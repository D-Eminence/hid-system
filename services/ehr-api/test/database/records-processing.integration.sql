\set ON_ERROR_STOP on
-- Records processing, Stage 1 (0104): the healthcare-operations purpose, the
-- access-request trigger (who may ask, the patient's age, scope and length),
-- the purpose on the patient's request list, and (owner decision 34(1)) the
-- cover by the patient's direct-care approval or Access PIN (section 10), which
-- since 0108 (owner decisions D-a and D-b of 2026-11-05) lasts as long as that
-- grant and also comes from an active patient share. Requests, approvals,
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

-- 1. What 0104 installs (and 0108's cover body).
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
-- The commands around the new trigger are unchanged (the bodies 0091, 0094,
-- 0095 and 0098 pin); the consent gate has 0104's body (decision 34(1), D9).
select pg_temp.expect('1g bodies', '732d11892dd4e27e1ff9093ae3b7de5a f88923a49a180c2180fdedb29bf2eccf '
  || 'af9482ccb8b9d9aa8486035478ac4e94 65e3eaff93fe729fd5c5b986b80c9dd6',
  (select string_agg(md5(prosrc), ' ' order by ord) from (values
     (1, 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'),
     (2, 'identity.create_access_request(text,text,text,integer)'), (3, 'identity.approve_access_request(uuid)'),
     (4, 'auth.membership_has_permission(text,uuid,uuid,text)')) wanted(ord, signature)
     join pg_proc p on p.oid = wanted.signature::regprocedure));
select pg_temp.expect('1g2 the cover has 0108''s body (owner decisions D-a and D-b)', '6928763d3b69f0e4b4acf96a6a255736',
  (select md5(prosrc) from pg_proc
    where oid = 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'::regprocedure));
select pg_temp.expect('1h the cover and the gate', 'cover: t/s/{"search_path=pg_catalog, pg_temp"}/t/hid_identity_runtime EXECUTE; '
  || 'gate: t/s/{"search_path=identity, auth, pg_temp"}/t',
  (select string_agg(format('%s: %s/%s/%s/%s%s', label, p.prosecdef, p.provolatile, p.proconfig,
            p.proowner = (select relowner from pg_class where oid = 'identity.access_requests'::regclass),
            case when label = 'cover' then '/' || (select string_agg(coalesce(nullif(acl.grantee::regrole::text, '-'), 'public')
                 || ' ' || acl.privilege_type, ', ') from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
               where acl.grantee <> p.proowner) else '' end), '; ' order by ord)
     from (values (1, 'cover', 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'),
                  (2, 'gate', 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)')) wanted(ord, label, signature)
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

-- 5. A direct-care share (the patient's own command) is unchanged for direct
-- care and, since 0108 D-b, also covers records processing for that
-- membership (section 10 has the details).
set local role hid_identity_api_runtime;
select pg_temp.as_patient();
select pg_temp.expect('5a P1 shares with the nurse', 'write_records',
  pg_temp.try($q$select scope from identity.create_my_consent_share('synthetic:records-processing:p1',
    '100a7000-0000-4000-8000-000000000001', '100a3000-0000-4000-8000-000000000003', 'clinical_collaboration', '24h',
    'records-processing-share-0001', repeat('b', 64))$q$));
reset role;
select pg_temp.backdate();
select pg_temp.expect('5b the share is direct care and covers records processing (0108 D-b)', 'dc read=t dc write=t rp read=t rp write=t',
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
select pg_temp.expect('6d nurse, records processing (the share covers it, 0108 D-b)', 'clean/available rows=1',
  pg_temp.document(3, 'healthcare-operations'));
select pg_temp.expect('6e nurse, direct care (share)', 'clean/available rows=1', pg_temp.document(3, 'direct-care'));
select pg_temp.expect('6f pharmacist, records processing', 'hidden rows=0', pg_temp.document(5, 'healthcare-operations'));
reset role;

-- 7. The PIN command stays direct care only (here the clinician's, so that
-- the doctor's records-processing grant is the only one section 8 revokes);
-- since decision 34(1) its grant also covers records processing (section 10).
set local role hid_identity_api_runtime;
select pg_temp.as_patient();
select identity.set_my_patient_access_pin('synthetic:records-processing:p1', '100a7000-0000-4000-8000-000000000001', '2468');
select pg_temp.as_staff(2, 'healthcare-operations');
select pg_temp.expect('7a PIN under records processing', '22023 Patient PIN access requires direct care',
  pg_temp.try($q$select consent_grant_id::text from identity.access_patient_with_pin('HID-RPADLT', '2468', 15)$q$));
select pg_temp.as_staff(2, 'direct-care');
select set_config('records_processing.pin', pg_temp.try($q$select consent_grant_id::text
  from identity.access_patient_with_pin('HID-RPADLT', '2468', 15)$q$), true);
reset role;
select pg_temp.expect('7b PIN under direct care', 'direct-care read_records patient_access_pin',
  (select format('%s %s %s', purpose_of_use, scope, authorization_method) from identity.consent_grants
    where id::text = current_setting('records_processing.pin')));
select pg_temp.expect('7c the PIN grant covers records processing (34(1))', 'rp read=t rp write=t dc read=t dc write=f',
  format('rp read=%s rp write=%s dc read=%s dc write=%s',
    pg_temp.allowed(2, 1, 'read_records', 'healthcare-operations'), pg_temp.allowed(2, 1, 'write_records', 'healthcare-operations'),
    pg_temp.allowed(2, 1, 'read_records', 'direct-care'), pg_temp.allowed(2, 1, 'write_records', 'direct-care')));

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

-- 10. Decision 34(1) (owner, 2026-11-03): the patient's approval of a
-- direct-care access request, or the patient's Access PIN, also covers
-- records processing for that staff member at that facility; since 0108
-- (owner, 2026-11-05) for as long as the grant lasts (D-a, no 24-hour bound),
-- and an active patient share covers it too, read and write at any level
-- (D-b). Under-18s, another facility, another staff member, break-glass,
-- emergency, seeded or imported grants, a membership that may not run OCR
-- jobs, a deny directive and the kill switch are not covered.
-- Fixtures: a second facility (B); a doctor with a membership at A (10) and at
-- B (11), a nurse (12) and a pharmacist (13) at A; patients with a login and a
-- live session aged 40 (P7), 17 (P8) and with no date of birth (P9); a clean
-- document of P7 at A. Section 9 left the kill switch on; it is off again.
update identity.purpose_of_use_codes set active = true where code = 'healthcare-operations';
insert into auth.accounts (id, subject, email, display_name, status)
select ('100a1000-0000-4000-8000-0000000000' || n)::uuid, subject, 'records-processing-cover-' || n || '@example.invalid',
  'Records cover ' || n, 'active'
  from (values (10, 'staff:records-processing-cover-doctor'), (11, 'staff:records-processing-cover-nurse'),
               (12, 'staff:records-processing-cover-pharmacist'), (13, 'synthetic:records-processing:p7'),
               (14, 'synthetic:records-processing:p8'), (15, 'synthetic:records-processing:p9')) account_row(n, subject);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('100a6000-0000-4000-8000-000000000003', '100a6000-0000-4000-8000-000000000001', 'Records Processing Clinic B',
   'RP-B', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('100a2000-0000-4000-8000-0000000000' || n)::uuid, ('100a1000-0000-4000-8000-0000000000' || n)::uuid,
  'Records cover ' || role_code, 'records-processing-cover-' || n || '@example.invalid', 'verified', role_code
  from (values (10, 'doctor'), (11, 'nurse'), (12, 'pharmacist')) staff_row(n, role_code);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('100a3000-0000-4000-8000-0000000000' || m)::uuid, ('100a2000-0000-4000-8000-0000000000' || n)::uuid,
  ('100a1000-0000-4000-8000-0000000000' || n)::uuid, '100a6000-0000-4000-8000-000000000001', facility::uuid,
  role_code, role_code, is_primary, true
  from (values (10, 10, 'doctor', '100a6000-0000-4000-8000-000000000002', true),
               (11, 10, 'doctor', '100a6000-0000-4000-8000-000000000003', false),
               (12, 11, 'nurse', '100a6000-0000-4000-8000-000000000002', true),
               (13, 12, 'pharmacist', '100a6000-0000-4000-8000-000000000002', true)) membership_row(m, n, role_code, facility, is_primary);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('100a4000-0000-4000-8000-0000000000' || m)::uuid, ('100a1000-0000-4000-8000-0000000000' || n)::uuid, role_code,
  'facility', ('100a3000-0000-4000-8000-0000000000' || m)::uuid, facility::uuid, 'Records processing cover test ' || role_code
  from (values (10, 10, 'doctor', '100a6000-0000-4000-8000-000000000002'),
               (11, 10, 'doctor', '100a6000-0000-4000-8000-000000000003'),
               (12, 11, 'nurse', '100a6000-0000-4000-8000-000000000002'),
               (13, 12, 'pharmacist', '100a6000-0000-4000-8000-000000000002')) role_row(m, n, role_code, facility);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, dob, status)
select ('100a5000-0000-4000-8000-00000000000' || n)::uuid, ('100a1000-0000-4000-8000-0000000000' || (n + 6))::uuid, hid,
  'Records', 'Patient ' || n, 'Records Patient ' || n, dob, 'active'
  from (values
    (7, 'HID-RPCVRA', ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '40 years')::date),
    (8, 'HID-RPCVRB', ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '17 years')::date),
    (9, 'HID-RPCVRC', null::date)) patient(n, hid, dob);
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('100a7000-0000-4000-8000-00000000000' || n)::uuid, ('100a1000-0000-4000-8000-0000000000' || (n + 6))::uuid,
  ('100a7000-0000-4000-8000-00000000000' || n)::uuid, md5('records-processing-cover-' || n) || md5('cover-' || n),
  gen_random_uuid(), 1, 'password', clock_timestamp(), clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours', 'patient', ('100a5000-0000-4000-8000-00000000000' || n)::uuid
  from generate_series(7, 9) n;
set local session_replication_role = replica;
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status, retention_class)
values ('100a8000-0000-4000-8000-000000000007', '100a5000-0000-4000-8000-000000000007',
  '100a6000-0000-4000-8000-000000000002', '100a1000-0000-4000-8000-000000000010', '100a3000-0000-4000-8000-000000000010',
  'old-clinic-card.pdf', 'synthetic-bucket', 'synthetic/records-processing-cover.pdf', 'cover-v1', 'application/pdf', 2048,
  repeat('c', 64), 'uploaded', 'clinical_record');
insert into ehr.document_scan_events (document_id, patient_id, facility_id, created_by, event_type, detected_media_type,
  scanner_engine, scanner_version, idempotency_key, correlation_id, object_version_id, object_sha256_hex) values
  ('100a8000-0000-4000-8000-000000000007', '100a5000-0000-4000-8000-000000000007', '100a6000-0000-4000-8000-000000000002',
   '100a1000-0000-4000-8000-000000000010', 'clean', 'application/pdf', 'synthetic-scanner', '1.0',
   'records-processing-cover-scan-7', 'records-processing-cover-scan', 'cover-v1', repeat('c', 64));
set local session_replication_role = origin;

-- Who asks or checks: doctor (A), doctor-b (B's membership at B),
-- doctor-a-at-b (A's membership, B's facility), nurse, pharmacist.
create function pg_temp.cover_actor(who text) returns text[] language sql as $$
  select case who
    when 'doctor' then array['staff:records-processing-cover-doctor', '100a3000-0000-4000-8000-000000000010', '100a6000-0000-4000-8000-000000000002']
    when 'doctor-b' then array['staff:records-processing-cover-doctor', '100a3000-0000-4000-8000-000000000011', '100a6000-0000-4000-8000-000000000003']
    when 'doctor-a-at-b' then array['staff:records-processing-cover-doctor', '100a3000-0000-4000-8000-000000000010', '100a6000-0000-4000-8000-000000000003']
    when 'nurse' then array['staff:records-processing-cover-nurse', '100a3000-0000-4000-8000-000000000012', '100a6000-0000-4000-8000-000000000002']
    when 'pharmacist' then array['staff:records-processing-cover-pharmacist', '100a3000-0000-4000-8000-000000000013', '100a6000-0000-4000-8000-000000000002']
  end;
$$;
create function pg_temp.as_cover_staff(who text, purpose text) returns void language sql as $$
  select set_config('app.actor_subject', (pg_temp.cover_actor(who))[1], true),
    set_config('app.membership_id', (pg_temp.cover_actor(who))[2], true),
    set_config('app.facility_id', (pg_temp.cover_actor(who))[3], true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.correlation_id', 'records-processing-cover-' || who || '-' || purpose, true);
$$;
create function pg_temp.as_cover_patient(n integer) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:records-processing:p' || n, true),
    set_config('app.correlation_id', 'records-processing-cover-patient-' || n, true);
$$;
-- A request the staff member makes and the patient approves: the grant's id.
create function pg_temp.cover_approved(who text, purpose text, n integer, scope text, minutes integer) returns text
language plpgsql as $$
declare
  request uuid;
  granted uuid;
begin
  perform pg_temp.as_cover_staff(who, purpose);
  select access_request_id into request from identity.create_access_request(
    (array['HID-RPCVRA', 'HID-RPCVRB', 'HID-RPCVRC'])[n - 6], scope, 'Clinic visit', minutes);
  perform pg_temp.as_cover_patient(n);
  select consent_grant_id into granted from identity.approve_access_request(request);
  return granted::text;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.cover_allowed(who text, n integer, action text, purpose text,
  at_time timestamptz default current_timestamp) returns boolean language sql as $$
  select identity.has_active_consent_grant(('100a5000-0000-4000-8000-00000000000' || n)::uuid,
    (pg_temp.cover_actor(who))[1], (pg_temp.cover_actor(who))[2]::uuid, (pg_temp.cover_actor(who))[3]::uuid,
    action, purpose, at_time);
$$;
-- Records processing read and write, direct care read and write, emergency read.
create function pg_temp.cover_answers(who text, n integer, at_time timestamptz default current_timestamp) returns text
language sql as $$
  select format('rp read=%s rp write=%s dc read=%s dc write=%s', pg_temp.cover_allowed(who, n, 'read_records',
    'healthcare-operations', at_time), pg_temp.cover_allowed(who, n, 'write_records', 'healthcare-operations', at_time),
    pg_temp.cover_allowed(who, n, 'read_records', 'direct-care', at_time),
    pg_temp.cover_allowed(who, n, 'write_records', 'direct-care', at_time));
$$;
create function pg_temp.cover_document(who text, purpose text) returns text language plpgsql as $$
declare
  seen text;
begin
  perform pg_temp.as_cover_staff(who, purpose);
  select string_agg(effective.scan_status || '/' || effective.status, ',') into seen
    from ehr.documents_effective effective where effective.id = '100a8000-0000-4000-8000-000000000007';
  return coalesce(seen, 'hidden');
end $$;
grant execute on function pg_temp.cover_actor(text), pg_temp.as_cover_staff(text, text), pg_temp.as_cover_patient(integer),
  pg_temp.cover_approved(text, text, integer, text, integer), pg_temp.cover_allowed(text, integer, text, text, timestamptz),
  pg_temp.cover_answers(text, integer, timestamptz), pg_temp.cover_document(text, text) to public;

-- 10a-10h. The patient approves the doctor's direct-care request (read, 60
-- minutes): records processing is covered for the doctor at A only.
set local role hid_identity_api_runtime;
select set_config('records_processing.cover_g1', pg_temp.cover_approved('doctor', 'direct-care', 7, 'read_records', 60), true);
reset role;
select pg_temp.backdate();
select pg_temp.expect('10a the approval grant is direct care, read, the patient''s', 'direct-care read_records approved patient=t method=none',
  (select format('%s %s %s patient=%s method=%s', grant_row.purpose_of_use, grant_row.scope, request_row.status,
            request_row.approved_by_patient_id = grant_row.patient_id, coalesce(grant_row.authorization_method, 'none'))
     from identity.consent_grants grant_row join identity.access_requests request_row on request_row.id = grant_row.request_id
    where grant_row.id::text = current_setting('records_processing.cover_g1')));
select pg_temp.expect('10b covered by the approval grant', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('doctor', 7));
select pg_temp.expect('10c no emergency from it', 'false', pg_temp.cover_allowed('doctor', 7, 'read_records', 'emergency')::text);
select pg_temp.expect('10d another facility (the doctor''s membership at B)', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('doctor-b', 7));
select pg_temp.expect('10e A''s membership asked for at B', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('doctor-a-at-b', 7));
select pg_temp.expect('10f another staff member at A', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('nurse', 7));
set local role hid_ehr_api_runtime;
select pg_temp.expect('10g P7''s document under records processing, covered', 'clean/available',
  pg_temp.cover_document('doctor', 'healthcare-operations'));
select pg_temp.expect('10h the nurse, not covered', 'hidden', pg_temp.cover_document('nurse', 'healthcare-operations'));
reset role;
-- 10i-10k. Identity reads which grant covered the check, and until when.
set local role hid_identity_api_runtime;
select set_config('records_processing.cover_answer',
  coalesce((select format('%s|%s', cover.consent_grant_id, cover.covered_until)
     from identity.records_processing_direct_care_cover('100a5000-0000-4000-8000-000000000007',
            'staff:records-processing-cover-doctor', '100a3000-0000-4000-8000-000000000010',
            '100a6000-0000-4000-8000-000000000002', 'write_records', current_timestamp) cover), 'none|none'), true);
reset role;
select pg_temp.expect('10i the cover names the approval grant and ends with it', 'grant=t until=expires_at',
  (select format('grant=%s until=%s', split_part(current_setting('records_processing.cover_answer'), '|', 1) = grant_row.id::text,
            case when split_part(current_setting('records_processing.cover_answer'), '|', 2)::timestamptz = grant_row.expires_at
                 then 'expires_at' else split_part(current_setting('records_processing.cover_answer'), '|', 2) end)
     from identity.consent_grants grant_row where grant_row.id::text = current_setting('records_processing.cover_g1')));
set local role hid_ehr_api_runtime;
select pg_temp.expect('10j only Identity may read the cover', '42501',
  left(pg_temp.try($q$select count(*)::text from identity.records_processing_direct_care_cover(
    '100a5000-0000-4000-8000-000000000007', 'staff:records-processing-cover-doctor',
    '100a3000-0000-4000-8000-000000000010', '100a6000-0000-4000-8000-000000000002', 'read_records', now())$q$), 5));
reset role;
select pg_temp.expect('10k who may execute the cover', 'identity=t ehr=f lab=f pharmacy=f ocr=f',
  format('identity=%s ehr=%s lab=%s pharmacy=%s ocr=%s',
    has_function_privilege('hid_identity_api_runtime', 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)', 'EXECUTE'),
    has_function_privilege('hid_ehr_api_runtime', 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)', 'EXECUTE'),
    has_function_privilege('hid_lab_api_runtime', 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)', 'EXECUTE'),
    has_function_privilege('hid_pharmacy_api_runtime', 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)', 'EXECUTE'),
    has_function_privilege('hid_ocr_api_runtime', 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)', 'EXECUTE')));

-- 10l-10o. Never past the grant's end; since 0108 D-a no longer bounded by
-- 24 hours from its start.
select pg_temp.expect('10l a second before the grant ends', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('doctor', 7, (select expires_at - interval '1 second' from identity.consent_grants
    where id::text = current_setting('records_processing.cover_g1'))));
select pg_temp.expect('10m when the grant ends', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('doctor', 7, (select expires_at from identity.consent_grants
    where id::text = current_setting('records_processing.cover_g1'))));
-- Requests last at most 24 hours and PIN grants 60 minutes today; a grant
-- made to last three days (as the owner) shows the cover lasting as long as
-- the grant, past 24 hours from its start.
update identity.consent_grants set starts_at = now() - interval '2 hours', expires_at = now() + interval '3 days'
 where id::text = current_setting('records_processing.cover_g1');
select pg_temp.expect('10n 24 hours from the start, the grant still active: covered (D-a)',
  'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('doctor', 7, now() + interval '22 hours'));
select pg_temp.expect('10n2 two days from the start: covered (D-a)', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('doctor', 7, now() + interval '2 days'));
select pg_temp.expect('10n3 a second before the three-day grant ends', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('doctor', 7, now() + interval '3 days' - interval '1 second'));
select pg_temp.expect('10o when the three-day grant ends: not covered', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('doctor', 7, now() + interval '3 days'));
set local role hid_identity_api_runtime;
select pg_temp.expect('10o2 the cover ends with the grant (covered_until = expires_at)', 'until=expires_at',
  (select 'until=' || case when cover.covered_until = now() + interval '3 days' then 'expires_at' else cover.covered_until::text end
     from identity.records_processing_direct_care_cover('100a5000-0000-4000-8000-000000000007',
            'staff:records-processing-cover-doctor', '100a3000-0000-4000-8000-000000000010',
            '100a6000-0000-4000-8000-000000000002', 'read_records', now() + interval '30 hours') cover));
reset role;

-- 10p-10q. The patient ends it by revoking the direct-care grant.
set local role hid_identity_api_runtime;
select pg_temp.as_cover_patient(7);
select pg_temp.expect('10p P7 revokes the doctor''s grant', 'revoked',
  pg_temp.try(format($q$select grant_status from identity.revoke_my_consent_grant('synthetic:records-processing:p7',
    '100a7000-0000-4000-8000-000000000007', %L, 'Not today')$q$, current_setting('records_processing.cover_g1'))));
reset role;
select pg_temp.expect('10q after the revocation', 'rp read=f rp write=f dc read=f dc write=f', pg_temp.cover_answers('doctor', 7));
set local role hid_ehr_api_runtime;
select pg_temp.expect('10q2 P7''s document after the revocation', 'hidden', pg_temp.cover_document('doctor', 'healthcare-operations'));
reset role;

-- 10r-10v. The Access PIN (direct care, read, at most 60 minutes) covers it
-- too, read and write; it ends with the PIN grant.
set local role hid_identity_api_runtime;
select pg_temp.as_cover_patient(7);
select identity.set_my_patient_access_pin('synthetic:records-processing:p7', '100a7000-0000-4000-8000-000000000007', '1357');
select pg_temp.as_cover_staff('doctor', 'direct-care');
select set_config('records_processing.cover_pin', pg_temp.try($q$select consent_grant_id::text
  from identity.access_patient_with_pin('HID-RPCVRA', '1357', 30)$q$), true);
reset role;
select pg_temp.expect('10r the PIN grant', 'direct-care read_records patient_access_pin approved',
  (select format('%s %s %s %s', grant_row.purpose_of_use, grant_row.scope, grant_row.authorization_method, request_row.status)
     from identity.consent_grants grant_row join identity.access_requests request_row on request_row.id = grant_row.request_id
    where grant_row.id::text = current_setting('records_processing.cover_pin')));
select pg_temp.expect('10s covered by the PIN grant', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('doctor', 7));
select pg_temp.expect('10t when the PIN grant ends', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('doctor', 7, (select expires_at from identity.consent_grants
    where id::text = current_setting('records_processing.cover_pin'))));
set local role hid_identity_api_runtime;
select pg_temp.as_cover_patient(7);
select pg_temp.expect('10u P7 turns the PIN off (its grants end)', 'ok',
  pg_temp.try($q$select null::text from identity.revoke_my_patient_access_pin('synthetic:records-processing:p7',
    '100a7000-0000-4000-8000-000000000007')$q$));
reset role;
select pg_temp.expect('10v after the PIN is turned off', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('doctor', 7));

-- 10w. Break-glass is not covered.
set local role hid_identity_api_runtime;
select pg_temp.as_cover_staff('doctor', 'emergency');
select pg_temp.expect('10w break-glass on P7', 'active',
  pg_temp.try($q$select grant_status from identity.activate_break_glass('HID-RPCVRA',
    'Unconscious patient in the emergency room', 30)$q$));
reset role;
select pg_temp.backdate();
select pg_temp.expect('10w2 break-glass covers emergency reading only', 'emergency=true rp read=f rp write=f dc read=f dc write=f',
  'emergency=' || pg_temp.cover_allowed('doctor', 7, 'read_records', 'emergency') || ' ' || pg_temp.cover_answers('doctor', 7));

-- 10x-10z. A membership that may not run OCR jobs is not covered; a share is
-- (0108 D-b).
set local role hid_identity_api_runtime;
select pg_temp.expect('10x the pharmacist''s approved direct-care request', 'true',
  (pg_temp.cover_approved('pharmacist', 'direct-care', 7, 'write_records', 60) ~ '^[0-9a-f-]{36}$')::text);
select pg_temp.as_cover_patient(7);
select pg_temp.expect('10y P7 shares with the nurse', 'write_records',
  pg_temp.try($q$select scope from identity.create_my_consent_share('synthetic:records-processing:p7',
    '100a7000-0000-4000-8000-000000000007', '100a3000-0000-4000-8000-000000000012', 'clinical_collaboration', '24h',
    'records-processing-cover-share-1', repeat('d', 64))$q$));
reset role;
select pg_temp.backdate();
select pg_temp.expect('10x2 pharmacist: direct care, no records processing', 'rp read=f rp write=f dc read=t dc write=t',
  pg_temp.cover_answers('pharmacist', 7));
select pg_temp.expect('10z the nurse''s share covers records processing (D-b)', 'rp read=t rp write=t dc read=t dc write=t',
  pg_temp.cover_answers('nurse', 7));

-- 10s. Patient shares (0108 D-b): any level covers records processing read
-- and write for that membership, for as long as the share lasts; never for
-- another membership or facility, an under-18 patient, under a deny
-- directive, after revocation or replacement, for a seeded or imported grant,
-- or for break-glass.
-- The active share grant of patient n to a membership, read as the owner.
create function pg_temp.share_grant(n integer, membership text) returns uuid language sql as $$
  select share_row.consent_grant_id
    from identity.patient_consent_shares share_row
    join identity.consent_grants grant_row on grant_row.id = share_row.consent_grant_id
   where share_row.patient_id = ('100a5000-0000-4000-8000-00000000000' || n)::uuid
     and share_row.membership_id = membership::uuid and grant_row.status = 'active'
   order by share_row.created_at desc
   limit 1;
$$;
-- The cover's answer for who and patient n at a time: the grant it names and its end.
create function pg_temp.cover_row(who text, n integer, action text, at_time timestamptz) returns text
language sql as $$
  select coalesce((select cover.consent_grant_id::text || '|' || cover.covered_until::text
     from identity.records_processing_direct_care_cover(('100a5000-0000-4000-8000-00000000000' || n)::uuid,
            (pg_temp.cover_actor(who))[1], (pg_temp.cover_actor(who))[2]::uuid, (pg_temp.cover_actor(who))[3]::uuid,
            action, at_time) cover), 'none');
$$;
select set_config('records_processing.share_n1', pg_temp.share_grant(7, '100a3000-0000-4000-8000-000000000012')::text, true);
select pg_temp.expect('10s1 the cover names the share and ends with it', 'share=t until=expires_at',
  (select format('share=%s until=%s', split_part(pg_temp.cover_row('nurse', 7, 'write_records', now()), '|', 1) = grant_row.id::text,
            case when nullif(split_part(pg_temp.cover_row('nurse', 7, 'write_records', now()), '|', 2), '')::timestamptz = grant_row.expires_at
                 then 'expires_at' else pg_temp.cover_row('nurse', 7, 'write_records', now()) end)
     from identity.consent_grants grant_row where grant_row.id::text = current_setting('records_processing.share_n1')));
-- P7 replaces it with a view_only share for 7 days (0095 D5 revokes the first).
set local role hid_identity_api_runtime;
select pg_temp.as_cover_patient(7);
select pg_temp.expect('10s2 P7 replaces the share with a view_only share for 7 days', 'read_records replaced=true',
  pg_temp.try($q$select scope || ' replaced=' || (replaced_consent_grant_id is not null)::text
    from identity.create_my_consent_share('synthetic:records-processing:p7',
    '100a7000-0000-4000-8000-000000000007', '100a3000-0000-4000-8000-000000000012', 'view_only', '7d',
    'records-processing-cover-share-2', repeat('f', 64))$q$));
reset role;
select pg_temp.backdate();
select set_config('records_processing.share_n2', pg_temp.share_grant(7, '100a3000-0000-4000-8000-000000000012')::text, true);
select pg_temp.expect('10s3 the replaced share no longer covers; the new one does', 'old=revoked named=new',
  (select format('old=%s named=%s', old_grant.status,
            case split_part(pg_temp.cover_row('nurse', 7, 'read_records', now()), '|', 1)
              when current_setting('records_processing.share_n2') then 'new'
              when current_setting('records_processing.share_n1') then 'old'
              else pg_temp.cover_row('nurse', 7, 'read_records', now()) end)
     from identity.consent_grants old_grant where old_grant.id::text = current_setting('records_processing.share_n1')));
select pg_temp.expect('10s4 a view_only share covers records processing read and write (D-b); direct care reads only',
  'rp read=t rp write=t dc read=t dc write=f', pg_temp.cover_answers('nurse', 7));
select pg_temp.expect('10s5 two days on, the 7-day share still covers (D-a)', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('nurse', 7, now() + interval '2 days'));
select pg_temp.expect('10s6 the share''s cover ends with it', 'until=expires_at end=none',
  (select format('until=%s end=%s',
            case when nullif(split_part(pg_temp.cover_row('nurse', 7, 'write_records', now() + interval '2 days'), '|', 2), '')::timestamptz
                      = grant_row.expires_at then 'expires_at'
                 else pg_temp.cover_row('nurse', 7, 'write_records', now() + interval '2 days') end,
            pg_temp.cover_row('nurse', 7, 'write_records', grant_row.expires_at))
     from identity.consent_grants grant_row where grant_row.id::text = current_setting('records_processing.share_n2')));
-- A seeded or imported grant (source_system other than 'hid') never covers,
-- share row or not (as the owner, put back after).
update identity.consent_grants set source_system = 'legacy_identity'
 where id::text = current_setting('records_processing.share_n2');
select pg_temp.expect('10s7 the share as a seeded grant: direct care only', 'rp read=f rp write=f dc read=t dc write=f',
  pg_temp.cover_answers('nurse', 7));
update identity.consent_grants set source_system = 'hid' where id::text = current_setting('records_processing.share_n2');
-- A share to the doctor's membership at B covers B's membership at B only.
set local role hid_identity_api_runtime;
select pg_temp.as_cover_patient(7);
select pg_temp.expect('10s8 P7 shares with the doctor''s membership at B', 'read_records',
  pg_temp.try($q$select scope from identity.create_my_consent_share('synthetic:records-processing:p7',
    '100a7000-0000-4000-8000-000000000007', '100a3000-0000-4000-8000-000000000011', 'clinical_review', '30d',
    'records-processing-cover-share-3', repeat('9', 64))$q$));
reset role;
select pg_temp.backdate();
select pg_temp.expect('10s9 B''s membership at B: covered', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('doctor-b', 7));
select pg_temp.expect('10s10 the same doctor''s membership at A: not covered by B''s share',
  'rp read=f rp write=f dc read=f dc write=f', pg_temp.cover_answers('doctor', 7));
select pg_temp.expect('10s11 A''s membership asked for at B: not covered', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('doctor-a-at-b', 7));
select pg_temp.expect('10s12 the nurse at A is covered by her own share, never by the doctor''s at B', 'own',
  case split_part(pg_temp.cover_row('nurse', 7, 'read_records', now()), '|', 1)
    when current_setting('records_processing.share_n2') then 'own'
    when (select grant_row.id::text from identity.consent_grants grant_row
           where grant_row.patient_id = '100a5000-0000-4000-8000-000000000007'
             and grant_row.membership_id = '100a3000-0000-4000-8000-000000000011' and grant_row.status = 'active')
      then 'the doctor''s'
    else pg_temp.cover_row('nurse', 7, 'read_records', now()) end);
-- A deny directive for records processing at B ends the share's cover there.
insert into identity.consent_directives (id, patient_id, current_version) values
  ('100a9200-0000-4000-8000-000000000001', '100a5000-0000-4000-8000-000000000007', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, facility_id, purposes, actions, starts_at, source_reference, reason, content_sha256) values
  ('100a9200-0000-4000-8000-000000000002', '100a9200-0000-4000-8000-000000000001', '100a5000-0000-4000-8000-000000000007',
   1, 'active', 'deny', 'facility', '100a6000-0000-4000-8000-000000000003', null, array['healthcare-operations'], '{}',
   now() - interval '1 hour', 'records-processing-cover-test', 'No paper records at B', repeat('e', 64));
select pg_temp.expect('10s13 a deny directive for records processing at B: the share covers nothing there',
  'rp read=f rp write=f dc read=t dc write=f', pg_temp.cover_answers('doctor-b', 7));
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, facility_id, purposes, actions, starts_at, source_reference, reason, content_sha256,
  supersedes_version) values
  ('100a9200-0000-4000-8000-000000000003', '100a9200-0000-4000-8000-000000000001', '100a5000-0000-4000-8000-000000000007',
   2, 'inactive', 'deny', 'facility', '100a6000-0000-4000-8000-000000000003', null, array['healthcare-operations'], '{}',
   now() - interval '1 hour', 'records-processing-cover-test', 'No paper records at B', repeat('e', 64), 1);
update identity.consent_directives set current_version = 2 where id = '100a9200-0000-4000-8000-000000000001';
select pg_temp.expect('10s14 the directive withdrawn: covered again', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('doctor-b', 7));
-- The patient revokes B's share: the cover ends at the next check.
select set_config('records_processing.share_b', pg_temp.share_grant(7, '100a3000-0000-4000-8000-000000000011')::text, true);
set local role hid_identity_api_runtime;
select pg_temp.as_cover_patient(7);
select pg_temp.expect('10s15 P7 revokes B''s share', 'revoked',
  pg_temp.try(format($q$select grant_status from identity.revoke_my_consent_grant('synthetic:records-processing:p7',
    '100a7000-0000-4000-8000-000000000007', %L, 'Not at B')$q$, current_setting('records_processing.share_b'))));
reset role;
select pg_temp.expect('10s16 after the revocation', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('doctor-b', 7));
-- Under 18 (P8) and no date of birth (P9): a share to the doctor at A is
-- direct care only.
set local role hid_identity_api_runtime;
select pg_temp.as_cover_patient(8);
select pg_temp.expect('10s17 P8 (17) shares with the doctor at A', 'write_records',
  pg_temp.try($q$select scope from identity.create_my_consent_share('synthetic:records-processing:p8',
    '100a7000-0000-4000-8000-000000000008', '100a3000-0000-4000-8000-000000000010', 'clinical_collaboration', '30d',
    'records-processing-cover-share-4', repeat('8', 64))$q$));
select pg_temp.as_cover_patient(9);
select pg_temp.expect('10s18 P9 (no date of birth) shares with the doctor at A', 'write_records',
  pg_temp.try($q$select scope from identity.create_my_consent_share('synthetic:records-processing:p9',
    '100a7000-0000-4000-8000-000000000009', '100a3000-0000-4000-8000-000000000010', 'clinical_collaboration', '30d',
    'records-processing-cover-share-5', repeat('7', 64))$q$));
reset role;
select pg_temp.backdate();
select pg_temp.expect('10s19 under 18 with a share: not covered', 'rp read=f rp write=f dc read=t dc write=t',
  pg_temp.cover_answers('doctor', 8));
select pg_temp.expect('10s20 no date of birth with a share: not covered', 'rp read=f rp write=f dc read=t dc write=t',
  pg_temp.cover_answers('doctor', 9));
-- A share row next to the doctor's break-glass grant (10w; as the owner, as
-- no command writes one): break-glass and emergency never cover.
insert into identity.patient_consent_shares (consent_grant_id, patient_id, membership_id, level, duration_preset,
  created_via, idempotency_key, request_sha256)
select grant_row.id, grant_row.patient_id, grant_row.membership_id, 'clinical_collaboration', '24h', 'search',
  'records-processing-cover-share-bg', repeat('6', 64)
  from identity.consent_grants grant_row
 where grant_row.patient_id = '100a5000-0000-4000-8000-000000000007'
   and grant_row.membership_id = '100a3000-0000-4000-8000-000000000010' and grant_row.break_glass
   and grant_row.status = 'active';
select pg_temp.expect('10s21 break-glass with a share row: emergency reading only',
  'emergency=true rp read=f rp write=f dc read=f dc write=f',
  'emergency=' || pg_temp.cover_allowed('doctor', 7, 'read_records', 'emergency') || ' ' || pg_temp.cover_answers('doctor', 7));
-- A direct-care grant with no request and no share row (as the owner, as
-- no command of this branch writes one): neither 0104's ways nor D-b.
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass, correlation_id, purpose_of_use)
values ('100a9300-0000-4000-8000-000000000001', null, '100a5000-0000-4000-8000-000000000007',
  '100a2000-0000-4000-8000-000000000010', '100a1000-0000-4000-8000-000000000010', '100a3000-0000-4000-8000-000000000011',
  '100a6000-0000-4000-8000-000000000003', 'write_records', 'active', '100a5000-0000-4000-8000-000000000007',
  'No request and no share', now() - interval '1 hour', now() + interval '1 day', false, 'records-processing-cover-bare',
  'direct-care');
select pg_temp.expect('10s21b a grant with no request and no share row: direct care only',
  'rp read=f rp write=f dc read=t dc write=t', pg_temp.cover_answers('doctor-b', 7));
update identity.consent_grants set status = 'revoked', revoked_at = now(), revoked_reason = 'Suite cleanup'
 where id = '100a9300-0000-4000-8000-000000000001';
-- The kill switch ends a share's cover as any other.
update identity.purpose_of_use_codes set active = false where code = 'healthcare-operations';
select pg_temp.expect('10s22 the kill switch ends the share''s cover', 'rp read=f rp write=f dc read=t dc write=f',
  pg_temp.cover_answers('nurse', 7));
update identity.purpose_of_use_codes set active = true where code = 'healthcare-operations';
-- The nurse's share ends here, so 10za-10ze read her approval grant alone.
set local role hid_identity_api_runtime;
select pg_temp.as_cover_patient(7);
select pg_temp.expect('10s23 P7 revokes the nurse''s share', 'revoked',
  pg_temp.try(format($q$select grant_status from identity.revoke_my_consent_grant('synthetic:records-processing:p7',
    '100a7000-0000-4000-8000-000000000007', %L, 'Not today')$q$, current_setting('records_processing.share_n2'))));
reset role;
select pg_temp.expect('10s24 after the nurse''s share is revoked', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('nurse', 7));

-- 10za-10ze. The nurse's approved request (read; her share ended in 10s23)
-- is covered; the patient's deny directive and the kill switch end it; a
-- separate records-processing request still works.
set local role hid_identity_api_runtime;
select set_config('records_processing.cover_g4', pg_temp.cover_approved('nurse', 'direct-care', 7, 'read_records', 120), true);
reset role;
select pg_temp.backdate();
select pg_temp.expect('10za the nurse''s approval grant is covered', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('nurse', 7));
insert into identity.consent_directives (id, patient_id, current_version) values
  ('100a9100-0000-4000-8000-000000000001', '100a5000-0000-4000-8000-000000000007', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, facility_id, purposes, actions, starts_at, source_reference, reason, content_sha256) values
  ('100a9100-0000-4000-8000-000000000002', '100a9100-0000-4000-8000-000000000001', '100a5000-0000-4000-8000-000000000007',
   1, 'active', 'deny', 'facility', '100a6000-0000-4000-8000-000000000002', null, array['healthcare-operations'], '{}',
   now() - interval '1 hour', 'records-processing-cover-test', 'No paper records here', repeat('e', 64));
select pg_temp.expect('10zb a deny directive for records processing at A', 'rp read=f rp write=f dc read=t dc write=f',
  pg_temp.cover_answers('nurse', 7));
-- Directive versions are append-only: each change is a new current version.
create function pg_temp.cover_directive(version integer, status text, purposes text[]) returns void language sql as $$
  insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
    grantee_type, grantee_id, facility_id, purposes, actions, starts_at, source_reference, reason, content_sha256,
    supersedes_version)
  values (('100a9100-0000-4000-8000-00000000001' || version)::uuid, '100a9100-0000-4000-8000-000000000001',
    '100a5000-0000-4000-8000-000000000007', version, status, 'deny', 'facility', '100a6000-0000-4000-8000-000000000002',
    null, purposes, '{}', now() - interval '1 hour', 'records-processing-cover-test', 'No paper records here',
    repeat('e', 64), version - 1);
  update identity.consent_directives set current_version = version where id = '100a9100-0000-4000-8000-000000000001';
$$;
select pg_temp.cover_directive(2, 'active', array['direct-care']);
select pg_temp.expect('10zc a deny directive for direct care at A', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('nurse', 7));
select pg_temp.cover_directive(3, 'inactive', array['direct-care']);
select pg_temp.expect('10zd the directive withdrawn', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('nurse', 7));
update identity.purpose_of_use_codes set active = false where code = 'healthcare-operations';
select pg_temp.expect('10ze the kill switch ends the cover', 'rp read=f rp write=f dc read=t dc write=f',
  pg_temp.cover_answers('nurse', 7));
update identity.purpose_of_use_codes set active = true where code = 'healthcare-operations';
update identity.purpose_of_use_codes set active = false where code = 'direct-care';
select pg_temp.expect('10ze2 the direct-care code switched off ends the cover too', 'rp read=f rp write=f dc read=f dc write=f',
  pg_temp.cover_answers('nurse', 7));
update identity.purpose_of_use_codes set active = true where code = 'direct-care';
select pg_temp.expect('10ze3 both codes on again: covered again', 'rp read=t rp write=t dc read=t dc write=f',
  pg_temp.cover_answers('nurse', 7));
set local role hid_identity_api_runtime;
select pg_temp.as_cover_staff('nurse', 'healthcare-operations');
select pg_temp.expect('10zf a separate records-processing request still works', 'ok pending healthcare-operations',
  pg_temp.try($q$select 'ok ' || request_status || ' ' || request_purpose
    from identity.create_access_request('HID-RPCVRA', 'write_records', 'Bring in the paper folder', 1440)$q$));
reset role;

-- 10zg-10zi. Under 18, and no date of birth: direct care as today, no
-- records processing, also with the PIN.
set local role hid_identity_api_runtime;
select pg_temp.expect('10zg the doctor''s approved request for P8 (17)', 'true',
  (pg_temp.cover_approved('doctor', 'direct-care', 8, 'write_records', 60) ~ '^[0-9a-f-]{36}$')::text);
select pg_temp.expect('10zh the doctor''s approved request for P9 (no date of birth)', 'true',
  (pg_temp.cover_approved('doctor', 'direct-care', 9, 'write_records', 60) ~ '^[0-9a-f-]{36}$')::text);
reset role;
select pg_temp.backdate();
select pg_temp.expect('10zg2 under 18: not covered', 'rp read=f rp write=f dc read=t dc write=t', pg_temp.cover_answers('doctor', 8));
select pg_temp.expect('10zh2 no date of birth: not covered', 'rp read=f rp write=f dc read=t dc write=t', pg_temp.cover_answers('doctor', 9));
set local role hid_identity_api_runtime;
select pg_temp.as_cover_patient(8);
select identity.set_my_patient_access_pin('synthetic:records-processing:p8', '100a7000-0000-4000-8000-000000000008', '8642');
select pg_temp.as_cover_staff('nurse', 'direct-care');
select pg_temp.expect('10zi the nurse opens P8 with the PIN', 'true',
  (pg_temp.try($q$select consent_grant_id::text from identity.access_patient_with_pin('HID-RPCVRB', '8642', 30)$q$)
     ~ '^[0-9a-f-]{36}$')::text);
reset role;
select pg_temp.expect('10zi2 under 18 with the PIN: not covered', 'rp read=f rp write=f dc read=t dc write=f',
  pg_temp.cover_answers('nurse', 8));

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
