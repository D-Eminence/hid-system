\set ON_ERROR_STOP on
-- Photos and files on the records patients add themselves (0117; health
-- main BACKEND-NEEDS.md section 1). Rollback-only; synthetic values only;
-- uuid prefix e7. The patient commands run as hid_ehr_api_runtime, as ehr-api
-- runs them; the scanner commands as hid_document_scanner (the scanner pool's
-- role). Run it on a database whose migrations were applied by an owner that
-- is neither a superuser nor BYPASSRLS (production's shape) as well as on the
-- acceptance shape: section 9 says which it ran under.
--   1. Shape and privileges: forced RLS with two policies on each of the three
--      tables, the effective view a security invoker, the one-way, no-delete
--      and no-truncate triggers; SELECT only for the EHR runtime and the
--      schema test runtime, no write privilege for any runtime; the patient
--      commands executable by exactly those two roles, the scanner commands
--      by hid_document_scanner alone, the guard by nobody; every command
--      SECURITY DEFINER on pg_catalog, pg_temp; the scanner role reads no
--      table and runs no patient command, the EHR runtime no scanner command.
--   2. The patient opens, uploads and confirms a file and reads it back;
--      another patient's file is refused (their record, their file, their
--      read); a revoked session and a missing correlation id are refused.
--   3. Replays: before the confirm the same file (replayed), after it
--      already_uploaded with its status; a key reused for another file or
--      another record key_reused; nothing written by any of them.
--   4. Limits: the 6th file on a record is refused (entry_full) and not
--      counted, though none of the 5 is confirmed (every opened file counts); 10 a Lagos day across records, a removed record's files
--      counted, yesterday's not; the 11th refused (daily_limit, with the
--      seconds to the next Lagos midnight), audited as denied, nothing
--      written; a replayed key at the limit is never refused.
--   5. Confirm: only the uploader, only the declared size and SHA-256
--      (mismatch writes nothing), once (already_uploaded); the guard refuses
--      any other change even to the owner; DELETE and TRUNCATE refused.
--   6. A removed record: its files hidden from the patient and the doctor,
--      kept; no confirm and no new link on it.
--   7. The doctor's read: a confirmed file at the facility with the grant,
--      never an unconfirmed one; nothing at another facility, for another
--      purpose or after the grant ends; the scan events and the effective
--      view the same.
--   8. The scanner: resolve, list and append by key and id, with 0105's and
--      0009's refusals word for word; available once clean; the patient's
--      extraction only of an available file; the scanner context alone.
--   9. No row locks on FORCE-RLS tables without an UPDATE policy: every
--      table a new command locks has the owner's FOR ALL policy, and the
--      locking commands ran above under this database's owner (which the
--      suite names); the runtime cannot lock a file row.
--  10. Chat evidence: patient_entry_document is a source kind of both chunk
--      tables; ehr-api's cleanup statement (withdrawnPatientEntryDocumentChunksSql)
--      deletes a removed record's file vectors under the patient's
--      row-level security and keeps an available file's.
--  11. Audit: action names, the patient actor, numbers only (never a name).
set plpgsql.variable_conflict = error;
begin;
set constraints all deferred;

-- 1. Shape and privileges.
do $$
declare
  mismatch text;
  role_name text;
  proc_name text;
  patient_commands text[] := array[
    'ehr.create_my_patient_entry_document_intent(uuid,text,text,bigint,text,text,text,text,text)',
    'ehr.complete_my_patient_entry_document(uuid,uuid,text,bigint,text)'];
  scanner_commands text[] := array[
    'ehr.resolve_patient_entry_document_scan_target(text,text,text,text)',
    'ehr.list_patient_entry_documents_awaiting_scan(integer,integer,text)',
    'ehr.append_patient_entry_document_scan_event(uuid,text,text,text,text,text,text,text,text,text)'];
begin
  select string_agg(relation.oid::regclass::text, ', ') into mismatch
    from pg_class relation
   where relation.oid in ('ehr.patient_entry_documents'::regclass, 'ehr.patient_entry_document_scan_events'::regclass,
                          'ehr.patient_entry_document_extractions'::regclass)
     and not (relation.relrowsecurity and relation.relforcerowsecurity);
  if mismatch is not null then raise exception 'Not under forced row-level security: %', mismatch; end if;
  select string_agg(tablename || '.' || policyname || ':' || cmd, ', ' order by tablename, policyname) into mismatch
    from pg_policies where schemaname = 'ehr' and tablename like 'patient_entry_document%';
  if mismatch is distinct from 'patient_entry_document_extractions.patient_entry_document_extractions_owner:ALL, '
       || 'patient_entry_document_extractions.patient_entry_document_extractions_self:ALL, '
       || 'patient_entry_document_scan_events.patient_entry_document_scan_events_owner:ALL, '
       || 'patient_entry_document_scan_events.patient_entry_document_scan_events_read:SELECT, '
       || 'patient_entry_documents.patient_entry_documents_owner:ALL, '
       || 'patient_entry_documents.patient_entry_documents_read:SELECT' then
    raise exception 'Policies: %', mismatch;
  end if;
  if not exists (select 1 from pg_class where oid = 'ehr.patient_entry_documents_effective'::regclass
                  and reloptions @> array['security_invoker=true', 'security_barrier=true']) then
    raise exception 'The effective view is not a security invoker';
  end if;
  select string_agg(tgrelid::regclass || ':' || tgname, ', ' order by tgrelid::regclass::text, tgname) into mismatch
    from pg_trigger where tgrelid in ('ehr.patient_entry_documents'::regclass,
      'ehr.patient_entry_document_scan_events'::regclass) and not tgisinternal and tgenabled = 'O';
  if mismatch is distinct from 'ehr.patient_entry_document_scan_events:patient_entry_document_scan_events_no_change, '
       || 'ehr.patient_entry_document_scan_events:patient_entry_document_scan_events_no_truncate, '
       || 'ehr.patient_entry_documents:patient_entry_documents_no_delete, '
       || 'ehr.patient_entry_documents:patient_entry_documents_no_truncate, '
       || 'ehr.patient_entry_documents:patient_entry_documents_one_way' then
    raise exception 'Triggers: %', mismatch;
  end if;
  select string_agg(relation.oid::regclass || '>' || coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public')
      || ':' || privilege.privilege_type, ', ' order by relation.oid::regclass::text, privilege.grantee::regrole::text,
      privilege.privilege_type) into mismatch
    from pg_class relation, aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
   where relation.oid in ('ehr.patient_entry_documents'::regclass, 'ehr.patient_entry_document_scan_events'::regclass,
                          'ehr.patient_entry_documents_effective'::regclass,
                          'ehr.patient_entry_document_extractions'::regclass)
     and privilege.grantee <> relation.relowner;
  if mismatch is distinct from
       'ehr.patient_entry_document_extractions>hid_ehr_runtime:INSERT, '
       || 'ehr.patient_entry_document_extractions>hid_ehr_runtime:SELECT, '
       || 'ehr.patient_entry_document_extractions>hid_ehr_runtime:UPDATE, '
       || 'ehr.patient_entry_document_scan_events>hid_ehr_runtime:SELECT, '
       || 'ehr.patient_entry_document_scan_events>hid_schema_test_runtime:SELECT, '
       || 'ehr.patient_entry_documents>hid_ehr_runtime:SELECT, '
       || 'ehr.patient_entry_documents>hid_schema_test_runtime:SELECT, '
       || 'ehr.patient_entry_documents_effective>hid_ehr_runtime:SELECT, '
       || 'ehr.patient_entry_documents_effective>hid_schema_test_runtime:SELECT' then
    raise exception 'Grants: %', coalesce(mismatch, 'none');
  end if;
  foreach role_name in array array['hid_ehr_api_runtime', 'hid_identity_api_runtime', 'hid_lab_api_runtime',
      'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_ocr_api_runtime', 'hid_notification_worker',
      'hid_event_dispatcher', 'hid_schema_test_runtime', 'hid_ehr_runtime', 'hid_document_scanner'] loop
    if exists (select 1 from pg_roles where rolname = role_name)
       and (has_table_privilege(role_name, 'ehr.patient_entry_documents', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
         or has_table_privilege(role_name, 'ehr.patient_entry_document_scan_events',
              'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')) then
      raise exception '% may write the files or their scan events', role_name;
    end if;
  end loop;
  if has_table_privilege('hid_document_scanner', 'ehr.patient_entry_documents', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'ehr.patient_entry_documents', 'SELECT')
     or not has_table_privilege('hid_ehr_api_runtime', 'ehr.patient_entry_documents', 'SELECT') then
    raise exception 'Only the EHR runtime may read the files';
  end if;
  select string_agg(expected, ', ') into mismatch
    from unnest(patient_commands || scanner_commands) expected
    left join pg_proc proc on proc.oid = to_regprocedure(expected)
   where proc.oid is null or not proc.prosecdef
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  if mismatch is not null then raise exception 'Commands without SECURITY DEFINER or search_path: %', mismatch; end if;
  foreach proc_name in array patient_commands || scanner_commands loop
    select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
        order by privilege.grantee::regrole::text) into mismatch
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
     where p.oid = proc_name::regprocedure and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner;
    if mismatch is distinct from (case when proc_name = any (patient_commands)
         then 'hid_ehr_runtime, hid_schema_test_runtime' else 'hid_document_scanner' end) then
      raise exception '% is executable by %', proc_name, coalesce(mismatch, 'its owner only');
    end if;
  end loop;
  -- The scanner role only on scanner commands; the EHR runtime only on the patient's.
  if has_function_privilege('hid_document_scanner', patient_commands[1], 'EXECUTE')
     or has_function_privilege('hid_document_scanner', patient_commands[2], 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', scanner_commands[1], 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', scanner_commands[3], 'EXECUTE')
     or not has_function_privilege('hid_ehr_api_runtime', patient_commands[1], 'EXECUTE')
     or not has_function_privilege('hid_document_scanner', scanner_commands[3], 'EXECUTE') then
    raise exception 'The scanner and patient commands are not each their own role''s';
  end if;
  if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
              where p.oid = 'ehr.patient_entry_documents_guard()'::regprocedure and privilege.privilege_type = 'EXECUTE'
                and privilege.grantee <> p.proowner) then
    raise exception 'The guard is executable by another role';
  end if;
end $$;

-- Transaction contexts as the services set them.
create function pg_temp.as_ehr_patient(subject text, account text, session text, patient text, correlation text)
returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.account_id', account, true),
    set_config('app.session_id', session, true), set_config('app.patient_id', patient, true),
    set_config('app.correlation_id', correlation, true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '30 seconds')::text, true),
    set_config('app.purpose_of_use', 'patient-self', true), set_config('app.facility_id', '', true),
    set_config('app.membership_id', '', true);
$$;
create function pg_temp.as_staff(subject text, membership text, facility text, purpose text, correlation text)
returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
    set_config('app.membership_id', membership, true), set_config('app.purpose_of_use', purpose, true),
    set_config('app.correlation_id', correlation, true), set_config('app.patient_id', '', true),
    set_config('app.account_id', '', true), set_config('app.session_id', '', true),
    set_config('app.self_authorized_until', '', true);
$$;
-- DatabaseService.withWorkloadTransaction.
create function pg_temp.as_scanner(correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'hid:staging:document-scanner', true),
    set_config('app.correlation_id', correlation, true), set_config('app.patient_id', '', true),
    set_config('app.account_id', '', true), set_config('app.session_id', '', true),
    set_config('app.self_authorized_until', '', true), set_config('app.purpose_of_use', '', true);
$$;
create function pg_temp.sqlstate_of(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- A patient in their own context: s (1), n (2), o (4).
create function pg_temp.as_p(n integer, correlation text) returns void language sql as $$
  select pg_temp.as_ehr_patient('patient:e7a10000-0000-4000-8000-00000000000' || n,
    'e7a10000-0000-4000-8000-00000000000' || n, 'e7f10000-0000-4000-8000-00000000000' || n,
    'e7b10000-0000-4000-8000-00000000000' || n, correlation);
$$;
create function pg_temp.add_entry(title text) returns uuid language plpgsql as $$
declare answer record;
begin
  select * into answer from ehr.create_my_patient_entry('test', title, null, date '2026-10-20', null, null,
    md5(title || clock_timestamp()::text) || md5(title));
  if answer.outcome <> 'created' then raise exception 'Adding the entry %: %', title, answer.outcome; end if;
  return answer.entry_id;
end $$;
-- The intent command's answer as 'outcome|id|status|scan|retry', or the error.
create function pg_temp.intent(entry uuid, file_name text, media text, size bigint, sha text, idem text, digest text,
  object_key text) returns text language plpgsql as $$
declare answer record;
begin
  select * into answer from ehr.create_my_patient_entry_document_intent(entry, file_name, media, size, sha, idem, digest,
    'hid-e7-documents', object_key);
  return format('%s|%s|%s|%s|%s', answer.outcome, coalesce(answer.document_id::text, ''),
    coalesce(answer.document_status, ''), coalesce(answer.document_scan_status, ''),
    coalesce(answer.retry_after_seconds::text, ''));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- A new file on an entry: n-th key and digest of a patient, its own object key.
create function pg_temp.open_file(entry uuid, who integer, n integer) returns text language sql as $$
  select pg_temp.intent(entry, 'scan-' || n || '.jpg', 'image/jpeg', 2048, repeat('a', 64),
    format('e7-key-%s-%s-aaaaaaaa', who, lpad(n::text, 4, '0')), lpad(to_hex(who * 1000 + n), 64, '0'),
    format('clinical/objects/e7%s%s-0000-4000-8000-%s', who, lpad(n::text, 5, '0'), lpad(to_hex(who * 1000 + n), 12, '0')));
$$;
create function pg_temp.complete(entry uuid, document uuid, version text, size bigint, sha text) returns text
language plpgsql as $$
declare answer record;
begin
  select * into answer from ehr.complete_my_patient_entry_document(entry, document, version, size, sha);
  return format('%s|%s|%s', answer.outcome, coalesce(answer.document_status, ''), coalesce(answer.document_scan_status, ''));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.vector() returns public.vector language sql as $$
  select ('[' || array_to_string(array_fill(0::real, array[1024]), ',') || ']')::public.vector;
$$;
create temporary table e7_ids (name text primary key, id uuid not null);
grant all on e7_ids to public;
grant execute on function pg_temp.as_ehr_patient(text, text, text, text, text),
  pg_temp.as_staff(text, text, text, text, text), pg_temp.as_scanner(text), pg_temp.sqlstate_of(text),
  pg_temp.as_p(integer, text), pg_temp.add_entry(text),
  pg_temp.intent(uuid, text, text, bigint, text, text, text, text), pg_temp.open_file(uuid, integer, integer),
  pg_temp.complete(uuid, uuid, text, bigint, text), pg_temp.vector() to public;

-- Fixtures. Accounts e7a1...: 1 patient S, 2 patient N (the limits), 4 another
-- patient O, 6 the doctor D. The scanner's account is 0105's seed.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'files-test') on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system) values
  ('e7a10000-0000-4000-8000-000000000001', 'patient:e7a10000-0000-4000-8000-000000000001', 'e7.s@example.invalid',
   'Sade Files', 'active', clock_timestamp(), 'hid'),
  ('e7a10000-0000-4000-8000-000000000002', 'patient:e7a10000-0000-4000-8000-000000000002', 'e7.n@example.invalid',
   'Nkem Files', 'active', clock_timestamp(), 'hid'),
  ('e7a10000-0000-4000-8000-000000000004', 'patient:e7a10000-0000-4000-8000-000000000004', 'e7.o@example.invalid',
   'Ola Files', 'active', clock_timestamp(), 'hid'),
  ('e7a10000-0000-4000-8000-000000000006', 'staff:e7-doctor', 'e7-doctor@example.invalid',
   'Files Doctor', 'active', clock_timestamp(), 'hid');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system) values
  ('e7b10000-0000-4000-8000-000000000001', 'e7a10000-0000-4000-8000-000000000001', 'HID-FSADEA', 'Sade', 'Files',
   'Sade Files', 'active', 'hid'),
  ('e7b10000-0000-4000-8000-000000000002', 'e7a10000-0000-4000-8000-000000000002', 'HID-FNKEMB', 'Nkem', 'Files',
   'Nkem Files', 'active', 'hid'),
  ('e7b10000-0000-4000-8000-000000000004', 'e7a10000-0000-4000-8000-000000000004', 'HID-FWLAAC', 'Ola', 'Files',
   'Ola Files', 'active', 'hid');
insert into identity.organizations (id, name, slug) values
  ('e7d10000-0000-4000-8000-000000000001', 'Files Test Org', 'e7-files-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e7d10000-0000-4000-8000-000000000002', 'e7d10000-0000-4000-8000-000000000001', 'Files Test Hospital', 'E7P-H',
   'Africa/Lagos', true, 'verified'),
  ('e7d10000-0000-4000-8000-000000000003', 'e7d10000-0000-4000-8000-000000000001', 'Files Other Clinic', 'E7P-C',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e7d20000-0000-4000-8000-000000000001', 'e7a10000-0000-4000-8000-000000000006', 'Files Doctor',
   'e7-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('e7d30000-0000-4000-8000-000000000001', 'e7d20000-0000-4000-8000-000000000001', 'e7a10000-0000-4000-8000-000000000006',
   'e7d10000-0000-4000-8000-000000000001', 'e7d10000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true),
  ('e7d30000-0000-4000-8000-000000000002', 'e7d20000-0000-4000-8000-000000000001', 'e7a10000-0000-4000-8000-000000000006',
   'e7d10000-0000-4000-8000-000000000001', 'e7d10000-0000-4000-8000-000000000003', 'doctor', 'doctor', false, true);
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('e7c30000-0000-4000-8000-000000000001', 'e7b10000-0000-4000-8000-000000000001', 'e7d20000-0000-4000-8000-000000000001',
   'e7a10000-0000-4000-8000-000000000006', 'e7d30000-0000-4000-8000-000000000001', 'e7d10000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Files test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'e7-grant-0001', 'hid');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id, revoked_at,
  revocation_reason)
select ('e7f10000-0000-4000-8000-00000000000' || n)::uuid, ('e7a10000-0000-4000-8000-00000000000' || n)::uuid,
  ('e7f10000-0000-4000-8000-00000000000' || n)::uuid, md5('e7-' || n) || md5('e7-' || n), gen_random_uuid(), 1,
  'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
  'patient', ('e7b10000-0000-4000-8000-00000000000' || n)::uuid, null, null
  from unnest(array[1, 2, 4]) n;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id, revoked_at,
  revocation_reason) values
  ('e7f10000-0000-4000-8000-000000000009', 'e7a10000-0000-4000-8000-000000000001', 'e7f10000-0000-4000-8000-000000000009',
   md5('e7-revoked') || md5('e7-revoked'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'e7b10000-0000-4000-8000-000000000001', clock_timestamp(), 'synthetic-test');

-- 2, 3 and 5, as the EHR API runs them.
set local role hid_ehr_api_runtime;
do $$
declare
  answer text;
  entry_s uuid;
  entry_s2 uuid;
  entry_o uuid;
  file_s uuid;
begin
  perform pg_temp.as_p(1, 'e7-entry-0001');
  entry_s := pg_temp.add_entry('Malaria test');
  perform pg_temp.as_p(1, 'e7-entry-0002');
  entry_s2 := pg_temp.add_entry('Chest film');
  perform pg_temp.as_p(4, 'e7-entry-0003');
  entry_o := pg_temp.add_entry('Ola''s record');
  insert into e7_ids values ('entry_s', entry_s), ('entry_s2', entry_s2), ('entry_o', entry_o);

  -- 2. S opens a file: initiated, scan pending, read back by S alone.
  perform pg_temp.as_p(1, 'e7-intent-0001');
  answer := pg_temp.open_file(entry_s, 1, 1);
  if answer !~ '^created\|[0-9a-f-]{36}\|initiated\|pending\|$' then raise exception 'S opens a file: %', answer; end if;
  file_s := split_part(answer, '|', 2)::uuid;
  insert into e7_ids values ('file_s', file_s);
  -- A second file on the same record, never confirmed: read by S, never by the doctor or the scanner.
  perform pg_temp.as_p(1, 'e7-intent-0002');
  answer := pg_temp.open_file(entry_s, 1, 2);
  if answer !~ '^created\|' then raise exception 'S opens a second file: %', answer; end if;
  if (select format('%s|%s|%s|%s', status, scan_status, storage_key, original_file_name)
        from ehr.patient_entry_documents_effective where id = file_s)
     is distinct from 'initiated|pending|clinical/objects/e7100001-0000-4000-8000-0000000003e9|scan-1.jpg' then
    raise exception 'S does not read their own initiated file back';
  end if;

  -- 2. Another patient's file is refused: O on S's record, O's confirm of S's file, O's read.
  perform pg_temp.as_p(4, 'e7-refuse-0001');
  answer := pg_temp.open_file(entry_s, 4, 1);
  if answer <> 'entry_not_found||||' then raise exception 'O opened a file on S''s record: %', answer; end if;
  if pg_temp.complete(entry_s, file_s, 'v1', 2048, repeat('a', 64)) <> 'not_found||' then
    raise exception 'O confirmed S''s file';
  end if;
  if exists (select 1 from ehr.patient_entry_documents) or exists (select 1 from ehr.patient_entry_documents_effective) then
    raise exception 'O reads S''s file';
  end if;
  -- S's context claiming O's patient id, a revoked session, no correlation id.
  perform pg_temp.as_ehr_patient('patient:e7a10000-0000-4000-8000-000000000001', 'e7a10000-0000-4000-8000-000000000001',
    'e7f10000-0000-4000-8000-000000000001', 'e7b10000-0000-4000-8000-000000000004', 'e7-refuse-0002');
  if pg_temp.open_file(entry_o, 1, 90) not like '42501%' then raise exception 'S opened a file as O'; end if;
  perform pg_temp.as_ehr_patient('patient:e7a10000-0000-4000-8000-000000000001', 'e7a10000-0000-4000-8000-000000000001',
    'e7f10000-0000-4000-8000-000000000009', 'e7b10000-0000-4000-8000-000000000001', 'e7-refuse-0003');
  if pg_temp.open_file(entry_s, 1, 91) not like '42501%'
     or pg_temp.complete(entry_s, file_s, 'v1', 2048, repeat('a', 64)) not like '42501%' then
    raise exception 'A revoked session opened or confirmed a file';
  end if;
  if exists (select 1 from ehr.patient_entry_documents) then raise exception 'A revoked session reads files'; end if;
  perform pg_temp.as_p(1, 'e7-refuse-0004');
  perform set_config('app.correlation_id', '', true);
  if pg_temp.open_file(entry_s, 1, 92) not like '42501%' then raise exception 'A file without a correlation id'; end if;

  -- Invalid input (22023), nothing written.
  perform pg_temp.as_p(1, 'e7-invalid-0001');
  foreach answer in array array[
      pg_temp.intent(entry_s, 'x.tif', 'image/tiff', 10, repeat('a', 64), 'e7-key-invalid-0001', repeat('1', 64),
        'clinical/objects/e7000001-0000-4000-8000-000000000001'),
      pg_temp.intent(entry_s, 'x.jpg', 'image/jpeg', 0, repeat('a', 64), 'e7-key-invalid-0002', repeat('1', 64),
        'clinical/objects/e7000001-0000-4000-8000-000000000002'),
      pg_temp.intent(entry_s, 'x.jpg', 'image/jpeg', 10485761, repeat('a', 64), 'e7-key-invalid-0003', repeat('1', 64),
        'clinical/objects/e7000001-0000-4000-8000-000000000003'),
      pg_temp.intent(entry_s, 'x.jpg', 'image/jpeg', 10, repeat('A', 64), 'e7-key-invalid-0004', repeat('1', 64),
        'clinical/objects/e7000001-0000-4000-8000-000000000004'),
      pg_temp.intent(entry_s, '', 'image/jpeg', 10, repeat('a', 64), 'e7-key-invalid-0005', repeat('1', 64),
        'clinical/objects/e7000001-0000-4000-8000-000000000005'),
      pg_temp.intent(entry_s, 'bell' || chr(7) || '.jpg', 'image/jpeg', 10, repeat('a', 64), 'e7-key-invalid-0006',
        repeat('1', 64), 'clinical/objects/e7000001-0000-4000-8000-000000000006'),
      pg_temp.intent(entry_s, repeat('n', 256), 'image/jpeg', 10, repeat('a', 64), 'e7-key-invalid-0007', repeat('1', 64),
        'clinical/objects/e7000001-0000-4000-8000-000000000007'),
      pg_temp.intent(entry_s, 'x.jpg', 'image/jpeg', 10, repeat('a', 64), null, repeat('1', 64),
        'clinical/objects/e7000001-0000-4000-8000-000000000008'),
      pg_temp.intent(entry_s, 'x.jpg', 'image/jpeg', 10, repeat('a', 64), 'e7-key-invalid-0009', repeat('1', 64),
        'patient/objects/e7000001-0000-4000-8000-000000000009'),
      pg_temp.intent(entry_s, 'x.jpg', 'image/jpeg', 10, repeat('a', 64), 'e7-key-invalid-0010', repeat('1', 64),
        'clinical/objects/../e7000001-0000-4000-8000-00000000000a')] loop
    if answer not like '22023 PATIENT_DOCUMENT_INVALID%' then raise exception 'An invalid file: %', answer; end if;
  end loop;
  -- The limits themselves are accepted: 1 byte, 10485760 bytes, PNG and PDF, a 255-character name.
  perform pg_temp.as_p(1, 'e7-limits-0001');
  answer := pg_temp.intent(entry_s2, repeat('n', 251) || '.pdf', 'application/pdf', 10485760, repeat('b', 64),
    'e7-key-limits-00000001', repeat('2', 64), 'clinical/objects/e7000002-0000-4000-8000-000000000001');
  if answer !~ '^created\|' then raise exception 'The upper limits: %', answer; end if;
  answer := pg_temp.intent(entry_s2, 'one.png', 'image/png', 1, repeat('c', 64), 'e7-key-limits-00000002',
    repeat('3', 64), 'clinical/objects/e7000002-0000-4000-8000-000000000002');
  if answer !~ '^created\|' then raise exception 'One byte: %', answer; end if;

  -- 3. Replays before the confirm: the same file, nothing new written.
  perform pg_temp.as_p(1, 'e7-replay-0001');
  answer := pg_temp.open_file(entry_s, 1, 1);
  if answer <> format('replayed|%s|initiated|pending|', file_s) then raise exception 'A replay: %', answer; end if;
  -- The same key with another body, or for another record: key_reused.
  perform pg_temp.as_p(1, 'e7-replay-0002');
  answer := pg_temp.intent(entry_s, 'other.jpg', 'image/jpeg', 2048, repeat('a', 64), 'e7-key-1-0001-aaaaaaaa',
    repeat('9', 64), 'clinical/objects/e7000003-0000-4000-8000-000000000001');
  if answer <> 'key_reused||||' then raise exception 'A reused key: %', answer; end if;

  -- 5. Confirm: only the uploader's declared size and SHA-256, once.
  perform pg_temp.as_p(1, 'e7-complete-0001');
  if pg_temp.complete(entry_s, file_s, 'e7-version-1', 2047, repeat('a', 64)) <> 'mismatch|initiated|pending'
     or pg_temp.complete(entry_s, file_s, 'e7-version-1', 2048, repeat('b', 64)) <> 'mismatch|initiated|pending' then
    raise exception 'A confirm of other bytes was not refused';
  end if;
  if pg_temp.complete(entry_s2, file_s, 'e7-version-1', 2048, repeat('a', 64)) <> 'not_found||' then
    raise exception 'A confirm under another record was not refused';
  end if;
  if pg_temp.complete(entry_s, file_s, '', 2048, repeat('a', 64)) not like '22023%' then
    raise exception 'A confirm without a version';
  end if;
  answer := pg_temp.complete(entry_s, file_s, 'e7-version-1', 2048, repeat('a', 64));
  if answer <> 'uploaded|uploaded|pending' then raise exception 'The confirm: %', answer; end if;
  perform pg_temp.as_p(1, 'e7-complete-0002');
  answer := pg_temp.complete(entry_s, file_s, 'e7-version-2', 2048, repeat('a', 64));
  if answer <> 'already_uploaded|uploaded|pending' then raise exception 'A repeated confirm: %', answer; end if;
  if (select object_version_id from ehr.patient_entry_documents where id = file_s) <> 'e7-version-1' then
    raise exception 'A repeated confirm rebound the object';
  end if;
  -- 3. A replay after the confirm: already_uploaded with its status.
  perform pg_temp.as_p(1, 'e7-replay-0003');
  answer := pg_temp.open_file(entry_s, 1, 1);
  if answer <> format('already_uploaded|%s|uploaded|pending|', file_s) then
    raise exception 'A replay after the confirm: %', answer;
  end if;
  -- The runtime cannot write the files, or lock one.
  if pg_temp.sqlstate_of($q$insert into ehr.patient_entry_documents (patient_id, entry_id, created_by_account_id,
       idempotency_key, request_sha256, original_file_name, storage_bucket, storage_key, declared_media_type, size_bytes,
       sha256_hex) values ('e7b10000-0000-4000-8000-000000000001', (select id from e7_ids where name = 'entry_s'),
       'e7a10000-0000-4000-8000-000000000001', 'e7-key-direct-00000001', repeat('4', 64), 'direct.jpg', 'hid-e7-documents',
       'clinical/objects/e7000004-0000-4000-8000-000000000001', 'image/jpeg', 10, repeat('a', 64))$q$) not like '42501%'
     or pg_temp.sqlstate_of($q$update ehr.patient_entry_documents set original_file_name = 'x'$q$) not like '42501%'
     or pg_temp.sqlstate_of($q$delete from ehr.patient_entry_documents$q$) not like '42501%'
     or pg_temp.sqlstate_of($q$select 1 from ehr.patient_entry_documents for update$q$) not like '42501%'
     or pg_temp.sqlstate_of($q$insert into ehr.patient_entry_document_scan_events (document_id, patient_id, created_by,
       object_version_id, object_sha256_hex, event_type, detected_media_type, scanner_engine, scanner_version,
       idempotency_key, correlation_id) values ((select id from e7_ids where name = 'file_s'),
       'e7b10000-0000-4000-8000-000000000001', 'e7a10000-0000-4000-8000-000000000001', 'e7-version-1', repeat('a', 64),
       'clean', 'image/jpeg', 'forged', '1', 'e7-forged-clean-0001', 'e7-forged-0001')$q$) not like '42501%' then
    raise exception 'The EHR runtime can write or lock the files directly';
  end if;
end $$;
reset role;

-- 5 (cont.) Only initiated to uploaded, even for the owner; no delete or truncate.
do $$
declare file_s uuid := (select id from e7_ids where name = 'file_s');
begin
  if pg_temp.sqlstate_of(format($q$update ehr.patient_entry_documents set original_file_name = 'renamed.jpg'
       where id = %L$q$, file_s)) not like '55000%'
     or pg_temp.sqlstate_of(format($q$update ehr.patient_entry_documents set object_version_id = 'other',
       row_version = row_version + 1 where id = %L$q$, file_s)) not like '55000%'
     or pg_temp.sqlstate_of(format($q$delete from ehr.patient_entry_documents where id = %L$q$, file_s)) not like '55000%'
     -- Refused by its trigger, or before it because the scan events and readings reference it.
     or pg_temp.sqlstate_of($q$truncate ehr.patient_entry_documents$q$) !~ '^(55000|0A000) '
     or pg_temp.sqlstate_of($q$truncate ehr.patient_entry_documents cascade$q$) not like '55000%' then
    raise exception 'A file was rewritten, rebound or deleted';
  end if;
end $$;

-- 4. Limits, for N: record A takes 5 and refuses the 6th; record B takes 5
-- more; record A is removed; the 11th of the day (on B) is refused; one file
-- opened yesterday in Lagos (record C) does not count.
set local role hid_ehr_api_runtime;
do $$
declare
  answer text;
  entry_a uuid;
  entry_b uuid;
  entry_c uuid;
  n integer;
begin
  perform pg_temp.as_p(2, 'e7-limit-entry-a');
  entry_a := pg_temp.add_entry('Record A');
  perform pg_temp.as_p(2, 'e7-limit-entry-b');
  entry_b := pg_temp.add_entry('Record B');
  perform pg_temp.as_p(2, 'e7-limit-entry-c');
  entry_c := pg_temp.add_entry('Record C');
  insert into e7_ids values ('entry_a', entry_a), ('entry_b', entry_b), ('entry_c', entry_c);
  for n in 1..5 loop
    perform pg_temp.as_p(2, 'e7-limit-a-' || n);
    answer := pg_temp.open_file(entry_a, 2, n);
    if answer !~ '^created\|' then raise exception 'File % on record A: %', n, answer; end if;
  end loop;
  perform pg_temp.as_p(2, 'e7-limit-a-6');
  answer := pg_temp.open_file(entry_a, 2, 6);
  if answer <> 'entry_full||||' then raise exception 'The 6th file on a record: %', answer; end if;
  perform pg_temp.as_p(2, 'e7-limit-withdraw-a');
  if (select outcome from ehr.withdraw_my_patient_entry(entry_a)) <> 'withdrawn' then raise exception 'Removing A'; end if;
  for n in 7..11 loop
    perform pg_temp.as_p(2, 'e7-limit-b-' || n);
    answer := pg_temp.open_file(entry_b, 2, n);
    if answer !~ '^created\|' then raise exception 'File % of the day (on B): %', n - 1, answer; end if;
  end loop;
end $$;
reset role;
-- Record A refused its 6th with none of its 5 confirmed: opened files count,
-- in any state (INTERFACE_CONTRACT.md §37).
do $$
begin
  if (select count(*) filter (where status = 'initiated') || '/' || count(*) from ehr.patient_entry_documents
       where entry_id = (select id from e7_ids where name = 'entry_a')) <> '5/5' then
    raise exception 'Record A should hold 5 unconfirmed files';
  end if;
end $$;
-- Yesterday's file on record C, written as the owner would have.
insert into ehr.patient_entry_documents (patient_id, entry_id, created_by_account_id, idempotency_key, request_sha256,
  original_file_name, storage_bucket, storage_key, declared_media_type, size_bytes, sha256_hex, created_at, updated_at)
values ('e7b10000-0000-4000-8000-000000000002', (select id from e7_ids where name = 'entry_c'),
  'e7a10000-0000-4000-8000-000000000002', 'e7-key-yesterday-0001', repeat('5', 64), 'yesterday.jpg', 'hid-e7-documents',
  'clinical/objects/e7000005-0000-4000-8000-000000000001', 'image/jpeg', 10, repeat('a', 64),
  (date_trunc('day', clock_timestamp() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') - interval '1 second',
  (date_trunc('day', clock_timestamp() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') - interval '1 second');
set local role hid_ehr_api_runtime;
do $$
declare
  answer text;
  retry integer;
  expected integer := ceil(extract(epoch from (date_trunc('day', clock_timestamp() at time zone 'Africa/Lagos')
    at time zone 'Africa/Lagos' + interval '1 day') - clock_timestamp()))::integer;
begin
  perform pg_temp.as_p(2, 'e7-limit-11');
  answer := pg_temp.open_file((select id from e7_ids where name = 'entry_c'), 2, 12);
  if answer !~ '^daily_limit\|\|\|\|[0-9]+$' then raise exception 'The 11th file of the day: %', answer; end if;
  retry := split_part(answer, '|', 5)::integer;
  if retry not between 1 and 86400 or abs(retry - expected) > 5 then
    raise exception 'Retry after % seconds, expected about % (the next Lagos midnight)', retry, expected;
  end if;
  -- A replayed key at the limit is never refused: before its confirm, the same file.
  perform pg_temp.as_p(2, 'e7-limit-replay');
  answer := pg_temp.open_file((select id from e7_ids where name = 'entry_b'), 2, 11);
  if answer !~ '^replayed\|' then raise exception 'A replay at the limit: %', answer; end if;
  -- A removed record's key is no longer a record of the patient's: no new link on it.
  perform pg_temp.as_p(2, 'e7-limit-replay-removed');
  answer := pg_temp.open_file((select id from e7_ids where name = 'entry_a'), 2, 1);
  if answer <> 'entry_not_found||||' then raise exception 'A replay on a removed record: %', answer; end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from ehr.patient_entry_documents where patient_id = 'e7b10000-0000-4000-8000-000000000002') <> 11
     or exists (select 1 from ehr.patient_entry_documents where idempotency_key in ('e7-key-2-0006-aaaaaaaa',
       'e7-key-2-0012-aaaaaaaa')) then
    raise exception 'A refused file was written';
  end if;
  if (select count(*) from audit.events where correlation_id = 'e7-limit-11'
        and action = 'ehr.patient-entry.document.upload-intent' and outcome = 'denied' and actor_type = 'patient'
        and resource_id is null and details = '{"reason": "daily_limit", "limit": 10}'::jsonb) <> 1
     or (select count(*) from audit.events where correlation_id = 'e7-limit-a-6'
        and action = 'ehr.patient-entry.document.upload-intent' and outcome = 'denied'
        and details = '{"reason": "entry_limit", "limit": 5}'::jsonb) <> 1 then
    raise exception 'A limit is not audited as denied with counts only';
  end if;
end $$;

-- 6. A removed record: S removes the second record; its files are hidden from
-- S, kept, and take no confirm. (The doctor's view is in 7.)
set local role hid_ehr_api_runtime;
do $$
declare
  entry_s2 uuid := (select id from e7_ids where name = 'entry_s2');
  hidden uuid;
begin
  perform pg_temp.as_p(1, 'e7-withdraw-0001');
  select id into hidden from ehr.patient_entry_documents where entry_id = entry_s2 and size_bytes = 1;
  insert into e7_ids values ('hidden', hidden);
  if (select outcome from ehr.withdraw_my_patient_entry(entry_s2)) <> 'withdrawn' then raise exception 'Removing S2'; end if;
  perform pg_temp.as_p(1, 'e7-withdraw-0002');
  if exists (select 1 from ehr.patient_entry_documents where entry_id = entry_s2)
     or exists (select 1 from ehr.patient_entry_documents_effective where entry_id = entry_s2) then
    raise exception 'S still reads a removed record''s files';
  end if;
  if pg_temp.complete(entry_s2, hidden, 'e7-version-h', 1, repeat('c', 64)) <> 'not_found||' then
    raise exception 'A file on a removed record was confirmed';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from ehr.patient_entry_documents where entry_id = (select id from e7_ids where name = 'entry_s2')) <> 2 then
    raise exception 'A removed record''s files were not kept';
  end if;
end $$;

-- 8. The scanner, by key and by id, as the scanner pool runs it.
set local role hid_document_scanner;
do $$
declare
  file_s uuid := (select id from e7_ids where name = 'file_s');
  answer text;
  event_id uuid;
begin
  -- Not the scanner's context: 42501.
  perform set_config('app.actor_subject', 'staff:e7-doctor', true), set_config('app.correlation_id', 'e7-scan-0000', true);
  if pg_temp.sqlstate_of($q$select * from ehr.resolve_patient_entry_document_scan_target('hid-e7-documents',
       'clinical/objects/e7100001-0000-4000-8000-0000000003e9', 'e7-version-1', 'e7-scan-0000')$q$)
     <> '42501 Authorized document scanner context is required' then
    raise exception 'Another subject resolved a file';
  end if;
  perform pg_temp.as_scanner('e7-scan-0001');
  if pg_temp.sqlstate_of($q$select * from ehr.resolve_patient_entry_document_scan_target('hid-e7-documents',
       'clinical/objects/e7100001-0000-4000-8000-0000000003e9', 'e7-version-1', 'e7-another-correlation')$q$)
     <> '42501 Authorized document scanner context is required' then
    raise exception 'A resolve with another correlation id';
  end if;
  select format('%s|%s|%s|%s|%s', document_id, object_version_id, status, declared_media_type,
           coalesce(latest_event_type, '-')) into answer
    from ehr.resolve_patient_entry_document_scan_target('hid-e7-documents',
      'clinical/objects/e7100001-0000-4000-8000-0000000003e9', 'e7-version-1', 'e7-scan-0001');
  if answer <> format('%s|e7-version-1|uploaded|image/jpeg|-', file_s) then raise exception 'The resolve: %', answer; end if;
  -- 0105's refusals, word for word.
  if pg_temp.sqlstate_of($q$select * from ehr.resolve_patient_entry_document_scan_target('hid-e7-documents',
       'clinical/objects/e7ffffff-0000-4000-8000-000000000000', 'v', 'e7-scan-0001')$q$) <> 'P0002 Document not found'
     or pg_temp.sqlstate_of($q$select * from ehr.resolve_patient_entry_document_scan_target('hid-e7-documents',
       'clinical/objects/e7100001-0000-4000-8000-0000000003e9', 'e7-version-other', 'e7-scan-0001')$q$)
       <> '55000 Scan result does not match the current immutable document object'
     or pg_temp.sqlstate_of($q$select * from ehr.resolve_patient_entry_document_scan_target('hid-e7-documents',
       'clinical/objects/e7200007-0000-4000-8000-0000000007d7', 'v', 'e7-scan-0001')$q$)
       <> '55000 Only an uploaded document can be scanned' then
    raise exception 'The resolve''s refusals are not 0105''s';
  end if;
  -- The work list: the confirmed file only (never an initiated one), no patient.
  if (select string_agg(document_id::text, ',') from ehr.list_patient_entry_documents_awaiting_scan(0, 100, 'e7-scan-0001'))
     is distinct from file_s::text then
    raise exception 'The work list is not the one confirmed file';
  end if;
  -- Append: scan_started, a replay of it, then clean.
  if pg_temp.sqlstate_of(format($q$select ehr.append_patient_entry_document_scan_event(%L, 'e7-version-1', %L,
       'clean', 'image/tiff', 'aws-guardduty-malware-protection-s3', '1.0', null, 'e7-scan-tiff-00000001',
       'e7-scan-0001')$q$, file_s, repeat('a', 64))) <> '22023 A supported detected media type is required for a clean scan'
     or pg_temp.sqlstate_of(format($q$select ehr.append_patient_entry_document_scan_event(%L, 'e7-version-1', %L,
       'clean', 'image/jpeg', 'aws-guardduty-malware-protection-s3', '1.0', null, 'e7-scan-wrong-00000001',
       'e7-scan-0001')$q$, file_s, repeat('b', 64))) <> '55000 Scan result does not match the current immutable document object'
     or pg_temp.sqlstate_of(format($q$select ehr.append_patient_entry_document_scan_event(%L, 'e7-version-1', %L,
       'clean', 'image/jpeg', 'aws-guardduty-malware-protection-s3', '1.0', null, 'e7-scan-none-00000001',
       'e7-scan-0001')$q$, 'e7ffffff-0000-4000-8000-000000000000', repeat('a', 64))) <> 'P0002 Document not found'
     or pg_temp.sqlstate_of(format($q$select ehr.append_patient_entry_document_scan_event(%L, 'e7-version-1', %L,
       'clean', 'image/jpeg', 'aws-guardduty-malware-protection-s3', '1.0', null, 'e7-scan-init-00000001',
       'e7-scan-0001')$q$, (select id from e7_ids where name = 'hidden'), repeat('c', 64)))
       <> '55000 Only an uploaded document can be scanned' then
    raise exception 'The append''s refusals are not 0009''s';
  end if;
  event_id := ehr.append_patient_entry_document_scan_event(file_s, 'e7-version-1', repeat('a', 64), 'scan_started', null,
    'aws-guardduty-malware-protection-s3', '1.0', null, 'e7-scan-started-00000001', 'e7-scan-0001');
  if ehr.append_patient_entry_document_scan_event(file_s, 'e7-version-1', repeat('a', 64), 'scan_started', null,
       'aws-guardduty-malware-protection-s3', '1.0', null, 'e7-scan-started-00000001', 'e7-scan-0001') <> event_id then
    raise exception 'A replayed scan event is not the same event';
  end if;
  if pg_temp.sqlstate_of(format($q$select ehr.append_patient_entry_document_scan_event(%L, 'e7-version-1', %L,
       'failed', null, 'aws-guardduty-malware-protection-s3', '1.0', 'other', 'e7-scan-started-00000001',
       'e7-scan-0001')$q$, file_s, repeat('a', 64))) <> '23505 Scanner idempotency key payload mismatch' then
    raise exception 'A reused scanner key was not refused';
  end if;
  perform ehr.append_patient_entry_document_scan_event(file_s, 'e7-version-1', repeat('a', 64), 'clean', 'image/jpeg',
    'aws-guardduty-malware-protection-s3', '1.0', null, 'e7-scan-clean-000000001', 'e7-scan-0001');
  if pg_temp.sqlstate_of(format($q$select ehr.append_patient_entry_document_scan_event(%L, 'e7-version-1', %L,
       'rejected', null, 'aws-guardduty-malware-protection-s3', '1.0', 'malware', 'e7-scan-reject-00000001',
       'e7-scan-0001')$q$, file_s, repeat('a', 64))) <> '55000 Document object scan has already reached a terminal result'
     or pg_temp.sqlstate_of($q$select * from ehr.resolve_patient_entry_document_scan_target('hid-e7-documents',
       'clinical/objects/e7100001-0000-4000-8000-0000000003e9', 'e7-version-1', 'e7-scan-0001')$q$)
       <> '55000 Document object scan has already reached a terminal result' then
    raise exception 'A terminal result was not final';
  end if;
  if exists (select 1 from ehr.list_patient_entry_documents_awaiting_scan(0, 100, 'e7-scan-0001')) then
    raise exception 'A clean file is still listed';
  end if;
  -- The scanner role reads no table and runs no patient command.
  if pg_temp.sqlstate_of('select 1 from ehr.patient_entry_documents') not like '42501%'
     or pg_temp.sqlstate_of('select 1 from ehr.patient_entry_document_scan_events') not like '42501%'
     or pg_temp.sqlstate_of(format($q$select * from ehr.complete_my_patient_entry_document(%L, %L, 'v', 1, %L)$q$,
       (select id from e7_ids where name = 'entry_s'), file_s, repeat('a', 64))) not like '42501%'
     or pg_temp.sqlstate_of(format($q$select * from ehr.create_my_patient_entry_document_intent(%L, 'x.jpg', 'image/jpeg',
       1, %L, 'e7-key-scanner-00000001', %L, 'hid-e7-documents', 'clinical/objects/e7000006-0000-4000-8000-000000000001')$q$,
       (select id from e7_ids where name = 'entry_s'), repeat('a', 64), repeat('6', 64))) not like '42501%' then
    raise exception 'The scanner role reached a table or a patient command';
  end if;
end $$;
reset role;
-- The EHR runtime runs no scanner command.
set local role hid_ehr_api_runtime;
do $$
begin
  perform pg_temp.as_scanner('e7-scan-0002');
  if pg_temp.sqlstate_of($q$select * from ehr.list_patient_entry_documents_awaiting_scan(0, 10, 'e7-scan-0002')$q$)
       not like '42501 permission denied%'
     or pg_temp.sqlstate_of($q$select ehr.append_patient_entry_document_scan_event(gen_random_uuid(), 'v', repeat('a', 64),
       'scan_started', null, 'e', '1', null, 'e7-scan-runtime-0000001', 'e7-scan-0002')$q$) not like '42501 permission denied%' then
    raise exception 'The EHR runtime ran a scanner command';
  end if;
end $$;
reset role;

-- 8 (cont.) S reads the file as available and clean, and may store the chat's
-- reading of it (only of an available file, only in S's own session).
set local role hid_ehr_api_runtime;
do $$
declare file_s uuid := (select id from e7_ids where name = 'file_s');
begin
  perform pg_temp.as_p(1, 'e7-read-0001');
  if (select format('%s|%s|%s', status, scan_status, detected_media_type) from ehr.patient_entry_documents_effective
       where id = file_s) is distinct from 'available|clean|image/jpeg' then
    raise exception 'S does not read the clean file as available';
  end if;
  insert into ehr.patient_entry_document_extractions (file_id, patient_id, object_version_id, sha256_hex, status, job_id,
    extracted_text, page_count)
  values (file_s, 'e7b10000-0000-4000-8000-000000000001', 'e7-version-1', repeat('a', 64), 'ready', 'e7-job-0001',
    'Page 1: Malaria RDT positive', 1);
  if pg_temp.sqlstate_of(format($q$insert into ehr.patient_entry_document_extractions (file_id, patient_id,
       object_version_id, sha256_hex, status, job_id) values (%L, 'e7b10000-0000-4000-8000-000000000001', 'e7-version-h',
       %L, 'processing', 'e7-job-0002')$q$, (select id from e7_ids where name = 'hidden'), repeat('c', 64)))
     not like '42501%' then
    raise exception 'A reading of a file that is not available was stored';
  end if;
  perform pg_temp.as_p(4, 'e7-read-0002');
  if exists (select 1 from ehr.patient_entry_document_extractions)
     or exists (select 1 from ehr.patient_entry_document_scan_events) then
    raise exception 'O reads S''s file''s reading or scan';
  end if;
end $$;
reset role;

-- 7. The doctor's read.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff('staff:e7-doctor', 'e7d30000-0000-4000-8000-000000000001',
  'e7d10000-0000-4000-8000-000000000002', 'direct-care', 'e7-staff-0001');
do $$
begin
  if (select string_agg(format('%s|%s', original_file_name, status), ';') from ehr.patient_entry_documents_effective)
     is distinct from 'scan-1.jpg|available' then
    raise exception 'The doctor with a grant does not read exactly S''s confirmed file: %',
      (select string_agg(format('%s|%s', original_file_name, status), ';') from ehr.patient_entry_documents_effective);
  end if;
  if (select count(*) from ehr.patient_entry_document_scan_events) <> 2 then
    raise exception 'The doctor does not read the file''s scan events';
  end if;
  if exists (select 1 from ehr.patient_entry_document_extractions) then
    raise exception 'The doctor reads the patient chat''s reading';
  end if;
end $$;
select pg_temp.as_staff('staff:e7-doctor', 'e7d30000-0000-4000-8000-000000000002',
  'e7d10000-0000-4000-8000-000000000003', 'direct-care', 'e7-staff-0002');
do $$
begin
  if exists (select 1 from ehr.patient_entry_documents) then raise exception 'The doctor read at a facility without a grant'; end if;
end $$;
select pg_temp.as_staff('staff:e7-doctor', 'e7d30000-0000-4000-8000-000000000001',
  'e7d10000-0000-4000-8000-000000000002', 'healthcare-operations', 'e7-staff-0003');
do $$
begin
  if exists (select 1 from ehr.patient_entry_documents) then raise exception 'The doctor read for another purpose'; end if;
end $$;
reset role;

-- 10. Chat evidence: the new kind in both chunk tables; ehr-api's cleanup
-- statement under S's row-level security deletes a removed record's file
-- vectors and keeps the available file's.
do $$
begin
  if (select count(*) from pg_constraint where conname = 'patient_evidence_chunks_source_kind_check'
        and conrelid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
        and convalidated and md5(pg_get_constraintdef(oid)) = 'bfbe0af8c372b45fc68a39cd3a4e4d28') <> 2 then
    raise exception 'The chunk source-kind CHECKs are not 0117''s';
  end if;
end $$;
set local role hid_ehr_api_runtime;
do $$
declare
  file_s uuid := (select id from e7_ids where name = 'file_s');
  hidden uuid := (select id from e7_ids where name = 'hidden');
begin
  perform pg_temp.as_p(1, 'e7-chunks-0001');
  insert into ehr.patient_evidence_chunks (patient_id, source_kind, source_id, source_version, source_hash, chunk_no,
    model_id, embedding)
  select 'e7b10000-0000-4000-8000-000000000001', 'patient_entry_document', source, '1', repeat('a', 64), 0, 'e7-model',
    pg_temp.vector()
    from unnest(array[file_s, hidden]) source;
  if pg_temp.sqlstate_of(format($q$insert into ehr.patient_evidence_chunks (patient_id, source_kind, source_id,
       source_version, source_hash, chunk_no, model_id, embedding) values ('e7b10000-0000-4000-8000-000000000001',
       'patient_entry_document_x', %L, '1', repeat('a', 64), 0, 'e7-model', pg_temp.vector())$q$, file_s))
     not like '23514%' then
    raise exception 'The patient chunks take a kind that is not a source kind';
  end if;
  execute $q$delete from ehr.patient_evidence_chunks chunk where chunk.patient_id = $1 and chunk.source_kind = 'patient_entry_document' and not exists (select 1 from ehr.patient_entry_documents_effective file where file.id = chunk.source_id and file.patient_id = chunk.patient_id and file.status = 'available')$q$
    using 'e7b10000-0000-4000-8000-000000000001'::uuid;
  if (select string_agg(source_id::text, ',') from ehr.patient_evidence_chunks
       where source_kind = 'patient_entry_document') is distinct from file_s::text then
    raise exception 'The cleanup did not delete exactly the removed record''s file vectors';
  end if;
end $$;
reset role;

-- 7 (cont.) The grant ends: no more reads. 6 (cont.) S removes the first
-- record: its clean file is gone from S, the doctor (with a grant again) and
-- the work list, and kept.
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(),
  revoked_by = 'e7a10000-0000-4000-8000-000000000001', revoked_reason = 'Synthetic revoke'
 where id = 'e7c30000-0000-4000-8000-000000000001';
set local role hid_ehr_api_runtime;
select pg_temp.as_staff('staff:e7-doctor', 'e7d30000-0000-4000-8000-000000000001',
  'e7d10000-0000-4000-8000-000000000002', 'direct-care', 'e7-staff-0004');
do $$
begin
  if exists (select 1 from ehr.patient_entry_documents) then raise exception 'The doctor read after the grant ended'; end if;
end $$;
reset role;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('e7c30000-0000-4000-8000-000000000002', 'e7b10000-0000-4000-8000-000000000001', 'e7d20000-0000-4000-8000-000000000001',
   'e7a10000-0000-4000-8000-000000000006', 'e7d30000-0000-4000-8000-000000000001', 'e7d10000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Files test grant again', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'e7-grant-0002', 'hid');
set local role hid_ehr_api_runtime;
do $$
begin
  perform pg_temp.as_p(1, 'e7-withdraw-0003');
  if (select outcome from ehr.withdraw_my_patient_entry((select id from e7_ids where name = 'entry_s'))) <> 'withdrawn' then
    raise exception 'Removing S''s first record';
  end if;
  perform pg_temp.as_p(1, 'e7-withdraw-0004');
  if exists (select 1 from ehr.patient_entry_documents) or exists (select 1 from ehr.patient_entry_document_extractions)
     or exists (select 1 from ehr.patient_entry_document_scan_events) then
    raise exception 'S still reads a removed record''s clean file, its reading or its scans';
  end if;
  perform pg_temp.as_staff('staff:e7-doctor', 'e7d30000-0000-4000-8000-000000000001',
    'e7d10000-0000-4000-8000-000000000002', 'direct-care', 'e7-staff-0005');
  if exists (select 1 from ehr.patient_entries where patient_id = 'e7b10000-0000-4000-8000-000000000001')
     or exists (select 1 from ehr.patient_entry_documents) then
    raise exception 'The doctor reads a removed record''s file';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from ehr.patient_entry_documents where patient_id = 'e7b10000-0000-4000-8000-000000000001') <> 4 then
    raise exception 'S''s files were not all kept';
  end if;
end $$;

-- 9. No row locks on FORCE-RLS tables without an UPDATE policy: every table a
-- new command locks (FOR UPDATE / FOR SHARE) is forced-RLS with the owner's
-- FOR ALL policy for the command's owner; the commands above ran under this
-- database's owner, named here.
do $$
declare
  owner_role text := (select proowner::regrole::text from pg_proc
                       where oid = 'ehr.complete_my_patient_entry_document(uuid,uuid,text,bigint,text)'::regprocedure);
  locked text;
  mismatch text;
begin
  select string_agg(distinct proc.proname || '>' || table_name, ', ') into locked
    from pg_proc proc,
         lateral (select (regexp_matches(proc.prosrc, 'from (ehr\.[a-z_]+) [a-z_]+\s+where[^;]*?for (?:update|share)', 'g'))[1]
                    as table_name) locks
   where proc.pronamespace = 'ehr'::regnamespace
     and proc.proname in ('create_my_patient_entry_document_intent', 'complete_my_patient_entry_document',
       'resolve_patient_entry_document_scan_target', 'list_patient_entry_documents_awaiting_scan',
       'append_patient_entry_document_scan_event');
  if locked is distinct from 'append_patient_entry_document_scan_event>ehr.patient_entry_documents, '
       || 'complete_my_patient_entry_document>ehr.patient_entry_documents' then
    raise exception 'The new commands lock %', coalesce(locked, 'nothing');
  end if;
  select string_agg(relation.oid::regclass::text, ', ') into mismatch
    from pg_class relation
   where relation.oid = 'ehr.patient_entry_documents'::regclass
     and not exists (select 1 from pg_policy policy
                      where policy.polrelid = relation.oid and policy.polcmd in ('*', 'w') and policy.polpermissive
                        and pg_get_expr(policy.polqual, policy.polrelid) = format('(CURRENT_USER = %L::name)', owner_role));
  if mismatch is not null then raise exception 'A locked table has no UPDATE policy for its owner: %', mismatch; end if;
  raise notice 'Patient entry documents: the commands ran under their owner %, superuser %, bypassrls %', owner_role,
    (select rolsuper from pg_roles where rolname = owner_role), (select rolbypassrls from pg_roles where rolname = owner_role);
end $$;

-- 11. Audit: one row per new file and per confirm, the patient actor, no file
-- name; the scanner's rows on the file.
do $$
declare file_s uuid := (select id from e7_ids where name = 'file_s');
begin
  if (select count(*) from audit.events where action = 'ehr.patient-entry.document.upload-intent'
        and outcome = 'success' and resource_id = file_s::text) <> 1
     or (select count(*) from audit.events where action = 'ehr.patient-entry.document.upload-complete'
        and resource_id = file_s::text) <> 1
     or exists (select 1 from audit.events where action like 'ehr.patient-entry.document.%'
        and correlation_id in ('e7-replay-0001', 'e7-replay-0002', 'e7-replay-0003', 'e7-complete-0002',
          'e7-limit-replay', 'e7-limit-replay-removed'))
     or exists (select 1 from audit.events where action like 'ehr.patient-entry.document.%'
        and correlation_id like 'e7-refuse-%') then
    raise exception 'The file audit rows are not one per new file and per confirm';
  end if;
  if exists (select 1 from audit.events where action like 'ehr.patient-entry.document.%'
              and (actor_type <> 'patient' or purpose_of_use <> 'patient-self' or resource_type <> 'patient-entry-document'
                or patient_id is null or actor_account_id is null))
     or exists (select 1 from audit.events where action like 'ehr.patient-entry.document.%'
              and details::text ~* 'scan-|\.jpg|\.png|\.pdf|yesterday|nnnn') then
    raise exception 'The file audit rows are wrong or carry a file name';
  end if;
  if (select string_agg(action, ',' order by sequence_id) from audit.events
       where resource_type = 'patient-entry-document' and resource_id = file_s::text and actor_type = 'workload')
     is distinct from 'ehr.document.scan-target.resolve,ehr.document.scan.scan_started,'
       || 'ehr.document.scan.idempotent-replay,ehr.document.scan.clean' then
    raise exception 'The scanner''s audit rows: %', (select string_agg(action, ',' order by sequence_id)
      from audit.events where resource_type = 'patient-entry-document' and resource_id = file_s::text
        and actor_type = 'workload');
  end if;
end $$;

do $$ begin raise notice 'Patient entry documents suite: passed'; end $$;
rollback;
