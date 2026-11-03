\set ON_ERROR_STOP on
-- Records patients add themselves, text only (0116; Akos handover step 6,
-- owner decision 25, D7: a removed entry is hidden everywhere and kept).
-- Rollback-only; synthetic values only; uuid prefix e6. The EHR commands run
-- as hid_ehr_api_runtime, as ehr-api runs them.
--   1. Shape and privileges: forced RLS with two policies, the no-delete,
--      no-truncate and one-way-update triggers; SELECT only for the EHR
--      runtime and the schema test runtime and no write privilege for any
--      runtime; the two commands executable by exactly those two roles; the
--      guard by none; the commands SECURITY DEFINER on pg_catalog, pg_temp.
--   2. The patient adds entries and reads them back in their own context.
--   3. Refusals: another patient's id, a revoked session, no correlation id;
--      another patient's context sees nothing.
--   4. Idempotency: a replay (one row, one audit row), a reused key (nothing
--      written), a no-key double tap within 60 seconds, an older no-key
--      twin (a new entry), a removed no-key twin (a new entry).
--   5. 30 a day: withdrawn rows count, a row 25 hours old does not; the
--      31st is limited, writes no row and is audited as denied.
--   6. Invalid input refused (22023): kind, title length and line breaks,
--      control characters, notes length and tab, a facility name too long,
--      dates before 1900 or after today in Lagos, a malformed key or digest.
--   7. Withdraw: withdrawn, then replayed with the first time; another
--      patient's entry and an unknown one are not found; hidden from the
--      patient and the doctor and kept; withdrawn to active, any other change,
--      DELETE and TRUNCATE refused; the runtime cannot write the table.
--   8. The doctor's read: at the facility with the grant for direct care;
--      nothing at another facility, for another purpose or after the grant
--      ends.
--   9. Audit: action names, the patient actor, no typed text in details; the
--      doctor's ehr.record.read on patient-entries is a view in the patient's
--      access log.
--  10. Chat evidence: patient_entry is a source kind of both chunk tables
--      (any other new kind still refused), the CHECKs are validated with the
--      expected definition, and a withdrawal removes the patient's own
--      chunks of that entry only.
set plpgsql.variable_conflict = error;
begin;
set constraints all deferred;

-- 1. Shape and privileges.
do $$
declare
  mismatch text;
  role_name text;
  proc_name text;
  commands text[] := array['ehr.create_my_patient_entry(text,text,text,date,text,text,text)',
    'ehr.withdraw_my_patient_entry(uuid)'];
begin
  if not exists (select 1 from pg_class where oid = 'ehr.patient_entries'::regclass
                  and relrowsecurity and relforcerowsecurity) then
    raise exception 'ehr.patient_entries is not under forced row-level security';
  end if;
  select string_agg(policyname || ':' || cmd, ', ' order by policyname) into mismatch
    from pg_policies where schemaname = 'ehr' and tablename = 'patient_entries';
  if mismatch is distinct from 'patient_entries_owner:ALL, patient_entries_read:SELECT' then
    raise exception 'ehr.patient_entries policies: %', mismatch;
  end if;
  if (select qual from pg_policies where schemaname = 'ehr' and tablename = 'patient_entries'
        and policyname = 'patient_entries_read')
     is distinct from '((status = ''active''::text) AND ehr.imported_record_read_context(patient_id))' then
    raise exception 'The read policy is not active entries in a patient-self or consented read';
  end if;
  select string_agg(tgname, ', ' order by tgname) into mismatch
    from pg_trigger where tgrelid = 'ehr.patient_entries'::regclass and not tgisinternal and tgenabled = 'O';
  if mismatch is distinct from 'patient_entries_no_delete, patient_entries_no_truncate, patient_entries_one_way' then
    raise exception 'ehr.patient_entries triggers: %', mismatch;
  end if;
  select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public') || ':' || privilege.privilege_type,
      ', ' order by privilege.grantee::regrole::text, privilege.privilege_type) into mismatch
    from pg_class relation, aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
   where relation.oid = 'ehr.patient_entries'::regclass and privilege.grantee <> relation.relowner;
  if mismatch is distinct from 'hid_ehr_runtime:SELECT, hid_schema_test_runtime:SELECT' then
    raise exception 'ehr.patient_entries is granted as %', coalesce(mismatch, 'nothing');
  end if;
  foreach role_name in array array['hid_ehr_api_runtime', 'hid_identity_api_runtime', 'hid_lab_api_runtime',
      'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_ocr_api_runtime', 'hid_notification_worker',
      'hid_event_dispatcher', 'hid_schema_test_runtime', 'hid_ehr_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name)
       and has_table_privilege(role_name, 'ehr.patient_entries', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      raise exception '% may write ehr.patient_entries', role_name;
    end if;
  end loop;
  if not has_table_privilege('hid_ehr_api_runtime', 'ehr.patient_entries', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'ehr.patient_entries', 'SELECT')
     or has_table_privilege('hid_lab_api_runtime', 'ehr.patient_entries', 'SELECT') then
    raise exception 'Only the EHR runtime may read ehr.patient_entries';
  end if;
  select string_agg(expected, ', ') into mismatch
    from unnest(commands) expected
    left join pg_proc proc on proc.oid = to_regprocedure(expected)
   where proc.oid is null or not proc.prosecdef
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  if mismatch is not null then raise exception 'Commands without SECURITY DEFINER or search_path: %', mismatch; end if;
  foreach proc_name in array commands loop
    select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
        order by privilege.grantee::regrole::text) into mismatch
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
     where p.oid = proc_name::regprocedure and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner;
    if mismatch is distinct from 'hid_ehr_runtime, hid_schema_test_runtime' then
      raise exception '% is executable by %', proc_name, coalesce(mismatch, 'its owner only');
    end if;
    if not has_function_privilege('hid_ehr_api_runtime', proc_name, 'EXECUTE')
       or has_function_privilege('hid_identity_api_runtime', proc_name, 'EXECUTE')
       or has_function_privilege('hid_lab_api_runtime', proc_name, 'EXECUTE') then
      raise exception '% is not the EHR runtime''s alone', proc_name;
    end if;
  end loop;
  select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', ') into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
   where p.oid = 'ehr.patient_entries_guard()'::regprocedure and privilege.privilege_type = 'EXECUTE'
     and privilege.grantee <> p.proowner;
  if mismatch is not null then raise exception 'The guard is executable by %', mismatch; end if;
end $$;

-- Transaction contexts as the services set them.
create function pg_temp.as_patient(subject text, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.correlation_id', correlation, true);
$$;
-- EHR's withPatientTransaction.
create function pg_temp.as_ehr_patient(subject text, account text, session text, patient text, correlation text)
returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.account_id', account, true),
    set_config('app.session_id', session, true), set_config('app.patient_id', patient, true),
    set_config('app.correlation_id', correlation, true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '30 seconds')::text, true),
    set_config('app.purpose_of_use', 'patient-self', true), set_config('app.facility_id', '', true),
    set_config('app.membership_id', '', true);
$$;
-- EHR's withTransaction for a clinician (the staff route and staff chat).
create function pg_temp.as_staff(subject text, membership text, facility text, purpose text, correlation text)
returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
    set_config('app.membership_id', membership, true), set_config('app.purpose_of_use', purpose, true),
    set_config('app.correlation_id', correlation, true), set_config('app.patient_id', '', true),
    set_config('app.account_id', '', true), set_config('app.session_id', '', true),
    set_config('app.self_authorized_until', '', true);
$$;
create function pg_temp.sqlstate_of(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- S in their own context (the default session, correlation e6-...).
create function pg_temp.as_s(correlation text) returns void language sql as $$
  select pg_temp.as_ehr_patient('patient:e6a10000-0000-4000-8000-000000000001', 'e6a10000-0000-4000-8000-000000000001',
    'e6f10000-0000-4000-8000-000000000001', 'e6b10000-0000-4000-8000-000000000001', correlation);
$$;
-- The create command's answer as 'outcome|id' (id empty when none), or the error.
create function pg_temp.add(kind text, title text, facility text, occurred date, notes text, idem text, digest text)
returns text language plpgsql as $$
declare answer record;
begin
  select * into answer from ehr.create_my_patient_entry(kind, title, facility, occurred, notes, idem, digest);
  return format('%s|%s', answer.outcome, coalesce(answer.entry_id::text, ''));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.withdraw(entry uuid) returns text language plpgsql as $$
declare answer record;
begin
  select * into answer from ehr.withdraw_my_patient_entry(entry);
  return format('%s|%s|%s', answer.outcome, coalesce(answer.entry_id::text, ''),
    coalesce(answer.entry_withdrawn_at::text, ''));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.vector() returns public.vector language sql as $$
  select ('[' || array_to_string(array_fill(0::real, array[1024]), ',') || ']')::public.vector;
$$;
create temporary table e6_ids (name text primary key, id uuid not null);
grant all on e6_ids to public;
grant execute on function pg_temp.as_patient(text, text), pg_temp.as_ehr_patient(text, text, text, text, text),
  pg_temp.as_staff(text, text, text, text, text), pg_temp.sqlstate_of(text), pg_temp.as_s(text),
  pg_temp.add(text, text, text, date, text, text, text), pg_temp.withdraw(uuid), pg_temp.vector() to public;

-- Fixtures. Accounts e6a1...: 1 patient S, 2 patient N (the daily limit),
-- 4 another patient O, 6 the doctor D.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'entries-test') on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system) values
  ('e6a10000-0000-4000-8000-000000000001', 'patient:e6a10000-0000-4000-8000-000000000001', 'e6.s@example.invalid',
   'Sade Entries', 'active', clock_timestamp(), 'hid'),
  ('e6a10000-0000-4000-8000-000000000002', 'patient:e6a10000-0000-4000-8000-000000000002', 'e6.n@example.invalid',
   'Nkem Entries', 'active', clock_timestamp(), 'hid'),
  ('e6a10000-0000-4000-8000-000000000004', 'patient:e6a10000-0000-4000-8000-000000000004', 'e6.o@example.invalid',
   'Ola Entries', 'active', clock_timestamp(), 'hid'),
  ('e6a10000-0000-4000-8000-000000000006', 'staff:e6-doctor', 'e6-doctor@example.invalid',
   'Entries Doctor', 'active', clock_timestamp(), 'hid');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system) values
  ('e6b10000-0000-4000-8000-000000000001', 'e6a10000-0000-4000-8000-000000000001', 'HID-ESADEA', 'Sade', 'Entries',
   'Sade Entries', 'active', 'hid'),
  ('e6b10000-0000-4000-8000-000000000002', 'e6a10000-0000-4000-8000-000000000002', 'HID-ENKEMB', 'Nkem', 'Entries',
   'Nkem Entries', 'active', 'hid'),
  ('e6b10000-0000-4000-8000-000000000004', 'e6a10000-0000-4000-8000-000000000004', 'HID-EWLAAC', 'Ola', 'Entries',
   'Ola Entries', 'active', 'hid');
insert into identity.organizations (id, name, slug) values
  ('e6d10000-0000-4000-8000-000000000001', 'Entries Test Org', 'e6-entries-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e6d10000-0000-4000-8000-000000000002', 'e6d10000-0000-4000-8000-000000000001', 'Entries Test Hospital', 'E6P-H',
   'Africa/Lagos', true, 'verified'),
  ('e6d10000-0000-4000-8000-000000000003', 'e6d10000-0000-4000-8000-000000000001', 'Entries Other Clinic', 'E6P-C',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e6d20000-0000-4000-8000-000000000001', 'e6a10000-0000-4000-8000-000000000006', 'Entries Doctor',
   'e6-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('e6d30000-0000-4000-8000-000000000001', 'e6d20000-0000-4000-8000-000000000001', 'e6a10000-0000-4000-8000-000000000006',
   'e6d10000-0000-4000-8000-000000000001', 'e6d10000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true),
  ('e6d30000-0000-4000-8000-000000000002', 'e6d20000-0000-4000-8000-000000000001', 'e6a10000-0000-4000-8000-000000000006',
   'e6d10000-0000-4000-8000-000000000001', 'e6d10000-0000-4000-8000-000000000003', 'doctor', 'doctor', false, true);
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('e6c30000-0000-4000-8000-000000000001', 'e6b10000-0000-4000-8000-000000000001', 'e6d20000-0000-4000-8000-000000000001',
   'e6a10000-0000-4000-8000-000000000006', 'e6d30000-0000-4000-8000-000000000001', 'e6d10000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Entries test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'e6-grant-0001', 'hid');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id, revoked_at,
  revocation_reason)
select ('e6f10000-0000-4000-8000-00000000000' || n)::uuid, ('e6a10000-0000-4000-8000-00000000000' || n)::uuid,
  ('e6f10000-0000-4000-8000-00000000000' || n)::uuid, md5('e6-' || n) || md5('e6-' || n), gen_random_uuid(), 1,
  'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
  'patient', ('e6b10000-0000-4000-8000-00000000000' || n)::uuid, null, null
  from unnest(array[1, 2, 4]) n;
-- A revoked session of S.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id, revoked_at,
  revocation_reason) values
  ('e6f10000-0000-4000-8000-000000000009', 'e6a10000-0000-4000-8000-000000000001', 'e6f10000-0000-4000-8000-000000000009',
   md5('e6-revoked') || md5('e6-revoked'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'e6b10000-0000-4000-8000-000000000001', clock_timestamp(), 'synthetic-test');

-- 2 to 4, 6 and the first half of 7, as the EHR API runs them.
set local role hid_ehr_api_runtime;
do $$
declare
  answer text;
  first_id uuid;
  tapped_id uuid;
  lagos_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
begin
  -- 2. S adds two entries and reads them back.
  perform pg_temp.as_s('e6-create-0001');
  answer := pg_temp.add('visit', 'Malaria check-up', 'Sunrise Clinic Ikeja', date '2026-10-30',
    'Fever for three days.' || chr(10) || 'Given tablets.', 'e6-key-0001-aaaaaaaa', repeat('a', 64));
  if answer !~ '^created\|' then raise exception 'S''s first entry: %', answer; end if;
  first_id := split_part(answer, '|', 2)::uuid;
  insert into e6_ids values ('first', first_id);
  perform pg_temp.as_s('e6-create-0002');
  answer := pg_temp.add('medicine', 'Amlodipine 5 mg', null, lagos_today, null, 'e6-key-0002-bbbbbbbb', repeat('b', 64));
  if answer !~ '^created\|' then raise exception 'An entry dated today in Lagos: %', answer; end if;
  insert into e6_ids values ('medicine', split_part(answer, '|', 2)::uuid);
  perform pg_temp.as_s('e6-read-0001');
  if (select string_agg(format('%s|%s|%s|%s|%s|%s', kind, title, coalesce(facility_name, '-'), occurred_on,
        coalesce(notes, '-'), status), ';' order by occurred_on desc, created_at desc) from ehr.patient_entries)
     <> format('medicine|Amlodipine 5 mg|-|%s|-|active;visit|Malaria check-up|Sunrise Clinic Ikeja|2026-10-30|'
        || 'Fever for three days.%sGiven tablets.|active', lagos_today, chr(10)) then
    raise exception 'S does not read their own entries back';
  end if;

  -- 3. Refusals: another patient's id, a revoked session, no correlation id.
  perform pg_temp.as_ehr_patient('patient:e6a10000-0000-4000-8000-000000000001', 'e6a10000-0000-4000-8000-000000000001',
    'e6f10000-0000-4000-8000-000000000001', 'e6b10000-0000-4000-8000-000000000004', 'e6-refuse-0001');
  answer := pg_temp.add('visit', 'Not mine', null, date '2026-10-01', null, null, repeat('c', 64));
  if answer not like '42501%' then raise exception 'S added an entry for O: %', answer; end if;
  if pg_temp.withdraw(first_id) not like '42501%' then raise exception 'S withdrew as O'; end if;
  perform pg_temp.as_ehr_patient('patient:e6a10000-0000-4000-8000-000000000001', 'e6a10000-0000-4000-8000-000000000001',
    'e6f10000-0000-4000-8000-000000000009', 'e6b10000-0000-4000-8000-000000000001', 'e6-refuse-0002');
  answer := pg_temp.add('visit', 'Revoked session', null, date '2026-10-01', null, null, repeat('c', 64));
  if answer not like '42501%' then raise exception 'A revoked session added an entry: %', answer; end if;
  if pg_temp.withdraw(first_id) not like '42501%' then raise exception 'A revoked session withdrew'; end if;
  if exists (select 1 from ehr.patient_entries) then raise exception 'A revoked session reads entries'; end if;
  perform pg_temp.as_s('e6-refuse-0003');
  perform set_config('app.correlation_id', '', true);
  answer := pg_temp.add('visit', 'No correlation', null, date '2026-10-01', null, null, repeat('c', 64));
  if answer not like '42501%' then raise exception 'An entry without a correlation id: %', answer; end if;
  perform pg_temp.as_ehr_patient('patient:e6a10000-0000-4000-8000-000000000004', 'e6a10000-0000-4000-8000-000000000004',
    'e6f10000-0000-4000-8000-000000000004', 'e6b10000-0000-4000-8000-000000000004', 'e6-refuse-0004');
  if exists (select 1 from ehr.patient_entries) then raise exception 'O reads S''s entries'; end if;
  if pg_temp.withdraw(first_id) <> format('not_found|%s|', first_id) then
    raise exception 'O''s withdrawal of S''s entry is not not_found';
  end if;

  -- 4. Idempotency.
  perform pg_temp.as_s('e6-replay-0001');
  answer := pg_temp.add('visit', 'Malaria check-up', 'Sunrise Clinic Ikeja', date '2026-10-30',
    'Fever for three days.' || chr(10) || 'Given tablets.', 'e6-key-0001-aaaaaaaa', repeat('a', 64));
  if answer <> format('replayed|%s', first_id) then raise exception 'A replay: %', answer; end if;
  perform pg_temp.as_s('e6-replay-0002');
  answer := pg_temp.add('test', 'Another body', null, date '2026-10-30', null, 'e6-key-0001-aaaaaaaa', repeat('d', 64));
  if answer <> 'key_reused|' then raise exception 'A reused key: %', answer; end if;
  perform pg_temp.as_s('e6-tap-0001');
  answer := pg_temp.add('test', 'Full blood count', 'Lagoon Lab', date '2026-10-29', null, null, repeat('e', 64));
  if answer !~ '^created\|' then raise exception 'A no-key entry: %', answer; end if;
  tapped_id := split_part(answer, '|', 2)::uuid;
  insert into e6_ids values ('tapped', tapped_id);
  perform pg_temp.as_s('e6-tap-0002');
  answer := pg_temp.add('test', 'Full blood count', 'Lagoon Lab', date '2026-10-29', null, null, repeat('e', 64));
  if answer <> format('replayed|%s', tapped_id) then raise exception 'A double tap within 60 seconds: %', answer; end if;
  -- A keyed twin is not a no-key double tap.
  perform pg_temp.as_s('e6-tap-0003');
  answer := pg_temp.add('test', 'Full blood count', 'Lagoon Lab', date '2026-10-29', null, 'e6-key-0003-cccccccc',
    repeat('e', 64));
  if answer !~ '^created\|' or split_part(answer, '|', 2)::uuid = tapped_id then
    raise exception 'A keyed twin of a no-key entry: %', answer;
  end if;

  -- 6. Invalid input (22023), nothing written.
  perform pg_temp.as_s('e6-invalid-0001');
  foreach answer in array array[
      pg_temp.add('xray', 'Chest film', null, date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add(null, 'Chest film', null, date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', 'X', null, date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', repeat('t', 161), null, date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', 'Two' || chr(10) || 'lines', null, date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', 'Bell' || chr(7), null, date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', ' Padded', null, date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', null, null, date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', repeat('h', 161), date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', '', date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', 'Line' || chr(10) || 'break', date '2026-10-01', null, null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', null, date '2026-10-01', repeat('n', 2001), null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', null, date '2026-10-01', 'tab' || chr(9) || 'here', null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', null, date '2026-10-01', '', null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', null, date '1899-12-31', null, null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', null, lagos_today + 1, null, null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', null, null, null, null, repeat('f', 64)),
      pg_temp.add('test', 'Chest film', null, date '2026-10-01', null, 'short', repeat('f', 64)),
      pg_temp.add('test', 'Chest film', null, date '2026-10-01', null, null, repeat('F', 64)),
      pg_temp.add('test', 'Chest film', null, date '2026-10-01', null, null, null)] loop
    if answer not like '22023 PATIENT_ENTRY_INVALID%' then raise exception 'An invalid entry: %', answer; end if;
  end loop;
  -- The limits themselves are accepted: 2 and 160 characters, 2000 of notes, 1 January 1900.
  perform pg_temp.as_s('e6-limits-0001');
  answer := pg_temp.add('other', 'Ok', repeat('h', 160), date '1900-01-01', repeat('n', 1999) || chr(10), null,
    repeat('0', 64));
  if answer !~ '^created\|' then raise exception 'The limits: %', answer; end if;
  answer := pg_temp.add('diagnosis', repeat('t', 160), 'H', date '2026-10-02', repeat('n', 2000), null, repeat('1', 64));
  if answer !~ '^created\|' then raise exception 'The upper limits: %', answer; end if;

  -- 7. Withdraw: first, then again (the first time is kept).
  perform pg_temp.as_s('e6-withdraw-0001');
  answer := pg_temp.withdraw(first_id);
  if answer !~ ('^withdrawn\|' || first_id || '\|.+') then raise exception 'A withdrawal: %', answer; end if;
  perform pg_temp.as_s('e6-withdraw-0002');
  if pg_temp.withdraw(first_id) <> 'already_withdrawn' || substr(answer, length('withdrawn') + 1) then
    raise exception 'A repeated withdrawal: % after %', pg_temp.withdraw(first_id), answer;
  end if;
  if pg_temp.withdraw('e6000000-0000-4000-8000-0000000000ff') <> 'not_found|e6000000-0000-4000-8000-0000000000ff|' then
    raise exception 'An unknown entry is not not_found';
  end if;
  if exists (select 1 from ehr.patient_entries where id = first_id) then
    raise exception 'S still reads the withdrawn entry';
  end if;
  -- A withdrawn no-key twin is not replayed.
  perform pg_temp.as_s('e6-withdraw-0003');
  if pg_temp.withdraw(tapped_id) !~ '^withdrawn\|' then raise exception 'Withdrawing the tapped entry'; end if;
  perform pg_temp.as_s('e6-tap-0004');
  answer := pg_temp.add('test', 'Full blood count', 'Lagoon Lab', date '2026-10-29', null, null, repeat('e', 64));
  if answer !~ '^created\|' or split_part(answer, '|', 2)::uuid = tapped_id then
    raise exception 'A no-key twin of a withdrawn entry: %', answer;
  end if;
  -- The runtime cannot write the table directly.
  if pg_temp.sqlstate_of($q$insert into ehr.patient_entries (patient_id, kind, title, occurred_on,
       created_by_account_id, request_sha256) values ('e6b10000-0000-4000-8000-000000000001', 'visit', 'Direct',
       date '2026-10-01', 'e6a10000-0000-4000-8000-000000000001', repeat('9', 64))$q$) not like '42501%'
     or pg_temp.sqlstate_of($q$update ehr.patient_entries set title = 'Changed'$q$) not like '42501%'
     or pg_temp.sqlstate_of($q$delete from ehr.patient_entries$q$) not like '42501%'
     or pg_temp.sqlstate_of($q$truncate ehr.patient_entries$q$) not like '42501%' then
    raise exception 'The EHR runtime can write ehr.patient_entries directly';
  end if;
end $$;
reset role;

-- 4 (cont.) A no-key twin older than 60 seconds, inserted directly, is not
-- replayed. 7 (cont.) The withdrawn entry is kept, and only active to
-- withdrawn is allowed, even to the table's owner.
insert into ehr.patient_entries (patient_id, kind, title, occurred_on, created_by_account_id, request_sha256, created_at,
  updated_at) values ('e6b10000-0000-4000-8000-000000000001', 'visit', 'Older twin', date '2026-10-03',
  'e6a10000-0000-4000-8000-000000000001', repeat('7', 64), clock_timestamp() - interval '61 seconds',
  clock_timestamp() - interval '61 seconds');
do $$
declare first_id uuid := (select id from e6_ids where name = 'first');
begin
  if (select format('%s|%s', status, withdrawn_at is not null) from ehr.patient_entries where id = first_id)
     <> 'withdrawn|t' then
    raise exception 'The withdrawn entry was not kept as withdrawn';
  end if;
  if pg_temp.sqlstate_of(format($q$update ehr.patient_entries set status = 'active', withdrawn_at = null,
       row_version = row_version + 1 where id = %L$q$, first_id)) not like '55000%'
     or pg_temp.sqlstate_of(format($q$update ehr.patient_entries set title = 'Rewritten' where id = %L$q$,
       (select id from e6_ids where name = 'medicine'))) not like '55000%'
     or pg_temp.sqlstate_of(format($q$update ehr.patient_entries set status = 'withdrawn',
       withdrawn_at = clock_timestamp(), row_version = row_version + 1, title = 'Rewritten' where id = %L$q$,
       (select id from e6_ids where name = 'medicine'))) not like '55000%'
     or pg_temp.sqlstate_of(format($q$update ehr.patient_entries set status = 'withdrawn',
       withdrawn_at = clock_timestamp() where id = %L$q$,
       (select id from e6_ids where name = 'medicine'))) not like '55000%'
     or pg_temp.sqlstate_of(format($q$delete from ehr.patient_entries where id = %L$q$, first_id)) not like '55000%'
     or pg_temp.sqlstate_of($q$truncate ehr.patient_entries$q$) not like '55000%' then
    raise exception 'A withdrawn entry came back, an entry was rewritten, or one was deleted';
  end if;
end $$;
set local role hid_ehr_api_runtime;
do $$
declare answer text;
begin
  perform pg_temp.as_s('e6-tap-0005');
  answer := pg_temp.add('visit', 'Older twin', null, date '2026-10-03', null, null, repeat('7', 64));
  if answer !~ '^created\|' then raise exception 'A no-key twin older than 60 seconds: %', answer; end if;
end $$;
reset role;

-- 5. 30 a day, for N: 29 in the last day (some withdrawn) and one 25 hours old.
insert into ehr.patient_entries (patient_id, kind, title, occurred_on, status, withdrawn_at, created_by_account_id,
  request_sha256, created_at, updated_at)
select 'e6b10000-0000-4000-8000-000000000002', 'other', 'Limit fixture ' || n, date '2026-10-01',
  case when n <= 5 then 'withdrawn' else 'active' end, case when n <= 5 then clock_timestamp() end,
  'e6a10000-0000-4000-8000-000000000002', lpad(to_hex(n), 64, '0'),
  clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
  from generate_series(1, 29) n;
insert into ehr.patient_entries (patient_id, kind, title, occurred_on, created_by_account_id, request_sha256, created_at,
  updated_at) values ('e6b10000-0000-4000-8000-000000000002', 'other', 'Limit fixture old', date '2026-10-01',
  'e6a10000-0000-4000-8000-000000000002', repeat('8', 64), clock_timestamp() - interval '25 hours',
  clock_timestamp() - interval '25 hours');
set local role hid_ehr_api_runtime;
do $$
declare answer text;
begin
  perform pg_temp.as_ehr_patient('patient:e6a10000-0000-4000-8000-000000000002', 'e6a10000-0000-4000-8000-000000000002',
    'e6f10000-0000-4000-8000-000000000002', 'e6b10000-0000-4000-8000-000000000002', 'e6-limit-0001');
  answer := pg_temp.add('visit', 'Thirtieth today', null, date '2026-10-02', null, 'e6-key-limit-00000030',
    repeat('2', 64));
  if answer !~ '^created\|' then raise exception 'The 30th entry of the day: %', answer; end if;
  perform pg_temp.as_ehr_patient('patient:e6a10000-0000-4000-8000-000000000002', 'e6a10000-0000-4000-8000-000000000002',
    'e6f10000-0000-4000-8000-000000000002', 'e6b10000-0000-4000-8000-000000000002', 'e6-limit-0002');
  answer := pg_temp.add('visit', 'Thirty-first', null, date '2026-10-02', null, 'e6-key-limit-00000031', repeat('3', 64));
  if answer <> 'limited|' then raise exception 'The 31st entry of the day: %', answer; end if;
  -- A replay of an earlier key is never limited.
  perform pg_temp.as_ehr_patient('patient:e6a10000-0000-4000-8000-000000000002', 'e6a10000-0000-4000-8000-000000000002',
    'e6f10000-0000-4000-8000-000000000002', 'e6b10000-0000-4000-8000-000000000002', 'e6-limit-0003');
  answer := pg_temp.add('visit', 'Thirtieth today', null, date '2026-10-02', null, 'e6-key-limit-00000030',
    repeat('2', 64));
  if answer !~ '^replayed\|' then raise exception 'A replay at the limit: %', answer; end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from ehr.patient_entries where patient_id = 'e6b10000-0000-4000-8000-000000000002') <> 31
     or exists (select 1 from ehr.patient_entries where title = 'Thirty-first') then
    raise exception 'The limited entry was written';
  end if;
  if (select count(*) from audit.events where correlation_id = 'e6-limit-0002' and action = 'ehr.patient-entry.create'
        and outcome = 'denied' and actor_type = 'patient' and resource_id is null
        and details = '{"reason": "daily_limit", "limit": 30, "windowHours": 24}'::jsonb) <> 1 then
    raise exception 'The limited entry is not audited as denied with counts only';
  end if;
end $$;

-- 4 (cont.) and 9. Exactly one audit row per created entry and per first
-- withdrawal; none for a replay, a reused key or a refusal; no typed text.
do $$
declare first_id uuid := (select id from e6_ids where name = 'first');
begin
  if (select count(*) from audit.events where action = 'ehr.patient-entry.create' and resource_id = first_id::text) <> 1
     or (select count(*) from audit.events where action = 'ehr.patient-entry.create'
           and correlation_id in ('e6-replay-0001', 'e6-replay-0002', 'e6-tap-0002', 'e6-limit-0003')) <> 0
     or (select count(*) from audit.events where action like 'ehr.patient-entry.%'
           and correlation_id like 'e6-refuse-%') <> 0
     or (select count(*) from audit.events where action = 'ehr.patient-entry.withdraw' and resource_id = first_id::text)
        <> 1 then
    raise exception 'The entry audit rows are not one per create and per first withdrawal';
  end if;
  if (select count(*) from ehr.patient_entries where idempotency_key = 'e6-key-0001-aaaaaaaa') <> 1
     or (select count(*) from ehr.patient_entries where request_sha256 = repeat('d', 64)) <> 0 then
    raise exception 'A replay or a reused key wrote a row';
  end if;
  if exists (select 1 from audit.events where action like 'ehr.patient-entry.%'
              and (actor_type <> 'patient' or purpose_of_use <> 'patient-self' or provenance <> 'application'
                or source_system <> 'ehr-api' or resource_type <> 'patient-entry'
                or patient_id is null or actor_account_id is null or actor_subject is null))
     or (select count(*) from audit.events where action = 'ehr.patient-entry.create' and outcome = 'success'
           and resource_id = first_id::text
           and details = '{"kind": "visit", "hasNotes": true, "hasFacilityName": true}'::jsonb) <> 1
     or exists (select 1 from audit.events where action like 'ehr.patient-entry.%'
              and details::text ~* 'malaria|sunrise|fever|tablets|amlodipine|blood count|lagoon|twin|fixture|ikeja') then
    raise exception 'The entry audit rows are wrong or carry typed text';
  end if;
end $$;

-- 8. The doctor's read.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff('staff:e6-doctor', 'e6d30000-0000-4000-8000-000000000001',
  'e6d10000-0000-4000-8000-000000000002', 'direct-care', 'e6-staff-0001');
do $$
begin
  if (select string_agg(title, ';' order by title) from ehr.patient_entries
       where patient_id = 'e6b10000-0000-4000-8000-000000000001') is distinct from
     'Amlodipine 5 mg;Full blood count;Full blood count;Ok;Older twin;Older twin;' || repeat('t', 160) then
    raise exception 'The doctor with a grant does not read S''s active entries: %',
      (select string_agg(title, ';' order by title) from ehr.patient_entries);
  end if;
  if exists (select 1 from ehr.patient_entries where patient_id <> 'e6b10000-0000-4000-8000-000000000001') then
    raise exception 'The doctor reads entries of a patient without a grant';
  end if;
end $$;
select pg_temp.as_staff('staff:e6-doctor', 'e6d30000-0000-4000-8000-000000000002',
  'e6d10000-0000-4000-8000-000000000003', 'direct-care', 'e6-staff-0002');
do $$
begin
  if exists (select 1 from ehr.patient_entries) then raise exception 'The doctor read at a facility without a grant'; end if;
end $$;
select pg_temp.as_staff('staff:e6-doctor', 'e6d30000-0000-4000-8000-000000000001',
  'e6d10000-0000-4000-8000-000000000002', 'healthcare-operations', 'e6-staff-0003');
do $$
begin
  if exists (select 1 from ehr.patient_entries) then raise exception 'The doctor read for another purpose'; end if;
end $$;
reset role;

-- 10. Chat evidence: both chunk tables take patient_entry; the patient's
-- chunks of an entry go when it is withdrawn.
do $$
declare mismatch text;
begin
  select string_agg(format('%s %s %s', conrelid::regclass, convalidated, md5(pg_get_constraintdef(oid))), '; ')
    into mismatch
    from pg_constraint
   where conname = 'patient_evidence_chunks_source_kind_check'
     and conrelid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
     and not (convalidated and md5(pg_get_constraintdef(oid)) = '392152e0fd4834262de048c7b9027151');
  if mismatch is not null
     or (select count(*) from pg_constraint where conname = 'patient_evidence_chunks_source_kind_check'
           and conrelid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)) <> 2 then
    raise exception 'The chunk source-kind CHECKs: %', coalesce(mismatch, 'not one on each table');
  end if;
end $$;
set local role hid_ehr_api_runtime;
do $$
declare
  medicine_id uuid := (select id from e6_ids where name = 'medicine');
  older_id uuid;
begin
  perform pg_temp.as_s('e6-chunks-0001');
  select id into older_id from ehr.patient_entries where title = 'Older twin' order by created_at desc limit 1;
  insert into ehr.patient_evidence_chunks (patient_id, source_kind, source_id, source_version, source_hash, chunk_no,
    model_id, embedding)
  select 'e6b10000-0000-4000-8000-000000000001', 'patient_entry', entry, '1', repeat('a', 64), chunk, 'e6-model',
    pg_temp.vector()
    from unnest(array[medicine_id, older_id]) entry, generate_series(0, 1) chunk;
  if pg_temp.sqlstate_of(format($q$insert into ehr.patient_evidence_chunks (patient_id, source_kind, source_id,
       source_version, source_hash, chunk_no, model_id, embedding) values ('e6b10000-0000-4000-8000-000000000001',
       'patient_entry_x', %L, '1', repeat('a', 64), 0, 'e6-model', pg_temp.vector())$q$, medicine_id))
     not like '23514%' then
    raise exception 'The patient chunks take a kind that is not a source kind';
  end if;
  perform pg_temp.as_s('e6-chunks-0002');
  if pg_temp.withdraw(medicine_id) !~ '^withdrawn\|' then raise exception 'Withdrawing the medicine'; end if;
  perform pg_temp.as_s('e6-chunks-0003');
  if exists (select 1 from ehr.patient_evidence_chunks where source_id = medicine_id)
     or (select count(*) from ehr.patient_evidence_chunks where source_id = older_id) <> 2 then
    raise exception 'A withdrawal did not remove exactly its own entry''s chunks';
  end if;
  if exists (select 1 from ehr.patient_entries where id = medicine_id) then
    raise exception 'The withdrawn medicine is still in S''s evidence';
  end if;
end $$;
select pg_temp.as_staff('staff:e6-doctor', 'e6d30000-0000-4000-8000-000000000001',
  'e6d10000-0000-4000-8000-000000000002', 'direct-care', 'e6-staff-0004');
do $$
begin
  if exists (select 1 from ehr.patient_entries where id in (select id from e6_ids where name in ('first', 'medicine'))) then
    raise exception 'The doctor reads a withdrawn entry';
  end if;
end $$;
reset role;
insert into ehr.staff_evidence_chunks (patient_id, source_kind, source_id, source_version, source_hash, chunk_no,
  model_id, embedding, facility_id, account_id, membership_id, purpose_of_use)
values ('e6b10000-0000-4000-8000-000000000001', 'patient_entry', (select id from e6_ids where name = 'tapped'), '1',
  repeat('a', 64), 0, 'e6-model', pg_temp.vector(), 'e6d10000-0000-4000-8000-000000000002',
  'e6a10000-0000-4000-8000-000000000006', 'e6d30000-0000-4000-8000-000000000001', 'direct-care');
do $$
begin
  if pg_temp.sqlstate_of($q$insert into ehr.staff_evidence_chunks (patient_id, source_kind, source_id, source_version,
       source_hash, chunk_no, model_id, embedding, facility_id, account_id, membership_id, purpose_of_use)
       values ('e6b10000-0000-4000-8000-000000000001', 'patient_entry_x', 'e6000000-0000-4000-8000-0000000000fe', '1',
       repeat('a', 64), 0, 'e6-model', pg_temp.vector(), 'e6d10000-0000-4000-8000-000000000002',
       'e6a10000-0000-4000-8000-000000000006', 'e6d30000-0000-4000-8000-000000000001', 'direct-care')$q$)
     not like '23514%' then
    raise exception 'The staff chunks take a kind that is not a source kind';
  end if;
end $$;

-- 8 (cont.) The grant ends: no more reads.
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(),
  revoked_by = 'e6a10000-0000-4000-8000-000000000001', revoked_reason = 'Synthetic revoke'
 where id = 'e6c30000-0000-4000-8000-000000000001';
set local role hid_ehr_api_runtime;
select pg_temp.as_staff('staff:e6-doctor', 'e6d30000-0000-4000-8000-000000000001',
  'e6d10000-0000-4000-8000-000000000002', 'direct-care', 'e6-staff-0005');
do $$
begin
  if exists (select 1 from ehr.patient_entries) then raise exception 'The doctor read after the grant ended'; end if;
end $$;
reset role;

-- 9 (cont.) The doctor's read as ClinicalRepository records it
-- (ehr.record.read on patient-entries) is a view in the patient's access log.
insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
  organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
  provenance, source_system, details)
values ('e6-staff-0001', 'staff', 'staff:e6-doctor', 'e6a10000-0000-4000-8000-000000000006',
  'e6d30000-0000-4000-8000-000000000001', 'e6d10000-0000-4000-8000-000000000001',
  'e6d10000-0000-4000-8000-000000000002', 'e6b10000-0000-4000-8000-000000000001', 'ehr.record.read', 'success',
  'patient-entries', 'e6b10000-0000-4000-8000-000000000001', 'direct-care', 'application', 'ehr-api',
  '{"entryCount": 6, "more": false}');
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:e6a10000-0000-4000-8000-000000000001', 'e6-access-log-0001');
do $$
declare entry jsonb;
begin
  entry := identity.patient_self_access_log('patient:e6a10000-0000-4000-8000-000000000001',
    'e6f10000-0000-4000-8000-000000000001', 10, null, null) -> 'events' -> 0;
  if entry ->> 'action' <> 'viewed' or entry ->> 'actorKind' <> 'clinician' or entry ->> 'actorName' <> 'Entries Doctor'
     or entry ->> 'facilityName' <> 'Entries Test Hospital' then
    raise exception 'The doctor''s read is not a view in the access log: %', entry;
  end if;
end $$;
reset role;

rollback;
