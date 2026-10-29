\set ON_ERROR_STOP on
-- The sealed demo tenant (0098, owner decision of 2026-10-29 "Sealed demo,
-- yes"). Rollback-only. On the databases CI and the release rehearsals use
-- (plain PostgreSQL, no rds_superuser) 0098 installs the seal and not the
-- seed, so this suite calls identity.sealed_demo_install() itself, as the
-- owner, inside its transaction.
--   1. structure: the members table (RLS enabled, not forced, one owner
--      policy, no grant, no update, delete or TRUNCATE), the helpers' ACLs,
--      the nine triggers, the policy, the new bodies' md5; no runtime role
--      reads the members;
--   2. the install: every row, accounts pending_reset without a password and
--      with a verified email, the four shares of Patient One and Two (D6),
--      the audit row without an address or Health ID, a second call inserts
--      nothing, the platform overview unchanged;
--   3. its refusals, each writing nothing: an address of the tenant held by
--      another account (any case, pending_reset too), a staff record, an open
--      organization application or a pending staff invitation, a Health ID,
--      a facility code, a CAC, a fixed id held by a real row; a deleted
--      account, a closed application and an expired invitation at the
--      address are no obstacle;
--   4. demo to real: Health ID lookups, access requests, break-glass, the
--      PIN (the right PIN answers as a wrong one), a direct grant, the order
--      directory and send, staff invitations, memberships, platform roles,
--      QoreID, share invitations both ways, a phone, an email change, the
--      emergency-contact check and the database's own contact rule (G7);
--   5. real to demo: the same boundary from the real side;
--   6. within the demo tenant: recovery as the owner will do it, writing in
--      Patient One's and Two's charts through the seeded shares (break-glass
--      only reads), a request approved by Patient One, break-glass on a
--      fictional patient, an order from Demo Hospital accepted at Demo
--      Laboratory, the permissions every portal needs, the admin markers, the
--      off switch;
--   7. real tenants unchanged: each changed function and the policy answer
--      the real fixture alike before and after the install.
-- Synthetic values only: the real tenant uses uuid prefix 98a and
-- @example.invalid addresses; the recovery uses the repository's non-hash
-- placeholder, never a password or a hash.
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
update platform.control_settings set enabled = true where control_key = 'cross_facility_orders_enabled';
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'sealed-demo-test'), ('emergency', 'Emergency', 'sealed-demo-test')
  on conflict (code) do update set active = true;

-- Helpers: an assertion, a statement's outcome ('ok' or SQLSTATE and
-- message), the contexts the services set.
create function pg_temp.assert(label text, condition boolean, detail text default null)
returns void language plpgsql as $f$
begin
  if condition is not true then
    raise exception 'sealed demo: % failed%', label, coalesce(': ' || detail, '');
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
    set_config('app.membership_id', membership::text, true),
    set_config('app.facility_id', facility::text, true),
    set_config('app.correlation_id', 'sealed-demo-' || substr(md5(random()::text), 1, 12), true),
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
    set_config('app.correlation_id', 'sealed-demo-patient-' || substr(md5(random()::text), 1, 12), true),
    set_config('app.purpose_of_use', 'patient-self', true);
$f$;
create function pg_temp.as_system()
returns void language sql as $f$
  select set_config('app.actor_subject', 'system:auth', true),
    set_config('app.correlation_id', 'sealed-demo-system-' || substr(md5(random()::text), 1, 12), true),
    set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
    set_config('app.purpose_of_use', '', true), set_config('app.patient_id', '', true);
$f$;
-- A probe's answer, recorded under a phase; a probe that writes runs in a
-- subtransaction that is undone, so that before and after the install it
-- meets the same rows.
create temp table sealed_probes (label text not null, phase text not null, answer text, primary key (label, phase));
create function pg_temp.probe(label text, phase text, statement text)
returns void language plpgsql as $f$
declare answer text;
begin
  begin
    answer := pg_temp.value_of(statement);
    raise exception using errcode = 'P0999', message = 'undo';
  exception when sqlstate 'P0999' then
    null;
  end;
  insert into sealed_probes values (label, phase, answer);
end
$f$;
grant select, insert on sealed_probes to hid_identity_api_runtime, hid_ehr_api_runtime, hid_lab_api_runtime,
  hid_schema_test_runtime;

-- The real tenant: hospital R (governed), laboratory RL (governed, product
-- laboratory, a lab member), doctor RD at R (doctor and org_admin), lab
-- scientist RLM at RL, a platform administrator RA, and patient RP with a
-- login, a live session and a PIN; RD holds a write consent for RP at R.
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at) values
  ('98a00003-0000-4000-8000-000000000001', 'synthetic:sealed:doctor', 'sealed-doctor@example.invalid', 'Real Doctor', 'active', clock_timestamp()),
  ('98a00003-0000-4000-8000-000000000002', 'synthetic:sealed:lab', 'sealed-lab@example.invalid', 'Real Lab', 'active', clock_timestamp()),
  ('98a00003-0000-4000-8000-000000000009', 'synthetic:sealed:admin', 'sealed-admin@example.invalid', 'Real Admin', 'active', clock_timestamp()),
  ('98a00008-0000-4000-8000-000000000001', 'synthetic:sealed:patient', 'sealed-patient@example.invalid', 'Real Patient', 'active', clock_timestamp());
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('98a00006-0000-4000-8000-000000000099', '98a00003-0000-4000-8000-000000000009', 'platform_super_admin', 'platform',
   'Sealed demo suite administrator');
insert into identity.organizations (id, name, slug) values
  ('98a00001-0000-4000-8000-000000000001', 'Sealed Real Hospital Ltd', 'sealed-real-hospital'),
  ('98a00001-0000-4000-8000-000000000002', 'Sealed Real Diagnostics Ltd', 'sealed-real-diagnostics');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('98a00002-0000-4000-8000-000000000001', '98a00001-0000-4000-8000-000000000001', 'Sealed Real Hospital', 'SRL-HOSP',
   'Africa/Lagos', true, 'verified'),
  ('98a00002-0000-4000-8000-000000000002', '98a00001-0000-4000-8000-000000000002', 'Sealed Real Laboratory', 'SRL-LAB',
   'Africa/Lagos', true, 'verified');
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, verified_at,
  organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at, verified_organization_name)
values
  ('98a00007-0000-4000-8000-000000000001', 'ehr', 'Sealed Real Hospital Ltd', 'hospital', 'RC9898001', 'Real Admin',
   'sealed-admin@example.invalid', 'approved', 'verified', clock_timestamp(), '98a00001-0000-4000-8000-000000000001',
   '98a00002-0000-4000-8000-000000000001', '98a00003-0000-4000-8000-000000000009', 'Governed approval for the suite',
   clock_timestamp(), 'Sealed Real Hospital Ltd'),
  ('98a00007-0000-4000-8000-000000000002', 'laboratory', 'Sealed Real Diagnostics Ltd', 'laboratory', 'RC9898002',
   'Real Admin', 'sealed-admin@example.invalid', 'approved', 'verified', clock_timestamp(),
   '98a00001-0000-4000-8000-000000000002', '98a00002-0000-4000-8000-000000000002', '98a00003-0000-4000-8000-000000000009',
   'Governed approval for the suite', clock_timestamp(), 'Sealed Real Diagnostics Ltd');
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id) values
  ('98a00001-0000-4000-8000-000000000001', 'ehr', '98a00002-0000-4000-8000-000000000001', 'active', '98a00007-0000-4000-8000-000000000001'),
  ('98a00001-0000-4000-8000-000000000002', 'laboratory', '98a00002-0000-4000-8000-000000000002', 'active', '98a00007-0000-4000-8000-000000000002');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('98a00004-0000-4000-8000-000000000001', '98a00003-0000-4000-8000-000000000001', 'Rita Realdoctor', 'sealed-doctor@example.invalid', 'verified', 'doctor'),
  ('98a00004-0000-4000-8000-000000000002', '98a00003-0000-4000-8000-000000000002', 'Lami Reallab', 'sealed-lab@example.invalid', 'verified', 'lab');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id, membership_role,
  app_role, is_primary, active) values
  ('98a00005-0000-4000-8000-000000000001', '98a00004-0000-4000-8000-000000000001', '98a00003-0000-4000-8000-000000000001',
   '98a00001-0000-4000-8000-000000000001', '98a00002-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true),
  ('98a00005-0000-4000-8000-000000000002', '98a00004-0000-4000-8000-000000000002', '98a00003-0000-4000-8000-000000000002',
   '98a00001-0000-4000-8000-000000000002', '98a00002-0000-4000-8000-000000000002', 'lab', 'lab', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('98a00006-0000-4000-8000-000000000011', '98a00003-0000-4000-8000-000000000001', 'doctor', 'facility',
   '98a00005-0000-4000-8000-000000000001', '98a00002-0000-4000-8000-000000000001', 'Sealed demo suite doctor'),
  ('98a00006-0000-4000-8000-000000000012', '98a00003-0000-4000-8000-000000000001', 'org_admin', 'facility',
   '98a00005-0000-4000-8000-000000000001', '98a00002-0000-4000-8000-000000000001', 'Sealed demo suite administrator'),
  ('98a00006-0000-4000-8000-000000000021', '98a00003-0000-4000-8000-000000000002', 'lab', 'facility',
   '98a00005-0000-4000-8000-000000000002', '98a00002-0000-4000-8000-000000000002', 'Sealed demo suite lab scientist');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('98a00009-0000-4000-8000-000000000001', '98a00008-0000-4000-8000-000000000001', 'HID-SRLPAT', 'Rafa', 'Realpatient',
   'Rafa Realpatient', 'male', '1980-02-02', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('98a0000b-0000-4000-8000-000000000001', '98a00008-0000-4000-8000-000000000001', '98a0000b-0000-4000-8000-000000000001',
   md5('sealed-real') || md5('sealed-real'), gen_random_uuid(), 1, 'password', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   '98a00009-0000-4000-8000-000000000001');
insert into identity.patient_access_pins (patient_id, pin_hash, source_system, source_record_id, source_created_at,
  source_updated_at)
values ('98a00009-0000-4000-8000-000000000001', crypt('2468', gen_salt('bf', 6)), 'supabase', 'sealed-real-pin',
  clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use) values
  ('98a0000c-0000-4000-8000-000000000001', '98a00009-0000-4000-8000-000000000001', '98a00004-0000-4000-8000-000000000001',
   '98a00003-0000-4000-8000-000000000001', '98a00005-0000-4000-8000-000000000001', '98a00002-0000-4000-8000-000000000001',
   'write_records', 'active', 'Sealed demo suite consent', clock_timestamp() - interval '1 hour',
   clock_timestamp() + interval '30 days', false, 'direct-care');
-- RD's encounter and lab request for RP at R (through the EHR runtime).
set local role hid_ehr_api_runtime;
select pg_temp.as_staff('synthetic:sealed:doctor', '98a00005-0000-4000-8000-000000000001',
  '98a00002-0000-4000-8000-000000000001');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('98a0000d-0000-4000-8000-000000000001', '98a00009-0000-4000-8000-000000000001',
  '98a00002-0000-4000-8000-000000000001', '98a00003-0000-4000-8000-000000000001',
  '98a00005-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
values ('98a0000e-0000-4000-8000-000000000001', '98a0000d-0000-4000-8000-000000000001',
  '98a00009-0000-4000-8000-000000000001', '98a00002-0000-4000-8000-000000000001',
  '98a00003-0000-4000-8000-000000000001', '98a00005-0000-4000-8000-000000000001', 'http://loinc.org', '718-7',
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

-- The probes of section 7, as the real tenant meets them (phase 'before'):
-- RD's Health ID lookup, request, break-glass, PIN, order directory and send;
-- RP's share directory; the platform overview.
create function pg_temp.real_probes(phase text)
returns void language plpgsql as $f$
begin
  execute 'set local role hid_identity_api_runtime';
  perform pg_temp.as_staff('synthetic:sealed:doctor', '98a00005-0000-4000-8000-000000000001',
    '98a00002-0000-4000-8000-000000000001');
  perform pg_temp.probe('lookup', phase,
    $q$select string_agg(hid_code, ',' order by hid_code) from identity.patients where upper(hid_code) in ('HID-SRLPAT')$q$);
  perform pg_temp.probe('lookup-all', phase,
    $q$select count(*)::text from identity.patients where hid_code like 'HID-SRL%'$q$);
  perform pg_temp.probe('request', phase,
    $q$select request_status || ' ' || existing_request || ' ' || (subject_patient_id = '98a00009-0000-4000-8000-000000000001')
       from identity.create_access_request('HID-SRLPAT', 'read_records', 'Review before the clinic visit', 60)$q$);
  perform pg_temp.probe('directory', phase,
    $q$select string_agg(facility_name, ',' order by facility_name) from identity.search_order_destinations('lab_request', 'Sealed')$q$);
  perform pg_temp.as_staff('synthetic:sealed:doctor', '98a00005-0000-4000-8000-000000000001',
    '98a00002-0000-4000-8000-000000000001', 'emergency');
  perform pg_temp.probe('break-glass', phase,
    $q$select grant_status || ' ' || existing_grant from identity.activate_break_glass('HID-SRLPAT',
       'Unconscious on arrival at the ward', 30)$q$);
  perform pg_temp.as_staff('synthetic:sealed:doctor', '98a00005-0000-4000-8000-000000000001',
    '98a00002-0000-4000-8000-000000000001');
  perform pg_temp.probe('pin', phase,
    $q$select verified || ' ' || coalesce(grant_status, '-') from identity.access_patient_with_pin('HID-SRLPAT', '2468', 30)$q$);
  perform pg_temp.probe('pin-wrong', phase,
    $q$select verified::text from identity.access_patient_with_pin('HID-SRLPAT', '1111', 30)$q$);
  perform pg_temp.as_patient('synthetic:sealed:patient', '98a00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000001', '98a00009-0000-4000-8000-000000000001');
  perform pg_temp.probe('share-directory', phase,
    $q$select coalesce(string_agg(clinician_name || '@' || facility_name, ',' order by clinician_name), '')
       from identity.search_share_providers('synthetic:sealed:patient', '98a0000b-0000-4000-8000-000000000001', 'Rita')$q$);
  perform pg_temp.as_staff('synthetic:sealed:admin', null, null, 'healthcare-operations');
  perform pg_temp.probe('overview', phase,
    $q$select row(registered_patients, facilities, verified_facilities, suspended_facilities, active_memberships,
       pending_identity_reviews)::text from identity.admin_platform_overview()$q$);
  execute 'set local role hid_ehr_api_runtime';
  perform pg_temp.as_staff('synthetic:sealed:doctor', '98a00005-0000-4000-8000-000000000001',
    '98a00002-0000-4000-8000-000000000001');
  perform pg_temp.probe('send', phase,
    $q$select state || ' ' || receiving_facility_name from ehr.send_order_route(gen_random_uuid(), 'lab_request',
       '98a00009-0000-4000-8000-000000000001', '98a0000e-0000-4000-8000-000000000001',
       '98a0000d-0000-4000-8000-000000000001', 1, '98a00002-0000-4000-8000-000000000002',
       'order-route-lab-attestation-v1', 'sealed-real-send-0001', encode(sha256('sealed-real-send-0001'::bytea), 'hex'))$q$);
  execute 'reset role';
end
$f$;
select pg_temp.real_probes('before');

-- 1. Structure.
do $$
begin
  perform pg_temp.assert('the members table: RLS enabled and not forced, one owner policy, no grant',
    (select relation.relrowsecurity and not relation.relforcerowsecurity from pg_class relation
      where relation.oid = 'identity.sealed_demo_members'::regclass)
    and (select count(*) from pg_policy policy_row where policy_row.polrelid = 'identity.sealed_demo_members'::regclass) = 1
    and not exists (select 1 from pg_class relation, aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                     where relation.oid = 'identity.sealed_demo_members'::regclass and acl.grantee <> relation.relowner));
  perform pg_temp.assert('no runtime role reads the members',
    not exists (select 1 from pg_roles runtime where runtime.rolname ~ '^hid_' and not runtime.rolsuper
      and runtime.oid <> (select relation.relowner from pg_class relation where relation.oid = 'identity.sealed_demo_members'::regclass)
      and (has_table_privilege(runtime.oid, 'identity.sealed_demo_members', 'SELECT')
        or has_table_privilege(runtime.oid, 'identity.sealed_demo_members', 'INSERT'))));
  perform pg_temp.assert('helper ACLs: the policy helpers, the application marker and the contact check to the Identity and schema test runtimes only',
    (select array_agg(proc.oid::regprocedure::text order by proc.oid::regprocedure::text)
       from pg_proc proc
      where proc.pronamespace = 'identity'::regnamespace
        and (proc.proname like 'sealed\_demo\_%' or proc.proname like '%\_sealed\_demo')
        and has_function_privilege('hid_identity_runtime', proc.oid, 'EXECUTE'))
    = array['identity.sealed_demo_application(uuid)',
            'identity.sealed_demo_contact_allowed(text,uuid,text,text,character)', 'identity.sealed_demo_facility(uuid)',
            'identity.sealed_demo_ids(text)']
    and (select count(*) from pg_proc proc
          where proc.pronamespace = 'identity'::regnamespace
            and (proc.proname like 'sealed\_demo\_%' or proc.proname like '%\_sealed\_demo')) = 15
    and not exists (select 1 from pg_proc proc, pg_roles runtime
                     where proc.pronamespace = 'identity'::regnamespace
                       and (proc.proname like 'sealed\_demo\_%' or proc.proname like '%\_sealed\_demo')
                       and runtime.rolname in ('hid_ehr_runtime', 'hid_lab_runtime', 'hid_pharmacy_runtime',
                         'hid_notification_runtime', 'hid_outreach_runtime', 'hid_ocr_runtime')
                       and has_function_privilege(runtime.oid, proc.oid, 'EXECUTE'))
    and not has_function_privilege('hid_identity_api_runtime', 'identity.sealed_demo_install()', 'EXECUTE')
    and not has_function_privilege('hid_identity_api_runtime', 'identity.sealed_demo_patient(uuid)', 'EXECUTE'));
  perform pg_temp.assert('nine triggers, enabled',
    (select count(*) from pg_trigger trigger_row where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
      and trigger_row.tgname in ('sealed_demo_members_immutable', 'sealed_demo_members_no_truncate',
        'consent_grants_sealed_demo', 'staff_memberships_sealed_demo', 'account_roles_sealed_demo',
        'patient_share_invitations_sealed_demo', 'patient_contact_changes_sealed_demo',
        'qoreid_quota_counters_sealed_demo', 'patient_emergency_contacts_sealed_demo')) = 9);
  perform pg_temp.assert('the eight new bodies',
    (select count(*) from (values
      ('identity.create_access_request(text,text,text,integer)', 'f88923a49a180c2180fdedb29bf2eccf'),
      ('identity.activate_break_glass(text,text,integer)', '6b888391ef7f0e4f264918baf00a6fe7'),
      ('identity.access_patient_with_pin(text,text,integer)', '830c1baa4bca3df57cc02b7b002a8831'),
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', '4202ba3bbf02abd7db34606d42adca9c'),
      ('identity.search_order_destinations(text,text)', '7890a21333d012621a36302fd7ad24cc'),
      ('identity.search_share_providers(text,uuid,text)', '2cc1107289f6ff4d55266c6ee4842932'),
      ('identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)',
       'b253ba70b4532a62b15eae6ae50465c1'),
      ('identity.admin_platform_overview()', '3b1b2ca005647190ea623c40afb4f96f')) pinned(signature, digest)
      join pg_proc proc on proc.oid = pinned.signature::regprocedure and md5(proc.prosrc) = pinned.digest) = 8);
  perform pg_temp.assert('the registration read is sealed and identity.patients keeps six policies',
    (select count(*) from pg_policy policy_row where policy_row.polrelid = 'identity.patients'::regclass) = 6
    and (select pg_get_expr(policy_row.polqual, policy_row.polrelid) from pg_policy policy_row
          where policy_row.polrelid = 'identity.patients'::regclass and policy_row.polname = 'patients_registration_read')
      like '%sealed_demo_ids(''patient''::text)%sealed_demo_facility(platform.current_facility_id())%');
  perform pg_temp.assert('the recipient allowlist: exactly the three demo mailboxes, any case, nothing else',
    identity.sealed_demo_recipient('operations@healthidentitydirectory.com')
    and identity.sealed_demo_recipient(' Patient1@HealthIdentityDirectory.com ')
    and identity.sealed_demo_recipient('PATIENT2@healthidentitydirectory.com')
    and not identity.sealed_demo_recipient('operations+patient1@healthidentitydirectory.com')
    and not identity.sealed_demo_recipient('operations+a.b_c-9@healthidentitydirectory.com')
    and not identity.sealed_demo_recipient('patient1+x@healthidentitydirectory.com')
    and not identity.sealed_demo_recipient('patient3@healthidentitydirectory.com')
    and not identity.sealed_demo_recipient('support@healthidentitydirectory.com')
    and not identity.sealed_demo_recipient('operations@healthidentitydirectory.co')
    and not identity.sealed_demo_recipient('xoperations@healthidentitydirectory.com')
    and not identity.sealed_demo_recipient('patient1@healthidentitydirectory.com.evil.example')
    and not identity.sealed_demo_recipient('patient1@evil.example')
    and not identity.sealed_demo_recipient('operations@healthidentitydirectory.com, someone@example.invalid')
    and not identity.sealed_demo_recipient('')
    and not identity.sealed_demo_recipient(null));
end $$;
set local role hid_identity_api_runtime;
select pg_temp.as_staff('synthetic:sealed:doctor', '98a00005-0000-4000-8000-000000000001',
  '98a00002-0000-4000-8000-000000000001');
select pg_temp.assert('the Identity runtime plans its Health ID lookup under the sealed policy',
  pg_temp.try($q$explain select id from identity.patients where upper(hid_code) = upper('HID-SRLPAT') and status = 'active'$q$) = 'ok');
select pg_temp.assert('the Identity runtime reads no member row',
  pg_temp.try('select count(*) from identity.sealed_demo_members') like '42501 %');
reset role;
-- The members are never updated, deleted or truncated (a savepoint undoes the
-- probe row).
savepoint immutable_probe;
insert into identity.sealed_demo_members values ('facility', '98a00002-0000-4000-8000-000000000001');
do $$
begin
  perform pg_temp.assert('a member row is never updated or deleted',
    pg_temp.try($q$delete from identity.sealed_demo_members where member_id = '98a00002-0000-4000-8000-000000000001'$q$)
      like '55000 %'
    and pg_temp.try($q$update identity.sealed_demo_members set member_kind = 'patient'
      where member_id = '98a00002-0000-4000-8000-000000000001'$q$) like '55000 %');
  perform pg_temp.assert('the members are never truncated',
    pg_temp.try('truncate identity.sealed_demo_members') = '55000 identity.sealed_demo_members is append-only'
    and identity.sealed_demo_facility('98a00002-0000-4000-8000-000000000001'));
end $$;
-- The seal fails closed, never open: row-level security on the members is not
-- forced, so when the table and its helpers change hands together (REASSIGN
-- OWNED, an owner alignment) the helpers still read every member, and a helper
-- whose owner may not read the table raises 42501 instead of answering "not
-- demo". (Undone with the savepoint, the role too.)
create role sealed_suite_new_owner nosuperuser nobypassrls;
grant usage on schema identity to sealed_suite_new_owner;
alter function identity.sealed_demo_facility(uuid) owner to sealed_suite_new_owner;
select pg_temp.assert('a helper whose owner may not read the members fails closed',
  pg_temp.try($q$select identity.sealed_demo_facility('98a00002-0000-4000-8000-000000000001')$q$) like '42501 %');
alter table identity.sealed_demo_members owner to sealed_suite_new_owner;
alter function identity.sealed_demo_ids(text) owner to sealed_suite_new_owner;
select pg_temp.assert('the table and its helpers under a new owner still read every member',
  identity.sealed_demo_facility('98a00002-0000-4000-8000-000000000001')
  and '98a00002-0000-4000-8000-000000000001'::uuid = any(identity.sealed_demo_ids('facility')));
rollback to savepoint immutable_probe;
select pg_temp.assert('the probe row is gone', not exists (select 1 from identity.sealed_demo_members));

-- 3. The install's refusals, before the tenant exists: each in a savepoint,
-- each 55000 with a message that names no address or Health ID, and nothing
-- written.
create function pg_temp.refused(label text, expected text)
returns void language plpgsql as $f$
declare answer text := pg_temp.try('select identity.sealed_demo_install()');
begin
  perform pg_temp.assert(label, answer = '55000 0098: ' || expected, answer);
  perform pg_temp.assert(label || ': nothing written',
    not exists (select 1 from identity.sealed_demo_members)
    and not exists (select 1 from identity.organizations where slug like 'sealed-demo-%')
    and not exists (select 1 from auth.accounts where id = '98d00003-0000-4000-8000-000000000001')
    and not exists (select 1 from audit.events where action = 'identity.sealed-demo.install'));
end
$f$;
savepoint refusal;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('98a00003-0000-4000-8000-000000000031', 'synthetic:sealed:owner-login', 'operations@healthidentitydirectory.com',
   'Owner Login', 'active');
select pg_temp.refused('an active account at the staff address', 'SEALED_DEMO_ADDRESS_TAKEN');
rollback to savepoint refusal;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('98a00003-0000-4000-8000-000000000031', 'synthetic:sealed:owner-login', 'OPERATIONS@HealthIdentityDirectory.com',
   'Owner Login', 'active');
select pg_temp.refused('the address in another case', 'SEALED_DEMO_ADDRESS_TAKEN');
rollback to savepoint refusal;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('98a00003-0000-4000-8000-000000000031', 'synthetic:sealed:owner-patient', 'patient2@healthidentitydirectory.com',
   'Owner Patient', 'pending_reset');
select pg_temp.refused('a pending_reset account at a patient address', 'SEALED_DEMO_ADDRESS_TAKEN');
rollback to savepoint refusal;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('98a00003-0000-4000-8000-000000000031', 'synthetic:sealed:staff-elsewhere', 'staff-elsewhere@example.invalid',
   'Staff Elsewhere', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('98a00004-0000-4000-8000-000000000031', '98a00003-0000-4000-8000-000000000031', 'Staff Elsewhere',
   'operations@healthidentitydirectory.com', 'verified', 'doctor');
select pg_temp.refused('a staff record at the staff address', 'SEALED_DEMO_ADDRESS_TAKEN');
rollback to savepoint refusal;
-- In-flight records naming a demo address: an open organization application
-- (its first administrator) or a pending staff invitation would be broken by
-- the seed, so the install refuses.
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status)
values ('98a00007-0000-4000-8000-000000000032', 'ehr', 'Owner Clinic Ltd', 'clinic', 'RC9898032', 'Owner Admin',
  'operations@healthidentitydirectory.com', 'pending_verification');
select pg_temp.refused('an open application names the staff address', 'SEALED_DEMO_ADDRESS_TAKEN');
rollback to savepoint refusal;
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status)
values ('98a00007-0000-4000-8000-000000000033', 'laboratory', 'Owner Lab Ltd', 'laboratory', 'RC9898033', 'Owner Admin',
  'patient1@healthidentitydirectory.com', 'pending_verification');
select pg_temp.refused('an open application names a patient address', 'SEALED_DEMO_ADDRESS_TAKEN');
rollback to savepoint refusal;
insert into identity.staff_invitations (id, organization_id, facility_id, invited_by_account_id, invited_by_membership_id,
  invitee_name, invitee_email, role_code, licence_body, licence_number, attestation_version, attested_at,
  link_token_hmac, email_code_hmac, key_version, last_sent_at, last_send_id, expires_at, idempotency_key,
  request_sha256, correlation_id)
values ('98a00011-0000-4000-8000-000000000001', '98a00001-0000-4000-8000-000000000001',
  '98a00002-0000-4000-8000-000000000001', '98a00003-0000-4000-8000-000000000001',
  '98a00005-0000-4000-8000-000000000001', 'Owner Person', 'operations@healthidentitydirectory.com', 'receptionist', null,
  null, 'facility-staff-attestation-v1', clock_timestamp(), repeat('1', 64), repeat('2', 64), 'v1', clock_timestamp(),
  gen_random_uuid(), clock_timestamp() + interval '7 days', 'sealed-suite-pending-invite', repeat('c', 64),
  'sealed-suite-seed');
select pg_temp.refused('a pending staff invitation names the staff address', 'SEALED_DEMO_ADDRESS_TAKEN');
rollback to savepoint refusal;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('98a00009-0000-4000-8000-000000000031', 'HID-ZDEMBBB5', 'Taken', 'Healthid', 'Taken Healthid', 'active');
select pg_temp.refused('a real patient holds a demo Health ID', 'SEALED_DEMO_KEY_TAKEN');
rollback to savepoint refusal;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('98a00009-0000-4000-8000-000000000031', 'HID-SRLTKN', 'Taken', 'Identifier', 'Taken Identifier', 'active');
insert into identity.patient_identifiers (id, patient_id, identifier_type, public_value, verified) values
  ('98a0000a-0000-4000-8000-000000000031', '98a00009-0000-4000-8000-000000000031', 'hid_code', 'hid-zdemaaa2', true);
select pg_temp.refused('a real identifier holds a demo Health ID', 'SEALED_DEMO_KEY_TAKEN');
rollback to savepoint refusal;
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('98a00002-0000-4000-8000-000000000031', '98a00001-0000-4000-8000-000000000001', 'A Real Annex', 'demo-laboratory',
   'Africa/Lagos', true, 'verified');
select pg_temp.refused('a real facility holds a demo code', 'SEALED_DEMO_KEY_TAKEN');
rollback to savepoint refusal;
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status)
values ('98a00007-0000-4000-8000-000000000031', 'laboratory', 'Someone Else Ltd', 'laboratory', 'RC00000000000000098002',
  'Someone Else', 'someone@example.invalid', 'pending_verification');
select pg_temp.refused('an open application holds a demo CAC', 'SEALED_DEMO_KEY_TAKEN');
rollback to savepoint refusal;
insert into identity.organizations (id, name, slug) values
  ('98d00001-0000-4000-8000-000000000003', 'Not The Demo', 'not-the-demo');
select pg_temp.refused('a real row at a fixed id', 'SEALED_DEMO_ID_TAKEN');
rollback to savepoint refusal;
insert into identity.organizations (id, name, slug) values
  ('98a00001-0000-4000-8000-000000000031', 'Slug Holder', 'Sealed-Demo-Pharmacy');
select pg_temp.refused('a real organization holds a demo slug', 'SEALED_DEMO_KEY_TAKEN');
rollback to savepoint refusal;
-- A deleted account at the address is no obstacle (the unique index ignores
-- it too); the install then succeeds (undone here).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('98a00003-0000-4000-8000-000000000031', 'synthetic:sealed:deleted', 'operations@healthidentitydirectory.com',
   'Deleted Login', 'deleted');
select pg_temp.assert('a deleted account at the address is accepted',
  (identity.sealed_demo_install()->>'inserted')::integer > 0);
rollback to savepoint refusal;
-- So are a closed application and an invitation past its expiry (neither can
-- be approved or accepted any more).
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, reviewed_by_account_id, review_reason,
  reviewed_at)
values ('98a00007-0000-4000-8000-000000000034', 'ehr', 'Owner Clinic Ltd', 'clinic', 'RC9898034', 'Owner Admin',
  'operations@healthidentitydirectory.com', 'rejected', '98a00003-0000-4000-8000-000000000009',
  'Rejected in the suite', clock_timestamp());
insert into identity.staff_invitations (id, organization_id, facility_id, invited_by_account_id, invited_by_membership_id,
  invitee_name, invitee_email, role_code, licence_body, licence_number, attestation_version, attested_at,
  link_token_hmac, email_code_hmac, key_version, last_sent_at, last_send_id, expires_at, idempotency_key,
  request_sha256, correlation_id, created_at)
values ('98a00011-0000-4000-8000-000000000002', '98a00001-0000-4000-8000-000000000001',
  '98a00002-0000-4000-8000-000000000001', '98a00003-0000-4000-8000-000000000001',
  '98a00005-0000-4000-8000-000000000001', 'Owner Person', 'operations@healthidentitydirectory.com', 'receptionist', null,
  null, 'facility-staff-attestation-v1', clock_timestamp() - interval '8 days', repeat('1', 64), repeat('2', 64), 'v1',
  clock_timestamp() - interval '8 days', gen_random_uuid(), clock_timestamp() - interval '1 day',
  'sealed-suite-lapsed-invite', repeat('c', 64), 'sealed-suite-seed', clock_timestamp() - interval '8 days');
select pg_temp.assert('a rejected application and a lapsed invitation at the address are accepted',
  (identity.sealed_demo_install()->>'inserted')::integer = 79);
rollback to savepoint refusal;
select pg_temp.assert('the savepoint left no demo row', not exists (select 1 from identity.sealed_demo_members));

-- 2. The install (it restores the caller's correlation id after the shares).
select set_config('app.correlation_id', 'sealed-suite-before-install', true);
create temp table sealed_install_1 as select identity.sealed_demo_install() as summary;
create temp table sealed_install_2 as select identity.sealed_demo_install() as summary;
do $$
declare
  first jsonb := (select summary from sealed_install_1);
  second jsonb := (select summary from sealed_install_2);
begin
  -- 21 members, 4 organizations, 4 facilities, 3 accounts, 1 staff record, 4
  -- memberships, 8 roles, 2 applications, 2 products, 10 patients, 10
  -- identifiers, 2 assurance states, and 4 shares (a consent grant and a
  -- share row each).
  perform pg_temp.assert('the first call inserts the tenant', (first->>'inserted')::integer = 79, first::text);
  perform pg_temp.assert('a second call inserts nothing and answers the same counts',
    (second->>'inserted')::integer = 0 and first - 'inserted' = second - 'inserted', second::text);
  perform pg_temp.assert('the counts',
    first - 'inserted' = '{"organizations": 4, "facilities": 4, "accounts": 3, "patients": 10, "memberships": 4, "roles": 8, "shares": 4}'::jsonb,
    first::text);
  perform pg_temp.assert('members',
    (select array_agg(member_kind || ':' || n order by member_kind)
       from (select member_kind, count(*) n from identity.sealed_demo_members group by member_kind) counted)
    = array['account:3', 'facility:4', 'organization:4', 'patient:10']);
  perform pg_temp.assert('the four facilities, verified and active',
    (select array_agg(facility.code || '|' || facility.name || '|' || organization.slug || '|' || facility.active
                      || '|' || facility.lifecycle_status || '|' || facility.timezone order by facility.code)
       from identity.facilities facility join identity.organizations organization on organization.id = facility.organization_id
      where identity.sealed_demo_facility(facility.id))
    = array['DEMO-HOSPITAL|Demo Hospital|sealed-demo-hospital|true|verified|Africa/Lagos',
            'DEMO-LABORATORY|Demo Laboratory|sealed-demo-laboratory|true|verified|Africa/Lagos',
            'DEMO-OUTREACH|Demo Outreach|sealed-demo-outreach|true|verified|Africa/Lagos',
            'DEMO-PHARMACY|Demo Pharmacy|sealed-demo-pharmacy|true|verified|Africa/Lagos']);
  perform pg_temp.assert('three accounts, pending_reset, no password, email verified',
    (select array_agg(account.email || '|' || account.status || '|' || (account.password_hash is null)
                      || '|' || (account.password_algorithm is null) || '|' || (account.email_verified_at is not null)
                      order by account.email)
       from auth.accounts account where identity.sealed_demo_account(account.id))
    = array['operations@healthidentitydirectory.com|pending_reset|true|true|true',
            'patient1@healthidentitydirectory.com|pending_reset|true|true|true',
            'patient2@healthidentitydirectory.com|pending_reset|true|true|true']);
  perform pg_temp.assert('the staff login: verified staff, four memberships, doctor lab pharmacist nurse and org_admin, no platform role',
    (select staff.verification_status = 'verified' and staff.active and staff.default_role = 'doctor'
       from identity.staff staff where staff.account_id = '98d00003-0000-4000-8000-000000000001')
    and (select array_agg(facility.code || ':' || membership.membership_role || ':' || membership.is_primary
                          order by facility.code)
           from identity.staff_facility_memberships membership
           join identity.facilities facility on facility.id = membership.facility_id
          where membership.account_id = '98d00003-0000-4000-8000-000000000001' and membership.active)
      = array['DEMO-HOSPITAL:doctor:true', 'DEMO-LABORATORY:lab:false', 'DEMO-OUTREACH:nurse:false',
              'DEMO-PHARMACY:pharmacist:false']
    and (select array_agg(facility.code || ':' || assignment.role_code order by facility.code, assignment.role_code)
           from auth.account_roles assignment join identity.facilities facility on facility.id = assignment.facility_id
          where assignment.account_id = '98d00003-0000-4000-8000-000000000001' and assignment.revoked_at is null)
      = array['DEMO-HOSPITAL:doctor', 'DEMO-HOSPITAL:org_admin', 'DEMO-LABORATORY:lab', 'DEMO-LABORATORY:org_admin',
              'DEMO-OUTREACH:nurse', 'DEMO-OUTREACH:org_admin', 'DEMO-PHARMACY:org_admin', 'DEMO-PHARMACY:pharmacist']
    and not exists (select 1 from auth.account_roles assignment
                     where assignment.account_id = '98d00003-0000-4000-8000-000000000001' and assignment.scope_type = 'platform'));
  perform pg_temp.assert('the laboratory and the pharmacy: an approved governed application and their product',
    (select array_agg(application.product_code || ':' || application.status || ':' || application.approval_mode
                      || ':' || product.status order by application.product_code)
       from identity.organization_applications application
       join identity.organization_products product on product.source_application_id = application.id
      where identity.sealed_demo_facility(application.facility_id))
    = array['laboratory:approved:admin_review:active', 'pharmacy:approved:admin_review:active']);
  perform pg_temp.assert('ten patients: two with a login, eight with no login and no contact',
    (select count(*) from identity.patients patient where identity.sealed_demo_patient(patient.id) and patient.status = 'active') = 10
    and (select array_agg(patient.hid_code || ':' || account.email order by patient.hid_code)
           from identity.patients patient join auth.accounts account on account.id = patient.account_id
          where identity.sealed_demo_patient(patient.id))
      = array['HID-ZDEMAAA2:patient1@healthidentitydirectory.com',
              'HID-ZDEMAAA3:patient2@healthidentitydirectory.com']
    and (select count(*) from identity.patients patient
          where identity.sealed_demo_patient(patient.id) and patient.account_id is null
            and patient.hid_code ~ '^HID-ZDEMBBB[2-9]$'
            and num_nonnulls(patient.phone_e164_ciphertext, patient.phone_lookup_hmac, patient.email_ciphertext,
              patient.email_lookup_hmac, patient.emergency_contact_ciphertext, patient.nin_last4, patient.nin_hash,
              patient.nin_ciphertext, patient.photo_object_key) = 0) = 8
    and (select count(*) from identity.patient_identifiers identifier
          where identity.sealed_demo_patient(identifier.patient_id) and identifier.identifier_type = 'hid_code'
            and identifier.verified) = 10
    and (select count(*) from identity.patient_assurance_states assurance
          where identity.sealed_demo_patient(assurance.patient_id) and assurance.state = 'CONTACT_VERIFIED') = 2);
  perform pg_temp.assert('Patient One and Two each share with the demo login at Demo Hospital and Demo Outreach, '
    || 'as the patient''s own Share writes it, once',
    (select array_agg(grant_row.patient_id::text || '|' || facility.code || '|' || grant_row.scope || '|'
                      || grant_row.purpose_of_use || '|' || grant_row.status || '|' || (not grant_row.break_glass)
                      || '|' || (grant_row.expires_at - grant_row.starts_at) || '|'
                      || (grant_row.granted_by_patient_id = grant_row.patient_id) || '|' || share.level || '|'
                      || share.duration_preset || '|' || share.created_via
                      order by grant_row.patient_id, facility.code)
       from identity.consent_grants grant_row
       join identity.patient_consent_shares share on share.consent_grant_id = grant_row.id
       join identity.facilities facility on facility.id = grant_row.facility_id
      where grant_row.correlation_id = '0098-sealed-demo-install')
    = array['98d00009-0000-4000-8000-000000000001|DEMO-HOSPITAL|write_records|direct-care|active|true|365 days|true|clinical_collaboration|until_revoked|search',
            '98d00009-0000-4000-8000-000000000001|DEMO-OUTREACH|write_records|direct-care|active|true|365 days|true|clinical_collaboration|until_revoked|search',
            '98d00009-0000-4000-8000-000000000002|DEMO-HOSPITAL|write_records|direct-care|active|true|365 days|true|clinical_collaboration|until_revoked|search',
            '98d00009-0000-4000-8000-000000000002|DEMO-OUTREACH|write_records|direct-care|active|true|365 days|true|clinical_collaboration|until_revoked|search']
    and (select count(*) from identity.consent_grants grant_row where identity.sealed_demo_patient(grant_row.patient_id)) = 4
    and (select count(*) from audit.events event where event.action = 'identity.consent-grant.patient-share'
          and event.correlation_id = '0098-sealed-demo-install') = 4
    and current_setting('app.correlation_id', true) = 'sealed-suite-before-install');
  perform pg_temp.assert('one audit row, counts only',
    (select count(*) from audit.events where action = 'identity.sealed-demo.install') = 1
    and (select event.details::text !~ '(@|HID-|operations)' and event.actor_type = 'system'
           and event.provenance = 'migration' and event.correlation_id = '0098-sealed-demo-install'
           from audit.events event where event.action = 'identity.sealed-demo.install'));
end $$;

-- 6a. Recovery as the owner will do it: forgot-password to each mailbox, the
-- code verified (the challenge written here as Identity's verify step leaves
-- it), then auth.complete_recovery_otp with the repository's non-hash
-- placeholder. Each account becomes active with an Argon2id-form hash, its
-- patient CONTACT_VERIFIED; then a live session for each patient login.
insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac, verifier_key_version,
  expires_at, max_attempts, verified_at, completion_token_hmac, completion_expires_at, account_token_version)
select ('98a0000f-0000-4000-8000-00000000000' || n)::uuid, account.id, md5('sealed-recipient-' || n) || md5('r' || n),
  'PASSWORD_RESET', 'email', md5('sealed-verifier-' || n) || md5('v' || n), 'sealed-test-v1',
  clock_timestamp() + interval '10 minutes', 5, clock_timestamp(), md5('sealed-completion-' || n) || md5('c' || n),
  clock_timestamp() + interval '10 minutes', account.token_version
  from (values (1, '98d00003-0000-4000-8000-000000000001'::uuid), (2, '98d00008-0000-4000-8000-000000000001'::uuid),
               (3, '98d00008-0000-4000-8000-000000000002'::uuid)) target(n, account_id)
  join auth.accounts account on account.id = target.account_id;
set local role hid_identity_api_runtime;
select pg_temp.as_system();
select pg_temp.assert('recovery completes for the three accounts',
  (select bool_and(auth.complete_recovery_otp(('98a0000f-0000-4000-8000-00000000000' || n)::uuid, 'PASSWORD_RESET',
     md5('sealed-completion-' || n) || md5('c' || n),
     '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43)))
     from generate_series(1, 3) n));
reset role;
select pg_temp.assert('after recovery: active, Argon2id, token version 2, patients contact verified',
  (select bool_and(account.status = 'active' and account.password_algorithm = 'argon2id' and account.token_version = 2)
     from auth.accounts account where identity.sealed_demo_account(account.id))
  and (select count(*) from identity.patient_assurance_states assurance
        where identity.sealed_demo_patient(assurance.patient_id) and assurance.state = 'CONTACT_VERIFIED') = 2);
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('98a0000b-0000-4000-8000-00000000001' || n)::uuid, ('98d00008-0000-4000-8000-00000000000' || n)::uuid,
  ('98a0000b-0000-4000-8000-00000000001' || n)::uuid, md5('sealed-demo-' || n) || md5('sealed-demo-' || n),
  gen_random_uuid(), 2, 'password', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours', 'patient', ('98d00009-0000-4000-8000-00000000000' || n)::uuid
  from generate_series(1, 2) n;
create function pg_temp.as_demo_patient(n integer)
returns void language sql as $f$
  select pg_temp.as_patient('patient:98d00008-0000-4000-8000-00000000000' || n,
    ('98d00008-0000-4000-8000-00000000000' || n)::uuid, ('98a0000b-0000-4000-8000-00000000001' || n)::uuid,
    ('98d00009-0000-4000-8000-00000000000' || n)::uuid);
$f$;
create function pg_temp.as_demo_staff(site integer, purpose text default 'direct-care')
returns void language sql as $f$
  select pg_temp.as_staff('sealed-demo:98d00003-0000-4000-8000-000000000001',
    ('98d00005-0000-4000-8000-00000000000' || site)::uuid, ('98d00002-0000-4000-8000-00000000000' || site)::uuid, purpose);
$f$;
create function pg_temp.as_real_doctor(purpose text default 'direct-care')
returns void language sql as $f$
  select pg_temp.as_staff('synthetic:sealed:doctor', '98a00005-0000-4000-8000-000000000001',
    '98a00002-0000-4000-8000-000000000001', purpose);
$f$;
create function pg_temp.as_real_patient()
returns void language sql as $f$
  select pg_temp.as_patient('synthetic:sealed:patient', '98a00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000001', '98a00009-0000-4000-8000-000000000001');
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;

-- 4. Demo to real.
set local role hid_identity_api_runtime;
select pg_temp.as_demo_staff(1);
do $$
begin
  perform pg_temp.assert('the demo doctor''s Health ID lookup: a real patient is not found, a demo patient is',
    (select count(*) from identity.patients where upper(hid_code) = 'HID-SRLPAT' and status = 'active') = 0
    and (select count(*) from identity.patients where upper(hid_code) = 'HID-ZDEMBBB2' and status = 'active') = 1
    and (select count(*) from identity.patients where id = '98a00009-0000-4000-8000-000000000001') = 0
    and (select count(*) from identity.patients) = 10);
  perform pg_temp.assert('an access request to a real patient answers as an unknown Health ID',
    pg_temp.try($q$select * from identity.create_access_request('HID-SRLPAT', 'read_records', 'Review before the clinic visit', 60)$q$)
      = 'P0002 Patient is not available');
  perform pg_temp.assert('a PIN with the right real PIN answers as a wrong one, counting the actor only',
    (select not verified and access_request_id is null and consent_grant_id is null
       from identity.access_patient_with_pin('HID-SRLPAT', '2468', 30)));
end $$;
select pg_temp.as_demo_staff(1, 'emergency');
select pg_temp.assert('break-glass on a real patient answers as an unknown Health ID',
  pg_temp.try($q$select * from identity.activate_break_glass('HID-SRLPAT', 'Unconscious on arrival at the ward', 30)$q$)
    = 'P0002 Patient is not available');
select pg_temp.as_demo_staff(4, 'emergency');
select pg_temp.assert('break-glass from Demo Outreach on a real patient: the same',
  pg_temp.try($q$select * from identity.activate_break_glass('HID-SRLPAT', 'Collapsed at the outreach site', 30)$q$)
    = 'P0002 Patient is not available');
select pg_temp.as_demo_staff(1);
select pg_temp.assert('the order directory from Demo Hospital: Demo Laboratory only',
  (select array_agg(facility_name order by facility_name) from identity.search_order_destinations('lab_request', 'Lab'))
    = array['Demo Laboratory']
  and (select array_agg(facility_name order by facility_name) from identity.search_order_destinations('prescription', 'Pharm'))
    = array['Demo Pharmacy']
  and not exists (select 1 from identity.search_order_destinations('lab_request', 'Sealed')));
select pg_temp.as_demo_staff(1, 'healthcare-operations');
select pg_temp.assert('a demo facility sends no staff invitation',
  pg_temp.try($q$select * from identity.create_staff_invitation(gen_random_uuid(), gen_random_uuid(), 'Someone Real',
    'someone@example.invalid', 'doctor', null, null, 'facility-staff-attestation-v1', 'sealed-invite-key-0001',
    repeat('a', 64), repeat('b', 64), repeat('c', 64), 'sealed-test-v1')$q$) = '42501 STAFF_MANAGEMENT_NOT_AVAILABLE');
select pg_temp.assert('the demo administrator''s CAC check consumes no QoreID quota',
  pg_temp.try($q$select platform.consume_qoreid_quota('existing_cac', '98d00001-0000-4000-8000-000000000001', null, null, null)$q$)
    = '42501 QOREID_QUOTA_PERMISSION_DENIED');
select pg_temp.as_demo_patient(1);
select pg_temp.assert('a demo patient''s NIN check consumes no QoreID quota',
  pg_temp.try($q$select platform.consume_qoreid_quota('patient_nin', null, '98a0000b-0000-4000-8000-000000000011', null, null)$q$)
    = '42501 QOREID_QUOTA_PERMISSION_DENIED');
select pg_temp.assert('a demo patient invites one of the three demo mailboxes only (no plus-address, no other)',
  pg_temp.try($q$select * from identity.create_my_share_invitation('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', 'someone@example.invalid', null, 'view_only', '24h',
    'sealed-share-invite-0001', repeat('a', 64))$q$) = '22023 SHARE_INVITATION_EMAIL_INVALID'
  and pg_temp.try($q$select * from identity.create_my_share_invitation('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', 'operations+clinic@healthidentitydirectory.com', null, 'view_only', '24h',
    'sealed-share-invite-0004', repeat('d', 64))$q$) = '22023 SHARE_INVITATION_EMAIL_INVALID'
  and pg_temp.try($q$select * from identity.create_my_share_invitation('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', 'patient3@healthidentitydirectory.com', null, 'view_only', '24h',
    'sealed-share-invite-0005', repeat('e', 64))$q$) = '22023 SHARE_INVITATION_EMAIL_INVALID');
-- Patient One invites the staff login's address and Patient Two's: both are
-- demo mailboxes, so both are sent; only the staff login accepts (at Demo
-- Hospital), because acceptance needs the accepting staff login's own
-- verified address.
select set_config('hid.test.demo_invitation', (select invitation_id::text
  from identity.create_my_share_invitation('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', 'Operations@HealthIdentityDirectory.com', 'Demo clinic', 'view_only',
    '24h', 'sealed-share-invite-0002', repeat('b', 64))), true);
select set_config('hid.test.demo_invitation_patient2', (select invitation_id::text
  from identity.create_my_share_invitation('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', 'Patient2@HealthIdentityDirectory.com', 'Patient Two', 'view_only',
    '24h', 'sealed-share-invite-0003', repeat('c', 64))), true);
select pg_temp.as_demo_staff(1);
select pg_temp.assert('the demo login accepts the invitation to its own address at Demo Hospital, never one to patient2@',
  (select status = 'accepted' and not replayed
     from identity.accept_share_invitation(current_setting('hid.test.demo_invitation')::uuid))
  and pg_temp.try(format('select * from identity.accept_share_invitation(%L)',
        current_setting('hid.test.demo_invitation_patient2'))) = 'P0002 SHARE_INVITATION_NOT_FOUND');
select pg_temp.as_demo_patient(1);
select pg_temp.assert('a demo patient never holds a phone',
  pg_temp.try($q$select * from identity.change_my_phone('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', gen_random_uuid(), repeat('d', 64), array[]::char(64)[],
    decode(repeat('ab', 40), 'hex'), 'sealed-test-v1', false)$q$) = '22023 PATIENT_CONTACT_CHANGE_INVALID');
-- A demo patient's email change: any address outside the allowlist (a plus-
-- address too) is refused by the seal with nothing recorded; an allowlisted
-- one passes the seal and meets the live rules: Patient Two's address is
-- another account's (recorded as denied, as for anyone), its own is
-- unchanged. So a demo patient keeps its address and no code is ever sent.
select pg_temp.assert('a demo patient''s email changes to a demo mailbox only',
  pg_temp.value_of($q$select identity.start_my_email_change('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', gen_random_uuid(), 'Someone@Example.invalid', repeat('e', 64),
    decode(repeat('cd', 40), 'hex'), 'sealed-test-v1', repeat('f', 64), 'sealed-test-v1', 600, 5, 60)$q$) = 'unavailable'
  and pg_temp.value_of($q$select identity.start_my_email_change('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', gen_random_uuid(), 'operations+patient1b@healthidentitydirectory.com',
    repeat('9', 64), decode(repeat('ef', 40), 'hex'), 'sealed-test-v1', repeat('8', 64), 'sealed-test-v1', 600, 5, 60)$q$)
    = 'unavailable');
reset role;
select pg_temp.assert('the seal recorded nothing for those two',
  not exists (select 1 from identity.patient_contact_changes change_row
               where change_row.patient_id = '98d00009-0000-4000-8000-000000000001'));
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(1);
select pg_temp.assert('an allowlisted address passes the seal and meets the live rules',
  pg_temp.value_of($q$select identity.start_my_email_change('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', gen_random_uuid(), 'Patient2@HealthIdentityDirectory.com',
    repeat('7', 64), decode(repeat('ef', 40), 'hex'), 'sealed-test-v1', repeat('6', 64), 'sealed-test-v1', 600, 5, 60)$q$)
    = 'unavailable'
  and pg_temp.value_of($q$select identity.start_my_email_change('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', gen_random_uuid(), 'patient1@healthidentitydirectory.com',
    repeat('5', 64), decode(repeat('ef', 40), 'hex'), 'sealed-test-v1', repeat('4', 64), 'sealed-test-v1', 600, 5, 60)$q$)
    = 'unchanged');
reset role;
select pg_temp.assert('only the live rule''s denied change is recorded, without an address',
  (select array_agg(change_row.state || '|' || change_row.invalidation_reason || '|' || (change_row.new_ciphertext is null))
     from identity.patient_contact_changes change_row
    where change_row.patient_id = '98d00009-0000-4000-8000-000000000001')
  = array['invalidated|contact_unavailable|true']);
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(1);
-- The emergency-contact check (each probe in a savepoint, undone, so that no
-- recorded HMAC outlives it) and the database's own rule, G7: a demo
-- patient's contact is an email whose HMAC the check recorded in the same
-- transaction; anything else, and any add that skipped the check (an Identity
-- before 0098, another caller), is refused; removal never is.
reset role;
create function pg_temp.add_contact(subject text, session uuid, contact uuid, channel text, hmac text)
returns text language sql as $f$
  select pg_temp.try(format('select identity.add_my_emergency_contact(%L, %L, %L, ''parent'', %L, '
    || 'decode(repeat(''ab'', 40), ''hex''), ''sealed-test-v1'', %L, true)', subject, session, contact, channel, hmac));
$f$;
grant execute on function pg_temp.add_contact(text,uuid,uuid,text,text) to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(1);
savepoint contact_probe;
select set_config('hid.sealed_demo_contact_hmac', '', true);
select pg_temp.assert('the emergency-contact check',
  identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001', '98a0000b-0000-4000-8000-000000000011',
    'email', 'operations@healthidentitydirectory.com', repeat('a', 64))
  and current_setting('hid.sealed_demo_contact_hmac') = repeat('a', 64)
  and not identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', 'email', 'mum@example.invalid', repeat('b', 64))
  and not identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', 'email', 'operations+mum@healthidentitydirectory.com', repeat('b', 64))
  and not identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', 'sms', '+2348012345678', repeat('c', 64))
  and not identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', null, 'operations@healthidentitydirectory.com', repeat('d', 64))
  and current_setting('hid.sealed_demo_contact_hmac') = repeat('a', 64)
  and pg_temp.try($q$select identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000012', 'email', 'operations@healthidentitydirectory.com', repeat('e', 64))$q$)
    = '42501 Patient self session is required');
rollback to savepoint contact_probe;
savepoint contact_probe;
select set_config('hid.sealed_demo_contact_hmac', '', true);
select pg_temp.assert('G7: a demo patient''s contact added without the check is refused, an email or an SMS',
  pg_temp.add_contact('patient:98d00008-0000-4000-8000-000000000001', '98a0000b-0000-4000-8000-000000000011',
    '98a00010-0000-4000-8000-000000000001', 'email', repeat('7', 64)) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED'
  and pg_temp.add_contact('patient:98d00008-0000-4000-8000-000000000001', '98a0000b-0000-4000-8000-000000000011',
    '98a00010-0000-4000-8000-000000000001', 'sms', repeat('7', 64)) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED');
select pg_temp.assert('G7: an SMS contact is refused even with the HMAC the check recorded for a mailbox',
  identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001', '98a0000b-0000-4000-8000-000000000011',
    'email', 'Patient2@HealthIdentityDirectory.com', repeat('6', 64))
  and pg_temp.add_contact('patient:98d00008-0000-4000-8000-000000000001', '98a0000b-0000-4000-8000-000000000011',
    '98a00010-0000-4000-8000-000000000001', 'sms', repeat('6', 64)) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED');
select pg_temp.assert('G7: the demo mailbox the check recorded is added, any other HMAC is not',
  pg_temp.add_contact('patient:98d00008-0000-4000-8000-000000000001', '98a0000b-0000-4000-8000-000000000011',
    '98a00010-0000-4000-8000-000000000001', 'email', repeat('6', 64)) = 'ok'
  and pg_temp.add_contact('patient:98d00008-0000-4000-8000-000000000001', '98a0000b-0000-4000-8000-000000000011',
    '98a00010-0000-4000-8000-000000000002', 'email', repeat('5', 64)) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED'
  and pg_temp.try($q$select identity.update_my_emergency_contact('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', '98a00010-0000-4000-8000-000000000001', 1, 'sibling',
    decode(repeat('cd', 40), 'hex'), 'sealed-test-v1', repeat('6', 64), false)$q$) = 'ok');
reset role;
select pg_temp.assert('G7: an update of the stored channel or destination is refused (owner SQL)',
  pg_temp.try($q$update identity.patient_emergency_contacts set channel = 'sms'
    where id = '98a00010-0000-4000-8000-000000000001'$q$) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED'
  and pg_temp.try($q$update identity.patient_emergency_contacts set destination_hmac = repeat('4', 64)
    where id = '98a00010-0000-4000-8000-000000000001'$q$) = '42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED');
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(1);
select set_config('hid.sealed_demo_contact_hmac', '', true);
select pg_temp.assert('G7 never refuses removal',
  pg_temp.try($q$select * from identity.deactivate_my_emergency_contact('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', '98a00010-0000-4000-8000-000000000001')$q$) = 'ok');
reset role;
select pg_temp.assert('G7: the one contact added is the checked mailbox, now removed',
  (select array_agg(contact.channel || '|' || contact.status || '|' || (contact.destination_hmac is null))
     from identity.patient_emergency_contacts contact where identity.sealed_demo_patient(contact.patient_id))
  = array['email|deactivated|true']);
rollback to savepoint contact_probe;
set local role hid_identity_api_runtime;
select pg_temp.as_real_patient();
savepoint contact_probe;
select set_config('hid.sealed_demo_contact_hmac', '', true);
select pg_temp.assert('the emergency-contact check and G7 leave real patients alone',
  identity.sealed_demo_contact_allowed('synthetic:sealed:patient', '98a0000b-0000-4000-8000-000000000001',
    'sms', '+2348012345678', repeat('3', 64))
  and identity.sealed_demo_contact_allowed('synthetic:sealed:patient', '98a0000b-0000-4000-8000-000000000001',
    'email', 'mum@example.invalid', repeat('2', 64))
  and current_setting('hid.sealed_demo_contact_hmac') = ''
  and pg_temp.add_contact('synthetic:sealed:patient', '98a0000b-0000-4000-8000-000000000001',
    '98a00010-0000-4000-8000-000000000011', 'sms', repeat('1', 64)) = 'ok'
  and pg_temp.add_contact('synthetic:sealed:patient', '98a0000b-0000-4000-8000-000000000001',
    '98a00010-0000-4000-8000-000000000012', 'email', repeat('0', 64)) = 'ok');
rollback to savepoint contact_probe;
-- A real patient invites the staff login's address (the owner's mailbox gets
-- the email); the demo login can never accept it.
select set_config('hid.test.real_invitation', (select invitation_id::text
  from identity.create_my_share_invitation('synthetic:sealed:patient', '98a0000b-0000-4000-8000-000000000001',
    'operations@healthidentitydirectory.com', 'Ops', 'view_only', '24h', 'sealed-real-invite-0001', repeat('c', 64))), true);
select pg_temp.as_demo_staff(1);
select pg_temp.assert('the demo login cannot accept a real patient''s invitation',
  pg_temp.try(format('select * from identity.accept_share_invitation(%L)', current_setting('hid.test.real_invitation')))
    = '42501 SEALED_DEMO_BOUNDARY');
reset role;
do $$
begin
  perform pg_temp.assert('nothing reached the real patient from the demo side',
    not exists (select 1 from identity.access_requests request
                 where request.patient_id = '98a00009-0000-4000-8000-000000000001'
                   and identity.sealed_demo_facility(request.facility_id))
    and not exists (select 1 from identity.consent_grants grant_row
                     where grant_row.patient_id = '98a00009-0000-4000-8000-000000000001'
                       and identity.sealed_demo_facility(grant_row.facility_id))
    and not exists (select 1 from identity.outbox_events event
                     where event.patient_id = '98a00009-0000-4000-8000-000000000001')
    and not exists (select 1 from notification.inbox_items item
                     where item.account_id = '98a00008-0000-4000-8000-000000000001')
    and not exists (select 1 from identity.patient_access_pin_target_limits target_limit
                     where target_limit.patient_id = '98a00009-0000-4000-8000-000000000001'
                       and target_limit.actor_account_id = '98d00003-0000-4000-8000-000000000001')
    and (select limit_row.failure_count from identity.patient_access_pin_actor_limits limit_row
          where limit_row.actor_account_id = '98d00003-0000-4000-8000-000000000001'
            and limit_row.facility_id = '98d00002-0000-4000-8000-000000000001') = 1
    and (select invitation.status from identity.patient_share_invitations invitation
          where invitation.id = current_setting('hid.test.real_invitation')::uuid) = 'pending');
  perform pg_temp.assert('no QoreID counter for a demo account',
    not exists (select 1 from platform.qoreid_quota_counters counter
                 where counter.scope_type = 'account' and identity.sealed_demo_account(counter.scope_id)));
  perform pg_temp.assert('no phone and no foreign address recorded for a demo patient',
    not exists (select 1 from identity.patient_contact_changes change_row
                 where identity.sealed_demo_patient(change_row.patient_id)
                   and (change_row.channel = 'phone' or change_row.state = 'pending'
                        or change_row.new_ciphertext is not null))
    and (select count(*) from identity.patient_contact_changes change_row
          where change_row.patient_id = '98d00009-0000-4000-8000-000000000001') = 1
    and (select patient.phone_e164_ciphertext is null from identity.patients patient
          where patient.id = '98d00009-0000-4000-8000-000000000001'));
  perform pg_temp.assert('a direct grant across the boundary is refused (owner SQL)',
    pg_temp.try($q$insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, status, reason, starts_at, expires_at, break_glass, purpose_of_use)
      values (gen_random_uuid(), '98a00009-0000-4000-8000-000000000001', '98d00004-0000-4000-8000-000000000001',
        '98d00003-0000-4000-8000-000000000001', '98d00005-0000-4000-8000-000000000001',
        '98d00002-0000-4000-8000-000000000001', 'read_records', 'active', 'Owner SQL across the boundary',
        clock_timestamp(), clock_timestamp() + interval '1 day', false, 'direct-care')$q$) = '42501 SEALED_DEMO_BOUNDARY'
    and pg_temp.try($q$insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, status, reason, starts_at, expires_at, break_glass, purpose_of_use)
      values (gen_random_uuid(), '98d00009-0000-4000-8000-000000000003', '98a00004-0000-4000-8000-000000000001',
        '98a00003-0000-4000-8000-000000000001', '98a00005-0000-4000-8000-000000000001',
        '98a00002-0000-4000-8000-000000000001', 'read_records', 'active', 'Owner SQL across the boundary',
        clock_timestamp(), clock_timestamp() + interval '1 day', false, 'direct-care')$q$) = '42501 SEALED_DEMO_BOUNDARY');
  perform pg_temp.assert('the demo login never joins a real facility, and a real account never a demo one (owner SQL)',
    pg_temp.try($q$insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active) values (gen_random_uuid(), '98d00004-0000-4000-8000-000000000001',
      '98d00003-0000-4000-8000-000000000001', '98a00001-0000-4000-8000-000000000001',
      '98a00002-0000-4000-8000-000000000001', 'doctor', 'doctor', false, true)$q$) = '42501 SEALED_DEMO_MEMBERSHIP_REFUSED'
    and pg_temp.try($q$insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active) values (gen_random_uuid(), '98a00004-0000-4000-8000-000000000001',
      '98a00003-0000-4000-8000-000000000001', '98d00001-0000-4000-8000-000000000001',
      '98d00002-0000-4000-8000-000000000001', 'doctor', 'doctor', false, true)$q$) = '42501 SEALED_DEMO_MEMBERSHIP_REFUSED'
    and pg_temp.try($q$update identity.staff_facility_memberships set facility_id = '98a00002-0000-4000-8000-000000000001',
      organization_id = '98a00001-0000-4000-8000-000000000001'
      where id = '98d00005-0000-4000-8000-000000000004'$q$) = '42501 SEALED_DEMO_MEMBERSHIP_REFUSED');
  perform pg_temp.assert('a demo account holds no platform role (owner SQL)',
    pg_temp.try($q$insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
      values (gen_random_uuid(), '98d00003-0000-4000-8000-000000000001', 'platform_admin', 'platform',
        'Owner SQL platform role')$q$) = '42501 SEALED_DEMO_PLATFORM_ROLE_REFUSED'
    and pg_temp.try($q$insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
      values (gen_random_uuid(), '98d00008-0000-4000-8000-000000000002', 'support_admin', 'platform',
        'Owner SQL platform role')$q$) = '42501 SEALED_DEMO_PLATFORM_ROLE_REFUSED');
end $$;

-- 5. Real to demo.
set local role hid_identity_api_runtime;
select pg_temp.as_real_doctor();
do $$
begin
  perform pg_temp.assert('a real doctor''s Health ID lookup never finds a demo patient',
    (select count(*) from identity.patients where upper(hid_code) like 'HID-ZDEM%') = 0
    and (select count(*) from identity.patients where id = '98d00009-0000-4000-8000-000000000001') = 0);
  perform pg_temp.assert('an access request to a demo patient answers as an unknown Health ID',
    pg_temp.try($q$select * from identity.create_access_request('HID-ZDEMAAA2', 'read_records', 'Review before the clinic visit', 60)$q$)
      = 'P0002 Patient is not available');
  perform pg_temp.assert('a PIN on a demo patient answers as unknown',
    (select not verified from identity.access_patient_with_pin('HID-ZDEMAAA2', '2468', 30)));
  perform pg_temp.assert('the real order directory lists no demo facility',
    not exists (select 1 from identity.search_order_destinations('lab_request', 'Demo'))
    and not exists (select 1 from identity.search_order_destinations('prescription', 'Demo'))
    and (select array_agg(facility_name) from identity.search_order_destinations('lab_request', 'Lab'))
      = array['Sealed Real Laboratory']);
end $$;
select pg_temp.as_real_doctor('emergency');
select pg_temp.assert('break-glass on a demo patient answers as an unknown Health ID',
  pg_temp.try($q$select * from identity.activate_break_glass('HID-ZDEMBBB2', 'Unconscious on arrival at the ward', 30)$q$)
    = 'P0002 Patient is not available');
select pg_temp.as_real_patient();
select pg_temp.assert('a real patient''s share directory never shows the demo clinician',
  not exists (select 1 from identity.search_share_providers('synthetic:sealed:patient',
    '98a0000b-0000-4000-8000-000000000001', 'Demo')));
select pg_temp.assert('a real patient''s share to a demo membership is refused',
  pg_temp.try($q$select * from identity.create_my_consent_share('synthetic:sealed:patient',
    '98a0000b-0000-4000-8000-000000000001', '98d00005-0000-4000-8000-000000000001', 'view_only', '24h',
    'sealed-real-share-0001', repeat('d', 64))$q$) = '42501 SEALED_DEMO_BOUNDARY');
select pg_temp.as_demo_patient(1);
select pg_temp.assert('a demo patient''s share directory shows demo clinicians only',
  (select array_agg(clinician_name || '@' || facility_name order by facility_name)
     from identity.search_share_providers('patient:98d00008-0000-4000-8000-000000000001',
       '98a0000b-0000-4000-8000-000000000011', 'Demo'))
    = array['Demo Operations@Demo Hospital', 'Demo Operations@Demo Outreach']
  and not exists (select 1 from identity.search_share_providers('patient:98d00008-0000-4000-8000-000000000001',
    '98a0000b-0000-4000-8000-000000000011', 'Rita')));
set local role hid_ehr_api_runtime;
select pg_temp.as_real_doctor();
select pg_temp.assert('a real order to Demo Laboratory is ineligible',
  pg_temp.try($q$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request', '98a00009-0000-4000-8000-000000000001',
    '98a0000e-0000-4000-8000-000000000001', '98a0000d-0000-4000-8000-000000000001', 1, '98d00002-0000-4000-8000-000000000002',
    'order-route-lab-attestation-v1', 'sealed-cross-send-0001', encode(sha256('sealed-cross-send-0001'::bytea), 'hex'))$q$)
    = 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
reset role;
select pg_temp.assert('nothing reached a demo patient from the real side',
  not exists (select 1 from identity.patient_access_pin_target_limits target_limit
               where identity.sealed_demo_patient(target_limit.patient_id))
  and not exists (select 1 from identity.access_requests request
                   where identity.sealed_demo_patient(request.patient_id)
                     and not identity.sealed_demo_facility(request.facility_id))
  and not exists (select 1 from identity.consent_grants grant_row
                   where identity.sealed_demo_patient(grant_row.patient_id)
                     and not identity.sealed_demo_facility(grant_row.facility_id))
  and (select count(*) from identity.consent_grants grant_row
        where identity.sealed_demo_patient(grant_row.patient_id)) = 4
  and not exists (select 1 from ehr.order_routes route where route.idempotency_key = 'sealed-cross-send-0001'));

-- 6. Within the demo tenant.
-- 6b. Writing from the first day, through the seeded shares (D6), with no
-- approval: the demo login writes in Patient One's and Two's charts at Demo
-- Hospital (doctor) and Demo Outreach (nurse). (The suite is one transaction,
-- whose CURRENT_TIMESTAMP, which the read gate compares grants with,
-- precedes the install: the shares are moved an hour back, as if made
-- earlier.)
update identity.consent_grants set starts_at = starts_at - interval '1 hour'
 where correlation_id = '0098-sealed-demo-install';
set local role hid_ehr_api_runtime;
select pg_temp.as_demo_staff(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('98a0000d-0000-4000-8000-000000000021', '98d00009-0000-4000-8000-000000000002',
  '98d00002-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001',
  '98d00005-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.assert('the shares let the demo doctor write for Patient One and Two at Demo Hospital, nobody else',
  ehr.context_allows('98d00009-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001', 'write_records')
  and ehr.context_allows('98d00009-0000-4000-8000-000000000002', '98d00002-0000-4000-8000-000000000001', 'write_records')
  and not ehr.context_allows('98d00009-0000-4000-8000-000000000003', '98d00002-0000-4000-8000-000000000001',
    'read_records')
  and exists (select 1 from ehr.encounters where id = '98a0000d-0000-4000-8000-000000000021'));
select pg_temp.as_demo_staff(4);
select pg_temp.assert('and the demo nurse at Demo Outreach',
  ehr.context_allows('98d00009-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000004', 'write_records')
  and ehr.context_allows('98d00009-0000-4000-8000-000000000002', '98d00002-0000-4000-8000-000000000004', 'write_records'));
reset role;
-- A share revoked by the patient stays revoked: a second install writes no
-- new one.
select set_config('hid.test.outreach_share', (select grant_row.id::text from identity.consent_grants grant_row
  where grant_row.patient_id = '98d00009-0000-4000-8000-000000000002'
    and grant_row.membership_id = '98d00005-0000-4000-8000-000000000004'
    and grant_row.correlation_id = '0098-sealed-demo-install'), true);
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(2);
select pg_temp.assert('Patient Two revokes the Demo Outreach share in the portal',
  (select grant_status = 'revoked'
     from identity.revoke_my_consent_grant('patient:98d00008-0000-4000-8000-000000000002',
       '98a0000b-0000-4000-8000-000000000012', current_setting('hid.test.outreach_share')::uuid,
       'Testing the revocation')));
reset role;
select pg_temp.assert('a second install neither restores nor adds a share',
  (identity.sealed_demo_install()->>'inserted')::integer = 0
  and (select count(*) from identity.consent_grants grant_row
        where grant_row.correlation_id = '0098-sealed-demo-install') = 4
  and (select count(*) from identity.consent_grants grant_row
        where grant_row.correlation_id = '0098-sealed-demo-install' and grant_row.status = 'active') = 3);
set local role hid_ehr_api_runtime;
select pg_temp.as_demo_staff(4);
select pg_temp.assert('the revoked share no longer lets the nurse in',
  not ehr.context_allows('98d00009-0000-4000-8000-000000000002', '98d00002-0000-4000-8000-000000000004', 'read_records'));
reset role;
-- 6c. A request approved by Patient One, and break-glass.
set local role hid_identity_api_runtime;
select pg_temp.as_demo_staff(1);
select set_config('hid.test.demo_request', (select access_request_id::text
  from identity.create_access_request('HID-ZDEMAAA2', 'write_records', 'Demo consultation and orders', 240)), true);
reset role;
select pg_temp.assert('the request reaches Patient One''s inbox',
  exists (select 1 from notification.inbox_items item where item.account_id = '98d00008-0000-4000-8000-000000000001'));
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(1);
select pg_temp.assert('Patient One approves it',
  (select status = 'approved' and consent_grant_id is not null
     from identity.approve_access_request(current_setting('hid.test.demo_request')::uuid)));
select pg_temp.as_demo_staff(1, 'emergency');
select set_config('hid.test.demo_break_glass', (select consent_grant_id::text
  from identity.activate_break_glass('HID-ZDEMBBB2', 'Demo emergency: unconscious on arrival', 60)), true);
reset role;
select pg_temp.assert('break-glass on a fictional patient: an active grant and the emergency event, no contact to tell',
  exists (select 1 from identity.consent_grants grant_row
           where grant_row.id = current_setting('hid.test.demo_break_glass')::uuid and grant_row.status = 'active'
             and grant_row.break_glass and grant_row.patient_id = '98d00009-0000-4000-8000-000000000003')
  and exists (select 1 from identity.outbox_events event where event.event_type = 'EmergencyAccessActivated'
               and event.patient_id = '98d00009-0000-4000-8000-000000000003')
  and not exists (select 1 from identity.patient_emergency_contacts contact
                   where identity.sealed_demo_patient(contact.patient_id)));
-- Break-glass opens a read-only emergency summary: read for the emergency
-- purpose only, never a write (the grant moved an hour back as above).
update identity.consent_grants set starts_at = starts_at - interval '1 hour'
 where id = current_setting('hid.test.demo_break_glass')::uuid;
set local role hid_ehr_api_runtime;
select pg_temp.as_demo_staff(1, 'emergency');
select pg_temp.assert('break-glass reads a fictional patient for the emergency purpose and writes nothing',
  ehr.context_allows('98d00009-0000-4000-8000-000000000003', '98d00002-0000-4000-8000-000000000001', 'read_records')
  and not ehr.context_allows('98d00009-0000-4000-8000-000000000003', '98d00002-0000-4000-8000-000000000001',
    'write_records')
  and pg_temp.try($q$insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id,
    encounter_type, status, started_at) values ('98a0000d-0000-4000-8000-000000000031',
    '98d00009-0000-4000-8000-000000000003', '98d00002-0000-4000-8000-000000000001',
    '98d00003-0000-4000-8000-000000000001', '98d00005-0000-4000-8000-000000000001', 'ambulatory', 'in_progress',
    clock_timestamp())$q$) like '42501 new row violates row-level security policy%');
select pg_temp.as_demo_staff(1);
select pg_temp.assert('and not for direct care',
  not ehr.context_allows('98d00009-0000-4000-8000-000000000003', '98d00002-0000-4000-8000-000000000001',
    'read_records'));
reset role;
select pg_temp.assert('Demo Laboratory and Demo Pharmacy receive orders',
  identity.order_route_destination_eligible('98d00002-0000-4000-8000-000000000002', 'lab_request')
  and identity.order_route_destination_eligible('98d00002-0000-4000-8000-000000000003', 'prescription')
  and not identity.order_route_destination_eligible('98d00002-0000-4000-8000-000000000001', 'lab_request'));
-- (The suite is one transaction, whose CURRENT_TIMESTAMP, which the read
-- gate compares grants with, precedes the approval: the grant is moved an
-- hour back, as if approved earlier.)
update identity.consent_grants set starts_at = starts_at - interval '1 hour'
 where request_id = current_setting('hid.test.demo_request')::uuid;
set local role hid_ehr_api_runtime;
select pg_temp.as_demo_staff(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('98a0000d-0000-4000-8000-000000000011', '98d00009-0000-4000-8000-000000000001',
  '98d00002-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001',
  '98d00005-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
values ('98a0000e-0000-4000-8000-000000000011', '98a0000d-0000-4000-8000-000000000011',
  '98d00009-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001',
  '98d00003-0000-4000-8000-000000000001', '98d00005-0000-4000-8000-000000000001', 'http://loinc.org', '718-7',
  'Haemoglobin', 'routine', 'draft', 'whole-blood', 'Demo: tiredness');
select pg_temp.assert('a demo order to a real laboratory is ineligible, nothing written',
  pg_temp.try($q$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request', '98d00009-0000-4000-8000-000000000001',
    '98a0000e-0000-4000-8000-000000000011', '98a0000d-0000-4000-8000-000000000011', 1, '98a00002-0000-4000-8000-000000000002',
    'order-route-lab-attestation-v1', 'sealed-demo-send-0001', encode(sha256('sealed-demo-send-0001'::bytea), 'hex'))$q$)
    = 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select set_config('hid.test.demo_route', (select route_id::text from ehr.send_order_route(gen_random_uuid(), 'lab_request',
  '98d00009-0000-4000-8000-000000000001', '98a0000e-0000-4000-8000-000000000011', '98a0000d-0000-4000-8000-000000000011',
  1, '98d00002-0000-4000-8000-000000000002', 'order-route-lab-attestation-v1', 'sealed-demo-send-0002',
  encode(sha256('sealed-demo-send-0002'::bytea), 'hex'))), true);
set local role hid_lab_api_runtime;
select pg_temp.as_demo_staff(2);
select pg_temp.assert('the same login at Demo Laboratory accepts the order by the Health ID',
  (select result = 'accepted' and work_item_id is not null
     from lab.accept_order_route(current_setting('hid.test.demo_route')::uuid, 1, 'health_id', 'HID-ZDEMAAA2',
       'sealed-demo-accept-0001', repeat('e', 64))));
reset role;
do $$
begin
  perform pg_temp.assert('no route between the boundary',
    not exists (select 1 from ehr.order_routes route
                 where identity.sealed_demo_facility(route.ordering_facility_id)
                    <> identity.sealed_demo_facility(route.receiving_facility_id)));
  perform pg_temp.assert('every portal''s permissions for the staff login',
    (select bool_and(auth.membership_has_permission('sealed-demo:98d00003-0000-4000-8000-000000000001',
        ('98d00005-0000-4000-8000-00000000000' || wanted.site)::uuid,
        ('98d00002-0000-4000-8000-00000000000' || wanted.site)::uuid, wanted.permission))
       from (values (1, 'ehr.encounter.write'), (1, 'ehr.order-route.send'), (1, 'identity.break-glass.write'),
                    (1, 'identity.consent.write'), (1, 'identity.registration.write'), (1, 'ocr.job.write'),
                    (1, 'ocr.publication.write'), (1, 'lab.import.write'), (1, 'pharmacy.import.write'),
                    (1, 'audit.read'), (1, 'workforce.manage'), (2, 'lab.order-route.receive'),
                    (2, 'lab.result.enter'), (2, 'lab.result.release'), (3, 'pharmacy.order-route.receive'),
                    (3, 'pharmacy.dispensing.create'), (4, 'outreach.registration.write'), (4, 'outreach.campaign.write'),
                    (4, 'identity.break-glass.write'), (4, 'audit.read')) wanted(site, permission)));
  perform pg_temp.assert('the patient logins resolve',
    (select count(*) from identity.current_patient_account('patient:98d00008-0000-4000-8000-000000000001')) = 1
    and (select count(*) from identity.current_patient_account('patient:98d00008-0000-4000-8000-000000000002')) = 1);
  perform pg_temp.assert('the shares are ones the patients could make themselves (the share directory''s rule)',
    identity.share_provider_eligible('98d00005-0000-4000-8000-000000000001')
    and identity.share_provider_eligible('98d00005-0000-4000-8000-000000000004'));
end $$;

-- 6d. The admin console's markers, read as Identity reads them for a platform
-- administrator: the demo accounts (principals list, search, export), the
-- demo facilities (order routes, wrong-patient reports) and the demo
-- applications (organization applications list).
set local role hid_identity_api_runtime;
select pg_temp.as_staff('synthetic:sealed:admin', null, null, 'healthcare-operations');
select pg_temp.assert('the admin markers',
  (select array_agg(account.email order by account.email) from auth.accounts account
    where account.id = any((select identity.sealed_demo_ids('account'))::uuid[]))
    = array['operations@healthidentitydirectory.com', 'patient1@healthidentitydirectory.com',
            'patient2@healthidentitydirectory.com']
  and cardinality(identity.sealed_demo_ids('facility')) = 4
  and (select array_agg(identity.sealed_demo_application(application_id) order by application_id)
         from unnest(array['98a00007-0000-4000-8000-000000000001', '98a00007-0000-4000-8000-000000000002',
           '98d00007-0000-4000-8000-000000000002', '98d00007-0000-4000-8000-000000000003',
           '98d00007-0000-4000-8000-000000000009']::uuid[]) application_id)
    = array[false, false, true, true, false]);
reset role;

-- 6e. The off switch: a platform administrator disables the three demo
-- accounts, revokes their sessions and suspends the four demo facilities with
-- the live admin commands; nothing of 0098 stands in the way and the rows stay
-- sealed (undone here).
savepoint off_switch;
set local role hid_identity_api_runtime;
select pg_temp.as_staff('synthetic:sealed:admin', null, null, 'healthcare-operations');
select pg_temp.assert('the off switch: the three demo accounts disabled',
  (select array_agg(transition.account_status order by account.id)
     from auth.accounts account
     cross join lateral auth.admin_transition_account(account.id, account.row_version, 'disabled',
       'Demo switched off in the suite', 'sealed-demo-off-account-' || account.id::text, repeat('a', 64)) transition
    where account.id = any((select identity.sealed_demo_ids('account'))::uuid[]))
  = array['disabled', 'disabled', 'disabled']);
select pg_temp.assert('the off switch: their sessions revoked',
  (select count(*) from unnest((select identity.sealed_demo_ids('account'))) demo_account(id)
     cross join lateral auth.admin_revoke_account_sessions(demo_account.id, 'Demo switched off in the suite',
       'sealed-demo-off-sessions-' || demo_account.id::text, repeat('b', 64)) revoked) = 3);
select pg_temp.assert('the off switch: the four demo facilities suspended',
  (select array_agg(transition.lifecycle_status order by facility.id)
     from identity.facilities facility
     cross join lateral identity.admin_transition_facility(facility.id, facility.row_version, 'suspended',
       'Demo switched off in the suite', 'sealed-demo-off-facility-' || facility.id::text, repeat('c', 64)) transition
    where facility.id = any((select identity.sealed_demo_ids('facility'))::uuid[]))
  = array['suspended', 'suspended', 'suspended', 'suspended']);
reset role;
select pg_temp.assert('switched off: no live demo session, no demo membership works, and the rows are still sealed',
  not exists (select 1 from auth.sessions session
               where identity.sealed_demo_account(session.account_id) and session.revoked_at is null)
  and not exists (select 1 from identity.staff_facility_memberships membership
               where membership.account_id = '98d00003-0000-4000-8000-000000000001'
                 and identity.has_active_membership('sealed-demo:98d00003-0000-4000-8000-000000000001', membership.id,
                   membership.facility_id))
  and identity.sealed_demo_facility('98d00002-0000-4000-8000-000000000001')
  and (select count(*) from identity.sealed_demo_members) = 21);
rollback to savepoint off_switch;

-- 7. Real tenants unchanged: the probes again, after the install.
select pg_temp.real_probes('after');
do $$
declare differences text;
begin
  select string_agg(before.label || ': ' || coalesce(before.answer, 'null') || ' / ' || coalesce(after.answer, 'null'), '; ')
    into differences
    from sealed_probes before join sealed_probes after on after.label = before.label and after.phase = 'after'
   where before.phase = 'before' and before.answer is distinct from after.answer;
  perform pg_temp.assert('the real fixture''s answers before and after the install are the same',
    differences is null and (select count(*) from sealed_probes where phase = 'after') = 10, differences);
  perform pg_temp.assert('the real fixture''s answers are the working ones',
    (select array_agg(probe.label || '=' || coalesce(probe.answer, 'null') order by probe.label)
       from sealed_probes probe where probe.phase = 'after' and probe.label <> 'overview')
    = array['break-glass=active false', 'directory=Sealed Real Laboratory', 'lookup=HID-SRLPAT', 'lookup-all=1',
            'pin=true active', 'pin-wrong=false', 'request=pending false true',
            'send=sent Sealed Real Laboratory', 'share-directory=Rita Realdoctor@Sealed Real Hospital']);
end $$;

rollback;
