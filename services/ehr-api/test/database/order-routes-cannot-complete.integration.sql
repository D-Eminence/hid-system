-- "We can't complete this order" (0091, D18). Rollback-only; fails without
-- 0091. The endings run as the exact Lab and Pharmacy runtimes, the readers
-- as the EHR and Identity runtimes, on the shared P4c fixture (item 3's and
-- D17's members added), with every route state of the design's table
-- (SPEC-FINAL D18 4.2):
--   1. properties, grants and pins: the language, security, volatility,
--      search path, owner and ACL of the command (C31), its two wrappers,
--      T10's guard and support's counts (C32); EXECUTE for each group and
--      login role and PUBLIC; T10 with forced row-level security, four
--      policies, no grant, its guard, both indexes, its key (on delete
--      restrict), its columns and CHECKs; the summary's attributes equal
--      0090's and its body is 0090's plus exactly the one key; the
--      functions reached by every new or replaced body (their callees,
--      transitively, the trigger functions of the tables they write and the
--      policy functions of the tables they read) equal the list 0091 pins,
--      with the bodies it pins; the three new CHECKs (validated, or NOT
--      VALID above the size 0091 chose by), and the route events' CHECKs
--      unchanged; and, before the fixture, the command refuses a REPEATABLE
--      READ or SERIALIZABLE caller before it reads anything;
--   2. every refusal writes nothing, with its code: never accepted (sent,
--      declined, withdrawn, expired as it was left and as it is stored);
--      accepted and lapsed; completed open, completed lapsed, completed
--      ended; cancelled by each ending (order changed, entered in error,
--      support, ordering and receiving released, wrong patient); reported
--      in the window and late; a report on an open route (T8 row, no
--      ending); another facility's route; the other kind's wrapper; a
--      receptionist; purpose emergency; the control off; every input; a
--      stale version on an open route (412) and on an ended one (the state
--      first); a checked result (also with a stale version, and also when
--      the critical value was told); a possibly critical value without the
--      statement;
--   3. success, Lab and Pharmacy: nothing recorded; an accession with a
--      received, a rejected and an uncollected specimen (not counted) and an
--      unverified result; a checked result corrected (a new, unverified
--      version) and one marked entered in error, both then allowed, without
--      the statement although the version no longer current, and the one
--      invalidated, is flagged possibly critical; a possibly critical value
--      with the statement; an order accepted 25 days earlier (reads never longer than
--      before); a patient whose account was deleted (no notice);
--      each with the route, both windows, the event, the T10 row, the two
--      audit rows with the patient and the critical facts, the notice and
--      the answer; ended by the member who accepted it and by another;
--   4. afterwards: item access answers write closed, read allowed with an
--      accession until access_ends_at and none after it, none at once
--      without; the cards; a release on the work item, by route access and
--      under P's consent, is refused (23514 ORDER_ROUTE_CLOSED), and so is a
--      dispensing; item 3's report ALREADY_ENDED; support's Close
--      ALREADY_CLOSED; A's order change leaves the route; the same order
--      cannot be sent again and a new one can; C3, C4, A's events, C5, C21
--      and C30;
--   5. D17 after D18: the late correction (C29, group 2) of a Lab route
--      with an unverified result and of a Pharmacy route right after the
--      ending, and of a Lab route after B's reads ended (the capability
--      path); the summary then answers notCompleted null; support's reports
--      list (C26) shows the earlier ending, flagged and first; its review
--      (C27) needs no referral (D18-12); C32 counts it; a released
--      receiving organization makes the order receiver_released, and its
--      member cannot end an order;
--   6. idempotency: a replay answers the first ending's facts with the
--      route as it is now (also after a late correction); the key with
--      another route or digest IDEMPOTENCY_KEY_REUSED; another key on an
--      ended route ALREADY_ENDED; the critical-value retry under a new key;
--   7. the limits, exact (D18-7): the 21st ending by one member and the
--      51st at one facility in 24 hours are refused with the time from
--      which another is possible, the 20th and 50th are not, an ending a
--      minute older than 24 hours is not counted while those between 23 and
--      24 hours old are, and both limits at once give the later time; the
--      member's limit counts their account at every facility it belongs to
--      (endings at one laboratory count at another);
--   8. the readers and their cost: the summary reads T10's rows only for
--      routes ended this way with no report (none for every other route);
--      C3 and C4 run as the EHR runtime; C32's five counts against the
--      endings, at their boundaries (59 and 60 minutes, 10,079 and 10,080
--      minutes after acceptance), its P0002 and its actor refusal;
--   9. the CHECKs: the new kind is refused on withdrawn, expired and
--      completed routes and without ended_at; T8's late CHECK admits it
--      only as the earlier ending of a late report; T10's reason, kind,
--      prescription and critical CHECKs; T10's UPDATE and DELETE refused,
--      also for a NOSUPERUSER owner;
--  10. the reason lists: every code of a kind passes C31's input check and
--      T10's CHECK, every code of the other kind (and an unknown one) is
--      refused by both, and both equal the shared fixture the Lab and
--      Pharmacy DTO tests read.
-- The two-session cases (replays before and after the locks, the key
-- committed concurrently on another route, exact limits under concurrency,
-- races with a release, a verification, a dispensing, item 3's report, the
-- order-change mirror, support's Close and B's own writes) are in the race
-- harness.
\set ON_ERROR_STOP on
set plpgsql.variable_conflict = error;
\ir ../fixtures/order-route-cannot-complete-reasons.sql
-- D18 (before the fixture): the command runs only in a READ COMMITTED
-- transaction, where each statement after its facility lock reads a new
-- snapshot, so that its limits are exact; under REPEATABLE READ and
-- SERIALIZABLE it refuses before it reads anything (under READ COMMITTED
-- the same call reaches the actor). Recorded in section 1 below.
begin isolation level repeatable read;
create function pg_temp.d18_isolation_outcome() returns text language plpgsql as $f$
begin
  perform ehr.cannot_complete_order_route('lab_request', gen_random_uuid(), 1, 'other', false,
    'd18-isolation-probe-0001', repeat('a', 64));
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.d18_isolation_outcome() as d18_repeatable_read_outcome \gset
rollback;
begin isolation level serializable;
create function pg_temp.d18_isolation_outcome() returns text language plpgsql as $f$
begin
  perform ehr.cannot_complete_order_route('lab_request', gen_random_uuid(), 1, 'other', false,
    'd18-isolation-probe-0001', repeat('a', 64));
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.d18_isolation_outcome() as d18_serializable_outcome \gset
rollback;
begin isolation level read committed;
create function pg_temp.d18_isolation_outcome() returns text language plpgsql as $f$
begin
  perform ehr.cannot_complete_order_route('lab_request', gen_random_uuid(), 1, 'other', false,
    'd18-isolation-probe-0001', repeat('a', 64));
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.d18_isolation_outcome() as d18_read_committed_outcome \gset
rollback;
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


-- D17's members: PB3 (37), pharmacist at PH1 holding P's direct-care write
-- consent there (as LB3 at L1).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e4c10000-0000-4000-8000-000000000037', 'synthetic:p4c:pb3', 'pb3@p4c-staff.invalid', 'Bisi Third Pharmacist',
   'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e4c12000-0000-4000-8000-000000000037', 'e4c10000-0000-4000-8000-000000000037', 'Bisi Third Pharmacist',
   'pb3@p4c-staff.invalid', 'verified', 'pharmacist');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
values ('e4c13000-0000-4000-8000-000000000037', 'e4c12000-0000-4000-8000-000000000037',
  'e4c10000-0000-4000-8000-000000000037', current_setting('hid.test.org_2')::uuid,
  current_setting('hid.test.facility_2')::uuid, 'pharmacist', 'pharmacist', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('e4c11000-0000-4000-8000-000000000037', 'e4c10000-0000-4000-8000-000000000037', 'pharmacist', 'facility',
  'e4c13000-0000-4000-8000-000000000037', current_setting('hid.test.facility_2')::uuid, 'P4c suite D17 role');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
values (gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000001', 'e4c12000-0000-4000-8000-000000000037',
  'e4c10000-0000-4000-8000-000000000037', 'e4c13000-0000-4000-8000-000000000037',
  current_setting('hid.test.facility_2')::uuid, 'write_records', 'active', 'P4c suite consent at the pharmacy',
  clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', false, 'direct-care');
-- Patient R (4), with an active account, an encounter ER at GH and DA's
-- direct-care consent: the routes that stay open or readable (so that P's
-- and Q's are all closed at L1 and PH1).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e4c10000-0000-4000-8000-000000000044', 'synthetic:p4c:patient-r', 'patient-r@p4c.invalid', 'Rukayat Danjuma',
   'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e4c30000-0000-4000-8000-000000000004', 'e4c10000-0000-4000-8000-000000000044', 'HID-P4CPATR', 'Rukayat',
   'Danjuma', 'Rukayat Danjuma', 'female', '1978-01-23', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
values (gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000004', 'e4c12000-0000-4000-8000-000000000011',
  'e4c10000-0000-4000-8000-000000000011', 'e4c13000-0000-4000-8000-000000000011',
  'e4c21000-0000-4000-8000-000000000001', 'write_records', 'active', 'P4c suite direct-care consent',
  clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', false, 'direct-care');
set local role hid_ehr_api_runtime;
select set_config('app.actor_subject', 'synthetic:p4c:da', true),
  set_config('app.membership_id', 'e4c13000-0000-4000-8000-000000000011', true),
  set_config('app.facility_id', 'e4c21000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'p4c-fixture-ehr-d17', true),
  set_config('app.purpose_of_use', 'direct-care', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e4c50000-0000-4000-8000-000000000004', 'e4c30000-0000-4000-8000-000000000004',
  'e4c21000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000011',
  'e4c13000-0000-4000-8000-000000000011', 'ambulatory', 'in_progress', clock_timestamp());
reset role;
select set_config('hid.test.p', 'e4c30000-0000-4000-8000-000000000001', true),
  set_config('hid.test.q', 'e4c30000-0000-4000-8000-000000000002', true),
  set_config('hid.test.n', 'e4c30000-0000-4000-8000-000000000004', true);

-- D17's helpers.
create function pg_temp.as_pb3(purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:pb3', true),
    set_config('app.membership_id', 'e4c13000-0000-4000-8000-000000000037', true),
    set_config('hid.test.actor_account', 'e4c10000-0000-4000-8000-000000000037', true),
    set_config('app.facility_id', current_setting('hid.test.facility_2'), true),
    set_config('app.correlation_id', 'p4c-suite-37-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true);
$f$;
-- A route, order, work item, result or reference by its D17 name.
create function pg_temp.r(name text) returns uuid language sql stable as $f$
  select current_setting('hid.test.route_' || name)::uuid
$f$;
create function pg_temp.o(name text) returns uuid language sql stable as $f$
  select current_setting('hid.test.order_' || name)::uuid
$f$;
create function pg_temp.i(name text) returns uuid language sql stable as $f$
  select current_setting('hid.test.item_' || name)::uuid
$f$;
create function pg_temp.res(name text) returns uuid language sql stable as $f$
  select current_setting('hid.test.result_' || name)::uuid
$f$;
create function pg_temp.ref(name text) returns text language sql stable as $f$
  select current_setting('hid.test.ref_' || name)
$f$;
-- An order by DA for patient n (1 P, 2 Q, 3 N), sent to a facility; its ids
-- are kept under the name. Through the EHR runtime.
create function pg_temp.order_to(name text, kind text, patient integer, receiving uuid)
returns uuid language plpgsql as $f$
declare
  order_id uuid;
  route_id uuid;
begin
  order_id := case kind when 'lab_request' then pg_temp.lab_request(patient, 'active')
                        else pg_temp.prescription(patient, 'active') end;
  route_id := pg_temp.send(11, kind, order_id, receiving, 'd17-late-send-route-' || name);
  perform set_config('hid.test.order_' || name, order_id::text, true);
  perform set_config('hid.test.route_' || name, route_id::text, true);
  return route_id;
end
$f$;
-- Acceptance at L1 by LB1 with a patient's Health ID.
create function pg_temp.accept_with(route uuid, health_id text)
returns uuid language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_signup_admin(1);
  select * into accepted from lab.accept_order_route(route, 1, 'health_id', health_id,
    'd17-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64), null);
  if accepted.result is distinct from 'accepted' then
    raise exception 'D17 acceptance of % answered %', route, accepted.result;
  end if;
  return accepted.work_item_id;
end
$f$;
-- The late correction, as the session's member, through the kind's wrapper.
create function pg_temp.late(kind text, route uuid, version bigint, reason text, found_by text, found_on date,
  note text, key text, digest text default null)
returns table (result text, report_id uuid, route_row_version bigint, route_state text, effective_state text,
  ended_kind text, ended_kind_before text, results_voided integer, result_reports_marked integer,
  dispensing_reversed boolean, state_before text, correctable_until timestamptz, patient_id uuid)
language plpgsql as $f$
begin
  if kind = 'lab_request' then
    return query select * from lab.correct_wrong_patient_order_route(route, version, reason, found_by, found_on,
      note, key, coalesce(digest, encode(sha256(key::bytea), 'hex')));
  else
    return query select * from pharmacy.correct_wrong_patient_order_route(route, version, reason, found_by,
      found_on, note, key, coalesce(digest, encode(sha256(key::bytea), 'hex')));
  end if;
end
$f$;
-- The same, keeping the answer under a label.
create function pg_temp.keep_late(label text, kind text, route uuid, version bigint, reason text, found_by text,
  found_on date, note text, key text, digest text default null)
returns text language plpgsql as $f$
declare answer record;
begin
  select * into answer from pg_temp.late(kind, route, version, reason, found_by, found_on, note, key, digest);
  insert into p4c_answers (label, answer) values (label, to_jsonb(answer));
  return answer.result;
end
$f$;
-- B's lookup, as the session's member: each row as jsonb.
create function pg_temp.find(kind text, wanted text)
returns setof jsonb language plpgsql as $f$
begin
  if kind = 'lab_request' then
    return query select to_jsonb(found_route) from lab.find_correctable_order_routes(wanted) found_route;
  else
    return query select to_jsonb(found_route) from pharmacy.find_correctable_order_routes(wanted) found_route;
  end if;
end
$f$;
create temp table d17_found (n serial primary key, label text not null, found jsonb not null);
create function pg_temp.look(label text, kind text, wanted text)
returns integer language plpgsql as $f$
declare made integer;
begin
  insert into d17_found (label, found) select label, found_row from pg_temp.find(kind, wanted) found_row;
  get diagnostics made = row_count;
  return made;
end
$f$;
create function pg_temp.found(label text) returns jsonb language sql volatile as $f$
  select found.found from d17_found found where found.label = $1 order by found.n limit 1
$f$;
-- Today and a route's acceptance day in Africa/Lagos.
create function pg_temp.lagos_today() returns date language sql stable as $f$
  select (clock_timestamp() at time zone 'Africa/Lagos')::date
$f$;
create function pg_temp.accepted_day(name text) returns date language sql stable as $f$
  select current_setting('hid.test.accepted_day_' || name)::date
$f$;
-- Lab results of a patient the session may read (row-level security decides).
create function pg_temp.results_seen(patient uuid) returns bigint language sql stable as $f$
  select count(*) from lab.results result_row where result_row.patient_id = patient
$f$;
-- 'refused' when a statement is refused by the governance validator
-- (23514, where the validator's owner is bound by row-level security) or by
-- the insert policy (42501, where it is not); else its outcome.
create function pg_temp.refused(statement text) returns text language plpgsql as $f$
declare got text := pg_temp.outcome(statement);
begin
  return case when got like '23514 Governance command must bind the exact current result version%'
                or got like '42501 new row violates row-level security policy%' then 'refused' else got end;
end
$f$;
-- A hand-written invalidation of a result's version 1, as the session's member.
create function pg_temp.hand_void(result_id uuid) returns text language sql as $f$
  select format($s$insert into lab.result_invalidations (result_id, execution_id, patient_id, facility_id,
    result_version, disposition, actor_id, actor_membership_id, reason, idempotency_key, request_sha256,
    correlation_id) values (%L, gen_random_uuid(), %L, %L, 1, 'entered_in_error', %L, %L, 'Trying by hand',
    'd17-hand-' || substr(md5(random()::text), 1, 12), repeat('a', 64), 'd17-hand-correlation')$s$, result_id,
    current_setting('hid.test.p'), current_setting('app.facility_id'), current_setting('hid.test.actor_account'),
    current_setting('app.membership_id'))
$f$;
-- Everything a refusal must leave as it was, counted as the owner (item 3's
-- footprint and the capability table).
create function pg_temp.footprint17() returns text language sql stable as $f$
  select pg_temp.footprint() || ',' || (select count(*) from ehr.order_route_correction_capabilities)
$f$;
create function pg_temp.capabilities() returns bigint language sql stable as $f$
  select count(*) from ehr.order_route_correction_capabilities
$f$;
-- Owner SQL: a route's ending as the release trigger gives it
-- (ehr.close_order_routes_on_release calls the closer so), without releasing
-- the organization.
create function pg_temp.close_as(route uuid, close_kind text) returns text language plpgsql as $f$
declare closed record;
begin
  perform pg_temp.as_platform(1);
  select * into closed from ehr.close_order_route(route, close_kind, 'platform', true);
  return closed.outcome;
end
$f$;
-- Owner SQL: moves a route's clock so that it was accepted at the given
-- time (every time of the route moves together, triggers off).
create function pg_temp.accept_at(route uuid, accepted timestamptz) returns void language plpgsql as $f$
declare shift interval;
begin
  select candidate.accepted_at - accepted into shift from ehr.order_routes candidate where candidate.id = route;
  perform pg_temp.age_route(route, shift, shift);
end
$f$;
-- Owner SQL: every late report moves back by an interval (triggers off).
create function pg_temp.age_late_reports(by_interval interval) returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  update ehr.order_route_wrong_patient_reports set reported_at = reported_at - by_interval where late;
  set local session_replication_role = origin;
end
$f$;
-- Owner SQL: a copy of a route with some columns changed (the reference is
-- generated from the id; triggers off). Answers the copy's id.
create function pg_temp.copy_route(template_id uuid, changes jsonb) returns uuid language plpgsql as $f$
declare
  columns_list text;
  copied jsonb;
begin
  select string_agg(quote_ident(attribute.attname), ', ' order by attribute.attnum) into columns_list
    from pg_attribute attribute
   where attribute.attrelid = 'ehr.order_routes'::regclass and attribute.attnum > 0 and not attribute.attisdropped
     and attribute.attgenerated = '';
  select to_jsonb(route) || changes into copied from ehr.order_routes route where route.id = template_id;
  set local session_replication_role = replica;
  execute format('insert into ehr.order_routes (%s) select %s from jsonb_populate_record(null::ehr.order_routes, $1)',
    columns_list, columns_list) using copied;
  set local session_replication_role = origin;
  return (copied ->> 'id')::uuid;
end
$f$;
-- Owner SQL: synthetic late reports at L1 by a membership, at the given
-- times (each on a synthetic copy of route snt; triggers off). Answers the
-- earliest time.
create function pg_temp.synthetic_late(membership uuid, times timestamptz[]) returns timestamptz
language plpgsql as $f$
declare
  at_time timestamptz;
  copy_id uuid;
  template ehr.order_routes%rowtype;
begin
  select * into template from ehr.order_routes where id = pg_temp.r('snt');
  foreach at_time in array times loop
    copy_id := pg_temp.copy_route(template.id, jsonb_build_object('id', gen_random_uuid(),
      'idempotency_key', 'd17-synthetic-' || gen_random_uuid(), 'source_lab_request_id', gen_random_uuid(),
      'patient_id', gen_random_uuid()));
    set local session_replication_role = replica;
    insert into ehr.order_route_wrong_patient_reports (id, route_id, kind, receiving_facility_id,
      receiving_organization_id, ordering_facility_id, state_before, reason_code, note, reported_by_account_id,
      reported_by_membership_id, accepted_by_account_id, accepted_by_membership_id, accepted_at, accepted_with,
      recorded_by_membership_ids, reporter_recorded_work, specimens_collected, results_voided, result_reports_marked,
      dispensing_reversed, idempotency_key, request_sha256, correlation_id, reported_at, late, ended_kind_before,
      discovered_by, discovered_on)
    values (gen_random_uuid(), copy_id, 'lab_request', template.receiving_facility_id,
      template.receiving_organization_id, template.ordering_facility_id, 'completed', 'other',
      'Synthetic late report for the limits', gen_random_uuid(), membership, gen_random_uuid(), gen_random_uuid(),
      at_time - interval '2 days', 'health_id', array[]::uuid[], false, 0, 0, 0, false,
      'd17-synthetic-' || substr(md5(copy_id::text), 1, 16), repeat('f', 64), 'd17-synthetic-correlation', at_time,
      true, 'support', 'own_check', (at_time at time zone 'Africa/Lagos')::date);
    set local session_replication_role = origin;
  end loop;
  return (select min(t) from unnest(times) t);
end
$f$;
-- Owner SQL: removes the synthetic reports and routes (triggers off).
create function pg_temp.forget_synthetic() returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  delete from ehr.order_route_wrong_patient_reports where idempotency_key like 'd17-synthetic-%';
  delete from ehr.order_routes where idempotency_key like 'd17-synthetic-%';
  set local session_replication_role = origin;
end
$f$;
-- The refusal's DETAIL for a time from which another is possible (UTC,
-- milliseconds, rounded up), as the command writes it.
create function pg_temp.limit_detail(free_at timestamptz) returns text language sql stable as $f$
  select to_char(date_trunc('milliseconds', free_at + interval '999 microseconds') at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$f$;
-- The SQLSTATE, message and DETAIL of a statement.
create function pg_temp.outcome_detail(statement text) returns text language plpgsql as $f$
declare detail_text text;
begin
  execute statement;
  return 'ok';
exception when others then
  get stacked diagnostics detail_text = pg_exception_detail;
  return sqlstate || ' ' || sqlerrm || ' / ' || coalesce(detail_text, '');
end
$f$;
grant select, insert on d17_found to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
grant usage on sequence d17_found_n_seq to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;

-- D18's helpers.
-- The ending, as the session's member, through the kind's wrapper (the
-- Pharmacy's takes no critical-value statement).
create function pg_temp.cannot(kind text, route uuid, version bigint, reason text, key text,
  told boolean default false, digest text default null)
returns table (result text, ending_id uuid, route_row_version bigint, route_state text, effective_state text,
  ended_kind text, reason_code text, access_ends_at timestamptz, specimens_collected integer, results_recorded integer,
  critical_candidates integer, patient_id uuid)
language plpgsql as $f$
begin
  if kind = 'lab_request' then
    return query select * from lab.cannot_complete_order_route(route, version, reason, told, key,
      coalesce(digest, encode(sha256(key::bytea), 'hex')));
  else
    return query select * from pharmacy.cannot_complete_order_route(route, version, reason, key,
      coalesce(digest, encode(sha256(key::bytea), 'hex')));
  end if;
end
$f$;
-- The same, keeping the answer under a label.
create temp table d18_answers (label text primary key, answer jsonb not null);
create function pg_temp.keep_cannot(label text, kind text, route uuid, version bigint, reason text, key text,
  told boolean default false, digest text default null)
returns text language plpgsql as $f$
declare answer record;
begin
  select * into answer from pg_temp.cannot(kind, route, version, reason, key, told, digest);
  insert into d18_answers (label, answer) values (label, to_jsonb(answer));
  return answer.result;
end
$f$;
create function pg_temp.ended(label text) returns jsonb language sql stable as $f$
  select answer.answer from d18_answers answer where answer.label = $1
$f$;
-- A statement's outcome, as pg_temp.outcome gives it, with the statement's
-- effects always rolled back ('ok' when it succeeded).
create function pg_temp.tried(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  raise exception using errcode = 'P0001', message = 'D18_TRIED_OK';
exception when others then
  return case when sqlerrm = 'D18_TRIED_OK' then 'ok' else sqlstate || ' ' || sqlerrm end;
end
$f$;
-- Everything a refusal must leave as it was, counted as the owner (item 3's
-- and D17's footprint, and T10).
create function pg_temp.footprint18() returns text language sql stable as $f$
  select pg_temp.footprint17() || ',' || (select count(*) from ehr.order_route_unable_endings)
$f$;
-- T10's row of a route, as jsonb.
create function pg_temp.ending(name text) returns jsonb language sql stable as $f$
  select to_jsonb(ending_row) from ehr.order_route_unable_endings ending_row where ending_row.route_id = pg_temp.r(name)
$f$;
-- The audit rows of an ending, as "side|patient|details" (A or B), oldest first.
create function pg_temp.ending_audit(name text) returns text language sql stable as $f$
  select string_agg(case when event.facility_id = route.ordering_facility_id then 'A' else 'B' end || '|'
      || (event.patient_id is not distinct from route.patient_id)::text || '|' || event.actor_type || '|'
      || event.outcome || '|' || event.details::text, ' ; ' order by event.facility_id = route.receiving_facility_id,
      event.occurred_at)
    from audit.events event join ehr.order_routes route on route.id = pg_temp.r(name)
   where event.resource_type = 'order-route' and event.resource_id = route.id::text
     and event.action = 'ehr.order-route.not-completed'
$f$;
-- The patient's inbox items for a route with a code, as "code|metadata".
create function pg_temp.notices(name text, code text) returns text language sql stable as $f$
  select coalesce(string_agg(item.notification_code || '|' || item.metadata::text, ' ; ' order by item.created_at), 'none')
    from notification.inbox_items item
   where item.resource_type = 'order-route' and item.resource_id = pg_temp.r(name) and item.notification_code = code
$f$;
-- A route's state as "state|ended_kind|effective|writes-ended_at|reads-ended_at|ended by|version".
create function pg_temp.d18_route(name text) returns text language sql stable as $f$
  select concat_ws('|', route.state, coalesce(route.ended_kind, '-'), ehr.order_route_effective_state(route),
    coalesce((route.writes_end_at - route.ended_at)::text, '-'), coalesce((route.access_ends_at - route.ended_at)::text, '-'),
    coalesce(route.ended_by_account_id::text, '-'), route.row_version)
    from ehr.order_routes route where route.id = pg_temp.r(name)
$f$;
-- Owner SQL: a second specimen of a work item's accession, collected and
-- then rejected (triggers off).
create function pg_temp.reject_specimen(work_item uuid) returns void language plpgsql as $f$
declare
  accession lab.accessions%rowtype;
  requirement_id uuid := gen_random_uuid();
begin
  select * into accession from lab.accessions where work_item_id = work_item;
  set local session_replication_role = replica;
  insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
  values (requirement_id, accession.id, accession.patient_id, accession.facility_id, 2, 'serum');
  insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
    collected_at, collected_by, collected_by_membership_id, rejected_at, rejected_by, rejected_by_membership_id,
    rejection_reason, row_version)
  values (gen_random_uuid(), requirement_id, accession.id, accession.patient_id, accession.facility_id, 'serum',
    'rejected', clock_timestamp(), 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031',
    clock_timestamp(), 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031',
    'Haemolysed sample', 2);
  set local session_replication_role = origin;
end
$f$;
-- Owner SQL: a third specimen of a work item's accession, still required
-- (not collected; triggers off).
create function pg_temp.required_specimen(work_item uuid) returns void language plpgsql as $f$
declare
  accession lab.accessions%rowtype;
  requirement_id uuid := gen_random_uuid();
begin
  select * into accession from lab.accessions where work_item_id = work_item;
  set local session_replication_role = replica;
  insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
  values (requirement_id, accession.id, accession.patient_id, accession.facility_id, 3, 'plasma');
  insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
    row_version)
  values (gen_random_uuid(), requirement_id, accession.id, accession.patient_id, accession.facility_id, 'plasma',
    'required', 1);
  set local session_replication_role = origin;
end
$f$;
-- Owner SQL: a result's current version flagged critical_candidate (the
-- Lab's own flag; triggers off).
create function pg_temp.flag_critical(target_result uuid) returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  update lab.result_revisions revision set abnormal_flag = 'critical_candidate'
    from lab.results result_row
   where result_row.id = target_result and revision.result_id = result_row.id
     and revision.version = result_row.current_version;
  set local session_replication_role = origin;
end
$f$;
-- Owner SQL: a result's current version marked entered in error (triggers off).
create function pg_temp.void_current(target_result uuid) returns void language plpgsql as $f$
declare head lab.results%rowtype;
begin
  select * into head from lab.results where id = target_result;
  set local session_replication_role = replica;
  insert into lab.result_invalidations (result_id, execution_id, patient_id, facility_id, result_version, disposition,
    actor_id, actor_membership_id, reason, idempotency_key, request_sha256, correlation_id)
  values (target_result, head.execution_id, head.patient_id, head.facility_id, head.current_version, 'entered_in_error',
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', 'Entered on the wrong analyser run',
    'd18-void-' || substr(md5(target_result::text), 1, 16), repeat('a', 64), 'd18-void-correlation');
  set local session_replication_role = origin;
end
$f$;
-- Owner SQL: a result's current version verified by a member (triggers off),
-- as a verification whose access check passed before an ending lands.
create function pg_temp.verify_current(target_result uuid, verifier uuid, verifier_membership uuid) returns uuid
language plpgsql as $f$
declare
  head lab.results%rowtype;
  verification_id uuid := gen_random_uuid();
begin
  select * into head from lab.results where id = target_result;
  set local session_replication_role = replica;
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, target_result, head.execution_id, head.patient_id, head.facility_id, head.current_version,
    verifier, verifier_membership, clock_timestamp(), 'Verified after the ending',
    'd18-verify-' || substr(md5(target_result::text), 1, 16), repeat('a', 64), 'd18-verify-correlation');
  set local session_replication_role = origin;
  return verification_id;
end
$f$;
-- Owner SQL: synthetic endings in T10 by a membership at a facility, at the
-- given times, each on a synthetic copy of route usnt (triggers off: T10's
-- guard and key too), recorded under the membership's account (a random one
-- for a made-up membership). Answers the earliest time.
create function pg_temp.synthetic_endings(membership uuid, facility uuid, times timestamptz[]) returns timestamptz
language plpgsql as $f$
declare
  at_time timestamptz;
  copy_id uuid;
  template ehr.order_routes%rowtype;
begin
  select * into template from ehr.order_routes where id = pg_temp.r('usnt');
  foreach at_time in array times loop
    copy_id := pg_temp.copy_route(template.id, jsonb_build_object('id', gen_random_uuid(),
      'idempotency_key', 'd18-synthetic-' || gen_random_uuid(), 'source_lab_request_id', gen_random_uuid(),
      'patient_id', gen_random_uuid()));
    set local session_replication_role = replica;
    insert into ehr.order_route_unable_endings (route_id, kind, receiving_facility_id, receiving_organization_id,
      ordering_facility_id, reason_code, ended_by_account_id, ended_by_membership_id, accepted_by_membership_id,
      accepted_at, ended_by_acceptor, minutes_after_acceptance, accession_made, specimens_collected, results_recorded,
      idempotency_key, request_sha256, correlation_id, recorded_at)
    values (copy_id, 'lab_request', facility, template.receiving_organization_id, template.ordering_facility_id,
      'other', coalesce((select member_row.account_id from identity.staff_facility_memberships member_row
                          where member_row.id = membership), gen_random_uuid()),
      membership, gen_random_uuid(), at_time - interval '2 hours', false, 120, false, 0, 0,
      'd18-synthetic-' || substr(md5(copy_id::text), 1, 16), repeat('f', 64), 'd18-synthetic-correlation', at_time);
    set local session_replication_role = origin;
  end loop;
  return (select min(t) from unnest(times) t);
end
$f$;
-- Owner SQL: removes the synthetic endings and their routes (triggers off).
create function pg_temp.forget_endings() returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  delete from ehr.order_route_unable_endings where idempotency_key like 'd18-synthetic-%';
  delete from ehr.order_routes where idempotency_key like 'd18-synthetic-%';
  set local session_replication_role = origin;
end
$f$;
-- T10's row reads in this transaction (sequential and index scans).
create function pg_temp.t10_reads() returns bigint language sql volatile as $f$
  select coalesce((select stat.seq_scan + coalesce(stat.idx_scan, 0) from pg_stat_xact_user_tables stat
                    where stat.relid = 'ehr.order_route_unable_endings'::regclass), 0)
$f$;
-- The patient of a route.
create function pg_temp.patient_of(name text) returns uuid language sql stable as $f$
  select current_setting('hid.test.patient_' || name)::uuid
$f$;
-- A route's correction state with its ending or its receiving
-- organization changed by hand (not stored), as D17's suite asks it.
create function pg_temp.state_released(name text, new_ended_kind text, organization_active boolean)
returns text language plpgsql as $f$
declare
  changed ehr.order_routes;
begin
  select route.* into changed from ehr.order_routes route where route.id = pg_temp.r(name);
  if new_ended_kind is not null then
    changed.ended_kind := new_ended_kind;
    changed.ended_at := coalesce(changed.ended_at, clock_timestamp());
  end if;
  if not organization_active then
    changed.receiving_organization_id := gen_random_uuid();
  end if;
  return ehr.order_route_correction_state(changed);
end
$f$;
create temp table d18_out (n serial primary key, label text not null, answer jsonb);
grant select, insert on d18_answers, d18_out to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
grant usage on sequence d18_out_n_seq to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;

-- 1. Properties, grants and pins.
select pg_temp.assert('d18: under REPEATABLE READ and SERIALIZABLE the command refuses before it reads anything; under '
    || 'READ COMMITTED it reaches the actor',
  :'d18_repeatable_read_outcome' = '25000 ORDER_ROUTE_CANNOT_COMPLETE_READ_COMMITTED_REQUIRED'
  and :'d18_serializable_outcome' = '25000 ORDER_ROUTE_CANNOT_COMPLETE_READ_COMMITTED_REQUIRED'
  and :'d18_read_committed_outcome' = '42501 Order route staff context is required',
  concat_ws(' / ', :'d18_repeatable_read_outcome', :'d18_serializable_outcome', :'d18_read_committed_outcome'));
select set_config('hid.test.o', (select proc.proowner::regrole::text from pg_proc proc
  where proc.oid = 'ehr.close_order_route(uuid,text,text,boolean)'::regprocedure), true);
create temp table d18_props on commit drop as
select proc.oid::regprocedure::text as signature, (select language_row.lanname from pg_language language_row
         where language_row.oid = proc.prolang) as language,
       proc.prosecdef, proc.provolatile, proc.proconfig, proc.proowner::regrole::text as owner,
       coalesce((select array_agg(acl.grantee::regrole::text order by acl.grantee::regrole::text)
                   from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                  where acl.privilege_type = 'EXECUTE' and acl.grantee <> proc.proowner), array[]::text[]) as grantees
  from pg_proc proc
 where proc.oid in ('ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character)'::regprocedure,
   'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)'::regprocedure,
   'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)'::regprocedure,
   'ehr.guard_order_route_unable_ending()'::regprocedure,
   'identity.admin_order_route_not_completed(uuid)'::regprocedure);
select pg_temp.assert('d18: the command, its wrappers, the guard and C32: language, security, volatility, search path, '
    || 'owner (the closer''s) and EXECUTE (PUBLIC none)',
  (select array_agg(format('%s %s %s %s %s %s %s', props.signature, props.language, props.prosecdef, props.provolatile,
      props.proconfig, props.owner = current_setting('hid.test.o'), props.grantees) order by props.signature)
     from d18_props props)
  = array[
    'ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character) plpgsql f v {"search_path=pg_catalog, ehr, identity, auth, lab, pharmacy, notification, platform, pg_temp"} t {}',
    'ehr.guard_order_route_unable_ending() plpgsql f v {"search_path=pg_catalog, ehr, pg_temp"} t {}',
    'identity.admin_order_route_not_completed(uuid) plpgsql t s {"search_path=pg_catalog, identity, ehr, auth, platform, pg_temp"} t {hid_identity_runtime}',
    'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character) sql t v {"search_path=pg_catalog, lab, ehr, pg_temp"} t {hid_lab_runtime,hid_schema_test_runtime}',
    'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character) sql t v {"search_path=pg_catalog, pharmacy, ehr, pg_temp"} t {hid_pharmacy_runtime,hid_schema_test_runtime}'],
  (select string_agg(format('%s %s %s %s %s %s %s', props.signature, props.language, props.prosecdef, props.provolatile,
      props.proconfig, props.owner = current_setting('hid.test.o'), props.grantees), ' ; ' order by props.signature)
     from d18_props props));
select pg_temp.assert('d18: the login roles reach their own wrapper and C32 through their groups, and nothing else',
  has_function_privilege('hid_lab_api_runtime', 'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'identity.admin_order_route_not_completed(uuid)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character)', 'EXECUTE')
  and has_function_privilege('hid_identity_api_runtime', 'identity.admin_order_route_not_completed(uuid)', 'EXECUTE')
  and not has_function_privilege('hid_identity_api_runtime', 'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'identity.admin_order_route_not_completed(uuid)', 'EXECUTE')
  and not has_function_privilege('hid_schema_test_runtime', 'identity.admin_order_route_not_completed(uuid)', 'EXECUTE')
  and not exists (select 1 from pg_roles runtime where runtime.rolname ~ '^hid_'
    and runtime.rolname <> current_setting('hid.test.o')
    and (has_function_privilege(runtime.oid, 'ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character)', 'EXECUTE')
      or has_function_privilege(runtime.oid, 'ehr.guard_order_route_unable_ending()', 'EXECUTE'))));
select pg_temp.assert('d18: T10 belongs to the closer''s owner, has row-level security enabled and forced, four '
    || 'policies (select, insert, update, delete, all true), no grant and no runtime privilege',
  (select relation.relowner::regrole::text = current_setting('hid.test.o')
      and relation.relrowsecurity and relation.relforcerowsecurity
     from pg_class relation where relation.oid = 'ehr.order_route_unable_endings'::regclass)
  and (select array_agg(policy_row.polname || ':' || policy_row.polcmd::text || ':'
        || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-') || ':'
        || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '-') order by policy_row.polname)
        from pg_policy policy_row where policy_row.polrelid = 'ehr.order_route_unable_endings'::regclass)
    = array['order_route_unable_endings_command_delete:d:true:-', 'order_route_unable_endings_command_insert:a:-:true',
            'order_route_unable_endings_command_read:r:true:-', 'order_route_unable_endings_command_update:w:true:true']
  and not exists (select 1 from pg_class relation, aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                   where relation.oid = 'ehr.order_route_unable_endings'::regclass and acl.grantee <> relation.relowner
                     and acl.grantee not in (select proc.proowner from pg_proc proc
                       where proc.oid in ('ehr.list_order_routes_for_order(text,uuid,uuid)'::regprocedure,
                         'ehr.order_route_summaries(text,uuid,uuid[])'::regprocedure,
                         'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure)))
  and not exists (select 1 from pg_roles runtime where runtime.rolname ~ '^hid_.*runtime$'
    and (has_table_privilege(runtime.oid, 'ehr.order_route_unable_endings', 'SELECT')
      or has_table_privilege(runtime.oid, 'ehr.order_route_unable_endings', 'INSERT')
      or has_table_privilege(runtime.oid, 'ehr.order_route_unable_endings', 'UPDATE')
      or has_table_privilege(runtime.oid, 'ehr.order_route_unable_endings', 'DELETE')
      or has_table_privilege(runtime.oid, 'ehr.order_route_unable_endings', 'TRUNCATE')))
  and not exists (select 1 from pg_depend dependency join pg_class sequence_row on sequence_row.oid = dependency.objid
                   where sequence_row.relkind = 'S'
                     and dependency.refobjid = 'ehr.order_route_unable_endings'::regclass));
select pg_temp.assert('d18: T10''s columns, keys, CHECKs, indexes, guard trigger and key to the route (on delete restrict)',
  (select array_agg(format('%s %s %s %s', attribute.attname, format_type(attribute.atttypid, attribute.atttypmod),
        attribute.attnotnull, coalesce(pg_get_expr(default_row.adbin, default_row.adrelid), '-')) order by attribute.attnum)
     from pg_attribute attribute
     left join pg_attrdef default_row on default_row.adrelid = attribute.attrelid and default_row.adnum = attribute.attnum
    where attribute.attrelid = 'ehr.order_route_unable_endings'::regclass and attribute.attnum > 0
      and not attribute.attisdropped)
  = array['id uuid t gen_random_uuid()', 'route_id uuid t -', 'kind text t -', 'receiving_facility_id uuid t -',
    'receiving_organization_id uuid t -', 'ordering_facility_id uuid t -', 'reason_code text t -',
    'ended_by_account_id uuid t -', 'ended_by_membership_id uuid t -', 'accepted_by_membership_id uuid t -',
    'accepted_at timestamp with time zone t -', 'ended_by_acceptor boolean t -',
    'minutes_after_acceptance integer t -', 'accession_made boolean t -', 'specimens_collected integer t -',
    'results_recorded integer t -', 'critical_candidates integer t 0', 'critical_value_told boolean t false',
    'idempotency_key text t -', 'request_sha256 character(64) t -', 'correlation_id text t -',
    'recorded_at timestamp with time zone t clock_timestamp()']
  and (select array_agg(constraint_row.conname || ' ' || constraint_row.contype::text || ' ' || constraint_row.convalidated
        || ' ' || pg_get_constraintdef(constraint_row.oid) order by constraint_row.conname)
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'ehr.order_route_unable_endings'::regclass
         and constraint_row.conname in ('order_route_unable_endings_route_uq', 'order_route_unable_endings_idempotency_uq',
           'order_route_unable_endings_reason_ck', 'order_route_unable_endings_kind_ck',
           'order_route_unable_endings_critical_ck', 'order_route_unable_endings_route_id_fkey'))
    = array['order_route_unable_endings_critical_ck c true CHECK (((critical_candidates = 0) OR critical_value_told))',
      'order_route_unable_endings_idempotency_uq u true UNIQUE (ended_by_account_id, receiving_facility_id, idempotency_key)',
      'order_route_unable_endings_kind_ck c true CHECK (((kind = ''lab_request''::text) OR ((NOT accession_made) AND (specimens_collected = 0) AND (results_recorded = 0) AND (critical_candidates = 0) AND (NOT critical_value_told))))',
      'order_route_unable_endings_reason_ck c true CHECK ((((kind = ''lab_request''::text) AND (reason_code = ANY (ARRAY[''test_not_offered''::text, ''supplies_unavailable''::text, ''equipment_unavailable''::text, ''sample_unusable''::text, ''sample_not_obtained''::text, ''cannot_meet_priority''::text, ''patient_declined''::text, ''patient_did_not_return''::text, ''other''::text]))) OR ((kind = ''prescription''::text) AND (reason_code = ANY (ARRAY[''out_of_stock''::text, ''medicine_unavailable''::text, ''needs_prescriber_review''::text, ''controlled_requirements''::text, ''cannot_meet_priority''::text, ''patient_declined''::text, ''patient_did_not_return''::text, ''other''::text])))))',
      'order_route_unable_endings_route_id_fkey f true FOREIGN KEY (route_id) REFERENCES ehr.order_routes(id) ON DELETE RESTRICT',
      'order_route_unable_endings_route_uq u true UNIQUE (route_id)']
  and (select count(*) from pg_constraint constraint_row
        where constraint_row.conrelid = 'ehr.order_route_unable_endings'::regclass) = 15
  and (select array_agg(pg_get_indexdef(index_row.indexrelid) order by pg_get_indexdef(index_row.indexrelid))
         from pg_index index_row where index_row.indrelid = 'ehr.order_route_unable_endings'::regclass)
    = array['CREATE INDEX order_route_unable_endings_account_idx ON ehr.order_route_unable_endings USING btree (ended_by_account_id, recorded_at)',
      'CREATE INDEX order_route_unable_endings_facility_idx ON ehr.order_route_unable_endings USING btree (receiving_facility_id, recorded_at)',
      'CREATE UNIQUE INDEX order_route_unable_endings_idempotency_uq ON ehr.order_route_unable_endings USING btree (ended_by_account_id, receiving_facility_id, idempotency_key)',
      'CREATE UNIQUE INDEX order_route_unable_endings_pkey ON ehr.order_route_unable_endings USING btree (id)',
      'CREATE UNIQUE INDEX order_route_unable_endings_route_uq ON ehr.order_route_unable_endings USING btree (route_id)']
  and (select array_agg(trigger_row.tgname || ' ' || trigger_row.tgtype || ' ' || trigger_row.tgenabled::text || ' '
        || trigger_row.tgfoid::regprocedure::text order by trigger_row.tgname)
        from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.order_route_unable_endings'::regclass and not trigger_row.tgisinternal)
    = array['order_route_unable_endings_guard 27 O ehr.guard_order_route_unable_ending()']
  and (select count(*) from pg_trigger trigger_row
        where trigger_row.tgrelid = 'ehr.order_routes'::regclass and not trigger_row.tgisinternal) = 2);
-- The summary: 0090's attributes (CREATE OR REPLACE restates them), and its
-- body 0090's byte for byte plus exactly one key in the outer select list
-- (0090's md5 measured on 0001-0090).
select set_config('hid.test.summary_key', E',\n    ''notCompleted'', case when route.ended_kind = ''receiving_unable'' and facts.answer is null then\n      (select jsonb_build_object(''reason'', unable.reason_code,\n                                 ''sampleTaken'', case when unable.kind = ''lab_request'' then unable.specimens_collected > 0 end,\n                                 ''resultRecorded'', case when unable.kind = ''lab_request'' then unable.results_recorded > 0 end)\n         from ehr.order_route_unable_endings unable where unable.route_id = route.id) end', true);
select pg_temp.assert('d18: the summary keeps 0090''s attributes, and its body is 0090''s plus the notCompleted key',
  (select (select language_row.lanname from pg_language language_row where language_row.oid = proc.prolang) = 'sql'
      and not proc.prosecdef and proc.provolatile = 's' and proc.proparallel = 'u'
      and proc.proconfig = array['search_path=pg_catalog, ehr, identity, pg_temp']
      and proc.proowner::regrole::text = current_setting('hid.test.o')
      and proc.proacl = array[format('%s=X/%s', proc.proowner::regrole, proc.proowner::regrole)::aclitem]
      and md5(replace(proc.prosrc, current_setting('hid.test.summary_key'), '')) = '324809e749bc38a89305b07f1458fc28'
      and (length(proc.prosrc) - length(replace(proc.prosrc, current_setting('hid.test.summary_key'), '')))
          = length(current_setting('hid.test.summary_key'))
      and right(proc.prosrc, 16) = E'offset 0) facts\n'
     from pg_proc proc where proc.oid = 'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure));
-- The functions every new or replaced body reaches, by 0091's rule (section
-- 0 c): their callees, transitively, from a source scan for
-- schema-qualified calls; the user trigger functions of the tables they
-- write; the functions in the read policies of the tables they read. Each is
-- one 0091 pins, with the body it pins (md5 measured on 0001-0090).
create temp table d18_reached on commit drop as
with recursive roots(oid) as (
  select unnest(array['ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character)'::regprocedure,
    'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)'::regprocedure,
    'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)'::regprocedure,
    'ehr.guard_order_route_unable_ending()'::regprocedure,
    'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure,
    'identity.admin_order_route_not_completed(uuid)'::regprocedure]::oid[])
), seeds(oid) as (
  select roots.oid from roots
  union
  select trigger_row.tgfoid from pg_trigger trigger_row
   where not trigger_row.tgisinternal
     and trigger_row.tgrelid in ('ehr.order_routes'::regclass, 'ehr.order_route_events'::regclass,
       'ehr.order_route_unable_endings'::regclass, 'audit.events'::regclass, 'notification.inbox_items'::regclass)
  union
  select callee.oid
    from pg_policy policy_row
    cross join lateral regexp_matches(coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), ''),
      '([a-z_]+)\.([a-z_][a-z0-9_]*)\(', 'g') called
    join pg_namespace namespace on namespace.nspname = called[1]
    join pg_proc callee on callee.pronamespace = namespace.oid and callee.proname = called[2]
   where policy_row.polcmd in ('r', '*')
     and policy_row.polrelid in ('lab.accessions'::regclass, 'lab.specimens'::regclass, 'lab.results'::regclass,
       'lab.test_executions'::regclass, 'lab.work_item_requested_tests'::regclass, 'lab.result_revisions'::regclass,
       'lab.result_verifications'::regclass, 'lab.result_invalidations'::regclass, 'ehr.order_routes'::regclass,
       'ehr.order_route_wrong_patient_reports'::regclass, 'ehr.order_route_unable_endings'::regclass,
       'identity.facilities'::regclass)
), calls(oid) as (
  select seeds.oid from seeds
  union
  select callee.oid
    from calls join pg_proc caller on caller.oid = calls.oid
    cross join lateral regexp_matches(caller.prosrc, '([a-z_]+)\.([a-z_][a-z0-9_]*)\s*\(', 'g') called
    join pg_namespace namespace on namespace.nspname = called[1]
    join pg_proc callee on callee.pronamespace = namespace.oid and callee.proname = called[2]
)
select calls.oid::regprocedure::text as reached from calls where calls.oid not in (select roots.oid from roots);
create temp table d18_pins (signature text primary key, digest text not null) on commit drop;
insert into d18_pins values
  ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'),
  ('auth.account_has_platform_permission(uuid,text)', '2145c72b864abf1b69d23d96265e5ba7'),
  ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
  ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
  ('ehr.close_order_route(uuid,text,text,boolean)', 'd0c8c11573bc3fd5cc764553d55b1820'),
  ('ehr.guard_order_route_mutation()', '6a01bc885cd54f87a1bee8c0ebc100a4'),
  ('ehr.lock_receiving_route(text,uuid,uuid,uuid)', 'b73b01f7ca721adb0de4e834dd566e3a'),
  ('ehr.order_route_access_allows(text,uuid,uuid,text)', '175eff453979c964889283a29bb8f34f'),
  ('ehr.order_route_access_open()', 'd0b8aff4c2a656c30872b95286071457'),
  ('ehr.order_route_allows(uuid,uuid,text)', 'b80c2df6c380f7c7e20d166da94e56d2'),
  ('ehr.order_route_destination_type(text)', '9ce8c8706abc84e98ae3e1c86a24515f'),
  ('ehr.order_route_effective_state(ehr.order_routes)', '934300a9e58a7f6789b1dc24520fabad'),
  ('ehr.order_route_notify_patient(ehr.order_routes,text)', '31a11a44325846699036367b7e56b46e'),
  ('ehr.order_route_receive_permission(text)', '4c9f4acbafb062ff9a2cda113ccad037'),
  ('ehr.order_route_receiver(text)', '61eed3f80f2502aadc338581142214a5'),
  ('ehr.order_route_staff_actor(boolean)', 'b1873dca92164652cc1977a90acb6184'),
  ('ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb)', '6c54f543a495e35d9ebd029450d49e0a'),
  ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
  ('ehr.require_order_route_first_event()', 'ae41186236e61c14f252bfa38a008e6a'),
  ('ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text)', 'b11691bfe99d65a93d60eefe0fc8c0c1'),
  ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)', '8b12ce866ee75cce411a2721795ffb92'),
  ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
  ('identity.lock_self_service_application(uuid)', '4eeb309085494a7652c19e7d6365e131'),
  ('identity.order_route_destination_eligible(uuid,text)', '6b274d9be9056cefc831a9fd92040bc6'),
  ('identity.order_route_destination_listed(uuid)', '2a2025d538db2686c1ca5a03e0354923'),
  ('identity.order_route_platform_actor(text[])', '599cccfdba5e9b4c46cde4dd2814a541'),
  ('identity.organization_self_service_state(uuid)', 'c67aa5224b2aa3d95e4415e26787d470'),
  ('identity.patient_self_session(text,uuid)', 'd4c7aeaf25317d0fae794a2764d7d72b'),
  ('lab.context_allows(uuid,uuid,text)', '57e689661a6227e34d3bde9562468951'),
  ('lab.patient_self_context(uuid)', '39aeca12d2c59b69877800a9a3a7c50b'),
  ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
  ('platform.control_enabled(text)', 'ed17b9d8097417363c0a6343e52aa47f'),
  ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
  ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
  ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
  ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
  ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
  ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
  ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
  ('platform.require_control_enabled(text)', '90887489d15eab24f8f71b145bb02320');
select pg_temp.assert('d18: the functions the new and replaced bodies reach are exactly the 40 0091 pins for them',
  (select array_agg(reached order by reached) from d18_reached)
  = (select array_agg(signature order by signature) from d18_pins),
  (select string_agg(reached, ', ' order by reached) from d18_reached));
select pg_temp.assert('d18: each reached function still has the body 0091 pinned',
  (select count(*) from d18_pins pinned
     join pg_proc proc on proc.oid = pinned.signature::regprocedure and md5(proc.prosrc) = pinned.digest) = 40);
-- The three CHECKs 0091 changed: their definitions, validated while the
-- route table's heap held at most 117,145,600 bytes when 0091 ran, NOT VALID
-- above (the form 0091 chose; the suite's own writes never move a copy
-- across that size). The route events' CHECKs are unchanged.
select set_config('hid.test.checks_valid', (pg_relation_size('ehr.order_routes'::regclass, 'main') <= 117145600)::text,
  true);
select pg_temp.assert('d18: the route''s ended-kind and end CHECKs and T8''s late CHECK admit receiving_unable, '
    || 'validated or NOT VALID by the size 0091 read',
  (select array_agg(constraint_row.conname || ' ' || constraint_row.convalidated || ' ' || pg_get_constraintdef(constraint_row.oid)
        order by constraint_row.conname)
     from pg_constraint constraint_row
    where (constraint_row.conrelid, constraint_row.conname) in (('ehr.order_routes'::regclass, 'order_routes_ended_kind_check'),
      ('ehr.order_routes'::regclass, 'order_routes_end_ck'),
      ('ehr.order_route_wrong_patient_reports'::regclass, 'order_route_wrong_patient_reports_late_ck')))
  = array[
    'order_route_wrong_patient_reports_late_ck ' || current_setting('hid.test.checks_valid') || ' CHECK ((((NOT late) AND (ended_kind_before IS NULL) AND (discovered_by IS NULL) AND (discovered_on IS NULL) AND (state_before = ANY (ARRAY[''accepted''::text, ''completed''::text]))) OR (late AND COALESCE((discovered_by = ANY (ARRAY[''patient''::text, ''ordering_facility''::text, ''own_check''::text, ''support''::text, ''other''::text])), false) AND (discovered_on IS NOT NULL) AND ((ended_kind_before IS NULL) OR (ended_kind_before = ANY (ARRAY[''order_changed''::text, ''entered_in_error''::text, ''receiving_released''::text, ''ordering_released''::text, ''support''::text, ''receiving_unable''::text]))) AND ((state_before <> ''cancelled''::text) OR (ended_kind_before IS NOT NULL)))))'
      || case when current_setting('hid.test.checks_valid')::boolean then '' else ' NOT VALID' end,
    'order_routes_end_ck ' || current_setting('hid.test.checks_valid') || E' CHECK ((((ended_at IS NULL) = (ended_kind IS NULL)) AND ((ended_by_account_id IS NULL) OR (ended_at IS NOT NULL)) AND COALESCE(\nCASE state\n    WHEN ''withdrawn''::text THEN (ended_kind = ANY (ARRAY[''orderer''::text, ''patient''::text, ''order_changed''::text, ''entered_in_error''::text, ''receiving_released''::text, ''ordering_released''::text, ''support''::text, ''order_in_work''::text]))\n    WHEN ''expired''::text THEN (ended_kind = ''not_accepted''::text)\n    WHEN ''cancelled''::text THEN (ended_kind = ANY (ARRAY[''order_changed''::text, ''entered_in_error''::text, ''receiving_released''::text, ''ordering_released''::text, ''support''::text, ''wrong_patient''::text, ''receiving_unable''::text]))\n    WHEN ''completed''::text THEN ((ended_kind IS NULL) OR (ended_kind = ANY (ARRAY[''entered_in_error''::text, ''receiving_released''::text, ''ordering_released''::text, ''support''::text, ''wrong_patient''::text])))\n    ELSE (ended_kind IS NULL)\nEND, false)))'
      || case when current_setting('hid.test.checks_valid')::boolean then '' else ' NOT VALID' end,
    'order_routes_ended_kind_check ' || current_setting('hid.test.checks_valid') || ' CHECK (((ended_kind IS NULL) OR (ended_kind = ANY (ARRAY[''orderer''::text, ''patient''::text, ''order_changed''::text, ''entered_in_error''::text, ''receiving_released''::text, ''ordering_released''::text, ''support''::text, ''order_in_work''::text, ''not_accepted''::text, ''wrong_patient''::text, ''receiving_unable''::text]))))'
      || case when current_setting('hid.test.checks_valid')::boolean then '' else ' NOT VALID' end],
  (select string_agg(constraint_row.conname || ' ' || constraint_row.convalidated, ', ' order by constraint_row.conname)
     from pg_constraint constraint_row
    where constraint_row.conname in ('order_routes_ended_kind_check', 'order_routes_end_ck',
      'order_route_wrong_patient_reports_late_ck')));
select pg_temp.assert('d18: the route events'' type, side, reason and state CHECKs are 0086''s (the ending writes '
    || 'cancelled / receiving / receiving_unable)',
  (select array_agg(md5(pg_get_constraintdef(constraint_row.oid)) order by constraint_row.conname)
     from pg_constraint constraint_row
    where constraint_row.conrelid = 'ehr.order_route_events'::regclass
      and constraint_row.conname in ('order_route_events_event_type_check', 'order_route_events_reason_code_check',
        'order_route_events_side_check', 'order_route_events_state_after_check'))
  = array['158c56f43c9a9b50b5d48f7bd3250588', 'b1a88068d27917305197f3fdc4ee99f6', '5c6950e2f29537f449ea1b21351f8ba3',
          '7ea0a7f877a98d0ea1b85f5befc75e62']);

-- The routes (DA at GH). R's lab requests to L1: usnt (sent), udec
-- (declined), uwdn (withdrawn by DA), uexp (sent, past respond_by), uexs
-- (stored expired), ulap (accepted, lapsed), uopc (completed, open), ucpl
-- (completed, lapsed), ucpe (completed, closed by support), uoc (cancelled:
-- the order changed), uee (cancelled: entered in error), usup (cancelled by
-- support), uorl and urrl (cancelled as the ordering's and the receiving
-- organization's release ends routes), urep (reported in its window by
-- item 3's command), ulate (lapsed, then corrected late by D17's command),
-- ut8 (accepted, open, with a report row written by hand and no ending),
-- uopa (accepted, nothing recorded), ub (an accession with a received and a
-- rejected specimen, an unverified result), uw7 (an accession, a received
-- specimen, an unverified result), uchk (a checked result), ueie (a checked
-- result marked entered in error), ucrit (an unverified result flagged
-- critical_candidate), ucv (a checked result flagged critical_candidate),
-- uaged (accepted 25 days ago, an accession), ulim1 to ulim4 (for the
-- limits). P's lab request to L1: up (an accession, an unverified result).
-- Q's to L1: uq (accepted; Q's account then deleted). P's to GL: ugl
-- (sent). P's prescriptions to PH1: xrx, xrx2 and xrxo (accepted), xrxc
-- (dispensed).
set local role hid_ehr_api_runtime;
select pg_temp.order_to(name, 'lab_request', 4, current_setting('hid.test.facility_1')::uuid)
  from unnest(array['usnt', 'udec', 'uwdn', 'uexp', 'uexs', 'ulap', 'uopc', 'ucpl', 'ucpe', 'uoc', 'uee', 'usup',
    'uorl', 'urrl', 'urep', 'ulate', 'ut8', 'uopa', 'ub', 'uw7', 'uchk', 'ueie', 'ucrit', 'ucv', 'uaged', 'ulim1',
    'ulim2', 'ulim3', 'ulim4']) name;
select pg_temp.order_to('up', 'lab_request', 1, current_setting('hid.test.facility_1')::uuid);
select pg_temp.order_to('uq', 'lab_request', 2, current_setting('hid.test.facility_1')::uuid);
select pg_temp.order_to('ugl', 'lab_request', 1, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.order_to(name, 'prescription', 1, current_setting('hid.test.facility_2')::uuid)
  from unnest(array['xrx', 'xrx2', 'xrxo', 'xrxc']) name;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select * from ehr.withdraw_order_route(pg_temp.r('uwdn'), 'lab_request', pg_temp.o('uwdn'), 1, 'sent_in_error');
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.item_' || name, pg_temp.accept_with(pg_temp.r(name), 'HID-P4CPATR')::text, true)
  from unnest(array['ulap', 'uopc', 'ucpl', 'ucpe', 'uoc', 'uee', 'usup', 'uorl', 'urrl', 'urep', 'ulate', 'ut8',
    'uopa', 'ub', 'uw7', 'uchk', 'ueie', 'ucrit', 'ucv', 'uaged', 'ulim1', 'ulim2', 'ulim3', 'ulim4']) name;
select set_config('hid.test.item_up', pg_temp.accept_lab(pg_temp.r('up'))::text, true);
select set_config('hid.test.item_uq', pg_temp.accept_with(pg_temp.r('uq'), 'HID-P4CPATQ')::text, true);
select pg_temp.as_signup_admin(1);
select * from lab.decline_order_route(pg_temp.r('udec'), 1, 'test_not_offered');
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.item_' || name, pg_temp.accept_rx(pg_temp.r(name))::text, true)
  from unnest(array['xrx', 'xrx2', 'xrxo', 'xrxc']) name;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.dispense(pg_temp.i('xrxc'), 'd18-dispense-xrxc');
reset role;
-- The work: checked (verified) results LB2 entered and LB1 verified on uopc,
-- ucpl, ucpe, uchk, ueie and ucv; unverified results LB2 entered on ub,
-- uw7, ucrit, uaged, ulate and up; ub's second specimen rejected and a
-- third still required (not collected); ueie's checked version marked
-- entered in error; ucrit's, ucv's, uchk's (later corrected, so no longer
-- current) and ueie's (invalidated) current versions flagged
-- critical_candidate.
select set_config('hid.test.result_' || name, pg_temp.lab_chain(pg_temp.i(name), 'd18' || name, 13.1)::text, true)
  from unnest(array['uopc', 'ucpl', 'ucpe', 'uchk', 'ueie', 'ucv']) name;
select pg_temp.assert('d18 fixture: one unverified result each on ub, uw7, ucrit, uaged, ulate and up',
  (select bool_and(pg_temp.lab_entry(pg_temp.i(name), 'd18' || name, 9.7) = 1)
     from unnest(array['ub', 'uw7', 'ucrit', 'uaged', 'ulate', 'up']) name));
select set_config('hid.test.result_' || name, current_setting('hid.test.d18' || name || '_result_1'), true)
  from unnest(array['ub', 'uw7', 'ucrit', 'uaged', 'ulate', 'up']) name;
select pg_temp.reject_specimen(pg_temp.i('ub'));
select pg_temp.required_specimen(pg_temp.i('ub'));
select pg_temp.void_current(pg_temp.res('ueie'));
select pg_temp.flag_critical(pg_temp.res(name)) from unnest(array['ucrit', 'ucv', 'uchk', 'ueie']) name;
-- Releases on uopc, ucpl and ucpe by LB1 under route access: completed.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.release(pg_temp.res(name), 1, current_setting('hid.test.d18' || name || '_verification_1')::uuid,
    'd18-release-' || name || '-1')
  from unnest(array['uopc', 'ucpl', 'ucpe']) name;
-- Item 3's report of urep by LB1, in its window.
select pg_temp.keep('urep', 'lab_request', pg_temp.r('urep'), 2, 'wrong_order_chosen',
  'Picked the wrong row at the counter', 'd18-inwindow-urep-001');
reset role;
-- DA cancels uoc's order and marks uee's entered in error: the mirror ends
-- the routes.
set local role hid_ehr_api_runtime;
select pg_temp.edit_lab(pg_temp.o('uoc'), 'cancelled', 'No longer needed');
select pg_temp.edit_lab(pg_temp.o('uee'), 'entered_in_error', 'Written in the wrong chart');
reset role;
-- Support (FR) closes ucpe and usup.
select pg_temp.snap();
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select route_closed.state from unnest(array['ucpe', 'usup']) name
  cross join lateral identity.admin_close_order_route(pg_temp.r(name), pg_temp.v(pg_temp.r(name)),
    'The hospital asked support to close it') route_closed;
reset role;
select pg_temp.assert('d18 fixture: the releases'' endings, and uexs stored expired',
  pg_temp.close_as(pg_temp.r('uorl'), 'ordering_released') = 'cancelled'
  and pg_temp.close_as(pg_temp.r('urrl'), 'receiving_released') = 'cancelled');
-- Windows lapse: ulap, ucpl and ulate 46 days back; uexp and uexs 8 days
-- (past respond_by), and uexs is then closed, which stores it expired;
-- uaged was accepted 25 days ago (its windows end in 5 days).
select pg_temp.age_route(pg_temp.r(name), interval '46 days', interval '46 days')
  from unnest(array['ulap', 'ucpl', 'ulate']) name;
select pg_temp.age_route(pg_temp.r(name), interval '8 days', interval '0 days') from unnest(array['uexp', 'uexs']) name;
select pg_temp.assert('d18 fixture: uexs is stored expired', pg_temp.close_as(pg_temp.r('uexs'), 'support') = 'expired');
select pg_temp.age_route(pg_temp.r('uaged'), interval '25 days', interval '25 days');
-- ulate corrected late by LB1 (D17's group 1: its window lapsed, it ends
-- wrong_patient now).
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.keep_late('ulate', 'lab_request', pg_temp.r('ulate'), pg_temp.v(pg_temp.r('ulate')), 'other',
  'own_check', pg_temp.lagos_today(), 'Found on our own audit of the run', 'd18-late-ulate-0001');
reset role;
-- ut8: a report row written by hand on an open accepted route (owner SQL,
-- triggers off): no command leaves such a row, and the command refuses it.
set local session_replication_role = replica;
insert into ehr.order_route_wrong_patient_reports (id, route_id, kind, receiving_facility_id, receiving_organization_id,
  ordering_facility_id, state_before, reason_code, note, reported_by_account_id, reported_by_membership_id,
  accepted_by_account_id, accepted_by_membership_id, accepted_at, accepted_with, recorded_by_membership_ids,
  reporter_recorded_work, specimens_collected, results_voided, result_reports_marked, dispensing_reversed,
  idempotency_key, request_sha256, correlation_id)
select gen_random_uuid(), route.id, route.kind, route.receiving_facility_id, route.receiving_organization_id,
  route.ordering_facility_id, 'accepted', 'other', 'Written by hand for the suite', route.accepted_by_account_id, route.accepted_by_membership_id,
  route.accepted_by_account_id, route.accepted_by_membership_id, route.accepted_at, 'health_id', array[]::uuid[],
  false, 0, 0, 0, false, 'd18-handmade-report-ut8', repeat('f', 64), 'd18-handmade-correlation'
  from ehr.order_routes route where route.id = pg_temp.r('ut8');
set local session_replication_role = origin;
-- Q's account deleted (owner SQL, triggers off): the inbox writer skips a
-- patient whose account was deleted.
set local session_replication_role = replica;
update auth.accounts set status = 'deleted' where id = 'e4c10000-0000-4000-8000-000000000042';
set local session_replication_role = origin;
select set_config('hid.test.ref_' || name, (select route.reference::text from ehr.order_routes route
    where route.id = pg_temp.r(name)), true),
  set_config('hid.test.patient_' || name, (select route.patient_id::text from ehr.order_routes route
    where route.id = pg_temp.r(name)), true)
  from unnest(array['usnt', 'udec', 'uwdn', 'uexp', 'uexs', 'ulap', 'uopc', 'ucpl', 'ucpe', 'uoc', 'uee', 'usup',
    'uorl', 'urrl', 'urep', 'ulate', 'ut8', 'uopa', 'ub', 'uw7', 'uchk', 'ueie', 'ucrit', 'ucv', 'uaged', 'ulim1',
    'ulim2', 'ulim3', 'ulim4', 'up', 'uq', 'ugl', 'xrx', 'xrx2', 'xrxo', 'xrxc']) name;
select pg_temp.assert('d18 fixture: each route''s state, ending and effective state before any ending',
  (select array_agg(name || ':' || route.state || ':' || coalesce(route.ended_kind, '-') || ':'
        || ehr.order_route_effective_state(route) order by position)
     from unnest(array['usnt', 'udec', 'uwdn', 'uexp', 'uexs', 'ulap', 'uopc', 'ucpl', 'ucpe', 'uoc', 'uee', 'usup',
       'uorl', 'urrl', 'urep', 'ulate', 'ut8', 'uopa', 'ub', 'uchk', 'uaged', 'up', 'uq', 'ugl', 'xrx', 'xrxc'])
       with ordinality listed(name, position)
     join ehr.order_routes route on route.id = pg_temp.r(listed.name))
  = array['usnt:sent:-:sent', 'udec:declined:-:declined', 'uwdn:withdrawn:orderer:withdrawn', 'uexp:sent:-:expired',
    'uexs:expired:not_accepted:expired', 'ulap:accepted:-:expired', 'uopc:completed:-:completed',
    'ucpl:completed:-:completed', 'ucpe:completed:support:completed', 'uoc:cancelled:order_changed:cancelled',
    'uee:cancelled:entered_in_error:cancelled', 'usup:cancelled:support:cancelled',
    'uorl:cancelled:ordering_released:cancelled', 'urrl:cancelled:receiving_released:cancelled',
    'urep:cancelled:wrong_patient:cancelled', 'ulate:cancelled:wrong_patient:cancelled', 'ut8:accepted:-:accepted',
    'uopa:accepted:-:accepted', 'ub:accepted:-:accepted', 'uchk:accepted:-:accepted', 'uaged:accepted:-:accepted',
    'up:accepted:-:accepted', 'uq:accepted:-:accepted', 'ugl:sent:-:sent', 'xrx:accepted:-:accepted',
    'xrxc:completed:-:completed'],
  (select string_agg(name || ':' || route.state || ':' || coalesce(route.ended_kind, '-') || ':'
        || ehr.order_route_effective_state(route), ', ' order by position)
     from unnest(array['usnt', 'udec', 'uwdn', 'uexp', 'uexs', 'ulap', 'uopc', 'ucpl', 'ucpe', 'uoc', 'uee', 'usup',
       'uorl', 'urrl', 'urep', 'ulate', 'ut8', 'uopa', 'ub', 'uchk', 'uaged', 'up', 'uq', 'ugl', 'xrx', 'xrxc'])
       with ordinality listed(name, position)
     join ehr.order_routes route on route.id = pg_temp.r(listed.name)));

-- 2. Refusals, which write nothing. LB1 at L1 through the Lab runtime unless
-- said otherwise.
select pg_temp.snap();
select set_config('hid.test.footprint_before_refusals', pg_temp.footprint18(), true);
create function pg_temp.refusal(name text, version_delta integer default 0, reason text default 'other',
  told boolean default false, kind text default 'lab_request') returns text language sql as $f$
  select format($s$select * from pg_temp.cannot(%L, %L, %s, %L, %L, %L)$s$, kind, pg_temp.r(name),
    pg_temp.v(pg_temp.r(name)) + version_delta, reason, 'd18-refusal-' || name || '-' || version_delta || '-' || reason,
    told)
$f$;
grant execute on function pg_temp.refusal(text,integer,text,boolean,text) to hid_lab_api_runtime,
  hid_pharmacy_api_runtime;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d18 refusal: sent', pg_temp.refusal('usnt'), 'P0001 ORDER_ROUTE_NOT_ACCEPTED');
select pg_temp.check('d18 refusal: declined', pg_temp.refusal('udec'), 'P0001 ORDER_ROUTE_NOT_ACCEPTED');
select pg_temp.check('d18 refusal: withdrawn', pg_temp.refusal('uwdn'), 'P0001 ORDER_ROUTE_NOT_ACCEPTED');
select pg_temp.check('d18 refusal: sent, past respond_by', pg_temp.refusal('uexp'), 'P0001 ORDER_ROUTE_NOT_ACCEPTED');
select pg_temp.check('d18 refusal: stored expired', pg_temp.refusal('uexs'), 'P0001 ORDER_ROUTE_NOT_ACCEPTED');
select pg_temp.check('d18 refusal: accepted, lapsed', pg_temp.refusal('ulap'), 'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: completed, open', pg_temp.refusal('uopc'), 'P0001 ORDER_ROUTE_ALREADY_RETURNED');
select pg_temp.check('d18 refusal: completed, open, stale version (the state first)', pg_temp.refusal('uopc', -1),
  'P0001 ORDER_ROUTE_ALREADY_RETURNED');
select pg_temp.check('d18 refusal: completed, lapsed', pg_temp.refusal('ucpl'), 'P0001 ORDER_ROUTE_ALREADY_RETURNED');
select pg_temp.check('d18 refusal: completed, ended by support', pg_temp.refusal('ucpe'),
  'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: cancelled, the order changed', pg_temp.refusal('uoc'),
  'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: cancelled, entered in error', pg_temp.refusal('uee'),
  'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: cancelled by support', pg_temp.refusal('usup'), 'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: cancelled, the ordering organization released', pg_temp.refusal('uorl'),
  'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: cancelled, the receiving organization released', pg_temp.refusal('urrl'),
  'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: reported in its window', pg_temp.refusal('urep'), 'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: reported late', pg_temp.refusal('ulate'), 'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: a report row on an open route', pg_temp.refusal('ut8'),
  'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: a stale version on an ended route (the state first)', pg_temp.refusal('usup', -1),
  'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('d18 refusal: a stale version on an open route', pg_temp.refusal('uopa', -1),
  'P0001 ORDER_ROUTE_VERSION_CONFLICT');
select pg_temp.check('d18 refusal: a newer version than the route''s', pg_temp.refusal('uopa', 1),
  'P0001 ORDER_ROUTE_VERSION_CONFLICT');
select pg_temp.check('d18 refusal: a checked result waits to be released', pg_temp.refusal('uchk'),
  'P0001 ORDER_ROUTE_RESULT_READY');
select pg_temp.check('d18 refusal: a checked result, with a stale version (the result first)',
  pg_temp.refusal('uchk', -1), 'P0001 ORDER_ROUTE_RESULT_READY');
select pg_temp.check('d18 refusal: a checked result, with the critical value told', pg_temp.refusal('ucv', 0,
  'supplies_unavailable', true), 'P0001 ORDER_ROUTE_RESULT_READY');
select pg_temp.check('d18 refusal: a possibly critical value without the statement', pg_temp.refusal('ucrit'),
  'P0001 ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD');
select pg_temp.check('d18 refusal: another facility''s route', pg_temp.refusal('ugl'), 'P0002 ORDER_ROUTE_NOT_FOUND');
select pg_temp.check('d18 refusal: a prescription through the Lab''s wrapper', pg_temp.refusal('xrx'),
  'P0002 ORDER_ROUTE_NOT_FOUND');
-- Every input.
select pg_temp.check('d18 refusal: no route', format($s$select * from pg_temp.cannot('lab_request', null, 2, 'other',
  'd18-refusal-input-0001')$s$), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: no version', format($s$select * from pg_temp.cannot('lab_request', %L, null, 'other',
  'd18-refusal-input-0002')$s$, pg_temp.r('uopa')), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: version 0', format($s$select * from pg_temp.cannot('lab_request', %L, 0, 'other',
  'd18-refusal-input-0003')$s$, pg_temp.r('uopa')), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: no reason', format($s$select * from pg_temp.cannot('lab_request', %L, %s, null,
  'd18-refusal-input-0004')$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: an unknown reason', format($s$select * from pg_temp.cannot('lab_request', %L, %s,
  'wrong_patient', 'd18-refusal-input-0005')$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))),
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: a pharmacy reason on a lab request', format($s$select * from pg_temp.cannot(
  'lab_request', %L, %s, 'out_of_stock', 'd18-refusal-input-0006')$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))),
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: a key too short', format($s$select * from pg_temp.cannot('lab_request', %L, %s,
  'other', 'd18-short')$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: a key with a space', format($s$select * from pg_temp.cannot('lab_request', %L, %s,
  'other', 'd18 refusal key 0001')$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: no key', format($s$select * from lab.cannot_complete_order_route(%L, %s, 'other',
  false, null, repeat('a', 64))$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: a digest in capitals', format($s$select * from pg_temp.cannot('lab_request', %L, %s,
  'other', 'd18-refusal-input-0009', false, repeat('A', 64))$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))),
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d18 refusal: no digest', format($s$select * from lab.cannot_complete_order_route(%L, %s, 'other',
  false, 'd18-refusal-input-0010', null)$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))),
  '22023 ORDER_ROUTE_INVALID');
reset role;
-- Another purpose, a receptionist, a member elsewhere, the other kind's
-- wrapper.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1, 'emergency');
select pg_temp.check('d18 refusal: purpose emergency', pg_temp.refusal('uopa'),
  '42501 Order route staff context is required');
select pg_temp.as_staff(32, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d18 refusal: RB, a receptionist at L1', pg_temp.refusal('uopa'),
  '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.check('d18 refusal: GLM, a laboratory member elsewhere', pg_temp.refusal('uopa'),
  'P0002 ORDER_ROUTE_NOT_FOUND');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d18 refusal: the Pharmacy''s wrapper as LB1 (no pharmacy receive permission)',
  pg_temp.refusal('uopa', 0, 'other', false, 'prescription'), '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.as_signup_admin(2);
select pg_temp.check('d18 refusal: the Pharmacy''s wrapper on a lab request, as PB1', pg_temp.refusal('uopa', 0,
  'other', false, 'prescription'), 'P0002 ORDER_ROUTE_NOT_FOUND');
select pg_temp.check('d18 refusal: completed (dispensed) prescription', pg_temp.refusal('xrxc', 0, 'out_of_stock',
  false, 'prescription'), 'P0001 ORDER_ROUTE_ALREADY_RETURNED');
select pg_temp.check('d18 refusal: a lab reason on a prescription', pg_temp.refusal('xrx', 0, 'sample_unusable', false,
  'prescription'), '22023 ORDER_ROUTE_INVALID');
reset role;
select pg_temp.assert('d18 refusal: the refusals wrote nothing (routes, events, reports, voids, outboxes, audit, inbox, T9, T10)',
  pg_temp.footprint18() = current_setting('hid.test.footprint_before_refusals'),
  current_setting('hid.test.footprint_before_refusals') || ' -> ' || pg_temp.footprint18());
-- The route-access control off (the control's own change is audited, so
-- every count but the audit's is compared).
create function pg_temp.footprint18_no_audit() returns text language sql stable as $f$
  select array_to_string((string_to_array(pg_temp.footprint18(), ','))[1:9]
    || (string_to_array(pg_temp.footprint18(), ','))[11:14], ',')
$f$;
select set_config('hid.test.footprint_before_control', pg_temp.footprint18_no_audit(), true);
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c suite pauses route access');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d18 refusal: the control off', pg_temp.refusal('uopa'),
  '55000 PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c suite resumes route access');
reset role;
select pg_temp.assert('d18 refusal: the control-off refusal wrote nothing',
  pg_temp.footprint18_no_audit() = current_setting('hid.test.footprint_before_control')
  and not exists (select 1 from audit.events event where event.action = 'ehr.order-route.not-completed'),
  current_setting('hid.test.footprint_before_control') || ' -> ' || pg_temp.footprint18_no_audit());

-- 3. Success. Each ending as the Lab or Pharmacy runtime; its route, both
-- windows, the event, T10's row, the two audit rows, the notice and the
-- answer, read as the owner.
create function pg_temp.expected_details(name text, reason text, specimens integer, results integer,
  criticals integer) returns jsonb language sql stable as $f$
  select jsonb_build_object('routeId', route.id, 'kind', route.kind, 'state', 'cancelled', 'reason', reason,
    'specimensCollected', specimens, 'resultsRecorded', results, 'criticalCandidates', criticals,
    'criticalValueTold', criticals > 0)
    from ehr.order_routes route where route.id = pg_temp.r(name)
$f$;
create function pg_temp.expected_audit(name text, reason text, specimens integer, results integer, criticals integer)
returns text language sql stable as $f$
  select 'A|true|system|success|' || pg_temp.expected_details(name, reason, specimens, results, criticals)::text
    || ' ; B|true|system|success|' || pg_temp.expected_details(name, reason, specimens, results, criticals)::text
$f$;
create function pg_temp.expected_notice(name text) returns text language sql stable as $f$
  select 'ORDER_ROUTE_NOT_COMPLETED|' || jsonb_build_object('routeId', route.id, 'kind', route.kind,
    'orderingFacilityName', (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
    'receivingFacilityName', (select facility.name from identity.facilities facility where facility.id = route.receiving_facility_id))::text
    from ehr.order_routes route where route.id = pg_temp.r(name)
$f$;
-- One ending's whole record: answer, route, event, T10 row, audit, notice.
create function pg_temp.ending_record(name text, label text, reason text, ender_account uuid, ender_membership uuid,
  by_acceptor boolean, accession boolean, specimens integer, results integer, criticals integer, reads text,
  key text, notified boolean)
returns text language plpgsql stable as $f$
declare
  route ehr.order_routes%rowtype;
  answer jsonb := pg_temp.ended(label);
  event ehr.order_route_events%rowtype;
  ending jsonb := pg_temp.ending(name);
  problems text[] := array[]::text[];
  wanted_notice text;
begin
  select * into route from ehr.order_routes candidate where candidate.id = pg_temp.r(name);
  select * into event from ehr.order_route_events candidate where candidate.route_id = route.id
   order by candidate.event_version desc limit 1;
  if answer is null or answer ->> 'result' <> 'ended' or (answer ->> 'ending_id')::uuid <> (ending ->> 'id')::uuid
     or (answer ->> 'route_row_version')::bigint <> route.row_version
     or (answer ->> 'route_row_version')::bigint
        <> (select version_row.row_version from d18_windows version_row where version_row.route_id = route.id) + 1
     or answer ->> 'route_state' <> 'cancelled' or answer ->> 'effective_state' <> 'cancelled'
     or answer ->> 'ended_kind' <> 'receiving_unable' or answer ->> 'reason_code' <> reason
     or (answer ->> 'access_ends_at')::timestamptz <> route.access_ends_at
     or (answer ->> 'specimens_collected')::integer <> specimens or (answer ->> 'results_recorded')::integer <> results
     or (answer ->> 'critical_candidates')::integer <> criticals or (answer ->> 'patient_id')::uuid <> route.patient_id then
    problems := problems || ('answer ' || coalesce(answer::text, 'none'));
  end if;
  if route.state <> 'cancelled' or route.ended_kind <> 'receiving_unable'
     or route.ended_by_account_id <> ender_account or route.writes_end_at <> route.ended_at
     or route.ended_at > clock_timestamp() or route.ended_at < clock_timestamp() - interval '10 minutes'
     or (reads = 'now' and route.access_ends_at <> route.ended_at)
     or (reads = '7 days' and route.access_ends_at <> route.ended_at + interval '168 hours')
     or (reads = 'as before' and route.access_ends_at
           <> (select version_row.access_ends_at from d18_windows version_row where version_row.route_id = route.id)) then
    problems := problems || ('route ' || pg_temp.d18_route(name));
  end if;
  if event.event_type <> 'cancelled' or event.side <> 'receiving' or event.reason_code <> 'receiving_unable'
     or event.state_after <> 'cancelled' or event.actor_account_id <> ender_account
     or event.actor_membership_id <> ender_membership or event.event_version <> route.row_version
     or event.writes_end_at_after <> route.writes_end_at or event.access_ends_at_after <> route.access_ends_at then
    problems := problems || ('event ' || to_jsonb(event)::text);
  end if;
  if ending is null or ending ->> 'kind' <> route.kind
     or (ending ->> 'receiving_facility_id')::uuid <> route.receiving_facility_id
     or (ending ->> 'receiving_organization_id')::uuid <> route.receiving_organization_id
     or (ending ->> 'ordering_facility_id')::uuid <> route.ordering_facility_id
     or ending ->> 'reason_code' <> reason or (ending ->> 'ended_by_account_id')::uuid <> ender_account
     or (ending ->> 'ended_by_membership_id')::uuid <> ender_membership
     or (ending ->> 'accepted_by_membership_id')::uuid <> route.accepted_by_membership_id
     or (ending ->> 'accepted_at')::timestamptz <> route.accepted_at
     or (ending ->> 'ended_by_acceptor')::boolean <> by_acceptor
     or (ending ->> 'minutes_after_acceptance')::integer
        <> floor(extract(epoch from ((ending ->> 'recorded_at')::timestamptz - route.accepted_at)) / 60)::integer
          and (ending ->> 'minutes_after_acceptance')::integer
        <> floor(extract(epoch from ((ending ->> 'recorded_at')::timestamptz - route.accepted_at)) / 60)::integer - 1
     or (ending ->> 'accession_made')::boolean <> accession
     or (ending ->> 'specimens_collected')::integer <> specimens or (ending ->> 'results_recorded')::integer <> results
     or (ending ->> 'critical_candidates')::integer <> criticals
     or (ending ->> 'critical_value_told')::boolean <> (criticals > 0)
     or ending ->> 'idempotency_key' <> key or ending ->> 'request_sha256' <> encode(sha256(key::bytea), 'hex')
     or ending ->> 'correlation_id' <> current_setting('hid.test.corr_' || name)
     or (ending ->> 'recorded_at')::timestamptz < route.ended_at then
    problems := problems || ('T10 ' || coalesce(ending::text, 'none'));
  end if;
  if pg_temp.ending_audit(name) is distinct from pg_temp.expected_audit(name, reason, specimens, results, criticals) then
    problems := problems || ('audit ' || coalesce(pg_temp.ending_audit(name), 'none'));
  end if;
  wanted_notice := case when notified then pg_temp.expected_notice(name) else 'none' end;
  if pg_temp.notices(name, 'ORDER_ROUTE_NOT_COMPLETED') <> wanted_notice then
    problems := problems || ('notice ' || pg_temp.notices(name, 'ORDER_ROUTE_NOT_COMPLETED'));
  end if;
  return coalesce(nullif(array_to_string(problems, ' ; '), ''), 'ok');
end
$f$;
-- Each route's windows before its ending.
create temp table d18_windows on commit drop as
  select route.id as route_id, route.writes_end_at, route.access_ends_at, route.row_version from ehr.order_routes route;
grant select on d18_windows to hid_lab_api_runtime, hid_pharmacy_api_runtime;
select pg_temp.snap();
-- uopa: nothing recorded, by LB1, who accepted it.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.keep_cannot('uopa', 'lab_request', pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa')), 'test_not_offered',
  'd18-end-uopa-0000001');
select set_config('hid.test.corr_uopa', current_setting('app.correlation_id'), true);
-- ub: an accession, a received and a rejected specimen, an unverified
-- result, by LB2, who did not accept it.
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.keep_cannot('ub', 'lab_request', pg_temp.r('ub'), pg_temp.v(pg_temp.r('ub')), 'supplies_unavailable',
  'd18-end-ub-00000001');
select set_config('hid.test.corr_ub', current_setting('app.correlation_id'), true);
-- uw7: an accession, a received specimen, an unverified result, by LB1.
select pg_temp.as_signup_admin(1);
select pg_temp.keep_cannot('uw7', 'lab_request', pg_temp.r('uw7'), pg_temp.v(pg_temp.r('uw7')), 'equipment_unavailable',
  'd18-end-uw7-0000001');
select set_config('hid.test.corr_uw7', current_setting('app.correlation_id'), true);
reset role;
-- uchk: its checked result corrected (a new, unverified version), then the
-- ending is allowed; ueie: its checked version marked entered in error,
-- allowed too.
select pg_temp.lab_next_version(pg_temp.res('uchk'), 'd18uchk', 12.2, null, null, false);
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.keep_cannot('uchk', 'lab_request', pg_temp.r('uchk'), pg_temp.v(pg_temp.r('uchk')), 'sample_unusable',
  'd18-end-uchk-000001');
select set_config('hid.test.corr_uchk', current_setting('app.correlation_id'), true);
select pg_temp.keep_cannot('ueie', 'lab_request', pg_temp.r('ueie'), pg_temp.v(pg_temp.r('ueie')), 'other',
  'd18-end-ueie-000001');
select set_config('hid.test.corr_ueie', current_setting('app.correlation_id'), true);
-- ucrit: refused without the statement (section 2, under another key);
-- with it, under a new key, ended, and the critical facts recorded.
select pg_temp.keep_cannot('ucrit', 'lab_request', pg_temp.r('ucrit'), pg_temp.v(pg_temp.r('ucrit')),
  'equipment_unavailable', 'd18-end-ucrit-00001', true);
select set_config('hid.test.corr_ucrit', current_setting('app.correlation_id'), true);
-- uaged: accepted 25 days ago, an accession: reads stay as they were (5
-- days), never 7 more.
select pg_temp.keep_cannot('uaged', 'lab_request', pg_temp.r('uaged'), pg_temp.v(pg_temp.r('uaged')),
  'cannot_meet_priority', 'd18-end-uaged-00001');
select set_config('hid.test.corr_uaged', current_setting('app.correlation_id'), true);
-- up: P's, an accession; P is told.
select pg_temp.keep_cannot('up', 'lab_request', pg_temp.r('up'), pg_temp.v(pg_temp.r('up')), 'cannot_meet_priority',
  'd18-end-up-00000001');
select set_config('hid.test.corr_up', current_setting('app.correlation_id'), true);
-- uq: Q's account was deleted: no notice.
select pg_temp.keep_cannot('uq', 'lab_request', pg_temp.r('uq'), pg_temp.v(pg_temp.r('uq')), 'patient_did_not_return',
  'd18-end-uq-00000001');
select set_config('hid.test.corr_uq', current_setting('app.correlation_id'), true);
reset role;
-- Prescriptions: xrx by PB1, who accepted it; xrx2 by PB2, who did not.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(2);
select pg_temp.keep_cannot('xrx', 'prescription', pg_temp.r('xrx'), pg_temp.v(pg_temp.r('xrx')), 'out_of_stock',
  'd18-end-xrx-0000001');
select set_config('hid.test.corr_xrx', current_setting('app.correlation_id'), true);
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.keep_cannot('xrx2', 'prescription', pg_temp.r('xrx2'), pg_temp.v(pg_temp.r('xrx2')),
  'needs_prescriber_review', 'd18-end-xrx2-000001');
select set_config('hid.test.corr_xrx2', current_setting('app.correlation_id'), true);
reset role;
select pg_temp.assert('d18 ended: uopa (nothing recorded; reads end now; by its acceptor)',
  pg_temp.ending_record('uopa', 'uopa', 'test_not_offered', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, false, 0, 0, 0, 'now', 'd18-end-uopa-0000001', true) = 'ok',
  pg_temp.ending_record('uopa', 'uopa', 'test_not_offered', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, false, 0, 0, 0, 'now', 'd18-end-uopa-0000001', true));
select pg_temp.assert('d18 ended: ub (an accession, two specimens collected, one rejected, one result; reads 7 days; '
    || 'by LB2, not its acceptor)',
  pg_temp.ending_record('ub', 'ub', 'supplies_unavailable', 'e4c10000-0000-4000-8000-000000000031',
    'e4c13000-0000-4000-8000-000000000031', false, true, 2, 1, 0, '7 days', 'd18-end-ub-00000001', true) = 'ok',
  pg_temp.ending_record('ub', 'ub', 'supplies_unavailable', 'e4c10000-0000-4000-8000-000000000031',
    'e4c13000-0000-4000-8000-000000000031', false, true, 2, 1, 0, '7 days', 'd18-end-ub-00000001', true));
select pg_temp.assert('d18 ended: uw7 (an accession; reads 7 days)',
  pg_temp.ending_record('uw7', 'uw7', 'equipment_unavailable', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 0, '7 days', 'd18-end-uw7-0000001', true) = 'ok',
  pg_temp.ending_record('uw7', 'uw7', 'equipment_unavailable', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 0, '7 days', 'd18-end-uw7-0000001', true));
select pg_temp.assert('d18 ended: uchk once its checked result was corrected (a new, unverified version)',
  pg_temp.ending_record('uchk', 'uchk', 'sample_unusable', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 0, '7 days', 'd18-end-uchk-000001', true) = 'ok',
  pg_temp.ending_record('uchk', 'uchk', 'sample_unusable', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 0, '7 days', 'd18-end-uchk-000001', true));
select pg_temp.assert('d18 ended: ueie once its checked version was marked entered in error',
  pg_temp.ending_record('ueie', 'ueie', 'other', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 0, '7 days', 'd18-end-ueie-000001', true) = 'ok',
  pg_temp.ending_record('ueie', 'ueie', 'other', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 0, '7 days', 'd18-end-ueie-000001', true));
select pg_temp.assert('d18 ended: ucrit with the critical-value statement (one possibly critical value recorded, told)',
  pg_temp.ending_record('ucrit', 'ucrit', 'equipment_unavailable', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 1, '7 days', 'd18-end-ucrit-00001', true) = 'ok',
  pg_temp.ending_record('ucrit', 'ucrit', 'equipment_unavailable', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 1, '7 days', 'd18-end-ucrit-00001', true));
select pg_temp.assert('d18 ended: uaged (reads end when they would have, 5 days on, not 7; minutes since acceptance)',
  pg_temp.ending_record('uaged', 'uaged', 'cannot_meet_priority', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 0, 'as before', 'd18-end-uaged-00001', true) = 'ok'
  and (pg_temp.ending('uaged') ->> 'minutes_after_acceptance')::integer between 35999 and 36001,
  pg_temp.ending_record('uaged', 'uaged', 'cannot_meet_priority', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 0, 'as before', 'd18-end-uaged-00001', true)
    || ' / ' || (pg_temp.ending('uaged') ->> 'minutes_after_acceptance'));
select pg_temp.assert('d18 ended: up (P''s; P is told)',
  pg_temp.ending_record('up', 'up', 'cannot_meet_priority', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 1, 1, 0, '7 days', 'd18-end-up-00000001', true) = 'ok',
  pg_temp.ending_record('up', 'up', 'cannot_meet_priority', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, true, 0, 0, 0, '7 days', 'd18-end-up-00000001', true));
select pg_temp.assert('d18 ended: uq (Q''s account deleted: no notice, as for every order notice)',
  pg_temp.ending_record('uq', 'uq', 'patient_did_not_return', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, false, 0, 0, 0, 'now', 'd18-end-uq-00000001', false) = 'ok',
  pg_temp.ending_record('uq', 'uq', 'patient_did_not_return', current_setting('hid.test.account_1')::uuid,
    current_setting('hid.test.membership_1')::uuid, true, false, 0, 0, 0, 'now', 'd18-end-uq-00000001', false));
select pg_temp.assert('d18 ended: xrx (prescription; reads end now; by its acceptor)',
  pg_temp.ending_record('xrx', 'xrx', 'out_of_stock', current_setting('hid.test.account_2')::uuid,
    current_setting('hid.test.membership_2')::uuid, true, false, 0, 0, 0, 'now', 'd18-end-xrx-0000001', true) = 'ok',
  pg_temp.ending_record('xrx', 'xrx', 'out_of_stock', current_setting('hid.test.account_2')::uuid,
    current_setting('hid.test.membership_2')::uuid, true, false, 0, 0, 0, 'now', 'd18-end-xrx-0000001', true));
select pg_temp.assert('d18 ended: xrx2 (prescription; by PB2, not its acceptor)',
  pg_temp.ending_record('xrx2', 'xrx2', 'needs_prescriber_review', 'e4c10000-0000-4000-8000-000000000033',
    'e4c13000-0000-4000-8000-000000000033', false, false, 0, 0, 0, 'now', 'd18-end-xrx2-000001', true) = 'ok',
  pg_temp.ending_record('xrx2', 'xrx2', 'needs_prescriber_review', 'e4c10000-0000-4000-8000-000000000033',
    'e4c13000-0000-4000-8000-000000000033', false, false, 0, 0, 0, 'now', 'd18-end-xrx2-000001', true));
select pg_temp.assert('d18 ended: the results B recorded stay as they were (none voided, none released)',
  not exists (select 1 from lab.result_invalidations invalidation
               where invalidation.result_id in (pg_temp.res('ub'), pg_temp.res('uw7'), pg_temp.res('ucrit'),
                 pg_temp.res('up')))
  and not exists (select 1 from lab.result_releases release_row
               where release_row.result_id in (pg_temp.res('ub'), pg_temp.res('uw7'), pg_temp.res('ucrit'),
                 pg_temp.res('up'), pg_temp.res('uchk'))));

-- 4. Afterwards.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
insert into d18_out (label, answer)
select 'access-' || name || '-' || action, to_jsonb(access_row)
  from unnest(array['uopa', 'uw7']) name
  cross join unnest(array['write_records', 'read_records']) action
  cross join lateral lab.order_route_access_for('work_item', pg_temp.i(name), action) access_row;
insert into d18_out (label, answer)
select 'card-' || name, to_jsonb(card) from unnest(array['uopa', 'uw7']) name
  cross join lateral lab.order_route_cards(array[pg_temp.i(name)]) card;
reset role;
select pg_temp.assert('d18 after: writes closed; reads allowed with an accession, none at once without',
  (select string_agg(label || '=' || (answer ->> 'outcome'), ', ' order by label) from d18_out where label like 'access-%')
  = 'access-uopa-read_records=none, access-uopa-write_records=closed, access-uw7-read_records=allowed, '
    || 'access-uw7-write_records=closed',
  (select string_agg(label || '=' || (answer ->> 'outcome'), ', ' order by label) from d18_out where label like 'access-%'));
select pg_temp.assert('d18 after: the cards: uw7 read-only with its ending; none for uopa',
  (select string_agg(label || '=' || (answer ->> 'access') || '|' || (answer ->> 'ended_kind') || '|'
      || (answer ->> 'effective_state'), ', ' order by label) from d18_out where label like 'card-%')
  = 'card-uw7=read|receiving_unable|cancelled',
  (select string_agg(label || '=' || answer::text, ', ' order by label) from d18_out where label like 'card-%'));
-- uw7's reads end at access_ends_at: aged past it (owner SQL), item access
-- answers none and its card goes.
select pg_temp.age_route(pg_temp.r('uw7'), interval '8 days', interval '8 days');
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
insert into d18_out (label, answer)
select 'aged-access-uw7', to_jsonb(access_row)
  from lab.order_route_access_for('work_item', pg_temp.i('uw7'), 'read_records') access_row;
insert into d18_out (label, answer)
select 'aged-card-uw7', to_jsonb(card) from lab.order_route_cards(array[pg_temp.i('uw7')]) card;
reset role;
select pg_temp.assert('d18 after: once its reads ended, uw7 answers none and has no card',
  (select answer ->> 'outcome' from d18_out where label = 'aged-access-uw7') = 'none'
  and not exists (select 1 from d18_out where label = 'aged-card-uw7'));
-- up: a verification whose access check passed before the ending lands
-- after it (owner SQL, as in the race); a release is refused by route
-- access and under P's consent (LB3): nothing crosses.
select set_config('hid.test.up_verification', pg_temp.verify_current(pg_temp.res('up'),
  current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select set_config('hid.test.up_release_route', pg_temp.outcome(format($s$select pg_temp.release(%L, 1, %L,
  'd18-release-up-route')$s$, pg_temp.res('up'), current_setting('hid.test.up_verification'))), true);
select pg_temp.as_extra(34, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d18 after: a release of up''s result under P''s consent at L1 (LB3)', format($s$select
  pg_temp.release(%L, 1, %L, 'd18-release-up-consent')$s$, pg_temp.res('up'), current_setting('hid.test.up_verification')),
  '23514 ORDER_ROUTE_CLOSED');
reset role;
select pg_temp.assert('d18 after: a release of up''s result by route access is refused (its write policy: writes ended)',
  current_setting('hid.test.up_release_route')
    = '42501 new row violates row-level security policy for table "result_releases"'
  and not exists (select 1 from lab.result_releases release_row where release_row.result_id = pg_temp.res('up'))
  and not exists (select 1 from lab.order_route_result_reports report_row where report_row.route_id = pg_temp.r('up')),
  current_setting('hid.test.up_release_route'));
-- A dispensing on xrx: by PB2 (route access) and under P's consent (PB3).
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select set_config('hid.test.xrx_dispense_route', pg_temp.outcome(format($s$select pg_temp.dispense(%L,
  'd18-dispense-xrx-route')$s$, pg_temp.i('xrx'))), true);
select pg_temp.as_pb3();
select pg_temp.check('d18 after: a dispensing on xrx under P''s consent at PH1 (PB3)', format($s$select
  pg_temp.dispense(%L, 'd18-dispense-xrx-consent')$s$, pg_temp.i('xrx')), '23514 ORDER_ROUTE_CLOSED');
reset role;
select pg_temp.assert('d18 after: a dispensing on xrx by route access is refused (the validator, before the write policy), and none exists',
  -- (the validator answers ORDER_ROUTE_CLOSED where its owner bypasses
  -- row-level security, and finds no eligible work item where it is bound
  -- by it, as on production's NOSUPERUSER owner: reads ended at once)
  current_setting('hid.test.xrx_dispense_route') in ('23514 ORDER_ROUTE_CLOSED',
    '23514 Dispensing does not match its eligible Pharmacy work item and actor context')
  and not exists (select 1 from pharmacy.dispensings dispensing where dispensing.work_item_id = pg_temp.i('xrx')),
  current_setting('hid.test.xrx_dispense_route'));
-- Item 3's report and support's Close of an order ended this way.
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d18 after: item 3''s report of uopa', format($s$select * from pg_temp.wrong_patient('lab_request',
  %L, %s, 'someone_elses_details', 'The person was not the patient', 'd18-after-c25-uopa01')$s$, pg_temp.r('uopa'),
  pg_temp.v(pg_temp.r('uopa'))), 'P0001 ORDER_ROUTE_ALREADY_ENDED');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('d18 after: support''s Close of uopa', format($s$select * from identity.admin_close_order_route(%L,
  %s, 'The hospital asked support to close it')$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))),
  '23505 ORDER_ROUTE_ALREADY_CLOSED');
reset role;
-- A's order change (DA cancels uopa's order) leaves the route as it is.
select set_config('hid.test.uopa_before_change', pg_temp.d18_route('uopa') || '|' || (select count(*)
  from ehr.order_route_events event where event.route_id = pg_temp.r('uopa')), true);
set local role hid_ehr_api_runtime;
select pg_temp.edit_lab(pg_temp.o('uopa'), 'cancelled', 'No longer needed');
reset role;
select pg_temp.assert('d18 after: A''s change of the order leaves the route as it is',
  pg_temp.d18_route('uopa') || '|' || (select count(*) from ehr.order_route_events event
    where event.route_id = pg_temp.r('uopa')) = current_setting('hid.test.uopa_before_change')
  and (select lab_request.status from ehr.lab_requests lab_request where lab_request.id = pg_temp.o('uopa')) = 'cancelled',
  pg_temp.d18_route('uopa'));
-- The same order cannot be sent again (to B or elsewhere); a new one can.
set local role hid_ehr_api_runtime;
select pg_temp.check('d18 after: uw7''s order sent again to L1', format($s$select pg_temp.send(11, 'lab_request', %L,
  %L, 'd18-resend-uw7-l1-0001')$s$, pg_temp.o('uw7'), current_setting('hid.test.facility_1')),
  'P0001 ORDER_ROUTE_ORDER_IN_WORK');
select pg_temp.check('d18 after: uw7''s order sent to GL', format($s$select pg_temp.send(11, 'lab_request', %L,
  'e4c21000-0000-4000-8000-000000000002', 'd18-resend-uw7-gl-0001')$s$, pg_temp.o('uw7')),
  'P0001 ORDER_ROUTE_ORDER_IN_WORK');
select pg_temp.check('d18 after: a new order sent to L1', format($s$select pg_temp.order_to('unew', 'lab_request', 4,
  %L)$s$, current_setting('hid.test.facility_1')), 'ok');
reset role;
-- The readers: C3 and C4 as DA at GH (the EHR runtime), A's events, C5 as
-- P, C21 as support, C30 as LB1.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
insert into d18_out (label, answer)
select 'c3-' || name, to_jsonb(found) from unnest(array['uopa', 'uw7', 'usup']) name
  cross join lateral ehr.list_order_routes_for_order('lab_request', pg_temp.patient_of(name), pg_temp.o(name)) found
 where found.route_id = pg_temp.r(name);
insert into d18_out (label, answer)
select 'c4-' || name, found.summary from unnest(array['uopa', 'ub', 'uw7', 'uchk', 'ucrit', 'usup', 'usnt']) name
  cross join lateral ehr.order_route_summaries('lab_request', pg_temp.patient_of(name), array[pg_temp.o(name)]) found;
insert into d18_out (label, answer)
select 'c4-' || name, found.summary from unnest(array['xrx', 'xrxc']) name
  cross join lateral ehr.order_route_summaries('prescription', pg_temp.patient_of(name), array[pg_temp.o(name)]) found;
select pg_temp.as_patient(1);
insert into d18_out (label, answer)
select 'c5-' || name, to_jsonb(listed) from unnest(array['up', 'xrx']) name
  join ehr.patient_list_order_routes() listed on listed.route_id = pg_temp.r(name);
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
insert into d18_out (label, answer)
select 'c21-' || name, to_jsonb(found) from unnest(array['uopa', 'xrx']) name
  cross join lateral identity.admin_find_order_routes(pg_temp.ref(name), null) found where found.route_id = pg_temp.r(name);
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.look('c30-uopa', 'lab_request', pg_temp.ref('uopa'));
reset role;
select pg_temp.assert('d18 readers: C4''s notCompleted: the reason, a sample taken and a result recorded for a lab '
    || 'request, null for a prescription; null for an order that ended another way or is open',
  (select string_agg(label || '=' || coalesce((answer -> 'notCompleted')::text, 'absent'), ', ' order by label)
     from d18_out where label like 'c4-%')
  = 'c4-ub={"reason": "supplies_unavailable", "sampleTaken": true, "resultRecorded": true}, '
    || 'c4-uchk={"reason": "sample_unusable", "sampleTaken": true, "resultRecorded": true}, '
    || 'c4-ucrit={"reason": "equipment_unavailable", "sampleTaken": true, "resultRecorded": true}, '
    || 'c4-uopa={"reason": "test_not_offered", "sampleTaken": false, "resultRecorded": false}, '
    || 'c4-usnt=null, c4-usup=null, '
    || 'c4-uw7={"reason": "equipment_unavailable", "sampleTaken": true, "resultRecorded": true}, '
    || 'c4-xrx={"reason": "out_of_stock", "sampleTaken": null, "resultRecorded": null}, c4-xrxc=null',
  (select string_agg(label || '=' || coalesce((answer -> 'notCompleted')::text, 'absent'), ', ' order by label)
     from d18_out where label like 'c4-%'));
select pg_temp.assert('d18 readers: C4''s other keys for uopa: cancelled, receiving_unable, its end, the late-correction '
    || 'deadline, no report, no resend',
  (select answer ->> 'effectiveState' = 'cancelled' and answer ->> 'endedKind' = 'receiving_unable'
      and (answer ->> 'endedAt')::timestamptz = (pg_temp.route(pg_temp.r('uopa'))).ended_at
      and (answer ->> 'correctableUntil')::timestamptz = (pg_temp.route(pg_temp.r('uopa'))).accepted_at + interval '4320 hours'
      and answer -> 'wrongPatient' = 'null'::jsonb and answer -> 'resendAllowed' = 'false'::jsonb
      and (answer ->> 'version')::bigint = (pg_temp.route(pg_temp.r('uopa'))).row_version
     from d18_out where label = 'c4-uopa'));
select pg_temp.assert('d18 readers: C3 carries the same summary and A''s events end with cancelled / receiving / '
    || 'receiving_unable',
  (select (answer -> 'summary' -> 'notCompleted') = (select c4.answer -> 'notCompleted' from d18_out c4 where c4.label = 'c4-uopa')
      and (answer -> 'events' -> -1 ->> 'type') = 'cancelled' and (answer -> 'events' -> -1 ->> 'side') = 'receiving'
      and (answer -> 'events' -> -1 ->> 'reasonCode') = 'receiving_unable'
     from d18_out where label = 'c3-uopa')
  and (select (answer -> 'summary' -> 'notCompleted') = 'null'::jsonb from d18_out where label = 'c3-usup'),
  (select answer::text from d18_out where label = 'c3-uopa'));
select pg_temp.assert('d18 readers: C5 lists up and xrx as cancelled, receiving_unable, with the late-correction deadline',
  (select string_agg(label || '=' || (answer ->> 'effective_state') || '|' || (answer ->> 'ended_kind') || '|'
      || ((answer ->> 'correctable_until') is not null)::text || '|' || (answer ? 'notCompleted')::text, ', '
      order by label) from d18_out where label like 'c5-%')
  = 'c5-up=cancelled|receiving_unable|true|false, c5-xrx=cancelled|receiving_unable|true|false',
  (select string_agg(label || '=' || answer::text, ', ' order by label) from d18_out where label like 'c5-%'));
select pg_temp.assert('d18 readers: C21 finds uopa and xrx: cancelled, receiving_unable, not closable, correctable',
  (select string_agg(label || '=' || (answer ->> 'effective_state') || '|' || (answer ->> 'ended_kind') || '|'
      || (answer ->> 'closable') || '|' || (answer ->> 'correction') || '|'
      || ((answer ->> 'correctable_until') is not null)::text, ', ' order by label) from d18_out where label like 'c21-%')
  = 'c21-uopa=cancelled|receiving_unable|false|correctable|true, c21-xrx=cancelled|receiving_unable|false|correctable|true',
  (select string_agg(label || '=' || answer::text, ', ' order by label) from d18_out where label like 'c21-%'));
select pg_temp.assert('d18 readers: B''s lookup (C30) lists uopa as correctable, receiving_unable, after its reads ended',
  (select pg_temp.found('c30-uopa') ->> 'correction_state') = 'correctable'
  and (select pg_temp.found('c30-uopa') ->> 'ended_kind') = 'receiving_unable',
  pg_temp.found('c30-uopa')::text);

-- 5. D17 after D18: the late correction of orders ended this way.
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
-- ub right after its ending (reads still open, 7 days).
select pg_temp.keep_late('late-ub', 'lab_request', pg_temp.r('ub'), pg_temp.v(pg_temp.r('ub')), 'someone_elses_details',
  'own_check', pg_temp.lagos_today(), 'The person served was not the patient', 'd18-late-ub-000001');
-- uw7 after its reads ended (aged above): through D17's capability.
select pg_temp.keep_late('late-uw7', 'lab_request', pg_temp.r('uw7'), pg_temp.v(pg_temp.r('uw7')), 'wrong_order_chosen',
  'patient', pg_temp.lagos_today(), 'The patient said it was not them', 'd18-late-uw7-000001');
-- uopa: no accession, so its reads ended at once.
select pg_temp.keep_late('late-uopa', 'lab_request', pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa')), 'other',
  'ordering_facility', pg_temp.lagos_today(), 'The clinic said it was another person', 'd18-late-uopa-00001');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
-- xrx2: a prescription, its reads ended at once.
select pg_temp.keep_late('late-xrx2', 'prescription', pg_temp.r('xrx2'), pg_temp.v(pg_temp.r('xrx2')),
  'someone_elses_details', 'own_check', pg_temp.lagos_today(), 'The person served was not the patient',
  'd18-late-xrx2-00001');
reset role;
select pg_temp.assert('d18 late: each corrected, its ending kept, the earlier ending receiving_unable, the voids',
  (select string_agg(name || '=' || (pg_temp.answer('late-' || name) ->> 'result') || '|'
      || (pg_temp.answer('late-' || name) ->> 'ended_kind') || '|' || (pg_temp.answer('late-' || name) ->> 'ended_kind_before')
      || '|' || (pg_temp.answer('late-' || name) ->> 'state_before') || '|'
      || (pg_temp.answer('late-' || name) ->> 'results_voided') || '|'
      || (pg_temp.answer('late-' || name) ->> 'dispensing_reversed'), ', ' order by name)
     from unnest(array['ub', 'uw7', 'uopa', 'xrx2']) name)
  = 'ub=corrected|receiving_unable|receiving_unable|cancelled|1|false, '
    || 'uopa=corrected|receiving_unable|receiving_unable|cancelled|0|false, '
    || 'uw7=corrected|receiving_unable|receiving_unable|cancelled|1|false, '
    || 'xrx2=corrected|receiving_unable|receiving_unable|cancelled|0|false',
  (select string_agg(name || '=' || coalesce(pg_temp.answer('late-' || name)::text, 'none'), ' ; ')
     from unnest(array['ub', 'uw7', 'uopa', 'xrx2']) name));
select pg_temp.assert('d18 late: the report rows (late, cancelled, receiving_unable), the voids, the notices, T9 empty',
  (select count(*) from ehr.order_route_wrong_patient_reports report
    where report.route_id in (pg_temp.r('ub'), pg_temp.r('uw7'), pg_temp.r('uopa'), pg_temp.r('xrx2'))
      and report.late and report.state_before = 'cancelled' and report.ended_kind_before = 'receiving_unable') = 4
  and (select count(*) from lab.result_invalidations invalidation
        where invalidation.result_id in (pg_temp.res('ub'), pg_temp.res('uw7'))) = 2
  and (select count(*) from notification.inbox_items item
        where item.resource_id in (pg_temp.r('ub'), pg_temp.r('uw7'), pg_temp.r('uopa'), pg_temp.r('xrx2'))
          and item.notification_code = 'ORDER_ROUTE_WRONG_PATIENT_CORRECTED') = 4
  and (select bool_and(route.state = 'cancelled' and route.ended_kind = 'receiving_unable') from ehr.order_routes route
        where route.id in (pg_temp.r('ub'), pg_temp.r('uw7'), pg_temp.r('uopa'), pg_temp.r('xrx2')))
  and pg_temp.capabilities() = 0);
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
insert into d18_out (label, answer)
select 'late-c4-' || name, found.summary from unnest(array['ub', 'uopa']) name
  cross join lateral ehr.order_route_summaries('lab_request', pg_temp.patient_of(name), array[pg_temp.o(name)]) found;
reset role;
select pg_temp.assert('d18 late: once reported, the summary answers notCompleted null and the late report',
  (select bool_and(answer -> 'notCompleted' = 'null'::jsonb and (answer -> 'wrongPatient' ->> 'late')::boolean
      and answer -> 'correctableUntil' = 'null'::jsonb) and count(*) = 2
     from d18_out where label like 'late-c4-%'),
  (select string_agg(answer::text, ' ; ') from d18_out where label like 'late-c4-%'));
-- Support's list (C26): flagged late_correction with the earlier ending,
-- no required action (nothing came back), first among the unreviewed; its
-- review (C27) with no further action (D18-12).
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
insert into d18_out (label, answer)
select 'c26-' || listed.reference, to_jsonb(listed) || jsonb_build_object('position', row_number() over ())
  from identity.admin_list_wrong_patient_reports('unreviewed', current_setting('hid.test.facility_1')::uuid) listed;
reset role;
select pg_temp.assert('d18 late: C26 lists ub''s, uw7''s and uopa''s reports with late_correction, ended before as '
    || 'receiving_unable, no required action, before the unflagged ones',
  (select bool_and((answer -> 'flags') ? 'late_correction' and answer ->> 'ended_kind_before' = 'receiving_unable'
      and answer -> 'required_actions' = '[]'::jsonb and answer ->> 'state_before' = 'cancelled')
     from d18_out where label in ('c26-' || pg_temp.ref('ub'), 'c26-' || pg_temp.ref('uw7'), 'c26-' || pg_temp.ref('uopa')))
  and (select max((answer ->> 'position')::integer) from d18_out
        where label in ('c26-' || pg_temp.ref('ub'), 'c26-' || pg_temp.ref('uw7'), 'c26-' || pg_temp.ref('uopa')))
      < coalesce((select min((answer ->> 'position')::integer) from d18_out
                   where label like 'c26-%' and jsonb_array_length(answer -> 'flags') = 0), 1000),
  (select string_agg(label || ' ' || (answer ->> 'position') || ' ' || (answer -> 'flags')::text, ', ')
     from d18_out where label like 'c26-%'));
select set_config('hid.test.report_ub', (select report.id::text from ehr.order_route_wrong_patient_reports report
  where report.route_id = pg_temp.r('ub')), true);
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select pg_temp.check('d18 late: support reviews ub''s report with no further action', format($s$select * from
  identity.admin_review_wrong_patient_report(%L, 1, array['no_further_action'], 'Lab confirmed the mix-up was handled',
  false)$s$, current_setting('hid.test.report_ub')), 'ok');
reset role;
select pg_temp.assert('d18 late: the review CHECK agrees: ub''s report reviewed with no further action',
  (select report.review_actions = array['no_further_action'] and report.reviewed_at is not null
     from ehr.order_route_wrong_patient_reports report where report.route_id = pg_temp.r('ub')));
-- B released (D17-3): an order ended this way whose receiving organization
-- is no longer active is receiver_released (section 11 releases PH1 for
-- real).
select pg_temp.assert('d18 late: xrx is correctable, and receiver_released once its organization is not active',
  ehr.order_route_correction_state(pg_temp.route(pg_temp.r('xrx'))) = 'correctable'
  and pg_temp.state_released('xrx', null, false) = 'receiver_released');

-- 6. Idempotency.
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.keep_cannot('replay-uopa', 'lab_request', pg_temp.r('uopa'), 2, 'test_not_offered',
  'd18-end-uopa-0000001');
select pg_temp.check('d18 key: uopa''s key on another route', format($s$select * from pg_temp.cannot('lab_request', %L,
  %s, 'test_not_offered', 'd18-end-uopa-0000001')$s$, pg_temp.r('ulim4'), pg_temp.v(pg_temp.r('ulim4'))),
  'P0001 IDEMPOTENCY_KEY_REUSED');
select pg_temp.check('d18 key: uopa''s key with another reason (another digest)', format($s$select * from pg_temp.cannot(
  'lab_request', %L, 2, 'other', 'd18-end-uopa-0000001', false, %L)$s$, pg_temp.r('uopa'), repeat('b', 64)),
  'P0001 IDEMPOTENCY_KEY_REUSED');
select pg_temp.check('d18 key: another key on uopa', format($s$select * from pg_temp.cannot('lab_request', %L, %s,
  'test_not_offered', 'd18-end-uopa-0000002')$s$, pg_temp.r('uopa'), pg_temp.v(pg_temp.r('uopa'))),
  'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.keep_cannot('replay-ub', 'lab_request', pg_temp.r('ub'), 2, 'supplies_unavailable',
  'd18-end-ub-00000001');
select pg_temp.check('d18 key: LB1''s key for uopa used by LB2 (another account) on uopa', format($s$select * from
  pg_temp.cannot('lab_request', %L, %s, 'test_not_offered', 'd18-end-uopa-0000001')$s$, pg_temp.r('uopa'),
  pg_temp.v(pg_temp.r('uopa'))), 'P0001 ORDER_ROUTE_ALREADY_ENDED');
reset role;
select pg_temp.assert('d18 key: a replay answers the first ending''s facts with the route as it is now (also after a '
    || 'late correction)',
  (select answer ->> 'result' = 'replayed' and answer ->> 'ending_id' = pg_temp.ended('uopa') ->> 'ending_id'
      and answer ->> 'reason_code' = 'test_not_offered' and answer ->> 'ended_kind' = 'receiving_unable'
      and (answer ->> 'route_row_version')::bigint = (pg_temp.route(pg_temp.r('uopa'))).row_version
      and (answer ->> 'access_ends_at')::timestamptz = (pg_temp.route(pg_temp.r('uopa'))).access_ends_at
      and answer ->> 'specimens_collected' = '0' and answer ->> 'patient_id' = pg_temp.ended('uopa') ->> 'patient_id'
     from d18_answers where label = 'replay-uopa')
  and (select answer ->> 'result' = 'replayed' and answer ->> 'ending_id' = pg_temp.ended('ub') ->> 'ending_id'
      and answer ->> 'specimens_collected' = '2' and answer ->> 'results_recorded' = '1'
      and (answer ->> 'route_row_version')::bigint = (pg_temp.route(pg_temp.r('ub'))).row_version
     from d18_answers where label = 'replay-ub')
  and (select count(*) from ehr.order_route_unable_endings ending_row
        where ending_row.route_id in (pg_temp.r('uopa'), pg_temp.r('ub'))) = 2,
  (select string_agg(label || ' ' || answer::text, ' ; ') from d18_answers where label like 'replay-%'));

-- 7. The limits, exact (D18-7), with LR (35) at L1, who holds only the lab
-- receive permission: at most 20 endings by one member and 50 at one
-- facility in any 24 hours.
select set_config('hid.test.lr_membership', 'e4c13000-0000-4000-8000-000000000035', true);
-- 19 endings by LR in the last 24 hours and one a minute older (synthetic,
-- owner SQL): LR's 20th is allowed, and the older one is not counted.
select set_config('hid.test.lr_first', pg_temp.synthetic_endings(current_setting('hid.test.lr_membership')::uuid,
  current_setting('hid.test.facility_1')::uuid, (select array_agg(clock_timestamp() - interval '23 hours'
    + make_interval(mins => step) order by step) from generate_series(0, 18) step))::text, true);
select pg_temp.synthetic_endings(current_setting('hid.test.lr_membership')::uuid,
  current_setting('hid.test.facility_1')::uuid, array[clock_timestamp() - interval '24 hours 1 minute']);
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d18 limits: LR''s 20th ending in 24 hours', format($s$select pg_temp.keep_cannot('ulim1',
  'lab_request', %L, %s, 'supplies_unavailable', 'd18-limit-ulim1-0001')$s$, pg_temp.r('ulim1'),
  pg_temp.v(pg_temp.r('ulim1'))), 'ok');
reset role;
select set_config('hid.test.footprint_before_limit', pg_temp.footprint18(), true);
set local role hid_lab_api_runtime;
select pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d18 limits: LR''s 21st ending in 24 hours, with the time another is possible', format($s$select
  pg_temp.keep_cannot('ulim2', 'lab_request', %L, %s, 'supplies_unavailable', 'd18-limit-ulim2-0001')$s$,
  pg_temp.r('ulim2'), pg_temp.v(pg_temp.r('ulim2'))), 'P0001 ORDER_ROUTE_CANNOT_COMPLETE_LIMIT');
reset role;
select pg_temp.assert('d18 limits: the member refusal''s DETAIL is when the oldest counted ending turns 24 hours old, '
    || 'and it wrote nothing',
  pg_temp.outcome_detail(format($s$select pg_temp.cannot('lab_request', %L, %s, 'supplies_unavailable',
    'd18-limit-ulim2-0002')$s$, pg_temp.r('ulim2'), pg_temp.v(pg_temp.r('ulim2'))))
    = 'P0001 ORDER_ROUTE_CANNOT_COMPLETE_LIMIT / '
      || pg_temp.limit_detail(current_setting('hid.test.lr_first')::timestamptz + interval '24 hours')
  and pg_temp.footprint18() = current_setting('hid.test.footprint_before_limit'),
  pg_temp.outcome_detail(format($s$select pg_temp.cannot('lab_request', %L, %s, 'supplies_unavailable',
    'd18-limit-ulim2-0003')$s$, pg_temp.r('ulim2'), pg_temp.v(pg_temp.r('ulim2')))) || ' / '
    || pg_temp.limit_detail(current_setting('hid.test.lr_first')::timestamptz + interval '24 hours'));
-- The facility: LR's synthetic endings removed; others by another member
-- between 23 and 24 hours ago, with L1's real ones, make 49: LR's next (the
-- 50th) is allowed, the 51st refused.
select pg_temp.forget_endings();
select set_config('hid.test.facility_first', pg_temp.synthetic_endings(gen_random_uuid(),
  current_setting('hid.test.facility_1')::uuid, (select array_agg(clock_timestamp() - interval '23 hours 59 minutes'
    + make_interval(mins => step) order by step)
    from generate_series(1, 49 - (select count(*)::integer from ehr.order_route_unable_endings ending_row
      where ending_row.receiving_facility_id = current_setting('hid.test.facility_1')::uuid
        and ending_row.recorded_at > clock_timestamp() - interval '24 hours')) step))::text, true);
select pg_temp.assert('d18 limits: 49 endings at L1 in 24 hours',
  (select count(*) from ehr.order_route_unable_endings ending_row
    where ending_row.receiving_facility_id = current_setting('hid.test.facility_1')::uuid
      and ending_row.recorded_at > clock_timestamp() - interval '24 hours') = 49);
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d18 limits: the 50th ending at L1 in 24 hours', format($s$select pg_temp.keep_cannot('ulim2',
  'lab_request', %L, %s, 'supplies_unavailable', 'd18-limit-ulim2-0004')$s$, pg_temp.r('ulim2'),
  pg_temp.v(pg_temp.r('ulim2'))), 'ok');
reset role;
select set_config('hid.test.footprint_before_limit', pg_temp.footprint18(), true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select set_config('hid.test.facility_refusal', pg_temp.outcome_detail(format($s$select pg_temp.cannot('lab_request',
  %L, %s, 'supplies_unavailable', 'd18-limit-ulim3-0001')$s$, pg_temp.r('ulim3'), pg_temp.v(pg_temp.r('ulim3')))), true);
reset role;
select pg_temp.assert('d18 limits: the 51st at L1 is refused (LB1, under its own member limit), DETAIL when the '
    || 'oldest counted turns 24 hours old, nothing written',
  current_setting('hid.test.facility_refusal') = 'P0001 ORDER_ROUTE_CANNOT_COMPLETE_LIMIT / '
    || pg_temp.limit_detail(current_setting('hid.test.facility_first')::timestamptz + interval '24 hours')
  and pg_temp.footprint18() = current_setting('hid.test.footprint_before_limit'),
  current_setting('hid.test.facility_refusal'));
-- Both limits at once: 18 more by LR two hours ago make LR's 20; the later
-- of the two times is given.
select set_config('hid.test.lr_second', pg_temp.synthetic_endings(current_setting('hid.test.lr_membership')::uuid,
  current_setting('hid.test.facility_1')::uuid, (select array_agg(clock_timestamp() - interval '2 hours'
    + make_interval(mins => step) order by step) from generate_series(0, 17) step))::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
select set_config('hid.test.both_refusal', pg_temp.outcome_detail(format($s$select pg_temp.cannot('lab_request',
  %L, %s, 'supplies_unavailable', 'd18-limit-ulim3-0002')$s$, pg_temp.r('ulim3'), pg_temp.v(pg_temp.r('ulim3')))), true);
reset role;
select pg_temp.assert('d18 limits: both limits at once give the later time',
  current_setting('hid.test.both_refusal') = 'P0001 ORDER_ROUTE_CANNOT_COMPLETE_LIMIT / '
    || pg_temp.limit_detail(current_setting('hid.test.lr_second')::timestamptz + interval '24 hours'),
  current_setting('hid.test.both_refusal'));
select pg_temp.forget_endings();
-- One staff member at every facility (D18-7: a stolen account ends at most 20
-- orders a day, wherever it holds the receive permission): LR's account also
-- holds a lab receiver membership at GL, another organization's laboratory
-- (as an accepted invitation of an existing staff member gives it; owner
-- SQL), and LR accepts two of R's lab requests there, uacc1 and uacc2. LR's
-- two real endings above (ulim1, ulim2) count for the account.
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
values ('e4c13000-0000-4000-8000-0000000003a5', 'e4c12000-0000-4000-8000-000000000035',
  'e4c10000-0000-4000-8000-000000000035', 'e4c20000-0000-4000-8000-000000000002',
  'e4c21000-0000-4000-8000-000000000002', 'lab', 'lab', false, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values (gen_random_uuid(), 'e4c10000-0000-4000-8000-000000000035', 'p4c_lab_receiver_only', 'facility',
  'e4c13000-0000-4000-8000-0000000003a5', 'e4c21000-0000-4000-8000-000000000002', 'D18 suite: LR also at GL');
select set_config('hid.test.lr_gl_membership', 'e4c13000-0000-4000-8000-0000000003a5', true),
  set_config('hid.test.lr_account', 'e4c10000-0000-4000-8000-000000000035', true);
create function pg_temp.as_lr_at_gl() returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:lr', true),
    set_config('app.membership_id', 'e4c13000-0000-4000-8000-0000000003a5', true),
    set_config('hid.test.actor_account', 'e4c10000-0000-4000-8000-000000000035', true),
    set_config('app.facility_id', 'e4c21000-0000-4000-8000-000000000002', true),
    set_config('app.correlation_id', 'd18-suite-lr-gl-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', 'direct-care', true),
    set_config('app.patient_id', '', true);
$f$;
grant execute on function pg_temp.as_lr_at_gl() to hid_lab_api_runtime;
-- A statement's SQLSTATE, message and DETAIL ('ok' when it succeeded), its
-- effects always rolled back.
create function pg_temp.tried_detail(statement text) returns text language plpgsql as $f$
declare detail_text text;
begin
  execute statement;
  raise exception using errcode = 'P0001', message = 'D18_TRIED_OK';
exception when others then
  if sqlerrm = 'D18_TRIED_OK' then
    return 'ok';
  end if;
  get stacked diagnostics detail_text = pg_exception_detail;
  return sqlstate || ' ' || sqlerrm || ' / ' || coalesce(detail_text, '');
end
$f$;
grant execute on function pg_temp.tried_detail(text) to hid_lab_api_runtime;
set local role hid_ehr_api_runtime;
select pg_temp.order_to(name, 'lab_request', 4, 'e4c21000-0000-4000-8000-000000000002')
  from unnest(array['uacc1', 'uacc2']) name;
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_lr_at_gl();
select pg_temp.assert('d18 limits: LR accepts uacc1 and uacc2 at GL',
  (select bool_and((select accepted.result from lab.accept_order_route(pg_temp.r(name), 1, 'health_id', 'HID-P4CPATR',
       'd18-accept-gl-' || name || '-0001', repeat('a', 64), null) accepted) = 'accepted')
     from unnest(array['uacc1', 'uacc2']) name));
reset role;
select pg_temp.snap();
-- 17 synthetic endings by LR's L1 membership: 19 by the account. At GL the
-- account's 20th is allowed (tried and rolled back), its 21st is not.
select set_config('hid.test.lr_account_first', pg_temp.synthetic_endings(current_setting('hid.test.lr_membership')::uuid,
  current_setting('hid.test.facility_1')::uuid, (select array_agg(clock_timestamp() - interval '23 hours'
    + make_interval(mins => step) order by step) from generate_series(0, 16) step))::text, true);
select pg_temp.assert('d18 limits: LR''s account has 19 endings in 24 hours, all at L1',
  (select count(*) from ehr.order_route_unable_endings ending_row
    where ending_row.ended_by_account_id = current_setting('hid.test.lr_account')::uuid
      and ending_row.receiving_facility_id = current_setting('hid.test.facility_1')::uuid
      and ending_row.recorded_at > clock_timestamp() - interval '24 hours') = 19
  and not exists (select 1 from ehr.order_route_unable_endings ending_row
    where ending_row.ended_by_account_id = current_setting('hid.test.lr_account')::uuid
      and ending_row.receiving_facility_id <> current_setting('hid.test.facility_1')::uuid));
set local role hid_lab_api_runtime;
select pg_temp.as_lr_at_gl();
select set_config('hid.test.account_twentieth', pg_temp.tried(format($s$select * from pg_temp.cannot('lab_request', %L,
  %s, 'supplies_unavailable', 'd18-limit-uacc1-0001')$s$, pg_temp.r('uacc1'), pg_temp.v(pg_temp.r('uacc1')))), true);
reset role;
select pg_temp.assert('d18 limits: the account''s 20th ending in 24 hours, its first at GL, is allowed',
  current_setting('hid.test.account_twentieth') = 'ok', current_setting('hid.test.account_twentieth'));
select pg_temp.synthetic_endings(current_setting('hid.test.lr_membership')::uuid,
  current_setting('hid.test.facility_1')::uuid, array[clock_timestamp() - interval '1 hour']);
select set_config('hid.test.footprint_before_limit', pg_temp.footprint18(), true);
set local role hid_lab_api_runtime;
select pg_temp.as_lr_at_gl();
select set_config('hid.test.account_refusal', pg_temp.tried_detail(format($s$select pg_temp.cannot('lab_request',
  %L, %s, 'supplies_unavailable', 'd18-limit-uacc1-0002')$s$, pg_temp.r('uacc1'), pg_temp.v(pg_temp.r('uacc1')))), true);
reset role;
select pg_temp.assert('d18 limits: at GL, the account''s 21st ending in 24 hours (20 at L1) is refused, DETAIL when the '
    || 'account''s oldest counted ending turns 24 hours old, nothing written',
  current_setting('hid.test.account_refusal') = 'P0001 ORDER_ROUTE_CANNOT_COMPLETE_LIMIT / '
    || pg_temp.limit_detail(current_setting('hid.test.lr_account_first')::timestamptz + interval '24 hours')
  and pg_temp.footprint18() = current_setting('hid.test.footprint_before_limit'),
  current_setting('hid.test.account_refusal'));
-- The other way: 18 synthetic endings by LR's GL membership at GL (20 by the
-- account with ulim1 and ulim2): LR at L1, with few endings under its L1
-- membership and L1 far from 50, is refused.
select pg_temp.forget_endings();
select set_config('hid.test.lr_gl_first', pg_temp.synthetic_endings(current_setting('hid.test.lr_gl_membership')::uuid,
  'e4c21000-0000-4000-8000-000000000002', (select array_agg(clock_timestamp() - interval '22 hours'
    + make_interval(mins => step) order by step) from generate_series(0, 17) step))::text, true);
select set_config('hid.test.footprint_before_limit', pg_temp.footprint18(), true);
set local role hid_lab_api_runtime;
select pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
select set_config('hid.test.account_refusal', pg_temp.tried_detail(format($s$select pg_temp.cannot('lab_request',
  %L, %s, 'supplies_unavailable', 'd18-limit-ulim3-0003')$s$, pg_temp.r('ulim3'), pg_temp.v(pg_temp.r('ulim3')))), true);
reset role;
select pg_temp.assert('d18 limits: at L1, LR is refused once its account has 20 endings in 24 hours, 18 of them at GL '
    || '(2 under its L1 membership; L1 under 50), nothing written',
  current_setting('hid.test.account_refusal') = 'P0001 ORDER_ROUTE_CANNOT_COMPLETE_LIMIT / '
    || pg_temp.limit_detail(current_setting('hid.test.lr_gl_first')::timestamptz + interval '24 hours')
  and (select count(*) from ehr.order_route_unable_endings ending_row
        where ending_row.ended_by_membership_id = current_setting('hid.test.lr_membership')::uuid
          and ending_row.recorded_at > clock_timestamp() - interval '24 hours') = 2
  and (select count(*) from ehr.order_route_unable_endings ending_row
        where ending_row.receiving_facility_id = current_setting('hid.test.facility_1')::uuid
          and ending_row.recorded_at > clock_timestamp() - interval '24 hours') < 50
  and pg_temp.footprint18() = current_setting('hid.test.footprint_before_limit'),
  current_setting('hid.test.account_refusal'));
select pg_temp.forget_endings();

-- 8. The readers and their cost. The summary reads T10's rows only for a
-- route ended receiving_unable with no report (its key sits in the outer
-- select list, behind the route's own kind and the report object): none for
-- every other route, none once reported (row reads in this transaction,
-- pg_stat_xact_user_tables).
create temp table d18_reads (label text primary key, routes bigint not null, reads bigint not null) on commit drop;
select set_config('hid.test.t10_before', pg_temp.t10_reads()::text, true);
select count(ehr.order_route_summary(route, false)) from ehr.order_routes route
 where route.ended_kind is distinct from 'receiving_unable';
insert into d18_reads values ('other', (select count(*) from ehr.order_routes route
  where route.ended_kind is distinct from 'receiving_unable'),
  pg_temp.t10_reads() - current_setting('hid.test.t10_before')::bigint);
select set_config('hid.test.t10_before', pg_temp.t10_reads()::text, true);
select count(ehr.order_route_summary(route, false)) from ehr.order_routes route
 where route.ended_kind = 'receiving_unable'
   and not exists (select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = route.id);
insert into d18_reads values ('ended', (select count(*) from ehr.order_routes route
  where route.ended_kind = 'receiving_unable'
    and not exists (select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = route.id)),
  pg_temp.t10_reads() - current_setting('hid.test.t10_before')::bigint);
select set_config('hid.test.t10_before', pg_temp.t10_reads()::text, true);
select count(ehr.order_route_summary(route, false)) from ehr.order_routes route
 where route.ended_kind = 'receiving_unable'
   and exists (select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = route.id);
insert into d18_reads values ('reported', (select count(*) from ehr.order_routes route
  where route.ended_kind = 'receiving_unable'
    and exists (select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = route.id)),
  pg_temp.t10_reads() - current_setting('hid.test.t10_before')::bigint);
select pg_temp.assert('d18 cost: T10 row reads by the summary: none for the other routes, one each for the routes '
    || 'ended this way without a report, none once reported',
  (select string_agg(label || ':' || reads || '/' || (routes > 0)::text, ', ' order by label) from d18_reads)
  = 'ended:' || (select routes from d18_reads where label = 'ended') || '/true, other:0/true, reported:0/true',
  (select string_agg(label || ':' || reads || ' over ' || routes, ', ' order by label) from d18_reads));
select pg_temp.assert('d18 cost: C3 and C4 ran as the EHR runtime for orders not ended this way (they read T10 as '
    || 'their owner) and answered notCompleted null',
  (select count(*) from d18_out where label in ('c4-usnt', 'c4-usup', 'c4-xrxc', 'c3-usup')) = 4
  and has_table_privilege((select proc.proowner from pg_proc proc
        where proc.oid = 'ehr.order_route_summaries(text,uuid,uuid[])'::regprocedure),
      'ehr.order_route_unable_endings', 'SELECT')
  and has_table_privilege((select proc.proowner from pg_proc proc
        where proc.oid = 'ehr.list_order_routes_for_order(text,uuid,uuid)'::regprocedure),
      'ehr.order_route_unable_endings', 'SELECT'));
-- C32, support's counts: as support (FR) through the Identity runtime,
-- against the same counts taken from T10 and T8 here; one PH1 ending 31 days
-- old (synthetic) is outside the 30 days; at GL four synthetic endings 59,
-- 60, 10,079 and 10,080 minutes after their acceptance, nothing recorded
-- (one within the hour, one after seven days).
select pg_temp.synthetic_endings(gen_random_uuid(), current_setting('hid.test.facility_2')::uuid,
  array[clock_timestamp() - interval '31 days']);
create function pg_temp.synthetic_minutes(facility uuid, minutes integer[]) returns void language plpgsql as $f$
declare
  after integer;
  copy_id uuid;
  template ehr.order_routes%rowtype;
begin
  select * into template from ehr.order_routes where id = pg_temp.r('usnt');
  foreach after in array minutes loop
    copy_id := pg_temp.copy_route(template.id, jsonb_build_object('id', gen_random_uuid(),
      'idempotency_key', 'd18-synthetic-' || gen_random_uuid(), 'source_lab_request_id', gen_random_uuid(),
      'patient_id', gen_random_uuid()));
    set local session_replication_role = replica;
    insert into ehr.order_route_unable_endings (route_id, kind, receiving_facility_id, receiving_organization_id,
      ordering_facility_id, reason_code, ended_by_account_id, ended_by_membership_id, accepted_by_membership_id,
      accepted_at, ended_by_acceptor, minutes_after_acceptance, accession_made, specimens_collected, results_recorded,
      idempotency_key, request_sha256, correlation_id)
    values (copy_id, 'lab_request', facility, template.receiving_organization_id, template.ordering_facility_id,
      'other', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), clock_timestamp() - make_interval(mins => after),
      false, after, false, 0, 0, 'd18-synthetic-' || substr(md5(copy_id::text), 1, 16), repeat('f', 64),
      'd18-synthetic-correlation');
    set local session_replication_role = origin;
  end loop;
end
$f$;
select pg_temp.synthetic_minutes('e4c21000-0000-4000-8000-000000000002', array[59, 60, 10079, 10080]);
create function pg_temp.counted(facility uuid) returns jsonb language sql stable as $f$
  select jsonb_build_object(
    'last30Days', (select count(*) from ehr.order_route_unable_endings e
                    where e.receiving_facility_id = facility and e.recorded_at > clock_timestamp() - interval '720 hours'),
    'soonAfterAcceptance', (select count(*) from ehr.order_route_unable_endings e
                    where e.receiving_facility_id = facility and e.recorded_at > clock_timestamp() - interval '720 hours'
                      and e.minutes_after_acceptance <= 59 and e.accession_made is false),
    'afterSevenDays', (select count(*) from ehr.order_route_unable_endings e
                    where e.receiving_facility_id = facility and e.recorded_at > clock_timestamp() - interval '720 hours'
                      and e.minutes_after_acceptance >= 7 * 24 * 60),
    'laterReportedWrongPatient', (select count(*) from ehr.order_route_unable_endings e
                    join ehr.order_route_wrong_patient_reports r on r.route_id = e.route_id
                    where e.receiving_facility_id = facility and e.recorded_at > clock_timestamp() - interval '720 hours'),
    'byReason', coalesce((select jsonb_object_agg(reason.code, reason.n)
                    from (select e.reason_code as code, count(*) as n from ehr.order_route_unable_endings e
                           where e.receiving_facility_id = facility
                             and e.recorded_at > clock_timestamp() - interval '720 hours'
                           group by e.reason_code) reason), '{}'::jsonb))
$f$;
select set_config('hid.test.counted_l1', pg_temp.counted(current_setting('hid.test.facility_1')::uuid)::text, true),
  set_config('hid.test.counted_ph1', pg_temp.counted(current_setting('hid.test.facility_2')::uuid)::text, true);
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
insert into d18_out (label, answer)
values ('c32-l1', identity.admin_order_route_not_completed(current_setting('hid.test.facility_1')::uuid)),
       ('c32-ph1', identity.admin_order_route_not_completed(current_setting('hid.test.facility_2')::uuid)),
       ('c32-gh', identity.admin_order_route_not_completed('e4c21000-0000-4000-8000-000000000001')),
       ('c32-gl', identity.admin_order_route_not_completed('e4c21000-0000-4000-8000-000000000002'));
select pg_temp.check('d18 C32: an unknown facility', $s$select identity.admin_order_route_not_completed(
  gen_random_uuid())$s$, 'P0002 ADMIN_FACILITY_NOT_FOUND');
select pg_temp.check('d18 C32: no facility', $s$select identity.admin_order_route_not_completed(null)$s$,
  'P0002 ADMIN_FACILITY_NOT_FOUND');
select pg_temp.as_signup_admin(1);
select pg_temp.check('d18 C32: a staff session, not support', format($s$select identity.admin_order_route_not_completed(
  %L)$s$, current_setting('hid.test.facility_1')), '42501 ADMIN_PERMISSION_DENIED');
reset role;
select pg_temp.assert('d18 C32: L1''s and PH1''s counts equal those taken from T10 and T8; a facility with none; '
    || 'GL''s boundaries (59 minutes counted soon, 60 not; 10,080 after seven days, 10,079 not)',
  (select answer from d18_out where label = 'c32-l1') = current_setting('hid.test.counted_l1')::jsonb
  and (select answer from d18_out where label = 'c32-ph1') = current_setting('hid.test.counted_ph1')::jsonb
  and (select answer from d18_out where label = 'c32-gh') = '{"byReason": {}, "last30Days": 0, "afterSevenDays": 0, '
    '"soonAfterAcceptance": 0, "laterReportedWrongPatient": 0}'::jsonb
  and (select answer from d18_out where label = 'c32-gl') = '{"byReason": {"other": 4}, "last30Days": 4, '
    '"afterSevenDays": 1, "soonAfterAcceptance": 1, "laterReportedWrongPatient": 0}'::jsonb,
  (select string_agg(label || ' ' || answer::text, ' ; ' order by label) from d18_out where label like 'c32-%')
    || ' / ' || current_setting('hid.test.counted_l1') || ' / ' || current_setting('hid.test.counted_ph1'));
select pg_temp.assert('d18 C32: PH1''s counts exactly (two endings within an hour, nothing recorded, one later '
    || 'reported; the 31-day-old one left out); at L1, the three later reported and uaged after seven days',
  (select answer from d18_out where label = 'c32-ph1') = '{"byReason": {"out_of_stock": 1, '
    '"needs_prescriber_review": 1}, "last30Days": 2, "afterSevenDays": 0, "soonAfterAcceptance": 2, '
    '"laterReportedWrongPatient": 1}'::jsonb
  and (select (answer ->> 'laterReportedWrongPatient')::integer = 3 and (answer ->> 'afterSevenDays')::integer = 1
         and (answer -> 'byReason' ->> 'cannot_meet_priority')::integer = 2
         and (answer ->> 'last30Days')::integer = (select count(*) from ehr.order_route_unable_endings e
               where e.receiving_facility_id = current_setting('hid.test.facility_1')::uuid)
       from d18_out where label = 'c32-l1'),
  (select string_agg(label || ' ' || answer::text, ' ; ' order by label) from d18_out where label like 'c32-%'));
select pg_temp.forget_endings();

-- 9. The CHECKs (owner SQL, triggers off so that only the CHECKs decide;
-- each statement rolled back).
set local session_replication_role = replica;
select pg_temp.assert('d18 CHECK: the new kind on withdrawn, expired and completed routes, and without ended_at, '
    || 'is refused by the end CHECK; on a cancelled route it is admitted; an unknown kind is refused (the end CHECK '
    || 'is checked first)',
  pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'receiving_unable' where id = %L$s$,
      pg_temp.r('uwdn')))
    = '23514 new row for relation "order_routes" violates check constraint "order_routes_end_ck"'
  and pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'receiving_unable' where id = %L$s$,
      pg_temp.r('uexs')))
    = '23514 new row for relation "order_routes" violates check constraint "order_routes_end_ck"'
  and pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'receiving_unable', ended_at = clock_timestamp()
      where id = %L$s$, pg_temp.r('uopc')))
    = '23514 new row for relation "order_routes" violates check constraint "order_routes_end_ck"'
  and pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'receiving_unable', ended_at = null
      where id = %L$s$, pg_temp.r('usup')))
    = '23514 new row for relation "order_routes" violates check constraint "order_routes_end_ck"'
  and pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'receiving_unable' where id = %L$s$,
      pg_temp.r('usup'))) = 'ok'
  and pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'not_a_kind' where id = %L$s$,
      pg_temp.r('usup')))
    = '23514 new row for relation "order_routes" violates check constraint "order_routes_end_ck"',
  concat_ws(' | ', pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'receiving_unable' where id = %L$s$,
      pg_temp.r('uwdn'))), pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'receiving_unable' where id = %L$s$,
      pg_temp.r('uexs'))), pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'receiving_unable',
      ended_at = clock_timestamp() where id = %L$s$, pg_temp.r('uopc'))), pg_temp.tried(format($s$update ehr.order_routes
      set ended_kind = 'receiving_unable', ended_at = null where id = %L$s$, pg_temp.r('usup'))),
    pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'receiving_unable' where id = %L$s$,
      pg_temp.r('usup'))), pg_temp.tried(format($s$update ehr.order_routes set ended_kind = 'not_a_kind' where id = %L$s$,
      pg_temp.r('usup')))));
-- T8's late CHECK admits receiving_unable only as the earlier ending of a
-- late report.
create function pg_temp.t8_row(late boolean, ended_before text) returns text language sql as $f$
  select format($s$insert into ehr.order_route_wrong_patient_reports (id, route_id, kind, receiving_facility_id,
    receiving_organization_id, ordering_facility_id, state_before, reason_code, note, reported_by_account_id,
    reported_by_membership_id, accepted_by_account_id, accepted_by_membership_id, accepted_at, accepted_with,
    recorded_by_membership_ids, reporter_recorded_work, specimens_collected, results_voided, result_reports_marked,
    dispensing_reversed, idempotency_key, request_sha256, correlation_id, late, ended_kind_before, discovered_by,
    discovered_on)
    values (gen_random_uuid(), %L, 'lab_request', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), %L,
    'other', 'A report written for the CHECK', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    gen_random_uuid(), clock_timestamp(), 'health_id', array[]::uuid[], false, 0, 0, 0, false,
    'd18-check-report-0001', repeat('a', 64), 'd18-check-correlation', %L, %L, %L, %L)$s$, pg_temp.r('uq'),
    case when late then 'cancelled' else 'accepted' end, late, ended_before, case when late then 'own_check' end,
    case when late then current_date end)
$f$;
select pg_temp.assert('d18 CHECK: T8''s late CHECK admits receiving_unable as the earlier ending of a late report, '
    || 'not on an in-window report, and no unknown kind',
  pg_temp.tried(pg_temp.t8_row(true, 'receiving_unable')) = 'ok'
  and pg_temp.tried(pg_temp.t8_row(false, 'receiving_unable'))
    = '23514 new row for relation "order_route_wrong_patient_reports" violates check constraint "order_route_wrong_patient_reports_late_ck"'
  and pg_temp.tried(pg_temp.t8_row(true, 'not_a_kind'))
    = '23514 new row for relation "order_route_wrong_patient_reports" violates check constraint "order_route_wrong_patient_reports_late_ck"'
  and pg_temp.tried(pg_temp.t8_row(true, 'support')) = 'ok',
  concat_ws(' | ', pg_temp.tried(pg_temp.t8_row(true, 'receiving_unable')), pg_temp.tried(pg_temp.t8_row(false,
    'receiving_unable'))));
-- T10's CHECKs.
create function pg_temp.t10_row(kind text, reason text, accession boolean, specimens integer, criticals integer,
  told boolean) returns text language sql as $f$
  select format($s$insert into ehr.order_route_unable_endings (route_id, kind, receiving_facility_id,
    receiving_organization_id, ordering_facility_id, reason_code, ended_by_account_id, ended_by_membership_id,
    accepted_by_membership_id, accepted_at, ended_by_acceptor, minutes_after_acceptance, accession_made,
    specimens_collected, results_recorded, critical_candidates, critical_value_told, idempotency_key, request_sha256,
    correlation_id)
    values (%L, %L, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), %L, gen_random_uuid(), gen_random_uuid(),
    gen_random_uuid(), clock_timestamp(), false, 0, %L, %s, 0, %s, %L, 'd18-check-ending-0001', repeat('a', 64),
    'd18-check-correlation')$s$, pg_temp.r('ulim4'), kind, reason, accession, specimens, criticals, told)
$f$;
select pg_temp.assert('d18 CHECK: T10''s reason by kind, prescription facts, critical statement and kind',
  pg_temp.tried(pg_temp.t10_row('lab_request', 'sample_unusable', true, 1, 1, true)) = 'ok'
  and pg_temp.tried(pg_temp.t10_row('prescription', 'out_of_stock', false, 0, 0, false)) = 'ok'
  and pg_temp.tried(pg_temp.t10_row('prescription', 'sample_unusable', false, 0, 0, false))
    = '23514 new row for relation "order_route_unable_endings" violates check constraint "order_route_unable_endings_reason_ck"'
  and pg_temp.tried(pg_temp.t10_row('lab_request', 'out_of_stock', false, 0, 0, false))
    = '23514 new row for relation "order_route_unable_endings" violates check constraint "order_route_unable_endings_reason_ck"'
  and pg_temp.tried(pg_temp.t10_row('prescription', 'out_of_stock', true, 0, 0, false))
    = '23514 new row for relation "order_route_unable_endings" violates check constraint "order_route_unable_endings_kind_ck"'
  and pg_temp.tried(pg_temp.t10_row('prescription', 'out_of_stock', false, 1, 0, false))
    = '23514 new row for relation "order_route_unable_endings" violates check constraint "order_route_unable_endings_kind_ck"'
  and pg_temp.tried(pg_temp.t10_row('prescription', 'out_of_stock', false, 0, 0, true))
    = '23514 new row for relation "order_route_unable_endings" violates check constraint "order_route_unable_endings_kind_ck"'
  and pg_temp.tried(pg_temp.t10_row('lab_request', 'other', true, 1, 1, false))
    = '23514 new row for relation "order_route_unable_endings" violates check constraint "order_route_unable_endings_critical_ck"'
  and pg_temp.tried(pg_temp.t10_row('referral', 'other', false, 0, 0, false))
    = '23514 new row for relation "order_route_unable_endings" violates check constraint "order_route_unable_endings_kind_check"',
  concat_ws(' | ', pg_temp.tried(pg_temp.t10_row('lab_request', 'sample_unusable', true, 1, 1, true)),
    pg_temp.tried(pg_temp.t10_row('prescription', 'sample_unusable', false, 0, 0, false))));
set local session_replication_role = origin;
-- T10 is append-only: its guard refuses an UPDATE and a DELETE by anyone,
-- the superuser and a NOSUPERUSER, NOBYPASSRLS owner too (with four
-- policies its rows reach the guard; with two they would match none).
select pg_temp.check('d18 T10: the superuser updates a row', $s$update ehr.order_route_unable_endings set reason_code =
  'other' where route_id = pg_temp.r('uopa')$s$, '23514 ORDER_ROUTE_UNABLE_ENDING_IMMUTABLE');
select pg_temp.check('d18 T10: the superuser deletes a row', $s$delete from ehr.order_route_unable_endings
  where route_id = pg_temp.r('uopa')$s$, '23514 ORDER_ROUTE_UNABLE_ENDING_IMMUTABLE');
create role d18_suite_t10_owner nosuperuser nobypassrls;
grant usage on schema ehr to d18_suite_t10_owner;
grant select, insert on p4c_checks to d18_suite_t10_owner;
grant usage on sequence p4c_checks_n_seq to d18_suite_t10_owner;
grant execute on function pg_temp.check(text,text,text), pg_temp.outcome(text), pg_temp.r(text)
  to d18_suite_t10_owner;
select set_config('hid.test.t10_owner', (select relation.relowner::regrole::text from pg_class relation
  where relation.oid = 'ehr.order_route_unable_endings'::regclass), true);
alter table ehr.order_route_unable_endings owner to d18_suite_t10_owner;
set local role d18_suite_t10_owner;
select pg_temp.check('d18 T10: a NOSUPERUSER, NOBYPASSRLS owner updates a row', $s$update
  ehr.order_route_unable_endings set reason_code = 'other' where route_id = pg_temp.r('uopa')$s$,
  '23514 ORDER_ROUTE_UNABLE_ENDING_IMMUTABLE');
select pg_temp.check('d18 T10: a NOSUPERUSER, NOBYPASSRLS owner deletes a row', $s$delete from
  ehr.order_route_unable_endings where route_id = pg_temp.r('uopa')$s$, '23514 ORDER_ROUTE_UNABLE_ENDING_IMMUTABLE');
reset role;
do $$
begin
  execute format('alter table ehr.order_route_unable_endings owner to %I', current_setting('hid.test.t10_owner'));
end $$;
-- The owner as it was (on the owner copy, hid_synthetic_schema_owner,
-- itself NOSUPERUSER) too, where it is no superuser.
do $$
begin
  if not (select role_row.rolsuper from pg_roles role_row where role_row.rolname = current_setting('hid.test.t10_owner')) then
    execute format('grant select, insert on p4c_checks to %I', current_setting('hid.test.t10_owner'));
    execute format('grant usage on sequence p4c_checks_n_seq to %I', current_setting('hid.test.t10_owner'));
    execute format('grant execute on function pg_temp.check(text,text,text), pg_temp.outcome(text), pg_temp.r(text) '
      'to %I', current_setting('hid.test.t10_owner'));
    execute format('set local role %I', current_setting('hid.test.t10_owner'));
    perform pg_temp.check('d18 T10: its owner (NOSUPERUSER) updates a row', $s$update ehr.order_route_unable_endings
      set reason_code = 'other' where route_id = pg_temp.r('uopa')$s$, '23514 ORDER_ROUTE_UNABLE_ENDING_IMMUTABLE');
    perform pg_temp.check('d18 T10: its owner (NOSUPERUSER) deletes a row', $s$delete from ehr.order_route_unable_endings
      where route_id = pg_temp.r('uopa')$s$, '23514 ORDER_ROUTE_UNABLE_ENDING_IMMUTABLE');
    reset role;
  end if;
end $$;
select pg_temp.assert('d18 T10: the rows are as they were, and the owner is back',
  (select count(*) from ehr.order_route_unable_endings) > 0
  and (pg_temp.ending('uopa') ->> 'reason_code') = 'test_not_offered'
  and (select relation.relowner::regrole::text from pg_class relation
        where relation.oid = 'ehr.order_route_unable_endings'::regclass) = current_setting('hid.test.t10_owner'));
set local role hid_lab_api_runtime;
select pg_temp.check('d18 T10: the Lab runtime reads it', $s$select count(*) from ehr.order_route_unable_endings$s$,
  '42501 permission denied for table order_route_unable_endings');
select pg_temp.check('d18 T10: the Lab runtime writes it', format($s$insert into ehr.order_route_unable_endings
  (route_id) values (%L)$s$, pg_temp.r('ulim4')), '42501 permission denied for table order_route_unable_endings');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.check('d18 T10: the EHR runtime reads it', $s$select count(*) from ehr.order_route_unable_endings$s$,
  '42501 permission denied for table order_route_unable_endings');
reset role;

-- 10. The reason lists. Every code of a kind passes the command's input
-- check (a stale version then answers 412, the version test coming after
-- the input's), every other code is refused 22023; T10's CHECK admits the
-- same; both equal the shared fixture the Lab and Pharmacy DTO tests read.
create temp table d18_reasons (kind text, code text, command text, ending text, primary key (kind, code))
  on commit drop;
grant select, insert, update on d18_reasons to hid_lab_api_runtime, hid_pharmacy_api_runtime;
insert into d18_reasons (kind, code)
select kinds.kind, codes.code
  from (values ('lab_request'), ('prescription')) kinds(kind)
  cross join (select jsonb_array_elements_text(:'cannot_complete_reasons'::jsonb -> 'lab_request') as code
              union select jsonb_array_elements_text(:'cannot_complete_reasons'::jsonb -> 'prescription')
              union select 'wrong_patient' union select 'identity_not_confirmed' union select 'Other') codes;
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
update d18_reasons set command = pg_temp.outcome(format($s$select * from pg_temp.cannot('lab_request', %L, %s, %L,
  %L)$s$, pg_temp.r('ulim4'), pg_temp.v(pg_temp.r('ulim4')) + 1, code, 'd18-reason-lab-' || md5(code)))
 where kind = 'lab_request';
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(2);
update d18_reasons set command = pg_temp.outcome(format($s$select * from pg_temp.cannot('prescription', %L, %s, %L,
  %L)$s$, pg_temp.r('xrxo'), pg_temp.v(pg_temp.r('xrxo')) + 1, code, 'd18-reason-rx-' || md5(code)))
 where kind = 'prescription';
reset role;
update d18_reasons set ending = pg_temp.tried(pg_temp.t10_row(kind, code, false, 0, 0, false));
select pg_temp.assert('d18 reasons: the command accepts exactly the fixture''s codes of each kind',
  (select array_agg(code order by code) from d18_reasons where kind = 'lab_request'
      and command = 'P0001 ORDER_ROUTE_VERSION_CONFLICT')
    = (select array_agg(code order by code) from jsonb_array_elements_text(:'cannot_complete_reasons'::jsonb -> 'lab_request') code)
  and (select array_agg(code order by code) from d18_reasons where kind = 'prescription'
      and command = 'P0001 ORDER_ROUTE_VERSION_CONFLICT')
    = (select array_agg(code order by code) from jsonb_array_elements_text(:'cannot_complete_reasons'::jsonb -> 'prescription') code)
  and not exists (select 1 from d18_reasons where command not in ('P0001 ORDER_ROUTE_VERSION_CONFLICT',
    '22023 ORDER_ROUTE_INVALID')),
  (select string_agg(kind || ':' || code || '=' || command, ', ' order by kind, code) from d18_reasons));
select pg_temp.assert('d18 reasons: T10''s CHECK admits exactly the fixture''s codes of each kind',
  (select array_agg(code order by code) from d18_reasons where kind = 'lab_request' and ending = 'ok')
    = (select array_agg(code order by code) from jsonb_array_elements_text(:'cannot_complete_reasons'::jsonb -> 'lab_request') code)
  and (select array_agg(code order by code) from d18_reasons where kind = 'prescription' and ending = 'ok')
    = (select array_agg(code order by code) from jsonb_array_elements_text(:'cannot_complete_reasons'::jsonb -> 'prescription') code)
  and not exists (select 1 from d18_reasons where ending <> 'ok' and ending <> '23514 new row for relation '
    || '"order_route_unable_endings" violates check constraint "order_route_unable_endings_reason_ck"'),
  (select string_agg(kind || ':' || code || '=' || ending, ', ' order by kind, code) from d18_reasons));
select pg_temp.assert('d18 reasons: the fixture holds the design''s 9 laboratory and 8 pharmacy codes (D18-5)',
  jsonb_array_length(:'cannot_complete_reasons'::jsonb -> 'lab_request') = 9
  and jsonb_array_length(:'cannot_complete_reasons'::jsonb -> 'prescription') = 8);

-- 11. A real release of B (D17-3): support suspends PH1, disables its
-- administrator PB1 and releases it. The release ends xrxo (open)
-- receiving_released; xrx, ended "can't complete" before, keeps its ending
-- and is receiver_released, with no deadline; PB2 can no longer end an
-- order (the actor) nor correct one.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select identity.admin_transition_facility(current_setting('hid.test.facility_2')::uuid,
  (select facility.row_version from identity.facilities facility where facility.id = current_setting('hid.test.facility_2')::uuid),
  'suspended', 'Suspended for the D18 suite', 'd18-release-suspend-ph1', repeat('c', 64));
select auth.admin_transition_account(current_setting('hid.test.account_2')::uuid,
  (select account.row_version from auth.accounts account where account.id = current_setting('hid.test.account_2')::uuid),
  'disabled', 'Disabled for the D18 release', 'd18-release-disable-pb1', repeat('d', 64));
select identity.admin_release_self_service_facility(current_setting('hid.test.app_2')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('all') application
    where application.application_id = current_setting('hid.test.app_2')::uuid),
  'Released for the D18 suite', false);
reset role;
select pg_temp.snap();
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.check('d18 released: PB2 ends an order at the released PH1', format($s$select * from pg_temp.cannot(
  'prescription', %L, %s, 'out_of_stock', 'd18-released-xrxo-001')$s$, pg_temp.r('xrxo'), pg_temp.v(pg_temp.r('xrxo'))),
  '42501 Order route staff context is required');
reset role;
select pg_temp.assert('d18 released: xrxo ended receiving_released; xrx keeps its ending and is receiver_released, '
    || 'with no deadline',
  (pg_temp.route(pg_temp.r('xrxo'))).ended_kind = 'receiving_released'
  and (pg_temp.route(pg_temp.r('xrx'))).ended_kind = 'receiving_unable'
  and ehr.order_route_correction_state(pg_temp.route(pg_temp.r('xrx'))) = 'receiver_released'
  and ehr.order_route_summary(pg_temp.route(pg_temp.r('xrx')), false) -> 'correctableUntil' = 'null'::jsonb
  and ehr.order_route_summary(pg_temp.route(pg_temp.r('xrx')), false) -> 'notCompleted'
    = '{"reason": "out_of_stock", "sampleTaken": null, "resultRecorded": null}'::jsonb,
  pg_temp.d18_route('xrxo') || ' / ' || pg_temp.d18_route('xrx'));

select pg_temp.report();
rollback;
