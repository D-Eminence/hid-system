\set ON_ERROR_STOP on
-- Records processing, Stage 1 (0104): the healthcare-operations purpose, the
-- access-request trigger (who may ask, the patient's age, scope and length)
-- and the purpose on the patient's request list. Requests, approvals,
-- revocations, PINs, shares and break-glass go through this branch's own
-- commands as the Identity API runtime; document reads go through the EHR API
-- runtime with the context the EHR API sets. Each case is recorded and the
-- suite fails at the end listing every case whose outcome differs from the
-- expected one.
-- Rollback-only. Synthetic values only; uuid prefix 100a.
set plpgsql.variable_conflict = error;
begin;

create temporary table records_processing_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on records_processing_cases to public;
grant usage on sequence records_processing_cases_seq_seq to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language sql as $$
  insert into records_processing_cases (name, expected, actual) values (case_name, expected, coalesce(actual, 'null'));
$$;
-- A statement's single text answer, or its SQLSTATE and message.
create function pg_temp.try(statement text) returns text language plpgsql as $$
declare
  answer text;
begin
  execute statement into answer;
  return coalesce(answer, 'ok');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.expect(text, text, text), pg_temp.try(text) to public;

-- 1. What 0104 installs.
select pg_temp.expect('1a the code', 'Records processing/t/hid',
  (select format('%s/%s/%s', display, active, source_system) from identity.purpose_of_use_codes
    where code = 'healthcare-operations'));
select pg_temp.expect('1b the trigger', 'O CREATE TRIGGER access_requests_records_processing BEFORE INSERT ON '
  || 'identity.access_requests FOR EACH ROW WHEN (((new.purpose_of_use = ''healthcare-operations''::text) AND '
  || '(NOT new.break_glass))) EXECUTE FUNCTION identity.access_requests_records_processing()',
  (select string_agg(tgenabled::text || ' ' || pg_get_triggerdef(oid), '; ') from pg_trigger
    where tgrelid = 'identity.access_requests'::regclass and tgname = 'access_requests_records_processing'));
select pg_temp.expect('1c the trigger function', 't/v/{"search_path=pg_catalog, pg_temp"}/t/owner only',
  (select format('%s/%s/%s/%s/%s', p.prosecdef, p.provolatile, p.proconfig,
            p.proowner = (select relowner from pg_class where oid = 'identity.access_requests'::regclass),
            coalesce((select string_agg(coalesce(nullif(acl.grantee::regrole::text, '-'), 'public') || ' ' || acl.privilege_type, ', ')
                        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                       where acl.grantee <> p.proowner), 'owner only'))
     from pg_proc p where p.oid = 'identity.access_requests_records_processing()'::regprocedure));
select pg_temp.expect('1d the request list', 't/{"search_path=pg_catalog, pg_temp"}/hid_identity_runtime EXECUTE',
  (select format('%s/%s/%s', p.prosecdef, p.proconfig,
            (select string_agg(coalesce(nullif(acl.grantee::regrole::text, '-'), 'public') || ' ' || acl.privilege_type, ', ')
               from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl where acl.grantee <> p.proowner))
     from pg_proc p where p.oid = 'identity.list_my_access_requests()'::regprocedure));
select pg_temp.expect('1e the list''s columns', 'access_request_id facility_id facility_name scope reason status '
  || 'requested_duration_minutes requested_at approved_at denied_at denied_reason purpose_of_use',
  (select array_to_string(p.proargnames[1:], ' ') from pg_proc p
    where p.oid = 'identity.list_my_access_requests()'::regprocedure));
select pg_temp.expect('1f who may list', 'identity=t ehr=f lab=f pharmacy=f ocr=f',
  format('identity=%s ehr=%s lab=%s pharmacy=%s ocr=%s',
    has_function_privilege('hid_identity_api_runtime', 'identity.list_my_access_requests()', 'EXECUTE'),
    has_function_privilege('hid_ehr_api_runtime', 'identity.list_my_access_requests()', 'EXECUTE'),
    has_function_privilege('hid_lab_api_runtime', 'identity.list_my_access_requests()', 'EXECUTE'),
    has_function_privilege('hid_pharmacy_api_runtime', 'identity.list_my_access_requests()', 'EXECUTE'),
    has_function_privilege('hid_ocr_api_runtime', 'identity.list_my_access_requests()', 'EXECUTE')));
-- The consent gate and the commands around the new trigger are unchanged
-- (the bodies 0091, 0094, 0095 and 0098 pin).
select pg_temp.expect('1g bodies not replaced', '8b12ce866ee75cce411a2721795ffb92 f88923a49a180c2180fdedb29bf2eccf '
  || 'af9482ccb8b9d9aa8486035478ac4e94 65e3eaff93fe729fd5c5b986b80c9dd6',
  (select string_agg(md5(prosrc), ' ' order by ord) from (values
     (1, 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'),
     (2, 'identity.create_access_request(text,text,text,integer)'), (3, 'identity.approve_access_request(uuid)'),
     (4, 'auth.membership_has_permission(text,uuid,uuid,text)')) wanted(ord, signature)
     join pg_proc p on p.oid = wanted.signature::regprocedure));

-- 2. Fixtures: one facility; a doctor, clinician, nurse, lab member,
-- pharmacist and receptionist there; patients aged 40 (P1, with a login and a
-- live patient session), 17 (P2), with no date of birth (P3), turning 18
-- today (P4) and tomorrow (P5) in Africa/Lagos, and born tomorrow (P6).
insert into auth.accounts (id, subject, email, display_name, status)
select ('100a1000-0000-4000-8000-00000000000' || n)::uuid, 'staff:records-processing-' || role_code,
  'records-processing-' || role_code || '@example.invalid', 'Records ' || role_code, 'active'
  from unnest(array['doctor', 'clinician', 'nurse', 'lab', 'pharmacist', 'receptionist']) with ordinality r(role_code, n);
insert into auth.accounts (id, subject, email, display_name, status) values
  ('100a1000-0000-4000-8000-000000000009', 'synthetic:records-processing:p1', 'records-processing-p1@example.invalid',
   'Records P1', 'active');
insert into identity.organizations (id, name, slug) values
  ('100a6000-0000-4000-8000-000000000001', 'Records Processing Test Org', 'records-processing-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('100a6000-0000-4000-8000-000000000002', '100a6000-0000-4000-8000-000000000001', 'Records Processing Hospital',
   'RP-A', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('100a2000-0000-4000-8000-00000000000' || n)::uuid, ('100a1000-0000-4000-8000-00000000000' || n)::uuid,
  'Records ' || role_code, 'records-processing-' || role_code || '@example.invalid', 'verified', role_code
  from unnest(array['doctor', 'clinician', 'nurse', 'lab', 'pharmacist', 'receptionist']) with ordinality r(role_code, n);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('100a3000-0000-4000-8000-00000000000' || n)::uuid, ('100a2000-0000-4000-8000-00000000000' || n)::uuid,
  ('100a1000-0000-4000-8000-00000000000' || n)::uuid, '100a6000-0000-4000-8000-000000000001',
  '100a6000-0000-4000-8000-000000000002', role_code, role_code, true, true
  from unnest(array['doctor', 'clinician', 'nurse', 'lab', 'pharmacist', 'receptionist']) with ordinality r(role_code, n);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('100a4000-0000-4000-8000-00000000000' || n)::uuid, ('100a1000-0000-4000-8000-00000000000' || n)::uuid,
  role_code, 'facility', ('100a3000-0000-4000-8000-00000000000' || n)::uuid, '100a6000-0000-4000-8000-000000000002',
  'Records processing test ' || role_code
  from unnest(array['doctor', 'clinician', 'nurse', 'lab', 'pharmacist', 'receptionist']) with ordinality r(role_code, n);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, dob, status)
select ('100a5000-0000-4000-8000-00000000000' || n)::uuid,
  case when n = 1 then '100a1000-0000-4000-8000-000000000009'::uuid end, hid, 'Records', 'Patient ' || n,
  'Records Patient ' || n, dob, 'active'
  from (values
    (1, 'HID-RPADLT', ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '40 years')::date),
    (2, 'HID-RPMNRA', ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '17 years')::date),
    (3, 'HID-RPNDXB', null::date),
    (4, 'HID-RPBDAY', ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '18 years')::date),
    (5, 'HID-RPEVEA', ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '18 years' + interval '1 day')::date),
    (6, 'HID-RPFTRE', ((clock_timestamp() at time zone 'Africa/Lagos')::date + 1)))
    patient(n, hid, dob);
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('100a7000-0000-4000-8000-000000000001', '100a1000-0000-4000-8000-000000000009', '100a7000-0000-4000-8000-000000000001',
   md5('records-processing') || md5('records-processing'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   '100a5000-0000-4000-8000-000000000001');
-- A scanned-clean document of P1 at the facility (the scan event is written
-- without the scanner's checks).
set local session_replication_role = replica;
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status, retention_class)
values ('100a8000-0000-4000-8000-000000000001', '100a5000-0000-4000-8000-000000000001',
  '100a6000-0000-4000-8000-000000000002', '100a1000-0000-4000-8000-000000000001', '100a3000-0000-4000-8000-000000000001',
  'referral-letter.pdf', 'synthetic-bucket', 'synthetic/records-processing.pdf', 'records-v1', 'application/pdf', 1024,
  repeat('a', 64), 'uploaded', 'clinical_record');
insert into ehr.document_scan_events (document_id, patient_id, facility_id, created_by, event_type, detected_media_type,
  scanner_engine, scanner_version, idempotency_key, correlation_id, object_version_id, object_sha256_hex) values
  ('100a8000-0000-4000-8000-000000000001', '100a5000-0000-4000-8000-000000000001', '100a6000-0000-4000-8000-000000000002',
   '100a1000-0000-4000-8000-000000000001', 'clean', 'application/pdf', 'synthetic-scanner', '1.0',
   'records-processing-scan-1', 'records-processing-scan', 'records-v1', repeat('a', 64));
set local session_replication_role = origin;

-- Contexts as Identity and the EHR API set them. Staff n: 1 doctor, 2
-- clinician, 3 nurse, 4 lab, 5 pharmacist, 6 receptionist.
create function pg_temp.as_staff(n integer, purpose text) returns void language sql as $$
  select set_config('app.actor_subject', 'staff:records-processing-'
           || (array['doctor', 'clinician', 'nurse', 'lab', 'pharmacist', 'receptionist'])[n], true),
    set_config('app.facility_id', '100a6000-0000-4000-8000-000000000002', true),
    set_config('app.membership_id', '100a3000-0000-4000-8000-00000000000' || n, true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.correlation_id', 'records-processing-' || n || '-' || purpose, true);
$$;
create function pg_temp.as_patient() returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:records-processing:p1', true),
    set_config('app.correlation_id', 'records-processing-patient', true);
$$;
-- Where pg_temp.request keeps the id of the request it made.
create function pg_temp.request_key(n integer, hid text, purpose text) returns text language sql as $$
  select 'records_processing.request_' || n || '_' || lower(regexp_replace(hid || '_' || purpose, '[^A-Za-z0-9]', '_', 'g'));
$$;
create function pg_temp.request_id(n integer, hid text, purpose text) returns uuid language sql as $$
  select current_setting(pg_temp.request_key(n, hid, purpose))::uuid;
$$;
create function pg_temp.request(n integer, purpose text, hid text, scope text, minutes integer) returns text
language plpgsql as $$
declare
  outcome record;
begin
  perform pg_temp.as_staff(n, purpose);
  select * into outcome from identity.create_access_request(hid, scope, 'Turn paper records into the digital record (OCR)', minutes);
  perform set_config(pg_temp.request_key(n, hid, purpose), outcome.access_request_id::text, true);
  return format('ok %s %s %s existing=%s', outcome.request_status, outcome.request_purpose, outcome.request_scope,
    outcome.existing_request);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.allowed(n integer, patient integer, action text, purpose text) returns boolean language sql as $$
  select identity.has_active_consent_grant(('100a5000-0000-4000-8000-00000000000' || patient)::uuid,
    'staff:records-processing-' || (array['doctor', 'clinician', 'nurse', 'lab', 'pharmacist', 'receptionist'])[n],
    ('100a3000-0000-4000-8000-00000000000' || n)::uuid, '100a6000-0000-4000-8000-000000000002', action, purpose);
$$;
-- What the EHR API sees of P1's document: the row and its scan status.
create function pg_temp.document(n integer, purpose text) returns text language plpgsql as $$
declare
  seen text;
begin
  perform pg_temp.as_staff(n, purpose);
  select string_agg(effective.scan_status || '/' || effective.status, ',') into seen
    from ehr.documents_effective effective where effective.id = '100a8000-0000-4000-8000-000000000001';
  return format('%s rows=%s', coalesce(seen, 'hidden'),
    (select count(*) from ehr.documents where id = '100a8000-0000-4000-8000-000000000001'));
end $$;
-- Every check compares a grant's starts_at with now(), the transaction's
-- start (ehr.context_allows passes no time); a real request is its own
-- transaction. Grants written here start later, so they are moved an hour
-- back, as the owner, as the sealed-demo suite does.
create function pg_temp.backdate() returns void language sql as $$
  update identity.consent_grants set starts_at = starts_at - interval '1 hour'
   where patient_id::text like '100a5000-%' and starts_at >= now();
$$;
grant execute on function pg_temp.as_staff(integer, text), pg_temp.as_patient(),
  pg_temp.request_key(integer, text, text), pg_temp.request_id(integer, text, text),
  pg_temp.request(integer, text, text, text, integer), pg_temp.allowed(integer, integer, text, text),
  pg_temp.document(integer, text) to public;

-- 3. Who may ask, and for whom, as the Identity API runtime.
set local role hid_identity_api_runtime;
select pg_temp.expect('3a doctor asks for P1 (write, 24 hours)', 'ok pending healthcare-operations write_records existing=f',
  pg_temp.request(1, 'healthcare-operations', 'HID-RPADLT', 'write_records', 1440));
select pg_temp.expect('3b clinician asks for P1', 'ok pending healthcare-operations write_records existing=f',
  pg_temp.request(2, 'healthcare-operations', 'HID-RPADLT', 'write_records', 1440));
select pg_temp.expect('3c nurse asks for P1', 'ok pending healthcare-operations read_records existing=f',
  pg_temp.request(3, 'healthcare-operations', 'HID-RPADLT', 'read_records', 60));
select pg_temp.expect('3d lab member asks for P1', 'ok pending healthcare-operations write_records existing=f',
  pg_temp.request(4, 'healthcare-operations', 'HID-RPADLT', 'write_records', 1440));
select pg_temp.expect('3e pharmacist is refused', '42501 RECORDS_PROCESSING_NOT_ALLOWED',
  pg_temp.request(5, 'healthcare-operations', 'HID-RPADLT', 'write_records', 1440));
select pg_temp.expect('3f receptionist is refused', '42501 RECORDS_PROCESSING_NOT_ALLOWED',
  pg_temp.request(6, 'healthcare-operations', 'HID-RPADLT', 'read_records', 1440));
select pg_temp.expect('3g pharmacist asking for a minor learns no age', '42501 RECORDS_PROCESSING_NOT_ALLOWED',
  pg_temp.request(5, 'healthcare-operations', 'HID-RPMNRA', 'write_records', 1440));
select pg_temp.expect('3h a patient aged 17 is refused', '42501 RECORDS_PROCESSING_MINOR',
  pg_temp.request(1, 'healthcare-operations', 'HID-RPMNRA', 'write_records', 1440));
select pg_temp.expect('3i no date of birth is refused', '42501 RECORDS_PROCESSING_MINOR',
  pg_temp.request(1, 'healthcare-operations', 'HID-RPNDXB', 'write_records', 1440));
select pg_temp.expect('3j 18 today in Lagos is an adult', 'ok pending healthcare-operations write_records existing=f',
  pg_temp.request(1, 'healthcare-operations', 'HID-RPBDAY', 'write_records', 1440));
select pg_temp.expect('3k 18 tomorrow in Lagos is refused', '42501 RECORDS_PROCESSING_MINOR',
  pg_temp.request(1, 'healthcare-operations', 'HID-RPEVEA', 'write_records', 1440));
select pg_temp.expect('3l a date of birth in the future is refused', '42501 RECORDS_PROCESSING_MINOR',
  pg_temp.request(1, 'healthcare-operations', 'HID-RPFTRE', 'write_records', 1440));
select pg_temp.expect('3m a lab member asking for a minor is refused', '42501 RECORDS_PROCESSING_MINOR',
  pg_temp.request(4, 'healthcare-operations', 'HID-RPMNRA', 'read_records', 30));
select pg_temp.expect('3n the replay of a pending request', 'ok pending healthcare-operations write_records existing=t',
  pg_temp.request(1, 'healthcare-operations', 'HID-RPADLT', 'write_records', 1440));
select pg_temp.expect('3o more than 24 hours (the command''s own check)', '22023 Invalid access request duration',
  pg_temp.request(1, 'healthcare-operations', 'HID-RPADLT', 'read_records', 1441));
-- The trigger ignores every other purpose: a pharmacist and a receptionist
-- still ask for direct care, for a minor and for a patient with no date of
-- birth.
select pg_temp.expect('3p direct care: pharmacist for a minor', 'ok pending direct-care write_records existing=f',
  pg_temp.request(5, 'direct-care', 'HID-RPMNRA', 'write_records', 60));
select pg_temp.expect('3q direct care: receptionist, no date of birth', 'ok pending direct-care read_records existing=f',
  pg_temp.request(6, 'direct-care', 'HID-RPNDXB', 'read_records', 60));
select pg_temp.expect('3r direct care: doctor for P1', 'ok pending direct-care read_records existing=f',
  pg_temp.request(1, 'direct-care', 'HID-RPADLT', 'read_records', 60));
-- Emergency: break-glass on the 17-year-old is unchanged.
select pg_temp.as_staff(1, 'emergency');
select pg_temp.expect('3s emergency break-glass on a minor', 'active',
  pg_temp.try($q$select grant_status from identity.activate_break_glass('HID-RPMNRA',
    'Unconscious patient in the emergency room', 30)$q$));
-- P1's own break-glass (the clinician's): the patient's list leaves it out (4a).
select pg_temp.as_staff(2, 'emergency');
select pg_temp.expect('3s2 emergency break-glass on P1', 'active',
  pg_temp.try($q$select grant_status from identity.activate_break_glass('HID-RPADLT',
    'Unconscious patient in the emergency room', 30)$q$));
select pg_temp.as_staff(1, 'healthcare-operations');
select pg_temp.expect('3t break-glass under records processing', '22023 Break-glass requires the emergency purpose of use',
  pg_temp.try($q$select grant_status from identity.activate_break_glass('HID-RPADLT',
    'Unconscious patient in the emergency room', 30)$q$));
reset role;

-- 3u-3z. Writes that do not come through the command (as the table's owner):
-- the trigger still guards records-processing rows and only those.
create function pg_temp.insert_request(n text, membership integer, patient integer, scope text, minutes integer,
  purpose text, break_glass boolean) returns text language sql as $$
  select pg_temp.try(format($i$insert into identity.access_requests (id, patient_id, staff_id, membership_id,
      facility_id, scope, purpose_of_use, reason, status, requested_duration_minutes, break_glass, correlation_id)
    values ('100a9000-0000-4000-8000-0000000000%s', '100a5000-0000-4000-8000-00000000000%s',
      '100a2000-0000-4000-8000-00000000000%s', '100a3000-0000-4000-8000-00000000000%s',
      '100a6000-0000-4000-8000-000000000002', %L, %L, 'Direct insert for the trigger', 'pending', %s, %L,
      'records-processing-direct') returning 'ok'$i$, n, patient, membership, membership, scope, purpose, minutes,
    break_glass));
$$;
select set_config('app.actor_subject', '', true), set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true);
select pg_temp.expect('3u no actor: records processing is refused', '42501 RECORDS_PROCESSING_NOT_ALLOWED',
  pg_temp.insert_request('01', 1, 1, 'read_records', 60, 'healthcare-operations', false));
select pg_temp.expect('3v no actor: direct care is not the trigger''s', 'ok',
  pg_temp.insert_request('02', 1, 2, 'read_records', 60, 'direct-care', false));
select pg_temp.expect('3w no actor: an emergency row is not the trigger''s', 'ok',
  pg_temp.insert_request('03', 5, 3, 'break_glass', 60, 'emergency', true));
select pg_temp.as_staff(1, 'healthcare-operations');
select pg_temp.expect('3x another account''s membership is refused', '42501 RECORDS_PROCESSING_NOT_ALLOWED',
  pg_temp.insert_request('04', 4, 1, 'read_records', 60, 'healthcare-operations', false));
select pg_temp.expect('3y the break_glass scope without the flag', '22023 RECORDS_PROCESSING_REQUEST_INVALID',
  pg_temp.insert_request('05', 1, 1, 'break_glass', 60, 'healthcare-operations', false));
select pg_temp.expect('3z more than 24 hours, before the table CHECK', '22023 RECORDS_PROCESSING_REQUEST_INVALID',
  pg_temp.insert_request('06', 1, 1, 'read_records', 1441, 'healthcare-operations', false));
select pg_temp.expect('3z2 a direct insert for a minor', '42501 RECORDS_PROCESSING_MINOR',
  pg_temp.insert_request('07', 1, 2, 'read_records', 60, 'healthcare-operations', false));
select pg_temp.expect('3z3 a direct insert for an adult', 'ok',
  pg_temp.insert_request('08', 1, 4, 'read_records', 60, 'healthcare-operations', false));
-- A request of P1 held by the cutover (no purpose): the patient's list leaves
-- it out (4a).
select pg_temp.expect('3z4 a held request is not the trigger''s', 'ok',
  pg_temp.try($i$insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope,
      purpose_of_use, reason, status, requested_duration_minutes, break_glass, migration_hold_reason, source_system)
    values ('100a9000-0000-4000-8000-000000000009', '100a5000-0000-4000-8000-000000000001',
      '100a2000-0000-4000-8000-000000000001', '100a3000-0000-4000-8000-000000000001',
      '100a6000-0000-4000-8000-000000000002', 'read_records', null, 'Legacy request awaiting review', 'pending', 60,
      false, 'legacy_request_purpose_unmapped', 'legacy_identity') returning 'ok'$i$));

-- 4. The patient sees the purpose (and, as in 0072, neither the break-glass
-- request nor the held one), approves, and the grant is for records
-- processing only.
set local role hid_identity_api_runtime;
select pg_temp.as_patient();
select pg_temp.expect('4a the list shows each purpose',
  'healthcare-operations write_records pending, healthcare-operations write_records pending, '
  || 'healthcare-operations read_records pending, healthcare-operations write_records pending, '
  || 'direct-care read_records pending',
  (select string_agg(format('%s %s %s', listed.purpose_of_use, listed.scope, listed.status), ', '
            order by listed.requested_at, listed.access_request_id)
     from identity.list_my_access_requests() listed));
-- Today's Identity image reads the list by name (consent.service.ts).
select pg_temp.expect('4b today''s Identity query', '5 rows, 11 keys',
  (select format('%s rows, %s keys', count(*), max((select count(*) from jsonb_object_keys(to_jsonb(old_row)))))
     from (select access_request_id as "accessRequestId", facility_id as "facilityId",
             facility_name as "facilityName", scope, reason, status,
             requested_duration_minutes as "requestedDurationMinutes",
             requested_at as "requestedAt", approved_at as "approvedAt",
             denied_at as "deniedAt", denied_reason as "deniedReason"
           from identity.list_my_access_requests()) old_row));
select set_config('records_processing.grant_doctor', (select consent_grant_id::text
  from identity.approve_access_request(pg_temp.request_id(1, 'HID-RPADLT', 'healthcare-operations'))), true);
select set_config('records_processing.grant_lab', (select consent_grant_id::text
  from identity.approve_access_request(pg_temp.request_id(4, 'HID-RPADLT', 'healthcare-operations'))), true);
select pg_temp.expect('4c the list after approval', 'approved healthcare-operations',
  (select listed.status || ' ' || listed.purpose_of_use from identity.list_my_access_requests() listed
    where listed.access_request_id = pg_temp.request_id(1, 'HID-RPADLT', 'healthcare-operations')));
reset role;
select pg_temp.expect('4d the grant', 'healthcare-operations write_records active patient=t 1440 minutes',
  (select format('%s %s %s patient=%s %s minutes', purpose_of_use, scope, status,
            granted_by_patient_id = '100a5000-0000-4000-8000-000000000001',
            round(extract(epoch from expires_at - starts_at) / 60))
     from identity.consent_grants where id = current_setting('records_processing.grant_doctor')::uuid));
select pg_temp.backdate();
select pg_temp.expect('4e records processing, not direct care',
  'rp read=t rp write=t dc read=f dc write=f emergency read=f',
  format('rp read=%s rp write=%s dc read=%s dc write=%s emergency read=%s',
    pg_temp.allowed(1, 1, 'read_records', 'healthcare-operations'), pg_temp.allowed(1, 1, 'write_records', 'healthcare-operations'),
    pg_temp.allowed(1, 1, 'read_records', 'direct-care'), pg_temp.allowed(1, 1, 'write_records', 'direct-care'),
    pg_temp.allowed(1, 1, 'read_records', 'emergency')));
select pg_temp.expect('4f the grant is the doctor''s membership only', 'clinician=f nurse=f pharmacist=f',
  format('clinician=%s nurse=%s pharmacist=%s', pg_temp.allowed(2, 1, 'read_records', 'healthcare-operations'),
    pg_temp.allowed(3, 1, 'read_records', 'healthcare-operations'), pg_temp.allowed(5, 1, 'read_records', 'healthcare-operations')));

-- 5. A direct-care share (the patient's own command) does not open records
-- processing, and is unchanged.
set local role hid_identity_api_runtime;
select pg_temp.as_patient();
select pg_temp.expect('5a P1 shares with the nurse', 'write_records',
  pg_temp.try($q$select scope from identity.create_my_consent_share('synthetic:records-processing:p1',
    '100a7000-0000-4000-8000-000000000001', '100a3000-0000-4000-8000-000000000003', 'clinical_collaboration', '24h',
    'records-processing-share-0001', repeat('b', 64))$q$));
reset role;
select pg_temp.backdate();
select pg_temp.expect('5b the share is direct care only', 'dc read=t dc write=t rp read=f rp write=f',
  format('dc read=%s dc write=%s rp read=%s rp write=%s',
    pg_temp.allowed(3, 1, 'read_records', 'direct-care'), pg_temp.allowed(3, 1, 'write_records', 'direct-care'),
    pg_temp.allowed(3, 1, 'read_records', 'healthcare-operations'), pg_temp.allowed(3, 1, 'write_records', 'healthcare-operations')));
select pg_temp.expect('5c the share''s purpose', 'direct-care',
  (select string_agg(purpose_of_use, ',') from identity.consent_grants
    where patient_id = '100a5000-0000-4000-8000-000000000001' and membership_id = '100a3000-0000-4000-8000-000000000003'));

-- 6. The document, through the EHR API runtime: visible with its clean scan
-- under records processing with the grant, hidden without it.
set local role hid_ehr_api_runtime;
select pg_temp.expect('6a doctor, records processing', 'clean/available rows=1', pg_temp.document(1, 'healthcare-operations'));
select pg_temp.expect('6b doctor, direct care (no direct-care grant)', 'hidden rows=0', pg_temp.document(1, 'direct-care'));
select pg_temp.expect('6c clinician, records processing, not approved', 'hidden rows=0',
  pg_temp.document(2, 'healthcare-operations'));
select pg_temp.expect('6d nurse, records processing (share only)', 'hidden rows=0', pg_temp.document(3, 'healthcare-operations'));
select pg_temp.expect('6e nurse, direct care (share)', 'clean/available rows=1', pg_temp.document(3, 'direct-care'));
select pg_temp.expect('6f pharmacist, records processing', 'hidden rows=0', pg_temp.document(5, 'healthcare-operations'));
reset role;

-- 7. The PIN stays direct care only.
set local role hid_identity_api_runtime;
select pg_temp.as_patient();
select identity.set_my_patient_access_pin('synthetic:records-processing:p1', '100a7000-0000-4000-8000-000000000001', '2468');
select pg_temp.as_staff(1, 'healthcare-operations');
select pg_temp.expect('7a PIN under records processing', '22023 Patient PIN access requires direct care',
  pg_temp.try($q$select consent_grant_id::text from identity.access_patient_with_pin('HID-RPADLT', '2468', 15)$q$));
select pg_temp.as_staff(1, 'direct-care');
select set_config('records_processing.pin', pg_temp.try($q$select consent_grant_id::text
  from identity.access_patient_with_pin('HID-RPADLT', '2468', 15)$q$), true);
reset role;
select pg_temp.expect('7b PIN under direct care', 'direct-care read_records patient_access_pin',
  (select format('%s %s %s', purpose_of_use, scope, authorization_method) from identity.consent_grants
    where id::text = current_setting('records_processing.pin')));

-- 8. The patient revokes the records-processing grant: access ends at the
-- next check.
set local role hid_identity_api_runtime;
select pg_temp.as_patient();
select pg_temp.expect('8a P1 revokes', 'revoked',
  pg_temp.try(format($q$select grant_status from identity.revoke_my_consent_grant('synthetic:records-processing:p1',
    '100a7000-0000-4000-8000-000000000001', %L, 'I no longer want this')$q$, current_setting('records_processing.grant_doctor'))));
reset role;
select pg_temp.expect('8b after revocation', 'rp read=f rp write=f',
  format('rp read=%s rp write=%s', pg_temp.allowed(1, 1, 'read_records', 'healthcare-operations'),
    pg_temp.allowed(1, 1, 'write_records', 'healthcare-operations')));
set local role hid_ehr_api_runtime;
select pg_temp.expect('8c the document after revocation', 'hidden rows=0', pg_temp.document(1, 'healthcare-operations'));
select pg_temp.expect('8d the lab member''s grant is still open', 'clean/available rows=1',
  pg_temp.document(4, 'healthcare-operations'));
reset role;

-- 9. The kill switch: the code made inactive denies every records-processing
-- request and read; direct care is untouched.
update identity.purpose_of_use_codes set active = false where code = 'healthcare-operations';
set local role hid_identity_api_runtime;
select pg_temp.expect('9a a new request', '22023 Invalid purpose for a standard access request',
  pg_temp.request(2, 'healthcare-operations', 'HID-RPBDAY', 'write_records', 1440));
select pg_temp.expect('9b the replay of a pending request', '22023 Invalid purpose for a standard access request',
  pg_temp.request(2, 'healthcare-operations', 'HID-RPADLT', 'write_records', 1440));
select pg_temp.as_patient();
select set_config('records_processing.grant_nurse', (select consent_grant_id::text
  from identity.approve_access_request(pg_temp.request_id(3, 'HID-RPADLT', 'healthcare-operations'))), true);
reset role;
select pg_temp.backdate();
select pg_temp.expect('9c the lab member''s open grant', 'rp read=f rp write=f',
  format('rp read=%s rp write=%s', pg_temp.allowed(4, 1, 'read_records', 'healthcare-operations'),
    pg_temp.allowed(4, 1, 'write_records', 'healthcare-operations')));
select pg_temp.expect('9d a grant approved while inactive authorizes nothing', 'written=t read=f',
  format('written=%s read=%s', current_setting('records_processing.grant_nurse') <> '',
    pg_temp.allowed(3, 1, 'read_records', 'healthcare-operations')));
set local role hid_ehr_api_runtime;
select pg_temp.expect('9e the lab member''s document', 'hidden rows=0', pg_temp.document(4, 'healthcare-operations'));
select pg_temp.expect('9f direct care is untouched', 'clean/available rows=1', pg_temp.document(3, 'direct-care'));
reset role;
update identity.purpose_of_use_codes set active = true where code = 'healthcare-operations';
select pg_temp.expect('9h made active again, the open grants count again', 'lab=t nurse=t',
  format('lab=%s nurse=%s', pg_temp.allowed(4, 1, 'read_records', 'healthcare-operations'),
    pg_temp.allowed(3, 1, 'read_records', 'healthcare-operations')));
update identity.purpose_of_use_codes set active = false where code = 'healthcare-operations';
set local role hid_identity_api_runtime;
select pg_temp.expect('9g direct-care requests still work', 'ok pending direct-care write_records existing=f',
  pg_temp.request(2, 'direct-care', 'HID-RPADLT', 'write_records', 60));
reset role;

-- The outcome.
do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected [%s], got [%s]', name, expected, actual), E'\n' order by seq) into failures
    from records_processing_cases where actual is distinct from expected;
  if failures is not null then
    raise exception E'records-processing cases failed:\n%', failures;
  end if;
  raise notice 'records-processing: % cases passed', (select count(*) from records_processing_cases);
end
$$;

rollback;
