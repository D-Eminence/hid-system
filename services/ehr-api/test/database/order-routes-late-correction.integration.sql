-- The late correction of an order accepted for the wrong person (0090, D17).
-- Rollback-only; fails without 0090. The corrections run as the exact Lab
-- and Pharmacy runtimes, the readers as the EHR and Identity runtimes, on
-- the shared P4c fixture (item 3's members added) with every route of the
-- design's table (SPEC-FINAL D17 4.2):
--   1. properties, grants and pins: the language, security, volatility,
--      search path, owner and ACL of every new, replaced and recreated
--      function (H6's as 0086 made it; its body keeps 0086's route predicate
--      and reads pg_current_xact_id_if_assigned(), never txid_current());
--      EXECUTE for each group and login role and PUBLIC; the capability
--      table (T9) with forced row-level security, three policies and no
--      grant; the report table's (T8) new columns, CHECKs and index; the
--      functions every new, replaced or recreated body calls, derived from
--      their source, equal the list 0090 pins; and, from a read-only
--      transaction before the fixture, a route-access check leaves no
--      transaction id;
--   2. the capability: without one, the Lab runtime reads none of P's
--      results where every route has ended, and cannot write one by hand;
--      it cannot read or write T9; a T9 row of another transaction, another
--      member, another patient, kind or facility opens nothing; one of this
--      transaction for this member opens exactly P's rows of the kind at the
--      facility; T9's probe is an index scan on its key;
--   3. B's lookup (C30): by the exact reference (trimmed, any case), only
--      routes this facility accepted, newest acceptance first, B's own
--      facts only while open or correctable (the test or medicine, who
--      accepted and how, what went back and whether it was withdrawn), never
--      the patient; its refusals; it writes nothing;
--   4. refusals of the late command (C29), which write nothing: never
--      accepted (sent, declined, withdrawn, expired), still open (accepted,
--      completed; also with a stale version: the state first), too late,
--      already reported, another facility's or kind's route, a stale
--      version, a receptionist, another purpose, a member who may not
--      withdraw what must be withdrawn (with the permission as DETAIL), the
--      control off, every invalid input;
--   5. group 1 (window lapsed; ends 'wrong_patient' now: accepted ->
--      cancelled, completed -> access ended) and group 2 (ended before;
--      ending kept) for every ending: support, entered in error, ordering
--      and receiving released on completed routes, and order changed,
--      entered in error, support, ordering and receiving released on
--      cancelled ones; item 3's v1-and-v2 variants late; three pharmacy
--      cases (dispensed and closed, accepted and lapsed, already reversed
--      under the patient's consent); each with its voids at B and reports at
--      A, the report row, the audit rows, the notice and the answer; P's
--      record no longer shows a withdrawn result; T9 empty after each; after
--      the command, in the same transaction, the runtime still reads none
--      of P's rows;
--   6. after a late report: a release under P's consent is refused, writes
--      on the item are closed, the lookup says reported; replays, keys
--      reused (also an in-window report's key), a second report;
--   7. item 3's command (C25) unchanged: an open route found by C30 is
--      reported by C25 with the id and version C30 gave;
--   8. the readers: the order summary's two keys agree with the helpers on
--      every route (MG1); C3, C5, C21 (the effective state once per row),
--      C26 (the new columns and flags, the reporter's late count, the
--      sender still active or not, the required actions) and C28 (keyed on
--      the report); the reference lookups' comparison is indexable;
--   9. T8's guard keeps the new columns fixed; support's review (C27)
--      requires the referral (D17-6), and the CHECK refuses an owner's
--      update that bypasses C27; in-window reports are reviewed as before;
--  10. the limits, exact (D17-9): the 6th late correction by one member and
--      the 21st at one facility in 24 hours are refused with the time from
--      which another is possible, a report older than 24 hours is not
--      counted, and both limits at once give the later time;
--  11. the 180-day bound (D17-2), a minute before and after it.
-- The two-session cases (replays before and after the lock under a
-- concurrent report, exact limits under concurrency, races with releases,
-- reversals and the order-change mirror) are in the race harness.
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
-- D17 (before the fixture): in a read-only transaction a route-access check
-- that reaches the capability branch leaves the transaction without an id
-- (H6 reads pg_current_xact_id_if_assigned(), never txid_current(), which
-- would assign one). Recorded in section 1 below.
begin read only;
select set_config('app.purpose_of_use', 'direct-care', true);
select ehr.order_route_access_allows('lab_request', gen_random_uuid(), gen_random_uuid(), 'read_records')
    as d17_readonly_answer,
  pg_current_xact_id_if_assigned() is null as d17_readonly_no_xid \gset
rollback;
-- D17 (before the fixture): the late command runs only in a READ COMMITTED
-- transaction, where each statement after its facility lock reads a new
-- snapshot, so that its limits are exact; under REPEATABLE READ and
-- SERIALIZABLE it refuses before it reads anything (under READ COMMITTED
-- the same call reaches the actor). Recorded in section 1 below.
begin isolation level repeatable read;
create function pg_temp.d17_isolation_outcome() returns text language plpgsql as $f$
begin
  perform ehr.correct_wrong_patient_order_route('lab_request', gen_random_uuid(), 1, 'other', 'own_check',
    current_date, 'Isolation probe note', 'd17-isolation-probe-0001', repeat('a', 64));
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.d17_isolation_outcome() as d17_repeatable_read_outcome \gset
rollback;
begin isolation level serializable;
create function pg_temp.d17_isolation_outcome() returns text language plpgsql as $f$
begin
  perform ehr.correct_wrong_patient_order_route('lab_request', gen_random_uuid(), 1, 'other', 'own_check',
    current_date, 'Isolation probe note', 'd17-isolation-probe-0001', repeat('a', 64));
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.d17_isolation_outcome() as d17_serializable_outcome \gset
rollback;
begin isolation level read committed;
create function pg_temp.d17_isolation_outcome() returns text language plpgsql as $f$
begin
  perform ehr.correct_wrong_patient_order_route('lab_request', gen_random_uuid(), 1, 'other', 'own_check',
    current_date, 'Isolation probe note', 'd17-isolation-probe-0001', repeat('a', 64));
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.d17_isolation_outcome() as d17_read_committed_outcome \gset
rollback;
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

-- 1. Properties, grants and pins.
select pg_temp.assert('d17: a route-access check in a read-only transaction answers no and leaves no transaction id',
  :'d17_readonly_no_xid'::boolean and not :'d17_readonly_answer'::boolean);
select pg_temp.assert('d17: the late command refuses a REPEATABLE READ or SERIALIZABLE caller before it reads '
    || 'anything (its limits are exact only under READ COMMITTED); under READ COMMITTED the same call reaches the actor',
  :'d17_repeatable_read_outcome' = '25000 ORDER_ROUTE_CORRECTION_READ_COMMITTED_REQUIRED'
  and :'d17_serializable_outcome' = '25000 ORDER_ROUTE_CORRECTION_READ_COMMITTED_REQUIRED'
  and :'d17_read_committed_outcome' like '42501 %'
  and (select position('transaction_isolation' in p.prosrc) between 1 and position('order_route_receiver' in p.prosrc)
        from pg_proc p
       where p.oid = 'ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)'::regprocedure),
  concat_ws(' | ', :'d17_repeatable_read_outcome', :'d17_serializable_outcome', :'d17_read_committed_outcome'));
select pg_temp.assert('d17: every new, replaced and recreated function: language, security, volatility, parallel, '
    || 'strictness, leakproof, cost, search path',
  (select array_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s', p.oid::regprocedure, l.lanname, p.prosecdef, p.provolatile,
       p.proparallel, p.proisstrict, p.proleakproof, p.procost, array_to_string(p.proconfig, ';'))
       order by p.oid::regprocedure::text)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid in ('ehr.order_route_correctable_until(ehr.order_routes)'::regprocedure,
      'ehr.order_route_correction_state(ehr.order_routes)'::regprocedure,
      'ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)'::regprocedure,
      'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)'::regprocedure,
      'pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)'::regprocedure,
      'ehr.find_correctable_order_routes(text,text)'::regprocedure,
      'lab.find_correctable_order_routes(text)'::regprocedure,
      'pharmacy.find_correctable_order_routes(text)'::regprocedure,
      'ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure,
      'ehr.order_route_item_access(text,uuid,text)'::regprocedure,
      'lab.return_order_route_result()'::regprocedure,
      'ehr.guard_order_route_wrong_patient_report()'::regprocedure,
      'ehr.list_sent_wrong_patient_order_routes()'::regprocedure,
      'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure,
      'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)'::regprocedure,
      'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure,
      'ehr.patient_list_order_routes()'::regprocedure,
      'identity.admin_find_order_routes(text,text)'::regprocedure))
  = array[
    'ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)|plpgsql|f|v|u|f|f|100|search_path=pg_catalog, ehr, identity, auth, lab, pharmacy, notification, platform, pg_temp',
    'ehr.find_correctable_order_routes(text,text)|plpgsql|f|s|u|f|f|100|search_path=pg_catalog, ehr, identity, auth, lab, pharmacy, platform, pg_temp',
    'ehr.guard_order_route_wrong_patient_report()|plpgsql|f|v|u|f|f|100|search_path=pg_catalog, ehr, pg_temp',
    'ehr.list_sent_wrong_patient_order_routes()|plpgsql|t|s|u|f|f|100|search_path=pg_catalog, ehr, identity, auth, platform, pg_temp',
    'ehr.order_route_access_allows(text,uuid,uuid,text)|plpgsql|t|s|u|f|f|100|search_path=pg_catalog, ehr, auth, platform, pg_temp',
    'ehr.order_route_correctable_until(ehr.order_routes)|sql|f|s|u|f|f|100|search_path=pg_catalog, pg_temp',
    'ehr.order_route_correction_state(ehr.order_routes)|plpgsql|f|s|u|f|f|100|search_path=pg_catalog, ehr, pg_temp',
    'ehr.order_route_item_access(text,uuid,text)|plpgsql|f|s|u|f|f|100|search_path=pg_catalog, ehr, platform, pg_temp',
    'ehr.order_route_summary(ehr.order_routes,boolean)|sql|f|s|u|f|f|100|search_path=pg_catalog, ehr, identity, pg_temp',
    'ehr.patient_list_order_routes()|plpgsql|t|s|u|f|f|100|search_path=pg_catalog, ehr, identity, platform, pg_temp',
    'identity.admin_find_order_routes(text,text)|plpgsql|t|s|u|f|f|100|search_path=pg_catalog, identity, ehr, auth, platform, pg_temp',
    'identity.admin_list_wrong_patient_reports(text,uuid)|plpgsql|t|s|u|f|f|100|search_path=pg_catalog, identity, ehr, auth, platform, pg_temp',
    'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)|plpgsql|t|v|u|f|f|100|search_path=pg_catalog, identity, ehr, auth, audit, platform, pg_temp',
    'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)|sql|t|v|u|f|f|100|search_path=pg_catalog, lab, ehr, pg_temp',
    'lab.find_correctable_order_routes(text)|sql|t|s|u|f|f|100|search_path=pg_catalog, lab, ehr, pg_temp',
    'lab.return_order_route_result()|plpgsql|t|v|u|f|f|100|search_path=pg_catalog, lab, ehr, platform, pg_temp',
    'pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)|sql|t|v|u|f|f|100|search_path=pg_catalog, pharmacy, ehr, pg_temp',
    'pharmacy.find_correctable_order_routes(text)|sql|t|s|u|f|f|100|search_path=pg_catalog, pharmacy, ehr, pg_temp'],
  (select string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s', p.oid::regprocedure, l.lanname, p.prosecdef, p.provolatile,
       p.proparallel, p.proisstrict, p.proleakproof, p.procost, array_to_string(p.proconfig, ';')), E'\n'
       order by p.oid::regprocedure::text)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.proname in ('correct_wrong_patient_order_route', 'find_correctable_order_routes',
      'order_route_correctable_until', 'order_route_correction_state')));
select pg_temp.assert('d17: every new, replaced and recreated function and T9 belong to 0086''s owner (H6''s)',
  (select bool_and(p.proowner = (select owner.proowner from pg_proc owner
                                   where owner.oid = 'ehr.close_order_route(uuid,text,text,boolean)'::regprocedure))
     from pg_proc p
    where p.proname in ('correct_wrong_patient_order_route', 'find_correctable_order_routes',
            'order_route_correctable_until', 'order_route_correction_state')
       or p.oid in ('ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure,
            'ehr.order_route_item_access(text,uuid,text)'::regprocedure, 'lab.return_order_route_result()'::regprocedure,
            'ehr.guard_order_route_wrong_patient_report()'::regprocedure,
            'ehr.list_sent_wrong_patient_order_routes()'::regprocedure,
            'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure,
            'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)'::regprocedure,
            'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure,
            'ehr.patient_list_order_routes()'::regprocedure,
            'identity.admin_find_order_routes(text,text)'::regprocedure))
  and (select c.relowner from pg_class c where c.oid = 'ehr.order_route_correction_capabilities'::regclass)
    = (select p.proowner from pg_proc p where p.oid = 'ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure)
  and (select count(*) from pg_proc p where p.proname in ('correct_wrong_patient_order_route',
         'find_correctable_order_routes', 'order_route_correctable_until', 'order_route_correction_state')) = 8);
create temp table d17_expected_execute (signature regprocedure primary key, grantees text[]) on commit drop;
insert into d17_expected_execute
select signature::regprocedure, grantees from (values
  ('ehr.order_route_correctable_until(ehr.order_routes)', array[]::text[]),
  ('ehr.order_route_correction_state(ehr.order_routes)', array[]::text[]),
  ('ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)', array[]::text[]),
  ('ehr.find_correctable_order_routes(text,text)', array[]::text[]),
  ('lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)',
   array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('lab.find_correctable_order_routes(text)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)',
   array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.find_correctable_order_routes(text)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('ehr.order_route_access_allows(text,uuid,uuid,text)', array[]::text[]),
  ('ehr.order_route_item_access(text,uuid,text)', array[]::text[]),
  ('lab.return_order_route_result()', array[]::text[]),
  ('ehr.guard_order_route_wrong_patient_report()', array[]::text[]),
  ('ehr.order_route_summary(ehr.order_routes,boolean)', array[]::text[]),
  ('ehr.list_sent_wrong_patient_order_routes()', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  ('identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)', array['hid_identity_runtime']),
  ('identity.admin_list_wrong_patient_reports(text,uuid)', array['hid_identity_runtime']),
  ('identity.admin_find_order_routes(text,text)', array['hid_identity_runtime']),
  ('ehr.patient_list_order_routes()', array['hid_ehr_runtime', 'hid_schema_test_runtime'])) v(signature, grantees);
select pg_temp.assert('d17: EXECUTE exactly as 0090 grants it (and as before for the replaced and recreated), PUBLIC none',
  not exists (
    select 1 from d17_expected_execute expected
     where coalesce((select array_agg(acl.grantee::regrole::text order by acl.grantee::regrole::text)
                       from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                      where p.oid = expected.signature and acl.privilege_type = 'EXECUTE' and acl.grantee <> p.proowner),
                    array[]::text[]) <> expected.grantees),
  (select string_agg(expected.signature::text || ' ' || coalesce((select array_agg(acl.grantee::regrole::text)
       from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where p.oid = expected.signature and acl.privilege_type = 'EXECUTE' and acl.grantee <> p.proowner)::text, '{}'), '; ')
     from d17_expected_execute expected));
select pg_temp.assert('d17: the login roles reach their wrappers through their groups, and nothing else',
  has_function_privilege('hid_lab_api_runtime', 'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_lab_api_runtime', 'lab.find_correctable_order_routes(text)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.find_correctable_order_routes(text,text)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.find_correctable_order_routes(text)', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'lab.find_correctable_order_routes(text)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'pharmacy.find_correctable_order_routes(text)', 'EXECUTE')
  and has_function_privilege('hid_ehr_api_runtime', 'ehr.patient_list_order_routes()', 'EXECUTE')
  and not has_function_privilege('hid_identity_api_runtime', 'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_identity_api_runtime', 'identity.admin_list_wrong_patient_reports(text,uuid)', 'EXECUTE')
  and has_function_privilege('hid_identity_api_runtime', 'identity.admin_find_order_routes(text,text)', 'EXECUTE')
  and not exists (select 1 from pg_roles runtime where runtime.rolname ~ '^hid_'
    and runtime.oid <> (select p.proowner from pg_proc p where p.oid = 'ehr.order_route_correction_state(ehr.order_routes)'::regprocedure)
    and (has_function_privilege(runtime.oid, 'ehr.order_route_correction_state(ehr.order_routes)', 'EXECUTE')
      or has_function_privilege(runtime.oid, 'ehr.order_route_correctable_until(ehr.order_routes)', 'EXECUTE'))));
select pg_temp.assert('d17: T9 has row-level security enabled and forced, three policies (select, insert, delete), '
    || 'no grant, no key to another table, no trigger, and no runtime privilege',
  (select c.relrowsecurity and c.relforcerowsecurity from pg_class c
    where c.oid = 'ehr.order_route_correction_capabilities'::regclass)
  and (select array_agg(p.polcmd::text order by p.polcmd::text) from pg_policy p
        where p.polrelid = 'ehr.order_route_correction_capabilities'::regclass) = array['a', 'd', 'r']
  and (select bool_and(pg_get_expr(coalesce(p.polqual, p.polwithcheck), p.polrelid) = 'true') from pg_policy p
        where p.polrelid = 'ehr.order_route_correction_capabilities'::regclass)
  and not exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = 'ehr.order_route_correction_capabilities'::regclass and acl.grantee <> c.relowner)
  and not exists (select 1 from pg_constraint k where k.conrelid = 'ehr.order_route_correction_capabilities'::regclass
    and k.contype = 'f')
  and not exists (select 1 from pg_trigger t where t.tgrelid = 'ehr.order_route_correction_capabilities'::regclass)
  and not exists (select 1 from pg_roles runtime where runtime.rolname ~ '^hid_'
    and runtime.oid <> (select c.relowner from pg_class c where c.oid = 'ehr.order_route_correction_capabilities'::regclass)
    and (has_table_privilege(runtime.oid, 'ehr.order_route_correction_capabilities', 'SELECT')
      or has_table_privilege(runtime.oid, 'ehr.order_route_correction_capabilities', 'INSERT')
      or has_table_privilege(runtime.oid, 'ehr.order_route_correction_capabilities', 'DELETE')
      or has_table_privilege(runtime.oid, 'ehr.order_route_correction_capabilities', 'UPDATE')))
  and (select array_agg(format('%s %s %s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull)
         order by a.attnum) from pg_attribute a
        where a.attrelid = 'ehr.order_route_correction_capabilities'::regclass and a.attnum > 0 and not a.attisdropped)
    = array['transaction_id xid8 t', 'route_id uuid t', 'kind text t', 'receiving_facility_id uuid t',
            'patient_id uuid t', 'membership_id uuid t', 'created_at timestamp with time zone t']
  and (select pg_get_constraintdef(k.oid) from pg_constraint k
        where k.conrelid = 'ehr.order_route_correction_capabilities'::regclass and k.contype = 'p')
    = 'PRIMARY KEY (transaction_id)');
select pg_temp.assert('d17: T8''s four new columns, its widened state CHECK, the two new CHECKs and the late index',
  (select array_agg(format('%s %s %s %s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
          coalesce(pg_get_expr(d.adbin, d.adrelid), '-')) order by a.attnum)
     from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'ehr.order_route_wrong_patient_reports'::regclass
      and a.attname in ('late', 'ended_kind_before', 'discovered_by', 'discovered_on'))
  = array['late boolean t false', 'ended_kind_before text f -', 'discovered_by text f -',
          'discovered_on date f -']
  and (select pg_get_constraintdef(k.oid) from pg_constraint k
        where k.conrelid = 'ehr.order_route_wrong_patient_reports'::regclass
          and k.conname = 'order_route_wrong_patient_reports_state_before_check')
    = 'CHECK ((state_before = ANY (ARRAY[''accepted''::text, ''completed''::text, ''cancelled''::text])))'
  and (select count(*) from pg_constraint k where k.conrelid = 'ehr.order_route_wrong_patient_reports'::regclass
        and k.conname in ('order_route_wrong_patient_reports_late_ck', 'order_route_wrong_patient_reports_late_review_ck')
        and k.convalidated) = 2
  and (select pg_get_indexdef(i.indexrelid) from pg_index i
        where i.indexrelid = 'ehr.order_route_wrong_patient_reports_late_member_idx'::regclass)
    = 'CREATE INDEX order_route_wrong_patient_reports_late_member_idx ON ehr.order_route_wrong_patient_reports '
      || 'USING btree (reported_by_membership_id, reported_at) WHERE late');
select pg_temp.assert('d17: H6 keeps 0086''s route predicate word for word, reads pg_current_xact_id_if_assigned() '
    || 'and never txid_current(), and keeps its owner-only ACL',
  position($p$select 1 from ehr.order_routes route
     where route.receiving_facility_id = row_facility_id
       and route.patient_id = row_patient_id
       and route.kind = requested_kind
       and route.state in ('accepted', 'completed', 'cancelled')
       and ((requested_action = 'write_records' and route.state in ('accepted', 'completed')
             and clock_timestamp() < route.writes_end_at)
         or (requested_action = 'read_records' and clock_timestamp() < route.access_ends_at))) then$p$
    in (select p.prosrc from pg_proc p where p.oid = 'ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure)) > 0
  and (select p.prosrc ~ 'pg_current_xact_id_if_assigned\(\)' and p.prosrc !~* 'txid_current'
         and p.prosrc !~* 'pg_current_xact_id\(\)' and p.proacl = array[format('%s=X/%s', p.proowner::regrole, p.proowner::regrole)::aclitem]
       from pg_proc p where p.oid = 'ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure));
-- The functions every new, replaced or recreated body calls (a source scan
-- for schema-qualified calls), apart from the new functions themselves: the
-- list 0090 pins in its section 0 c (MG3).
create temp table d17_callees on commit drop as
  select distinct proc.oid::regprocedure::text as callee
    from pg_proc body
    cross join lateral regexp_matches(body.prosrc, '([a-z_]+)\.([a-z_][a-z0-9_]*)\s*\(', 'g') called
    join pg_namespace namespace on namespace.nspname = called[1]
    join pg_proc proc on proc.pronamespace = namespace.oid and proc.proname = called[2]
   where body.oid in ('ehr.order_route_correctable_until(ehr.order_routes)'::regprocedure,
      'ehr.order_route_correction_state(ehr.order_routes)'::regprocedure,
      'ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)'::regprocedure,
      'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)'::regprocedure,
      'pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)'::regprocedure,
      'ehr.find_correctable_order_routes(text,text)'::regprocedure,
      'lab.find_correctable_order_routes(text)'::regprocedure,
      'pharmacy.find_correctable_order_routes(text)'::regprocedure,
      'ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure,
      'ehr.order_route_item_access(text,uuid,text)'::regprocedure,
      'lab.return_order_route_result()'::regprocedure,
      'ehr.guard_order_route_wrong_patient_report()'::regprocedure,
      'ehr.list_sent_wrong_patient_order_routes()'::regprocedure,
      'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure,
      'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)'::regprocedure,
      'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure,
      'ehr.patient_list_order_routes()'::regprocedure,
      'identity.admin_find_order_routes(text,text)'::regprocedure)
     and proc.proname not in ('correct_wrong_patient_order_route', 'find_correctable_order_routes',
       'order_route_correctable_until', 'order_route_correction_state');
select pg_temp.assert('d17: the functions the new, replaced and recreated bodies call are exactly the 24 0090 pins for them',
  (select array_agg(callee order by callee) from d17_callees)
  = array['auth.membership_has_permission(text,uuid,uuid,text)', 'ehr.close_order_route(uuid,text,text,boolean)',
    'ehr.lock_receiving_route(text,uuid,uuid,uuid)', 'ehr.order_route_access_open()',
    'ehr.order_route_allows(uuid,uuid,text)', 'ehr.order_route_effective_state(ehr.order_routes)',
    'ehr.order_route_health_id(text)', 'ehr.order_route_notify_patient(ehr.order_routes,text)',
    'ehr.order_route_patient()', 'ehr.order_route_receive_permission(text)', 'ehr.order_route_receiver(text)',
    'ehr.order_route_staff_actor(boolean)', 'ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb)',
    'ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text)',
    'identity.has_active_membership(text,uuid,uuid)', 'identity.order_route_destination_eligible(uuid,text)',
    'identity.order_route_platform_actor(text[])', 'identity.order_route_registered_address(uuid)',
    'platform.current_actor_subject()', 'platform.current_correlation_id()', 'platform.current_facility_id()',
    'platform.current_membership_id()', 'platform.current_purpose_of_use()', 'platform.require_control_enabled(text)'],
  (select string_agg(callee, ', ' order by callee) from d17_callees));
-- Their bodies are the ones 0090 pinned (md5 measured on 0001-0089).
select pg_temp.assert('d17: each called function still has the body 0090 pinned',
  (select count(*) from d17_callees callee
     join (values ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
                  ('ehr.close_order_route(uuid,text,text,boolean)', 'd0c8c11573bc3fd5cc764553d55b1820'),
                  ('ehr.lock_receiving_route(text,uuid,uuid,uuid)', 'b73b01f7ca721adb0de4e834dd566e3a'),
                  ('ehr.order_route_access_open()', 'd0b8aff4c2a656c30872b95286071457'),
                  ('ehr.order_route_allows(uuid,uuid,text)', 'b80c2df6c380f7c7e20d166da94e56d2'),
                  ('ehr.order_route_effective_state(ehr.order_routes)', '934300a9e58a7f6789b1dc24520fabad'),
                  ('ehr.order_route_health_id(text)', 'f336e87adb3ac67fd83ac1de7b3efa7d'),
                  ('ehr.order_route_notify_patient(ehr.order_routes,text)', '31a11a44325846699036367b7e56b46e'),
                  ('ehr.order_route_patient()', '675c6185c12c43e651ebf0a22770d282'),
                  ('ehr.order_route_receive_permission(text)', '4c9f4acbafb062ff9a2cda113ccad037'),
                  ('ehr.order_route_receiver(text)', '61eed3f80f2502aadc338581142214a5'),
                  ('ehr.order_route_staff_actor(boolean)', 'b1873dca92164652cc1977a90acb6184'),
                  ('ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb)',
                   '6c54f543a495e35d9ebd029450d49e0a'),
                  ('ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text)',
                   'b11691bfe99d65a93d60eefe0fc8c0c1'),
                  ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
                  ('identity.order_route_destination_eligible(uuid,text)', '6b274d9be9056cefc831a9fd92040bc6'),
                  ('identity.order_route_platform_actor(text[])', '599cccfdba5e9b4c46cde4dd2814a541'),
                  ('identity.order_route_registered_address(uuid)', '80a2c9e306c72dff55aa2c91af9b93d2'),
                  ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
                  ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
                  ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
                  ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
                  ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
                  ('platform.require_control_enabled(text)', '90887489d15eab24f8f71b145bb02320'))
          pinned(signature, digest) on pinned.signature = callee.callee
     join pg_proc proc on proc.oid = pinned.signature::regprocedure and md5(proc.prosrc) = pinned.digest) = 24);
-- The reference lookups compare the stored char(8) with a char(8), so they
-- can use order_routes_reference_idx (MG6): the comparison each body makes,
-- and the plan of that comparison.
select pg_temp.assert('d17: C21 and C30 compare the reference as char(8)',
  (select p.prosrc ~ 'route\.reference = wanted::char\(8\)' from pg_proc p
    where p.oid = 'ehr.find_correctable_order_routes(text,text)'::regprocedure)
  and (select p.prosrc ~ 'route\.reference = wanted_reference::char\(8\)' from pg_proc p
    where p.oid = 'identity.admin_find_order_routes(text,text)'::regprocedure));
create function pg_temp.plan_of(statement text) returns text language plpgsql as $f$
declare line text; plan text := '';
begin
  for line in execute 'explain (costs off) ' || statement loop
    plan := plan || line || E'\n';
  end loop;
  return plan;
end
$f$;
set local enable_seqscan = off;
select pg_temp.assert('d17: the char(8) comparison is an index condition on order_routes_reference_idx; the text one is not',
  pg_temp.plan_of($s$select 1 from ehr.order_routes route where route.reference = 'ABCDEF12'::text::char(8)$s$)
    ~ 'Index Cond: \(reference = .ABCDEF12.::(bpchar|character\(8\))\)'
  and pg_temp.plan_of($s$select 1 from ehr.order_routes route where route.reference = 'ABCDEF12'::text$s$)
    !~ 'Index Cond: \(reference');
-- T9's probe in H6 is a lookup of its primary key (MG11). Sequential scans
-- stay off for this plan: once autovacuum has seen T9 (always empty between
-- commands), the planner's own choice for it is a sequential scan of its
-- zero pages, which is cheaper still (the report gives both plans).
select pg_temp.assert('d17: T9''s probe in H6 is an index scan on its primary key (MG11)',
  pg_temp.plan_of($s$select 1 from ehr.order_route_correction_capabilities capability
     where capability.transaction_id = '12345'::xid8
       and capability.receiving_facility_id = '00000000-0000-4000-8000-000000000001'
       and capability.patient_id = '00000000-0000-4000-8000-000000000002' and capability.kind = 'lab_request'
       and capability.membership_id = '00000000-0000-4000-8000-000000000003'$s$)
  ~ 'Index Scan using order_route_correction_capabilities_pkey on order_route_correction_capabilities capability\s+Index Cond: \(transaction_id = ''12345''::xid8\)');
reset enable_seqscan;

-- The routes (DA at GH). P's to L1: g2s (completed, closed by support), g1c
-- (completed, its window lapsed), g1a (accepted with an unverified result,
-- its window lapsed), g2e (completed, the order then marked entered in
-- error), g2o and g2r (completed, ended as the ordering's or the receiving
-- organization's release ends routes), v12 (v1 and its correction v2
-- released, closed by support), v2u (accepted with a date of birth and the
-- reference; v1 released, v2 verified but not released, closed by
-- support), old (completed and released, accepted 181 days ago), rep
-- (accepted, reported in its window by item 3's command), lima and limb
-- (completed, closed by support; for the limits), bnd (completed, closed by
-- support; for the bound). P's to GL: gl (sent). Q's to L1: q (completed,
-- lapsed). R's to L1: g2oc (accepted with an unverified result, cancelled by
-- an order change), g2ec (accepted, the order marked entered in error), g2sc
-- (accepted, closed by support), g2orc and g2rrc (accepted, ended by the
-- releases), opa (accepted, open), opc (completed, open), snt (sent), dec
-- (declined), wdn (withdrawn by DA), exp (sent, past respond_by), dup1 and
-- dup2 (a copy of dup1 sharing its reference). P's prescriptions to
-- PH1: rx2s (dispensed, closed by support), rx1a (accepted, lapsed), rxrev
-- (dispensed, lapsed, then reversed by PB3 under P's consent), rx1c
-- (dispensed, lapsed), rxpr (dispensed, closed by support).
set local role hid_ehr_api_runtime;
select pg_temp.order_to(name, 'lab_request', 1, current_setting('hid.test.facility_1')::uuid)
  from unnest(array['g2s', 'g1c', 'g1a', 'g2e', 'g2o', 'g2r', 'v12', 'v2u', 'old', 'rep', 'lima', 'limb', 'bnd']) name;
select pg_temp.order_to('gl', 'lab_request', 1, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.order_to('q', 'lab_request', 2, current_setting('hid.test.facility_1')::uuid);
select pg_temp.order_to(name, 'lab_request', 4, current_setting('hid.test.facility_1')::uuid)
  from unnest(array['g2oc', 'g2ec', 'g2sc', 'g2orc', 'g2rrc', 'opa', 'opc', 'snt', 'dec', 'wdn', 'exp', 'dup1']) name;
select pg_temp.order_to(name, 'prescription', 1, current_setting('hid.test.facility_2')::uuid)
  from unnest(array['rx2s', 'rx1a', 'rxrev', 'rx1c', 'rxpr']) name;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select * from ehr.withdraw_order_route(pg_temp.r('wdn'), 'lab_request', pg_temp.o('wdn'), 1, 'sent_in_error');
reset role;
select set_config('hid.test.ref_v2u', (select route.reference::text from ehr.order_routes route
  where route.id = pg_temp.r('v2u')), true);
-- Acceptances: LB1 at L1 (v2u with a date of birth and its reference; Q's
-- and N's with their Health IDs), PB1 at PH1; LB1 declines dec.
set local role hid_lab_api_runtime;
select set_config('hid.test.item_' || name, pg_temp.accept_lab(pg_temp.r(name))::text, true)
  from unnest(array['g2s', 'g1c', 'g1a', 'g2e', 'g2o', 'g2r', 'v12', 'old', 'rep', 'lima', 'limb', 'bnd']) name;
select set_config('hid.test.item_v2u', pg_temp.accept_lab(pg_temp.r('v2u'), 'date_of_birth',
  pg_temp.ref('v2u'))::text, true);
select set_config('hid.test.item_q', pg_temp.accept_with(pg_temp.r('q'), 'HID-P4CPATQ')::text, true);
select set_config('hid.test.item_' || name, pg_temp.accept_with(pg_temp.r(name), 'HID-P4CPATR')::text, true)
  from unnest(array['g2oc', 'g2ec', 'g2sc', 'g2orc', 'g2rrc', 'opa', 'opc', 'dup1']) name;
select pg_temp.as_signup_admin(1);
select * from lab.decline_order_route(pg_temp.r('dec'), 1, 'test_not_offered');
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.item_' || name, pg_temp.accept_rx(pg_temp.r(name))::text, true)
  from unnest(array['rx2s', 'rx1a', 'rxrev', 'rx1c', 'rxpr']) name;
reset role;
-- The work: a verified result (LB2 entered, LB1 verified) on each completed
-- lab route; unverified results LB2 entered on g1a and g2oc.
select set_config('hid.test.result_' || name, pg_temp.lab_chain(pg_temp.i(name), 'd17' || name, 10.4)::text, true)
  from unnest(array['g2s', 'g1c', 'g2e', 'g2o', 'g2r', 'v12', 'v2u', 'old', 'lima', 'limb', 'bnd', 'q', 'opc']) name;
select pg_temp.assert('d17 fixture: g1a and g2oc have one unverified result each',
  pg_temp.lab_entry(pg_temp.i('g1a'), 'd17g1a', 9.8) = 1 and pg_temp.lab_entry(pg_temp.i('g2oc'), 'd17g2oc', 9.6) = 1);
select set_config('hid.test.result_g1a', current_setting('hid.test.d17g1a_result_1'), true),
  set_config('hid.test.result_g2oc', current_setting('hid.test.d17g2oc_result_1'), true);
-- Releases of version 1 by LB1 under route access.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.release(pg_temp.res(name), 1, current_setting('hid.test.d17' || name || '_verification_1')::uuid,
    'd17-release-' || name || '-1')
  from unnest(array['g2s', 'g1c', 'g2e', 'g2o', 'g2r', 'v12', 'v2u', 'old', 'lima', 'limb', 'bnd', 'q', 'opc']) name;
reset role;
-- v12's correction v2 (verified by LB1) released by LB2; v2u's verified, not
-- released.
select set_config('hid.test.v12_verification_2', pg_temp.lab_correction(pg_temp.res('v12'), 'd17v12', 11.2,
  current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
select pg_temp.lab_correction(pg_temp.res('v2u'), 'd17v2u', 11.6, current_setting('hid.test.account_1')::uuid,
  current_setting('hid.test.membership_1')::uuid);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.release(pg_temp.res('v12'), 2, current_setting('hid.test.v12_verification_2')::uuid,
  'd17-release-v12-2');
reset role;
-- Dispensings by PB2 on rx2s, rxrev, rx1c and rxpr.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select set_config('hid.test.dispensing_' || name, pg_temp.dispense(pg_temp.i(name), 'd17-dispense-' || name)::text, true)
  from unnest(array['rx2s', 'rxrev', 'rx1c', 'rxpr']) name;
reset role;
-- The endings. Item 3's report of rep by LB1, in its window.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.keep('rep', 'lab_request', pg_temp.r('rep'), 2, 'wrong_order_chosen',
  'Picked the wrong row at the counter', 'd17-inwindow-rep-0001');
reset role;
-- DA cancels g2oc's order and marks g2e's (completed) and g2ec's (accepted)
-- entered in error: the mirror ends the routes.
set local role hid_ehr_api_runtime;
select pg_temp.edit_lab(pg_temp.o('g2oc'), 'cancelled', 'No longer needed');
select pg_temp.edit_lab(pg_temp.o('g2e'), 'entered_in_error', 'Written in the wrong chart');
select pg_temp.edit_lab(pg_temp.o('g2ec'), 'entered_in_error', 'Written in the wrong chart');
reset role;
-- Support (FR) closes g2s, v12, v2u, lima, limb, bnd, g2sc, rx2s and rxpr.
select pg_temp.snap();
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select route_closed.state from unnest(array['g2s', 'v12', 'v2u', 'lima', 'limb', 'bnd', 'g2sc', 'rx2s', 'rxpr']) name
  cross join lateral identity.admin_close_order_route(pg_temp.r(name), pg_temp.v(pg_temp.r(name)),
    'The hospital asked support to close it') route_closed;
reset role;
-- g2o and g2orc end as the ordering organization's release ends routes,
-- g2r and g2rrc as the receiving one's (the release trigger's own call of
-- the closer; the organizations stay active, so B may still act).
select pg_temp.assert('d17 fixture: the releases'' endings',
  pg_temp.close_as(pg_temp.r('g2o'), 'ordering_released') = 'access_ended'
  and pg_temp.close_as(pg_temp.r('g2r'), 'receiving_released') = 'access_ended'
  and pg_temp.close_as(pg_temp.r('g2orc'), 'ordering_released') = 'cancelled'
  and pg_temp.close_as(pg_temp.r('g2rrc'), 'receiving_released') = 'cancelled');
-- Windows lapse: g1c, g1a, q, rx1a, rxrev and rx1c 46 days back (past
-- access_ends_at too), old 181 days, exp 8 days (past respond_by).
select pg_temp.age_route(pg_temp.r(name), interval '46 days', interval '46 days')
  from unnest(array['g1c', 'g1a', 'q', 'rx1a', 'rxrev', 'rx1c']) name;
select pg_temp.age_route(pg_temp.r('old'), interval '181 days', interval '181 days');
select pg_temp.age_route(pg_temp.r('exp'), interval '8 days', interval '0 days');
-- dup2: a copy of dup1 whose id, so its reference, begins as dup1's, accepted a
-- minute later (owner SQL, triggers off).
select set_config('hid.test.route_dup2', pg_temp.copy_route(pg_temp.r('dup1'), jsonb_build_object(
  'id', left(pg_temp.r('dup1')::text, 8) || substr(gen_random_uuid()::text, 9),
  'idempotency_key', 'd17-copy-' || gen_random_uuid(), 'source_lab_request_id', gen_random_uuid(),
  'accepted_at', (pg_temp.route(pg_temp.r('dup1'))).accepted_at + interval '1 minute'))::text, true);
-- rxrev's dispensing reversed by PB3, under P's consent at PH1, after the
-- window.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_pb3();
insert into pharmacy.dispensing_reversals (dispensing_id, dispensing_version, work_item_id, patient_id, facility_id,
  reversed_by, reversed_by_membership_id, reason, idempotency_key, request_sha256, correlation_id)
values (current_setting('hid.test.dispensing_rxrev')::uuid, 1, pg_temp.i('rxrev'),
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_2')::uuid,
  'e4c10000-0000-4000-8000-000000000037', 'e4c13000-0000-4000-8000-000000000037', 'Handed out the wrong strength',
  'd17-reverse-consent-rxrev', repeat('e', 64), current_setting('app.correlation_id'));
reset role;
select set_config('hid.test.ref_' || name, (select route.reference::text from ehr.order_routes route
    where route.id = pg_temp.r(name)), true),
  set_config('hid.test.accepted_day_' || name, (select coalesce((route.accepted_at at time zone 'Africa/Lagos')::date::text,
    '') from ehr.order_routes route where route.id = pg_temp.r(name)), true)
  from unnest(array['g2s', 'g1c', 'g1a', 'g2e', 'g2o', 'g2r', 'v12', 'v2u', 'old', 'rep', 'lima', 'limb', 'bnd', 'gl',
    'q', 'g2oc', 'g2ec', 'g2sc', 'g2orc', 'g2rrc', 'opa', 'opc', 'snt', 'dec', 'wdn', 'exp', 'dup1', 'dup2', 'rx2s',
    'rx1a', 'rxrev', 'rx1c', 'rxpr']) name;
select pg_temp.assert('d17 fixture: each route''s state, ending and correction state before any late report',
  (select array_agg(name || ':' || route.state || ':' || coalesce(route.ended_kind, '-') || ':'
        || ehr.order_route_correction_state(route) order by position)
     from unnest(array['g2s', 'g1c', 'g1a', 'g2e', 'g2o', 'g2r', 'v12', 'v2u', 'old', 'rep', 'lima', 'gl', 'q', 'g2oc',
       'g2ec', 'g2sc', 'g2orc', 'g2rrc', 'opa', 'opc', 'snt', 'dec', 'wdn', 'exp', 'rx2s', 'rx1a', 'rxrev', 'rx1c',
       'rxpr']) with ordinality listed(name, position)
     join ehr.order_routes route on route.id = pg_temp.r(listed.name))
  = array['g2s:completed:support:correctable', 'g1c:completed:-:correctable', 'g1a:accepted:-:correctable',
    'g2e:completed:entered_in_error:correctable', 'g2o:completed:ordering_released:correctable',
    'g2r:completed:receiving_released:correctable', 'v12:completed:support:correctable',
    'v2u:completed:support:correctable', 'old:completed:-:too_late', 'rep:cancelled:wrong_patient:reported',
    'lima:completed:support:correctable', 'gl:sent:-:not_accepted', 'q:completed:-:correctable',
    'g2oc:cancelled:order_changed:correctable', 'g2ec:cancelled:entered_in_error:correctable',
    'g2sc:cancelled:support:correctable', 'g2orc:cancelled:ordering_released:correctable',
    'g2rrc:cancelled:receiving_released:correctable', 'opa:accepted:-:open', 'opc:completed:-:open',
    'snt:sent:-:not_accepted', 'dec:declined:-:not_accepted', 'wdn:withdrawn:orderer:not_accepted',
    'exp:sent:-:not_accepted', 'rx2s:completed:support:correctable', 'rx1a:accepted:-:correctable',
    'rxrev:completed:-:correctable', 'rx1c:completed:-:correctable', 'rxpr:completed:support:correctable'],
  (select string_agg(name || ':' || route.state || ':' || coalesce(route.ended_kind, '-') || ':'
        || ehr.order_route_correction_state(route), ', ' order by position)
     from unnest(array['g2s', 'g1c', 'g1a', 'g2e', 'g2o', 'g2r', 'v12', 'v2u', 'old', 'rep', 'lima', 'gl', 'q', 'g2oc',
       'g2ec', 'g2sc', 'g2orc', 'g2rrc', 'opa', 'opc', 'snt', 'dec', 'wdn', 'exp', 'rx2s', 'rx1a', 'rxrev', 'rx1c',
       'rxpr']) with ordinality listed(name, position)
     join ehr.order_routes route on route.id = pg_temp.r(listed.name)));
select pg_temp.assert('d17 fixture: no route of P at L1 or PH1, or of Q at L1, allows a read or a write now',
  not exists (select 1 from ehr.order_routes route
               where route.patient_id in (current_setting('hid.test.p')::uuid, current_setting('hid.test.q')::uuid)
                 and route.receiving_facility_id in (current_setting('hid.test.facility_1')::uuid,
                   current_setting('hid.test.facility_2')::uuid)
                 and route.state in ('accepted', 'completed', 'cancelled')
                 and (clock_timestamp() < route.access_ends_at or clock_timestamp() < route.writes_end_at))
  and (select count(*) from ehr.order_route_wrong_patient_reports) = 1
  and (select count(*) from pharmacy.order_route_dispensing_reports report_row
        where report_row.route_id = pg_temp.r('rxrev')) = 2);
select pg_temp.snap();
-- The correction state's definition, one rule at a time, on g1c's row
-- changed by hand (not stored): open while an accepted route may still be
-- worked, or a completed one may and has not ended; too late from the
-- bound; correctable otherwise.
create function pg_temp.state_with(new_state text, accepted_ago interval, ended_ago interval, writes_end_in interval)
returns text language plpgsql as $f$
declare
  changed ehr.order_routes;
begin
  select route.* into changed from ehr.order_routes route where route.id = pg_temp.r('g1c');
  changed.state := new_state;
  changed.accepted_at := clock_timestamp() - accepted_ago;
  changed.ended_at := clock_timestamp() - ended_ago;
  changed.writes_end_at := clock_timestamp() + writes_end_in;
  return ehr.order_route_correction_state(changed);
end
$f$;
select pg_temp.assert('d17 state: open, correctable and too late by definition',
  pg_temp.state_with('accepted', '10 days', null, '1 hour') = 'open'
  and pg_temp.state_with('accepted', '10 days', null, '-1 hour') = 'correctable'
  and pg_temp.state_with('completed', '10 days', null, '1 hour') = 'open'
  and pg_temp.state_with('completed', '10 days', '1 hour', '1 hour') = 'correctable'
  and pg_temp.state_with('completed', '10 days', '1 hour', '-2 hours') = 'correctable'
  and pg_temp.state_with('cancelled', '10 days', '1 hour', '1 hour') = 'correctable'
  and pg_temp.state_with('completed', interval '4320 hours' - interval '1 minute', '1 hour', '-2 hours') = 'correctable'
  and pg_temp.state_with('completed', interval '4320 hours' + interval '1 second', '1 hour', '-2 hours') = 'too_late'
  and pg_temp.state_with('accepted', interval '4320 hours' + interval '1 second', null, '-1 hour') = 'too_late',
  concat_ws(',', pg_temp.state_with('accepted', '10 days', null, '1 hour'),
    pg_temp.state_with('accepted', '10 days', null, '-1 hour'), pg_temp.state_with('completed', '10 days', null, '1 hour'),
    pg_temp.state_with('completed', '10 days', '1 hour', '1 hour'),
    pg_temp.state_with('completed', '10 days', '1 hour', '-2 hours'),
    pg_temp.state_with('cancelled', '10 days', '1 hour', '1 hour'),
    pg_temp.state_with('completed', interval '4320 hours' - interval '1 minute', '1 hour', '-2 hours'),
    pg_temp.state_with('completed', interval '4320 hours' + interval '1 second', '1 hour', '-2 hours'),
    pg_temp.state_with('accepted', interval '4320 hours' + interval '1 second', null, '-1 hour')));

-- 2. The capability. Without one, LB1 at L1 (no consent for P or Q) reads
-- none of their results, and cannot void one by hand; the Lab runtime can
-- neither read nor write T9.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 capability: without one, LB1 reads none of P''s or Q''s results at L1',
  pg_temp.results_seen(current_setting('hid.test.p')::uuid) = 0
  and pg_temp.results_seen(current_setting('hid.test.q')::uuid) = 0);
select pg_temp.assert('d17 capability: LB1''s hand-written invalidation of g2s''s result is refused', pg_temp.refused(pg_temp.hand_void(pg_temp.res('g2s')))
  = 'refused', pg_temp.outcome(pg_temp.hand_void(pg_temp.res('g2s'))));
select pg_temp.check('d17 capability: the Lab runtime cannot write T9', $s$insert into
  ehr.order_route_correction_capabilities (transaction_id, route_id, kind, receiving_facility_id, patient_id,
  membership_id) values (pg_current_xact_id(), gen_random_uuid(), 'lab_request', gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid())$s$, '42501 permission denied for table order_route_correction_capabilities');
select pg_temp.check('d17 capability: the Lab runtime cannot read T9',
  'select count(*) from ehr.order_route_correction_capabilities',
  '42501 permission denied for table order_route_correction_capabilities');
reset role;
-- A row of another transaction (another id), and one of this transaction
-- for another member (LB2), open nothing for LB1.
insert into ehr.order_route_correction_capabilities (transaction_id, route_id, kind, receiving_facility_id, patient_id,
  membership_id)
values (((pg_current_xact_id()::text)::numeric - 1)::text::xid8, pg_temp.r('g2s'), 'lab_request',
  current_setting('hid.test.facility_1')::uuid, current_setting('hid.test.p')::uuid,
  current_setting('hid.test.membership_1')::uuid);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 capability: a row of another transaction opens nothing',
  pg_temp.results_seen(current_setting('hid.test.p')::uuid) = 0);
reset role;
delete from ehr.order_route_correction_capabilities;
insert into ehr.order_route_correction_capabilities (transaction_id, route_id, kind, receiving_facility_id, patient_id,
  membership_id)
values (pg_current_xact_id(), pg_temp.r('g2s'), 'lab_request', current_setting('hid.test.facility_1')::uuid,
  current_setting('hid.test.p')::uuid, 'e4c13000-0000-4000-8000-000000000031');
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 capability: a row of this transaction for another member opens nothing',
  pg_temp.results_seen(current_setting('hid.test.p')::uuid) = 0);
reset role;
delete from ehr.order_route_correction_capabilities;
-- Nor one of this transaction for LB1 of the other kind, or at another
-- facility.
insert into ehr.order_route_correction_capabilities (transaction_id, route_id, kind, receiving_facility_id, patient_id,
  membership_id)
values (pg_current_xact_id(), pg_temp.r('g2s'), 'prescription', current_setting('hid.test.facility_1')::uuid,
  current_setting('hid.test.p')::uuid, current_setting('hid.test.membership_1')::uuid);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 capability: a row of this transaction for LB1 of the other kind opens nothing',
  pg_temp.results_seen(current_setting('hid.test.p')::uuid) = 0);
reset role;
delete from ehr.order_route_correction_capabilities;
insert into ehr.order_route_correction_capabilities (transaction_id, route_id, kind, receiving_facility_id, patient_id,
  membership_id)
values (pg_current_xact_id(), pg_temp.r('g2s'), 'lab_request', current_setting('hid.test.facility_2')::uuid,
  current_setting('hid.test.p')::uuid, current_setting('hid.test.membership_1')::uuid);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 capability: a row of this transaction for LB1 at another facility opens nothing at L1',
  pg_temp.results_seen(current_setting('hid.test.p')::uuid) = 0);
reset role;
delete from ehr.order_route_correction_capabilities;
-- One of this transaction for LB1 opens exactly P's lab rows at L1 for LB1:
-- not Q's, not for LB2, not another kind, facility or purpose.
insert into ehr.order_route_correction_capabilities (transaction_id, route_id, kind, receiving_facility_id, patient_id,
  membership_id)
values (pg_current_xact_id(), pg_temp.r('g2s'), 'lab_request', current_setting('hid.test.facility_1')::uuid,
  current_setting('hid.test.p')::uuid, current_setting('hid.test.membership_1')::uuid);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 capability: this transaction''s row for LB1 opens P''s results at L1 to LB1, not Q''s',
  pg_temp.results_seen(current_setting('hid.test.p')::uuid) > 0
  and pg_temp.results_seen(current_setting('hid.test.q')::uuid) = 0,
  pg_temp.results_seen(current_setting('hid.test.p')::uuid)::text);
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('d17 capability: ... and not to LB2', pg_temp.results_seen(current_setting('hid.test.p')::uuid) = 0);
select pg_temp.as_signup_admin(1, 'emergency');
select pg_temp.assert('d17 capability: ... and not under another purpose',
  pg_temp.results_seen(current_setting('hid.test.p')::uuid) = 0);
reset role;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 capability: H6 opens that facility, patient and kind (read and write), nothing else',
  ehr.order_route_access_allows('lab_request', current_setting('hid.test.p')::uuid,
    current_setting('hid.test.facility_1')::uuid, 'read_records')
  and ehr.order_route_access_allows('lab_request', current_setting('hid.test.p')::uuid,
    current_setting('hid.test.facility_1')::uuid, 'write_records')
  and not ehr.order_route_access_allows('prescription', current_setting('hid.test.p')::uuid,
    current_setting('hid.test.facility_1')::uuid, 'read_records')
  and not ehr.order_route_access_allows('lab_request', current_setting('hid.test.q')::uuid,
    current_setting('hid.test.facility_1')::uuid, 'read_records')
  and not ehr.order_route_access_allows('lab_request', current_setting('hid.test.p')::uuid,
    current_setting('hid.test.facility_2')::uuid, 'read_records')
  and not ehr.order_route_access_allows('lab_request', current_setting('hid.test.p')::uuid,
    current_setting('hid.test.facility_1')::uuid, 'delete_records'));
delete from ehr.order_route_correction_capabilities;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 capability: once the row is gone, LB1 reads none of P''s results again',
  pg_temp.results_seen(current_setting('hid.test.p')::uuid) = 0);
reset role;

-- 3. B's lookup (C30), before any late report.
-- gla: a copy of g2s accepted at GL, whose id (so its reference) begins as
-- g2s's (owner SQL, triggers off; removed after the lookup's checks).
select set_config('hid.test.route_gla', pg_temp.copy_route(pg_temp.r('g2s'), jsonb_build_object(
  'id', left(pg_temp.r('g2s')::text, 8) || substr(gen_random_uuid()::text, 9),
  'idempotency_key', 'd17-copy-' || gen_random_uuid(), 'source_lab_request_id', gen_random_uuid(),
  'receiving_facility_id', (pg_temp.route(pg_temp.r('gl'))).receiving_facility_id))::text, true);
select set_config('hid.test.footprint_lookup', pg_temp.footprint17(), true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 lookup: the Lab finds its accepted routes by reference (trimmed, any case)',
  pg_temp.look('g2s', 'lab_request', '  ' || lower(pg_temp.ref('g2s')) || ' ') = 1
  and pg_temp.look('g1c', 'lab_request', pg_temp.ref('g1c')) = 1
  and pg_temp.look('g1a', 'lab_request', pg_temp.ref('g1a')) = 1
  and pg_temp.look('v12', 'lab_request', pg_temp.ref('v12')) = 1
  and pg_temp.look('v2u', 'lab_request', pg_temp.ref('v2u')) = 1
  and pg_temp.look('old', 'lab_request', pg_temp.ref('old')) = 1
  and pg_temp.look('rep', 'lab_request', pg_temp.ref('rep')) = 1
  and pg_temp.look('opa', 'lab_request', pg_temp.ref('opa')) = 1
  and pg_temp.look('g2oc', 'lab_request', pg_temp.ref('g2oc')) = 1
  and pg_temp.look('dup', 'lab_request', pg_temp.ref('dup1')) = 2);
select pg_temp.assert('d17 lookup: never-accepted routes, another facility''s and another kind''s are not found',
  pg_temp.look('snt', 'lab_request', pg_temp.ref('snt')) = 0
  and pg_temp.look('dec', 'lab_request', pg_temp.ref('dec')) = 0
  and pg_temp.look('wdn', 'lab_request', pg_temp.ref('wdn')) = 0
  and pg_temp.look('exp', 'lab_request', pg_temp.ref('exp')) = 0
  and pg_temp.look('gl', 'lab_request', pg_temp.ref('gl')) = 0
  and pg_temp.look('gla', 'lab_request', pg_temp.ref('g2s')) = 1
  and (pg_temp.found('gla') ->> 'route_id')::uuid = pg_temp.r('g2s')
  and pg_temp.look('rx2s-lab', 'lab_request', pg_temp.ref('rx2s')) = 0
  and pg_temp.look('none', 'lab_request', 'ABCDEF12') = 0);
select pg_temp.check('d17 lookup: a reference that is not 8 hex characters',
  $s$select * from lab.find_correctable_order_routes('3F2A9C1')$s$, '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d17 lookup: a reference with a letter beyond F',
  $s$select * from lab.find_correctable_order_routes('3F2A9C1G')$s$, '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('d17 lookup: no reference', $s$select * from lab.find_correctable_order_routes(null)$s$,
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.as_signup_admin(1, 'emergency');
select pg_temp.check('d17 lookup: another purpose', format($s$select * from lab.find_correctable_order_routes(%L)$s$,
  pg_temp.ref('g2s')), '42501 Order route staff context is required');
select pg_temp.as_staff(32, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d17 lookup: a receptionist', format($s$select * from lab.find_correctable_order_routes(%L)$s$,
  pg_temp.ref('g2s')), '42501 ORDER_ROUTE_PERMISSION_DENIED');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.assert('d17 lookup: the Pharmacy finds its accepted prescriptions, not a lab request',
  pg_temp.look('rx2s', 'prescription', pg_temp.ref('rx2s')) = 1
  and pg_temp.look('rxrev', 'prescription', pg_temp.ref('rxrev')) = 1
  and pg_temp.look('rx1a', 'prescription', pg_temp.ref('rx1a')) = 1
  and pg_temp.look('g2s-rx', 'prescription', pg_temp.ref('g2s')) = 0);
reset role;
select pg_temp.assert('d17 lookup: it writes nothing', pg_temp.footprint17() = current_setting('hid.test.footprint_lookup'));
set local session_replication_role = replica;
delete from ehr.order_routes route where route.id = pg_temp.r('gla');
set local session_replication_role = origin;
select pg_temp.assert('d17 lookup: a correctable route with B''s own facts (g2s): the test, who accepted it and how, '
    || 'what went back and that it was not withdrawn',
  pg_temp.found('g2s') = (select jsonb_build_object('route_id', route.id, 'reference', route.reference,
      'kind', 'lab_request', 'row_version', route.row_version, 'effective_state', 'completed',
      'ordering_facility_name', 'P4c General Hospital', 'accepted_at', route.accepted_at,
      'completed_at', route.completed_at, 'ended_at', route.ended_at, 'ended_kind', 'support', 'returned', true,
      'correction_state', 'correctable', 'correctable_until', route.accepted_at + interval '4320 hours',
      'reported_at', null, 'report_late', null, 'what_name', 'Haemoglobin', 'accepted_by_name', 'Kemi Lab Admin',
      'accepted_with', 'health_id',
      'returned_items', (select jsonb_agg(jsonb_build_object('at', released.occurred_at, 'withdrawn', false)
                                          order by released.recorded_at, released.id)
                           from lab.order_route_result_reports released
                          where released.route_id = route.id and released.kind = 'released'))
    from ehr.order_routes route where route.id = pg_temp.r('g2s')),
  pg_temp.found('g2s')::text);
select pg_temp.assert('d17 lookup: v12 lists both versions that went back, oldest first; v2u was accepted with a date '
    || 'of birth and the reference; g1a (accepted, lapsed) returned nothing',
  jsonb_array_length(pg_temp.found('v12') -> 'returned_items') = 2
  and (select bool_and((item ->> 'withdrawn')::boolean = false) from jsonb_array_elements(pg_temp.found('v12') -> 'returned_items') item)
  and (pg_temp.found('v12') ->> 'returned_items') = (select jsonb_agg(jsonb_build_object('at', released.occurred_at,
        'withdrawn', false) order by released.recorded_at, released.id)::text from lab.order_route_result_reports released
        where released.route_id = pg_temp.r('v12') and released.kind = 'released')
  and pg_temp.found('v2u') ->> 'accepted_with' = 'date_of_birth_with_reference'
  and pg_temp.found('g1a') ->> 'correction_state' = 'correctable'
  and pg_temp.found('g1a') ->> 'effective_state' = 'expired'
  and not (pg_temp.found('g1a') ->> 'returned')::boolean
  and pg_temp.found('g1a') -> 'returned_items' = '[]'::jsonb
  and pg_temp.found('g2oc') ->> 'ended_kind' = 'order_changed' and pg_temp.found('g2oc') ->> 'correction_state' = 'correctable');
select pg_temp.assert('d17 lookup: too late and reported routes carry no details; an open route does',
  pg_temp.found('old') ->> 'correction_state' = 'too_late'
  and (pg_temp.found('old') ->> 'correctable_until')::timestamptz = (pg_temp.route(pg_temp.r('old'))).accepted_at + interval '4320 hours'
  and pg_temp.found('old') -> 'what_name' = 'null'::jsonb and pg_temp.found('old') -> 'accepted_by_name' = 'null'::jsonb
  and pg_temp.found('old') -> 'accepted_with' = 'null'::jsonb and pg_temp.found('old') -> 'returned_items' = 'null'::jsonb
  and (pg_temp.found('old') ->> 'returned')::boolean
  and pg_temp.found('rep') ->> 'correction_state' = 'reported'
  and (pg_temp.found('rep') ->> 'reported_at')::timestamptz
      = (select report.reported_at from ehr.order_route_wrong_patient_reports report where report.route_id = pg_temp.r('rep'))
  and pg_temp.found('rep') ->> 'report_late' = 'false' and pg_temp.found('rep') -> 'what_name' = 'null'::jsonb
  and pg_temp.found('opa') ->> 'correction_state' = 'open' and pg_temp.found('opa') ->> 'what_name' = 'Haemoglobin'
  and pg_temp.found('opa') -> 'returned_items' = '[]'::jsonb);
select pg_temp.assert('d17 lookup: two routes sharing a reference, newest acceptance first',
  (select array_agg((found.found ->> 'route_id')::uuid order by found.n) from d17_found found where found.label = 'dup')
  = array[pg_temp.r('dup2'), pg_temp.r('dup1')]);
select pg_temp.assert('d17 lookup: the Pharmacy''s rows: a dispensing that went back, and one already reversed under '
    || 'the patient''s consent (withdrawn)',
  pg_temp.found('rx2s') ->> 'what_name' = 'Amoxicillin 500 mg'
  and (pg_temp.found('rx2s') -> 'returned_items' -> 0 ->> 'withdrawn') = 'false'
  and jsonb_array_length(pg_temp.found('rx2s') -> 'returned_items') = 1
  and (pg_temp.found('rxrev') -> 'returned_items' -> 0 ->> 'withdrawn') = 'true'
  and (pg_temp.found('rxrev') ->> 'returned')::boolean
  and pg_temp.found('rxrev') ->> 'accepted_by_name' = 'Lanre Pharmacy Admin'
  and pg_temp.found('rx1a') -> 'returned_items' = '[]'::jsonb);
select pg_temp.assert('d17 lookup: no patient, orderer, work item or value in any column or row',
  not exists (select 1 from pg_proc p, unnest(p.proargnames) name
               where p.oid in ('lab.find_correctable_order_routes(text)'::regprocedure,
                 'pharmacy.find_correctable_order_routes(text)'::regprocedure,
                 'ehr.find_correctable_order_routes(text,text)'::regprocedure)
                 and (name ~ 'patient|orderer|work_item|value|health_id|birth'))
  and not exists (select 1 from d17_found found
                   where found.found::text ~* '(Patience|Okafor|Rukayat|Danjuma|Nkem|P4CPAT|1990-04-12|(^|[^0-9:])10\.4([^0-9]|$)|Fever|e4c30000)'));

-- 4. Refusals of the late command, which write nothing.
select set_config('hid.test.footprint_refusals', pg_temp.footprint17(), true);
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d17 refusal: ' || name || ' was never accepted here', format($s$select * from pg_temp.late(
    'lab_request', %L, 1, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them',
    %L)$s$, pg_temp.r(name), 'd17-refuse-' || name || '-00001'), 'P0001 ORDER_ROUTE_NOT_ACCEPTED')
  from unnest(array['snt', 'dec', 'wdn', 'exp']) name;
select pg_temp.check('d17 refusal: ' || name || ' is still open', format($s$select * from pg_temp.late('lab_request',
    %L, %s, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', %L)$s$, pg_temp.r(name),
    pg_temp.v(pg_temp.r(name)), 'd17-refuse-' || name || '-00001'), 'P0001 ORDER_ROUTE_STILL_OPEN')
  from unnest(array['opa', 'opc']) name;
select pg_temp.check('d17 refusal: opa is still open, with a stale version (the state first)',
  format($s$select * from pg_temp.late('lab_request', %L, 1, 'other', 'patient', pg_temp.lagos_today(),
    'The patient says it was not them', 'd17-refuse-opa-00002')$s$, pg_temp.r('opa')), 'P0001 ORDER_ROUTE_STILL_OPEN');
select pg_temp.check('d17 refusal: old is too late', format($s$select * from pg_temp.late('lab_request', %L, %s, 'other',
    'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-old-00001')$s$,
    pg_temp.r('old'), pg_temp.v(pg_temp.r('old'))), 'P0001 ORDER_ROUTE_CORRECTION_TOO_LATE');
select pg_temp.check('d17 refusal: rep was reported in its window', format($s$select * from pg_temp.late('lab_request',
    %L, %s, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-rep-00001')$s$,
    pg_temp.r('rep'), pg_temp.v(pg_temp.r('rep'))), 'P0001 ORDER_ROUTE_ALREADY_REPORTED');
select pg_temp.check('d17 refusal: another facility''s route', format($s$select * from pg_temp.late('lab_request', %L, 1,
    'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-gl-000001')$s$,
    pg_temp.r('gl')), 'P0002 ORDER_ROUTE_NOT_FOUND');
select pg_temp.check('d17 refusal: a prescription route through the Lab', format($s$select * from pg_temp.late(
    'lab_request', %L, %s, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them',
    'd17-refuse-rx2s-00001')$s$, pg_temp.r('rx2s'), pg_temp.v(pg_temp.r('rx2s'))), 'P0002 ORDER_ROUTE_NOT_FOUND');
select pg_temp.check('d17 refusal: a stale version on a correctable route', format($s$select * from pg_temp.late(
    'lab_request', %L, %s, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them',
    'd17-refuse-g2s-00001')$s$, pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s')) - 1), 'P0001 ORDER_ROUTE_VERSION_CONFLICT');
select pg_temp.check('d17 refusal: ' || bad.label, format($s$select * from pg_temp.late('lab_request', %L, %s, %L, %L,
    %s, %L, %L, %L)$s$, pg_temp.r('g2s'), coalesce(bad.version::text, 'null'), bad.reason, bad.found_by,
    coalesce(quote_literal(bad.found_on::text) || '::date', 'null'), bad.note, bad.key, bad.digest),
  '22023 ORDER_ROUTE_INVALID')
  from (select * from (values
    ('an unknown reason', 1::bigint, 'cannot_do_it', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-input-0001', null),
    ('how B found out, unknown', 1, 'other', 'nobody', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-input-0001', null),
    ('how B found out, missing', 1, 'other', null, pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-input-0001', null),
    ('the day B found out, missing', 1, 'other', 'patient', null, 'The patient says it was not them', 'd17-refuse-input-0001', null),
    ('the day B found out, tomorrow in Lagos', 1, 'other', 'patient', pg_temp.lagos_today() + 1, 'The patient says it was not them', 'd17-refuse-input-0001', null),
    ('the day B found out, before the acceptance day', null, 'other', 'patient', pg_temp.accepted_day('g2s') - 1, 'The patient says it was not them', 'd17-refuse-input-0001', null),
    ('a 7-character note once trimmed', 1, 'other', 'patient', pg_temp.lagos_today(), '   Not him   ', 'd17-refuse-input-0001', null),
    ('a 501-character note', 1, 'other', 'patient', pg_temp.lagos_today(), repeat('x', 501), 'd17-refuse-input-0001', null),
    ('a short key', 1, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'short-key', null),
    ('a bad digest', 1, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-input-0001', 'ABC'),
    ('no version', null, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-input-0001', null),
    ('version 0', 0, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-input-0001', null))
    v(label, version, reason, found_by, found_on, note, key, digest)) bad
 where bad.label <> 'the day B found out, before the acceptance day';
select pg_temp.check('d17 refusal: the day B found out, before the acceptance day', format($s$select * from
    pg_temp.late('lab_request', %L, %s, 'other', 'patient', %L::date, 'The patient says it was not them',
    'd17-refuse-input-0002')$s$, pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s')),
    pg_temp.accepted_day('g2s') - 1), '22023 ORDER_ROUTE_INVALID');
select pg_temp.as_signup_admin(1, 'emergency');
select pg_temp.check('d17 refusal: another purpose', format($s$select * from pg_temp.late('lab_request', %L, %s,
    'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-purpose-01')$s$,
    pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s'))), '42501 Order route staff context is required');
select pg_temp.as_staff(32, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d17 refusal: a receptionist', format($s$select * from pg_temp.late('lab_request', %L, %s,
    'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-rb-000001')$s$,
    pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s'))), '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('d17 refusal: LR (receive only) where a result must be withdrawn, with the permission as DETAIL', pg_temp.outcome_detail(format($s$select * from pg_temp.late(
    'lab_request', %L, %s, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them',
    'd17-refuse-lr-000001')$s$, pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s'))))
  = 'P0001 ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED / lab.result.entered-in-error');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_extra(36, current_setting('hid.test.facility_2')::uuid);
select pg_temp.assert('d17 refusal: PR (receive only) where a dispensing must be reversed, with the permission as DETAIL',
  pg_temp.outcome_detail(format($s$select * from pg_temp.late('prescription', %L, %s, 'other', 'patient',
    pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-pr-000001')$s$, pg_temp.r('rxpr'),
    pg_temp.v(pg_temp.r('rxpr'))))
  = 'P0001 ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED / pharmacy.dispensing.reverse');
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.check('d17 refusal: a lab route through the Pharmacy', format($s$select * from pg_temp.late(
    'prescription', %L, %s, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them',
    'd17-refuse-g2s-rx001')$s$, pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s'))), 'P0002 ORDER_ROUTE_NOT_FOUND');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.check('d17 refusal: GLM, a laboratory member elsewhere', format($s$select * from pg_temp.late(
    'lab_request', %L, %s, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them',
    'd17-refuse-glm-00001')$s$, pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s'))), 'P0002 ORDER_ROUTE_NOT_FOUND');
reset role;
-- The route-access control off: the command, the lookup and H6's
-- capability branch all stop.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c suite pauses route access');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d17 refusal: the control off (the command)', format($s$select * from pg_temp.late('lab_request',
    %L, %s, 'other', 'patient', pg_temp.lagos_today(), 'The patient says it was not them', 'd17-refuse-paused-01')$s$,
    pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s'))), '55000 PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled');
select pg_temp.check('d17 refusal: the control off (the lookup)', format($s$select * from
    lab.find_correctable_order_routes(%L)$s$, pg_temp.ref('g2s')),
  '55000 PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled');
reset role;
insert into ehr.order_route_correction_capabilities (transaction_id, route_id, kind, receiving_facility_id, patient_id,
  membership_id)
values (pg_current_xact_id(), pg_temp.r('g2s'), 'lab_request', current_setting('hid.test.facility_1')::uuid,
  current_setting('hid.test.p')::uuid, current_setting('hid.test.membership_1')::uuid);
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 refusal: the control off, a capability opens nothing',
  not ehr.order_route_access_allows('lab_request', current_setting('hid.test.p')::uuid,
    current_setting('hid.test.facility_1')::uuid, 'read_records'));
delete from ehr.order_route_correction_capabilities;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c suite resumes route access');
reset role;
select pg_temp.assert('d17 refusal: the refusals wrote nothing (apart from the two control changes and their audit rows)',
  (select string_agg(part, ',') from (select part from unnest(string_to_array(pg_temp.footprint17(), ',')) with ordinality p(part, i)
     where i <> 10) parts)
  = (select string_agg(part, ',') from (select part from unnest(string_to_array(current_setting('hid.test.footprint_refusals'),
       ',')) with ordinality p(part, i) where i <> 10) parts),
  pg_temp.footprint17() || ' vs ' || current_setting('hid.test.footprint_refusals'));

-- 5. The late corrections. g2s first (group 2, closed by support), by LB1;
-- then, in the same transaction, LB1 still reads none of P's results and
-- cannot void one by hand.
select pg_temp.snap();
select pg_temp.assert('d17 g2s: before, P''s record shows its result', pg_temp.res('g2s') = any(pg_temp.patient_results()));
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d17 g2s: LB1 corrects it late', format($s$select pg_temp.keep_late('g2s', 'lab_request', %L, %s,
    'someone_elses_details', 'patient', pg_temp.lagos_today(), '  The patient says they never gave a sample here ',
    'd17-late-g2s-0000001')$s$, pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s'))), 'ok');
select pg_temp.assert('d17 g2s: after the command, in the same transaction, LB1 reads none of P''s results',
  pg_temp.results_seen(current_setting('hid.test.p')::uuid) = 0);
select pg_temp.assert('d17 g2s: after the command, a hand-written invalidation is still refused',
  pg_temp.refused(pg_temp.hand_void(pg_temp.res('g1c'))) = 'refused', pg_temp.outcome(pg_temp.hand_void(pg_temp.res('g1c'))));
reset role;
select pg_temp.assert('d17 g2s: T9 is empty after the command', pg_temp.capabilities() = 0);
select pg_temp.assert('d17 g2s: the answer', pg_temp.answer('g2s') = (select jsonb_build_object('result', 'corrected',
    'report_id', report.id, 'route_row_version', route.row_version, 'route_state', 'completed',
    'effective_state', 'completed', 'ended_kind', 'support', 'ended_kind_before', 'support', 'results_voided', 1,
    'result_reports_marked', 1, 'dispensing_reversed', false, 'state_before', 'completed',
    'correctable_until', route.accepted_at + interval '4320 hours', 'patient_id', route.patient_id)
    from ehr.order_routes route join ehr.order_route_wrong_patient_reports report on report.route_id = route.id
   where route.id = pg_temp.r('g2s')), pg_temp.answer('g2s')::text);
do $$
declare
  r ehr.order_routes%rowtype := pg_temp.route(pg_temp.r('g2s'));
  report record;
begin
  select * into report from ehr.order_route_wrong_patient_reports candidate where candidate.route_id = r.id;
  perform pg_temp.assert('d17 g2s: v1 invalidated by LB1 with the late reason and item 3''s key, its outbox row',
    exists (select 1 from lab.result_invalidations invalidation
             where invalidation.result_id = pg_temp.res('g2s') and invalidation.result_version = 1
               and invalidation.actor_membership_id = current_setting('hid.test.membership_1')::uuid
               and invalidation.reason = 'Accepted for someone who is not this order''s patient: not this patient''s '
                 || 'result (reported after the order ended)'
               and invalidation.idempotency_key = 'wrong-patient:' || r.id || ':' || pg_temp.res('g2s')
               and invalidation.request_sha256 = encode(sha256('d17-late-g2s-0000001'::bytea), 'hex'))
    and exists (select 1 from lab.outbox_events outbox where outbox.event_type = 'LabResultEnteredInError'
                 and outbox.aggregate_id = pg_temp.res('g2s') and outbox.aggregate_version = 1
                 and outbox.patient_id = r.patient_id and outbox.facility_id = r.receiving_facility_id));
  perform pg_temp.assert('d17 g2s: A holds released v1 and its entered-in-error report; the ending (support) kept; '
      || 'the last event the trigger''s result_marked_in_error',
    (select array_agg(report_row.kind || ':' || report_row.result_version order by report_row.recorded_at, report_row.id)
       from lab.order_route_result_reports report_row where report_row.route_id = r.id)
      = array['released:1', 'entered_in_error:1']
    and r.state = 'completed' and r.ended_kind = 'support'
    and (pg_temp.last_event(r.id)).event_type = 'result_marked_in_error', row_to_json(r)::text);
  perform pg_temp.assert('d17 g2s: the report row (late, the ending before, how and when B found out, the note '
      || 'trimmed, who recorded the work)',
    report.late and report.ended_kind_before = 'support' and report.discovered_by = 'patient'
    and report.discovered_on = pg_temp.lagos_today() and report.state_before = 'completed'
    and report.reason_code = 'someone_elses_details' and report.note = 'The patient says they never gave a sample here'
    and report.results_voided = 1 and report.result_reports_marked = 1 and not report.dispensing_reversed
    and report.reported_by_membership_id = current_setting('hid.test.membership_1')::uuid
    and report.accepted_with = 'health_id' and report.reporter_recorded_work and report.specimens_collected = 1
    and report.recorded_by_membership_ids @> array[current_setting('hid.test.membership_1')::uuid,
      'e4c13000-0000-4000-8000-000000000031'::uuid]
    and report.reviewed_at is null and report.row_version = 1, row_to_json(report)::text);
  perform pg_temp.assert('d17 g2s: P''s record no longer shows its result', not pg_temp.res('g2s') = any(pg_temp.patient_results()));
  perform pg_temp.assert('d17 g2s: a system row at A and at B with the patient and the late details (never the note)',
    (select count(*) from audit.events event where event.action = 'ehr.order-route.wrong-patient'
      and event.resource_id = r.id::text and event.patient_id = r.patient_id
      and event.facility_id in (r.ordering_facility_id, r.receiving_facility_id)
      and event.details = jsonb_build_object('routeId', r.id, 'kind', 'lab_request', 'state', 'completed',
        'reason', 'someone_elses_details', 'stateBefore', 'completed', 'resultsVoided', 1, 'dispensingReversed', false,
        'late', true, 'endedKindBefore', 'support', 'discoveredBy', 'patient', 'discoveredOn', pg_temp.lagos_today()))
    = 2
    and not exists (select 1 from audit.events event where event.resource_id = r.id::text
                     and event.details::text like '%never gave a sample%'));
  perform pg_temp.assert('d17 g2s: P''s inbox notice ORDER_ROUTE_WRONG_PATIENT_CORRECTED (the order had ended)',
    exists (select 1 from notification.inbox_items item
             where item.patient_id = r.patient_id and item.notification_code = 'ORDER_ROUTE_WRONG_PATIENT_CORRECTED'
               and item.resource_type = 'order-route' and item.resource_id = r.id
               and item.metadata = jsonb_build_object('routeId', r.id, 'kind', 'lab_request',
                 'orderingFacilityName', 'P4c General Hospital', 'receivingFacilityName',
                 (select facility.name from identity.facilities facility where facility.id = r.receiving_facility_id))));
end $$;

-- Every other route of the table, by the member named: LB1 g1c, g2e, g2o;
-- LB2 g1a, g2r, v12, v2u; LB3 (P's consent) g2oc; LR (receive only;
-- nothing to withdraw) g2ec, g2sc, g2orc, g2rrc; PB2 rx2s, rxrev; PR (nothing
-- to reverse) rx1a; PB1 rx1c.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d17 ' || late.name || ': corrected late', format($s$select pg_temp.keep_late(%L, 'lab_request', %L,
    %s, %L, %L, %L::date, 'Reported after the order had ended', %L)$s$, late.name, pg_temp.r(late.name),
    pg_temp.v(pg_temp.r(late.name)), late.reason, late.found_by, late.found_on, 'd17-late-' || late.name || '-000001'),
  'ok')
  from (values ('g1c', 'suspected_misuse', 'ordering_facility', pg_temp.accepted_day('g1c')),
               ('g2e', 'other', 'own_check', pg_temp.lagos_today()),
               ('g2o', 'wrong_order_chosen', 'support', pg_temp.lagos_today())) late(name, reason, found_by, found_on);
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d17 ' || late.name || ': corrected late', format($s$select pg_temp.keep_late(%L, 'lab_request', %L,
    %s, %L, %L, %L::date, 'Reported after the order had ended', %L)$s$, late.name, pg_temp.r(late.name),
    pg_temp.v(pg_temp.r(late.name)), late.reason, late.found_by, late.found_on, 'd17-late-' || late.name || '-000001'),
  'ok')
  from (values ('g1a', 'wrong_order_chosen', 'own_check', pg_temp.lagos_today()),
               ('g2r', 'someone_elses_details', 'other', pg_temp.lagos_today()),
               ('v12', 'someone_elses_details', 'patient', pg_temp.lagos_today()),
               ('v2u', 'other', 'ordering_facility', pg_temp.lagos_today())) late(name, reason, found_by, found_on);
select pg_temp.as_extra(34, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d17 g2oc: corrected late by LB3', format($s$select pg_temp.keep_late('g2oc', 'lab_request', %L, %s,
    'wrong_order_chosen', 'own_check', pg_temp.lagos_today(), 'Reported after the order had ended',
    'd17-late-g2oc-000001')$s$, pg_temp.r('g2oc'), pg_temp.v(pg_temp.r('g2oc'))), 'ok');
select pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d17 ' || late.name || ': corrected late by LR', format($s$select pg_temp.keep_late(%L, 'lab_request',
    %L, %s, %L, %L, pg_temp.lagos_today(), 'Reported after the order had ended', %L)$s$, late.name,
    pg_temp.r(late.name), pg_temp.v(pg_temp.r(late.name)), late.reason, late.found_by,
    'd17-late-' || late.name || '-000001'), 'ok')
  from (values ('g2ec', 'suspected_misuse', 'ordering_facility'), ('g2sc', 'other', 'support'),
               ('g2orc', 'wrong_order_chosen', 'own_check'), ('g2rrc', 'someone_elses_details', 'patient'))
       late(name, reason, found_by);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.check('d17 ' || late.name || ': corrected late by PB2', format($s$select pg_temp.keep_late(%L,
    'prescription', %L, %s, %L, %L, pg_temp.lagos_today(), 'Reported after the order had ended', %L)$s$, late.name,
    pg_temp.r(late.name), pg_temp.v(pg_temp.r(late.name)), late.reason, late.found_by,
    'd17-late-' || late.name || '-000001'), 'ok')
  from (values ('rx2s', 'someone_elses_details', 'patient'), ('rxrev', 'other', 'own_check')) late(name, reason, found_by);
select pg_temp.as_extra(36, current_setting('hid.test.facility_2')::uuid);
select pg_temp.check('d17 rx1a: corrected late by PR', format($s$select pg_temp.keep_late('rx1a', 'prescription', %L, %s,
    'wrong_order_chosen', 'own_check', pg_temp.lagos_today(), 'Reported after the order had ended',
    'd17-late-rx1a-000001')$s$, pg_temp.r('rx1a'), pg_temp.v(pg_temp.r('rx1a'))), 'ok');
select pg_temp.as_signup_admin(2);
select pg_temp.check('d17 rx1c: corrected late by PB1', format($s$select pg_temp.keep_late('rx1c', 'prescription', %L, %s,
    'suspected_misuse', 'patient', pg_temp.lagos_today(), 'Reported after the order had ended',
    'd17-late-rx1c-000001')$s$, pg_temp.r('rx1c'), pg_temp.v(pg_temp.r('rx1c'))), 'ok');
reset role;
select pg_temp.assert('d17: every route of the table afterwards (state, ending) and its report (state and ending '
    || 'before, voided, marked at A, reversed), group 1 ending wrong_patient now, group 2 keeping its ending',
  (select array_agg(format('%s:%s:%s|%s:%s|%s:%s:%s|%s', name, route.state, route.ended_kind, report.state_before,
       coalesce(report.ended_kind_before, '-'), report.results_voided, report.result_reports_marked,
       report.dispensing_reversed, report.late) order by position)
     from unnest(array['g2s', 'g1c', 'g1a', 'g2e', 'g2o', 'g2r', 'v12', 'v2u', 'g2oc', 'g2ec', 'g2sc', 'g2orc', 'g2rrc',
       'rx2s', 'rx1a', 'rxrev', 'rx1c']) with ordinality listed(name, position)
     join ehr.order_routes route on route.id = pg_temp.r(listed.name)
     join ehr.order_route_wrong_patient_reports report on report.route_id = route.id)
  = array['g2s:completed:support|completed:support|1:1:f|t',
    'g1c:completed:wrong_patient|completed:-|1:1:f|t',
    'g1a:cancelled:wrong_patient|accepted:-|1:0:f|t',
    'g2e:completed:entered_in_error|completed:entered_in_error|1:1:f|t',
    'g2o:completed:ordering_released|completed:ordering_released|1:1:f|t',
    'g2r:completed:receiving_released|completed:receiving_released|1:1:f|t',
    'v12:completed:support|completed:support|1:2:f|t',
    'v2u:completed:support|completed:support|1:1:f|t',
    'g2oc:cancelled:order_changed|cancelled:order_changed|1:0:f|t',
    'g2ec:cancelled:entered_in_error|cancelled:entered_in_error|0:0:f|t',
    'g2sc:cancelled:support|cancelled:support|0:0:f|t',
    'g2orc:cancelled:ordering_released|cancelled:ordering_released|0:0:f|t',
    'g2rrc:cancelled:receiving_released|cancelled:receiving_released|0:0:f|t',
    'rx2s:completed:support|completed:support|0:0:t|t',
    'rx1a:cancelled:wrong_patient|accepted:-|0:0:f|t',
    'rxrev:completed:wrong_patient|completed:-|0:0:f|t',
    'rx1c:completed:wrong_patient|completed:-|0:0:t|t'],
  (select string_agg(format('%s:%s:%s|%s:%s|%s:%s:%s|%s', name, route.state, route.ended_kind, report.state_before,
       coalesce(report.ended_kind_before, '-'), report.results_voided, report.result_reports_marked,
       report.dispensing_reversed, report.late), ', ' order by position)
     from unnest(array['g2s', 'g1c', 'g1a', 'g2e', 'g2o', 'g2r', 'v12', 'v2u', 'g2oc', 'g2ec', 'g2sc', 'g2orc', 'g2rrc',
       'rx2s', 'rx1a', 'rxrev', 'rx1c']) with ordinality listed(name, position)
     join ehr.order_routes route on route.id = pg_temp.r(listed.name)
     left join ehr.order_route_wrong_patient_reports report on report.route_id = route.id));
select pg_temp.assert('d17: each answer matches its route and report',
  not exists (
    select 1 from p4c_answers answer
      join ehr.order_routes route on route.id = pg_temp.r(answer.label)
      join ehr.order_route_wrong_patient_reports report on report.route_id = route.id
     where answer.label in ('g1c', 'g1a', 'g2e', 'g2o', 'g2r', 'v12', 'v2u', 'g2oc', 'g2ec', 'g2sc', 'g2orc', 'g2rrc',
             'rx2s', 'rx1a', 'rxrev', 'rx1c')
       and answer.answer is distinct from jsonb_build_object('result', 'corrected', 'report_id', report.id,
         'route_row_version', route.row_version, 'route_state', route.state,
         'effective_state', ehr.order_route_effective_state(route), 'ended_kind', route.ended_kind,
         'ended_kind_before', report.ended_kind_before, 'results_voided', report.results_voided,
         'result_reports_marked', report.result_reports_marked, 'dispensing_reversed', report.dispensing_reversed,
         'state_before', report.state_before, 'correctable_until', route.accepted_at + interval '4320 hours',
         'patient_id', route.patient_id)));
select pg_temp.assert('d17 group 1: g1c''s window ends now with access_ended (wrong_patient), g1a''s with cancelled; '
    || 'both windows at the ending',
  (pg_temp.last_event(pg_temp.r('g1c'))).event_type = 'access_ended'
  and (pg_temp.last_event(pg_temp.r('g1c'))).reason_code = 'wrong_patient'
  and (pg_temp.last_event(pg_temp.r('g1a'))).event_type = 'cancelled'
  and (pg_temp.last_event(pg_temp.r('g1a'))).reason_code = 'wrong_patient'
  and (select bool_and(route.writes_end_at <= route.ended_at and route.access_ends_at <= route.ended_at)
         from ehr.order_routes route where route.id in (pg_temp.r('g1c'), pg_temp.r('g1a'))));
select pg_temp.assert('d17 v12: v2 invalidated (A''s report by the trigger), v1 reported directly with its released '
    || 'fields, one batch event and one batch row at A',
  (select array_agg(invalidation.result_version order by invalidation.result_version) from lab.result_invalidations invalidation
    where invalidation.result_id = pg_temp.res('v12')) = array[2::bigint]
  and (select array_agg(report_row.kind || ':' || report_row.result_version order by report_row.kind, report_row.result_version)
         from lab.order_route_result_reports report_row where report_row.route_id = pg_temp.r('v12'))
    = array['entered_in_error:1', 'entered_in_error:2', 'released:1', 'released:2']
  and (select count(*) from ehr.order_route_events event where event.route_id = pg_temp.r('v12')
        and event.event_type = 'result_marked_in_error' and event.reason_code = 'wrong_patient') = 1
  and (select count(*) from audit.events event where event.action = 'ehr.order-route.result-marked-in-error'
        and event.resource_id = pg_temp.r('v12')::text and event.details ->> 'reportsMarked' = '1'
        and event.details ->> 'reason' = 'wrong_patient') = 1);
select pg_temp.assert('d17 v2u: v2 (verified, not released) invalidated, v1 reported directly',
  (select array_agg(invalidation.result_version) from lab.result_invalidations invalidation
    where invalidation.result_id = pg_temp.res('v2u')) = array[2::bigint]
  and (select array_agg(report_row.kind || ':' || report_row.result_version order by report_row.kind)
         from lab.order_route_result_reports report_row where report_row.route_id = pg_temp.r('v2u'))
    = array['entered_in_error:1', 'released:1']);
select pg_temp.assert('d17 cancelled routes: g1a''s and g2oc''s unreleased results invalidated, nothing reported at A; '
    || 'the reporter''s facts',
  (select count(*) from lab.result_invalidations invalidation
    where invalidation.result_id in (pg_temp.res('g1a'), pg_temp.res('g2oc'))) = 2
  and not exists (select 1 from lab.order_route_result_reports report_row
                   where report_row.route_id in (pg_temp.r('g1a'), pg_temp.r('g2oc'), pg_temp.r('g2ec')))
  and (select report.reporter_recorded_work and report.specimens_collected = 1
       from ehr.order_route_wrong_patient_reports report where report.route_id = pg_temp.r('g1a'))
  and (select not report.reporter_recorded_work and report.recorded_by_membership_ids = array[]::uuid[]
         and report.reported_by_membership_id = 'e4c13000-0000-4000-8000-000000000035'
       from ehr.order_route_wrong_patient_reports report where report.route_id = pg_temp.r('g2sc')));
select pg_temp.assert('d17 pharmacy: rx2s and rx1c reversed once (A''s report), rxrev not reversed again but reported, '
    || 'rx1a nothing',
  (select array_agg(report_row.kind order by report_row.recorded_at) from pharmacy.order_route_dispensing_reports report_row
    where report_row.route_id = pg_temp.r('rx2s')) = array['dispensed', 'reversed']
  and (select array_agg(report_row.kind order by report_row.recorded_at) from pharmacy.order_route_dispensing_reports report_row
    where report_row.route_id = pg_temp.r('rx1c')) = array['dispensed', 'reversed']
  and (select count(*) from pharmacy.dispensing_reversals reversal
        where reversal.dispensing_id = current_setting('hid.test.dispensing_rxrev')::uuid) = 1
  and (select reversal.reason = 'Dispensed to someone who is not this prescription''s patient (wrong-patient report after '
           || 'the order ended)' and reversal.idempotency_key = 'wrong-patient:' || pg_temp.r('rx2s')
         and reversal.reversed_by_membership_id = 'e4c13000-0000-4000-8000-000000000033'
       from pharmacy.dispensing_reversals reversal
      where reversal.dispensing_id = current_setting('hid.test.dispensing_rx2s')::uuid)
  and (select count(*) from pharmacy.outbox_events outbox where outbox.event_type = 'MedicationDispensingReversed'
        and outbox.payload ->> 'dispensingId' in (current_setting('hid.test.dispensing_rx2s'),
          current_setting('hid.test.dispensing_rx1c'))) = 2
  and not exists (select 1 from pharmacy.order_route_dispensing_reports report_row where report_row.route_id = pg_temp.r('rx1a')));
select pg_temp.assert('d17: P''s notices: CORRECTED for the routes that had ended, WRONG_PATIENT for those that end now '
    || '(and item 3''s); R''s routes had ended',
  (select count(*) from notification.inbox_items item where item.patient_id = current_setting('hid.test.p')::uuid
    and item.notification_code = 'ORDER_ROUTE_WRONG_PATIENT_CORRECTED') = 7
  and (select array_agg(item.resource_id order by item.resource_id) from notification.inbox_items item
        where item.patient_id = current_setting('hid.test.p')::uuid
          and item.notification_code = 'ORDER_ROUTE_WRONG_PATIENT')
      = (select array_agg(id order by id) from unnest(array[pg_temp.r('g1c'), pg_temp.r('g1a'), pg_temp.r('rx1a'),
          pg_temp.r('rxrev'), pg_temp.r('rx1c'), pg_temp.r('rep')]) id)
  and (select array_agg(item.notification_code || ':' || item.resource_id order by item.resource_id)
         from notification.inbox_items item where item.patient_id = current_setting('hid.test.n')::uuid
          and item.notification_code like 'ORDER_ROUTE_WRONG_PATIENT%')
      = (select array_agg('ORDER_ROUTE_WRONG_PATIENT_CORRECTED:' || id order by id) from unnest(array[pg_temp.r('g2oc'),
          pg_temp.r('g2ec'), pg_temp.r('g2sc'), pg_temp.r('g2orc'), pg_temp.r('g2rrc')]) id));
select pg_temp.assert('d17: two system rows (A and B) per late report, with late', (select count(*) from audit.events event
  where event.action = 'ehr.order-route.wrong-patient' and event.details ->> 'late' = 'true') = 34);
select pg_temp.assert('d17: T9 is empty after every correction', pg_temp.capabilities() = 0);
select pg_temp.assert('d17: P''s record shows none of the corrected results, still old''s (too late)',
  not (pg_temp.patient_results() && array[pg_temp.res('g2s'), pg_temp.res('g1c'), pg_temp.res('g2e'), pg_temp.res('g2o'),
    pg_temp.res('g2r'), pg_temp.res('v12'), pg_temp.res('v2u')])
  and pg_temp.res('old') = any(pg_temp.patient_results()));

-- 6. After a late report. A release under P's consent at L1 (LB3) of g2s's
-- next version is refused; a write on its items is closed, a read none.
select set_config('hid.test.g2s_verification_2', pg_temp.lab_next_version(pg_temp.res('g2s'), 'd17g2s', 12.0,
  current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_extra(34, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d17 after: a release under P''s consent of g2s''s next version', format($s$select pg_temp.release(%L,
    2, %L, 'd17-release-after-g2s')$s$, pg_temp.res('g2s'), current_setting('hid.test.g2s_verification_2')),
  '23514 ORDER_ROUTE_CLOSED');
select pg_temp.assert('d17 after: LB3''s item access on g2s''s result: write closed, read none',
  (select access.outcome from lab.order_route_access_for('result', pg_temp.res('g2s'), 'write_records') access) = 'closed'
  and (select access.outcome from lab.order_route_access_for('result', pg_temp.res('g2s'), 'read_records') access) = 'none');
reset role;
select pg_temp.snap();
select set_config('hid.test.footprint_after', pg_temp.footprint17(), true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 after: the lookup answers g2s reported (late), without details',
  pg_temp.look('g2s-after', 'lab_request', pg_temp.ref('g2s')) = 1);
select pg_temp.check('d17 after: the same key and request answer replayed', format($s$select pg_temp.keep_late('g2s-replay',
    'lab_request', %L, %s, 'someone_elses_details', 'patient', pg_temp.lagos_today(),
    'The patient says they never gave a sample here', 'd17-late-g2s-0000001')$s$, pg_temp.r('g2s'),
    pg_temp.v(pg_temp.r('g2s'))), 'ok');
select pg_temp.check('d17 after: another key on g2s', format($s$select * from pg_temp.late('lab_request', %L, %s, 'other',
    'own_check', pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-late-g2s-0000099')$s$,
    pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s'))), 'P0001 ORDER_ROUTE_ALREADY_REPORTED');
select pg_temp.check('d17 after: g2s''s key with another request', format($s$select * from pg_temp.late('lab_request', %L,
    %s, 'other', 'patient', pg_temp.lagos_today(), 'The patient says they never gave a sample here',
    'd17-late-g2s-0000001', repeat('9', 64))$s$, pg_temp.r('g2s'), pg_temp.v(pg_temp.r('g2s'))),
  'P0001 IDEMPOTENCY_KEY_REUSED');
select pg_temp.check('d17 after: g2s''s key on another route', format($s$select * from pg_temp.late('lab_request', %L, %s,
    'someone_elses_details', 'patient', pg_temp.lagos_today(), 'The patient says they never gave a sample here',
    'd17-late-g2s-0000001')$s$, pg_temp.r('lima'), pg_temp.v(pg_temp.r('lima'))), 'P0001 IDEMPOTENCY_KEY_REUSED');
select pg_temp.check('d17 after: the key of an in-window report (item 3''s, rep), even with its digest',
  format($s$select * from pg_temp.late('lab_request', %L, %s, 'wrong_order_chosen', 'patient', pg_temp.lagos_today(),
    'Picked the wrong row at the counter', 'd17-inwindow-rep-0001')$s$, pg_temp.r('rep'), pg_temp.v(pg_temp.r('rep'))),
  'P0001 IDEMPOTENCY_KEY_REUSED');
reset role;
select pg_temp.assert('d17 after: the replay''s answer (the route as it is now, the first report''s counts)',
  pg_temp.answer('g2s-replay') = (pg_temp.answer('g2s') || jsonb_build_object('result', 'replayed',
    'route_row_version', (pg_temp.route(pg_temp.r('g2s'))).row_version)));
select pg_temp.assert('d17 after: the lookup''s row for g2s now', pg_temp.found('g2s-after') ->> 'correction_state' = 'reported'
  and (pg_temp.found('g2s-after') ->> 'report_late')::boolean
  and (pg_temp.found('g2s-after') ->> 'reported_at')::timestamptz = (select report.reported_at
        from ehr.order_route_wrong_patient_reports report where report.route_id = pg_temp.r('g2s'))
  and pg_temp.found('g2s-after') -> 'what_name' = 'null'::jsonb
  and pg_temp.found('g2s-after') -> 'returned_items' = 'null'::jsonb);
select pg_temp.assert('d17 after: replays and refusals wrote nothing; T9 empty',
  pg_temp.footprint17() = current_setting('hid.test.footprint_after'), pg_temp.footprint17());

-- 7. Item 3's command unchanged: opa (open) is reported by C25 with the id
-- and version the lookup gave.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d17 C25: opa reported in its window with the lookup''s id and version',
  format($s$select pg_temp.keep('opa', 'lab_request', %L, %s, 'someone_elses_details',
    'The person gave a Health ID that was not theirs', 'd17-inwindow-opa-0001')$s$,
    pg_temp.found('opa') ->> 'route_id', pg_temp.found('opa') ->> 'row_version'), 'ok');
select pg_temp.assert('d17 C25: the lookup now answers opa reported, not late',
  pg_temp.look('opa-after', 'lab_request', pg_temp.ref('opa')) = 1
  and pg_temp.found('opa-after') ->> 'correction_state' = 'reported'
  and pg_temp.found('opa-after') ->> 'report_late' = 'false');
reset role;
select pg_temp.assert('d17 C25: its answer and row as item 3 writes them (late false, the new columns null)',
  pg_temp.answer('opa') ->> 'result' = 'ended' and pg_temp.answer('opa') ->> 'route_state' = 'cancelled'
  and (select not report.late and report.ended_kind_before is null and report.discovered_by is null
         and report.discovered_on is null and report.state_before = 'accepted'
       from ehr.order_route_wrong_patient_reports report where report.route_id = pg_temp.r('opa')));

-- 8. The readers. The order summary computes its two keys inline; on every
-- route of the suite they agree with the helpers (MG1).
select pg_temp.assert('d17 readers: on every route the summary''s correctableUntil is set exactly while the route is '
    || 'open or correctable, equal to ehr.order_route_correctable_until, and wrongPatient exactly when reported',
  not exists (
    select 1 from ehr.order_routes route
     cross join lateral (select ehr.order_route_summary(route, false) as summary,
                                ehr.order_route_correction_state(route) as correction) checked
     where ((checked.summary ->> 'correctableUntil') is not null) <> (checked.correction in ('open', 'correctable'))
        or (checked.summary ->> 'correctableUntil')::timestamptz is distinct from
           case when checked.correction in ('open', 'correctable') then ehr.order_route_correctable_until(route) end
        or (checked.summary -> 'wrongPatient' <> 'null'::jsonb)
           <> exists (select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = route.id)
        or (checked.summary -> 'wrongPatient' <> 'null'::jsonb and checked.summary -> 'wrongPatient'
           <> (select jsonb_build_object('reportedAt', report.reported_at, 'late', report.late)
                 from ehr.order_route_wrong_patient_reports report where report.route_id = route.id)))
  and (select count(*) from ehr.order_routes) = 33
  and (select count(distinct ehr.order_route_correction_state(route)) from ehr.order_routes route) = 5);
-- The answers as the runtimes give them, kept for the owner's checks.
create temp table d17_out (n serial primary key, label text not null, answer jsonb not null);
grant select, insert on d17_out to hid_ehr_api_runtime, hid_identity_api_runtime;
grant usage on sequence d17_out_n_seq to hid_ehr_api_runtime, hid_identity_api_runtime;
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
insert into d17_out (label, answer)
select 'c3-' || name, to_jsonb(listed)
  from unnest(array['g2s', 'lima']) name
  cross join lateral ehr.list_order_routes_for_order('lab_request', current_setting('hid.test.p')::uuid,
    pg_temp.o(name)) listed;
insert into d17_out (label, answer)
select 'c4', summary.summary from ehr.order_route_summaries('lab_request', current_setting('hid.test.p')::uuid,
  array[pg_temp.o('lima'), pg_temp.o('g2s'), pg_temp.o('old'), pg_temp.o('rep')]) summary;
insert into d17_out (label, answer) select 'c28', ehr.list_sent_wrong_patient_order_routes();
select pg_temp.as_patient(1);
insert into d17_out (label, answer) select 'c5', to_jsonb(listed) from ehr.patient_list_order_routes() listed;
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(2);
insert into d17_out (label, answer)
select 'c21-' || name, to_jsonb(found)
  from unnest(array['g2s', 'lima', 'old', 'snt', 'opc']) name
  cross join lateral identity.admin_find_order_routes(case name when 'old' then lower(pg_temp.ref(name))
    else pg_temp.ref(name) end, null) found;
reset role;
-- How often C21 and C30 run the two helpers (function statistics, this
-- transaction): once per row returned, never once per reference to the
-- lateral column, nor for routes the limit drops.
set local track_functions = 'all';
create function pg_temp.helper_calls() returns integer[] language sql volatile as $f$
  select array[coalesce(pg_stat_get_xact_function_calls('ehr.order_route_effective_state(ehr.order_routes)'::regprocedure), 0),
    coalesce(pg_stat_get_xact_function_calls('ehr.order_route_correction_state(ehr.order_routes)'::regprocedure), 0)]::integer[]
$f$;
select set_config('hid.test.calls_before_c21', pg_temp.helper_calls()::text, true);
set local role hid_identity_api_runtime;
select pg_temp.as_platform(2);
insert into d17_out (label, answer)
select 'c21-p', to_jsonb(found) from identity.admin_find_order_routes(null, 'HID-P4CPATP') found;
reset role;
select set_config('hid.test.calls_after_c21', pg_temp.helper_calls()::text, true);
-- Three more routes of P (copies of lima, owner SQL, triggers off; removed
-- below), so that the Health ID lookup's limit of 20 drops two of 22.
select pg_temp.copy_route(pg_temp.r('lima'), jsonb_build_object('id', gen_random_uuid(),
    'idempotency_key', 'd17-limit-copy-' || copy || '-' || gen_random_uuid(), 'source_lab_request_id', gen_random_uuid()))
  from generate_series(1, 3) copy;
select set_config('hid.test.calls_before_limit', pg_temp.helper_calls()::text, true);
set local role hid_identity_api_runtime;
select pg_temp.as_platform(2);
select set_config('hid.test.c21_limit_rows', (select count(*) from identity.admin_find_order_routes(null, 'HID-P4CPATP'))::text,
  true);
reset role;
select set_config('hid.test.calls_after_limit', pg_temp.helper_calls()::text, true);
set local session_replication_role = replica;
delete from ehr.order_routes route where route.idempotency_key like 'd17-limit-copy-%';
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select set_config('hid.test.c30_rows', (select count(*) from lab.find_correctable_order_routes(pg_temp.ref('dup1')))::text,
  true);
reset role;
select pg_temp.assert('d17 readers: C21 by Health ID runs each helper once per row it returns, also when its limit '
    || 'drops routes; C30 likewise (function statistics)',
  current_setting('hid.test.calls_after_c21')::integer[]
    = array[(current_setting('hid.test.calls_before_c21')::integer[])[1] + 19,
            (current_setting('hid.test.calls_before_c21')::integer[])[2] + 19]
  and current_setting('hid.test.c21_limit_rows')::integer = 20
  and current_setting('hid.test.calls_after_limit')::integer[]
    = array[(current_setting('hid.test.calls_before_limit')::integer[])[1] + 20,
            (current_setting('hid.test.calls_before_limit')::integer[])[2] + 20]
  and current_setting('hid.test.c30_rows')::integer = 2
  and pg_temp.helper_calls() = array[(current_setting('hid.test.calls_after_limit')::integer[])[1] + 2,
            (current_setting('hid.test.calls_after_limit')::integer[])[2] + 2],
  concat_ws(' ', current_setting('hid.test.calls_before_c21'), current_setting('hid.test.calls_after_c21'),
    current_setting('hid.test.calls_before_limit'), current_setting('hid.test.calls_after_limit'),
    pg_temp.helper_calls()::text, current_setting('hid.test.c21_limit_rows'), current_setting('hid.test.c30_rows')));
create function pg_temp.out(wanted text, route_key text, route uuid) returns jsonb language sql stable as $f$
  select out_row.answer from d17_out out_row where out_row.label = wanted and (out_row.answer ->> route_key)::uuid = route
$f$;
select pg_temp.assert('d17 readers: C3 gives A g2s with wrongPatient (late), no deadline, and both result rows; lima '
    || 'with the deadline and no report; C4 likewise',
  (select (answer -> 'summary' -> 'wrongPatient' ->> 'late')::boolean and answer -> 'summary' ->> 'endedKind' = 'support'
     and answer -> 'summary' -> 'correctableUntil' = 'null'::jsonb
     and (select array_agg((item ->> 'kind') || ':' || (item ->> 'resultVersion')) from jsonb_array_elements(answer -> 'reports') item)
       = array['released:1', 'entered_in_error:1']
   from d17_out where label = 'c3-g2s')
  and (select answer -> 'summary' -> 'wrongPatient' = 'null'::jsonb
         and (answer -> 'summary' ->> 'correctableUntil')::timestamptz
           = (pg_temp.route(pg_temp.r('lima'))).accepted_at + interval '4320 hours'
       from d17_out where label = 'c3-lima')
  and (select count(*) filter (where answer ->> 'correctableUntil' is not null) = 1
         and count(*) filter (where answer -> 'wrongPatient' <> 'null'::jsonb) = 2 and count(*) = 4
       from d17_out where label = 'c4'),
  (select string_agg(label || ' ' || answer::text, E'\n') from d17_out where label in ('c3-g2s', 'c3-lima', 'c4')));
select pg_temp.assert('d17 readers: C28 lists every report sent from GH in 30 days to DA, the sender, newest report '
    || 'first, with reportedAt, late and endedKindBefore; a group-2 item keeps its earlier endedAt',
  (select jsonb_array_length(answer -> 'items') = 19 and (answer -> 'others' ->> 'count')::integer = 0
     from d17_out where label = 'c28')
  and (select array_agg((item ->> 'routeId')::uuid order by ordinal)
         from d17_out, jsonb_array_elements(answer -> 'items') with ordinality listed(item, ordinal) where label = 'c28')
      = (select array_agg(report.route_id order by report.reported_at desc, report.route_id)
           from ehr.order_route_wrong_patient_reports report)
  and (select item ->> 'late' = 'true' and item ->> 'endedKindBefore' = 'support'
         and (item ->> 'reportedAt')::timestamptz = report.reported_at and (item ->> 'endedAt')::timestamptz = route.ended_at
         and route.ended_at < report.reported_at and (item ->> 'resultsWithdrawn')::integer = 1
       from d17_out, jsonb_array_elements(answer -> 'items') item
       join ehr.order_route_wrong_patient_reports report on report.route_id = (item ->> 'routeId')::uuid
       join ehr.order_routes route on route.id = report.route_id
      where label = 'c28' and report.route_id = pg_temp.r('g2s'))
  and (select item ->> 'late' = 'false' and item -> 'endedKindBefore' = 'null'::jsonb
       from d17_out, jsonb_array_elements(answer -> 'items') item
      where label = 'c28' and (item ->> 'routeId')::uuid = pg_temp.r('rep')));
select pg_temp.assert('d17 readers: C5 tells P when B reported and whether late, and the deadline only while B may act',
  (select (answer ->> 'wrong_patient_late')::boolean and answer ->> 'wrong_patient_reported_at' is not null
     and answer -> 'correctable_until' = 'null'::jsonb
   from d17_out where label = 'c5' and (answer ->> 'route_id')::uuid = pg_temp.r('g2s'))
  and (select not (answer ->> 'wrong_patient_late')::boolean and answer -> 'correctable_until' = 'null'::jsonb
       from d17_out where label = 'c5' and (answer ->> 'route_id')::uuid = pg_temp.r('rep'))
  and (select answer -> 'wrong_patient_reported_at' = 'null'::jsonb and answer -> 'wrong_patient_late' = 'null'::jsonb
         and (answer ->> 'correctable_until')::timestamptz
           = (pg_temp.route(pg_temp.r('lima'))).accepted_at + interval '4320 hours'
       from d17_out where label = 'c5' and (answer ->> 'route_id')::uuid = pg_temp.r('lima'))
  and (select answer -> 'correctable_until' = 'null'::jsonb and answer -> 'wrong_patient_late' = 'null'::jsonb
       from d17_out where label = 'c5' and (answer ->> 'route_id')::uuid = pg_temp.r('old'))
  and (select (answer ->> 'wrong_patient_late')::boolean and (answer ->> 'entered_in_error')::boolean
         and answer -> 'content' = jsonb_build_object('reference', pg_temp.ref('g2e'))
       from d17_out where label = 'c5' and (answer ->> 'route_id')::uuid = pg_temp.r('g2e')));
select pg_temp.assert('d17 readers: C21 by reference: the correction state, the deadline (also once past it), the report',
  (select answer ->> 'correction' = 'reported' and answer -> 'correctable_until' = 'null'::jsonb
     and (answer ->> 'wrong_patient_late')::boolean and answer ->> 'wrong_patient_reported_at' is not null
     and not (answer ->> 'closable')::boolean
   from d17_out where label = 'c21-g2s')
  and (select answer ->> 'correction' = 'correctable' and answer -> 'wrong_patient_late' = 'null'::jsonb
         and (answer ->> 'correctable_until')::timestamptz
           = (pg_temp.route(pg_temp.r('lima'))).accepted_at + interval '4320 hours'
       from d17_out where label = 'c21-lima')
  and (select answer ->> 'correction' = 'too_late'
         and (answer ->> 'correctable_until')::timestamptz
           = (pg_temp.route(pg_temp.r('old'))).accepted_at + interval '4320 hours'
       from d17_out where label = 'c21-old')
  and (select answer ->> 'correction' = 'not_accepted' and answer -> 'correctable_until' = 'null'::jsonb
       from d17_out where label = 'c21-snt')
  and (select answer ->> 'correction' = 'open' and answer ->> 'correctable_until' is not null
       from d17_out where label = 'c21-opc')
  and (select count(*) from d17_out where label = 'c21-p') = 19
  and not exists (select 1 from d17_out
                   where label = 'c21-p'
                     and answer ->> 'correction'
                       is distinct from ehr.order_route_correction_state(pg_temp.route((answer ->> 'route_id')::uuid)))
  and (select count(*) from d17_out where label in ('c21-g2s', 'c21-lima', 'c21-old', 'c21-snt', 'c21-opc')) = 5);
select pg_temp.assert('d17 readers: C21 still evaluates the effective state once per row',
  (select (length(p.prosrc) - length(replace(p.prosrc, 'order_route_effective_state', '')))
          / length('order_route_effective_state') from pg_proc p
    where p.oid = 'identity.admin_find_order_routes(text,text)'::regprocedure) = 1);
-- C26: the new columns, flags and the reporter's late count.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
create temp table d17_listed on commit drop as
  select row_number() over () as position, listed.*
    from identity.admin_list_wrong_patient_reports('unreviewed', null) listed;
reset role;
select pg_temp.assert('d17 readers: C26 lists every report, flagged first then oldest first',
  (select count(*) from d17_listed) = (select count(*) from ehr.order_route_wrong_patient_reports)
  and (select array_agg(listed.report_id order by listed.position) from d17_listed listed)
    = (select array_agg(listed.report_id order by cardinality(listed.flags) > 0 desc, listed.reported_at, listed.report_id)
         from d17_listed listed));
select pg_temp.assert('d17 readers: C26''s late columns, the reporter''s late reports in 30 days, the sender active, '
    || 'and the actions the review requires',
  (select listed.late and listed.ended_kind_before = 'support' and listed.discovered_by = 'patient'
     and listed.discovered_on = pg_temp.lagos_today() and listed.reporter_late_reports_last_30_days = 4
     and listed.ordering_sender_active and listed.required_actions = array['referred_to_dpo', 'ordering_facility_told']
   from d17_listed listed where listed.route_id = pg_temp.r('g2s'))
  and (select listed.required_actions = array['referred_to_dpo'] and listed.reporter_late_reports_last_30_days = 4
       from d17_listed listed where listed.route_id = pg_temp.r('g2o'))
  and (select listed.required_actions = array['referred_to_dpo'] and listed.reporter_late_reports_last_30_days = 4
       from d17_listed listed where listed.route_id = pg_temp.r('g2ec'))
  and (select listed.required_actions = array[]::text[] from d17_listed listed where listed.route_id = pg_temp.r('g2sc'))
  and (select listed.required_actions = array[]::text[] and listed.ended_kind_before is null
         and not listed.late and listed.discovered_by is null and listed.reporter_late_reports_last_30_days = 4
       from d17_listed listed where listed.route_id = pg_temp.r('rep'))
  and (select listed.required_actions = array['referred_to_dpo', 'ordering_facility_told'] and listed.late
         and listed.ended_kind_before is null
       from d17_listed listed where listed.route_id = pg_temp.r('g1c')),
  (select string_agg(row_to_json(listed)::text, E'\n') from d17_listed listed
    where listed.route_id in (pg_temp.r('g2s'), pg_temp.r('g2o'))));
select pg_temp.assert('d17 readers: C26''s flags: late_correction on every late report, patient_prompted when found out '
    || 'from the patient or another way and something had come back, patient_reported_before after the patient''s first',
  (select array_agg(name || ':' || array_to_string(listed.flags, '+') order by name)
     from unnest(array['g2s', 'g1c', 'g1a', 'g2r', 'g2oc', 'g2rrc', 'rep', 'rx2s', 'rx1a']) name
     join d17_listed listed on listed.route_id = pg_temp.r(name))
  = array[
    'g1a:reporter_recorded_work+late_correction+patient_reported_before',
    'g1c:something_came_back+reporter_recorded_work+suspected_misuse+late_correction+patient_reported_before',
    'g2oc:late_correction',
    'g2r:something_came_back+reporter_recorded_work+late_correction+patient_prompted+patient_reported_before',
    'g2rrc:late_correction+patient_reported_before',
    'g2s:something_came_back+reporter_recorded_work+late_correction+patient_prompted+patient_reported_before',
    'rep:',
    'rx1a:late_correction+patient_reported_before',
    'rx2s:something_came_back+reporter_recorded_work+late_correction+patient_prompted+patient_reported_before'],
  (select string_agg(name || ':' || array_to_string(listed.flags, '+'), ', ' order by name)
     from unnest(array['g2s', 'g1c', 'g1a', 'g2r', 'g2oc', 'g2rrc', 'rep', 'rx2s', 'rx1a']) name
     join d17_listed listed on listed.route_id = pg_temp.r(name)));
select pg_temp.assert('d17 readers: C26 names no patient', not exists (select 1 from d17_listed listed
  where row_to_json(listed)::text ~* '(Patience|Okafor|Rukayat|Danjuma|Nkem|P4CPAT|1990-04-12)'));
-- The clinician who sent the orders leaves GH (owner SQL, triggers off).
do $$
begin
  set local session_replication_role = replica;
  update identity.staff_facility_memberships set active = false where id = 'e4c13000-0000-4000-8000-000000000011';
  set local session_replication_role = origin;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.assert('d17 readers: once DA is no longer active at GH, C26 says the sender is not active',
  (select bool_and(not listed.ordering_sender_active) from identity.admin_list_wrong_patient_reports('unreviewed', null) listed));
reset role;
do $$
begin
  set local session_replication_role = replica;
  update identity.staff_facility_memberships set active = true where id = 'e4c13000-0000-4000-8000-000000000011';
  set local session_replication_role = origin;
end $$;

-- 9. T8's guard keeps the four new columns, even to the superuser: alone,
-- and inside an update that is otherwise a valid review (which passes).
select pg_temp.check('d17 guard: ' || change.column_name || review.how, format($s$update
    ehr.order_route_wrong_patient_reports set %s%s where route_id = %L$s$, change.assignment, review.assignments,
    pg_temp.r('g2s')), '55000 ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE')
  from (values ('late', 'late = false'), ('ended_kind_before', 'ended_kind_before = ''order_changed'''),
               ('discovered_by', 'discovered_by = ''other'''), ('discovered_on', 'discovered_on = discovered_on - 1'))
       change(column_name, assignment)
  cross join (values ('', ''), (' in a review', ', reviewed_at = clock_timestamp(), reviewed_by_account_id = '
    || quote_literal('e4c10000-0000-4000-8000-000000000003') || ', review_actions = array[''referred_to_dpo'', '
    || '''ordering_facility_told''], review_note = ''Reviewed by hand'', row_version = row_version + 1')) review(how, assignments);
select pg_temp.check('d17 guard: the same review without a change passes (rolled back)', format($s$do $d$ begin
    update ehr.order_route_wrong_patient_reports set reviewed_at = clock_timestamp(), reviewed_by_account_id = %L,
      review_actions = array['referred_to_dpo', 'ordering_facility_told'], review_note = 'Reviewed by hand',
      row_version = row_version + 1 where route_id = %L;
    raise exception using errcode = 'P0001', message = 'review passed';
  end $d$$s$, 'e4c10000-0000-4000-8000-000000000003', pg_temp.r('g2s')), 'P0001 review passed');
-- Support's review (C27), D17-6: a late report where something had come
-- back, or a "pretending" one, needs the DPO referral; where something came
-- back and the ordering facility was not released, also the call.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.assert('d17 review: g2s (late, came back) with "No further action": both required actions missing',
  pg_temp.outcome_detail(format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
    array['no_further_action'], 'Nothing more to do here', false)$s$, pg_temp.answer('g2s') ->> 'report_id'))
  = '22023 WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED / referred_to_dpo,ordering_facility_told');
select pg_temp.assert('d17 review: g2s with the referral only: the call missing',
  pg_temp.outcome_detail(format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
    array['referred_to_dpo', 'facility_contacted'], 'Referred it to the DPO', false)$s$,
    pg_temp.answer('g2s') ->> 'report_id'))
  = '22023 WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED / ordering_facility_told');
select pg_temp.check('d17 review: g2s with both', format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
    array['ordering_facility_told', 'referred_to_dpo'], 'Phoned the hospital and referred to the DPO', false)$s$,
    pg_temp.answer('g2s') ->> 'report_id'), 'ok');
select pg_temp.check('d17 review: g2o (the ordering facility released) needs only the referral', format($s$select * from
    identity.admin_review_wrong_patient_report(%L, 1, array['referred_to_dpo'], 'Referred it to the DPO', false)$s$,
    pg_temp.answer('g2o') ->> 'report_id'), 'ok');
select pg_temp.assert('d17 review: g2ec ("pretending", nothing came back) without the referral',
  pg_temp.outcome_detail(format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
    array['facility_contacted'], 'Phoned the laboratory', false)$s$, pg_temp.answer('g2ec') ->> 'report_id'))
  = '22023 WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED / referred_to_dpo');
select pg_temp.check('d17 review: g2ec with the referral', format($s$select * from
    identity.admin_review_wrong_patient_report(%L, 1, array['referred_to_dpo'], 'Referred it to the DPO', false)$s$,
    pg_temp.answer('g2ec') ->> 'report_id'), 'ok');
select pg_temp.check('d17 review: g2sc (late, nothing came back, not "pretending") with "No further action"',
  format($s$select * from identity.admin_review_wrong_patient_report(%L, 1, array['no_further_action'],
    'Nothing more to do here', false)$s$, pg_temp.answer('g2sc') ->> 'report_id'), 'ok');
select pg_temp.check('d17 review: an in-window report (rep) with "No further action", as before', format($s$select * from
    identity.admin_review_wrong_patient_report(%L, 1, array['no_further_action'], 'Checked with the laboratory', false)$s$,
    pg_temp.answer('rep') ->> 'report_id'), 'ok');
select pg_temp.check('d17 review: the old refusals still come first: an unknown action',
  format($s$select * from identity.admin_review_wrong_patient_report(%L, 1, array['called_the_police'],
    'Phoned the laboratory', false)$s$, pg_temp.answer('g1c') ->> 'report_id'), '22023 WRONG_PATIENT_REVIEW_INVALID');
select pg_temp.check('d17 review: ... a stale version', format($s$select * from identity.admin_review_wrong_patient_report(%L,
    5, array['no_further_action'], 'Phoned the laboratory', false)$s$, pg_temp.answer('g1c') ->> 'report_id'),
  '40001 Wrong-patient report version conflict');
reset role;
select pg_temp.check('d17 review: an owner''s update that bypasses C27 is refused by the CHECK', format($s$update
    ehr.order_route_wrong_patient_reports set reviewed_at = clock_timestamp(), reviewed_by_account_id = %L,
    review_actions = array['no_further_action'], review_note = 'Closed by hand without the referral',
    row_version = row_version + 1 where route_id = %L$s$, 'e4c10000-0000-4000-8000-000000000003', pg_temp.r('g1c')),
  '23514 new row for relation "order_route_wrong_patient_reports" violates check constraint '
  || '"order_route_wrong_patient_reports_late_review_ck"');
select pg_temp.assert('d17 review: the reviewed reports',
  (select array_agg(name || ':' || array_to_string(report.review_actions, '+') || ':' || report.row_version order by name)
     from unnest(array['g2s', 'g2o', 'g2ec', 'g2sc', 'rep']) name
     join ehr.order_route_wrong_patient_reports report on report.route_id = pg_temp.r(name))
  = array['g2ec:referred_to_dpo:2', 'g2o:referred_to_dpo:2', 'g2s:ordering_facility_told+referred_to_dpo:2',
          'g2sc:no_further_action:2', 'rep:no_further_action:2']);
select pg_temp.check('d17 the late CHECK: a late report without how B found out', format($s$do $d$ begin
    set local session_replication_role = replica;
    update ehr.order_route_wrong_patient_reports set discovered_by = null where route_id = %L; end $d$$s$,
    pg_temp.r('g1a')),
  '23514 new row for relation "order_route_wrong_patient_reports" violates check constraint '
  || '"order_route_wrong_patient_reports_late_ck"');
select pg_temp.check('d17 the late CHECK: an in-window report with a late fact', format($s$do $d$ begin
    set local session_replication_role = replica;
    update ehr.order_route_wrong_patient_reports set discovered_on = current_date where route_id = %L; end $d$$s$,
    pg_temp.r('opa')),
  '23514 new row for relation "order_route_wrong_patient_reports" violates check constraint '
  || '"order_route_wrong_patient_reports_late_ck"');
select pg_temp.check('d17 the late CHECK: a late cancelled report without an earlier ending', format($s$do $d$ begin
    set local session_replication_role = replica;
    update ehr.order_route_wrong_patient_reports set ended_kind_before = null where route_id = %L; end $d$$s$,
    pg_temp.r('g2oc')),
  '23514 new row for relation "order_route_wrong_patient_reports" violates check constraint '
  || '"order_route_wrong_patient_reports_late_ck"');

-- 10. The limits, exact. Every late report so far moves back 25 hours, so
-- none counts; then LB1 makes its 5th within 24 hours (4 synthetic, one
-- older than 24 hours not counted) and its 6th is refused with the time the
-- oldest counted one leaves the window; with 20 at L1, LB2's next is refused
-- with the facility's time; LB1's, with both reached, gives the later.
select pg_temp.age_late_reports(interval '25 hours');
select set_config('hid.test.limit_base', clock_timestamp()::text, true);
select set_config('hid.test.member_oldest', pg_temp.synthetic_late(current_setting('hid.test.membership_1')::uuid,
  array[current_setting('hid.test.limit_base')::timestamptz - interval '23 hours',
        current_setting('hid.test.limit_base')::timestamptz - interval '22 hours',
        current_setting('hid.test.limit_base')::timestamptz - interval '21 hours',
        current_setting('hid.test.limit_base')::timestamptz - interval '20 hours'])::text, true);
select pg_temp.synthetic_late(current_setting('hid.test.membership_1')::uuid,
  array[current_setting('hid.test.limit_base')::timestamptz - interval '24 hours 1 second']);
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('d17 limits: LB1''s 5th late correction in 24 hours', format($s$select * from pg_temp.late('lab_request',
    %L, %s, 'other', 'own_check', pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-limit-lima-00001')$s$,
    pg_temp.r('lima'), pg_temp.v(pg_temp.r('lima'))), 'ok');
reset role;
select set_config('hid.test.footprint_limits', pg_temp.footprint17(), true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 limits: LB1''s 6th is refused until the oldest counted report is 24 hours old',
  pg_temp.outcome_detail(format($s$select * from pg_temp.late('lab_request', %L, %s, 'other', 'own_check',
    pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-limit-limb-00001')$s$, pg_temp.r('limb'),
    pg_temp.v(pg_temp.r('limb'))))
  = 'P0001 ORDER_ROUTE_CORRECTION_LIMIT / '
    || pg_temp.limit_detail(current_setting('hid.test.member_oldest')::timestamptz + interval '24 hours'),
  pg_temp.outcome_detail(format($s$select * from pg_temp.late('lab_request', %L, %s, 'other', 'own_check',
    pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-limit-limb-00001')$s$, pg_temp.r('limb'),
    pg_temp.v(pg_temp.r('limb')))));
reset role;
select set_config('hid.test.facility_oldest', pg_temp.synthetic_late(gen_random_uuid(),
  array(select current_setting('hid.test.limit_base')::timestamptz - interval '23 hours 30 minutes' + make_interval(secs => n)
          from generate_series(1, 15) n))::text, true);
select pg_temp.snap();
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('d17 limits: with 20 at L1 in 24 hours, LB2''s next is refused until the facility''s oldest '
    || 'counted report is 24 hours old',
  pg_temp.outcome_detail(format($s$select * from pg_temp.late('lab_request', %L, %s, 'other', 'own_check',
    pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-limit-limb-00002')$s$, pg_temp.r('limb'),
    pg_temp.v(pg_temp.r('limb'))))
  = 'P0001 ORDER_ROUTE_CORRECTION_LIMIT / '
    || pg_temp.limit_detail(current_setting('hid.test.facility_oldest')::timestamptz + interval '24 hours'));
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 limits: LB1, with both limits reached, is refused until the later of the two times',
  pg_temp.outcome_detail(format($s$select * from pg_temp.late('lab_request', %L, %s, 'other', 'own_check',
    pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-limit-limb-00003')$s$, pg_temp.r('limb'),
    pg_temp.v(pg_temp.r('limb'))))
  = 'P0001 ORDER_ROUTE_CORRECTION_LIMIT / '
    || pg_temp.limit_detail(current_setting('hid.test.member_oldest')::timestamptz + interval '24 hours'));
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.assert('d17 limits: another facility counts its own (PH1 has none in 24 hours)',
  pg_temp.outcome(format($s$select * from pg_temp.late('prescription', %L, %s, 'other', 'own_check',
    pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-limit-rxpr-00001')$s$, pg_temp.r('rxpr'),
    pg_temp.v(pg_temp.r('rxpr')))) = 'ok');
reset role;
select pg_temp.assert('d17 limits: the refusals wrote nothing (the pharmacy''s correction aside)',
  (select count(*) from ehr.order_route_wrong_patient_reports report where report.route_id = pg_temp.r('limb')) = 0
  and pg_temp.capabilities() = 0
  and (pg_temp.route(pg_temp.r('limb'))).row_version = pg_temp.v(pg_temp.r('limb')));
-- A limit refusal comes after the replay and state checks: LB1's replay of
-- lima, and a report of an already reported route, answer as such.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('d17 limits: at the limit, LB1''s replay answers replayed and a reported route ALREADY_REPORTED',
  (select replayed.result = 'replayed' from pg_temp.late('lab_request', pg_temp.r('lima'), pg_temp.v(pg_temp.r('lima')),
     'other', 'own_check', pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-limit-lima-00001') replayed)
  and pg_temp.outcome(format($s$select * from pg_temp.late('lab_request', %L, %s, 'other', 'own_check',
    pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-limit-g1c-000001')$s$, pg_temp.r('g1c'),
    pg_temp.v(pg_temp.r('g1c')))) = 'P0001 ORDER_ROUTE_ALREADY_REPORTED');
reset role;
select pg_temp.forget_synthetic();

-- 11. The 180-day bound (D17-2): a minute before it bnd is correctable (the
-- summary, C5, C21 and the lookup carry the deadline); a minute after it,
-- too late everywhere, and the command refuses it.
select pg_temp.accept_at(pg_temp.r('bnd'), clock_timestamp() - interval '4320 hours' + interval '1 minute');
select pg_temp.assert('d17 bound: a minute before the deadline',
  ehr.order_route_correction_state(pg_temp.route(pg_temp.r('bnd'))) = 'correctable'
  and (ehr.order_route_summary(pg_temp.route(pg_temp.r('bnd')), false) ->> 'correctableUntil')::timestamptz
    = (pg_temp.route(pg_temp.r('bnd'))).accepted_at + interval '4320 hours'
  and ehr.order_route_correctable_until(pg_temp.route(pg_temp.r('bnd')))
    = (pg_temp.route(pg_temp.r('bnd'))).accepted_at + interval '180 days');
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('d17 bound: ... the lookup says correctable', pg_temp.look('bnd-before', 'lab_request', pg_temp.ref('bnd')) = 1
  and pg_temp.found('bnd-before') ->> 'correction_state' = 'correctable');
reset role;
select pg_temp.accept_at(pg_temp.r('bnd'), clock_timestamp() - interval '4320 hours' - interval '1 minute');
select pg_temp.snap();
select pg_temp.assert('d17 bound: a minute after the deadline', ehr.order_route_correction_state(pg_temp.route(pg_temp.r('bnd')))
  = 'too_late' and ehr.order_route_summary(pg_temp.route(pg_temp.r('bnd')), false) -> 'correctableUntil' = 'null'::jsonb);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('d17 bound: ... the command refuses it', format($s$select * from pg_temp.late('lab_request', %L, %s,
    'other', 'own_check', pg_temp.lagos_today(), 'Found on our own audit of the run', 'd17-bound-bnd-000001')$s$,
    pg_temp.r('bnd'), pg_temp.v(pg_temp.r('bnd'))), 'P0001 ORDER_ROUTE_CORRECTION_TOO_LATE');
select pg_temp.assert('d17 bound: ... the lookup says too late, without details',
  pg_temp.look('bnd-after', 'lab_request', pg_temp.ref('bnd')) = 1
  and pg_temp.found('bnd-after') ->> 'correction_state' = 'too_late' and pg_temp.found('bnd-after') -> 'what_name' = 'null'::jsonb);
reset role;
select pg_temp.assert('d17: T9 is empty at the end', pg_temp.capabilities() = 0);

select pg_temp.report();
rollback;
