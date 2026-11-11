\set ON_ERROR_STOP on
-- 0118: OCR correction observations. Rollback-only. Every person, facility
-- and document here is made up (Test Patient Ngozi Example, Learning Test
-- Clinic A/B).
--
-- Proves, as the exact runtime roles (hid_ocr_api_runtime for the record
-- command, hid_ocr_worker for the purge) with the session settings each
-- service sets:
--   - the security properties, EXECUTE grants, forced row-level security, the
--     absence of any table privilege for a runtime role, one 32-byte key and
--     no column that could hold text from a page beyond the closed-list value;
--   - staff holding ocr.validation.write record the observations of their own
--     accepted validation of the last 10 minutes; a replay adds nothing; the
--     staff key is HMAC-SHA-256 of the account id with the stored key (the
--     same account at another facility gives the same key; another account a
--     different one), never the account id or its plain digest;
--   - refused: a membership without ocr.validation.write (42501), a session
--     without a membership (42501), another facility's or another
--     membership's validation, one older than 10 minutes and a rejected one
--     (P0002), and every malformed observation list (22023, nothing written);
--   - no runtime role reads or writes the tables directly;
--   - rows older than 180 days are purged by the record command (up to 1000)
--     and by the worker's purge; the purge is the worker's only (42501 for
--     anyone else, including the OCR API role, which has no EXECUTE), and a
--     bad limit is refused.
begin;

-- Security properties.
do $$
declare
  mismatch text;
  ocr_owner oid := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
begin
  select string_agg(format('%s: definer=%s config=%s owner=%s', p.oid::regprocedure, p.prosecdef, p.proconfig,
           p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values
      ('ocr.record_correction_observations(uuid,jsonb)'::regprocedure,
       '{"search_path=pg_catalog, ocr, auth, platform, pg_temp"}'::text[]),
      ('ocr.purge_correction_observations(integer)'::regprocedure,
       '{"search_path=pg_catalog, ocr, auth, platform, pg_temp"}'::text[]))
      expected(proc, config) on p.oid = expected.proc
   where not p.prosecdef or p.proconfig is distinct from expected.config or p.proowner <> ocr_owner;
  if mismatch is not null then
    raise exception '0118 command security properties differ: %', mismatch;
  end if;
  select string_agg(format('%s to %s', p.oid::regprocedure, coalesce(grantee.rolname, 'PUBLIC')), '; ')
    into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
   where p.pronamespace = 'ocr'::regnamespace
     and p.proname in ('record_correction_observations', 'purge_correction_observations')
     and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner
     and (p.proname, coalesce(grantee.rolname, 'PUBLIC')) not in (
       ('record_correction_observations', 'hid_ocr_runtime'), ('purge_correction_observations', 'hid_ocr_worker'));
  if mismatch is not null then
    raise exception 'unexpected EXECUTE grants on the 0118 commands: %', mismatch;
  end if;
  if (select count(*) from pg_proc p, aclexplode(p.proacl) privilege
       where p.pronamespace = 'ocr'::regnamespace and privilege.privilege_type = 'EXECUTE'
         and (p.proname, privilege.grantee::regrole::text) in (
           ('record_correction_observations', 'hid_ocr_runtime'),
           ('purge_correction_observations', 'hid_ocr_worker'))) <> 2 then
    raise exception 'the 0118 EXECUTE grants are incomplete';
  end if;
  select string_agg(format('%s %s %s', role_row.rolname, privilege, table_name), '; ') into mismatch
    from pg_roles role_row
    cross join unnest(array['ocr.learning_key', 'ocr.correction_observations']) table_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege
   where role_row.rolname like 'hid\_%' and not role_row.rolsuper
     and not pg_has_role(role_row.oid, (select relowner from pg_class where oid = table_name::regclass), 'MEMBER')
     and has_table_privilege(role_row.oid, table_name, privilege);
  if mismatch is not null then
    raise exception 'a runtime role has a privilege on a 0118 table: %', mismatch;
  end if;
  if (select count(*) from pg_class c
       where c.oid in ('ocr.learning_key'::regclass, 'ocr.correction_observations'::regclass)
         and c.relrowsecurity and c.relforcerowsecurity
         and not exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                          where a.grantee <> c.relowner)
         and (select count(*) from pg_policy p where p.polrelid = c.oid) = 1) <> 2 then
    raise exception 'the 0118 tables must force row-level security, grant nothing and have one owner policy';
  end if;
  if (select count(*) from ocr.learning_key where id = 1 and octet_length(key) = 32) <> 1 then
    raise exception 'ocr.learning_key must hold exactly one 32-byte key';
  end if;
  -- Nothing can hold text from a page: the only text columns are field_class
  -- (six codes) and suggest_value (a closed-list value), both constrained.
  if exists (select 1 from information_schema.columns
              where table_schema = 'ocr' and table_name = 'correction_observations'
                and data_type in ('text', 'jsonb', 'json', 'character varying')
                and column_name not in ('suggest_value', 'field_class'))
     or exists (select 1 from information_schema.columns
                 where table_schema = 'ocr' and table_name = 'correction_observations'
                   and column_name = 'validation_key' and data_type <> 'bytea') then
    raise exception 'ocr.correction_observations has a free-text column beyond suggest_value';
  end if;
  if exists (select 1 from pg_constraint
              where conrelid = 'ocr.correction_observations'::regclass and contype = 'f'
                and confrelid <> 'identity.facilities'::regclass) then
    raise exception 'ocr.correction_observations may reference only identity.facilities';
  end if;
end $$;

-- Fixtures (triggers and references skipped while they are inserted).
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('d1180000-0000-4000-8000-000000000001', 'Learning Test Organization', 'learning-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('d1180000-0000-4000-8000-00000000000a', 'd1180000-0000-4000-8000-000000000001', 'Learning Test Clinic A',
   'LEARNING-A', 'Africa/Lagos', true, 'verified'),
  ('d1180000-0000-4000-8000-00000000000b', 'd1180000-0000-4000-8000-000000000001', 'Learning Test Clinic B',
   'LEARNING-B', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('d1181000-0000-4000-8000-000000000001', 'staff:learning-doctor', 'learning-doctor@example.invalid', 'Learning Doctor', 'active'),
  ('d1181000-0000-4000-8000-000000000002', 'staff:learning-nurse', 'learning-nurse@example.invalid', 'Learning Nurse', 'active'),
  ('d1181000-0000-4000-8000-000000000003', 'staff:learning-pharmacist', 'learning-pharmacist@example.invalid', 'Learning Pharmacist', 'active'),
  ('d1181000-0000-4000-8000-000000000004', 'workload:learning-worker', null, 'Learning Worker', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d1182000-0000-4000-8000-000000000001', 'd1181000-0000-4000-8000-000000000001', 'Learning Doctor',
   'learning-doctor@example.invalid', 'verified', 'doctor'),
  ('d1182000-0000-4000-8000-000000000002', 'd1181000-0000-4000-8000-000000000002', 'Learning Nurse',
   'learning-nurse@example.invalid', 'verified', 'nurse'),
  ('d1182000-0000-4000-8000-000000000003', 'd1181000-0000-4000-8000-000000000003', 'Learning Pharmacist',
   'learning-pharmacist@example.invalid', 'verified', 'pharmacist');
-- Memberships: doctor at A (1) and B (4); nurse at A (2); pharmacist at A (3).
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, active)
select ('d1183000-0000-4000-8000-00000000000' || m.n)::uuid, ('d1182000-0000-4000-8000-00000000000' || m.staff)::uuid,
       ('d1181000-0000-4000-8000-00000000000' || m.staff)::uuid, 'd1180000-0000-4000-8000-000000000001',
       ('d1180000-0000-4000-8000-00000000000' || m.facility)::uuid, m.role, m.role, true
  from (values (1, 1, 'a', 'doctor'), (2, 2, 'a', 'nurse'), (3, 3, 'a', 'pharmacist'), (4, 1, 'b', 'doctor'))
       m(n, staff, facility, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('d1184000-0000-4000-8000-00000000000' || m.n)::uuid, ('d1181000-0000-4000-8000-00000000000' || m.staff)::uuid,
       m.role, 'facility', ('d1183000-0000-4000-8000-00000000000' || m.n)::uuid,
       ('d1180000-0000-4000-8000-00000000000' || m.facility)::uuid, 'Synthetic learning test'
  from (values (1, 1, 'a', 'doctor'), (2, 2, 'a', 'nurse'), (3, 3, 'a', 'pharmacist'), (4, 1, 'b', 'doctor'))
       m(n, staff, facility, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d1184000-0000-4000-8000-000000000009', 'd1181000-0000-4000-8000-000000000004', 'ocr_worker', 'platform',
   'Synthetic learning worker');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('d1185000-0000-4000-8000-000000000001', 'HID-LRNTST', 'Ngozi', 'Example', 'Test Patient Ngozi Example', 'active');
-- Documents, jobs and extractions 1-6 (6 at clinic B).
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status,
  retention_class)
select ('d1186000-0000-4000-8000-00000000000' || n)::uuid, 'd1185000-0000-4000-8000-000000000001',
       case when n = 6 then 'd1180000-0000-4000-8000-00000000000b' else 'd1180000-0000-4000-8000-00000000000a' end::uuid,
       'd1181000-0000-4000-8000-000000000001',
       case when n = 6 then 'd1183000-0000-4000-8000-000000000004' else 'd1183000-0000-4000-8000-000000000001' end::uuid,
       'learning-paper-record-' || n || '.pdf', 'synthetic-bucket', 'synthetic/learning-' || n || '.pdf',
       'learning-v' || n, 'application/pdf', 2048, repeat(n::text, 64), 'uploaded', 'clinical_record'
  from generate_series(1, 6) n;
insert into ocr.jobs (id, facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id,
  status, attempt_count, completed_at)
select ('d1187000-0000-4000-8000-00000000000' || n)::uuid,
       case when n = 6 then 'd1180000-0000-4000-8000-00000000000b' else 'd1180000-0000-4000-8000-00000000000a' end::uuid,
       ('d1186000-0000-4000-8000-00000000000' || n)::uuid, 'd1185000-0000-4000-8000-000000000001',
       'learning-v' || n, repeat(n::text, 64), 'learning-fixture-000' || n, repeat('e', 64), 'learning-provider', 3,
       'd1181000-0000-4000-8000-000000000001',
       case when n = 6 then 'd1183000-0000-4000-8000-000000000004' else 'd1183000-0000-4000-8000-000000000001' end::uuid,
       'learning-fixture', case when n = 4 then 'rejected' else 'validated' end, 1, clock_timestamp()
  from generate_series(1, 6) n;
insert into ocr.extractions (id, job_id, facility_id, document_id, patient_id, extraction_version, attempt_no,
  provider, provider_model, provider_result_key, content_sha256, source_object_version_id, source_sha256_hex,
  raw_text, structured_payload, confidence, provenance)
select ('d1188000-0000-4000-8000-00000000000' || n)::uuid, ('d1187000-0000-4000-8000-00000000000' || n)::uuid,
       case when n = 6 then 'd1180000-0000-4000-8000-00000000000b' else 'd1180000-0000-4000-8000-00000000000a' end::uuid,
       ('d1186000-0000-4000-8000-00000000000' || n)::uuid, 'd1185000-0000-4000-8000-000000000001', 1, 1,
       'learning-provider', 'synthetic-model', 'learning-result-' || n, repeat('a', 64), 'learning-v' || n,
       repeat(n::text, 64), 'Fictional reading line', '{"contract":"hid-paper-reading-v2","pages":[]}'::jsonb, 0.9,
       '{"processingContract":"hid-textract-v2"}'::jsonb
  from generate_series(1, 6) n;
-- Validations: V1 the doctor's at A now; V2 the doctor's at A 20 minutes ago;
-- V3 the nurse's at A now; V4 the doctor's rejection at A now; V5 the
-- pharmacist's at A now; V6 the doctor's at B now.
insert into ocr.validations (id, job_id, facility_id, extraction_id, validation_version, validated_payload,
  corrections, reason, validated_by, validated_by_membership_id, disposition, target_domain, candidate_type,
  accepted_fields, rejected_fields, provenance, idempotency_key, request_sha256, created_at)
select ('d1189000-0000-4000-8000-00000000000' || v.n)::uuid, ('d1187000-0000-4000-8000-00000000000' || v.n)::uuid,
       ('d1180000-0000-4000-8000-00000000000' || v.facility)::uuid,
       ('d1188000-0000-4000-8000-00000000000' || v.n)::uuid, 1, '{}'::jsonb, '[]'::jsonb,
       'Reviewer checked the fictional page', ('d1181000-0000-4000-8000-00000000000' || v.staff)::uuid,
       ('d1183000-0000-4000-8000-00000000000' || v.membership)::uuid, v.disposition, 'PHARMACY', 'historical_medication_evidence',
       '{}'::jsonb, '[]'::jsonb, '{"source":"human_review"}'::jsonb, 'learning-validation-' || v.n || 'xxxxx',
       repeat('b', 64), clock_timestamp() - v.age
  from (values (1, 'a', 1, 1, 'validated', interval '0'), (2, 'a', 1, 1, 'validated', interval '20 minutes'),
               (3, 'a', 2, 2, 'validated', interval '0'), (4, 'a', 1, 1, 'rejected', interval '0'),
               (5, 'a', 3, 3, 'validated', interval '0'), (6, 'b', 1, 4, 'validated', interval '0'))
       v(n, facility, staff, membership, disposition, age);
-- An old observation (181 days) at A and one of 179 days, for the purges.
insert into ocr.correction_observations (facility_id, field_class, read_digest, suggest_value, staff_key,
  validation_key, observed_at)
select 'd1180000-0000-4000-8000-00000000000a', 'name', decode(repeat(to_hex(n), 64 / length(to_hex(n))), 'hex'),
       'Amoxicillin', decode(repeat('f', 64), 'hex'), public.digest(gen_random_uuid()::text, 'sha256'),
       clock_timestamp() - age
  from (values (1, interval '181 days'), (2, interval '181 days'), (3, interval '179 days')) old(n, age);
set local session_replication_role = origin;

create temporary table learning_cases (name text primary key, expected text, actual text) on commit drop;
grant all on learning_cases to public;
-- Runs one statement; records the SQLSTATE it raised (or 'ok').
create function pg_temp.learning_try(case_name text, statement text, expected text) returns void
language plpgsql as $$
declare
  outcome text := 'ok';
begin
  begin
    execute statement;
  exception when others then
    outcome := sqlstate;
  end;
  insert into learning_cases (name, expected, actual) values (case_name, expected, outcome);
end $$;
create function pg_temp.learning_check(case_name text, ok boolean) returns void language plpgsql as $$
begin
  insert into learning_cases (name, expected, actual) values (case_name, 'true', coalesce(ok, false)::text);
end $$;
create function pg_temp.as_staff(subject text, facility text, membership text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
    set_config('app.membership_id', membership, true), set_config('app.correlation_id', 'learning-suite-staff', true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$$;
create function pg_temp.as_worker(subject text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', '', true),
    set_config('app.membership_id', '', true), set_config('app.correlation_id', 'learning-suite-worker', true);
$$;
-- The keyed forms 0118 stores (computed as the suite's owner).
create function pg_temp.vkey(validation text) returns bytea language sql as $$
  select public.hmac(convert_to(validation, 'UTF8'), (select key from ocr.learning_key where id = 1), 'sha256')
$$;
create function pg_temp.dkey(digest_hex text) returns bytea language sql as $$
  select public.hmac(decode(digest_hex, 'hex'), (select key from ocr.learning_key where id = 1), 'sha256')
$$;
grant execute on function pg_temp.learning_try(text, text, text), pg_temp.learning_check(text, boolean),
  pg_temp.as_staff(text, text, text), pg_temp.as_worker(text) to public;


-- The OCR API records.
set local role hid_ocr_api_runtime;
select pg_temp.as_staff('staff:learning-doctor', 'd1180000-0000-4000-8000-00000000000a',
  'd1183000-0000-4000-8000-000000000001');
do $$
begin
  perform pg_temp.learning_check('doctor records two observations of V1',
    ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001',
      '[{"field":"name","readDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","suggestValue":"Amoxicillin"},
        {"field":"strength","readDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","suggestValue":null}]') = 2);
  perform pg_temp.learning_check('a replay adds nothing',
    ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001',
      '[{"field":"name","readDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","suggestValue":"Amoxicillin"}]') = 0);
  perform pg_temp.learning_check('an empty list records nothing',
    ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001', '[]') = 0);
end $$;
select pg_temp.learning_try('V2 is older than 10 minutes',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000002', '[]')$q$, 'P0002');
select pg_temp.learning_try('V4 is a rejection',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000004', '[]')$q$, 'P0002');
select pg_temp.learning_try('V3 is the nurse''s validation',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000003', '[]')$q$, 'P0002');
select pg_temp.learning_try('V6 is clinic B''s validation',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000006', '[]')$q$, 'P0002');
select pg_temp.learning_try('an unknown validation',
  $q$select ocr.record_correction_observations(gen_random_uuid(), '[]')$q$, 'P0002');
select pg_temp.learning_try('a NULL validation',
  $q$select ocr.record_correction_observations(null, '[]')$q$, '42501');
-- Malformed lists: nothing is written.
select pg_temp.learning_try('not an array',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001', '{}')$q$, '22023');
select pg_temp.learning_try('NULL list',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001', null)$q$, '22023');
select pg_temp.learning_try('an extra key',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001',
    '[{"field":"name","readDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","suggestValue":"Amoxicillin","text":"Ngozi"}]')$q$, '22023');
select pg_temp.learning_try('a missing key',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001',
    '[{"field":"name","readDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]')$q$, '22023');
select pg_temp.learning_try('an unknown field class',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001',
    '[{"field":"patientName","readDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","suggestValue":null}]')$q$, '22023');
select pg_temp.learning_try('a digest that is not 64 lower-case hex digits',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001',
    '[{"field":"name","readDigest":"CCCC","suggestValue":null}]')$q$, '22023');
select pg_temp.learning_try('a suggested value with a line break',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001',
    '[{"field":"name","readDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","suggestValue":"Amoxicillin\nNgozi"}]')$q$, '22023');
select pg_temp.learning_try('a suggested value of 121 characters',
  format($q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001',
    '[{"field":"name","readDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","suggestValue":"%s"}]')$q$,
    repeat('a', 121)), '22023');
select pg_temp.learning_try('a numeric suggested value',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001',
    '[{"field":"name","readDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","suggestValue":5}]')$q$, '22023');
select pg_temp.learning_try('201 observations',
  format($q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001', %L)$q$,
    (select jsonb_agg(jsonb_build_object('field', 'name', 'readDigest', lpad(to_hex(n), 64, '0'), 'suggestValue', null))
       from generate_series(1, 201) n)::text), '22023');
-- No direct table access.
select pg_temp.learning_try('the OCR API reads no observation',
  $q$select count(*) from ocr.correction_observations$q$, '42501');
select pg_temp.learning_try('the OCR API reads no key', $q$select key from ocr.learning_key$q$, '42501');
select pg_temp.learning_try('the OCR API cannot purge',
  $q$select ocr.purge_correction_observations(10)$q$, '42501');
-- The doctor at clinic B records V6 there (same account, same staff key).
select pg_temp.as_staff('staff:learning-doctor', 'd1180000-0000-4000-8000-00000000000b',
  'd1183000-0000-4000-8000-000000000004');
select pg_temp.learning_check('doctor at B records V6',
  ocr.record_correction_observations('d1189000-0000-4000-8000-000000000006',
    '[{"field":"name","readDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","suggestValue":"Amoxicillin"}]') = 1);
select pg_temp.learning_try('the doctor at B cannot record clinic A''s V1',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001', '[]')$q$, 'P0002');
-- The nurse records V3.
select pg_temp.as_staff('staff:learning-nurse', 'd1180000-0000-4000-8000-00000000000a',
  'd1183000-0000-4000-8000-000000000002');
select pg_temp.learning_check('nurse records V3',
  ocr.record_correction_observations('d1189000-0000-4000-8000-000000000003',
    '[{"field":"name","readDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","suggestValue":"Amoxicillin"}]') = 1);
-- The pharmacist's membership has no ocr.validation.write.
select pg_temp.as_staff('staff:learning-pharmacist', 'd1180000-0000-4000-8000-00000000000a',
  'd1183000-0000-4000-8000-000000000003');
select pg_temp.learning_try('the pharmacist lacks ocr.validation.write',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000005', '[]')$q$, '42501');
-- No membership in the session.
select pg_temp.as_staff('staff:learning-doctor', 'd1180000-0000-4000-8000-00000000000a', '');
select pg_temp.learning_try('a session without a membership',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001', '[]')$q$, '42501');
-- The worker may not record.
reset role;
set local role hid_ocr_worker;
select pg_temp.as_worker('workload:learning-worker');
select pg_temp.learning_try('the worker cannot record',
  $q$select ocr.record_correction_observations('d1189000-0000-4000-8000-000000000001', '[]')$q$, '42501');
reset role;

-- What was stored (as the owner).
do $$
declare
  learning_key bytea := (select key from ocr.learning_key where id = 1);
  doctor_key bytea := public.hmac(convert_to('d1181000-0000-4000-8000-000000000001', 'UTF8'),
    (select key from ocr.learning_key where id = 1), 'sha256');
  nurse_key bytea := public.hmac(convert_to('d1181000-0000-4000-8000-000000000002', 'UTF8'),
    (select key from ocr.learning_key where id = 1), 'sha256');
begin
  perform pg_temp.learning_check('V1 stored once per field, with the facility and values given',
    (select count(*) = 2 and count(*) filter (where field_class = 'name' and suggest_value = 'Amoxicillin') = 1
            and count(*) filter (where field_class = 'strength' and suggest_value is null) = 1
            and bool_and(facility_id = 'd1180000-0000-4000-8000-00000000000a')
       from ocr.correction_observations where validation_key = pg_temp.vkey('d1189000-0000-4000-8000-000000000001')));
  perform pg_temp.learning_check('the staff key is the HMAC of the doctor''s account, at A and at B',
    (select bool_and(staff_key = doctor_key) and count(*) = 3 from ocr.correction_observations
      where validation_key in (pg_temp.vkey('d1189000-0000-4000-8000-000000000001'),
                               pg_temp.vkey('d1189000-0000-4000-8000-000000000006'))));
  perform pg_temp.learning_check('the nurse has another staff key',
    (select staff_key = nurse_key and staff_key <> doctor_key from ocr.correction_observations
      where validation_key = pg_temp.vkey('d1189000-0000-4000-8000-000000000003')));
  perform pg_temp.learning_check('the staff key is not the account id''s plain digest',
    doctor_key <> public.digest('d1181000-0000-4000-8000-000000000001', 'sha256')
    and doctor_key <> public.digest(convert_to('d1181000-0000-4000-8000-000000000001', 'UTF8'), 'sha256'));
  perform pg_temp.learning_check('the record command purged the rows older than 180 days only',
    (select count(*) = 1 from ocr.correction_observations where observed_at < clock_timestamp() - interval '178 days'));
  perform pg_temp.learning_check('no malformed list wrote anything',
    not exists (select 1 from ocr.correction_observations
                 where read_digest = pg_temp.dkey(repeat('c', 64)) or read_digest = decode(repeat('c', 64), 'hex')));
  perform pg_temp.learning_check('the read digest is stored as its HMAC under the key, never as sent',
    exists (select 1 from ocr.correction_observations where read_digest = pg_temp.dkey(repeat('a', 64)))
    and not exists (select 1 from ocr.correction_observations where read_digest = decode(repeat('a', 64), 'hex')));
  perform pg_temp.learning_check('no row holds a validation id',
    not exists (select 1 from information_schema.columns where table_schema = 'ocr'
                 and table_name = 'correction_observations' and data_type = 'uuid' and column_name <> 'facility_id'));
  if learning_key is null then raise exception 'no key'; end if;
end $$;

-- The worker purges (add two more old rows first).
set local session_replication_role = replica;
insert into ocr.correction_observations (facility_id, field_class, read_digest, suggest_value, staff_key,
  validation_key, observed_at)
select 'd1180000-0000-4000-8000-00000000000a', 'unit', decode(lpad(to_hex(n), 64, '0'), 'hex'), null,
       decode(repeat('f', 64), 'hex'), public.digest(gen_random_uuid()::text, 'sha256'),
       clock_timestamp() - interval '200 days'
  from generate_series(1, 2) n;
set local session_replication_role = origin;
set local role hid_ocr_worker;
select pg_temp.as_worker('workload:learning-worker');
select pg_temp.learning_check('the worker purges one old row at a time',
  ocr.purge_correction_observations(1) = 1);
select pg_temp.learning_check('then the other, and nothing younger than 180 days',
  ocr.purge_correction_observations(100) = 1);
select pg_temp.learning_try('a purge limit of 0', $q$select ocr.purge_correction_observations(0)$q$, '22023');
select pg_temp.learning_try('a NULL purge limit', $q$select ocr.purge_correction_observations(null)$q$, '22023');
select pg_temp.as_worker('staff:learning-doctor');
select pg_temp.learning_try('a staff subject cannot purge',
  $q$select ocr.purge_correction_observations(10)$q$, '42501');
reset role;
select pg_temp.learning_check('the 179-day row is kept',
  (select count(*) = 1 from ocr.correction_observations where observed_at < clock_timestamp() - interval '178 days'));

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n') into failures
    from learning_cases where expected <> actual;
  if failures is not null then
    raise exception 'OCR correction observation cases failed:%', E'\n' || failures;
  end if;
  raise notice 'OCR correction observations: % cases passed', (select count(*) from learning_cases);
end $$;

rollback;
