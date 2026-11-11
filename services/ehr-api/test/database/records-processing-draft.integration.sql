\set ON_ERROR_STOP on
-- Records processing, draft publication (0112, owner decision of 2026-11-11,
-- Option B): identity.records_processing_write_grant names only the patient's
-- dedicated records-processing grant (an approved healthcare-operations
-- write request); a view_only, clinical_review or clinical_collaboration
-- share, an Access-PIN grant, an approved read-only request, a direct-care
-- approval, an expired or revoked grant, another facility, another
-- membership, an under-18 patient, break-glass, a deny directive and the kill
-- switch all fail. The "Imported paper records" encounter is found or created
-- once per patient per facility; a note added there is a draft; the patient
-- does not see the encounter until it holds a signed note. Requests,
-- approvals, shares, PINs and break-glass go through this branch's own
-- commands as the Identity API runtime; the check and the encounter are
-- called as the OCR and EHR API runtimes with the context those APIs set.
-- Each case is recorded and the suite fails at the end listing every case
-- whose outcome differs from the expected one.
-- Rollback-only. Synthetic values only; uuid prefix 112d.
set plpgsql.variable_conflict = error;
begin;

create temporary table draft_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on draft_cases to public;
grant usage on sequence draft_cases_seq_seq to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language sql as $$
  insert into draft_cases (name, expected, actual) values (case_name, expected, coalesce(actual, 'null'));
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

-- 1. What 0112 installs.
select pg_temp.expect('1a the check', 't/s/sql/{"search_path=pg_catalog, pg_temp"}/owner=t/hid_ehr_runtime EXECUTE, hid_ocr_runtime EXECUTE',
  (select format('%s/%s/%s/%s/owner=%s/%s', p.prosecdef, p.provolatile, l.lanname, p.proconfig,
            p.proowner = (select relowner from pg_class where oid = 'identity.access_requests'::regclass),
            (select string_agg(coalesce(nullif(acl.grantee::regrole::text, '-'), 'public') || ' ' || acl.privilege_type, ', '
                               order by acl.grantee::regrole::text)
               from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl where acl.grantee <> p.proowner))
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = 'identity.records_processing_write_grant(uuid,text,uuid,uuid)'::regprocedure));
select pg_temp.expect('1b the encounter function', 'f/v/plpgsql/hid_ehr_runtime EXECUTE',
  (select format('%s/%s/%s/%s', p.prosecdef, p.provolatile, l.lanname,
            (select string_agg(coalesce(nullif(acl.grantee::regrole::text, '-'), 'public') || ' ' || acl.privilege_type, ', ')
               from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl where acl.grantee <> p.proowner))
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = 'ehr.imported_paper_records_encounter(uuid)'::regprocedure));
select pg_temp.expect('1c who may call the check', 'ocr=t ehr=t identity=f lab=f pharmacy=f worker=f',
  format('ocr=%s ehr=%s identity=%s lab=%s pharmacy=%s worker=%s',
    has_function_privilege('hid_ocr_api_runtime', 'identity.records_processing_write_grant(uuid,text,uuid,uuid)', 'EXECUTE'),
    has_function_privilege('hid_ehr_api_runtime', 'identity.records_processing_write_grant(uuid,text,uuid,uuid)', 'EXECUTE'),
    has_function_privilege('hid_identity_api_runtime', 'identity.records_processing_write_grant(uuid,text,uuid,uuid)', 'EXECUTE'),
    has_function_privilege('hid_lab_api_runtime', 'identity.records_processing_write_grant(uuid,text,uuid,uuid)', 'EXECUTE'),
    has_function_privilege('hid_pharmacy_api_runtime', 'identity.records_processing_write_grant(uuid,text,uuid,uuid)', 'EXECUTE'),
    has_function_privilege('hid_ocr_worker', 'identity.records_processing_write_grant(uuid,text,uuid,uuid)', 'EXECUTE')));
select pg_temp.expect('1d who may find or create the encounter', 'ehr=t ocr=f identity=f',
  format('ehr=%s ocr=%s identity=%s',
    has_function_privilege('hid_ehr_api_runtime', 'ehr.imported_paper_records_encounter(uuid)', 'EXECUTE'),
    has_function_privilege('hid_ocr_api_runtime', 'ehr.imported_paper_records_encounter(uuid)', 'EXECUTE'),
    has_function_privilege('hid_identity_api_runtime', 'ehr.imported_paper_records_encounter(uuid)', 'EXECUTE')));
select pg_temp.expect('1e the OCR runtime reads no identity table', 'patients=f grants=f requests=f',
  format('patients=%s grants=%s requests=%s',
    has_table_privilege('hid_ocr_api_runtime', 'identity.patients', 'SELECT'),
    has_table_privilege('hid_ocr_api_runtime', 'identity.consent_grants', 'SELECT'),
    has_table_privilege('hid_ocr_api_runtime', 'identity.access_requests', 'SELECT')));
select pg_temp.expect('1f the marker', 'boolean not null false; unique (patient_id, facility_id) where imported_paper_records',
  (select format('%s %s %s; unique (patient_id, facility_id) where imported_paper_records',
            format_type(a.atttypid, a.atttypmod), case when a.attnotnull then 'not null' else 'null' end,
            pg_get_expr(d.adbin, d.adrelid))
     from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'ehr.encounters'::regclass and a.attname = 'imported_paper_records'
      and exists (select 1 from pg_index i where i.indexrelid = 'ehr.encounters_imported_paper_records_key'::regclass
                    and i.indisunique)));

-- 2. Fixtures: one organization, facilities A and B; staff at A: 1 doctor
-- (also 2, the same doctor at B), 3 nurse, 4 clinician, 5 doctor, 6
-- doctor, 7 nurse, 8 clinician, 9 doctor; patients P1 (40, login and live
-- session) and P2 (17).
insert into auth.accounts (id, subject, email, display_name, status)
select ('112d1000-0000-4000-8000-00000000000' || n)::uuid, 'staff:draft-' || n,
  'draft-' || n || '@example.invalid', 'Draft staff ' || n, 'active'
  from generate_series(1, 9) n where n <> 2;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('112d1000-0000-4000-8000-000000000020', 'synthetic:draft:p1', 'draft-p1@example.invalid', 'Draft P1', 'active');
insert into identity.organizations (id, name, slug) values
  ('112d6000-0000-4000-8000-000000000001', 'Draft Test Org', 'draft-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('112d6000-0000-4000-8000-000000000002', '112d6000-0000-4000-8000-000000000001', 'Draft Hospital A', 'DR-A',
   'Africa/Lagos', true, 'verified'),
  ('112d6000-0000-4000-8000-000000000003', '112d6000-0000-4000-8000-000000000001', 'Draft Clinic B', 'DR-B',
   'Africa/Lagos', true, 'verified');
create temporary table draft_staff (n integer primary key, account integer, role_code text, facility text);
insert into draft_staff values
  (1, 1, 'doctor', '112d6000-0000-4000-8000-000000000002'), (2, 1, 'doctor', '112d6000-0000-4000-8000-000000000003'),
  (3, 3, 'nurse', '112d6000-0000-4000-8000-000000000002'), (4, 4, 'clinician', '112d6000-0000-4000-8000-000000000002'),
  (5, 5, 'doctor', '112d6000-0000-4000-8000-000000000002'), (6, 6, 'doctor', '112d6000-0000-4000-8000-000000000002'),
  (7, 7, 'nurse', '112d6000-0000-4000-8000-000000000002'), (8, 8, 'clinician', '112d6000-0000-4000-8000-000000000002'),
  (9, 9, 'doctor', '112d6000-0000-4000-8000-000000000002');
grant select on draft_staff to public;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('112d2000-0000-4000-8000-00000000000' || account)::uuid, ('112d1000-0000-4000-8000-00000000000' || account)::uuid,
  'Draft staff ' || account, 'draft-' || account || '@example.invalid', 'verified', role_code
  from draft_staff where n <> 2;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('112d3000-0000-4000-8000-00000000000' || n)::uuid, ('112d2000-0000-4000-8000-00000000000' || account)::uuid,
  ('112d1000-0000-4000-8000-00000000000' || account)::uuid, '112d6000-0000-4000-8000-000000000001', facility::uuid,
  role_code, role_code, n <> 2, true
  from draft_staff;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('112d4000-0000-4000-8000-00000000000' || n)::uuid, ('112d1000-0000-4000-8000-00000000000' || account)::uuid,
  role_code, 'facility', ('112d3000-0000-4000-8000-00000000000' || n)::uuid, facility::uuid, 'Draft test ' || role_code
  from draft_staff;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, dob, status) values
  ('112d5000-0000-4000-8000-000000000001', '112d1000-0000-4000-8000-000000000020', 'HID-DRAFTA', 'Draft', 'Patient 1',
   'Draft Patient 1', ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '40 years')::date, 'active'),
  ('112d5000-0000-4000-8000-000000000002', null, 'HID-DRAFTB', 'Draft', 'Patient 2', 'Draft Patient 2',
   ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '17 years')::date, 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('112d7000-0000-4000-8000-000000000001', '112d1000-0000-4000-8000-000000000020', '112d7000-0000-4000-8000-000000000001',
   md5('draft-p1') || md5('draft-p1'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   '112d5000-0000-4000-8000-000000000001');

-- Contexts as Identity and the EHR and OCR APIs set them.
create function pg_temp.as_staff(n integer, purpose text) returns void language sql as $$
  select set_config('app.actor_subject', 'staff:draft-' || (select account from draft_staff where draft_staff.n = $1), true),
    set_config('app.facility_id', (select facility from draft_staff where draft_staff.n = $1), true),
    set_config('app.membership_id', '112d3000-0000-4000-8000-00000000000' || n, true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true),
    set_config('app.correlation_id', 'draft-' || n || '-' || purpose, true);
$$;
create function pg_temp.as_patient() returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:draft:p1', true),
    set_config('app.account_id', '112d1000-0000-4000-8000-000000000020', true),
    set_config('app.session_id', '112d7000-0000-4000-8000-000000000001', true),
    set_config('app.patient_id', '112d5000-0000-4000-8000-000000000001', true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '5 minutes')::text, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'draft-patient', true),
    set_config('app.purpose_of_use', 'patient-self', true);
$$;
-- A staff request as staff n; the request id is kept under the key.
create function pg_temp.request(n integer, purpose text, hid text, scope text, minutes integer, kept text) returns text
language plpgsql as $$
declare
  outcome record;
begin
  perform pg_temp.as_staff(n, purpose);
  select * into outcome from identity.create_access_request(hid, scope, 'Turn paper records into the digital record (OCR)', minutes);
  perform set_config('draft.request_' || kept, outcome.access_request_id::text, true);
  return format('%s %s %s', outcome.request_status, outcome.request_purpose, outcome.request_scope);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.approve(kept text) returns text language plpgsql as $$
begin
  perform pg_temp.as_patient();
  perform set_config('draft.grant_' || kept, (select consent_grant_id::text
    from identity.approve_access_request(current_setting('draft.request_' || kept)::uuid)), true);
  return 'approved';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- The check, as staff n asks it about patient p in its own session.
create function pg_temp.check_grant(n integer, patient integer) returns text language plpgsql as $$
declare
  answer uuid;
begin
  perform pg_temp.as_staff(n, 'healthcare-operations');
  answer := identity.records_processing_write_grant(('112d5000-0000-4000-8000-00000000000' || patient)::uuid,
    current_setting('app.actor_subject'), current_setting('app.membership_id')::uuid,
    current_setting('app.facility_id')::uuid);
  return coalesce(answer::text, 'none');
end $$;
-- The answer named against a kept grant: 'dedicated' when it is that grant.
create function pg_temp.named(answer text, kept text) returns text language sql as $$
  select case when answer = current_setting('draft.grant_' || kept, true) then 'dedicated' else answer end;
$$;
-- One change as the owner, the probe as the given runtime, then undone (the
-- block's subtransaction is rolled back, the role with it).
create function pg_temp.after_change(change text, probe_role text, probe text) returns text language plpgsql as $$
declare
  answer text;
begin
  begin
    execute change;
    execute format('set local role %I', probe_role);
    execute probe into answer;
    raise exception using errcode = 'P0001', message = coalesce(answer, 'null');
  exception when sqlstate 'P0001' then
    answer := sqlerrm;
  when others then
    answer := 'change refused ' || sqlstate;
  end;
  return answer;
end $$;
-- Every check compares a grant's starts_at with now(), the transaction's
-- start; grants written here start later, so they are moved an hour back,
-- with their end, as the owner (as records-processing.integration.sql does).
create function pg_temp.backdate() returns void language sql as $$
  update identity.consent_grants set starts_at = starts_at - interval '1 hour', expires_at = expires_at - interval '1 hour'
   where patient_id::text like '112d5000-%' and starts_at >= now();
$$;
grant execute on function pg_temp.as_staff(integer, text), pg_temp.as_patient(),
  pg_temp.request(integer, text, text, text, integer, text), pg_temp.approve(text),
  pg_temp.check_grant(integer, integer), pg_temp.named(text, text) to public;

-- 3. The grants, through Identity's commands.
set local role hid_identity_api_runtime;
-- The dedicated grant: the doctor's records-processing write request, approved.
select pg_temp.expect('3a the doctor asks to write records for records processing', 'pending healthcare-operations write_records',
  pg_temp.request(1, 'healthcare-operations', 'HID-DRAFTA', 'write_records', 1440, 'dedicated'));
select pg_temp.expect('3b P1 approves it', 'approved', pg_temp.approve('dedicated'));
-- An approved read-only records-processing request (nurse 7).
select pg_temp.expect('3c a read-only records-processing request', 'pending healthcare-operations read_records',
  pg_temp.request(7, 'healthcare-operations', 'HID-DRAFTA', 'read_records', 1440, 'readonly'));
select pg_temp.expect('3d approved', 'approved', pg_temp.approve('readonly'));
-- An approved direct-care write request (clinician 8: the cover's approval way).
select pg_temp.expect('3e a direct-care write request', 'pending direct-care write_records',
  pg_temp.request(8, 'direct-care', 'HID-DRAFTA', 'write_records', 60, 'direct'));
select pg_temp.expect('3f approved', 'approved', pg_temp.approve('direct'));
-- Shares at three levels (nurse 3 view_only, clinician 4 clinical_review, doctor 5 clinical_collaboration).
select pg_temp.as_patient();
select pg_temp.expect('3g shares', 'read_records read_records write_records',
  (select string_agg(pg_temp.try(format($q$select scope from identity.create_my_consent_share('synthetic:draft:p1',
     '112d7000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-00000000000%s', %L, '24h', 'draft-share-key-000%s',
     repeat('%s', 64))$q$, n, level, n, n)), ' ' order by n)
     from (values (3, 'view_only'), (4, 'clinical_review'), (5, 'clinical_collaboration')) share_row(n, level)));
-- The Access PIN (doctor 6, direct care).
select identity.set_my_patient_access_pin('synthetic:draft:p1', '112d7000-0000-4000-8000-000000000001', '2468');
select pg_temp.as_staff(6, 'direct-care');
select pg_temp.expect('3h the doctor opens P1 with the PIN', 'direct-care read_records',
  pg_temp.try($q$select 'direct-care read_records' from identity.access_patient_with_pin('HID-DRAFTA', '2468', 30)
    where consent_grant_id is not null$q$));
-- Break-glass (doctor 9).
select pg_temp.as_staff(9, 'emergency');
select pg_temp.expect('3i break-glass', 'active',
  pg_temp.try($q$select grant_status from identity.activate_break_glass('HID-DRAFTA',
    'Unconscious patient in the emergency room', 30)$q$));
-- A minor: the request itself is refused (0104 D3), so no dedicated grant can exist.
select pg_temp.expect('3j a records-processing request for a 17-year-old', '42501 RECORDS_PROCESSING_MINOR',
  pg_temp.request(1, 'healthcare-operations', 'HID-DRAFTB', 'write_records', 1440, 'minor'));
reset role;
select pg_temp.backdate();
select pg_temp.expect('3k the dedicated grant', 'healthcare-operations write_records hid pin=f',
  (select format('%s %s %s pin=%s', purpose_of_use, scope, source_system, authorization_method is not null)
     from identity.consent_grants where id::text = current_setting('draft.grant_dedicated')));

-- 4. Who the check names, as the OCR API runtime and as the EHR API runtime.
set local role hid_ocr_api_runtime;
select pg_temp.expect('4a OCR runtime: the dedicated grant passes', 'dedicated',
  pg_temp.named(pg_temp.check_grant(1, 1), 'dedicated'));
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.expect('4b EHR runtime: the dedicated grant passes', 'dedicated',
  pg_temp.named(pg_temp.check_grant(1, 1), 'dedicated'));
select pg_temp.expect('4c a view_only share fails', 'none', pg_temp.check_grant(3, 1));
select pg_temp.expect('4d a clinical_review share fails', 'none', pg_temp.check_grant(4, 1));
select pg_temp.expect('4e a clinical_collaboration (write) share fails', 'none', pg_temp.check_grant(5, 1));
select pg_temp.expect('4f an Access-PIN grant fails', 'none', pg_temp.check_grant(6, 1));
select pg_temp.expect('4g an approved read-only records-processing request fails', 'none', pg_temp.check_grant(7, 1));
select pg_temp.expect('4h an approved direct-care write request (the cover) fails', 'none', pg_temp.check_grant(8, 1));
select pg_temp.expect('4i break-glass fails', 'none', pg_temp.check_grant(9, 1));
select pg_temp.expect('4j another facility (the same doctor at B) fails', 'none', pg_temp.check_grant(2, 1));
select pg_temp.expect('4k a 17-year-old fails', 'none', pg_temp.check_grant(1, 2));
-- The same grant, asked for another membership, another facility or another
-- subject than the session's: refused (the session's own context only).
select pg_temp.as_staff(1, 'healthcare-operations');
select pg_temp.expect('4l another membership than the session''s', 'none',
  coalesce(identity.records_processing_write_grant('112d5000-0000-4000-8000-000000000001', 'staff:draft-1',
    '112d3000-0000-4000-8000-000000000002', '112d6000-0000-4000-8000-000000000002')::text, 'none'));
select pg_temp.expect('4m another facility than the session''s', 'none',
  coalesce(identity.records_processing_write_grant('112d5000-0000-4000-8000-000000000001', 'staff:draft-1',
    '112d3000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000003')::text, 'none'));
select pg_temp.expect('4n another subject than the session''s', 'none',
  coalesce(identity.records_processing_write_grant('112d5000-0000-4000-8000-000000000001', 'staff:draft-6',
    '112d3000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002')::text, 'none'));
select pg_temp.expect('4o nulls fail closed', 'none none',
  coalesce(identity.records_processing_write_grant(null, 'staff:draft-1', '112d3000-0000-4000-8000-000000000001',
    '112d6000-0000-4000-8000-000000000002')::text, 'none') || ' '
  || coalesce(identity.records_processing_write_grant('112d5000-0000-4000-8000-000000000001', null,
    '112d3000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002')::text, 'none'));
-- A membership of another facility asked from the doctor's facility A session.
select pg_temp.as_staff(2, 'healthcare-operations');
select set_config('app.facility_id', '112d6000-0000-4000-8000-000000000002', true);
select pg_temp.expect('4p the doctor''s membership at B named with facility A', 'none',
  coalesce(identity.records_processing_write_grant('112d5000-0000-4000-8000-000000000001', 'staff:draft-1',
    '112d3000-0000-4000-8000-000000000002', '112d6000-0000-4000-8000-000000000002')::text, 'none'));
reset role;

-- 5. One condition at a time, as the owner, the check then asked as the EHR
-- runtime (each change undone).
create function pg_temp.changed(change text) returns text language sql as $$
  select pg_temp.named(pg_temp.after_change(change, 'hid_ehr_api_runtime', 'select pg_temp.check_grant(1, 1)'),
    'dedicated');
$$;
select pg_temp.expect('5a unchanged (the probe itself)', 'dedicated', pg_temp.changed('select 1'));
select pg_temp.expect('5b expired', 'none', pg_temp.changed(format(
  $c$update identity.consent_grants set expires_at = now() - interval '1 second' where id = %L$c$,
  current_setting('draft.grant_dedicated'))));
select pg_temp.expect('5c not started yet', 'none', pg_temp.changed(format(
  $c$update identity.consent_grants set starts_at = now() + interval '1 minute' where id = %L$c$,
  current_setting('draft.grant_dedicated'))));
select pg_temp.expect('5d longer than 24 hours', 'none', pg_temp.changed(format(
  $c$update identity.consent_grants set expires_at = starts_at + interval '24 hours 1 second' where id = %L$c$,
  current_setting('draft.grant_dedicated'))));
select pg_temp.expect('5e revoked', 'none', pg_temp.changed(format(
  $c$update identity.consent_grants set status = 'revoked', revoked_at = now(),
     revoked_reason = 'Synthetic revocation' where id = %L$c$, current_setting('draft.grant_dedicated'))));
select pg_temp.expect('5f held by the cutover', 'none', pg_temp.changed(format(
  $c$update identity.consent_grants set migration_hold_reason = 'legacy_grant_review' where id = %L$c$,
  current_setting('draft.grant_dedicated'))));
select pg_temp.expect('5g imported (source_system not hid)', 'none', pg_temp.changed(format(
  $c$update identity.consent_grants set source_system = 'legacy_identity' where id = %L$c$,
  current_setting('draft.grant_dedicated'))));
select pg_temp.expect('5k not granted by the patient', 'none', pg_temp.changed(format(
  $c$update identity.consent_grants set granted_by_patient_id = null where id = %L$c$,
  current_setting('draft.grant_dedicated'))));
select pg_temp.expect('5l no request (a share''s shape)', 'none', pg_temp.changed(format(
  $c$update identity.consent_grants set request_id = null where id = %L$c$, current_setting('draft.grant_dedicated'))));
select pg_temp.expect('5m the request not approved by the patient', 'none', pg_temp.changed(format(
  $c$update identity.access_requests set approved_by_patient_id = null where id = %L$c$,
  current_setting('draft.request_dedicated'))));
select pg_temp.expect('5o under 18 today in Lagos', 'none', pg_temp.changed(
  $c$update identity.patients set dob = ((now() at time zone 'Africa/Lagos')::date - interval '18 years' + interval '1 day')::date
     where id = '112d5000-0000-4000-8000-000000000001'$c$));
select pg_temp.expect('5p no date of birth', 'none', pg_temp.changed(
  $c$update identity.patients set dob = null where id = '112d5000-0000-4000-8000-000000000001'$c$));
select pg_temp.expect('5q 18 today in Lagos passes', 'dedicated', pg_temp.changed(
  $c$update identity.patients set dob = ((now() at time zone 'Africa/Lagos')::date - interval '18 years')::date
     where id = '112d5000-0000-4000-8000-000000000001'$c$));
select pg_temp.expect('5r the kill switch (records processing inactive)', 'none', pg_temp.changed(
  $c$update identity.purpose_of_use_codes set active = false where code = 'healthcare-operations'$c$));
select pg_temp.expect('5s direct care inactive', 'none', pg_temp.changed(
  $c$update identity.purpose_of_use_codes set active = false where code = 'direct-care'$c$));
select pg_temp.expect('5t the membership loses ocr.job.write (role revoked)', 'none', pg_temp.changed(
  $c$update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = account_id, revocation_reason = 'Synthetic revocation'
     where id = '112d4000-0000-4000-8000-000000000001'$c$));
select pg_temp.expect('5u the membership ends', 'none', pg_temp.changed(
  $c$update identity.staff_facility_memberships set active = false where id = '112d3000-0000-4000-8000-000000000001'$c$));
select pg_temp.expect('5v the account is disabled', 'none', pg_temp.changed(
  $c$update auth.accounts set status = 'disabled' where id = '112d1000-0000-4000-8000-000000000001'$c$));
-- Deny directives of P1 (0012's reading): for records processing at A, for
-- direct care, for every purpose, for the staff member; one for reading only
-- or for emergency, or for facility B, does not block.
create function pg_temp.deny(purposes text, actions text, grantee_type text, grantee_id text, facility text) returns text
language sql as $$
  select pg_temp.changed(format($c$insert into identity.consent_directives (id, patient_id, current_version)
      values ('112d9100-0000-4000-8000-000000000001', '112d5000-0000-4000-8000-000000000001', 1);
    insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
      grantee_type, grantee_id, facility_id, purposes, actions, starts_at, source_reference, reason, content_sha256)
    values ('112d9100-0000-4000-8000-000000000002', '112d9100-0000-4000-8000-000000000001',
      '112d5000-0000-4000-8000-000000000001', 1, 'active', 'deny', %L, %L::uuid, %L::uuid, %L::text[], %L::text[],
      now() - interval '1 hour', 'draft-test', 'No paper records here', repeat('e', 64))$c$,
    grantee_type, grantee_id, facility, purposes, actions));
$$;
select pg_temp.expect('5w deny records processing at A', 'none',
  pg_temp.deny('{healthcare-operations}', '{}', 'facility', '112d6000-0000-4000-8000-000000000002', null));
select pg_temp.expect('5x deny direct care for all', 'none', pg_temp.deny('{direct-care}', '{}', 'all', null, null));
select pg_temp.expect('5y deny every purpose for the doctor', 'none',
  pg_temp.deny('{}', '{}', 'staff', '112d2000-0000-4000-8000-000000000001', null));
select pg_temp.expect('5z deny writing for the organization', 'none',
  pg_temp.deny('{}', '{write_records}', 'organization', '112d6000-0000-4000-8000-000000000001', null));
select pg_temp.expect('5z2 a deny for reading only does not block a write', 'dedicated',
  pg_temp.deny('{}', '{read_records}', 'all', null, null));
select pg_temp.expect('5z3 a deny for emergency only does not block', 'dedicated',
  pg_temp.deny('{emergency}', '{}', 'all', null, null));
select pg_temp.expect('5z4 a deny at facility B does not block A', 'dedicated',
  pg_temp.deny('{}', '{}', 'all', null, '112d6000-0000-4000-8000-000000000003'));

-- 6. The "Imported paper records" encounter, as the EHR API runtime.
create function pg_temp.encounter(n integer, purpose text) returns text language plpgsql as $$
begin
  perform pg_temp.as_staff(n, purpose);
  return pg_temp.try($q$select ehr.imported_paper_records_encounter('112d5000-0000-4000-8000-000000000001')::text$q$);
end $$;
grant execute on function pg_temp.encounter(integer, text) to public;
set local role hid_ehr_api_runtime;
select set_config('draft.encounter', pg_temp.encounter(1, 'healthcare-operations'), true);
select pg_temp.expect('6a the dedicated grant creates it', 'true',
  (current_setting('draft.encounter') ~ '^[0-9a-f-]{36}$')::text);
select pg_temp.expect('6b asked again, the same encounter', 'same',
  case when pg_temp.encounter(1, 'healthcare-operations') = current_setting('draft.encounter') then 'same'
       else pg_temp.encounter(1, 'healthcare-operations') end);
select pg_temp.expect('6c a view_only share under records processing is refused', '42501 RECORDS_PROCESSING_GRANT_REQUIRED',
  pg_temp.encounter(3, 'healthcare-operations'));
select pg_temp.expect('6d a view_only share under direct care is refused', '42501 RECORDS_PROCESSING_GRANT_REQUIRED',
  pg_temp.encounter(3, 'direct-care'));
select pg_temp.expect('6e a clinical_collaboration share under records processing is refused',
  '42501 RECORDS_PROCESSING_GRANT_REQUIRED', pg_temp.encounter(5, 'healthcare-operations'));
select pg_temp.expect('6f the Access PIN under records processing is refused', '42501 RECORDS_PROCESSING_GRANT_REQUIRED',
  pg_temp.encounter(6, 'healthcare-operations'));
select pg_temp.expect('6g break-glass under emergency is refused', '42501 RECORDS_PROCESSING_GRANT_REQUIRED',
  pg_temp.encounter(9, 'emergency'));
select pg_temp.expect('6h the doctor at B is refused', '42501 RECORDS_PROCESSING_GRANT_REQUIRED',
  pg_temp.encounter(2, 'healthcare-operations'));
select pg_temp.expect('6i a direct-care writer (no visit named) finds the same encounter', 'same',
  case when pg_temp.encounter(8, 'direct-care') = current_setting('draft.encounter') then 'same'
       else pg_temp.encounter(8, 'direct-care') end);
select pg_temp.as_staff(1, 'healthcare-operations');
select pg_temp.expect('6j its shape', 'other completed started=ended Imported paper records (Migrate) number=null flag=t',
  (select format('%s %s started=%s %s number=%s flag=%s', encounter_type, status,
            case when started_at = ended_at then 'ended' else 'different' end, chief_complaint,
            coalesce(encounter_number, 'null'), imported_paper_records)
     from ehr.encounters where id::text = current_setting('draft.encounter')));
select pg_temp.expect('6k one per patient per facility', '1',
  (select count(*)::text from ehr.encounters
    where patient_id = '112d5000-0000-4000-8000-000000000001' and imported_paper_records));
reset role;
-- The unique index and the shape, as the owner (as a concurrent second insert
-- would meet them: ON CONFLICT turns the first into "found").
select pg_temp.as_staff(1, 'healthcare-operations');
select pg_temp.expect('6l a second imported encounter for P1 at A', '23505',
  split_part(pg_temp.try($q$insert into ehr.encounters (patient_id, facility_id, created_by, created_by_membership_id,
      encounter_type, status, started_at, ended_at, chief_complaint, imported_paper_records)
    values ('112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001', 'other', 'completed', now(), now(),
      'Imported paper records (Migrate)', true) returning 'ok'$q$), ' ', 1));
select pg_temp.expect('6m the same with ON CONFLICT does nothing', 'ok',
  pg_temp.try($q$insert into ehr.encounters (patient_id, facility_id, created_by, created_by_membership_id,
      encounter_type, status, started_at, ended_at, chief_complaint, imported_paper_records)
    values ('112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001', 'other', 'completed', now(), now(),
      'Imported paper records (Migrate)', true)
    on conflict (patient_id, facility_id) where imported_paper_records do nothing returning 'inserted'$q$));
-- The shape check under direct care (under healthcare-operations the D4
-- guard, below, refuses this patient first: no dedicated grant for P2).
select pg_temp.as_staff(1, 'direct-care');
select pg_temp.expect('6n an imported encounter in progress', '23514',
  split_part(pg_temp.try($q$insert into ehr.encounters (patient_id, facility_id, created_by, created_by_membership_id,
      encounter_type, status, started_at, chief_complaint, imported_paper_records)
    values ('112d5000-0000-4000-8000-000000000002', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001', 'other', 'in_progress', now(),
      'Imported paper records (Migrate)', true) returning 'ok'$q$), ' ', 1));
select set_config('app.change_reason', 'Synthetic flag change', true);
select pg_temp.expect('6o the flag cannot be cleared', '55000 IMPORTED_PAPER_RECORDS_FIXED',
  pg_temp.try(format($q$update ehr.encounters set imported_paper_records = false where id = %L returning 'ok'$q$,
    current_setting('draft.encounter'))));

-- 7. The draft note, as the EHR API inserts it under the dedicated grant.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(1, 'healthcare-operations');
with inserted as (
  insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    note_type, title, status)
  values (current_setting('draft.encounter')::uuid, '112d5000-0000-4000-8000-000000000001',
    '112d6000-0000-4000-8000-000000000002', '112d1000-0000-4000-8000-000000000001',
    '112d3000-0000-4000-8000-000000000001', 'From a paper record (Migrate)',
    'From a paper record (Migrate): Clinic card', 'draft') returning id)
select set_config('draft.note', (select id::text from inserted), true);
insert into ehr.clinical_note_revisions (clinical_note_id, patient_id, facility_id, revision_no, content,
  change_reason, supersedes_revision_no, created_by, created_by_membership_id)
values (current_setting('draft.note')::uuid, '112d5000-0000-4000-8000-000000000001',
  '112d6000-0000-4000-8000-000000000002', 1, 'Synthetic paper record text', 'OCR import from human-validated source evidence',
  null, '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001');
select pg_temp.expect('7a the note is a draft in the imported encounter', 'draft imported=t',
  (select format('%s imported=%s', note_row.status, encounter_row.imported_paper_records)
     from ehr.clinical_notes note_row join ehr.encounters encounter_row on encounter_row.id = note_row.encounter_id
    where note_row.id::text = current_setting('draft.note')));
select pg_temp.expect('7b staff (records processing) see the encounter, labelled', '1 imported',
  (select count(*) || ' imported' from ehr.encounters
    where id::text = current_setting('draft.encounter') and imported_paper_records));

-- 7c-7k D4: under healthcare-operations the database itself allows only the
-- draft path, whatever the API does (security review of 0112).
select pg_temp.as_staff(1, 'healthcare-operations');
select set_config('app.change_reason', 'Synthetic records-processing write', true);
select pg_temp.expect('7c the draft cannot be signed under records processing', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.try(format($q$update ehr.clinical_notes set status = 'signed', signed_at = clock_timestamp(),
      signed_by = '112d1000-0000-4000-8000-000000000001' where id = %L returning status$q$, current_setting('draft.note'))));
select pg_temp.expect('7d nor its title changed', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.try(format($q$update ehr.clinical_notes set title = 'Changed' where id = %L returning 'ok'$q$,
    current_setting('draft.note'))));
select pg_temp.expect('7e a note inserted already signed', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.try(format($q$insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by,
      created_by_membership_id, note_type, title, status, signed_at, signed_by)
    values (%L, '112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001', 'progress', 'Signed',
      'signed', clock_timestamp(), '112d1000-0000-4000-8000-000000000001') returning 'ok'$q$,
    current_setting('draft.encounter'))));
select pg_temp.expect('7f an ordinary encounter', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.try($q$insert into ehr.encounters (patient_id, facility_id, created_by, created_by_membership_id,
      encounter_type, status, started_at, chief_complaint)
    values ('112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001', 'ambulatory', 'in_progress',
      now(), 'Synthetic visit') returning 'ok'$q$));
select pg_temp.expect('7g the imported encounter cannot be changed', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.try(format($q$update ehr.encounters set chief_complaint = 'Changed' where id = %L returning 'ok'$q$,
    current_setting('draft.encounter'))));
select pg_temp.expect('7h a second revision of the draft', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.try(format($q$insert into ehr.clinical_note_revisions (clinical_note_id, patient_id, facility_id,
      revision_no, content, change_reason, supersedes_revision_no, created_by, created_by_membership_id)
    values (%L, '112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002', 2, 'More text',
      'Synthetic change', 1, '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001')
    returning 'ok'$q$, current_setting('draft.note'))));
select pg_temp.expect('7l a draft inserted already naming a signer', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.try(format($q$insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by,
      created_by_membership_id, note_type, title, status, signed_by)
    values (%L, '112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001', 'From a paper record (Migrate)',
      'From a paper record (Migrate): Draft', 'draft', '112d1000-0000-4000-8000-000000000008') returning 'ok'$q$,
    current_setting('draft.encounter'))));
select pg_temp.expect('7m a draft at a later revision', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.try(format($q$insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by,
      created_by_membership_id, note_type, title, status, current_revision_no)
    values (%L, '112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001', 'From a paper record (Migrate)',
      'From a paper record (Migrate): Draft', 'draft', 9) returning 'ok'$q$, current_setting('draft.encounter'))));
select pg_temp.expect('7n a draft of another note type or title', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.try(format($q$insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by,
      created_by_membership_id, note_type, title, status)
    values (%L, '112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001', 'progress', 'Progress note',
      'draft') returning 'ok'$q$, current_setting('draft.encounter'))));
reset role;
-- A healthcare-operations write grant that D1 does not name (imported from
-- legacy identity) still passes row-level security; the guard refuses it.
create function pg_temp.draft_probe() returns text language sql as $$
  select pg_temp.as_staff(1, 'healthcare-operations');
  select pg_temp.try(format($q$insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by,
      created_by_membership_id, note_type, title, status)
    values (%L, '112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000001', '112d3000-0000-4000-8000-000000000001', 'From a paper record (Migrate)',
      'From a paper record (Migrate): Another draft', 'draft') returning 'ok'$q$, current_setting('draft.encounter')));
$$;
grant execute on function pg_temp.draft_probe() to public;
select pg_temp.expect('7i the probe: a second draft under the dedicated grant', 'ok',
  pg_temp.after_change('select 1', 'hid_ehr_api_runtime', 'select pg_temp.draft_probe()'));
select pg_temp.expect('7j the same under an imported (legacy) grant', '42501 RECORDS_PROCESSING_DRAFT_ONLY',
  pg_temp.after_change(format($c$update identity.consent_grants set source_system = 'legacy_identity' where id = %L$c$,
    current_setting('draft.grant_dedicated')), 'hid_ehr_api_runtime', 'select pg_temp.draft_probe()'));
select pg_temp.expect('7k direct care is untouched by the guard: a direct-care writer adds a note to a visit', 'ok',
  pg_temp.after_change('select 1', 'hid_ehr_api_runtime', $p$select pg_temp.as_staff(8, 'direct-care');
    select pg_temp.try(format($q$insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by,
      created_by_membership_id, note_type, title, status)
    values (%L, '112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
      '112d1000-0000-4000-8000-000000000008', '112d3000-0000-4000-8000-000000000008', 'progress', 'Visit note',
      'draft') returning 'ok'$q$, current_setting('draft.encounter')))$p$));
reset role;

-- 8. Patient-facing: the patient does not see the empty entry (a draft only),
-- then sees it once a clinician signs the note.
set local role hid_ehr_api_runtime;
select pg_temp.as_patient();
select pg_temp.expect('8a the patient: no imported encounter, no draft note', 'encounters=0 notes=0',
  format('encounters=%s notes=%s',
    (select count(*) from ehr.encounters where patient_id = '112d5000-0000-4000-8000-000000000001'),
    (select count(*) from ehr.clinical_notes where patient_id = '112d5000-0000-4000-8000-000000000001')));
-- Signing: the direct-care writer (clinician 8), as the EHR API's PATCH route does.
select pg_temp.as_staff(8, 'direct-care');
select set_config('app.change_reason', 'Clinician signs the imported note', true);
select pg_temp.expect('8b the clinician signs the draft (direct care)', 'signed',
  pg_temp.try(format($q$update ehr.clinical_notes set status = 'signed', signed_at = clock_timestamp(),
      signed_by = '112d1000-0000-4000-8000-000000000008' where id = %L returning status$q$, current_setting('draft.note'))));
select pg_temp.as_patient();
select pg_temp.expect('8c the patient now sees the encounter and the signed note', 'encounters=1 notes=1',
  format('encounters=%s notes=%s',
    (select count(*) from ehr.encounters where id::text = current_setting('draft.encounter')),
    (select count(*) from ehr.clinical_notes where id::text = current_setting('draft.note'))));
-- An ordinary completed encounter is shown as before.
reset role;
select pg_temp.as_staff(8, 'direct-care');
set local role hid_ehr_api_runtime;
with inserted as (
  insert into ehr.encounters (patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
    started_at, ended_at)
  values ('112d5000-0000-4000-8000-000000000001', '112d6000-0000-4000-8000-000000000002',
    '112d1000-0000-4000-8000-000000000008', '112d3000-0000-4000-8000-000000000008', 'ambulatory', 'completed',
    now() - interval '1 hour', now()) returning id)
select set_config('draft.ordinary', (select id::text from inserted), true);
select pg_temp.as_patient();
select pg_temp.expect('8d an ordinary completed visit is still shown', '2',
  (select count(*)::text from ehr.encounters where patient_id = '112d5000-0000-4000-8000-000000000001'));
reset role;

-- The outcome.
do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected [%s], got [%s]', name, expected, actual), E'\n' order by seq) into failures
    from draft_cases where actual is distinct from expected;
  if failures is not null then
    raise exception E'records-processing-draft cases failed:\n%', failures;
  end if;
  raise notice 'records-processing-draft: % cases passed', (select count(*) from draft_cases);
end
$$;

rollback;
