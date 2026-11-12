\set ON_ERROR_STOP on
-- The sealed QA tenant (0123, owner decision Q60 of 2026-11-12). Rollback-only.
-- On the databases CI and the release rehearsals use (plain PostgreSQL, no
-- rds_superuser) 0123 installs the seal and not the seed, so this suite calls
-- identity.sealed_qa_install() itself, as the owner, inside its transaction
-- (and identity.sealed_demo_install() too, so that all three sides exist:
-- real, demo and QA).
--   1. structure: identity.sealed_qa_members (RLS enabled, not forced, one
--      owner policy, no grant, no update, delete or TRUNCATE); the helpers'
--      ACLs (sealed_qa_ids and sealed_qa_facility to the Identity and schema
--      test runtimes only, nothing to any other runtime); the twelve
--      triggers; the registration-read policy with its demo and QA clauses;
--      identity.sealed_qa_recipient (the owner's domain, plus-addresses, any
--      case; no other domain, subdomain, lookalike, list, '' or null);
--   2. the install's refusals before the tenant exists, each writing nothing
--      (an address held by a real account in any case or a staff record:
--      SEALED_QA_ADDRESS_TAKEN; a Health ID or facility code held by a real
--      row: SEALED_QA_KEY_TAKEN; a real row at a fixed id:
--      SEALED_QA_ID_TAKEN); then D10, the demo patient logins' move (put
--      back on patient1@ and patient2@ as production has them, with a
--      password and a session: the QA seed refuses while they hold them; the
--      move refuses a new address held by an account, staff record, open
--      application or pending staff invitation, a login on neither address,
--      a patient record with an email of its own, a demo patient's live email
--      emergency contact or pending share invitation to an old address, each
--      moving nothing; a partly moved state moves the rest;
--      then it moves both to patientdemo1@ and patientdemo2@, address only,
--      the session live, one count-only audit row, a second call moves
--      nothing, the demo seed stays idempotent); then the install: counts,
--      the nine logins pending_reset without a password and with a verified
--      address (the QA patients at patient1@ and patient2@),
--      the one seeded share (grant, share row, one migration audit row, no
--      audit row with a patient or person as actor), Patient Two without a
--      share, a second call inserts nothing;
--   3. the platform overview: the same counts before and after the install;
--   4. the boundary in every direction (QA to real, real to QA, QA to demo,
--      demo to QA) and real to demo spot-checked (0098 unchanged): Health ID
--      lookups (access request, break-glass, PIN: an unknown Health ID's
--      answer), a direct consent grant, a staff membership, a patient's
--      share, the order directory and send, the share directory, share
--      invitation acceptance, and identity.patients' registration read by
--      Health ID and by name;
--   5. QA-only rules: no platform role, no QoreID quota, no phone; share
--      invitations, email change and emergency contacts (the check C and
--      G7q) to the owner's domain only; the demo branch of C keeps its three
--      exact mailboxes (patientdemo1@ and patientdemo2@ now), and a demo
--      patient cannot invite patient1@ or patient2@;
--   6. outreach (G8q): a QA organiser's group (name "QA ...") becomes QA, its
--      organiser's membership accepted; another name is refused; a real
--      organiser's group stays real (even when named "QA ..."); a QA account
--      joins no real group;
--   7. within QA: the seeded share opens Patient One's chart, a request, the
--      PIN, a share and an invitation work, an order from QA Hospital to QA
--      Laboratory is sent and accepted; then another install inserts
--      nothing;
--   8. a member is never both demo and QA (SEALED_QA_DEMO_OVERLAP).
-- Synthetic values only: the real tenant uses uuid prefix a123 and
-- @example.invalid addresses (plus an invented gmail.com address that is only
-- ever refused); the recovery uses the repository's non-hash placeholder,
-- never a password or a hash.
set plpgsql.variable_conflict = error;
begin;
set constraints all deferred;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;
update platform.control_settings set enabled = true
 where control_key in ('cross_facility_orders_enabled', 'outreach_organiser_signup_enabled');
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'sealed-qa-test'), ('emergency', 'Emergency', 'sealed-qa-test')
  on conflict (code) do update set active = true;

-- Helpers (as the demo suite's): an assertion, a statement's outcome ('ok' or
-- SQLSTATE and message), a value or the error, the contexts the services set.
create function pg_temp.assert(label text, condition boolean, detail text default null)
returns void language plpgsql as $f$
begin
  if condition is not true then
    raise exception 'sealed qa: % failed%', label, coalesce(': ' || detail, '');
  end if;
end
$f$;
create function pg_temp.try(statement text)
returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.value_of(statement text)
returns text language plpgsql as $f$
declare answer text;
begin
  execute statement into answer;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.as_staff(subject text, membership uuid, facility uuid, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', subject, true),
    set_config('app.membership_id', coalesce(membership::text, ''), true),
    set_config('app.facility_id', coalesce(facility::text, ''), true),
    set_config('app.correlation_id', 'sealed-qa-' || substr(md5(random()::text), 1, 12), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true),
    set_config('app.session_id', '', true),
    set_config('app.account_id', '', true);
$f$;
create function pg_temp.as_patient(subject text, account uuid, session uuid, patient uuid)
returns void language sql as $f$
  select set_config('app.actor_subject', subject, true),
    set_config('app.account_id', account::text, true),
    set_config('app.session_id', session::text, true),
    set_config('app.patient_id', patient::text, true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '5 minutes')::text, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'sealed-qa-patient-' || substr(md5(random()::text), 1, 12), true),
    set_config('app.purpose_of_use', 'patient-self', true);
$f$;
create function pg_temp.as_system()
returns void language sql as $f$
  select set_config('app.actor_subject', 'system:auth', true),
    set_config('app.correlation_id', 'sealed-qa-system-' || substr(md5(random()::text), 1, 12), true),
    set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
    set_config('app.purpose_of_use', '', true), set_config('app.patient_id', '', true);
$f$;
-- The three sides' actors. QA staff: account n (1 clinician, 2 migrate, 3 lab1,
-- 4 lab2, 5 pharmacist, 6 admin, 7 outreach), membership suffix ('11' the
-- clinician at QA Hospital, '31' lab1 at QA Laboratory, '61' the admin at QA
-- Hospital), facility n (1 QA Hospital, 2 QA Laboratory, 3 QA Pharmacy).
create function pg_temp.as_qa_staff(account_n integer, membership text, facility_n integer,
  purpose text default 'direct-care')
returns void language sql as $f$
  select pg_temp.as_staff('sealed-qa:c0a00003-0000-4000-8000-00000000000' || account_n,
    ('c0a00005-0000-4000-8000-0000000000' || membership)::uuid,
    ('c0a00002-0000-4000-8000-00000000000' || facility_n)::uuid, purpose);
$f$;
create function pg_temp.as_qa_clinician(purpose text default 'direct-care')
returns void language sql as $f$
  select pg_temp.as_qa_staff(1, '11', 1, purpose);
$f$;
create function pg_temp.as_qa_patient(n integer)
returns void language sql as $f$
  select pg_temp.as_patient('patient:c0a00008-0000-4000-8000-00000000000' || n,
    ('c0a00008-0000-4000-8000-00000000000' || n)::uuid, ('a123000b-0000-4000-8000-00000000002' || n)::uuid,
    ('c0a00009-0000-4000-8000-00000000000' || n)::uuid);
$f$;
create function pg_temp.as_demo_staff(site integer, purpose text default 'direct-care')
returns void language sql as $f$
  select pg_temp.as_staff('sealed-demo:98d00003-0000-4000-8000-000000000001',
    ('98d00005-0000-4000-8000-00000000000' || site)::uuid, ('98d00002-0000-4000-8000-00000000000' || site)::uuid, purpose);
$f$;
create function pg_temp.as_demo_patient(n integer)
returns void language sql as $f$
  select pg_temp.as_patient('patient:98d00008-0000-4000-8000-00000000000' || n,
    ('98d00008-0000-4000-8000-00000000000' || n)::uuid, ('a123000b-0000-4000-8000-00000000001' || n)::uuid,
    ('98d00009-0000-4000-8000-00000000000' || n)::uuid);
$f$;
create function pg_temp.as_real_doctor(purpose text default 'direct-care')
returns void language sql as $f$
  select pg_temp.as_staff('synthetic:qa-suite:doctor', 'a1230005-0000-4000-8000-000000000001',
    'a1230002-0000-4000-8000-000000000001', purpose);
$f$;
create function pg_temp.as_real_patient()
returns void language sql as $f$
  select pg_temp.as_patient('synthetic:qa-suite:patient', 'a1230008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000001', 'a1230009-0000-4000-8000-000000000001');
$f$;
create function pg_temp.as_platform_admin()
returns void language sql as $f$
  select pg_temp.as_staff('synthetic:qa-suite:admin', null, null, 'healthcare-operations');
$f$;
-- The patient's emergency contact command, its outcome.
create function pg_temp.add_contact(subject text, session uuid, contact uuid, channel text, hmac text)
returns text language sql as $f$
  select pg_temp.try(format('select identity.add_my_emergency_contact(%L, %L, %L, ''parent'', %L, '
    || 'decode(repeat(''ab'', 40), ''hex''), ''sealed-test-v1'', %L, true)', subject, session, contact, channel, hmac));
$f$;
-- The platform overview, as one text value (run as the platform administrator).
create function pg_temp.overview()
returns text language sql as $f$
  select pg_temp.value_of($q$select row(registered_patients, facilities, verified_facilities, suspended_facilities,
    active_memberships, pending_identity_reviews)::text from identity.admin_platform_overview()$q$);
$f$;
-- A direct consent grant (owner SQL), its outcome.
create function pg_temp.direct_grant(patient uuid, staff uuid, account uuid, membership uuid, facility uuid)
returns text language sql as $f$
  select pg_temp.try(format($q$insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id,
    facility_id, scope, status, reason, starts_at, expires_at, break_glass, purpose_of_use)
    values (gen_random_uuid(), %L, %L, %L, %L, %L, 'read_records', 'active', 'Owner SQL across the boundary',
      clock_timestamp(), clock_timestamp() + interval '1 day', false, 'direct-care')$q$,
    patient, staff, account, membership, facility));
$f$;
-- A staff membership (owner SQL), its outcome.
create function pg_temp.direct_membership(staff uuid, account uuid, organization uuid, facility uuid)
returns text language sql as $f$
  select pg_temp.try(format($q$insert into identity.staff_facility_memberships (id, staff_id, account_id,
    organization_id, facility_id, membership_role, app_role, is_primary, active)
    values (gen_random_uuid(), %L, %L, %L, %L, 'doctor', 'doctor', false, true)$q$, staff, account, organization, facility));
$f$;
-- An invitation's acceptance written directly (owner SQL), its outcome.
create function pg_temp.direct_accept(invitation uuid, membership uuid, account uuid)
returns text language sql as $f$
  select pg_temp.try(format($q$update identity.patient_share_invitations set status = 'accepted',
    accepted_at = clock_timestamp(), accepted_membership_id = %L, accepted_account_id = %L,
    row_version = row_version + 1 where id = %L$q$, membership, account, invitation));
$f$;

-- The real tenant: hospital R (governed), laboratory RL (governed, product
-- laboratory), doctor RD at R (doctor), lab scientist RLM at RL, a platform
-- administrator RA, and patient RP with a login, a live session and a PIN; RD
-- holds a write consent for RP at R, and has an encounter and a draft lab
-- request for RP.
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at) values
  ('a1230003-0000-4000-8000-000000000001', 'synthetic:qa-suite:doctor', 'qa-suite-doctor@example.invalid', 'Real Doctor', 'active', clock_timestamp()),
  ('a1230003-0000-4000-8000-000000000002', 'synthetic:qa-suite:lab', 'qa-suite-lab@example.invalid', 'Real Lab', 'active', clock_timestamp()),
  ('a1230003-0000-4000-8000-000000000009', 'synthetic:qa-suite:admin', 'qa-suite-admin@example.invalid', 'Real Admin', 'active', clock_timestamp()),
  ('a1230008-0000-4000-8000-000000000001', 'synthetic:qa-suite:patient', 'qa-suite-patient@example.invalid', 'Real Patient', 'active', clock_timestamp());
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('a1230006-0000-4000-8000-000000000099', 'a1230003-0000-4000-8000-000000000009', 'platform_super_admin', 'platform',
   'Sealed QA suite administrator');
insert into identity.organizations (id, name, slug) values
  ('a1230001-0000-4000-8000-000000000001', 'Suite Real Hospital Ltd', 'suite-real-hospital'),
  ('a1230001-0000-4000-8000-000000000002', 'Suite Real Diagnostics Ltd', 'suite-real-diagnostics');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('a1230002-0000-4000-8000-000000000001', 'a1230001-0000-4000-8000-000000000001', 'Suite Real Hospital', 'SQR-HOSP',
   'Africa/Lagos', true, 'verified'),
  ('a1230002-0000-4000-8000-000000000002', 'a1230001-0000-4000-8000-000000000002', 'Suite Real Laboratory', 'SQR-LAB',
   'Africa/Lagos', true, 'verified');
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, verified_at,
  organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at, verified_organization_name)
values
  ('a1230007-0000-4000-8000-000000000001', 'ehr', 'Suite Real Hospital Ltd', 'hospital', 'RC1231001', 'Real Admin',
   'qa-suite-admin@example.invalid', 'approved', 'verified', clock_timestamp(), 'a1230001-0000-4000-8000-000000000001',
   'a1230002-0000-4000-8000-000000000001', 'a1230003-0000-4000-8000-000000000009', 'Governed approval for the suite',
   clock_timestamp(), 'Suite Real Hospital Ltd'),
  ('a1230007-0000-4000-8000-000000000002', 'laboratory', 'Suite Real Diagnostics Ltd', 'laboratory', 'RC1231002',
   'Real Admin', 'qa-suite-admin@example.invalid', 'approved', 'verified', clock_timestamp(),
   'a1230001-0000-4000-8000-000000000002', 'a1230002-0000-4000-8000-000000000002', 'a1230003-0000-4000-8000-000000000009',
   'Governed approval for the suite', clock_timestamp(), 'Suite Real Diagnostics Ltd');
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id) values
  ('a1230001-0000-4000-8000-000000000001', 'ehr', 'a1230002-0000-4000-8000-000000000001', 'active', 'a1230007-0000-4000-8000-000000000001'),
  ('a1230001-0000-4000-8000-000000000002', 'laboratory', 'a1230002-0000-4000-8000-000000000002', 'active', 'a1230007-0000-4000-8000-000000000002');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('a1230004-0000-4000-8000-000000000001', 'a1230003-0000-4000-8000-000000000001', 'Remi Suitedoctor', 'qa-suite-doctor@example.invalid', 'verified', 'doctor'),
  ('a1230004-0000-4000-8000-000000000002', 'a1230003-0000-4000-8000-000000000002', 'Lola Suitelab', 'qa-suite-lab@example.invalid', 'verified', 'lab');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id, membership_role,
  app_role, is_primary, active) values
  ('a1230005-0000-4000-8000-000000000001', 'a1230004-0000-4000-8000-000000000001', 'a1230003-0000-4000-8000-000000000001',
   'a1230001-0000-4000-8000-000000000001', 'a1230002-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true),
  ('a1230005-0000-4000-8000-000000000002', 'a1230004-0000-4000-8000-000000000002', 'a1230003-0000-4000-8000-000000000002',
   'a1230001-0000-4000-8000-000000000002', 'a1230002-0000-4000-8000-000000000002', 'lab', 'lab', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('a1230006-0000-4000-8000-000000000011', 'a1230003-0000-4000-8000-000000000001', 'doctor', 'facility',
   'a1230005-0000-4000-8000-000000000001', 'a1230002-0000-4000-8000-000000000001', 'Sealed QA suite doctor'),
  ('a1230006-0000-4000-8000-000000000021', 'a1230003-0000-4000-8000-000000000002', 'lab', 'facility',
   'a1230005-0000-4000-8000-000000000002', 'a1230002-0000-4000-8000-000000000002', 'Sealed QA suite lab scientist');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('a1230009-0000-4000-8000-000000000001', 'a1230008-0000-4000-8000-000000000001', 'HID-SQRPAT', 'Rafa', 'Suitepatient',
   'Rafa Suitepatient', 'male', '1980-02-02', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('a123000b-0000-4000-8000-000000000001', 'a1230008-0000-4000-8000-000000000001', 'a123000b-0000-4000-8000-000000000001',
   md5('sealed-qa-real') || md5('sealed-qa-real'), gen_random_uuid(), 1, 'password', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'a1230009-0000-4000-8000-000000000001');
insert into identity.patient_access_pins (patient_id, pin_hash, source_system, source_record_id, source_created_at,
  source_updated_at)
values ('a1230009-0000-4000-8000-000000000001', crypt('2468', gen_salt('bf', 6)), 'supabase', 'sealed-qa-real-pin',
  clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use) values
  ('a123000c-0000-4000-8000-000000000001', 'a1230009-0000-4000-8000-000000000001', 'a1230004-0000-4000-8000-000000000001',
   'a1230003-0000-4000-8000-000000000001', 'a1230005-0000-4000-8000-000000000001', 'a1230002-0000-4000-8000-000000000001',
   'write_records', 'active', 'Sealed QA suite consent', clock_timestamp() - interval '1 hour',
   clock_timestamp() + interval '30 days', false, 'direct-care');
set local role hid_ehr_api_runtime;
select pg_temp.as_real_doctor();
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('a123000d-0000-4000-8000-000000000001', 'a1230009-0000-4000-8000-000000000001',
  'a1230002-0000-4000-8000-000000000001', 'a1230003-0000-4000-8000-000000000001',
  'a1230005-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
values ('a123000e-0000-4000-8000-000000000001', 'a123000d-0000-4000-8000-000000000001',
  'a1230009-0000-4000-8000-000000000001', 'a1230002-0000-4000-8000-000000000001',
  'a1230003-0000-4000-8000-000000000001', 'a1230005-0000-4000-8000-000000000001', 'http://loinc.org', '718-7',
  'Haemoglobin', 'urgent', 'draft', 'whole-blood', 'Tiredness for two weeks');
reset role;

do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;

-- 1. Structure.
do $$
begin
  perform pg_temp.assert('the members table: RLS enabled and not forced, one owner policy, no grant',
    (select relation.relrowsecurity and not relation.relforcerowsecurity from pg_class relation
      where relation.oid = 'identity.sealed_qa_members'::regclass)
    and (select count(*) from pg_policy policy_row where policy_row.polrelid = 'identity.sealed_qa_members'::regclass) = 1
    and not exists (select 1 from pg_class relation, aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                     where relation.oid = 'identity.sealed_qa_members'::regclass and acl.grantee <> relation.relowner));
  perform pg_temp.assert('no runtime role reads or writes the members',
    not exists (select 1 from pg_roles runtime where runtime.rolname ~ '^hid_' and not runtime.rolsuper
      and runtime.oid <> (select relation.relowner from pg_class relation where relation.oid = 'identity.sealed_qa_members'::regclass)
      and (has_table_privilege(runtime.oid, 'identity.sealed_qa_members', 'SELECT')
        or has_table_privilege(runtime.oid, 'identity.sealed_qa_members', 'INSERT'))));
  perform pg_temp.assert('helper ACLs: sealed_qa_ids and sealed_qa_facility to the Identity and schema test runtimes only',
    (select count(*) from pg_proc proc
      where proc.pronamespace = 'identity'::regnamespace
        and (proc.proname like 'sealed\_qa\_%' or proc.proname like '%\_sealed\_qa' or proc.proname = 'demo_members_never_qa')) = 17
    and (select array_agg(proc.oid::regprocedure::text order by proc.oid::regprocedure::text)
           from pg_proc proc
          where proc.pronamespace = 'identity'::regnamespace
            and (proc.proname like 'sealed\_qa\_%' or proc.proname like '%\_sealed\_qa' or proc.proname = 'demo_members_never_qa')
            and has_function_privilege('hid_identity_runtime', proc.oid, 'EXECUTE'))
      = array['identity.sealed_qa_facility(uuid)', 'identity.sealed_qa_ids(text)']
    and (select array_agg(proc.oid::regprocedure::text order by proc.oid::regprocedure::text)
           from pg_proc proc
          where proc.pronamespace = 'identity'::regnamespace
            and (proc.proname like 'sealed\_qa\_%' or proc.proname like '%\_sealed\_qa' or proc.proname = 'demo_members_never_qa')
            and has_function_privilege('hid_schema_test_runtime', proc.oid, 'EXECUTE'))
      = array['identity.sealed_qa_facility(uuid)', 'identity.sealed_qa_ids(text)']
    and not exists (select 1 from pg_proc proc, pg_roles runtime
                     where proc.pronamespace = 'identity'::regnamespace
                       and (proc.proname like 'sealed\_qa\_%' or proc.proname like '%\_sealed\_qa'
                            or proc.proname = 'demo_members_never_qa')
                       and runtime.rolname in ('hid_ehr_runtime', 'hid_lab_runtime', 'hid_pharmacy_runtime',
                         'hid_notification_runtime', 'hid_outreach_runtime', 'hid_ocr_runtime',
                         'hid_ehr_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime',
                         'hid_notification_api_runtime', 'hid_outreach_api_runtime', 'hid_ocr_api_runtime')
                       and has_function_privilege(runtime.oid, proc.oid, 'EXECUTE'))
    and not has_function_privilege('hid_identity_api_runtime', 'identity.sealed_qa_install()', 'EXECUTE')
    and not has_function_privilege('hid_identity_api_runtime', 'identity.sealed_qa_patient(uuid)', 'EXECUTE')
    and not has_function_privilege('hid_identity_api_runtime', 'identity.sealed_qa_account(uuid)', 'EXECUTE')
    and not has_function_privilege('hid_identity_api_runtime', 'identity.sealed_qa_recipient(text)', 'EXECUTE'));
  perform pg_temp.assert('the thirteen QA triggers, enabled',
    (select count(*) from pg_trigger trigger_row where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
      and (trigger_row.tgrelid::regclass::text, trigger_row.tgname) in (
        ('identity.sealed_qa_members', 'sealed_qa_members_immutable'),
        ('identity.sealed_qa_members', 'sealed_qa_members_no_truncate'),
        ('identity.sealed_qa_members', 'sealed_qa_members_not_demo'),
        ('identity.sealed_demo_members', 'demo_members_never_qa'),
        ('identity.consent_grants', 'consent_grants_sealed_qa'),
        ('identity.staff_facility_memberships', 'staff_memberships_sealed_qa'),
        ('auth.account_roles', 'account_roles_sealed_qa'),
        ('identity.patient_share_invitations', 'patient_share_invitations_sealed_qa'),
        ('identity.patient_contact_changes', 'patient_contact_changes_sealed_qa'),
        ('platform.qoreid_quota_counters', 'qoreid_quota_counters_sealed_qa'),
        ('identity.patient_emergency_contacts', 'patient_emergency_contacts_sealed_qa'),
        ('identity.outreach_organisations', 'outreach_organisations_sealed_qa'),
        ('identity.outreach_invitations', 'outreach_invitations_sealed_qa'))) = 13);
  perform pg_temp.assert('0098''s nine triggers are still there, enabled',
    (select count(*) from pg_trigger trigger_row where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
      and trigger_row.tgname in ('sealed_demo_members_immutable', 'sealed_demo_members_no_truncate',
        'consent_grants_sealed_demo', 'staff_memberships_sealed_demo', 'account_roles_sealed_demo',
        'patient_share_invitations_sealed_demo', 'patient_contact_changes_sealed_demo',
        'qoreid_quota_counters_sealed_demo', 'patient_emergency_contacts_sealed_demo')) = 9);
  perform pg_temp.assert('the registration read holds the demo clause and the QA clause; six policies',
    (select count(*) from pg_policy policy_row where policy_row.polrelid = 'identity.patients'::regclass) = 6
    and (select pg_get_expr(policy_row.polqual, policy_row.polrelid) from pg_policy policy_row
          where policy_row.polrelid = 'identity.patients'::regclass and policy_row.polname = 'patients_registration_read')
      like '%sealed_demo_ids(''patient''::text)%sealed_demo_facility(platform.current_facility_id())%'
        || 'sealed_qa_ids(''patient''::text)%sealed_qa_facility(platform.current_facility_id())%');
  perform pg_temp.assert('each replaced body holds the QA clause beside the demo clause',
    (select count(*) from pg_proc proc
      where proc.oid in ('identity.create_access_request(text,text,text,integer)'::regprocedure,
              'identity.activate_break_glass(text,text,integer)'::regprocedure,
              'identity.access_patient_with_pin(text,text,integer)'::regprocedure,
              'ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)'::regprocedure,
              'identity.search_order_destinations(text,text)'::regprocedure,
              'identity.search_share_providers(text,uuid,text)'::regprocedure,
              'identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)'::regprocedure,
              'identity.admin_platform_overview()'::regprocedure,
              'identity.sealed_demo_contact_allowed(text,uuid,text,text,character)'::regprocedure)
        and position('sealed_qa_' in proc.prosrc) > 0 and position('sealed_demo_' in proc.prosrc) > 0) = 9);
  perform pg_temp.assert('the nine replaced bodies are 0123''s, byte for byte',
    (select count(*) from (values
      ('identity.create_access_request(text,text,text,integer)', '2745e91d666f16a6ad79019d31f0380a'),
      ('identity.activate_break_glass(text,text,integer)', '585d55fe4f7b5773cea96ae8729cc99c'),
      ('identity.access_patient_with_pin(text,text,integer)', 'e9efafc9b624940931cb47838c38ac5a'),
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', '0c2def2b530bcb3d68537ade52787b6b'),
      ('identity.search_order_destinations(text,text)', 'da222fe1b63db757a1ddb93fdc9eabf0'),
      ('identity.search_share_providers(text,uuid,text)', '26ca190255ddc1ff30adb2fb5f0ee347'),
      ('identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)',
       'f7659b71a9240050c36d67f41ddf0890'),
      ('identity.admin_platform_overview()', 'c38a354bb38bd4e60f293dd69165506c'),
      ('identity.sealed_demo_contact_allowed(text,uuid,text,text,character)', 'f7bd015c0053621e2e18689abe886139'))
        pinned(signature, digest)
      join pg_proc proc on proc.oid = pinned.signature::regprocedure and md5(proc.prosrc) = pinned.digest) = 9);
  perform pg_temp.assert('the QA recipient: the owner''s domain, plus-addresses, any case, outer blanks trimmed',
    identity.sealed_qa_recipient('operations+qa-x@healthidentitydirectory.com')
    and identity.sealed_qa_recipient('Operations+QA-X@HealthIdentityDirectory.COM')
    and identity.sealed_qa_recipient('  patient1+qa@healthidentitydirectory.com  ')
    and identity.sealed_qa_recipient('patient1@healthidentitydirectory.com')
    and identity.sealed_qa_recipient('operations@healthidentitydirectory.com'));
  perform pg_temp.assert('the QA recipient: printable ASCII only, no percent sign',
    not identity.sealed_qa_recipient('a@healthİdentitydirectory.com')
    and not identity.sealed_qa_recipient('ops+qа@healthidentitydirectory.com')
    and not identity.sealed_qa_recipient('x%evil.example@healthidentitydirectory.com'));
  perform pg_temp.assert('the QA recipient: no other domain, subdomain, lookalike, list, empty or null',
    not identity.sealed_qa_recipient('qa.suite.someone@gmail.com')
    and not identity.sealed_qa_recipient('a@sub.healthidentitydirectory.com')
    and not identity.sealed_qa_recipient('patient1@healthidentitydirectory.com.evil.example')
    and not identity.sealed_qa_recipient('patient1@healthidentitydirectory.co')
    and not identity.sealed_qa_recipient('patient1@xhealthidentitydirectory.com')
    and not identity.sealed_qa_recipient('patient1@healthidentitydirectoryXcom')
    and not identity.sealed_qa_recipient('a@healthidentitydirectory.com, b@healthidentitydirectory.com')
    and not identity.sealed_qa_recipient('a@healthidentitydirectory.com;b@healthidentitydirectory.com')
    and not identity.sealed_qa_recipient('a@example.invalid@healthidentitydirectory.com')
    and not identity.sealed_qa_recipient('@healthidentitydirectory.com')
    and not identity.sealed_qa_recipient('a b@healthidentitydirectory.com')
    and not identity.sealed_qa_recipient('a@healthidentitydirectory.com' || chr(10))
    and not identity.sealed_qa_recipient('')
    and not identity.sealed_qa_recipient(null));
  perform pg_temp.assert('nothing seeded by the migration here (not Amazon RDS)',
    not exists (select 1 from identity.sealed_qa_members)
    and not exists (select 1 from audit.events where correlation_id = '0123-sealed-qa-install'));
end $$;
set local role hid_identity_api_runtime;
select pg_temp.as_real_doctor();
select pg_temp.assert('the Identity runtime reads no member row',
  pg_temp.try('select count(*) from identity.sealed_qa_members') like '42501 %');
select pg_temp.assert('the Identity runtime plans its Health ID lookup under the sealed policy',
  pg_temp.try($q$explain select id from identity.patients where upper(hid_code) = upper('HID-SQRPAT') and status = 'active'$q$) = 'ok');
reset role;
-- The members are never updated, deleted or truncated (a savepoint undoes the
-- probe row).
savepoint immutable_probe;
insert into identity.sealed_qa_members values ('facility', 'a1230002-0000-4000-8000-000000000001');
select pg_temp.assert('a member row is never updated or deleted, the members never truncated',
  pg_temp.try($q$delete from identity.sealed_qa_members where member_id = 'a1230002-0000-4000-8000-000000000001'$q$)
    like '55000 %'
  and pg_temp.try($q$update identity.sealed_qa_members set member_kind = 'patient'
    where member_id = 'a1230002-0000-4000-8000-000000000001'$q$) like '55000 %'
  and pg_temp.try('truncate identity.sealed_qa_members') = '55000 identity.sealed_qa_members is append-only'
  and identity.sealed_qa_facility('a1230002-0000-4000-8000-000000000001'));
rollback to savepoint immutable_probe;
select pg_temp.assert('the probe row is gone', not exists (select 1 from identity.sealed_qa_members));

-- 2a. The install's refusals, before the tenant exists: each in a savepoint,
-- each 55000, and nothing written.
create function pg_temp.refused(label text, expected text)
returns void language plpgsql as $f$
declare answer text := pg_temp.try('select identity.sealed_qa_install()');
begin
  perform pg_temp.assert(label, answer = '55000 0123: ' || expected, answer);
  perform pg_temp.assert(label || ': nothing written',
    not exists (select 1 from identity.sealed_qa_members)
    and not exists (select 1 from identity.organizations where slug like 'sealed-qa-%')
    and not exists (select 1 from auth.accounts where id = 'c0a00003-0000-4000-8000-000000000001')
    and not exists (select 1 from identity.patients where id = 'c0a00009-0000-4000-8000-000000000001')
    and not exists (select 1 from audit.events where correlation_id = '0123-sealed-qa-install'));
end
$f$;
savepoint refusal;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('a1230003-0000-4000-8000-000000000031', 'synthetic:qa-suite:taken', 'lab@healthidentitydirectory.com',
   'Taken Login', 'active');
select pg_temp.refused('a real account at a QA staff address', 'SEALED_QA_ADDRESS_TAKEN');
rollback to savepoint refusal;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('a1230003-0000-4000-8000-000000000031', 'synthetic:qa-suite:taken', 'Patient2@HealthIdentityDirectory.com',
   'Taken Login', 'pending_reset');
select pg_temp.refused('a real account at a QA patient address in another case', 'SEALED_QA_ADDRESS_TAKEN');
rollback to savepoint refusal;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('a1230003-0000-4000-8000-000000000031', 'synthetic:qa-suite:staff-elsewhere', 'qa-suite-elsewhere@example.invalid',
   'Staff Elsewhere', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('a1230004-0000-4000-8000-000000000031', 'a1230003-0000-4000-8000-000000000031', 'Staff Elsewhere',
   'admin@healthidentitydirectory.com', 'verified', 'doctor');
select pg_temp.refused('a real staff record at a QA address', 'SEALED_QA_ADDRESS_TAKEN');
rollback to savepoint refusal;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('a1230009-0000-4000-8000-000000000031', 'HID-ZQAAAAA2', 'Taken', 'Healthid', 'Taken Healthid', 'active');
select pg_temp.refused('a real patient holds a QA Health ID', 'SEALED_QA_KEY_TAKEN');
rollback to savepoint refusal;
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('a1230002-0000-4000-8000-000000000031', 'a1230001-0000-4000-8000-000000000001', 'A Real Annex', 'QA-HOSPITAL',
   'Africa/Lagos', true, 'verified');
select pg_temp.refused('a real facility holds a QA facility code', 'SEALED_QA_KEY_TAKEN');
rollback to savepoint refusal;
insert into identity.organizations (id, name, slug) values
  ('c0a00001-0000-4000-8000-000000000002', 'Not The QA Laboratory', 'not-the-qa-laboratory');
select pg_temp.refused('a real row at a fixed id', 'SEALED_QA_ID_TAKEN');
rollback to savepoint refusal;
select pg_temp.assert('the savepoint left no QA row', not exists (select 1 from identity.sealed_qa_members));

-- The demo tenant, so that all three sides exist; then the overview as the
-- platform administrator sees it before the QA install.
select identity.sealed_demo_install();

-- 2a'. D10, the demo patient logins' move. After 0123 the demo seeds its
-- patients at patientdemo1@ and patientdemo2@; production's demo was seeded
-- before 0123 at patient1@ and patient2@, so the suite puts them back there
-- (owner SQL), with a password and a live session on Patient One, then moves
-- them as section 10 does.
select pg_temp.assert('after 0123 the demo seeds its patient logins at the new addresses',
  (select array_agg(lower(account.email) order by account.id) from auth.accounts account
    where account.id in ('98d00008-0000-4000-8000-000000000001', '98d00008-0000-4000-8000-000000000002'))
  = array['patientdemo1@healthidentitydirectory.com', 'patientdemo2@healthidentitydirectory.com']);
update auth.accounts set email = 'patient1@healthidentitydirectory.com', status = 'active',
       password_hash = '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('d', 22) || '$' || repeat('e', 43),
       password_algorithm = 'argon2id', token_version = 4
 where id = '98d00008-0000-4000-8000-000000000001';
update auth.accounts set email = 'Patient2@HealthIdentityDirectory.com'
 where id = '98d00008-0000-4000-8000-000000000002';
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('a123000b-0000-4000-8000-000000000091', '98d00008-0000-4000-8000-000000000001', 'a123000b-0000-4000-8000-000000000091',
   md5('sealed-qa-demo-move') || md5('m'), gen_random_uuid(), 4, 'password', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   '98d00009-0000-4000-8000-000000000001');
create temp table demo_logins_before as
select account.id, account.password_hash, account.password_algorithm, account.token_version, account.status,
       account.email_verified_at, account.subject, account.row_version
  from auth.accounts account
 where account.id in ('98d00008-0000-4000-8000-000000000001', '98d00008-0000-4000-8000-000000000002');
select pg_temp.assert('before the move the QA seed refuses: patient1@ and patient2@ are the demo''s',
  pg_temp.try('select identity.sealed_qa_install()') = '55000 0123: SEALED_QA_ADDRESS_TAKEN');

-- The move's refusals: each 55000, nothing moved, no audit row.
create function pg_temp.move_refused(label text, expected text)
returns void language plpgsql as $f$
declare answer text := pg_temp.try('select identity.demo_patient_logins_move()');
begin
  perform pg_temp.assert(label, answer = '55000 0123: ' || expected, answer);
  perform pg_temp.assert(label || ': nothing moved',
    (select array_agg(lower(account.email) order by account.id) from auth.accounts account
      where account.id in ('98d00008-0000-4000-8000-000000000001', '98d00008-0000-4000-8000-000000000002'))
      = array['patient1@healthidentitydirectory.com', 'patient2@healthidentitydirectory.com']
    and not exists (select 1 from audit.events where correlation_id = '0123-demo-patient-logins'));
end
$f$;
savepoint move_refusal;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('a1230003-0000-4000-8000-000000000041', 'synthetic:qa-suite:demo-taken', 'PatientDemo1@HealthIdentityDirectory.com',
   'Taken Demo Address', 'pending_reset');
select pg_temp.move_refused('a real account at a new demo address in another case', 'DEMO_PATIENT_ADDRESS_TAKEN');
rollback to savepoint move_refusal;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('a1230003-0000-4000-8000-000000000041', 'synthetic:qa-suite:demo-staff', 'qa-suite-demo-staff@example.invalid',
   'Demo Staff Elsewhere', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('a1230004-0000-4000-8000-000000000041', 'a1230003-0000-4000-8000-000000000041', 'Demo Staff Elsewhere',
   'patientdemo2@healthidentitydirectory.com', 'verified', 'doctor');
select pg_temp.move_refused('a real staff record at a new demo address', 'DEMO_PATIENT_ADDRESS_TAKEN');
rollback to savepoint move_refusal;
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status)
values ('a1230007-0000-4000-8000-000000000041', 'laboratory', 'Owner Lab Ltd', 'laboratory', 'RC1230041', 'Owner Admin',
  'patientdemo1@healthidentitydirectory.com', 'pending_verification');
select pg_temp.move_refused('an open application names a new demo address', 'DEMO_PATIENT_ADDRESS_TAKEN');
rollback to savepoint move_refusal;
insert into identity.staff_invitations (id, organization_id, facility_id, invited_by_account_id, invited_by_membership_id,
  invitee_name, invitee_email, role_code, licence_body, licence_number, attestation_version, attested_at,
  link_token_hmac, email_code_hmac, key_version, last_sent_at, last_send_id, expires_at, idempotency_key,
  request_sha256, correlation_id)
values ('a1230011-0000-4000-8000-000000000041', 'a1230001-0000-4000-8000-000000000001',
  'a1230002-0000-4000-8000-000000000001', 'a1230003-0000-4000-8000-000000000001',
  'a1230005-0000-4000-8000-000000000001', 'Owner Person', 'patientdemo2@healthidentitydirectory.com', 'receptionist', null,
  null, 'facility-staff-attestation-v1', clock_timestamp(), repeat('1', 64), repeat('2', 64), 'v1', clock_timestamp(),
  gen_random_uuid(), clock_timestamp() + interval '7 days', 'qa-suite-demo-move-invite', repeat('c', 64),
  'qa-suite-demo-move-invite');
select pg_temp.move_refused('a pending staff invitation to a new demo address', 'DEMO_PATIENT_ADDRESS_TAKEN');
rollback to savepoint move_refusal;
update auth.accounts set email = 'patient1+elsewhere@healthidentitydirectory.com'
 where id = '98d00008-0000-4000-8000-000000000001';
select pg_temp.assert('a demo patient login on neither address is refused, nothing moved',
  pg_temp.try('select identity.demo_patient_logins_move()') = '55000 0123: DEMO_PATIENT_LOGIN_UNEXPECTED'
  and (select lower(email) from auth.accounts where id = '98d00008-0000-4000-8000-000000000002')
      = 'patient2@healthidentitydirectory.com');
rollback to savepoint move_refusal;
update identity.patients set email_lookup_hmac = repeat('a', 64), email_ciphertext = decode(repeat('ab', 40), 'hex'),
       contact_key_version = coalesce(contact_key_version, 'sealed-test-v1')
 where id = '98d00009-0000-4000-8000-000000000002';
select pg_temp.move_refused('a demo patient record with an email of its own', 'DEMO_PATIENT_LOGIN_UNEXPECTED');
rollback to savepoint move_refusal;
-- A demo patient's live email emergency contact (before 0123 it could only be
-- operations@, patient1@ or patient2@) or pending share invitation to an old
-- address: refused, so nothing of the demo still points at a QA mailbox.
-- Fixture rows without triggers (session_replication_role = replica).
set local session_replication_role = replica;
insert into identity.patient_emergency_contacts (id, patient_id, created_by_account_id, relationship, channel,
  contact_ciphertext, contact_key_version, destination_hmac, notify_on_emergency_access, status)
values ('a1230010-0000-4000-8000-000000000041', '98d00009-0000-4000-8000-000000000001',
  '98d00008-0000-4000-8000-000000000001', 'sibling', 'email', decode(repeat('ab', 40), 'hex'), 'sealed-test-v1',
  repeat('7', 64), true, 'unverified');
set local session_replication_role = origin;
select pg_temp.move_refused('a demo patient''s live email emergency contact', 'DEMO_PATIENT_OLD_ADDRESS_IN_USE');
rollback to savepoint move_refusal;
set local session_replication_role = replica;
insert into identity.patient_emergency_contacts (id, patient_id, created_by_account_id, relationship, channel,
  contact_ciphertext, contact_key_version, destination_hmac, notify_on_emergency_access, status, deactivated_at,
  deactivation_reason)
values ('a1230010-0000-4000-8000-000000000042', '98d00009-0000-4000-8000-000000000001',
  '98d00008-0000-4000-8000-000000000001', 'sibling', 'email', null, null, null, true, 'deactivated',
  clock_timestamp(), 'patient_removed');
insert into identity.patient_share_invitations (id, reference, patient_id, invitee_email, level, duration_preset,
  status, expires_at, idempotency_key, request_sha256, delivery_outcome)
values ('a1230012-0000-4000-8000-000000000041', 'QAMVAAA2', '98d00009-0000-4000-8000-000000000001',
  'patient2@healthidentitydirectory.com', 'view_only', '24h', 'pending', clock_timestamp() + interval '1 day',
  'qa-suite-demo-move-share-0001', repeat('d', 64), 'sent');
set local session_replication_role = origin;
select pg_temp.move_refused('a demo patient''s pending share invitation to an old address',
  'DEMO_PATIENT_OLD_ADDRESS_IN_USE');
update identity.patient_share_invitations set status = 'cancelled', cancelled_at = clock_timestamp()
 where id = 'a1230012-0000-4000-8000-000000000041';
select pg_temp.assert('a deactivated contact and a cancelled invitation do not hold the move',
  identity.demo_patient_logins_move() = 2);
rollback to savepoint move_refusal;
-- Partly moved (one login already at its new address): the other moves.
update auth.accounts set email = 'patientdemo2@healthidentitydirectory.com'
 where id = '98d00008-0000-4000-8000-000000000002';
select pg_temp.assert('partly moved: only the login still on its old address moves',
  identity.demo_patient_logins_move() = 1);
select pg_temp.assert('partly moved: its audit row counts one',
  (select details from audit.events where correlation_id = '0123-demo-patient-logins') = '{"accountsMoved": 1}'::jsonb);
rollback to savepoint move_refusal;
select pg_temp.assert('nobody but the owner may move them',
  not has_function_privilege('hid_identity_api_runtime', 'identity.demo_patient_logins_move()', 'EXECUTE')
  and not has_function_privilege('hid_identity_runtime', 'identity.demo_patient_logins_move()', 'EXECUTE')
  and not has_function_privilege('hid_schema_test_runtime', 'identity.demo_patient_logins_move()', 'EXECUTE'));

-- The move, then a second call.
select pg_temp.assert('the move moves the two demo patient logins',
  identity.demo_patient_logins_move() = 2);
select pg_temp.assert('a second call moves nothing', identity.demo_patient_logins_move() = 0);
select pg_temp.assert('the demo patient logins are at patientdemo1@ and patientdemo2@; nothing else of them changed',
  (select array_agg(account.email order by account.id) from auth.accounts account
    where account.id in ('98d00008-0000-4000-8000-000000000001', '98d00008-0000-4000-8000-000000000002'))
    = array['patientdemo1@healthidentitydirectory.com', 'patientdemo2@healthidentitydirectory.com']
  and (select bool_and(account.password_hash is not distinct from before.password_hash
                       and account.password_algorithm is not distinct from before.password_algorithm
                       and account.token_version = before.token_version and account.status = before.status
                       and account.email_verified_at is not distinct from before.email_verified_at
                       and account.subject = before.subject and account.row_version = before.row_version + 1
                       and identity.sealed_demo_account(account.id) and not identity.sealed_qa_account(account.id))
         from auth.accounts account join demo_logins_before before on before.id = account.id) is true
  and (select password_algorithm = 'argon2id' and status = 'active' and token_version = 4
         from auth.accounts where id = '98d00008-0000-4000-8000-000000000001')
  and exists (select 1 from auth.sessions session_row
               where session_row.id = 'a123000b-0000-4000-8000-000000000091' and session_row.revoked_at is null
                 and session_row.account_token_version = 4)
  and (select array_agg(patient.hid_code order by patient.hid_code) from identity.patients patient
        where patient.account_id in ('98d00008-0000-4000-8000-000000000001', '98d00008-0000-4000-8000-000000000002')
          and identity.sealed_demo_patient(patient.id))
      = array['HID-ZDEMAAA2', 'HID-ZDEMAAA3']);
select pg_temp.assert('one audit row for the move, a count only (no address)',
  (select count(*) from audit.events where correlation_id = '0123-demo-patient-logins') = 1
  and (select details = '{"accountsMoved": 2}'::jsonb and actor_type = 'system' and patient_id is null
         and action = 'identity.sealed-demo.patient-logins-moved'
         from audit.events where correlation_id = '0123-demo-patient-logins'));
select pg_temp.assert('the demo seed is idempotent on the new addresses',
  (identity.sealed_demo_install()->>'inserted')::integer = 0);
drop table demo_logins_before;
set local role hid_identity_api_runtime;
select pg_temp.as_platform_admin();
select set_config('hid.test.overview_before', pg_temp.overview(), true);
reset role;
select pg_temp.assert('the overview answers before the install',
  current_setting('hid.test.overview_before') like '(%)', current_setting('hid.test.overview_before'));

-- 2b. The install (twice).
create temp table sealed_qa_install_1 as select identity.sealed_qa_install() as summary;
create temp table sealed_qa_install_2 as select identity.sealed_qa_install() as summary;
do $$
declare
  first jsonb := (select summary from sealed_qa_install_1);
  second jsonb := (select summary from sealed_qa_install_2);
begin
  perform pg_temp.assert('the first call inserts the tenant', (first->>'inserted')::integer > 0, first::text);
  perform pg_temp.assert('a second call inserts nothing and answers the same counts',
    (second->>'inserted')::integer = 0 and first - 'inserted' = second - 'inserted', second::text);
  perform pg_temp.assert('the counts',
    first - 'inserted' = '{"organizations": 3, "facilities": 3, "accounts": 9, "patients": 2, "memberships": 8, "shares": 1}'::jsonb,
    first::text);
  perform pg_temp.assert('members',
    (select array_agg(member_kind || ':' || n order by member_kind)
       from (select member_kind, count(*) n from identity.sealed_qa_members group by member_kind) counted)
    = array['account:9', 'facility:3', 'organization:3', 'patient:2']);
  perform pg_temp.assert('the three facilities, verified and active, Africa/Lagos',
    (select array_agg(facility.code || '|' || facility.name || '|' || organization.slug || '|' || facility.active
                      || '|' || facility.lifecycle_status || '|' || facility.timezone order by facility.code)
       from identity.facilities facility join identity.organizations organization on organization.id = facility.organization_id
      where identity.sealed_qa_facility(facility.id))
    = array['QA-HOSPITAL|QA Hospital|sealed-qa-hospital|true|verified|Africa/Lagos',
            'QA-LABORATORY|QA Laboratory|sealed-qa-laboratory|true|verified|Africa/Lagos',
            'QA-PHARMACY|QA Pharmacy|sealed-qa-pharmacy|true|verified|Africa/Lagos']);
  perform pg_temp.assert('nine accounts at the role and patient addresses, pending_reset, no password, email verified',
    (select array_agg(account.email || '|' || account.status || '|' || (account.password_hash is null)
                      || '|' || (account.password_algorithm is null) || '|' || (account.email_verified_at is not null)
                      order by account.email collate "C")
       from auth.accounts account where identity.sealed_qa_account(account.id))
    = array['admin@healthidentitydirectory.com|pending_reset|true|true|true',
            'ehr@healthidentitydirectory.com|pending_reset|true|true|true',
            'lab2@healthidentitydirectory.com|pending_reset|true|true|true',
            'lab@healthidentitydirectory.com|pending_reset|true|true|true',
            'migrate@healthidentitydirectory.com|pending_reset|true|true|true',
            'outreach@healthidentitydirectory.com|pending_reset|true|true|true',
            'patient1@healthidentitydirectory.com|pending_reset|true|true|true',
            'patient2@healthidentitydirectory.com|pending_reset|true|true|true',
            'pharmacy@healthidentitydirectory.com|pending_reset|true|true|true']);
  perform pg_temp.assert('seven verified staff records; eight memberships with their facility role; no platform role',
    (select count(*) from identity.staff staff where identity.sealed_qa_account(staff.account_id)
      and staff.verification_status = 'verified' and staff.active) = 7
    and (select array_agg(facility.code || ':' || membership.membership_role || ':' || account.email
                          order by facility.code collate "C", membership.membership_role collate "C",
                            account.email collate "C")
           from identity.staff_facility_memberships membership
           join identity.facilities facility on facility.id = membership.facility_id
           join auth.accounts account on account.id = membership.account_id
          where identity.sealed_qa_account(membership.account_id) and membership.active)
      = array['QA-HOSPITAL:clinician:migrate@healthidentitydirectory.com',
              'QA-HOSPITAL:doctor:ehr@healthidentitydirectory.com',
              'QA-HOSPITAL:org_admin:admin@healthidentitydirectory.com',
              'QA-LABORATORY:lab:lab2@healthidentitydirectory.com',
              'QA-LABORATORY:lab:lab@healthidentitydirectory.com',
              'QA-LABORATORY:org_admin:admin@healthidentitydirectory.com',
              'QA-PHARMACY:org_admin:admin@healthidentitydirectory.com',
              'QA-PHARMACY:pharmacist:pharmacy@healthidentitydirectory.com']
    and (select count(*) from auth.account_roles assignment
          where identity.sealed_qa_account(assignment.account_id) and assignment.scope_type = 'facility'
            and assignment.revoked_at is null) = 8
    and not exists (select 1 from auth.account_roles assignment
                     where identity.sealed_qa_account(assignment.account_id) and assignment.scope_type = 'platform')
    and not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.account_id = 'c0a00003-0000-4000-8000-000000000007'));
  perform pg_temp.assert('QA Laboratory and QA Pharmacy: an approved governed application and their product',
    (select array_agg(application.product_code || ':' || application.status || ':' || application.approval_mode
                      || ':' || product.status order by application.product_code)
       from identity.organization_applications application
       join identity.organization_products product on product.source_application_id = application.id
      where identity.sealed_qa_facility(application.facility_id))
    = array['laboratory:approved:admin_review:active', 'pharmacy:approved:admin_review:active']);
  perform pg_temp.assert('two patients with their logins, Health IDs and identifiers, no phone',
    (select array_agg(patient.hid_code || ':' || patient.full_name || ':' || account.email order by patient.hid_code)
       from identity.patients patient join auth.accounts account on account.id = patient.account_id
      where identity.sealed_qa_patient(patient.id) and patient.status = 'active'
        and patient.phone_e164_ciphertext is null and patient.phone_lookup_hmac is null)
    = array['HID-ZQAAAAA2:QA Patient One:patient1@healthidentitydirectory.com',
            'HID-ZQAAAAA3:QA Patient Two:patient2@healthidentitydirectory.com']
    and (select count(*) from identity.patient_identifiers identifier
          where identity.sealed_qa_patient(identifier.patient_id) and identifier.identifier_type = 'hid_code'
            and identifier.verified) = 2
    and (select count(*) from identity.patient_assurance_states assurance
          where identity.sealed_qa_patient(assurance.patient_id) and assurance.state = 'CONTACT_VERIFIED') = 2);
  perform pg_temp.assert('QA Patient One shares with the clinician''s doctor membership at QA Hospital, once; Patient Two has no share',
    (select array_agg(grant_row.patient_id::text || '|' || grant_row.membership_id || '|' || facility.code || '|'
                      || grant_row.scope || '|' || grant_row.purpose_of_use || '|' || grant_row.status || '|'
                      || (grant_row.expires_at - grant_row.starts_at) || '|'
                      || (grant_row.granted_by_patient_id = grant_row.patient_id) || '|' || share.level || '|'
                      || share.duration_preset || '|' || share.created_via || '|' || grant_row.source_system)
       from identity.consent_grants grant_row
       join identity.patient_consent_shares share on share.consent_grant_id = grant_row.id
       join identity.facilities facility on facility.id = grant_row.facility_id
      where identity.sealed_qa_patient(grant_row.patient_id))
    = array['c0a00009-0000-4000-8000-000000000001|c0a00005-0000-4000-8000-000000000011|QA-HOSPITAL|write_records|'
            || 'direct-care|active|365 days|true|clinical_collaboration|until_revoked|search|hid']
    and not exists (select 1 from identity.consent_grants grant_row
                     where grant_row.patient_id = 'c0a00009-0000-4000-8000-000000000002'));
  perform pg_temp.assert('one migration audit row for the share and one for the install; no person as actor',
    (select count(*) from audit.events event where event.action = 'identity.sealed-qa.seed-share') = 1
    and (select event.actor_type = 'system' and event.provenance = 'migration' and event.source_system = 'hid-sealed-qa'
                and event.patient_id = 'c0a00009-0000-4000-8000-000000000001'
                and event.facility_id = 'c0a00002-0000-4000-8000-000000000001'
                and event.resource_id = (select grant_row.id::text from identity.consent_grants grant_row
                                          where grant_row.correlation_id = '0123-sealed-qa-install')
           from audit.events event where event.action = 'identity.sealed-qa.seed-share')
    and (select count(*) from audit.events event where event.action = 'identity.sealed-qa.install') = 1
    and (select count(*) from audit.events event where event.correlation_id = '0123-sealed-qa-install') = 2
    and not exists (select 1 from audit.events event
                     where event.correlation_id = '0123-sealed-qa-install'
                       and (event.actor_type <> 'system'
                         or num_nonnulls(event.actor_subject, event.actor_account_id, event.actor_membership_id) > 0
                         or event.details::text ~ '(@|HID-)'))
    and not exists (select 1 from audit.events event
                     where identity.sealed_qa_account(event.actor_account_id)
                        or (event.actor_type = 'patient' and identity.sealed_qa_patient(event.patient_id))));
end $$;

-- 3. The platform overview counts no QA row: the same before and after.
set local role hid_identity_api_runtime;
select pg_temp.as_platform_admin();
select pg_temp.assert('the platform overview is the same before and after the QA install',
  pg_temp.overview() = current_setting('hid.test.overview_before'),
  pg_temp.overview() || ' / ' || current_setting('hid.test.overview_before'));
reset role;

-- Recovery as the owner will do it (forgot-password to each mailbox, the code
-- verified, the repository's non-hash placeholder), for the nine QA and three
-- demo logins; then a live session for each QA and demo patient login.
insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac, verifier_key_version,
  expires_at, max_attempts, verified_at, completion_token_hmac, completion_expires_at, account_token_version)
select ('a123000f-0000-4000-8000-' || lpad(target.n::text, 12, '0'))::uuid, account.id,
  md5('qa-recipient-' || target.n) || md5('r' || target.n), 'PASSWORD_RESET', 'email',
  md5('qa-verifier-' || target.n) || md5('v' || target.n), 'sealed-test-v1', clock_timestamp() + interval '10 minutes', 5,
  clock_timestamp(), md5('qa-completion-' || target.n) || md5('c' || target.n), clock_timestamp() + interval '10 minutes',
  account.token_version
  from (select row_number() over (order by account.id) n, account.id from auth.accounts account
         where identity.sealed_qa_account(account.id) or identity.sealed_demo_account(account.id)) target
  join auth.accounts account on account.id = target.id;
set local role hid_identity_api_runtime;
select pg_temp.as_system();
select pg_temp.assert('recovery completes for the twelve logins',
  (select bool_and(auth.complete_recovery_otp(('a123000f-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
     'PASSWORD_RESET', md5('qa-completion-' || n) || md5('c' || n),
     '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43)))
     from generate_series(1, 12) n));
reset role;
select pg_temp.assert('after recovery the nine QA logins are active',
  (select count(*) from auth.accounts account where identity.sealed_qa_account(account.id) and account.status = 'active') = 9);
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select session_row.id, session_row.account_id, session_row.id, md5('sealed-qa-' || session_row.id) || md5('s'),
  gen_random_uuid(), account.token_version, 'password', clock_timestamp() - interval '1 minute',
  clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient', session_row.patient_id
  from (values
    ('a123000b-0000-4000-8000-000000000021'::uuid, 'c0a00008-0000-4000-8000-000000000001'::uuid, 'c0a00009-0000-4000-8000-000000000001'::uuid),
    ('a123000b-0000-4000-8000-000000000022', 'c0a00008-0000-4000-8000-000000000002', 'c0a00009-0000-4000-8000-000000000002'),
    ('a123000b-0000-4000-8000-000000000011', '98d00008-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000001'),
    ('a123000b-0000-4000-8000-000000000012', '98d00008-0000-4000-8000-000000000002', '98d00009-0000-4000-8000-000000000002')
  ) session_row(id, account_id, patient_id)
  join auth.accounts account on account.id = session_row.account_id;
-- A PIN for QA Patient Two (the test PIN 1357, made here), so that "the right
-- PIN across the boundary answers as a wrong one" means something.
insert into identity.patient_access_pins (patient_id, pin_hash, source_system, source_record_id, source_created_at,
  source_updated_at)
values ('c0a00009-0000-4000-8000-000000000002', crypt('1357', gen_salt('bf', 6)), 'supabase', 'sealed-qa-suite-pin',
  clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day');
-- The seeded shares (QA and demo) an hour old: the suite is one transaction,
-- whose CURRENT_TIMESTAMP, which the read gate compares grants with, precedes
-- the installs.
update identity.consent_grants set starts_at = starts_at - interval '1 hour'
 where correlation_id in ('0123-sealed-qa-install', '0098-sealed-demo-install');

-- 4. The boundary, in every direction.
-- 4a. Health ID lookups: an unknown Health ID's answer across it.
set local role hid_identity_api_runtime;
select pg_temp.as_qa_clinician();
select pg_temp.assert('QA to real and QA to demo: an access request answers as an unknown Health ID',
  pg_temp.try($q$select * from identity.create_access_request('HID-SQRPAT', 'read_records', 'Review before the clinic visit', 60)$q$)
    = 'P0002 Patient is not available'
  and pg_temp.try($q$select * from identity.create_access_request('HID-ZDEMAAA2', 'read_records', 'Review before the clinic visit', 60)$q$)
    = 'P0002 Patient is not available'
  and pg_temp.try($q$select * from identity.create_access_request('HID-ZDEMBBB2', 'read_records', 'Review before the clinic visit', 60)$q$)
    = 'P0002 Patient is not available');
select pg_temp.assert('QA to real: the right real PIN answers as a wrong one; QA to demo: the same',
  (select not verified and access_request_id is null and consent_grant_id is null
     from identity.access_patient_with_pin('HID-SQRPAT', '2468', 30))
  and (select not verified and consent_grant_id is null
         from identity.access_patient_with_pin('HID-ZDEMAAA2', '2468', 30)));
select pg_temp.as_qa_clinician('emergency');
select pg_temp.assert('QA to real and QA to demo: break-glass answers as an unknown Health ID',
  pg_temp.try($q$select * from identity.activate_break_glass('HID-SQRPAT', 'Unconscious on arrival at the ward', 30)$q$)
    = 'P0002 Patient is not available'
  and pg_temp.try($q$select * from identity.activate_break_glass('HID-ZDEMBBB2', 'Unconscious on arrival at the ward', 30)$q$)
    = 'P0002 Patient is not available');
select pg_temp.as_real_doctor();
select pg_temp.assert('real to QA: an access request and the right PIN answer as an unknown Health ID',
  pg_temp.try($q$select * from identity.create_access_request('HID-ZQAAAAA2', 'read_records', 'Review before the clinic visit', 60)$q$)
    = 'P0002 Patient is not available'
  and pg_temp.try($q$select * from identity.create_access_request('hid-zqaaaaa3', 'read_records', 'Review before the clinic visit', 60)$q$)
    = 'P0002 Patient is not available'
  and (select not verified and consent_grant_id is null
         from identity.access_patient_with_pin('HID-ZQAAAAA3', '1357', 30)));
select pg_temp.as_real_doctor('emergency');
select pg_temp.assert('real to QA: break-glass answers as an unknown Health ID',
  pg_temp.try($q$select * from identity.activate_break_glass('HID-ZQAAAAA2', 'Unconscious on arrival at the ward', 30)$q$)
    = 'P0002 Patient is not available');
select pg_temp.as_demo_staff(1);
select pg_temp.assert('demo to QA: an access request and the right PIN answer as an unknown Health ID',
  pg_temp.try($q$select * from identity.create_access_request('HID-ZQAAAAA2', 'read_records', 'Review before the clinic visit', 60)$q$)
    = 'P0002 Patient is not available'
  and (select not verified and consent_grant_id is null
         from identity.access_patient_with_pin('HID-ZQAAAAA3', '1357', 30)));
select pg_temp.as_demo_staff(1, 'emergency');
select pg_temp.assert('demo to QA: break-glass answers as an unknown Health ID',
  pg_temp.try($q$select * from identity.activate_break_glass('HID-ZQAAAAA3', 'Unconscious on arrival at the ward', 30)$q$)
    = 'P0002 Patient is not available');
-- 0098 unchanged: real and demo still never meet.
select pg_temp.as_demo_staff(1);
select pg_temp.assert('demo to real (0098): still an unknown Health ID',
  pg_temp.try($q$select * from identity.create_access_request('HID-SQRPAT', 'read_records', 'Review before the clinic visit', 60)$q$)
    = 'P0002 Patient is not available');
select pg_temp.as_real_doctor();
select pg_temp.assert('real to demo (0098): still an unknown Health ID',
  pg_temp.try($q$select * from identity.create_access_request('HID-ZDEMAAA2', 'read_records', 'Review before the clinic visit', 60)$q$)
    = 'P0002 Patient is not available');
reset role;
select pg_temp.assert('nothing reached a patient across the boundary from those lookups',
  not exists (select 1 from identity.access_requests request
               where identity.sealed_qa_patient(request.patient_id) <> identity.sealed_qa_facility(request.facility_id)
                  or identity.sealed_demo_patient(request.patient_id) <> identity.sealed_demo_facility(request.facility_id))
  and not exists (select 1 from identity.consent_grants grant_row
                   where identity.sealed_qa_patient(grant_row.patient_id) <> identity.sealed_qa_facility(grant_row.facility_id))
  and not exists (select 1 from identity.patient_access_pin_target_limits target_limit
                   where identity.sealed_qa_patient(target_limit.patient_id) <> identity.sealed_qa_facility(target_limit.facility_id))
  and not exists (select 1 from identity.outbox_events event where identity.sealed_qa_patient(event.patient_id)));

-- 4b. A direct consent grant (owner SQL). Across QA and real, G1q answers;
-- across QA and demo, 0098's G1 fires first (triggers fire in name order:
-- consent_grants_sealed_demo before consent_grants_sealed_qa) and answers.
select pg_temp.assert('a direct grant: QA patient at a real facility, real patient at QA Hospital',
  pg_temp.direct_grant('c0a00009-0000-4000-8000-000000000001', 'a1230004-0000-4000-8000-000000000001',
    'a1230003-0000-4000-8000-000000000001', 'a1230005-0000-4000-8000-000000000001',
    'a1230002-0000-4000-8000-000000000001') = '42501 SEALED_QA_BOUNDARY'
  and pg_temp.direct_grant('a1230009-0000-4000-8000-000000000001', 'c0a00004-0000-4000-8000-000000000001',
    'c0a00003-0000-4000-8000-000000000001', 'c0a00005-0000-4000-8000-000000000011',
    'c0a00002-0000-4000-8000-000000000001') = '42501 SEALED_QA_BOUNDARY');
select pg_temp.assert('a direct grant: QA patient at Demo Hospital, demo patient at QA Hospital',
  pg_temp.direct_grant('c0a00009-0000-4000-8000-000000000001', '98d00004-0000-4000-8000-000000000001',
    '98d00003-0000-4000-8000-000000000001', '98d00005-0000-4000-8000-000000000001',
    '98d00002-0000-4000-8000-000000000001') = '42501 SEALED_DEMO_BOUNDARY'
  and pg_temp.direct_grant('98d00009-0000-4000-8000-000000000003', 'c0a00004-0000-4000-8000-000000000001',
    'c0a00003-0000-4000-8000-000000000001', 'c0a00005-0000-4000-8000-000000000011',
    'c0a00002-0000-4000-8000-000000000001') = '42501 SEALED_DEMO_BOUNDARY');
-- G1q alone on a QA-demo pair: with 0098's trigger out of the way in a
-- subtransaction (undone), the QA trigger refuses the pair by itself.
savepoint g1q_alone;
alter table identity.consent_grants disable trigger consent_grants_sealed_demo;
select pg_temp.assert('G1q by itself refuses a QA patient at Demo Hospital and a demo patient at QA Hospital',
  pg_temp.direct_grant('c0a00009-0000-4000-8000-000000000001', '98d00004-0000-4000-8000-000000000001',
    '98d00003-0000-4000-8000-000000000001', '98d00005-0000-4000-8000-000000000001',
    '98d00002-0000-4000-8000-000000000001') = '42501 SEALED_QA_BOUNDARY'
  and pg_temp.direct_grant('98d00009-0000-4000-8000-000000000003', 'c0a00004-0000-4000-8000-000000000001',
    'c0a00003-0000-4000-8000-000000000001', 'c0a00005-0000-4000-8000-000000000011',
    'c0a00002-0000-4000-8000-000000000001') = '42501 SEALED_QA_BOUNDARY');
rollback to savepoint g1q_alone;
select pg_temp.assert('a direct grant: real and demo still refused (0098)',
  pg_temp.direct_grant('a1230009-0000-4000-8000-000000000001', '98d00004-0000-4000-8000-000000000001',
    '98d00003-0000-4000-8000-000000000001', '98d00005-0000-4000-8000-000000000001',
    '98d00002-0000-4000-8000-000000000001') = '42501 SEALED_DEMO_BOUNDARY');
savepoint grant_within_qa;
select pg_temp.assert('a direct grant within QA is accepted (undone)',
  pg_temp.direct_grant('c0a00009-0000-4000-8000-000000000002', 'c0a00004-0000-4000-8000-000000000001',
    'c0a00003-0000-4000-8000-000000000001', 'c0a00005-0000-4000-8000-000000000011',
    'c0a00002-0000-4000-8000-000000000001') = 'ok');
rollback to savepoint grant_within_qa;

-- 4c. A staff membership (owner SQL).
select pg_temp.assert('a membership: a QA login at a real facility, a real login at QA Hospital',
  pg_temp.direct_membership('c0a00004-0000-4000-8000-000000000001', 'c0a00003-0000-4000-8000-000000000001',
    'a1230001-0000-4000-8000-000000000001', 'a1230002-0000-4000-8000-000000000001') = '42501 SEALED_QA_MEMBERSHIP_REFUSED'
  and pg_temp.direct_membership('a1230004-0000-4000-8000-000000000001', 'a1230003-0000-4000-8000-000000000001',
    'c0a00001-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001') = '42501 SEALED_QA_MEMBERSHIP_REFUSED'
  and pg_temp.try($q$update identity.staff_facility_memberships set facility_id = 'a1230002-0000-4000-8000-000000000001',
      organization_id = 'a1230001-0000-4000-8000-000000000001'
      where id = 'c0a00005-0000-4000-8000-000000000021'$q$) = '42501 SEALED_QA_MEMBERSHIP_REFUSED');
select pg_temp.assert('a membership: a QA login at Demo Hospital, the demo login at QA Hospital (0098''s trigger fires first)',
  pg_temp.direct_membership('c0a00004-0000-4000-8000-000000000001', 'c0a00003-0000-4000-8000-000000000001',
    '98d00001-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001') = '42501 SEALED_DEMO_MEMBERSHIP_REFUSED'
  and pg_temp.direct_membership('98d00004-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001',
    'c0a00001-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001') = '42501 SEALED_DEMO_MEMBERSHIP_REFUSED');
savepoint g2q_alone;
alter table identity.staff_facility_memberships disable trigger staff_memberships_sealed_demo;
select pg_temp.assert('G2q by itself refuses a QA login at Demo Hospital and the demo login at QA Hospital',
  pg_temp.direct_membership('c0a00004-0000-4000-8000-000000000001', 'c0a00003-0000-4000-8000-000000000001',
    '98d00001-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001') = '42501 SEALED_QA_MEMBERSHIP_REFUSED'
  and pg_temp.direct_membership('98d00004-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001',
    'c0a00001-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001') = '42501 SEALED_QA_MEMBERSHIP_REFUSED');
rollback to savepoint g2q_alone;

-- 4d. The order directory and send.
set local role hid_identity_api_runtime;
select pg_temp.as_qa_clinician();
select pg_temp.assert('QA Hospital''s order directory: QA Laboratory and QA Pharmacy only',
  (select array_agg(facility_name order by facility_name) from identity.search_order_destinations('lab_request', 'Lab'))
    = array['QA Laboratory']
  and (select array_agg(facility_name order by facility_name) from identity.search_order_destinations('prescription', 'Pharm'))
    = array['QA Pharmacy']
  and not exists (select 1 from identity.search_order_destinations('lab_request', 'Suite'))
  and not exists (select 1 from identity.search_order_destinations('lab_request', 'Demo'))
  and not exists (select 1 from identity.search_order_destinations('prescription', 'Demo')));
select pg_temp.as_real_doctor();
select pg_temp.assert('the real order directory lists no QA facility',
  not exists (select 1 from identity.search_order_destinations('lab_request', 'QA Lab'))
  and not exists (select 1 from identity.search_order_destinations('prescription', 'QA Pharm'))
  and (select array_agg(facility_name) from identity.search_order_destinations('lab_request', 'Lab'))
    = array['Suite Real Laboratory']);
select pg_temp.as_demo_staff(1);
select pg_temp.assert('the demo order directory lists no QA facility (and no real one)',
  not exists (select 1 from identity.search_order_destinations('lab_request', 'QA Lab'))
  and not exists (select 1 from identity.search_order_destinations('prescription', 'QA Pharm'))
  and (select array_agg(facility_name) from identity.search_order_destinations('lab_request', 'Lab'))
    = array['Demo Laboratory']);
reset role;
-- Orders: the real doctor's draft for the real patient; the QA clinician's for
-- QA Patient One at QA Hospital and the demo login's for Demo Patient One at
-- Demo Hospital (each through its seeded share).
set local role hid_ehr_api_runtime;
select pg_temp.as_qa_clinician();
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('a123000d-0000-4000-8000-000000000021', 'c0a00009-0000-4000-8000-000000000001',
  'c0a00002-0000-4000-8000-000000000001', 'c0a00003-0000-4000-8000-000000000001',
  'c0a00005-0000-4000-8000-000000000011', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
values ('a123000e-0000-4000-8000-000000000021', 'a123000d-0000-4000-8000-000000000021',
  'c0a00009-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001',
  'c0a00003-0000-4000-8000-000000000001', 'c0a00005-0000-4000-8000-000000000011', 'http://loinc.org', '718-7',
  'Haemoglobin', 'routine', 'draft', 'whole-blood', 'QA: tiredness');
select pg_temp.as_demo_staff(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('a123000d-0000-4000-8000-000000000011', '98d00009-0000-4000-8000-000000000001',
  '98d00002-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001',
  '98d00005-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
values ('a123000e-0000-4000-8000-000000000011', 'a123000d-0000-4000-8000-000000000011',
  '98d00009-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001',
  '98d00003-0000-4000-8000-000000000001', '98d00005-0000-4000-8000-000000000001', 'http://loinc.org', '718-7',
  'Haemoglobin', 'routine', 'draft', 'whole-blood', 'Demo: tiredness');
select pg_temp.as_qa_clinician();
select pg_temp.assert('QA to real and QA to demo: an order to Suite Real Laboratory or Demo Laboratory is ineligible',
  pg_temp.try($q$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request', 'c0a00009-0000-4000-8000-000000000001',
    'a123000e-0000-4000-8000-000000000021', 'a123000d-0000-4000-8000-000000000021', 1, 'a1230002-0000-4000-8000-000000000002',
    'order-route-lab-attestation-v1', 'sealed-qa-send-to-real-0001', encode(sha256('sealed-qa-send-to-real-0001'::bytea), 'hex'))$q$)
    = 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE'
  and pg_temp.try($q$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request', 'c0a00009-0000-4000-8000-000000000001',
    'a123000e-0000-4000-8000-000000000021', 'a123000d-0000-4000-8000-000000000021', 1, '98d00002-0000-4000-8000-000000000002',
    'order-route-lab-attestation-v1', 'sealed-qa-send-to-demo-0001', encode(sha256('sealed-qa-send-to-demo-0001'::bytea), 'hex'))$q$)
    = 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.as_real_doctor();
select pg_temp.assert('real to QA: an order to QA Laboratory is ineligible',
  pg_temp.try($q$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request', 'a1230009-0000-4000-8000-000000000001',
    'a123000e-0000-4000-8000-000000000001', 'a123000d-0000-4000-8000-000000000001', 1, 'c0a00002-0000-4000-8000-000000000002',
    'order-route-lab-attestation-v1', 'sealed-real-send-to-qa-0001', encode(sha256('sealed-real-send-to-qa-0001'::bytea), 'hex'))$q$)
    = 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.as_demo_staff(1);
select pg_temp.assert('demo to QA: an order to QA Laboratory is ineligible',
  pg_temp.try($q$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request', '98d00009-0000-4000-8000-000000000001',
    'a123000e-0000-4000-8000-000000000011', 'a123000d-0000-4000-8000-000000000011', 1, 'c0a00002-0000-4000-8000-000000000002',
    'order-route-lab-attestation-v1', 'sealed-demo-send-to-qa-0001', encode(sha256('sealed-demo-send-to-qa-0001'::bytea), 'hex'))$q$)
    = 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
reset role;
select pg_temp.assert('no route was written across the boundary',
  not exists (select 1 from ehr.order_routes route where route.idempotency_key like 'sealed-%-send-to-%'));

-- 4e. The share directory and a patient's own share.
set local role hid_identity_api_runtime;
select pg_temp.as_qa_patient(1);
select pg_temp.assert('a QA patient''s share directory shows QA clinicians only',
  (select array_agg(clinician_name || '@' || facility_name order by clinician_name)
     from identity.search_share_providers('patient:c0a00008-0000-4000-8000-000000000001',
       'a123000b-0000-4000-8000-000000000021', 'QA Hosp'))
    = array['QA Clinician@QA Hospital', 'QA Migrate User@QA Hospital']
  and not exists (select 1 from identity.search_share_providers('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'Remi'))
  and not exists (select 1 from identity.search_share_providers('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'Demo')));
select pg_temp.assert('QA to real and QA to demo: a QA patient''s share to a real or demo membership is refused',
  pg_temp.try($q$select * from identity.create_my_consent_share('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'a1230005-0000-4000-8000-000000000001', 'view_only', '24h',
    'sealed-qa-share-to-real-0001', repeat('d', 64))$q$) = '42501 SEALED_QA_BOUNDARY'
  and pg_temp.try($q$select * from identity.create_my_consent_share('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', '98d00005-0000-4000-8000-000000000001', 'view_only', '24h',
    'sealed-qa-share-to-demo-0001', repeat('d', 64))$q$) like '42501 SEALED_%_BOUNDARY');
select pg_temp.as_real_patient();
select pg_temp.assert('real to QA: the share directory never shows a QA clinician; a share to one is refused',
  not exists (select 1 from identity.search_share_providers('synthetic:qa-suite:patient',
    'a123000b-0000-4000-8000-000000000001', 'QA Hosp'))
  and (select array_agg(clinician_name) from identity.search_share_providers('synthetic:qa-suite:patient',
    'a123000b-0000-4000-8000-000000000001', 'Remi')) = array['Remi Suitedoctor']
  and pg_temp.try($q$select * from identity.create_my_consent_share('synthetic:qa-suite:patient',
    'a123000b-0000-4000-8000-000000000001', 'c0a00005-0000-4000-8000-000000000011', 'view_only', '24h',
    'sealed-real-share-to-qa-0001', repeat('d', 64))$q$) = '42501 SEALED_QA_BOUNDARY');
select pg_temp.as_demo_patient(1);
select pg_temp.assert('demo to QA: the share directory never shows a QA clinician; a share to one is refused',
  not exists (select 1 from identity.search_share_providers('patient:98d00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000011', 'QA Hosp'))
  and exists (select 1 from identity.search_share_providers('patient:98d00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000011', 'Demo'))
  and pg_temp.try($q$select * from identity.create_my_consent_share('patient:98d00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000011', 'c0a00005-0000-4000-8000-000000000011', 'view_only', '24h',
    'sealed-demo-share-to-qa-0001', repeat('d', 64))$q$) like '42501 SEALED_%_BOUNDARY');
reset role;

-- 4f. Share invitation acceptance across the boundary. Real to QA: a real
-- patient invites the QA clinician's address, which the clinician cannot
-- accept at QA Hospital. QA to demo: QA Patient One invites the demo login's
-- address (the owner's domain, so G4q lets it be sent), which the demo login
-- cannot accept at Demo Hospital. QA to real and demo to QA: no real staff
-- login has an address of the owner's domain and a demo patient invites the
-- three demo mailboxes only, so the acceptance is written directly (owner
-- SQL), as the function would write it.
set local role hid_identity_api_runtime;
select pg_temp.as_real_patient();
select set_config('hid.test.real_to_qa_invitation', (select invitation_id::text
  from identity.create_my_share_invitation('synthetic:qa-suite:patient', 'a123000b-0000-4000-8000-000000000001',
    'ehr@healthidentitydirectory.com', 'QA clinic', 'view_only', '24h', 'sealed-real-invite-0001',
    repeat('c', 64))), true);
select pg_temp.as_qa_clinician();
select pg_temp.assert('real to QA: the QA clinician cannot accept a real patient''s invitation',
  pg_temp.try(format('select * from identity.accept_share_invitation(%L)', current_setting('hid.test.real_to_qa_invitation')))
    = '42501 SEALED_QA_BOUNDARY');
select pg_temp.as_qa_patient(1);
select set_config('hid.test.qa_to_demo_invitation', (select invitation_id::text
  from identity.create_my_share_invitation('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'Operations@HealthIdentityDirectory.com', 'Demo clinic', 'view_only', '24h',
    'sealed-qa-invite-0001', repeat('a', 64))), true);
select set_config('hid.test.qa_to_real_invitation', (select invitation_id::text
  from identity.create_my_share_invitation('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'operations+qa-suite-real@healthidentitydirectory.com', null, 'view_only',
    '24h', 'sealed-qa-invite-0002', repeat('b', 64))), true);
select pg_temp.as_demo_staff(1);
select pg_temp.assert('QA to demo: the demo login cannot accept a QA patient''s invitation',
  pg_temp.try(format('select * from identity.accept_share_invitation(%L)', current_setting('hid.test.qa_to_demo_invitation')))
    = '42501 SEALED_DEMO_BOUNDARY');
select pg_temp.as_demo_patient(1);
select set_config('hid.test.demo_to_qa_invitation', (select invitation_id::text
  from identity.create_my_share_invitation('patient:98d00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000011', 'patientdemo2@healthidentitydirectory.com', null, 'view_only', '24h',
    'sealed-demo-invite-0001', repeat('e', 64))), true);
select pg_temp.assert('demo to QA: a demo patient cannot invite the QA patients'' patient1@ or patient2@ (D10)',
  pg_temp.try($q$select * from identity.create_my_share_invitation('patient:98d00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000011', 'patient1@healthidentitydirectory.com', null, 'view_only', '24h',
    'sealed-demo-invite-0002', repeat('f', 64))$q$) = '22023 SHARE_INVITATION_EMAIL_INVALID'
  and pg_temp.try($q$select * from identity.create_my_share_invitation('patient:98d00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000011', ' Patient2@HealthIdentityDirectory.com ', null, 'view_only', '24h',
    'sealed-demo-invite-0003', repeat('f', 64))$q$) = '22023 SHARE_INVITATION_EMAIL_INVALID');
reset role;
select pg_temp.assert('QA to real: an acceptance at a real membership is refused (owner SQL)',
  pg_temp.direct_accept(current_setting('hid.test.qa_to_real_invitation')::uuid, 'a1230005-0000-4000-8000-000000000001',
    'a1230003-0000-4000-8000-000000000001') = '42501 SEALED_QA_BOUNDARY');
select pg_temp.assert('QA to demo: an acceptance at a demo membership is refused (owner SQL)',
  pg_temp.direct_accept(current_setting('hid.test.qa_to_real_invitation')::uuid, '98d00005-0000-4000-8000-000000000001',
    '98d00003-0000-4000-8000-000000000001') like '42501 SEALED_%_BOUNDARY');
select pg_temp.assert('demo to QA: an acceptance at a QA membership is refused (owner SQL)',
  pg_temp.direct_accept(current_setting('hid.test.demo_to_qa_invitation')::uuid, 'c0a00005-0000-4000-8000-000000000011',
    'c0a00003-0000-4000-8000-000000000001') like '42501 SEALED_%_BOUNDARY');
savepoint g4q_alone;
alter table identity.patient_share_invitations disable trigger patient_share_invitations_sealed_demo;
select pg_temp.assert('G4q by itself refuses demo to QA and QA to demo acceptances',
  pg_temp.direct_accept(current_setting('hid.test.demo_to_qa_invitation')::uuid, 'c0a00005-0000-4000-8000-000000000011',
    'c0a00003-0000-4000-8000-000000000001') = '42501 SEALED_QA_BOUNDARY'
  and pg_temp.direct_accept(current_setting('hid.test.qa_to_demo_invitation')::uuid, '98d00005-0000-4000-8000-000000000001',
    '98d00003-0000-4000-8000-000000000001') = '42501 SEALED_QA_BOUNDARY');
rollback to savepoint g4q_alone;
select pg_temp.assert('the four invitations are still pending',
  (select array_agg(invitation.status) from identity.patient_share_invitations invitation
    where invitation.id in (current_setting('hid.test.real_to_qa_invitation')::uuid,
      current_setting('hid.test.qa_to_demo_invitation')::uuid, current_setting('hid.test.qa_to_real_invitation')::uuid,
      current_setting('hid.test.demo_to_qa_invitation')::uuid))
  = array['pending', 'pending', 'pending', 'pending']);

-- 4g. identity.patients' registration read, by Health ID and by name.
set local role hid_identity_api_runtime;
select pg_temp.as_qa_staff(6, '61', 1);
do $$
begin
  perform pg_temp.assert('QA Hospital''s registration staff read the two QA patients and nobody else',
    (select count(*) from identity.patients) = 2
    and (select count(*) from identity.patients where upper(hid_code) = 'HID-ZQAAAAA2' and status = 'active') = 1
    and (select count(*) from identity.patients where full_name ilike 'QA Patient%') = 2
    and (select count(*) from identity.patients where upper(hid_code) in ('HID-SQRPAT', 'HID-ZDEMAAA2', 'HID-ZDEMBBB2')) = 0
    and (select count(*) from identity.patients where full_name ilike 'Rafa%' or full_name ilike 'Demo %') = 0
    and (select count(*) from identity.patients where id in ('a1230009-0000-4000-8000-000000000001',
           '98d00009-0000-4000-8000-000000000001')) = 0);
end $$;
select pg_temp.as_qa_clinician();
select pg_temp.assert('and the QA clinician (doctor) the same',
  (select count(*) from identity.patients) = 2
  and (select count(*) from identity.patients where upper(hid_code) = 'HID-SQRPAT') = 0);
select pg_temp.as_real_doctor();
do $$
begin
  perform pg_temp.assert('a real doctor''s registration read never finds a QA patient (Health ID or name), nor a demo one',
    (select count(*) from identity.patients where upper(hid_code) like 'HID-ZQA%') = 0
    and (select count(*) from identity.patients where full_name ilike 'QA Patient%') = 0
    and (select count(*) from identity.patients where id = 'c0a00009-0000-4000-8000-000000000001') = 0
    and (select count(*) from identity.patients where upper(hid_code) like 'HID-ZDEM%') = 0
    and (select count(*) from identity.patients where upper(hid_code) = 'HID-SQRPAT') = 1);
end $$;
select pg_temp.as_demo_staff(1);
do $$
begin
  perform pg_temp.assert('the demo login''s registration read never finds a QA patient (Health ID or name); its ten remain',
    (select count(*) from identity.patients where upper(hid_code) like 'HID-ZQA%') = 0
    and (select count(*) from identity.patients where full_name ilike 'QA Patient%') = 0
    and (select count(*) from identity.patients) = 10);
end $$;
reset role;

-- 5. QA-only rules.
select pg_temp.assert('a QA account holds no platform role (owner SQL)',
  pg_temp.try($q$insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values (gen_random_uuid(), 'c0a00003-0000-4000-8000-000000000006', 'platform_admin', 'platform',
      'Owner SQL platform role')$q$) = '42501 SEALED_QA_PLATFORM_ROLE_REFUSED'
  and pg_temp.try($q$insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values (gen_random_uuid(), 'c0a00008-0000-4000-8000-000000000001', 'support_admin', 'platform',
      'Owner SQL platform role')$q$) = '42501 SEALED_QA_PLATFORM_ROLE_REFUSED');
select pg_temp.assert('a QA account consumes no QoreID quota (owner SQL; a real account''s row is accepted, undone)',
  pg_temp.try($q$insert into platform.qoreid_quota_counters (operation, scope_type, scope_id, bucket_period,
    bucket_start, attempt_count) values ('existing_cac', 'account', 'c0a00003-0000-4000-8000-000000000006', 'day',
    date_trunc('day', clock_timestamp()), 1)$q$) = '42501 QOREID_QUOTA_PERMISSION_DENIED'
  and pg_temp.try($q$insert into platform.qoreid_quota_counters (operation, scope_type, scope_id, bucket_period,
    bucket_start, attempt_count) values ('patient_nin', 'account', 'c0a00008-0000-4000-8000-000000000002', 'hour',
    date_trunc('hour', clock_timestamp()), 1)$q$) = '42501 QOREID_QUOTA_PERMISSION_DENIED'
  and pg_temp.value_of($q$with written as (insert into platform.qoreid_quota_counters (operation, scope_type, scope_id,
    bucket_period, bucket_start, attempt_count) values ('existing_cac', 'account', 'a1230003-0000-4000-8000-000000000001',
    'day', date_trunc('day', clock_timestamp()), 1) returning 1) select count(*)::text from written$q$) = '1');
delete from platform.qoreid_quota_counters where scope_id = 'a1230003-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
select pg_temp.as_qa_patient(1);
select pg_temp.assert('a QA patient''s NIN check consumes no QoreID quota',
  pg_temp.try($q$select platform.consume_qoreid_quota('patient_nin', null, 'a123000b-0000-4000-8000-000000000021', null, null)$q$)
    = '42501 QOREID_QUOTA_PERMISSION_DENIED');
select pg_temp.assert('a QA patient never holds a phone',
  pg_temp.try($q$select * from identity.change_my_phone('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', gen_random_uuid(), repeat('d', 64), array[]::char(64)[],
    decode(repeat('ab', 40), 'hex'), 'sealed-test-v1', false)$q$) = '22023 PATIENT_CONTACT_CHANGE_INVALID');
-- The same command for the real patient passes (undone), so the refusal above is the seal's.
savepoint phone_probe;
select pg_temp.as_real_patient();
select pg_temp.assert('a real patient''s phone change passes the seal',
  pg_temp.try($q$select * from identity.change_my_phone('synthetic:qa-suite:patient',
    'a123000b-0000-4000-8000-000000000001', gen_random_uuid(), repeat('d', 64), array[]::char(64)[],
    decode(repeat('ab', 40), 'hex'), 'sealed-test-v1', false)$q$) = 'ok');
rollback to savepoint phone_probe;
reset role;
select pg_temp.assert('G5q: a phone change row for a QA patient is refused (owner SQL)',
  pg_temp.try($q$insert into identity.patient_contact_changes (id, patient_id, account_id, channel, state, new_lookup_hmac,
    new_ciphertext, key_version, verifier_hmac, verifier_key_version, expires_at, max_attempts, delivery_outcome)
    values (gen_random_uuid(), 'c0a00009-0000-4000-8000-000000000002', 'c0a00008-0000-4000-8000-000000000002', 'phone',
      'pending', repeat('1', 64), decode(repeat('ab', 40), 'hex'), 'sealed-test-v1', repeat('2', 64), 'sealed-test-v1',
      clock_timestamp() + interval '10 minutes', 5, 'pending')$q$) = '22023 PATIENT_CONTACT_CHANGE_INVALID');
-- Share invitations from a QA patient: the owner's domain only.
set local role hid_identity_api_runtime;
select pg_temp.as_qa_patient(2);
select pg_temp.assert('a QA patient invites no other domain, no subdomain, no lookalike',
  pg_temp.try($q$select * from identity.create_my_share_invitation('patient:c0a00008-0000-4000-8000-000000000002',
    'a123000b-0000-4000-8000-000000000022', 'qa.suite.someone@gmail.com', null, 'view_only', '24h',
    'sealed-qa-invite-0011', repeat('a', 64))$q$) = '22023 SHARE_INVITATION_EMAIL_INVALID'
  and pg_temp.try($q$select * from identity.create_my_share_invitation('patient:c0a00008-0000-4000-8000-000000000002',
    'a123000b-0000-4000-8000-000000000022', 'clinic@sub.healthidentitydirectory.com', null, 'view_only', '24h',
    'sealed-qa-invite-0012', repeat('b', 64))$q$) = '22023 SHARE_INVITATION_EMAIL_INVALID'
  and pg_temp.try($q$select * from identity.create_my_share_invitation('patient:c0a00008-0000-4000-8000-000000000002',
    'a123000b-0000-4000-8000-000000000022', 'clinic@healthidentitydirectory.com.evil.example', null, 'view_only', '24h',
    'sealed-qa-invite-0013', repeat('c', 64))$q$) = '22023 SHARE_INVITATION_EMAIL_INVALID');
select set_config('hid.test.qa_invitation', (select invitation_id::text
  from identity.create_my_share_invitation('patient:c0a00008-0000-4000-8000-000000000002',
    'a123000b-0000-4000-8000-000000000022', 'EHR@HealthIdentityDirectory.com', 'QA clinic',
    'view_only', '24h', 'sealed-qa-invite-0014', repeat('d', 64))), true);
select pg_temp.assert('an address of the owner''s domain, in any case, is accepted',
  current_setting('hid.test.qa_invitation', true) ~ '^[0-9a-f-]{36}$');
reset role;
-- G4q also guards an update of the address (the invitation guard, which fires
-- first and keeps an address fixed, is lifted in an undone subtransaction).
savepoint g4q_update;
alter table identity.patient_share_invitations disable trigger patient_share_invitations_guard;
select pg_temp.assert('G4q: a QA patient''s invitation moved to another domain is refused (owner SQL)',
  pg_temp.try($q$update identity.patient_share_invitations set invitee_email = 'qa.suite.someone@gmail.com'
    where id = current_setting('hid.test.qa_invitation')::uuid$q$) = '22023 SHARE_INVITATION_EMAIL_INVALID'
  and pg_temp.try($q$update identity.patient_share_invitations set invitee_email = 'operations+qa-other@healthidentitydirectory.com'
    where id = current_setting('hid.test.qa_invitation')::uuid$q$) = 'ok');
rollback to savepoint g4q_update;
-- Email change: the owner's domain only; nothing recorded otherwise.
set local role hid_identity_api_runtime;
select pg_temp.as_qa_patient(1);
select pg_temp.assert('a QA patient''s email change to another domain answers unavailable',
  pg_temp.value_of($q$select identity.start_my_email_change('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', gen_random_uuid(), 'Qa.Suite.Someone@Gmail.com', repeat('e', 64),
    decode(repeat('cd', 40), 'hex'), 'sealed-test-v1', repeat('f', 64), 'sealed-test-v1', 600, 5, 60)$q$) = 'unavailable'
  and pg_temp.value_of($q$select identity.start_my_email_change('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', gen_random_uuid(), 'patient1@sub.healthidentitydirectory.com', repeat('e', 64),
    decode(repeat('cd', 40), 'hex'), 'sealed-test-v1', repeat('f', 64), 'sealed-test-v1', 600, 5, 60)$q$) = 'unavailable');
reset role;
select pg_temp.assert('the seal recorded nothing for those',
  not exists (select 1 from identity.patient_contact_changes change_row
               where change_row.patient_id = 'c0a00009-0000-4000-8000-000000000001'));
set local role hid_identity_api_runtime;
select pg_temp.as_qa_patient(1);
select pg_temp.assert('a QA patient''s email change to an address of the owner''s domain starts',
  pg_temp.value_of($q$select identity.start_my_email_change('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', gen_random_uuid(), 'Patient1+QA-New@HealthIdentityDirectory.com',
    repeat('7', 64), decode(repeat('ef', 40), 'hex'), 'sealed-test-v1', repeat('6', 64), 'sealed-test-v1', 600, 5, 60)$q$)
    = 'started');
-- Emergency contacts: the check (C) and the database's own rule (G7q), each
-- probe in a savepoint, undone, so that no recorded HMAC outlives it.
savepoint contact_probe;
select set_config('hid.sealed_qa_contact_hmac', '', true);
select set_config('hid.sealed_demo_contact_hmac', '', true);
select pg_temp.assert('C for a QA patient: an email to the owner''s domain with a well-formed HMAC only',
  not identity.sealed_demo_contact_allowed('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'email', 'qa.suite.mum@gmail.com', repeat('a', 64))
  and current_setting('hid.sealed_qa_contact_hmac') = ''
  and identity.sealed_demo_contact_allowed('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'email', 'Operations+QA-Mum@HealthIdentityDirectory.com', repeat('b', 64))
  and current_setting('hid.sealed_qa_contact_hmac') = repeat('b', 64)
  and current_setting('hid.sealed_demo_contact_hmac') = ''
  and not identity.sealed_demo_contact_allowed('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'email', 'mum@sub.healthidentitydirectory.com', repeat('c', 64))
  and not identity.sealed_demo_contact_allowed('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'sms', '+2348012345678', repeat('c', 64))
  and not identity.sealed_demo_contact_allowed('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', null, 'operations+qa-mum@healthidentitydirectory.com', repeat('c', 64))
  and (select bool_and(not identity.sealed_demo_contact_allowed('patient:c0a00008-0000-4000-8000-000000000001',
            'a123000b-0000-4000-8000-000000000021', 'email', 'operations+qa-mum@healthidentitydirectory.com', malformed.hmac))
         from (values (repeat('A', 64)), (repeat('a', 63)), ('abc'), (repeat('g', 64)), (null)) malformed(hmac))
  and current_setting('hid.sealed_qa_contact_hmac') = repeat('b', 64));
select pg_temp.assert('G7q: the checked HMAC is added; another HMAC, an SMS, or none checked is refused',
  pg_temp.add_contact('patient:c0a00008-0000-4000-8000-000000000001', 'a123000b-0000-4000-8000-000000000021',
    'a1230010-0000-4000-8000-000000000002', 'email', repeat('5', 64)) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED'
  and pg_temp.add_contact('patient:c0a00008-0000-4000-8000-000000000001', 'a123000b-0000-4000-8000-000000000021',
    'a1230010-0000-4000-8000-000000000002', 'sms', repeat('b', 64)) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED'
  and pg_temp.add_contact('patient:c0a00008-0000-4000-8000-000000000001', 'a123000b-0000-4000-8000-000000000021',
    'a1230010-0000-4000-8000-000000000001', 'email', repeat('b', 64)) = 'ok');
select set_config('hid.sealed_qa_contact_hmac', '', true);
select pg_temp.assert('G7q: an email contact whose HMAC was not recorded is refused',
  pg_temp.add_contact('patient:c0a00008-0000-4000-8000-000000000001', 'a123000b-0000-4000-8000-000000000021',
    'a1230010-0000-4000-8000-000000000003', 'email', repeat('9', 64)) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED');
-- A demo HMAC recorded for a demo patient does not open a QA patient's contact.
select pg_temp.as_demo_patient(1);
select pg_temp.assert('C for a demo patient: its three exact mailboxes, never a plus-address; it records the demo HMAC only',
  not identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000011', 'email', 'operations+qa-mum@healthidentitydirectory.com', repeat('8', 64))
  and not identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000011', 'email', 'patient1@healthidentitydirectory.com', repeat('8', 64))
  and identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000011', 'email', 'patientdemo2@healthidentitydirectory.com', repeat('8', 64))
  and current_setting('hid.sealed_demo_contact_hmac') = repeat('8', 64)
  and current_setting('hid.sealed_qa_contact_hmac') = '');
select pg_temp.as_qa_patient(1);
select pg_temp.assert('G7q: the demo check''s HMAC does not admit a QA patient''s contact',
  pg_temp.add_contact('patient:c0a00008-0000-4000-8000-000000000001', 'a123000b-0000-4000-8000-000000000021',
    'a1230010-0000-4000-8000-000000000004', 'email', repeat('8', 64)) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED');
select pg_temp.as_real_patient();
select pg_temp.assert('C and G7q leave real patients alone',
  identity.sealed_demo_contact_allowed('synthetic:qa-suite:patient', 'a123000b-0000-4000-8000-000000000001',
    'email', 'qa.suite.mum@gmail.com', repeat('2', 64))
  and current_setting('hid.sealed_qa_contact_hmac') = ''
  and pg_temp.add_contact('synthetic:qa-suite:patient', 'a123000b-0000-4000-8000-000000000001',
    'a1230010-0000-4000-8000-000000000011', 'sms', repeat('1', 64)) = 'ok');
reset role;
select pg_temp.assert('G7q: an update of a QA contact''s channel or destination is refused (owner SQL); removal never is',
  pg_temp.try($q$update identity.patient_emergency_contacts set channel = 'sms'
    where id = 'a1230010-0000-4000-8000-000000000001'$q$) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED'
  and pg_temp.try($q$update identity.patient_emergency_contacts set destination_hmac = repeat('4', 64)
    where id = 'a1230010-0000-4000-8000-000000000001'$q$) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED');
set local role hid_identity_api_runtime;
select pg_temp.as_qa_patient(1);
select set_config('hid.sealed_qa_contact_hmac', '', true);
select pg_temp.assert('G7q never refuses removal',
  pg_temp.try($q$select * from identity.deactivate_my_emergency_contact('patient:c0a00008-0000-4000-8000-000000000001',
    'a123000b-0000-4000-8000-000000000021', 'a1230010-0000-4000-8000-000000000001')$q$) = 'ok');
reset role;
select pg_temp.assert('the one QA contact added is the checked address, now removed',
  (select array_agg(contact.channel || '|' || contact.status)
     from identity.patient_emergency_contacts contact where identity.sealed_qa_patient(contact.patient_id))
  = array['email|deactivated']);
rollback to savepoint contact_probe;
reset role;
select pg_temp.assert('no QA counter, no phone, no contact outside the owner''s domain',
  not exists (select 1 from platform.qoreid_quota_counters counter
               where counter.scope_type = 'account' and identity.sealed_qa_account(counter.scope_id))
  and not exists (select 1 from identity.patient_contact_changes change_row
                   where identity.sealed_qa_patient(change_row.patient_id) and change_row.channel = 'phone')
  and not exists (select 1 from identity.patient_emergency_contacts contact
                   where identity.sealed_qa_patient(contact.patient_id)));

-- 6. Outreach (G8q): "Start an outreach group" as the QA organiser (verified
-- staff record, no membership), the control on.
create function pg_temp.start_group(subject text, group_name text, phone text)
returns text language sql as $f$
  select pg_temp.as_staff(subject, null, null, 'healthcare-operations');
  select pg_temp.value_of(format($q$select result || ' ' || (organization_id is not null)
      from identity.activate_outreach_organiser_for_account(%L, 'group', null, %L, %L,
        decode(repeat('cd', 32), 'hex'), 'k1')$q$, group_name, current_setting('hid.test.outreach_terms'),
      encode(sha256(convert_to(phone, 'UTF8')), 'hex')));
$f$;
grant execute on function pg_temp.start_group(text,text,text) to hid_identity_api_runtime;
select set_config('hid.test.outreach_terms', identity.outreach_organiser_terms_version(), true);
set local role hid_identity_api_runtime;
select pg_temp.assert('a QA organiser''s group not named "QA ..." is refused',
  pg_temp.start_group('sealed-qa:c0a00003-0000-4000-8000-000000000007', 'Outreach Friends', 'qa-phone-1')
    = '22023 OUTREACH_ORGANISER_SIGNUP_INVALID'
  and pg_temp.start_group('sealed-qa:c0a00003-0000-4000-8000-000000000007', 'QAOutreach Friends', 'qa-phone-1')
    = '22023 OUTREACH_ORGANISER_SIGNUP_INVALID');
savepoint lower_case_group;
select pg_temp.assert('"qa ..." in any case is accepted (undone)',
  pg_temp.start_group('sealed-qa:c0a00003-0000-4000-8000-000000000007', 'qa community checks', 'qa-phone-2')
    = 'started true');
rollback to savepoint lower_case_group;
set local role hid_identity_api_runtime;
select pg_temp.assert('a QA organiser starts "QA Outreach"',
  pg_temp.start_group('sealed-qa:c0a00003-0000-4000-8000-000000000007', 'QA Outreach', 'qa-phone-3') = 'started true');
select pg_temp.assert('a real organiser''s group starts, even when named "QA ..."',
  pg_temp.start_group('synthetic:qa-suite:doctor', 'QA Lookalike Outreach', 'real-phone-1') = 'started true');
reset role;
select pg_temp.assert('the QA group: its organization and facility QA members, the organiser''s membership and role accepted',
  (select identity.sealed_qa_facility(organisation.facility_id)
          and exists (select 1 from identity.sealed_qa_members member where member.member_kind = 'organization'
                       and member.member_id = organisation.organization_id)
          and exists (select 1 from identity.staff_facility_memberships membership
                       join auth.account_roles assignment on assignment.membership_id = membership.id
                        and assignment.role_code = 'outreach_organiser' and assignment.revoked_at is null
                      where membership.account_id = 'c0a00003-0000-4000-8000-000000000007'
                        and membership.facility_id = organisation.facility_id and membership.active)
     from identity.outreach_organisations organisation
    where organisation.organiser_account_id = 'c0a00003-0000-4000-8000-000000000007'
      and organisation.display_name = 'QA Outreach')
  and (select count(*) from identity.outreach_organisations organisation
        where organisation.organiser_account_id = 'c0a00003-0000-4000-8000-000000000007') = 1);
select pg_temp.assert('the real organiser''s group stays real',
  (select not identity.sealed_qa_facility(organisation.facility_id)
          and not exists (select 1 from identity.sealed_qa_members member
                           where member.member_id in (organisation.organization_id, organisation.facility_id))
     from identity.outreach_organisations organisation
    where organisation.organiser_account_id = 'a1230003-0000-4000-8000-000000000001'));
select pg_temp.assert('a QA login never joins the real group; a real login never the QA group (owner SQL)',
  (select pg_temp.direct_membership('c0a00004-0000-4000-8000-000000000001', 'c0a00003-0000-4000-8000-000000000001',
            organisation.organization_id, organisation.facility_id)
     from identity.outreach_organisations organisation
    where organisation.organiser_account_id = 'a1230003-0000-4000-8000-000000000001') = '42501 SEALED_QA_MEMBERSHIP_REFUSED'
  and (select pg_temp.direct_membership('a1230004-0000-4000-8000-000000000002', 'a1230003-0000-4000-8000-000000000002',
            organisation.organization_id, organisation.facility_id)
     from identity.outreach_organisations organisation
    where organisation.organiser_account_id = 'c0a00003-0000-4000-8000-000000000007') = '42501 SEALED_QA_MEMBERSHIP_REFUSED');
select pg_temp.assert('G8q directly (owner SQL): a QA organiser''s group row named otherwise is refused',
  pg_temp.value_of($q$select identity.create_outreach_group('c0a00003-0000-4000-8000-000000000007',
    'c0a00004-0000-4000-8000-000000000007', 'Second Group', 'group', null, repeat('a', 64),
    decode(repeat('cd', 32), 'hex'), 'k1', '2026-11-01', 'existing_account', null, false)::text$q$)
    = '22023 OUTREACH_ORGANISER_SIGNUP_INVALID');
-- G9q: a QA outreach group invites an address of the owner's domain only (owner SQL, as the command writes it).
create function pg_temp.outreach_invite(organiser uuid, invitee text)
returns text language plpgsql as $f$
begin
  return pg_temp.try(format($q$insert into identity.outreach_invitations (id, organization_id, facility_id,
      invited_by_account_id, invited_by_membership_id, invitee_name, invitee_email, link_token_hmac, expires_at)
    select gen_random_uuid(), organisation.organization_id, organisation.facility_id, organisation.organiser_account_id,
           membership.id, 'Synthetic Volunteer', %L, repeat('b', 64), clock_timestamp() + interval '7 days'
      from identity.outreach_organisations organisation
      join identity.staff_facility_memberships membership
        on membership.facility_id = organisation.facility_id and membership.account_id = organisation.organiser_account_id
     where organisation.organiser_account_id = %L$q$, invitee, organiser));
end
$f$;
savepoint outreach_invitations_qa;
select pg_temp.assert('G9q: a QA group''s invitation to another domain is refused, to the owner''s domain accepted',
  pg_temp.outreach_invite('c0a00003-0000-4000-8000-000000000007', 'volunteer@gmail.com') = '22023 OUTREACH_INVITATION_INVALID'
  and pg_temp.outreach_invite('c0a00003-0000-4000-8000-000000000007', 'volunteer@sub.healthidentitydirectory.com')
    = '22023 OUTREACH_INVITATION_INVALID'
  and pg_temp.outreach_invite('c0a00003-0000-4000-8000-000000000007', 'operations+qa-volunteer@healthidentitydirectory.com')
    = 'ok');
select pg_temp.assert('G9q: an invitation moved to another domain is refused',
  pg_temp.try($q$update identity.outreach_invitations set invitee_email = 'volunteer@gmail.com'
    where invitee_email = 'operations+qa-volunteer@healthidentitydirectory.com'$q$) = '22023 OUTREACH_INVITATION_INVALID');
select pg_temp.assert('G9q: a real group still invites any address',
  pg_temp.outreach_invite('a1230003-0000-4000-8000-000000000001', 'volunteer@example.invalid') = 'ok');
rollback to savepoint outreach_invitations_qa;
set local role hid_identity_api_runtime;
select pg_temp.as_platform_admin();
select pg_temp.assert('the overview still counts no QA row (the QA group excluded, the real one counted)',
  pg_temp.overview() <> current_setting('hid.test.overview_before')
  and (select facilities from identity.admin_platform_overview())
    = split_part(trim(both '()' from current_setting('hid.test.overview_before')), ',', 2)::bigint + 1);
reset role;

-- 7. Within QA, everything works.
set local role hid_ehr_api_runtime;
select pg_temp.as_qa_clinician();
select pg_temp.assert('the seeded share lets the QA clinician read and write QA Patient One at QA Hospital; not Patient Two',
  ehr.context_allows('c0a00009-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001', 'read_records')
  and ehr.context_allows('c0a00009-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001', 'write_records')
  and not ehr.context_allows('c0a00009-0000-4000-8000-000000000002', 'c0a00002-0000-4000-8000-000000000001', 'read_records')
  and exists (select 1 from ehr.encounters where id = 'a123000d-0000-4000-8000-000000000021'));
select set_config('hid.test.qa_route', (select route_id::text from ehr.send_order_route(gen_random_uuid(), 'lab_request',
  'c0a00009-0000-4000-8000-000000000001', 'a123000e-0000-4000-8000-000000000021', 'a123000d-0000-4000-8000-000000000021',
  1, 'c0a00002-0000-4000-8000-000000000002', 'order-route-lab-attestation-v1', 'sealed-qa-send-0001',
  encode(sha256('sealed-qa-send-0001'::bytea), 'hex'))), true);
set local role hid_lab_api_runtime;
select pg_temp.as_qa_staff(3, '31', 2);
select pg_temp.assert('QA Laboratory accepts the order from QA Hospital by the Health ID',
  (select result = 'accepted' and work_item_id is not null
     from lab.accept_order_route(current_setting('hid.test.qa_route')::uuid, 1, 'health_id', 'HID-ZQAAAAA2',
       'sealed-qa-accept-0001', repeat('e', 64))));
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_qa_clinician();
select pg_temp.assert('a request to QA Patient Two and the right PIN work within QA',
  (select request_status = 'pending' and subject_patient_id = 'c0a00009-0000-4000-8000-000000000002'
     from identity.create_access_request('HID-ZQAAAAA3', 'read_records', 'Review before the clinic visit', 60))
  and (select verified and grant_status = 'active' from identity.access_patient_with_pin('HID-ZQAAAAA3', '1357', 30)));
select pg_temp.assert('the clinician accepts QA Patient Two''s invitation at QA Hospital',
  (select status = 'accepted' and not replayed
     from identity.accept_share_invitation(current_setting('hid.test.qa_invitation')::uuid)));
select pg_temp.as_qa_patient(2);
select pg_temp.assert('QA Patient Two shares with the QA Migrate User at QA Hospital',
  (select membership_id = 'c0a00005-0000-4000-8000-000000000021' and facility_name = 'QA Hospital'
     from identity.create_my_consent_share('patient:c0a00008-0000-4000-8000-000000000002',
       'a123000b-0000-4000-8000-000000000022', 'c0a00005-0000-4000-8000-000000000021', 'view_only', '24h',
       'sealed-qa-share-0001', repeat('d', 64))));
reset role;
select pg_temp.assert('no route, grant or request crosses the boundary',
  not exists (select 1 from ehr.order_routes route
               where identity.sealed_qa_facility(route.ordering_facility_id)
                  <> identity.sealed_qa_facility(route.receiving_facility_id))
  and (select count(*) from ehr.order_routes route where identity.sealed_qa_facility(route.ordering_facility_id)) = 1
  and not exists (select 1 from identity.consent_grants grant_row
                   where identity.sealed_qa_patient(grant_row.patient_id)
                      <> identity.sealed_qa_facility(coalesce(grant_row.facility_id,
                           (select membership.facility_id from identity.staff_facility_memberships membership
                             where membership.id = grant_row.membership_id))))
  and not exists (select 1 from identity.access_requests request
                   where identity.sealed_qa_patient(request.patient_id) <> identity.sealed_qa_facility(request.facility_id)));

select pg_temp.assert('after recovery, the QA Outreach group, the order, the new share and the request, another install inserts nothing',
  (select (summary->>'inserted')::integer = 0 and (summary->>'shares')::integer = 1 and (summary->>'patients')::integer = 2
          and (summary->>'accounts')::integer = 9 and (summary->>'facilities')::integer = 4
     from (select identity.sealed_qa_install() as summary) installed)
  and (select count(*) from audit.events event where event.correlation_id = '0123-sealed-qa-install') = 2);

-- The install stays idempotent after a QA patient changed their email (allowed within the owner's domain)
-- and a staff login's address changed (owner SQL, undone).
savepoint email_changed;
update auth.accounts set email = 'patient1+qa-new@healthidentitydirectory.com'
 where id = 'c0a00008-0000-4000-8000-000000000001';
update auth.accounts set email = 'operations+qa-lab-new@healthidentitydirectory.com'
 where id = 'c0a00003-0000-4000-8000-000000000004';
update identity.staff set email = 'operations+qa-lab-new@healthidentitydirectory.com'
 where id = 'c0a00004-0000-4000-8000-000000000004';
select pg_temp.assert('after QA email changes, another install inserts nothing',
  (select (summary->>'inserted')::integer = 0 from (select identity.sealed_qa_install() as summary) installed));
rollback to savepoint email_changed;

-- 8. A member is never both demo and QA, whichever table it reaches first.
select pg_temp.assert('a QA member is refused as a demo member, and a demo member as a QA member',
  pg_temp.try($q$insert into identity.sealed_demo_members (member_kind, member_id)
    values ('facility', 'c0a00002-0000-4000-8000-000000000001')$q$) = '42501 SEALED_QA_DEMO_OVERLAP'
  and pg_temp.try($q$insert into identity.sealed_demo_members (member_kind, member_id)
    values ('patient', 'c0a00009-0000-4000-8000-000000000002')$q$) = '42501 SEALED_QA_DEMO_OVERLAP'
  and pg_temp.try($q$insert into identity.sealed_qa_members (member_kind, member_id)
    values ('account', '98d00003-0000-4000-8000-000000000001')$q$) = '42501 SEALED_QA_DEMO_OVERLAP'
  and pg_temp.try($q$insert into identity.sealed_qa_members (member_kind, member_id)
    values ('facility', '98d00002-0000-4000-8000-000000000002')$q$) = '42501 SEALED_QA_DEMO_OVERLAP'
  and not identity.sealed_demo_facility('c0a00002-0000-4000-8000-000000000001')
  and not identity.sealed_qa_facility('98d00002-0000-4000-8000-000000000002')
  and not exists (select 1 from identity.sealed_qa_members qa_member
                   join identity.sealed_demo_members demo_member
                     on demo_member.member_kind = qa_member.member_kind and demo_member.member_id = qa_member.member_id));

select 'sealed qa tenant: all assertions passed' as result;
rollback;
