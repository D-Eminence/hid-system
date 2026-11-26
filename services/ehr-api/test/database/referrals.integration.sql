\set ON_ERROR_STOP on
-- REF-1 Referrals between facilities (0191-0193, Release D; owner decisions
-- Q261-Q266 A of 25 November 2026). Rollback-only. Every command runs as the
-- exact runtime role (hid_ehr_api_runtime for the EHR's functions,
-- hid_identity_api_runtime for the directory and support's), in the context
-- the services set; owner SQL is marked.
--   1. the agreement text, who may send, and the control off: a referral to a
--      facility on Health ID refused (423), a printed letter recorded;
--   2. the refusals of route 2 in order, each audited;
--   3. the package: each kind's eligibility (another patient's, another
--      facility's, a refuted diagnosis, an ended medicine, an old or
--      entered-in-error vital reading, an unreleased lab result, a duplicate,
--      all package_invalid) and the frozen copy built by the server;
--   4. a referral to a facility on Health ID: respond_by, replay and a reused
--      key, the patient's notice, the 5-per-visit limit;
--   5. the receiving facility: incoming at view level preview (sex and age,
--      no name or chart content), a third facility sees nothing, accept (full,
--      the package, arrive_by and access_ends_at), the control off (metadata),
--      version conflicts;
--   6. arrival: another patient's matchRef, a patient id that is not this
--      facility's own, then the referral's patient's matchRef (0135's own
--      check-in, basis search), the waiting-list row kept;
--   7. complete: the outcome rules, access_ends_at, the counter-referral read by
--      the referring facility;
--   8. decline, withdraw by the referring facility and by the patient, expiry
--      (not_answered), the visit entered in error ending the read at once;
--   9. the frozen package: a source marked entered in error since sending
--      answers enteredInErrorSinceSent with no content;
--  10. the guard: no frozen column changes, no step out of order, no package
--      item after sending, no delete or truncate;
--  11. the directory, support's lookup and listing lever;
--  12. audit and notices: no name, Health ID, reason, letter, note or content.
-- Synthetic values only; uuid prefix e9f.
--   Governed hospitals A (referring), B (receiving, listed, with a profile
--   listing its departments) and C (a third facility); a governed laboratory L
--   (not a hospital or clinic).
--   Staff: 11 DA doctor (MDCN licence), 12 CA clinician, 13 NA nurse, 15 XA
--   clinician without a consent (all at A); 21 DB doctor, 22 RB receptionist,
--   23 NB nurse (at B); 31 DC doctor (at C).
--   Patients: 1 P (account and session), 2 N (no account), 3 U (an unknown
--   record at A), 4 D (a deny directive naming B), 5 Q (another patient).
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

create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception 'referrals suite failed: %: expected [%] got [%]', case_name, expected, coalesce(actual, 'null');
  end if;
  perform set_config('ref.passed', (coalesce(nullif(current_setting('ref.passed', true), ''), '0')::integer + 1)::text,
    true);
end
$$;
grant execute on function pg_temp.expect(text, text, text) to public;

insert into identity.purpose_of_use_codes (code, display, source_system)
values ('direct-care', 'Direct patient care', 'ref1-test') on conflict (code) do nothing;

-- Platform: the super administrator.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e9f10000-0000-4000-8000-000000000001', 'synthetic:ref1:super', 'super@ref1.invalid', 'Ref Super Admin', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('e9f11000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'REF-1 suite super admin');

-- Governed organizations: hospitals A, B and C; laboratory L.
insert into identity.organizations (id, name, slug)
select ('e9f20000-0000-4000-8000-00000000000' || g.n)::uuid, g.legal_name, 'ref1-org-' || g.n
  from (values (1, 'Ref Referring Hospital Ltd'), (2, 'Ref Receiving Hospital Ltd'), (3, 'Ref Third Hospital Ltd'),
               (4, 'Ref Diagnostics Ltd')) g(n, legal_name);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
select ('e9f21000-0000-4000-8000-00000000000' || g.n)::uuid, ('e9f20000-0000-4000-8000-00000000000' || g.n)::uuid,
  g.name, 'REF1-' || g.n, 'Africa/Lagos', true, 'verified'
  from (values (1, 'Fictional General Hospital'), (2, 'Fictional Teaching Hospital'), (3, 'Fictional Third Hospital'),
               (4, 'Fictional Laboratory')) g(n, name);
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
select ('e9f22000-0000-4000-8000-00000000000' || g.n)::uuid, g.product, g.legal_name, g.kind, g.cac,
  'Governed Admin ' || g.n, 'admin' || g.n || '@ref1-governed.invalid', 'approved', 'verified', '88' || g.n,
  clock_timestamp(), ('e9f20000-0000-4000-8000-00000000000' || g.n)::uuid,
  ('e9f21000-0000-4000-8000-00000000000' || g.n)::uuid, 'e9f10000-0000-4000-8000-000000000001',
  'Governed approval for the REF-1 suite', clock_timestamp(), g.legal_name, 'Private Company Limited by Shares',
  '2019-05-01', g.n || ' Referral Road, Ikeja, Lagos', 'active'
  from (values (1, 'ehr', 'hospital', 'RC9955001', 'Ref Referring Hospital Ltd'),
               (2, 'ehr', 'hospital', 'RC9955002', 'Ref Receiving Hospital Ltd'),
               (3, 'ehr', 'hospital', 'RC9955003', 'Ref Third Hospital Ltd'),
               (4, 'laboratory', 'laboratory', 'RC9955004', 'Ref Diagnostics Ltd')) g(n, product, kind, cac, legal_name);
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
select ('e9f20000-0000-4000-8000-00000000000' || n)::uuid, product, ('e9f21000-0000-4000-8000-00000000000' || n)::uuid,
  'active', ('e9f22000-0000-4000-8000-00000000000' || n)::uuid
  from (values (1, 'ehr'), (2, 'ehr'), (3, 'ehr'), (4, 'laboratory')) g(n, product);
set local session_replication_role = replica;
insert into identity.organization_cac_registrations (cac_registration_number, organization_id, primary_facility_id,
  source_application_id, verified_organization_name, verified_entity_type, verified_registration_date, verified_address,
  verified_registry_status, organization_name_source, entity_type_source, registration_date_source, address_source,
  registry_status_source)
values ('RC9955001', 'e9f20000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000001',
  'e9f22000-0000-4000-8000-000000000001', 'Ref Referring Hospital Ltd', 'Private Company Limited by Shares',
  '2019-05-01', '1 Referral Road, Ikeja, Lagos', 'active', 'qoreid', 'qoreid', 'qoreid', 'qoreid', 'qoreid');
insert into identity.facility_profiles (facility_id, trading_name, ownership, care_level, address_line, city,
  state_code, lga, gps_latitude, gps_longitude, phone_e164, email, bed_count, operating_hours, emergency_24h,
  departments, services_offered, smoh_licence_number, has_registry_id, has_nhia_accreditation, medical_director_name,
  medical_director_mdcn, expected_staff, migrating_records, needs_interoperability, source)
values ('e9f21000-0000-4000-8000-000000000002', 'Fictional Teaching Hospital', 'private', 'tertiary',
  '2 Teaching Road, Yaba', 'Lagos', 'LA', 'Yaba', 6.5, 3.4, '+2348031234567', 'desk@ref1-teaching.invalid', 300,
  'Always open', true, array['general_outpatient', 'cardiology'], 'Outpatients and specialist clinics', 'SMOH/1234',
  false, false, 'Dr Teaching Director', 'MDCN/77777', 50, false, false, 'facility_administrator');
set local session_replication_role = origin;

-- Staff. n: 11 DA doctor, 12 CA clinician, 13 NA nurse, 15 XA clinician (A); 21 DB doctor, 22 RB receptionist,
-- 23 NB nurse (B); 31 DC doctor (C).
create temporary table ref_staff (n integer, code text, full_name text, role text, site integer) on commit drop;
insert into ref_staff values (11, 'da', 'Ada Referrer', 'doctor', 1), (12, 'ca', 'Bayo Clinician', 'clinician', 1),
  (13, 'na', 'Chika Nurse', 'nurse', 1), (15, 'xa', 'Xavier Clinician', 'clinician', 1),
  (21, 'db', 'Dayo Receiver', 'doctor', 2), (22, 'rb', 'Ronke Desk', 'receptionist', 2),
  (23, 'nb', 'Nneka Nurse', 'nurse', 2), (31, 'dc', 'Dapo Third', 'doctor', 3);
insert into auth.accounts (id, subject, email, display_name, status)
select ('e9f10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:ref1:' || s.code, s.code || '@ref1-staff.invalid',
  s.full_name, 'active' from ref_staff s;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e9f12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e9f10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@ref1-staff.invalid', 'verified', s.role from ref_staff s;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e9f13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e9f12000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e9f10000-0000-4000-8000-0000000000' || s.n)::uuid, ('e9f20000-0000-4000-8000-00000000000' || s.site)::uuid,
  ('e9f21000-0000-4000-8000-00000000000' || s.site)::uuid, s.role, s.role, true, true from ref_staff s;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e9f11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e9f10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e9f13000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e9f21000-0000-4000-8000-00000000000' || s.site)::uuid, 'REF-1 suite role' from ref_staff s;
insert into identity.staff_licence_attestations (organization_id, facility_id, account_id, staff_id, membership_id,
  role_code, role_grant_id, licence_body, licence_number, attested_person_name, verification_method,
  attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id)
values ('e9f20000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000001',
  'e9f10000-0000-4000-8000-000000000011', 'e9f12000-0000-4000-8000-000000000011',
  'e9f13000-0000-4000-8000-000000000011', 'doctor', 'e9f11000-0000-4000-8000-000000000011', 'MDCN', 'MDCN/12345',
  'Ada Referrer', 'facility_attestation', 'e9f10000-0000-4000-8000-000000000012', 'e9f13000-0000-4000-8000-000000000012',
  'facility-staff-attestation-v1', clock_timestamp(), 'ref1-fixture-licence');

-- Patients: P (1) and D (4) and Q (5) with active accounts, P with a live patient session; N (2) without an account;
-- U (3) an unknown record made at A.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e9f10000-0000-4000-8000-000000000041', 'synthetic:ref1:patient-p', 'patient-p@ref1.invalid', 'Ngozi Referone', 'active'),
  ('e9f10000-0000-4000-8000-000000000044', 'synthetic:ref1:patient-d', 'patient-d@ref1.invalid', 'Dede Denies', 'active'),
  ('e9f10000-0000-4000-8000-000000000045', 'synthetic:ref1:patient-q', 'patient-q@ref1.invalid', 'Qudus Other', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e9f30000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000041', 'HID-REFPATPX', 'Ngozi', 'Referone',
   'Ngozi Referone', 'female', '1979-04-02', 'active'),
  ('e9f30000-0000-4000-8000-000000000002', null, 'HID-REFPATNX', 'Nnamdi', 'Noaccount', 'Nnamdi Noaccount', 'male',
   '1990-01-15', 'active'),
  ('e9f30000-0000-4000-8000-000000000003', null, 'HID-REFPATUX', 'Unknown', 'Patient', 'Unknown patient U-0001',
   'unknown', '1980-01-01', 'active'),
  ('e9f30000-0000-4000-8000-000000000004', 'e9f10000-0000-4000-8000-000000000044', 'HID-REFPATDX', 'Dede', 'Denies',
   'Dede Denies', 'female', '1988-07-07', 'active'),
  ('e9f30000-0000-4000-8000-000000000005', 'e9f10000-0000-4000-8000-000000000045', 'HID-REFPATQX', 'Qudus', 'Other',
   'Qudus Other', 'male', '1970-03-03', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
values ('e9f31000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000041',
  'e9f31000-0000-4000-8000-000000000001', md5('ref1-session-1') || md5('ref1-session-1'), gen_random_uuid(), 1,
  'password', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours', 'patient', 'e9f30000-0000-4000-8000-000000000001');
insert into identity.unknown_patients (patient_id, facility_id, label_number, unknown_reason, status,
  created_by_account_id, created_by_membership_id, idempotency_key, request_sha256)
values ('e9f30000-0000-4000-8000-000000000003', 'e9f21000-0000-4000-8000-000000000001', 1, 'unconscious',
  'open', 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011', 'ref1-fixture-unknown-0001',
  repeat('a', 64));
-- D's deny directive naming B.
insert into identity.consent_directives (id, patient_id, current_version) values
  ('e9f32000-0000-4000-8000-000000000004', 'e9f30000-0000-4000-8000-000000000004', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, starts_at, source_reference, reason, content_sha256)
values ('e9f32100-0000-4000-8000-000000000004', 'e9f32000-0000-4000-8000-000000000004',
  'e9f30000-0000-4000-8000-000000000004', 1, 'active', 'deny', 'facility', 'e9f21000-0000-4000-8000-000000000002',
  clock_timestamp() - interval '1 day', 'ref1-fixture', 'Does not want the teaching hospital to see records',
  repeat('b', 64));
-- Direct-care write consents at A for DA, CA and NA (not XA), for every patient.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), ('e9f30000-0000-4000-8000-00000000000' || p.n)::uuid,
  ('e9f12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e9f10000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e9f13000-0000-4000-8000-0000000000' || s.n)::uuid, 'e9f21000-0000-4000-8000-000000000001',
  'write_records', 'active', 'REF-1 suite direct-care consent', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '30 days', false, 'direct-care'
  from (values (11), (12), (13)) s(n) cross join generate_series(1, 5) p(n);

-- Visits at A (DA): 1 EP for P, 2 EN for N, 3 EU for U, 4 ED for D, 5 EP2 for P (no signed note), 6 EQ for Q,
-- 7 EP3 for P (the visit entered in error later), 8 EP4 for P (the per-visit limit).
set local session_replication_role = replica;
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e9f50000-0000-4000-8000-00000000000' || v.n)::uuid, ('e9f30000-0000-4000-8000-00000000000' || v.p)::uuid,
  'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011',
  'e9f13000-0000-4000-8000-000000000011', 'ambulatory', 'in_progress', clock_timestamp() - interval '1 hour'
  from (values (1, 1), (2, 2), (3, 3), (4, 4), (5, 1), (6, 5), (7, 1), (8, 1)) v(n, p);
insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  note_type, title, status, current_revision_no, signed_at, signed_by)
select ('e9f51000-0000-4000-8000-00000000000' || v.n)::uuid, ('e9f50000-0000-4000-8000-00000000000' || v.n)::uuid,
  ('e9f30000-0000-4000-8000-00000000000' || v.p)::uuid, 'e9f21000-0000-4000-8000-000000000001',
  'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011', 'progress', 'Consultation',
  case when v.n = 5 then 'draft' else 'signed' end, 1, case when v.n = 5 then null else clock_timestamp() end,
  case when v.n = 5 then null else 'e9f10000-0000-4000-8000-000000000011'::uuid end
  from (values (1, 1), (2, 2), (3, 3), (4, 4), (5, 1), (6, 5), (7, 1), (8, 1)) v(n, p);
-- P's chart at A: diagnoses 1 (active) and 2 (refuted); Q's diagnosis 3; prescriptions 1 (active) and 2 (ended
-- yesterday); allergies 1 (at A) and 2 (at C); vital readings 1 (today, corrected), 2 (40 days ago), 3 (entered in
-- error); lab results 1 (released) and 2 (not released), both of this facility's own laboratory.
insert into ehr.diagnoses (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  code_system, code, display, clinical_status, verification_status, notes)
values
  ('e9f52000-0000-4000-8000-000000000001', 'e9f50000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
   'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011',
   'ICD-11', 'BC21', 'Heart murmur', 'active', 'provisional', 'Private working note'),
  ('e9f52000-0000-4000-8000-000000000002', 'e9f50000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
   'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011',
   'ICD-11', 'CA40', 'Pneumonia', 'active', 'refuted', null),
  ('e9f52000-0000-4000-8000-000000000003', 'e9f50000-0000-4000-8000-000000000006', 'e9f30000-0000-4000-8000-000000000005',
   'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011',
   'ICD-11', '5A11', 'Type 2 diabetes mellitus', 'active', 'confirmed', null);
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, starts_on, ends_on, status)
values
  ('e9f53000-0000-4000-8000-000000000001', 'e9f50000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
   'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011',
   'Amlodipine 5 mg tablet', 5, 'mg', 'oral', 'once daily', 'Take in the morning', current_date - 5, null, 'active'),
  ('e9f53000-0000-4000-8000-000000000002', 'e9f50000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
   'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011',
   'Amoxicillin 500 mg capsule', 500, 'mg', 'oral', 'three times daily', 'Finish the course', current_date - 10,
   (clock_timestamp() at time zone 'Africa/Lagos')::date - 1, 'active');
insert into ehr.recorded_allergies (id, patient_id, facility_id, created_by, created_by_membership_id, substance,
  reaction, severity, status)
values
  ('e9f54000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000001',
   'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011', 'Penicillin', 'Rash', 'severe',
   'active'),
  ('e9f54000-0000-4000-8000-000000000002', 'e9f30000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000003',
   'e9f10000-0000-4000-8000-000000000031', 'e9f13000-0000-4000-8000-000000000031', 'Peanut', 'Swelling', 'moderate',
   'active');
insert into ehr.vitals (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
  pulse_bpm, systolic_mmhg, diastolic_mmhg, current_correction_no, status, status_changed_at)
values
  ('e9f55000-0000-4000-8000-000000000001', 'e9f50000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
   'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011',
   clock_timestamp() - interval '30 minutes', 96, 150, 95, 1, 'recorded', null),
  ('e9f55000-0000-4000-8000-000000000002', 'e9f50000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
   'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011',
   clock_timestamp() - interval '40 days', 80, 120, 80, 0, 'recorded', null),
  ('e9f55000-0000-4000-8000-000000000003', 'e9f50000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
   'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011',
   clock_timestamp() - interval '20 minutes', 70, 110, 70, 0, 'entered_in_error', clock_timestamp());
insert into ehr.vital_corrections (vital_id, patient_id, facility_id, correction_no, replacement_values, reason,
  created_by, created_by_membership_id)
values ('e9f55000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
  'e9f21000-0000-4000-8000-000000000001', 1, '{"pulse_bpm": 98}', 'Recounted the pulse',
  'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011');
-- The laboratory chain at A (owner SQL).
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name, requested_by,
  requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e9f56000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
  'e9f21000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000001', gen_random_uuid(), 1,
  'e9f50000-0000-4000-8000-000000000001', 'accepted', 'routine', 'HID-LAB', 'HB', 'Haemoglobin',
  'e9f10000-0000-4000-8000-000000000011', clock_timestamp(), 'e9f10000-0000-4000-8000-000000000011',
  'e9f13000-0000-4000-8000-000000000011', 'ref1-fixture-work-item-1', repeat('d', 64), 'ref1-fixture-lab');
insert into lab.work_item_requested_tests (id, work_item_id, facility_id, patient_id, ordinal, code_system, code, name)
select ('e9f56100-0000-4000-8000-00000000000' || n)::uuid, 'e9f56000-0000-4000-8000-000000000001',
  'e9f21000-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001', n, 'HID-LAB', 'HB' || n,
  'Haemoglobin' from generate_series(1, 2) n;
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
values ('e9f56200-0000-4000-8000-000000000001', 'e9f56000-0000-4000-8000-000000000001',
  'e9f30000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000001', 'routine',
  'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011', 'ref1-fixture-accession-1',
  repeat('e', 64), 'ref1-fixture-lab');
insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type)
values ('e9f56300-0000-4000-8000-000000000001', gen_random_uuid(), 'e9f56200-0000-4000-8000-000000000001',
  'e9f30000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000001', 'blood');
insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, started_by,
  started_by_membership_id, started_at, idempotency_key, request_sha256, correlation_id)
select ('e9f56400-0000-4000-8000-00000000000' || n)::uuid, 'e9f56200-0000-4000-8000-000000000001',
  'e9f56300-0000-4000-8000-000000000001', ('e9f56100-0000-4000-8000-00000000000' || n)::uuid,
  'e9f30000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000001', 'e9f10000-0000-4000-8000-000000000011',
  'e9f13000-0000-4000-8000-000000000011', clock_timestamp(), 'ref1-fixture-execution-' || n, repeat('f', 64),
  'ref1-fixture-lab' from generate_series(1, 2) n;
insert into lab.results (id, execution_id, patient_id, facility_id, current_version, created_by, created_by_membership_id)
select ('e9f56500-0000-4000-8000-00000000000' || n)::uuid, ('e9f56400-0000-4000-8000-00000000000' || n)::uuid,
  'e9f30000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000001', 1,
  'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011' from generate_series(1, 2) n;
insert into lab.result_revisions (id, result_id, execution_id, patient_id, facility_id, version, result_type,
  numeric_value, unit, reference_range, abnormal_flag, entry_source, verification_status, entered_by,
  entered_by_membership_id, idempotency_key, request_sha256, correlation_id, revision_kind)
select gen_random_uuid(), ('e9f56500-0000-4000-8000-00000000000' || n)::uuid,
  ('e9f56400-0000-4000-8000-00000000000' || n)::uuid, 'e9f30000-0000-4000-8000-000000000001',
  'e9f21000-0000-4000-8000-000000000001', 1, 'numeric', 13.2, 'g/dL', '12-16', 'normal', 'manual', 'unverified',
  'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011', 'ref1-fixture-revision-' || n,
  repeat('0', 64), 'ref1-fixture-lab', 'original' from generate_series(1, 2) n;
insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version, verified_by,
  verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
values ('e9f56600-0000-4000-8000-000000000001', 'e9f56500-0000-4000-8000-000000000001',
  'e9f56400-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001', 'e9f21000-0000-4000-8000-000000000001',
  1, 'e9f10000-0000-4000-8000-000000000011', 'e9f13000-0000-4000-8000-000000000011', clock_timestamp(),
  'Checked against the analyser', 'ref1-fixture-verification-1', repeat('1', 64), 'ref1-fixture-lab');
insert into lab.result_releases (id, verification_id, result_id, execution_id, patient_id, facility_id, result_version,
  attestation_method, released_by, released_by_membership_id, released_at, reason, idempotency_key, request_sha256,
  correlation_id)
values ('e9f56700-0000-4000-8000-000000000001', 'e9f56600-0000-4000-8000-000000000001',
  'e9f56500-0000-4000-8000-000000000001', 'e9f56400-0000-4000-8000-000000000001', 'e9f30000-0000-4000-8000-000000000001',
  'e9f21000-0000-4000-8000-000000000001', 1, 'authenticated_manual_approval', 'e9f10000-0000-4000-8000-000000000011',
  'e9f13000-0000-4000-8000-000000000011', clock_timestamp(), 'Released to the clinician', 'ref1-fixture-release-1',
  repeat('2', 64), 'ref1-fixture-lab');
set local session_replication_role = origin;

-- Session helpers.
create function pg_temp.as_staff(member integer, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:ref1:' || (select code from ref_staff where n = member), true),
    set_config('app.membership_id', 'e9f13000-0000-4000-8000-0000000000' || member, true),
    set_config('app.facility_id', 'e9f21000-0000-4000-8000-00000000000' || (select site from ref_staff where n = member),
      true),
    set_config('app.correlation_id', 'ref1-suite-' || member || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.vitals_status', '0142', true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_patient()
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:ref1:patient-p', true),
    set_config('app.account_id', 'e9f10000-0000-4000-8000-000000000041', true),
    set_config('app.session_id', 'e9f31000-0000-4000-8000-000000000001', true),
    set_config('app.patient_id', 'e9f30000-0000-4000-8000-000000000001', true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '5 minutes')::text, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'ref1-suite-patient-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', 'patient-self', true);
$f$;
create function pg_temp.as_platform()
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:ref1:super', true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'ref1-suite-platform-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', 'healthcare-operations', true),
    set_config('app.patient_id', '', true);
$f$;
-- A referral send by a member, answering "outcome|referralId" (the id is kept in ref.last).
create function pg_temp.send(member integer, patient integer, visit integer, kind text, receiving integer,
  diagnoses uuid[] default '{}', prescriptions uuid[] default '{}', allergies uuid[] default '{}',
  vitals uuid[] default '{}', labs uuid[] default '{}', agreed boolean default true,
  version text default null, urgency text default 'routine', idem text default null, reason text default null)
returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_staff(member);
  select * into answer from ehr.referral_send(('e9f30000-0000-4000-8000-00000000000' || patient)::uuid,
    ('e9f50000-0000-4000-8000-00000000000' || visit)::uuid, kind,
    case when kind = 'health_id' then ('e9f21000-0000-4000-8000-00000000000' || receiving)::uuid end,
    case when kind = 'printed' then 'Fictional Outside Clinic' end, case when kind = 'printed' then 'Ibadan' end,
    'cardiology', 'Cardiology clinic', urgency, coalesce(reason, 'New heart murmur with breathlessness on exertion'),
    'Dear colleague, please see this patient about a new heart murmur.', diagnoses, prescriptions, allergies, vitals,
    labs, coalesce(version, case when kind = 'printed' then 'referral-printed-attestation-v1'
                                 else 'referral-health-id-attestation-v1' end),
    agreed, coalesce(idem, 'ref1-send-' || substr(md5(random()::text), 1, 16)),
    encode(sha256(convert_to(coalesce(idem, random()::text), 'UTF8')), 'hex'));
  perform set_config('ref.last', coalesce(answer.referral ->> 'referralId', ''), true);
  perform set_config('ref.card', coalesce(answer.referral::text, ''), true);
  perform set_config('ref.package', coalesce(answer.package::text, ''), true);
  return answer.outcome || case when answer.replayed then ' (replayed)' else '' end;
end
$f$;
grant execute on function pg_temp.send(integer, integer, integer, text, integer, uuid[], uuid[], uuid[], uuid[], uuid[],
  boolean, text, text, text, text) to public;
grant execute on function pg_temp.as_staff(integer, text), pg_temp.as_patient(), pg_temp.as_platform() to public;
grant select on ref_staff to public;
-- The current row version of a referral (owner read).
create function pg_temp.version_of(referral uuid) returns bigint language sql as $f$
  select row_version from ehr.referrals where id = referral;
$f$;
grant execute on function pg_temp.version_of(uuid) to public;
create function pg_temp.key() returns text language sql as $f$ select 'ref1-key-' || md5(random()::text) $f$;
create function pg_temp.sha() returns text language sql as $f$ select encode(sha256(convert_to(random()::text, 'UTF8')), 'hex') $f$;
grant execute on function pg_temp.key(), pg_temp.sha() to public;

-- 1. The agreement text, who may send, and the control off.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11);
select pg_temp.expect('1a the Health ID agreement text', 'referral-health-id-attestation-v1',
  (select version from ehr.referral_attestation_text('health_id')));
select pg_temp.expect('1b the printed letter agreement text holds {patient} and {receivingFacility}', 'true',
  (select (text like '%{patient}%' and text like '%{receivingFacility}%')::text
     from ehr.referral_attestation_text('printed')));
select pg_temp.as_staff(13);
do $$
begin
  perform ehr.referral_attestation_text('health_id');
  raise exception 'a nurse read the agreement text';
exception when insufficient_privilege then
  perform pg_temp.expect('1c a nurse holds no referral code', 'REFERRAL_NOT_ALLOWED', sqlerrm);
end $$;
select pg_temp.as_staff(11, 'emergency');
do $$
begin
  perform ehr.referral_attestation_text('health_id');
  raise exception 'an emergency purpose read the agreement text';
exception when insufficient_privilege then
  perform pg_temp.expect('1d emergency purpose refused', 'REFERRAL_NOT_ALLOWED', sqlerrm);
end $$;
select pg_temp.expect('1e control off: a referral to a facility on Health ID is refused', 'control_off',
  pg_temp.send(11, 1, 1, 'health_id', 2));
select pg_temp.expect('1f control off: a printed letter is recorded', 'printed',
  pg_temp.send(11, 1, 1, 'printed', null, array['e9f52000-0000-4000-8000-000000000001']::uuid[],
    array['e9f53000-0000-4000-8000-000000000001']::uuid[],
    array['e9f54000-0000-4000-8000-000000000001', 'e9f54000-0000-4000-8000-000000000002']::uuid[],
    array['e9f55000-0000-4000-8000-000000000001']::uuid[], array['e9f56500-0000-4000-8000-000000000001']::uuid[]));
select set_config('ref.printed', current_setting('ref.last'), true);
select pg_temp.expect('1g the printed card', 'printed|printed|Fictional Outside Clinic|Ibadan|null|MDCN/12345|full|47|female',
  (select concat_ws('|', card ->> 'state', card ->> 'destinationKind', card #>> '{printedFacility,name}',
     card #>> '{printedFacility,town}', coalesce(card ->> 'respondBy', 'null'), card #>> '{referrer,licence,number}',
     card ->> 'viewLevel', card #>> '{patient,ageYearsAtSend}', card #>> '{patient,sexAtSend}')
     from (select current_setting('ref.card')::jsonb as card) answered));
select pg_temp.expect('1h the frozen package as built by the server', '1 1 2 1 1|98|Penicillin,Peanut|true,false|13.2',
  (select concat_ws('|',
     jsonb_array_length(package #> '{sections,diagnoses}') || ' ' || jsonb_array_length(package #> '{sections,medicines}')
       || ' ' || jsonb_array_length(package #> '{sections,allergies}') || ' ' || jsonb_array_length(package #> '{sections,vitals}')
       || ' ' || jsonb_array_length(package #> '{sections,labResults}'),
     package #>> '{sections,vitals,0,content,measures,pulseBpm}',
     (select string_agg(item #>> '{content,substance}', ',') from jsonb_array_elements(package #> '{sections,allergies}') item),
     (select string_agg(item #>> '{content,recordedAtReferringFacility}', ',')
        from jsonb_array_elements(package #> '{sections,allergies}') item),
     package #>> '{sections,labResults,0,content,value}')
     from (select current_setting('ref.package')::jsonb as package) answered));
select pg_temp.expect('1i a diagnosis carries no free-text note', 'false',
  (select (current_setting('ref.package')::jsonb #> '{sections,diagnoses,0,content}' ? 'notes')::text));

-- The control on (support's audited command).
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform();
select platform.admin_set_control('cross_facility_referrals_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_referrals_enabled'), 'REF-1 suite opens referrals between facilities');
reset role;

-- 2. The refusals of route 2, in order.
set local role hid_ehr_api_runtime;
select pg_temp.expect('2a patientAgreed false', 'attestation_required',
  pg_temp.send(11, 1, 1, 'health_id', 2, agreed => false));
select pg_temp.expect('2b a member without the patient''s access', 'consent_required', pg_temp.send(15, 1, 1, 'health_id', 2));
select pg_temp.expect('2c another patient''s visit', 'visit_invalid', pg_temp.send(11, 1, 2, 'health_id', 2));
select pg_temp.expect('2d a visit with no signed note', 'visit_not_signed', pg_temp.send(11, 1, 5, 'health_id', 2));
select pg_temp.expect('2e an unknown record (ID-7)', 'patient_not_identified', pg_temp.send(11, 3, 3, 'printed', null));
select pg_temp.expect('2f an older agreement wording', 'attestation_outdated',
  pg_temp.send(11, 1, 1, 'health_id', 2, version => 'referral-health-id-attestation-v0'));
select pg_temp.expect('2g the printed wording for a Health ID referral', 'attestation_outdated',
  pg_temp.send(11, 1, 1, 'health_id', 2, version => 'referral-printed-attestation-v1'));
select pg_temp.expect('2h no app account (Q-REF-7 A)', 'patient_app_required', pg_temp.send(11, 2, 2, 'health_id', 2));
select pg_temp.expect('2i the same patient by printed letter', 'printed', pg_temp.send(11, 2, 2, 'printed', null));
select pg_temp.expect('2j a deny directive naming the destination', 'patient_denied', pg_temp.send(11, 4, 4, 'health_id', 2));
select pg_temp.expect('2k a laboratory is not a destination', 'destination_unavailable', pg_temp.send(11, 1, 1, 'health_id', 4));
select pg_temp.expect('2l this facility is not a destination', 'destination_unavailable', pg_temp.send(11, 1, 1, 'health_id', 1));
select pg_temp.expect('2m C has no member who may receive (no referral code at C? DC holds it): C is a destination',
  'sent', pg_temp.send(11, 1, 8, 'health_id', 3));
select set_config('ref.to_c', current_setting('ref.last'), true);
reset role;
select pg_temp.expect('2n each refusal is audited as denied, naming no reason',
  'attestation_required,attestation_outdated,consent_required,control_off,destination_unavailable,patient_app_required,patient_denied,patient_not_identified,visit_invalid,visit_not_signed',
  (select string_agg(distinct details ->> 'refusal', ',' order by details ->> 'refusal') from audit.events
    where action = 'ehr.referral.send' and outcome = 'denied' and correlation_id like 'ref1-suite-%'));
select pg_temp.expect('2o no referral row was written by a refusal', '3',
  (select count(*)::text from ehr.referrals));

-- 3. The package: each kind's eligibility.
set local role hid_ehr_api_runtime;
select pg_temp.expect('3a another patient''s diagnosis', 'package_invalid',
  pg_temp.send(11, 1, 1, 'health_id', 2, array['e9f52000-0000-4000-8000-000000000003']::uuid[]));
select pg_temp.expect('3b a refuted diagnosis', 'package_invalid',
  pg_temp.send(11, 1, 1, 'health_id', 2, array['e9f52000-0000-4000-8000-000000000002']::uuid[]));
select pg_temp.expect('3c a medicine that ended yesterday', 'package_invalid',
  pg_temp.send(11, 1, 1, 'health_id', 2, prescriptions => array['e9f53000-0000-4000-8000-000000000002']::uuid[]));
select pg_temp.expect('3d a reading 40 days old', 'package_invalid',
  pg_temp.send(11, 1, 1, 'health_id', 2, vitals => array['e9f55000-0000-4000-8000-000000000002']::uuid[]));
select pg_temp.expect('3e a reading entered in error', 'package_invalid',
  pg_temp.send(11, 1, 1, 'health_id', 2, vitals => array['e9f55000-0000-4000-8000-000000000003']::uuid[]));
select pg_temp.expect('3f a lab result not released', 'package_invalid',
  pg_temp.send(11, 1, 1, 'health_id', 2, labs => array['e9f56500-0000-4000-8000-000000000002']::uuid[]));
select pg_temp.expect('3g a duplicate', 'package_invalid',
  pg_temp.send(11, 1, 1, 'health_id', 2, array['e9f52000-0000-4000-8000-000000000001',
    'e9f52000-0000-4000-8000-000000000001']::uuid[]));
select pg_temp.expect('3h an id that is not a diagnosis', 'package_invalid',
  pg_temp.send(11, 1, 1, 'health_id', 2, array['e9f53000-0000-4000-8000-000000000001']::uuid[]));

-- 4. A referral to a facility on Health ID.
select pg_temp.expect('4a sent', 'sent', pg_temp.send(11, 1, 1, 'health_id', 2,
  array['e9f52000-0000-4000-8000-000000000001']::uuid[], array['e9f53000-0000-4000-8000-000000000001']::uuid[],
  array['e9f54000-0000-4000-8000-000000000001']::uuid[], array['e9f55000-0000-4000-8000-000000000001']::uuid[],
  array['e9f56500-0000-4000-8000-000000000001']::uuid[], idem => 'ref1-main-referral-key'));
select set_config('ref.main', current_setting('ref.last'), true);
reset role;
select pg_temp.expect('4b respond_by is sent + 168 hours; reference from the id; 5 items', '168:00:00|t|5',
  (select concat_ws('|', (respond_by - sent_at)::text, (reference = upper(left(replace(id::text, '-', ''), 8)))::text,
     package_item_count) from ehr.referrals where id = current_setting('ref.main')::uuid));
select pg_temp.expect('4c the patient''s notice: codes, ids and facility names only', 'REFERRAL_SENT|referral|destinationName,printed,referralId,referringFacilityName',
  (select concat_ws('|', notification_code, resource_type,
     (select string_agg(key, ',' order by key) from jsonb_object_keys(metadata) key))
     from notification.inbox_items where resource_id = current_setting('ref.main')::uuid));
set local role hid_ehr_api_runtime;
select pg_temp.expect('4d the same key and body again: the first answer', 'sent (replayed)',
  pg_temp.send(11, 1, 1, 'health_id', 2,
    array['e9f52000-0000-4000-8000-000000000001']::uuid[], array['e9f53000-0000-4000-8000-000000000001']::uuid[],
    array['e9f54000-0000-4000-8000-000000000001']::uuid[], array['e9f55000-0000-4000-8000-000000000001']::uuid[],
    array['e9f56500-0000-4000-8000-000000000001']::uuid[], idem => 'ref1-main-referral-key'));
select pg_temp.expect('4e the replay names the same referral', current_setting('ref.main'), current_setting('ref.last'));
select pg_temp.expect('4f the same key, another body', 'key_reused',
  pg_temp.send(11, 1, 1, 'health_id', 2, idem => 'ref1-main-referral-key', reason => 'Another reason entirely'));
select pg_temp.expect('4g urgent: respond by 24 hours', 'sent', pg_temp.send(11, 1, 7, 'health_id', 2, urgency => 'urgent'));
select set_config('ref.urgent', current_setting('ref.last'), true);
reset role;
select pg_temp.expect('4h urgent respond_by', '24:00:00',
  (select (respond_by - sent_at)::text from ehr.referrals where id = current_setting('ref.urgent')::uuid));
set local role hid_ehr_api_runtime;
-- The per-visit limit: EP4 (visit 8) has one; four more printed letters, then the sixth is refused.
select pg_temp.send(11, 1, 8, 'printed', null) from generate_series(1, 4);
select pg_temp.expect('4i the sixth referral from one visit', 'visit_limit', pg_temp.send(11, 1, 8, 'printed', null));

-- 5. The receiving facility.
select pg_temp.as_staff(21);
select pg_temp.expect('5a incoming: urgent first, at preview, sex and age only', 'urgent,routine|preview,preview|null|null|47|female|true|null|null',
  (select concat_ws('|', string_agg(card ->> 'urgency', ',' order by ord), string_agg(card ->> 'viewLevel', ',' order by ord),
     max(card #>> '{patient,fullName}') filter (where ord = 2), max(card ->> 'encounterId') filter (where ord = 2),
     max(card #>> '{patient,ageYearsAtSend}') filter (where ord = 2), max(card #>> '{patient,sexAtSend}') filter (where ord = 2),
     (max(card ->> 'reason') filter (where ord = 2) is not null)::text,
     coalesce(max(card ->> 'packageSummary') filter (where ord = 2), 'null'),
     coalesce(max(card #>> '{referrer,membershipId}') filter (where ord = 2), 'null'))
     from ehr.referral_incoming_list()));
select pg_temp.expect('5b the counts', '2 1 false',
  (select waiting_count || ' ' || urgent_count || ' ' || has_more from ehr.referral_incoming_list() limit 1));
select pg_temp.expect('5c read before acceptance: preview, no package', 'found|preview|not_accepted|null',
  (select concat_ws('|', outcome, referral ->> 'viewLevel', package_hidden, coalesce(package::text, 'null'))
     from ehr.referral_read(current_setting('ref.main')::uuid)));
select pg_temp.as_staff(31);
select pg_temp.expect('5d a third facility: not found, and its incoming holds only its own', 'not_found|1',
  (select outcome from ehr.referral_read(current_setting('ref.main')::uuid)) || '|'
  || (select count(*) from ehr.referral_incoming_list()));
select pg_temp.as_staff(22);
do $$
begin
  perform ehr.referral_incoming_list();
  raise exception 'the front desk listed incoming referrals';
exception when insufficient_privilege then
  perform pg_temp.expect('5e the front desk does not receive referrals', 'REFERRAL_NOT_ALLOWED', sqlerrm);
end $$;
select pg_temp.as_staff(21);
select pg_temp.expect('5f accept with a stale version', 'changed',
  (select outcome from ehr.referral_accept(current_setting('ref.main')::uuid, 7, null, pg_temp.key(), pg_temp.sha())));
select pg_temp.expect('5g accept', 'accepted|full|Ngozi Referone|null|null|5',
  (select concat_ws('|', outcome, referral ->> 'viewLevel', referral #>> '{patient,fullName}',
     coalesce(referral ->> 'encounterId', 'null'), coalesce(referral #>> '{referrer,membershipId}', 'null'),
     (select sum((section.value -> 'count')::integer) from jsonb_array_elements(referral -> 'packageSummary') section))
     from ehr.referral_accept(current_setting('ref.main')::uuid, 1, 'Please come to the Tuesday clinic.', pg_temp.key(),
       pg_temp.sha())));
reset role;
select pg_temp.expect('5h arrive_by = acceptance + 90 days, access_ends_at = acceptance + 120 days', '90 days|120 days',
  (select (arrive_by - accepted_at)::text || '|' || (access_ends_at - accepted_at)::text from ehr.referrals
    where id = current_setting('ref.main')::uuid));
set local role hid_ehr_api_runtime;
select pg_temp.expect('5i accept again: no longer waiting', 'not_pending',
  (select outcome from ehr.referral_accept(current_setting('ref.main')::uuid, 2, null, pg_temp.key(), pg_temp.sha())));
select pg_temp.expect('5j read after acceptance: full with the package', 'full|5|Heart murmur|Please come to the Tuesday clinic.',
  (select concat_ws('|', referral ->> 'viewLevel',
     jsonb_array_length(package #> '{sections,diagnoses}') + jsonb_array_length(package #> '{sections,medicines}')
       + jsonb_array_length(package #> '{sections,allergies}') + jsonb_array_length(package #> '{sections,vitals}')
       + jsonb_array_length(package #> '{sections,labResults}'),
     package #>> '{sections,diagnoses,0,content,display}', referral ->> 'acceptNote')
     from ehr.referral_read(current_setting('ref.main')::uuid)));
select pg_temp.expect('5k the receiver still cannot read the chart', '0',
  (select count(*)::text from ehr.diagnoses where patient_id = 'e9f30000-0000-4000-8000-000000000001'));
-- The control off: metadata, no package; accept and arrival refused (423); decline still works (8).
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform();
select platform.admin_set_control('cross_facility_referrals_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_referrals_enabled'), 'REF-1 suite switches referrals off');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(21);
select pg_temp.expect('5l control off: metadata, no patient or reason, the package hidden',
  'metadata|null|null|access_ended|null',
  (select concat_ws('|', referral ->> 'viewLevel', coalesce(referral ->> 'patient', 'null'),
     coalesce(referral ->> 'reason', 'null'), package_hidden, coalesce(package::text, 'null'))
     from ehr.referral_read(current_setting('ref.main')::uuid)));
select pg_temp.expect('5m control off: accept refused', 'control_off',
  (select outcome from ehr.referral_accept(current_setting('ref.urgent')::uuid, 1, null, pg_temp.key(), pg_temp.sha())));
select pg_temp.as_staff(22);
select pg_temp.expect('5n control off: the expected list is empty', '0',
  (select count(*)::text from ehr.referral_expected_list()));
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform();
select platform.admin_set_control('cross_facility_referrals_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_referrals_enabled'), 'REF-1 suite opens referrals again');
reset role;

-- 6. Arrival.
-- Search results (0132) for the front desk at B: one for Q (another patient), one for P.
insert into identity.patient_search_refs (token_sha256, patient_id, account_id, membership_id, facility_id,
  purpose_of_use, search_mode, created_at, expires_at)
select encode(sha256(convert_to(token, 'UTF8')), 'hex'), patient::uuid, 'e9f10000-0000-4000-8000-000000000022',
  'e9f13000-0000-4000-8000-000000000022', 'e9f21000-0000-4000-8000-000000000002', 'direct-care', 'standard',
  clock_timestamp(), clock_timestamp() + interval '10 minutes'
  from (values ('psr_' || repeat('Q', 43), 'e9f30000-0000-4000-8000-000000000005'),
               ('psr_' || repeat('P', 43), 'e9f30000-0000-4000-8000-000000000001')) refs(token, patient);
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(22);
select pg_temp.expect('6a expected arrivals: name and last 4, no reason', 'Ngozi Referone|ATPX|false|Fictional General Hospital',
  (select concat_ws('|', item #>> '{patient,fullName}', item #>> '{patient,healthIdLast4}', (item ? 'reason')::text,
     item ->> 'referringFacilityName') from ehr.referral_expected_list()));
select pg_temp.expect('6b another patient''s search result', 'needs_search',
  (select outcome from ehr.referral_arrive(current_setting('ref.main')::uuid, 2, 'psr_' || repeat('Q', 43), null,
     pg_temp.key(), pg_temp.sha())));
select pg_temp.expect('6c the patient id of a patient not this facility''s own', 'needs_search',
  (select outcome from ehr.referral_arrive(current_setting('ref.main')::uuid, 2, null,
     'e9f30000-0000-4000-8000-000000000001', pg_temp.key(), pg_temp.sha())));
select pg_temp.as_staff(23);
do $$
begin
  perform ehr.referral_arrive(current_setting('ref.main')::uuid, 2, 'psr_' || repeat('P', 43), null, pg_temp.key(),
    pg_temp.sha());
  raise exception 'a nurse marked an arrival';
exception when insufficient_privilege then
  perform pg_temp.expect('6d a nurse holds no arrival code', 'REFERRAL_ARRIVAL_NOT_ALLOWED', sqlerrm);
end $$;
select pg_temp.as_staff(22);
select pg_temp.expect('6e the referral''s patient from this member''s search: checked in, basis search',
  'checked_in|arrived|search|Ngozi Referone',
  (select concat_ws('|', outcome, referral ->> 'state', entry ->> 'check_in_basis', entry ->> 'full_name')
     from ehr.referral_arrive(current_setting('ref.main')::uuid, 2, 'psr_' || repeat('P', 43), null, pg_temp.key(),
       pg_temp.sha())));
reset role;
select pg_temp.expect('6f the waiting-list row is 0135''s and the referral keeps it', 'search|search|1',
  (select concat_ws('|', referral.arrival_basis, entry.check_in_basis,
     (select count(*) from audit.events where action = 'ehr.visit-queue.check-in' and outcome = 'success'
        and resource_id = entry.id::text))
     from ehr.referrals referral join ehr.visit_queue entry on entry.id = referral.visit_queue_entry_id
    where referral.id = current_setting('ref.main')::uuid));

-- 7. Complete.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(21);
select pg_temp.expect('7a did not attend after arrival', 'outcome_invalid',
  (select outcome from ehr.referral_complete(current_setting('ref.main')::uuid, 3, 'did_not_attend',
     'The patient was seen in clinic today.', pg_temp.key(), pg_temp.sha())));
select pg_temp.expect('7b seen, care returns to the referrer', 'completed|completed|seen_care_returned',
  (select concat_ws('|', outcome, referral ->> 'state', referral #>> '{outcome,code}')
     from ehr.referral_complete(current_setting('ref.main')::uuid, 3, 'seen_care_returned',
       'Echo normal. Continue amlodipine; review in 3 months.', pg_temp.key(), pg_temp.sha())));
reset role;
select pg_temp.expect('7c access ends 14 days after completion', '14 days',
  (select (access_ends_at - completed_at)::text from ehr.referrals where id = current_setting('ref.main')::uuid));
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11);
select pg_temp.expect('7d the counter-referral at the referring facility, and the history',
  'full|Echo normal. Continue amlodipine; review in 3 months.|sent,accepted,arrived,completed|t',
  (select concat_ws('|', referral ->> 'viewLevel', referral #>> '{outcome,feedbackNote}',
     (select string_agg(step ->> 'kind', ',') from jsonb_array_elements(history) step),
     (select bool_and((step ->> 'side' = 'referring') = (step ->> 'byMembershipId' is not null))
        from jsonb_array_elements(history) step)::text)
     from ehr.referral_read(current_setting('ref.main')::uuid)));
select pg_temp.expect('7e the sent list leaves out the reason and notes', 'false|false',
  (select (card ? 'reason' and card ->> 'reason' is not null)::text || '|'
          || (card #>> '{outcome,feedbackNote}' is not null)::text
     from ehr.referral_sent_list(null, 50, null) where card ->> 'referralId' = current_setting('ref.main')));
select pg_temp.expect('7f the visit''s referrals (route 8)', '1',
  (select count(*)::text from ehr.referral_patient_list('e9f30000-0000-4000-8000-000000000001',
     'e9f50000-0000-4000-8000-000000000001') where card ->> 'referralId' = current_setting('ref.main')));
select pg_temp.as_staff(15);
select pg_temp.expect('7g route 8 without the patient''s access', 'consent_required',
  (select outcome from ehr.referral_patient_list('e9f30000-0000-4000-8000-000000000001', null)));
select pg_temp.as_staff(11);
select pg_temp.expect('7h the letter: every print audited, never the Health ID',
  'found|1 Referral Road, Ikeja, Lagos|false',
  (select concat_ws('|', outcome, letter ->> 'referringFacilityAddress',
     (referral::text like '%HID-REFPATPX%')::text) from ehr.referral_letter(current_setting('ref.printed')::uuid)));

-- 8. Decline, withdraw, the patient's withdraw, expiry, the visit entered in error.
select pg_temp.as_staff(21);
select pg_temp.expect('8a decline needs a note', 'reason_required',
  (select outcome from ehr.referral_decline(current_setting('ref.urgent')::uuid, 1, 'no_capacity', 'short',
     pg_temp.key(), pg_temp.sha())));
select pg_temp.expect('8b decline', 'declined|declined|no_capacity',
  (select concat_ws('|', outcome, referral ->> 'state', referral #>> '{decline,reasonCode}')
     from ehr.referral_decline(current_setting('ref.urgent')::uuid, 1, 'no_capacity',
       'No cardiology clinic slots for two months.', pg_temp.key(), pg_temp.sha())));
select pg_temp.as_staff(11);
select pg_temp.expect('8c the referrer sees the decline note', 'No cardiology clinic slots for two months.',
  (select referral #>> '{decline,note}' from ehr.referral_read(current_setting('ref.urgent')::uuid)));
-- A new referral, withdrawn by the referring facility; another, withdrawn by the patient.
select pg_temp.send(11, 1, 7, 'health_id', 2);
select set_config('ref.withdraw', current_setting('ref.last'), true);
select pg_temp.expect('8d withdraw sent in error needs a note', 'reason_required',
  (select outcome from ehr.referral_withdraw(current_setting('ref.withdraw')::uuid, 1, 'sent_in_error', null,
     pg_temp.key(), pg_temp.sha())));
select pg_temp.expect('8e withdraw', 'withdrawn|referring_facility',
  (select concat_ws('|', outcome, referral #>> '{withdrawal,by}')
     from ehr.referral_withdraw(current_setting('ref.withdraw')::uuid, 1, 'sent_in_error',
       'Sent to the wrong hospital by mistake.', pg_temp.key(), pg_temp.sha())));
select pg_temp.send(11, 1, 7, 'health_id', 2);
select set_config('ref.patient_withdraw', current_setting('ref.last'), true);
select pg_temp.as_patient();
select pg_temp.expect('8f the portal list: reason and counts, no letter or note', 'true|false|false|true',
  (select concat_ws('|', (item ->> 'reason' is not null)::text, (item ? 'letterText')::text,
     (item ? 'feedbackNote')::text, (item ->> 'canWithdraw')::text) from ehr.referral_my_list()
    where item ->> 'referralId' = current_setting('ref.patient_withdraw')));
select pg_temp.expect('8g the patient withdraws before acceptance', 'withdrawn|2',
  (select outcome || '|' || row_version from ehr.referral_my_withdraw(current_setting('ref.patient_withdraw')::uuid, 1)));
select pg_temp.expect('8h a printed letter cannot be withdrawn by the patient', 'not_pending',
  (select outcome from ehr.referral_my_withdraw(current_setting('ref.printed')::uuid, 1)));
select pg_temp.as_staff(21);
select pg_temp.expect('8i the receiver sees "withdrawn by the patient"', 'withdrawn|patient|metadata',
  (select concat_ws('|', referral ->> 'state', referral #>> '{withdrawal,by}', referral ->> 'viewLevel')
     from ehr.referral_read(current_setting('ref.patient_withdraw')::uuid)));
reset role;
-- Expiry: a sent referral moved 8 days back (owner SQL, the guard off for the fixture).
set local role hid_ehr_api_runtime;
select pg_temp.send(11, 1, 7, 'health_id', 2);
select set_config('ref.expired', current_setting('ref.last'), true);
reset role;
set local session_replication_role = replica;
update ehr.referrals set sent_at = sent_at - interval '8 days', respond_by = respond_by - interval '8 days'
 where id = current_setting('ref.expired')::uuid;
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(21);
select pg_temp.expect('8j past respond_by: expired, not answered, not in incoming', 'expired|not_answered|0',
  (select concat_ws('|', referral ->> 'effectiveState', referral ->> 'endedKind',
     (select count(*) from ehr.referral_incoming_list() listed where listed.card ->> 'referralId' = current_setting('ref.expired')))
     from ehr.referral_read(current_setting('ref.expired')::uuid)));
select pg_temp.expect('8k accept after respond_by', 'expired',
  (select outcome from ehr.referral_accept(current_setting('ref.expired')::uuid, 1, null, pg_temp.key(), pg_temp.sha())));
select pg_temp.expect('8l a late decline still reaches the referrer', 'declined',
  (select outcome from ehr.referral_decline(current_setting('ref.expired')::uuid, 1, 'other',
     'Answered late after a holiday closure.', pg_temp.key(), pg_temp.sha())));
-- The visit entered in error ends the read at once.
select pg_temp.as_staff(11);
select pg_temp.send(11, 1, 7, 'health_id', 2, array['e9f52000-0000-4000-8000-000000000001']::uuid[]);
select set_config('ref.eie', current_setting('ref.last'), true);
select pg_temp.as_staff(21);
select pg_temp.expect('8m accepted before the visit is entered in error', 'accepted',
  (select outcome from ehr.referral_accept(current_setting('ref.eie')::uuid, 1, null, pg_temp.key(), pg_temp.sha())));
reset role;
set local session_replication_role = replica;
update ehr.encounters set status = 'entered_in_error' where id = 'e9f50000-0000-4000-8000-000000000007';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(21);
select pg_temp.expect('8n the visit entered in error: withdrawn, metadata, no package',
  'withdrawn|visit_entered_in_error|metadata|access_ended',
  (select concat_ws('|', referral ->> 'effectiveState', referral ->> 'endedKind', referral ->> 'viewLevel', package_hidden)
     from ehr.referral_read(current_setting('ref.eie')::uuid)));
select pg_temp.as_patient();
select pg_temp.expect('8o the portal keeps the record, no content', 'true|null|null',
  (select concat_ws('|', item ->> 'enteredInError', coalesce(item ->> 'reason', 'null'),
     coalesce(item ->> 'sharedSections', 'null')) from ehr.referral_my_list()
    where item ->> 'referralId' = current_setting('ref.eie')));

-- 9. A source marked entered in error after sending: the frozen copy answers no content.
select pg_temp.as_staff(11);
update ehr.diagnoses set verification_status = 'entered_in_error' where id = 'e9f52000-0000-4000-8000-000000000001';
reset role;
select pg_temp.expect('9a the mark', '1', (select count(*)::text from ehr.referral_source_marks
  where item_kind = 'diagnosis' and source_id = 'e9f52000-0000-4000-8000-000000000001'));
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(21);
select pg_temp.expect('9b the receiver: entered in error since sent, no content (main referral, still readable)',
  'true|null',
  (select (package #>> '{sections,diagnoses,0,enteredInErrorSinceSent}') || '|'
          || coalesce(package #>> '{sections,diagnoses,0,content}', 'null')
     from ehr.referral_read(current_setting('ref.main')::uuid)));
reset role;

-- 10. The guard.
do $$
begin
  update ehr.referrals set reason = 'A changed reason here' where id = current_setting('ref.main')::uuid;
  raise exception 'a frozen column changed';
exception when object_not_in_prerequisite_state then
  perform pg_temp.expect('10a no frozen column changes', 'REFERRAL_STATE_ORDER', sqlerrm);
end $$;
do $$
begin
  update ehr.referrals set state = 'accepted', row_version = row_version + 1 where id = current_setting('ref.withdraw')::uuid;
  raise exception 'a closed referral moved';
exception when object_not_in_prerequisite_state then
  perform pg_temp.expect('10b no step out of order', 'REFERRAL_STATE_ORDER', sqlerrm);
end $$;
do $$
begin
  update ehr.referrals set state = 'declined', declined_at = clock_timestamp(), reason = 'A changed reason here',
    declined_by_membership_id = 'e9f13000-0000-4000-8000-000000000021',
    declined_by_account_id = 'e9f10000-0000-4000-8000-000000000021', decline_reason_code = 'other',
    decline_note = 'Changed with the decline', row_version = row_version + 1
   where id = current_setting('ref.to_c')::uuid;
  raise exception 'a frozen column changed with a step';
exception when object_not_in_prerequisite_state then
  perform pg_temp.expect('10c a frozen column with a step', 'REFERRAL_FROZEN', sqlerrm);
end $$;
do $$
begin
  insert into ehr.referral_package_items (referral_id, position, item_kind, source_id, source_version, content)
  values (current_setting('ref.main')::uuid, 5, 'diagnosis', gen_random_uuid(), 1, '{}');
  raise exception 'an item was added after sending';
exception when object_not_in_prerequisite_state then
  perform pg_temp.expect('10d no item after sending', 'REFERRAL_PACKAGE_CLOSED', sqlerrm);
end $$;
do $$
begin
  delete from ehr.referrals where id = current_setting('ref.main')::uuid;
  raise exception 'a referral was deleted';
exception when object_not_in_prerequisite_state then
  perform pg_temp.expect('10e no delete', 'ehr.referrals is append-only', sqlerrm);
end $$;
do $$
begin
  truncate ehr.referral_events;
  raise exception 'the history was truncated';
exception when object_not_in_prerequisite_state then
  perform pg_temp.expect('10f no truncate', 'ehr.referral_events is append-only', sqlerrm);
end $$;
do $$
begin
  update ehr.referral_package_items set content = '{"changed": true}' where referral_id = current_setting('ref.main')::uuid;
  raise exception 'a package item changed';
exception when object_not_in_prerequisite_state then
  perform pg_temp.expect('10g the package is append-only', 'ehr.referral_package_items is append-only', sqlerrm);
end $$;
select pg_temp.expect('10h no runtime role reads a REF-1 table', 'false|false|false',
  has_table_privilege('hid_ehr_runtime', 'ehr.referrals', 'select')::text || '|'
  || has_table_privilege('hid_identity_runtime', 'ehr.referral_package_items', 'select')::text || '|'
  || has_function_privilege('hid_ehr_runtime', 'ehr.referral_package(uuid)', 'execute')::text);

-- 11. The directory, support's lookup and listing lever.
set local role hid_identity_api_runtime;
select pg_temp.as_staff(11);
select pg_temp.expect('11a the directory finds B with its departments, never L or A', 'Fictional Teaching Hospital|general_outpatient,cardiology',
  (select string_agg(facility_name || '|' || array_to_string(departments, ','), ';')
     from identity.search_referral_destinations('Fictional Teaching')));
select pg_temp.expect('11b the laboratory is not listed', '0',
  (select count(*)::text from identity.search_referral_destinations('Fictional Laboratory')));
select pg_temp.as_platform();
select pg_temp.expect('11c support: B listed by default and eligible', 'true|true|true',
  (select listed || '|' || by_default || '|' || eligible_now
     from identity.admin_referral_destination('e9f21000-0000-4000-8000-000000000002')));
select pg_temp.expect('11d support unlists B', 'false|false|false',
  (select listed || '|' || by_default || '|' || eligible_now
     from identity.admin_set_referral_destination('e9f21000-0000-4000-8000-000000000002', false,
       'Teaching hospital asked to pause referrals')));
select pg_temp.expect('11e support finds a referral by reference: no patient or content', '1|false',
  (select count(*)::text || '|' || bool_or(to_jsonb(found)::text like '%Ngozi%')::text
     from identity.admin_find_referrals((select reference::text from ehr.referrals
       where id = current_setting('ref.main')::uuid), null) found));
select pg_temp.expect('11f by Health ID (a body field)', 'true',
  ((select count(*) from identity.admin_find_referrals(null, 'HID-REFPATPX')) >= 5)::text);
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.expect('11g a send to the unlisted facility', 'destination_unavailable', pg_temp.send(11, 1, 1, 'health_id', 2));
reset role;

-- 12. Audit and notices: no name, Health ID, reason, letter, note or content in any REF-1 audit row or notice.
select pg_temp.expect('12a the audit rows hold no names, reasons, letters or notes', '0',
  (select count(*)::text from audit.events
    where (action like 'ehr.referral.%' or action like 'admin.referral%' or action like 'identity.referral%')
      and (details::text ~* '(Ngozi|Referone|HID-REF|heart murmur|Dear colleague|Tuesday clinic|Echo normal|No cardiology|wrong hospital|Outside Clinic|Ibadan|Penicillin)')));
select pg_temp.expect('12b the notices hold no department, reason or urgency', '0',
  (select count(*)::text from notification.inbox_items
    where resource_type = 'referral' and metadata::text ~* '(cardiology|heart murmur|urgent|routine)'));
select pg_temp.expect('12c each list shown audits a row per referral', 'true',
  ((select count(*) from audit.events where action = 'ehr.referral.incoming-list.shown') >= 2)::text);

select current_setting('ref.passed') as passed \gset
\echo 'referrals suite: ' :passed ' cases passed'
rollback;
