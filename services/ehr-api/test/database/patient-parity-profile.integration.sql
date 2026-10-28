\set ON_ERROR_STOP on
-- Patient parity with hid-1.0, the profile (0094; owner decisions of
-- 2026-10-28 and the lead's decisions for wave B3). Rollback-only;
-- synthetic values only (contacts are fixed hex lookups and opaque bytes:
-- Identity's keys never reach the database); uuid prefix b3. Identity's
-- commands run as hid_identity_api_runtime, EHR's as hid_ehr_api_runtime.
--   1. Security properties and privileges of the 13 new functions, the
--      two replaced functions and the four tables (forced RLS, no Identity
--      table grant, EHR SELECT only).
--   2. identity.patient_self_contact: email and verification, the phone and
--      the change that wrote it, the photo flag; bound to the live session.
--   3. Email change: start (started, unchanged, rate limited, unavailable
--      recorded, counted and audited as denied, the hourly limit), the
--      pending ciphertext, the delivery outcome (a definitive failure
--      audited), completion (wrong code counted, the fifth invalidates,
--      expiry, a concurrent claim, success): the account email, its
--      verification, the patient's contact email; the old address is free
--      again and sign-in finds the new one; the Google account linked by the
--      old address is unlinked (an explicit link stays), the open recovery
--      code is invalidated, the account's other session families end (the
--      caller's family goes on); audit rows; no delete. The patient links
--      the unlinked Google account again (0059's explicit link, replaced):
--      active, explicit, the notice's evidence, signs in; another account is
--      still refused. A patient account that is also workforce is refused at
--      the start and at completion, and a staff record's email is
--      unavailable.
--   4. Phone change: changed (phone sign-in finds the new number, not the
--      old one; either Nigerian form counts as the current one), unchanged,
--      unavailable in any stored form, the hourly limit; the notice email
--      only when verified; the same number written again when Identity
--      cannot read the stored one.
--   5. Readiness (0057, replaced): stays true after a sign-up patient's email
--      change, a NIN-route patient's phone change and a migrated patient's
--      added contact; 0057's own body would answer false; an unrecorded
--      contact write still answers false.
--   6. Profile details: before a save, a save, a stale version, refusals.
--   7. Photo: set, replace, read, remove; CHECKs; another session.
--   8. EHR health information: the patient's save and read in a fresh
--      patient-self context, stale versions, refusals, no direct write; a
--      clinician with a grant at the facility reads it, without one or at
--      another facility does not; another patient does not; the clinician's
--      ehr.record.read audit row is a view in the patient's access log.
--   9. The account's own unverified email address verified through the
--      email change: started, completed and verified, with nothing unlinked,
--      invalidated or ended and no previous address answered (audited as
--      addressUnchanged); once verified, the same address is unchanged.
set plpgsql.variable_conflict = error;
begin;
set constraints all deferred;

-- 1. Security properties and privileges.
do $$
declare
  mismatch text;
  proc_name text;
  role_name text;
  identity_procs text[] := array[
    'identity.patient_self_contact(text,uuid)', 'identity.my_contact_change_credentials(text,uuid)',
    'identity.start_my_email_change(text,uuid,uuid,text,char,bytea,text,char,text,integer,integer,integer)',
    'identity.read_my_pending_email_change(text,uuid,uuid)',
    'identity.record_my_contact_change_delivery(text,uuid,uuid,text,text)',
    'identity.complete_my_email_change(text,uuid,uuid,char,text)',
    'identity.change_my_phone(text,uuid,uuid,char,char[],bytea,text,boolean)',
    'identity.read_my_profile_details(text,uuid)', 'identity.save_my_profile_details(text,uuid,bigint,text,text)',
    'identity.set_my_profile_photo(text,uuid,bytea,text,char,integer,integer,integer,text)',
    'identity.read_my_profile_photo(text,uuid)', 'identity.remove_my_profile_photo(text,uuid)'];
  ehr_proc text := 'ehr.save_my_reported_health_profile(bigint,text,text,text,text,text,text)';
begin
  select string_agg(expected, ', ') into mismatch
    from unnest(identity_procs || ehr_proc) expected
    left join pg_proc proc on proc.oid = to_regprocedure(expected)
   where proc.oid is null or not proc.prosecdef
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  if mismatch is not null then raise exception 'New functions lost SECURITY DEFINER or search_path: %', mismatch; end if;
  foreach proc_name in array identity_procs loop
    select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
        order by privilege.grantee::regrole::text) into mismatch
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
     where p.oid = proc_name::regprocedure and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner;
    if mismatch is distinct from 'hid_identity_runtime, hid_schema_test_runtime' then
      raise exception '% is executable by %', proc_name, coalesce(mismatch, 'its owner only');
    end if;
    if not has_function_privilege('hid_identity_api_runtime', proc_name, 'EXECUTE') then
      raise exception 'The Identity API runtime cannot run %', proc_name;
    end if;
    foreach role_name in array array['hid_ehr_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime',
        'hid_outreach_api_runtime', 'hid_ocr_api_runtime', 'hid_notification_worker', 'hid_event_dispatcher'] loop
      if has_function_privilege(role_name, proc_name, 'EXECUTE') then
        raise exception 'Unrelated service % can run %', role_name, proc_name;
      end if;
    end loop;
  end loop;
  select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
      order by privilege.grantee::regrole::text) into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
   where p.oid = ehr_proc::regprocedure and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner;
  if mismatch is distinct from 'hid_ehr_runtime, hid_schema_test_runtime' then
    raise exception '% is executable by %', ehr_proc, coalesce(mismatch, 'its owner only');
  end if;
  if not has_function_privilege('hid_ehr_api_runtime', ehr_proc, 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', ehr_proc, 'EXECUTE') then
    raise exception 'The EHR command is not the EHR runtime''s alone';
  end if;
  -- The replaced readiness function keeps 0057's ACL.
  select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
      order by privilege.grantee::regrole::text) into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
   where p.oid = 'identity.patient_contact_lookup_ready()'::regprocedure and privilege.privilege_type = 'EXECUTE'
     and privilege.grantee <> p.proowner;
  if mismatch is distinct from 'hid_identity_runtime, hid_schema_test_runtime'
     or not exists (select 1 from pg_proc where oid = 'identity.patient_contact_lookup_ready()'::regprocedure
       and prosecdef and provolatile = 's'
       and proconfig = '{"search_path=pg_catalog, identity, migration, platform, pg_temp"}'::text[]) then
    raise exception 'The replaced readiness function changed its ACL or security properties: %', mismatch;
  end if;
  -- The replaced explicit Google link keeps 0059's ACL.
  select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
      order by privilege.grantee::regrole::text) into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
   where p.oid = 'auth.link_google_identity_to_patient_account(uuid,text)'::regprocedure
     and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner;
  if mismatch is distinct from 'hid_identity_runtime, hid_schema_test_runtime'
     or not exists (select 1 from pg_proc where oid = 'auth.link_google_identity_to_patient_account(uuid,text)'::regprocedure
       and prosecdef and provolatile = 'v'
       and proconfig = '{"search_path=pg_catalog, auth, identity, audit, platform, pg_temp"}'::text[]) then
    raise exception 'The replaced Google link changed its ACL or security properties: %', mismatch;
  end if;
  -- Forced RLS on the four tables; no runtime holds any privilege on the
  -- three Identity tables; the EHR table is SELECT only.
  if exists (select 1 from pg_class relation
              where relation.oid in ('identity.patient_profile_details'::regclass,
                'identity.patient_profile_photos'::regclass, 'identity.patient_contact_changes'::regclass,
                'ehr.patient_reported_health_profiles'::regclass)
                and not (relation.relrowsecurity and relation.relforcerowsecurity)) then
    raise exception 'A 0094 table is not under forced RLS';
  end if;
  foreach role_name in array array['hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_lab_api_runtime',
      'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_ocr_api_runtime', 'hid_notification_worker',
      'hid_event_dispatcher', 'hid_schema_test_runtime'] loop
    if has_table_privilege(role_name, 'identity.patient_profile_details', 'SELECT, INSERT, UPDATE, DELETE')
       or has_table_privilege(role_name, 'identity.patient_profile_photos', 'SELECT, INSERT, UPDATE, DELETE')
       or has_table_privilege(role_name, 'identity.patient_contact_changes', 'SELECT, INSERT, UPDATE, DELETE')
       or has_table_privilege(role_name, 'ehr.patient_reported_health_profiles', 'INSERT, UPDATE, DELETE, TRUNCATE') then
      raise exception '% holds a privilege on a 0094 table it must not', role_name;
    end if;
  end loop;
  if not has_table_privilege('hid_ehr_api_runtime', 'ehr.patient_reported_health_profiles', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'ehr.patient_reported_health_profiles', 'SELECT')
     or has_table_privilege('hid_lab_api_runtime', 'ehr.patient_reported_health_profiles', 'SELECT') then
    raise exception 'Only the EHR runtime may read the patient-reported health information';
  end if;
end $$;

-- Transaction contexts as the services set them.
create function pg_temp.as_system(correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', correlation, true),
    set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
    set_config('app.purpose_of_use', '', true), set_config('app.patient_id', '', true);
$$;
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
-- EHR's withTransaction for a clinician.
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
grant execute on function pg_temp.as_system(text), pg_temp.as_patient(text, text),
  pg_temp.as_ehr_patient(text, text, text, text, text), pg_temp.as_staff(text, text, text, text, text),
  pg_temp.sqlstate_of(text) to public;

-- Fixtures. Accounts b3a1...n: 1 sign-up patient S (verified email, its
-- sign-up enrollment), 2 NIN-route patient N (no email, a verified phone
-- contact), 3 migrated hid-1.0 patient L (verified email, a phone, no
-- contact email), 4 another patient O (an email, a phone), 5 a staff-only
-- account T (an email), 6 the doctor D, 7 patient U with an unverified email.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'parity-test') on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system,
  password_hash, password_algorithm) values
  ('b3a10000-0000-4000-8000-000000000001', 'patient:b3a10000-0000-4000-8000-000000000001', 's.one@example.invalid',
   'Sade One', 'active', clock_timestamp(), 'hid-public-qoreid-enrollment',
   '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljLXNhbHQ$synthetic-password-digest-not-an-operational-secret', 'argon2id'),
  ('b3a10000-0000-4000-8000-000000000002', 'patient:b3a10000-0000-4000-8000-000000000002', null,
   'Nkem Nin', 'active', null, 'hid-public-qoreid-enrollment',
   '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljLXNhbHQ$synthetic-password-digest-not-an-operational-secret', 'argon2id'),
  ('b3a10000-0000-4000-8000-000000000003', 'b3a10000-0000-4000-8000-000000000003', 'legacy.l@example.invalid',
   'Lami Legacy', 'active', clock_timestamp(), 'legacy_identity',
   '$2b$10$syntheticsyntheticsyntheticsyntheticsyntheticsy', 'bcrypt_legacy'),
  ('b3a10000-0000-4000-8000-000000000004', 'synthetic:b3:other', 'other@example.invalid',
   'Ola Other', 'active', clock_timestamp(), 'hid', null, null),
  ('b3a10000-0000-4000-8000-000000000005', 'synthetic:b3:taken', 'taken@example.invalid',
   'Taken Address', 'active', clock_timestamp(), 'hid', null, null),
  ('b3a10000-0000-4000-8000-000000000006', 'staff:b3-doctor', 'b3-doctor@example.invalid',
   'Profile Doctor', 'active', clock_timestamp(), 'hid', null, null),
  ('b3a10000-0000-4000-8000-000000000007', 'synthetic:b3:unverified', 'u.unverified@example.invalid',
   'Uche Unverified', 'active', null, 'hid', null, null);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system,
  phone_e164_ciphertext, phone_lookup_hmac, email_ciphertext, email_lookup_hmac, contact_key_version) values
  ('b3b10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001', 'HID-SADAAA', 'Sade', 'One',
   'Sade One', 'active', 'hid-public-qoreid-enrollment', decode(repeat('51', 40), 'hex'), repeat('5', 64),
   decode(repeat('e1', 40), 'hex'), repeat('e', 63) || '1', 'fixture'),
  ('b3b10000-0000-4000-8000-000000000002', 'b3a10000-0000-4000-8000-000000000002', 'HID-NKMBBB', 'Nkem', 'Nin',
   'Nkem Nin', 'active', 'hid-public-qoreid-enrollment', decode(repeat('52', 40), 'hex'), repeat('6', 64),
   null, null, 'fixture'),
  ('b3b10000-0000-4000-8000-000000000003', 'b3a10000-0000-4000-8000-000000000003', 'HID-LAMCCC', 'Lami', 'Legacy',
   'Lami Legacy', 'active', 'legacy_identity', decode(repeat('53', 40), 'hex'), repeat('7', 64), null, null, 'legacy-v1'),
  ('b3b10000-0000-4000-8000-000000000004', 'b3a10000-0000-4000-8000-000000000004', 'HID-QLADDD', 'Ola', 'Other',
   'Ola Other', 'active', 'hid', decode(repeat('54', 40), 'hex'), repeat('8', 64),
   decode(repeat('e4', 40), 'hex'), repeat('e', 63) || '4', 'fixture'),
  ('b3b10000-0000-4000-8000-000000000007', 'b3a10000-0000-4000-8000-000000000007', 'HID-UCHEEE', 'Uche', 'Unverified',
   'Uche Unverified', 'active', 'hid', decode(repeat('57', 40), 'hex'), repeat('9', 64), null, null, 'fixture');
-- S's sign-up enrollment (its contact is the email) and N's NIN-route
-- enrollment (its verified contact is the phone), both active.
insert into identity.public_patient_enrollments (id, profile_ciphertext, profile_sha256, key_version, request_hmac,
  token_hmac, state, contact_channel, contact_hmac, contact_lookup_hmac, contact_ciphertext, contact_verified_at,
  patient_id, account_id, activated_at, signup_email_lookup_hmac, signup_phone_lookup_hmac, signup_phone_ciphertext,
  nin_lookup_hmac, nin_last4, nin_ciphertext, provider_reference) values
  ('b3e10000-0000-4000-8000-000000000001', decode(repeat('b1', 32), 'hex'), repeat('a', 64), 'fixture',
   repeat('1', 63) || 'a', repeat('f', 63) || 'a', 'active', 'email', repeat('c', 63) || '1', repeat('e', 63) || '1',
   decode(repeat('e1', 40), 'hex'), clock_timestamp(), 'b3b10000-0000-4000-8000-000000000001',
   'b3a10000-0000-4000-8000-000000000001', clock_timestamp(), repeat('e', 63) || '1', repeat('5', 64),
   decode(repeat('51', 40), 'hex'), null, null, null, null),
  ('b3e10000-0000-4000-8000-000000000002', decode(repeat('b2', 32), 'hex'), repeat('b', 64), 'fixture',
   repeat('1', 63) || 'b', repeat('f', 63) || 'b', 'active', 'phone', repeat('c', 63) || '2', repeat('6', 64),
   decode(repeat('52', 40), 'hex'), clock_timestamp(), 'b3b10000-0000-4000-8000-000000000002',
   'b3a10000-0000-4000-8000-000000000002', clock_timestamp(), null, null, null,
   repeat('d', 63) || '2', '1234', decode(repeat('d2', 40), 'hex'), 'qoreid-b3-fixture');
-- The rekey marker as the one-shot rekey records it for these migrated patients.
insert into migration.patient_contact_lookup_rekeys (source_snapshot, operator, legacy_patient_count,
  legacy_contact_count, enrollment_count)
select 'b3-profile-fixture-snapshot', 'b3-fixture',
  (select count(*) from identity.patients where source_system = 'legacy_identity'),
  (select count(*) from identity.patients patient
     cross join lateral (values (patient.phone_e164_ciphertext), (patient.email_ciphertext)) contact(ciphertext)
    where patient.source_system = 'legacy_identity' and contact.ciphertext is not null),
  (select count(*) from identity.public_patient_enrollments where contact_hmac is not null);
insert into identity.organizations (id, name, slug) values
  ('b3d10000-0000-4000-8000-000000000001', 'Profile Test Org', 'b3-profile-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('b3d10000-0000-4000-8000-000000000002', 'b3d10000-0000-4000-8000-000000000001', 'Profile Test Hospital', 'B3P-H',
   'Africa/Lagos', true, 'verified'),
  ('b3d10000-0000-4000-8000-000000000003', 'b3d10000-0000-4000-8000-000000000001', 'Profile Other Clinic', 'B3P-C',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('b3d20000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000006', 'Profile Doctor',
   'b3-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('b3d30000-0000-4000-8000-000000000001', 'b3d20000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000006',
   'b3d10000-0000-4000-8000-000000000001', 'b3d10000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true),
  ('b3d30000-0000-4000-8000-000000000002', 'b3d20000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000006',
   'b3d10000-0000-4000-8000-000000000001', 'b3d10000-0000-4000-8000-000000000003', 'doctor', 'doctor', false, true);
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('b3c30000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000001', 'b3d20000-0000-4000-8000-000000000001',
   'b3a10000-0000-4000-8000-000000000006', 'b3d30000-0000-4000-8000-000000000001', 'b3d10000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Profile test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'b3-grant-0001', 'hid');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id, revoked_at,
  revocation_reason)
select ('b3f10000-0000-4000-8000-00000000000' || n)::uuid, ('b3a10000-0000-4000-8000-00000000000' || n)::uuid,
  ('b3f10000-0000-4000-8000-00000000000' || n)::uuid, md5('b3-' || n) || md5('b3-' || n), gen_random_uuid(), 1,
  'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
  'patient', ('b3b10000-0000-4000-8000-00000000000' || n)::uuid, null, null
  from unnest(array[1, 2, 3, 4, 7]) n;
-- A revoked session of S.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id, revoked_at,
  revocation_reason) values
  ('b3f10000-0000-4000-8000-000000000009', 'b3a10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-000000000009',
   md5('b3-revoked') || md5('b3-revoked'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'b3b10000-0000-4000-8000-000000000001', clock_timestamp(), 'synthetic-test');
-- S's other live sessions: one in another family (another device) and one
-- in the caller's family (a rotation not yet revoked); an open recovery code
-- and an open email check of S, an open recovery code of O; the Google
-- account linked because Google verified S's address (0093), one S linked
-- explicitly, and O's auto-link.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('b3f10000-0000-4000-8000-00000000001a', 'b3a10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-00000000001a',
   md5('b3-other-device') || md5('b3-other-device'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'b3b10000-0000-4000-8000-000000000001'),
  ('b3f10000-0000-4000-8000-00000000001b', 'b3a10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-000000000001',
   md5('b3-same-family') || md5('b3-same-family'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'b3b10000-0000-4000-8000-000000000001');
insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac, verifier_key_version,
  expires_at, max_attempts, account_token_version) values
  ('b3c90000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001', repeat('1', 64), 'PASSWORD_RESET',
   'email', repeat('2', 64), 'otp-v3', clock_timestamp() + interval '10 minutes', 5, 1),
  ('b3c90000-0000-4000-8000-000000000002', 'b3a10000-0000-4000-8000-000000000001', repeat('1', 64), 'EMAIL_VERIFY',
   'email', repeat('3', 64), 'otp-v3', clock_timestamp() + interval '10 minutes', 5, 1),
  ('b3c90000-0000-4000-8000-000000000003', 'b3a10000-0000-4000-8000-000000000004', repeat('4', 64), 'PASSWORD_RESET',
   'email', repeat('5', 64), 'otp-v3', clock_timestamp() + interval '10 minutes', 5, 1);
insert into auth.external_identities (id, account_id, issuer, subject, status, source_system) values
  ('b3c80000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001', 'https://accounts.google.com',
   'b3-google-auto-s', 'active', 'hid-google-verified-email-link'),
  ('b3c80000-0000-4000-8000-000000000002', 'b3a10000-0000-4000-8000-000000000001', 'https://accounts.google.com',
   'b3-google-explicit-s', 'active', 'hid-google-explicit-link'),
  ('b3c80000-0000-4000-8000-000000000003', 'b3a10000-0000-4000-8000-000000000004', 'https://accounts.google.com',
   'b3-google-auto-o', 'active', 'hid-google-verified-email-link');
-- W: a patient account that is also workforce (hid-1.0 accounts were migrated
-- with both rows on one login), its staff record's address another one.
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system,
  password_hash, password_algorithm) values
  ('b3a10000-0000-4000-8000-000000000009', 'b3a10000-0000-4000-8000-000000000009', 'w.patient@example.invalid',
   'Wale Both', 'active', clock_timestamp(), 'legacy_identity', null, null);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system)
  values ('b3b10000-0000-4000-8000-000000000009', 'b3a10000-0000-4000-8000-000000000009', 'HID-WALGGG', 'Wale', 'Both',
   'Wale Both', 'active', 'hid');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('b3d20000-0000-4000-8000-000000000009', 'b3a10000-0000-4000-8000-000000000009', 'Wale Both',
   'w.staff@example.invalid', 'verified', 'nurse');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('b3f10000-0000-4000-8000-000000000019', 'b3a10000-0000-4000-8000-000000000009', 'b3f10000-0000-4000-8000-000000000019',
   md5('b3-both') || md5('b3-both'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'b3b10000-0000-4000-8000-000000000009');

-- 0057's body, as 0094 found it, to show what the replacement changes.
create function pg_temp.ready_0057() returns boolean language plpgsql as $$
declare legacy_count bigint;
begin
  select count(*) into legacy_count from identity.patients where source_system = 'legacy_identity';
  if legacy_count = 0 and not exists (select 1 from identity.public_patient_enrollments
      where contact_hmac is not null and contact_lookup_hmac is null) then
    return true;
  end if;
  if not exists (select 1 from migration.patient_contact_lookup_rekeys marker
    where marker.legacy_patient_count = legacy_count
      and marker.legacy_contact_count = (select count(*) from identity.patients patient
        cross join lateral (values (patient.phone_e164_ciphertext), (patient.email_ciphertext)) as contact(ciphertext)
        where patient.source_system = 'legacy_identity' and contact.ciphertext is not null)
      and marker.enrollment_count >= (select count(*) from identity.public_patient_enrollments enrollment
        where enrollment.contact_hmac is not null and enrollment.created_at <= marker.created_at)) then
    return false;
  end if;
  if exists (select 1 from identity.patients patient where patient.source_system = 'legacy_identity'
      and ((patient.phone_e164_ciphertext is not null and patient.phone_lookup_hmac is null)
        or (patient.email_ciphertext is not null and patient.email_lookup_hmac is null))) then
    return false;
  end if;
  if exists (select 1 from identity.public_patient_enrollments enrollment
    where enrollment.contact_hmac is not null
      and (enrollment.contact_lookup_hmac is null or (enrollment.state = 'active' and not exists (
        select 1 from identity.patients patient where patient.id = enrollment.patient_id
          and ((enrollment.contact_channel = 'phone' and patient.phone_lookup_hmac = enrollment.contact_lookup_hmac)
            or (enrollment.contact_channel = 'email' and patient.email_lookup_hmac = enrollment.contact_lookup_hmac)))))) then
    return false;
  end if;
  return true;
end $$;
create function pg_temp.readiness() returns text language plpgsql as $$
declare answer boolean;
begin
  perform pg_temp.as_system('b3-readiness-0001');
  set local role hid_identity_api_runtime;
  answer := identity.patient_contact_lookup_ready();
  reset role;
  return format('new=%s old=%s', answer, pg_temp.ready_0057());
end $$;
do $$
begin
  if pg_temp.readiness() <> 'new=t old=t' then
    raise exception 'Readiness before any change: %', pg_temp.readiness();
  end if;
end $$;

-- 2. The profile's contacts, bound to the live session.
create function pg_temp.contact(subject text, session text) returns text language sql as $$
  select coalesce((select format('%s|%s|%s|%s|%s', contact.email, contact.email_verified, contact.phone_lookup_hmac,
      contact.phone_change_id, contact.has_photo)
    from identity.patient_self_contact(subject, session::uuid) contact), 'none');
$$;
grant execute on function pg_temp.contact(text, text) to public;
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-contact-0001');
do $$
begin
  if pg_temp.contact('patient:b3a10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-000000000001')
       <> 's.one@example.invalid|t|' || repeat('5', 64) || '||f' then
    raise exception 'S''s contacts: %', pg_temp.contact('patient:b3a10000-0000-4000-8000-000000000001',
      'b3f10000-0000-4000-8000-000000000001');
  end if;
  if pg_temp.contact('patient:b3a10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-000000000009') <> 'none'
     or pg_temp.contact('patient:b3a10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-000000000004') <> 'none'
     or pg_temp.contact('synthetic:b3:other', 'b3f10000-0000-4000-8000-000000000004') <> 'none' then
    raise exception 'A revoked session, another patient''s session or another subject read contacts';
  end if;
  if (select count(*) from identity.my_contact_change_credentials('patient:b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001') credentials
       where credentials.password_algorithm = 'argon2id' and credentials.patient_hid_code = 'HID-SADAAA'
         and credentials.email = 's.one@example.invalid' and credentials.email_verified) <> 1
     or exists (select 1 from identity.my_contact_change_credentials('patient:b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000009')) then
    raise exception 'The contact-change credentials are not the live session''s account''s';
  end if;
end $$;
reset role;

-- 3. Email change of S (a sign-up patient): new@ then a code.
create function pg_temp.start_email(n integer, email text, lookup text) returns text language plpgsql as $$
begin
  return identity.start_my_email_change('patient:b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', ('b3c10000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
    email, lookup, decode(repeat('c' || (n % 10)::text, 40), 'hex'), 'nin-v7', repeat('a', 63) || (n % 10)::text,
    'otp-v3', 300, 5, 60);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.complete_email(n integer, verifier text, email text) returns text language plpgsql as $$
declare outcome record;
begin
  select * into outcome from identity.complete_my_email_change('patient:b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', ('b3c10000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
    verifier, email);
  return format('%s|%s|%s|%s|%s', outcome.outcome, outcome.email, outcome.previous_email, outcome.patient_first_name,
    outcome.patient_hid_code);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.start_email(integer, text, text), pg_temp.complete_email(integer, text, text) to public;
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-email-0001');
do $$
declare answer text;
begin
  -- The account's own address (any case) is unchanged; nothing is recorded.
  answer := pg_temp.start_email(1, 'S.One@Example.invalid', repeat('e', 63) || '1');
  if answer <> 'unchanged' then raise exception 'Own email: %', answer; end if;
  -- Another account's email, or another patient's contact email: refused and recorded.
  answer := pg_temp.start_email(2, 'taken@example.invalid', repeat('a', 63) || '2');
  if answer <> 'unavailable' then raise exception 'Another account''s email: %', answer; end if;
  -- A refused start counts toward the resend window, so the next one waits.
  if identity.start_my_email_change('patient:b3a10000-0000-4000-8000-000000000001',
       'b3f10000-0000-4000-8000-000000000001', 'b3c10000-0000-4000-8000-000000000098', 'y@example.invalid',
       repeat('b', 64), decode(repeat('c1', 40), 'hex'), 'nin-v7', repeat('a', 64), 'otp-v3', 300, 5, 60)
       <> 'rate_limited' then
    raise exception 'A second start within the resend window was not rate limited';
  end if;
  -- A malformed start and another session are refused outright.
  answer := pg_temp.sqlstate_of($q$select identity.start_my_email_change('patient:b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', 'b3c10000-0000-4000-8000-000000000097', 'not-an-email',
    repeat('a', 64), decode(repeat('c1', 40), 'hex'), 'nin-v7', repeat('a', 64), 'otp-v3', 300, 5, 60)$q$);
  if answer not like '22023 PATIENT_CONTACT_CHANGE_INVALID%' then raise exception 'A malformed start: %', answer; end if;
  answer := pg_temp.sqlstate_of($q$select identity.start_my_email_change('patient:b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000009', 'b3c10000-0000-4000-8000-000000000096', 'z@example.invalid',
    repeat('a', 64), decode(repeat('c1', 40), 'hex'), 'nin-v7', repeat('a', 64), 'otp-v3', 300, 5, 60)$q$);
  if answer not like '42501%' then raise exception 'A revoked session started a change: %', answer; end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from identity.patient_contact_changes
       where patient_id = 'b3b10000-0000-4000-8000-000000000001' and channel = 'email') <> 1
     or not exists (select 1 from identity.patient_contact_changes
       where id = 'b3c10000-0000-4000-8000-000000000002' and state = 'invalidated'
         and invalidation_reason = 'contact_unavailable' and new_ciphertext is null) then
    raise exception 'The refused starts were not recorded without their address';
  end if;
  -- The refused start is audited as denied, without the address; the
  -- unchanged and rate-limited ones wrote nothing and are not.
  if (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
       and action = 'identity.patient.contact-change.start' and outcome = 'denied'
       and resource_id = 'b3c10000-0000-4000-8000-000000000002'
       and details = '{"channel": "email", "result": "unavailable"}'::jsonb) <> 1
     or (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
       and action like 'identity.patient.contact-change.%') <> 1 then
    raise exception 'The refused start was not audited as denied (exactly)';
  end if;
end $$;
-- The window has passed (as if 61 seconds ago).
update identity.patient_contact_changes set created_at = created_at - interval '61 seconds',
  expires_at = expires_at - interval '61 seconds', invalidated_at = invalidated_at - interval '61 seconds'
 where patient_id = 'b3b10000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-email-0002');
do $$
declare answer text;
begin
  answer := pg_temp.start_email(3, 'New.Address@Example.invalid', repeat('a', 63) || '3');
  if answer <> 'started' then raise exception 'A start: %', answer; end if;
  if (select count(*) from identity.read_my_pending_email_change('patient:b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001', 'b3c10000-0000-4000-8000-000000000003') pending
       where pending.new_ciphertext = decode(repeat('c3', 40), 'hex') and pending.key_version = 'nin-v7') <> 1
     or exists (select 1 from identity.read_my_pending_email_change('patient:b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000009', 'b3c10000-0000-4000-8000-000000000003')) then
    raise exception 'The pending ciphertext is not the live session''s';
  end if;
  perform identity.record_my_contact_change_delivery('patient:b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', 'b3c10000-0000-4000-8000-000000000003', 'accepted', 'brevo');
  -- Four wrong codes count; the right one then completes.
  for attempt in 1..4 loop
    answer := pg_temp.complete_email(3, repeat('0', 64), 'new.address@example.invalid');
    if answer <> 'invalid||||' then raise exception 'Wrong code %: %', attempt, answer; end if;
  end loop;
  answer := pg_temp.complete_email(3, repeat('a', 63) || '3', 'new.address@example.invalid');
  if answer <> 'completed|new.address@example.invalid|s.one@example.invalid|Sade|HID-SADAAA' then
    raise exception 'The right code: %', answer;
  end if;
  answer := pg_temp.complete_email(3, repeat('a', 63) || '3', 'new.address@example.invalid');
  if answer <> 'invalid||||' then raise exception 'A replay: %', answer; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from auth.accounts where id = 'b3a10000-0000-4000-8000-000000000001'
       and email = 'new.address@example.invalid' and email_verified_at > clock_timestamp() - interval '1 minute')
     or not exists (select 1 from identity.patients where id = 'b3b10000-0000-4000-8000-000000000001'
       and email_lookup_hmac = repeat('a', 63) || '3' and email_ciphertext = decode(repeat('c3', 40), 'hex')
       and contact_key_version = 'fixture')
     or not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000003'
       and state = 'completed' and replaced_contact and failed_attempts = 4 and delivery_outcome = 'accepted'
       and delivery_provider = 'brevo')
     or (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
          and action = 'identity.patient.contact-change.verify' and outcome = 'denied') <> 5
     or (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
          and action = 'identity.patient.contact-change.complete' and outcome = 'success'
          and details = '{"channel": "email", "result": "completed", "otherSessionsRevoked": 1,
            "recoveryCodesInvalidated": 1, "googleLinksRevoked": 1}'::jsonb) <> 1
     or (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
          and action = 'identity.patient.contact-change.start' and outcome = 'success'
          and resource_id = 'b3c10000-0000-4000-8000-000000000003') <> 1
     or exists (select 1 from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
          and action like 'identity.patient.contact-change.%' and details::text ~ '@|[0-9a-f]{64}') then
    raise exception 'The completed email change did not write exactly the new address (and no address in audit)';
  end if;
  -- Sign-in (lower(email)) and recovery find the new address; the old one is free.
  if (select count(*) from auth.accounts where lower(email) = 'new.address@example.invalid' and status <> 'deleted') <> 1
     or exists (select 1 from auth.accounts where lower(email) = 's.one@example.invalid' and status <> 'deleted') then
    raise exception 'Sign-in does not use the new address only';
  end if;
  -- The Google account Google verified the old address for no longer signs
  -- in; the one S linked and O's stay; audited.
  if not exists (select 1 from auth.external_identities where id = 'b3c80000-0000-4000-8000-000000000001'
       and status = 'revoked' and revoked_at > clock_timestamp() - interval '1 minute')
     or (select count(*) from auth.external_identities
          where id in ('b3c80000-0000-4000-8000-000000000002', 'b3c80000-0000-4000-8000-000000000003')
            and status = 'active' and revoked_at is null) <> 2
     or (select count(*) from audit.events where actor_account_id = 'b3a10000-0000-4000-8000-000000000001'
          and action = 'auth.google.auto-link.revoke' and outcome = 'success'
          and resource_id = 'b3a10000-0000-4000-8000-000000000001'
          and details = '{"reason": "email_changed", "revoked": 1}'::jsonb) <> 1 then
    raise exception 'The Google link of the old address survived the change, or another link did not';
  end if;
  -- The recovery code sent to the old address no longer completes; S's
  -- email check and O's recovery code are untouched.
  if not exists (select 1 from auth.otp_challenges where id = 'b3c90000-0000-4000-8000-000000000001'
       and invalidated_at is not null and invalidation_reason = 'completed' and consumed_at is null)
     or (select count(*) from auth.otp_challenges
          where id in ('b3c90000-0000-4000-8000-000000000002', 'b3c90000-0000-4000-8000-000000000003')
            and invalidated_at is null) <> 2 then
    raise exception 'Open recovery codes of the old address survived the change, or others did not';
  end if;
  -- S's session on another device ends; the caller's family (its session and
  -- a rotation) goes on, and token_version is unchanged; O's session stays.
  if not exists (select 1 from auth.sessions where id = 'b3f10000-0000-4000-8000-00000000001a'
       and revoked_at is not null and revocation_reason = 'contact_changed')
     or (select count(*) from auth.sessions
          where id in ('b3f10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-00000000001b',
                       'b3f10000-0000-4000-8000-000000000004')
            and revoked_at is null) <> 3
     or (select token_version from auth.accounts where id = 'b3a10000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'The other sessions did not end, or the caller''s family did';
  end if;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-email-0002b');
do $$
begin
  -- The ended session can no longer read the contacts; the caller's can.
  if pg_temp.contact('patient:b3a10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-00000000001a') <> 'none'
     or pg_temp.contact('patient:b3a10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-000000000001') = 'none' then
    raise exception 'The session family rule is not what the patient session reads';
  end if;
end $$;
reset role;
-- S links the Google account the change unlinked again (0059's explicit link,
-- replaced: Identity checked the password first). While S has another Google
-- account linked, 0059's rule refuses it; once that one is gone, the revoked
-- row becomes S's explicit link, linked now (the SECURITY_GOOGLE_LINKED
-- notice's evidence: the old linked_at is a day back), and sign-in finds it.
-- Another account can never take it.
update auth.external_identities set linked_at = linked_at - interval '1 day'
 where id = 'b3c80000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
select pg_temp.as_system('b3-google-relink-0001');
do $$
declare answer text;
begin
  if exists (select 1 from auth.resolve_google_identity('b3-google-auto-s')) then
    raise exception 'The unlinked Google account still signs in';
  end if;
  answer := pg_temp.sqlstate_of($q$select auth.link_google_identity_to_patient_account(
    'b3a10000-0000-4000-8000-000000000001', 'b3-google-auto-s')$q$);
  if answer not like '23505 GOOGLE_ACCOUNT_ALREADY_LINKED%' then
    raise exception 'S linked a second Google account: %', answer;
  end if;
  answer := pg_temp.sqlstate_of($q$select auth.link_google_identity_to_patient_account(
    'b3a10000-0000-4000-8000-000000000003', 'b3-google-auto-s')$q$);
  if answer not like '23505 GOOGLE_IDENTITY_ALREADY_LINKED%' then
    raise exception 'Another account linked S''s unlinked Google account: %', answer;
  end if;
end $$;
reset role;
update auth.external_identities set status = 'revoked', revoked_at = clock_timestamp()
 where id = 'b3c80000-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
select pg_temp.as_system('b3-google-relink-0002');
do $$
declare answer text;
begin
  if not auth.link_google_identity_to_patient_account('b3a10000-0000-4000-8000-000000000001', 'b3-google-auto-s') then
    raise exception 'S could not link its own unlinked Google account again';
  end if;
  if auth.record_account_security_notice('b3a10000-0000-4000-8000-000000000001', 'SECURITY_GOOGLE_LINKED') is null then
    raise exception 'The link again is no evidence for the SECURITY_GOOGLE_LINKED notice';
  end if;
  if (select account_id from auth.resolve_google_identity('b3-google-auto-s')) <> 'b3a10000-0000-4000-8000-000000000001' then
    raise exception 'Sign-in does not find the Google account linked again';
  end if;
  -- Linked now: S again and another account are refused, as 0059 refuses.
  answer := pg_temp.sqlstate_of($q$select auth.link_google_identity_to_patient_account(
    'b3a10000-0000-4000-8000-000000000001', 'b3-google-auto-s')$q$);
  if answer not like '23505 GOOGLE_IDENTITY_ALREADY_LINKED%' then raise exception 'S linked it twice: %', answer; end if;
  answer := pg_temp.sqlstate_of($q$select auth.link_google_identity_to_patient_account(
    'b3a10000-0000-4000-8000-000000000003', 'b3-google-auto-s')$q$);
  if answer not like '23505 GOOGLE_IDENTITY_ALREADY_LINKED%' then
    raise exception 'Another account took S''s Google account: %', answer;
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from auth.external_identities where id = 'b3c80000-0000-4000-8000-000000000001'
       and account_id = 'b3a10000-0000-4000-8000-000000000001' and status = 'active' and revoked_at is null
       and source_system = 'hid-google-explicit-link' and linked_at > clock_timestamp() - interval '1 minute')
     or (select count(*) from auth.external_identities
          where issuer = 'https://accounts.google.com' and subject = 'b3-google-auto-s') <> 1
     or (select count(*) from audit.events where actor_account_id = 'b3a10000-0000-4000-8000-000000000001'
          and action = 'auth.google.link' and outcome = 'success' and correlation_id = 'b3-google-relink-0002') <> 1
     or exists (select 1 from audit.events where correlation_id = 'b3-google-relink-0001')
     or (select count(*) from notification.inbox_items where account_id = 'b3a10000-0000-4000-8000-000000000001'
          and notification_code = 'SECURITY_GOOGLE_LINKED') <> 1 then
    raise exception 'The Google account linked again is not S''s active explicit link, audited and announced once';
  end if;
end $$;
do $$
begin
  if pg_temp.sqlstate_of($q$delete from identity.patient_contact_changes
       where id = 'b3c10000-0000-4000-8000-000000000003'$q$) not like '55000 identity.patient_contact_changes is append-only%' then
    raise exception 'A contact change was deleted';
  end if;
  if not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000003') then
    raise exception 'The contact change row is gone';
  end if;
end $$;
-- The old address can now be anyone's: O starts a change to it.
set local role hid_identity_api_runtime;
select pg_temp.as_patient('synthetic:b3:other', 'b3-email-0003');
do $$
begin
  if identity.start_my_email_change('synthetic:b3:other', 'b3f10000-0000-4000-8000-000000000004',
       'b3c10000-0000-4000-8000-000000000030', 's.one@example.invalid', repeat('e', 63) || '1',
       decode(repeat('c0', 40), 'hex'), 'nin-v7', repeat('a', 64), 'otp-v3', 300, 5, 60) <> 'started' then
    raise exception 'The released address is still held';
  end if;
  -- ...but the new one is S's.
  if identity.start_my_email_change('synthetic:b3:other', 'b3f10000-0000-4000-8000-000000000004',
       'b3c10000-0000-4000-8000-000000000031', 'NEW.address@example.invalid', repeat('b', 64),
       decode(repeat('c0', 40), 'hex'), 'nin-v7', repeat('a', 64), 'otp-v3', 300, 5, 60) <> 'rate_limited' then
    raise exception 'A second start within the window was not rate limited';
  end if;
end $$;
reset role;
-- Expiry, the fifth wrong code, a definitive delivery failure and a
-- concurrent claim, each on its own pending change of S.
update identity.patient_contact_changes set created_at = created_at - interval '2 hours',
  expires_at = expires_at - interval '2 hours', completed_at = completed_at - interval '2 hours',
  invalidated_at = invalidated_at - interval '2 hours'
 where patient_id = 'b3b10000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-email-0004');
do $$
declare answer text;
begin
  if pg_temp.start_email(4, 'four@example.invalid', repeat('a', 63) || '4') <> 'started' then
    raise exception 'Start 4 failed';
  end if;
  for attempt in 1..5 loop
    answer := pg_temp.complete_email(4, repeat('0', 64), 'four@example.invalid');
    if answer <> 'invalid||||' then raise exception 'Wrong code %: %', attempt, answer; end if;
  end loop;
  answer := pg_temp.complete_email(4, repeat('a', 63) || '4', 'four@example.invalid');
  if answer <> 'invalid||||' then raise exception 'The right code after the fifth wrong one: %', answer; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000004'
       and state = 'invalidated' and invalidation_reason = 'attempts_exhausted' and failed_attempts = 5
       and new_ciphertext is null) then
    raise exception 'The fifth wrong code did not invalidate the change';
  end if;
end $$;
update identity.patient_contact_changes set created_at = created_at - interval '61 seconds',
  expires_at = expires_at - interval '61 seconds' where id = 'b3c10000-0000-4000-8000-000000000004';
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-email-0005');
select pg_temp.start_email(5, 'five@example.invalid', repeat('a', 63) || '5');
reset role;
-- 5 expires.
update identity.patient_contact_changes set created_at = created_at - interval '10 minutes',
  expires_at = clock_timestamp() - interval '1 second' where id = 'b3c10000-0000-4000-8000-000000000005';
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-email-0006');
do $$
declare answer text;
begin
  answer := pg_temp.complete_email(5, repeat('a', 63) || '5', 'five@example.invalid');
  if answer <> 'expired||||' then raise exception 'An expired code: %', answer; end if;
  -- 6: a definitive delivery failure invalidates it.
  if pg_temp.start_email(6, 'six@example.invalid', repeat('a', 63) || '6') <> 'started' then raise exception 'Start 6'; end if;
  perform identity.record_my_contact_change_delivery('patient:b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', 'b3c10000-0000-4000-8000-000000000006', 'definitive_failure', null);
  answer := pg_temp.complete_email(6, repeat('a', 63) || '6', 'six@example.invalid');
  if answer <> 'invalid||||' then raise exception 'An undeliverable change completed: %', answer; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000005'
       and state = 'invalidated' and invalidation_reason = 'expired')
     or not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000006'
       and state = 'invalidated' and invalidation_reason = 'delivery_failed' and delivery_outcome = 'definitive_failure') then
    raise exception 'Expiry or delivery failure did not invalidate';
  end if;
  if (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
       and action = 'identity.patient.contact-change.delivery' and outcome = 'failure'
       and resource_id = 'b3c10000-0000-4000-8000-000000000006'
       and details = '{"channel": "email", "result": "delivery_failed"}'::jsonb) <> 1
     or exists (select 1 from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
       and action = 'identity.patient.contact-change.delivery' and resource_id <> 'b3c10000-0000-4000-8000-000000000006') then
    raise exception 'The undelivered code''s invalidation was not audited (or an accepted one was)';
  end if;
end $$;
-- 7: another account takes the address between the start and the code.
update identity.patient_contact_changes set created_at = created_at - interval '61 seconds',
  expires_at = expires_at - interval '61 seconds' where id = 'b3c10000-0000-4000-8000-000000000006';
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-email-0007');
select pg_temp.start_email(7, 'seven@example.invalid', repeat('a', 63) || '7');
reset role;
update auth.accounts set email = 'Seven@example.invalid' where id = 'b3a10000-0000-4000-8000-000000000005';
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-email-0008');
do $$
declare answer text;
begin
  answer := pg_temp.complete_email(7, repeat('a', 63) || '7', 'seven@example.invalid');
  if answer <> 'unavailable||||' then raise exception 'A claimed address completed: %', answer; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000007'
       and state = 'invalidated' and invalidation_reason = 'contact_unavailable')
     or not exists (select 1 from auth.accounts where id = 'b3a10000-0000-4000-8000-000000000001'
       and email = 'new.address@example.invalid') then
    raise exception 'A claimed address changed the account';
  end if;
end $$;
-- The hourly limit: five starts an hour.
do $$
declare
  started integer := 0;
  answer text;
begin
  for attempt in 10..16 loop
    update identity.patient_contact_changes set created_at = created_at - interval '61 seconds',
      expires_at = expires_at - interval '61 seconds', invalidated_at = invalidated_at - interval '61 seconds',
      completed_at = completed_at - interval '61 seconds'
     where patient_id = 'b3b10000-0000-4000-8000-000000000001';
    perform pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-email-hour-' || attempt);
    set local role hid_identity_api_runtime;
    answer := pg_temp.start_email(attempt, 'hour' || attempt || '@example.invalid', repeat('b', 62) || attempt);
    reset role;
    if answer = 'started' then started := started + 1;
    elsif answer <> 'rate_limited' then raise exception 'Hourly start %: %', attempt, answer; end if;
  end loop;
  -- 4, 5, 6 and 7 are within the hour already: one more start is admitted.
  if started <> 1 then raise exception 'The hourly limit admitted % starts', started; end if;
end $$;
-- W (patient and workforce on one account) cannot start; U cannot take a
-- staff record's address; U's change is refused at completion once U's
-- account becomes workforce.
set local role hid_identity_api_runtime;
select pg_temp.as_patient('b3a10000-0000-4000-8000-000000000009', 'b3-email-workforce-1');
do $$
begin
  if identity.start_my_email_change('b3a10000-0000-4000-8000-000000000009', 'b3f10000-0000-4000-8000-000000000019',
       'b3c10000-0000-4000-8000-000000000060', 'w.new@example.invalid', repeat('6', 63) || '0',
       decode(repeat('c6', 40), 'hex'), 'nin-v7', repeat('a', 63) || '6', 'otp-v3', 300, 5, 60) <> 'workforce' then
    raise exception 'A workforce account started an email change';
  end if;
end $$;
select pg_temp.as_patient('synthetic:b3:unverified', 'b3-email-workforce-2');
do $$
begin
  if identity.start_my_email_change('synthetic:b3:unverified', 'b3f10000-0000-4000-8000-000000000007',
       'b3c10000-0000-4000-8000-000000000061', 'W.Staff@example.invalid', repeat('6', 63) || '1',
       decode(repeat('c6', 40), 'hex'), 'nin-v7', repeat('a', 63) || '6', 'otp-v3', 300, 5, 60) <> 'unavailable' then
    raise exception 'A staff record''s address was available';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.patient_contact_changes where patient_id = 'b3b10000-0000-4000-8000-000000000009')
     or exists (select 1 from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000009')
     or not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000061'
       and state = 'invalidated' and invalidation_reason = 'contact_unavailable')
     or not exists (select 1 from audit.events where resource_id = 'b3c10000-0000-4000-8000-000000000061'
       and action = 'identity.patient.contact-change.start' and outcome = 'denied') then
    raise exception 'The workforce or staff-address refusals were not recorded as they should be';
  end if;
end $$;
update identity.patient_contact_changes set created_at = created_at - interval '61 seconds',
  expires_at = expires_at - interval '61 seconds', invalidated_at = invalidated_at - interval '61 seconds'
 where patient_id = 'b3b10000-0000-4000-8000-000000000007';
set local role hid_identity_api_runtime;
select pg_temp.as_patient('synthetic:b3:unverified', 'b3-email-workforce-3');
do $$
begin
  if identity.start_my_email_change('synthetic:b3:unverified', 'b3f10000-0000-4000-8000-000000000007',
       'b3c10000-0000-4000-8000-000000000062', 'u.new@example.invalid', repeat('6', 63) || '2',
       decode(repeat('c6', 40), 'hex'), 'nin-v7', repeat('a', 63) || '7', 'otp-v3', 300, 5, 60) <> 'started' then
    raise exception 'U''s start';
  end if;
end $$;
reset role;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('b3d20000-0000-4000-8000-000000000007', 'b3a10000-0000-4000-8000-000000000007', 'Uche Unverified',
   'u.staff@example.invalid', 'verified', 'nurse');
set local role hid_identity_api_runtime;
select pg_temp.as_patient('synthetic:b3:unverified', 'b3-email-workforce-4');
do $$
declare outcome_row record;
begin
  select * into outcome_row from identity.complete_my_email_change('synthetic:b3:unverified',
    'b3f10000-0000-4000-8000-000000000007', 'b3c10000-0000-4000-8000-000000000062', repeat('a', 63) || '7',
    'u.new@example.invalid');
  if format('%s|%s|%s', outcome_row.outcome, outcome_row.email, outcome_row.previous_email) <> 'workforce||' then
    raise exception 'An account that became workforce completed: %', outcome_row.outcome;
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000062'
       and state = 'invalidated' and invalidation_reason = 'workforce_account' and new_ciphertext is null)
     or not exists (select 1 from auth.accounts where id = 'b3a10000-0000-4000-8000-000000000007'
       and email = 'u.unverified@example.invalid')
     or (select count(*) from audit.events where resource_id = 'b3c10000-0000-4000-8000-000000000062'
          and action = 'identity.patient.contact-change.verify' and outcome = 'denied'
          and details = '{"channel": "email", "result": "workforce"}'::jsonb) <> 1 then
    raise exception 'The workforce refusal at completion is not recorded';
  end if;
end $$;
delete from identity.staff where id = 'b3d20000-0000-4000-8000-000000000007';

-- 4. Phone changes: L (migrated) to a UK number, N (NIN route) to a Nigerian one.
create function pg_temp.change_phone(subject text, session text, n integer, lookup text, others text[],
  unreadable boolean default false)
returns text language plpgsql as $$
declare outcome record;
begin
  select * into outcome from identity.change_my_phone(subject, session::uuid,
    ('b3c20000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, lookup, others::char(64)[],
    decode(repeat('d' || (n % 10)::text, 40), 'hex'), 'nin-v7', unreadable);
  return format('%s|%s|%s|%s', outcome.outcome, outcome.notice_email, outcome.patient_first_name,
    outcome.patient_hid_code);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.change_phone(text, text, integer, text, text[], boolean) to public;
set local role hid_identity_api_runtime;
select pg_temp.as_patient('b3a10000-0000-4000-8000-000000000003', 'b3-phone-0001');
do $$
declare answer text;
begin
  -- The current number, in either stored form, is unchanged.
  answer := pg_temp.change_phone('b3a10000-0000-4000-8000-000000000003', 'b3f10000-0000-4000-8000-000000000003', 1,
    repeat('1', 64), array[repeat('7', 64)]);
  if answer <> 'unchanged|||' then raise exception 'L''s own number: %', answer; end if;
  -- Another patient's number, in any form.
  answer := pg_temp.change_phone('b3a10000-0000-4000-8000-000000000003', 'b3f10000-0000-4000-8000-000000000003', 2,
    repeat('2', 64), array[repeat('8', 64)]);
  if answer <> 'unavailable|||' then raise exception 'O''s number in its second form: %', answer; end if;
  answer := pg_temp.change_phone('b3a10000-0000-4000-8000-000000000003', 'b3f10000-0000-4000-8000-000000000003', 3,
    repeat('c', 64), '{}');
  if answer <> 'changed|legacy.l@example.invalid|Lami|HID-LAMCCC' then raise exception 'L''s change: %', answer; end if;
  answer := pg_temp.change_phone('b3a10000-0000-4000-8000-000000000003', 'b3f10000-0000-4000-8000-000000000009', 4,
    repeat('d', 64), '{}');
  if answer not like '42501%' then raise exception 'Another session changed L''s phone: %', answer; end if;
  answer := pg_temp.change_phone('b3a10000-0000-4000-8000-000000000003', 'b3f10000-0000-4000-8000-000000000003', 5,
    'not-a-lookup', '{}');
  if answer not like '22023%' then raise exception 'A malformed lookup: %', answer; end if;
  if pg_temp.contact('b3a10000-0000-4000-8000-000000000003', 'b3f10000-0000-4000-8000-000000000003')
       <> 'legacy.l@example.invalid|t|' || repeat('c', 64) || '|b3c20000-0000-4000-8000-000000000003|f' then
    raise exception 'L''s contacts after the change: %', pg_temp.contact('b3a10000-0000-4000-8000-000000000003',
      'b3f10000-0000-4000-8000-000000000003');
  end if;
end $$;
-- Phone sign-in and reset (0093's lookup) find L by the new number only.
select pg_temp.as_system('b3-phone-0002');
do $$
begin
  if (select account_id from auth.find_patient_account('phone', repeat('c', 64))) <> 'b3a10000-0000-4000-8000-000000000003'
     or exists (select 1 from auth.find_patient_account('phone', repeat('7', 64))) then
    raise exception 'Phone sign-in does not follow the change';
  end if;
end $$;
-- N (no email): changed, and no notice address; U (unverified email): no notice address.
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000002', 'b3-phone-0003');
do $$
begin
  if pg_temp.change_phone('patient:b3a10000-0000-4000-8000-000000000002', 'b3f10000-0000-4000-8000-000000000002', 6,
       repeat('d', 64), array[repeat('d', 63) || 'e']) <> 'changed||Nkem|HID-NKMBBB' then
    raise exception 'N''s phone change';
  end if;
end $$;
select pg_temp.as_patient('synthetic:b3:unverified', 'b3-phone-0004');
do $$
begin
  if pg_temp.change_phone('synthetic:b3:unverified', 'b3f10000-0000-4000-8000-000000000007', 7,
       repeat('f', 64), '{}') <> 'changed||Uche|HID-UCHEEE' then
    raise exception 'An unverified email was given as the notice address';
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patients where id = 'b3b10000-0000-4000-8000-000000000003'
       and phone_lookup_hmac = repeat('c', 64) and phone_e164_ciphertext = decode(repeat('d3', 40), 'hex')
       and contact_key_version = 'legacy-v1')
     or (select count(*) from identity.patient_contact_changes where patient_id = 'b3b10000-0000-4000-8000-000000000003'
          and channel = 'phone') <> 2
     or not exists (select 1 from identity.patient_contact_changes where id = 'b3c20000-0000-4000-8000-000000000003'
          and state = 'completed' and replaced_contact and verifier_hmac is null and expires_at is null)
     or not exists (select 1 from identity.patient_contact_changes where id = 'b3c20000-0000-4000-8000-000000000002'
          and state = 'invalidated' and invalidation_reason = 'contact_unavailable' and new_ciphertext is null)
     or (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000003'
          and action = 'identity.patient.contact-change.complete') <> 2 then
    raise exception 'L''s phone changes were not recorded as made';
  end if;
end $$;
-- The hourly limit: five changes an hour.
do $$
declare
  answer text;
  changed integer := 0;
begin
  perform pg_temp.as_patient('b3a10000-0000-4000-8000-000000000003', 'b3-phone-hour');
  set local role hid_identity_api_runtime;
  for attempt in 20..26 loop
    answer := pg_temp.change_phone('b3a10000-0000-4000-8000-000000000003', 'b3f10000-0000-4000-8000-000000000003',
      attempt, repeat('a', 62) || attempt, '{}');
    if answer like 'changed|%' then changed := changed + 1;
    elsif answer <> 'rate_limited|||' then raise exception 'Hourly phone change %: %', attempt, answer; end if;
  end loop;
  reset role;
  if changed <> 3 then raise exception 'The hourly phone limit admitted % changes', changed; end if;
  -- Only the current phone's change keeps its ciphertext.
  if (select count(*) from identity.patient_contact_changes where patient_id = 'b3b10000-0000-4000-8000-000000000003'
       and channel = 'phone' and new_ciphertext is not null) <> 1 then
    raise exception 'A superseded phone change kept its ciphertext';
  end if;
end $$;
-- O's stored number is one Identity cannot read (as a phone migrated from
-- hid-1.0): entering the same number writes it again, as a change, so the
-- profile shows it; once readable, the same number is unchanged.
set local role hid_identity_api_runtime;
select pg_temp.as_patient('synthetic:b3:other', 'b3-phone-rewrite');
do $$
declare answer text;
begin
  answer := pg_temp.change_phone('synthetic:b3:other', 'b3f10000-0000-4000-8000-000000000004', 40,
    repeat('8', 64), '{}', null);
  if answer not like '22023 PATIENT_CONTACT_CHANGE_INVALID%' then raise exception 'No readability: %', answer; end if;
  answer := pg_temp.change_phone('synthetic:b3:other', 'b3f10000-0000-4000-8000-000000000004', 41,
    repeat('8', 64), '{}', true);
  if answer <> 'changed|other@example.invalid|Ola|HID-QLADDD' then raise exception 'O''s rewrite: %', answer; end if;
  if pg_temp.contact('synthetic:b3:other', 'b3f10000-0000-4000-8000-000000000004')
       <> 'other@example.invalid|t|' || repeat('8', 64) || '|b3c20000-0000-4000-8000-000000000041|f' then
    raise exception 'O''s contacts after the rewrite: %', pg_temp.contact('synthetic:b3:other',
      'b3f10000-0000-4000-8000-000000000004');
  end if;
  answer := pg_temp.change_phone('synthetic:b3:other', 'b3f10000-0000-4000-8000-000000000004', 42,
    repeat('8', 64), '{}', false);
  if answer <> 'unchanged|||' then raise exception 'O''s readable number again: %', answer; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patients where id = 'b3b10000-0000-4000-8000-000000000004'
       and phone_lookup_hmac = repeat('8', 64) and phone_e164_ciphertext = decode(repeat('d1', 40), 'hex'))
     or not exists (select 1 from identity.patient_contact_changes where id = 'b3c20000-0000-4000-8000-000000000041'
       and state = 'completed' and replaced_contact)
     or exists (select 1 from identity.patient_contact_changes
                 where id in ('b3c20000-0000-4000-8000-000000000040', 'b3c20000-0000-4000-8000-000000000042')) then
    raise exception 'O''s rewrite was not recorded as a change (or a refusal was)';
  end if;
end $$;

-- 5. Readiness after the changes: S's email (a sign-up enrollment's contact),
-- N's phone (a NIN-route enrollment's verified contact), L's phone (a
-- migrated contact replaced). 0057's body would refuse S and N.
do $$
begin
  if pg_temp.readiness() <> 'new=t old=f' then
    raise exception 'Readiness after the changes: %', pg_temp.readiness();
  end if;
end $$;
-- L adds an email (none before): counted with the marker's contacts.
set local role hid_identity_api_runtime;
select pg_temp.as_patient('b3a10000-0000-4000-8000-000000000003', 'b3-ready-0001');
select identity.start_my_email_change('b3a10000-0000-4000-8000-000000000003', 'b3f10000-0000-4000-8000-000000000003',
  'b3c10000-0000-4000-8000-000000000050', 'lami.new@example.invalid', repeat('5', 63) || '0',
  decode(repeat('c5', 40), 'hex'), 'nin-v7', repeat('a', 63) || '5', 'otp-v3', 300, 5, 60);
do $$
begin
  if (select outcome from identity.complete_my_email_change('b3a10000-0000-4000-8000-000000000003',
        'b3f10000-0000-4000-8000-000000000003', 'b3c10000-0000-4000-8000-000000000050', repeat('a', 63) || '5',
        'lami.new@example.invalid')) <> 'completed' then
    raise exception 'L''s email change did not complete';
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000050'
       and not replaced_contact) then
    raise exception 'L''s added email is not recorded as added';
  end if;
  if pg_temp.readiness() <> 'new=t old=f' then
    raise exception 'Readiness after a migrated patient added an email: %', pg_temp.readiness();
  end if;
end $$;
-- A contact written without a change is still refused (fail closed).
update identity.patients set phone_lookup_hmac = repeat('b', 64)
 where id = 'b3b10000-0000-4000-8000-000000000002';
do $$
begin
  if pg_temp.readiness() <> 'new=f old=f' then
    raise exception 'An unrecorded phone write kept readiness: %', pg_temp.readiness();
  end if;
end $$;
update identity.patients set phone_lookup_hmac = repeat('d', 64)
 where id = 'b3b10000-0000-4000-8000-000000000002';
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system,
  phone_e164_ciphertext, phone_lookup_hmac, contact_key_version) values
  ('b3b10000-0000-4000-8000-000000000008', null, 'HID-LATEFF', 'Late', 'Legacy', 'Late Legacy', 'active',
   'legacy_identity', decode(repeat('58', 40), 'hex'), repeat('0', 63) || '8', 'legacy-v1');
do $$
begin
  if pg_temp.readiness() <> 'new=f old=f' then
    raise exception 'A migrated patient promoted after the rekey kept readiness: %', pg_temp.readiness();
  end if;
end $$;
delete from identity.patients where id = 'b3b10000-0000-4000-8000-000000000008';

-- 6. Profile details (S).
create function pg_temp.save_details(version bigint, hospital text, hmo text) returns text language plpgsql as $$
declare outcome record;
begin
  select * into outcome from identity.save_my_profile_details('patient:b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', version, hospital, hmo);
  return format('%s|%s|%s|%s', outcome.outcome, outcome.hospital_currently_using, outcome.hmo_name, outcome.row_version);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.save_details(bigint, text, text) to public;
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-details-0001');
do $$
declare answer text;
begin
  if (select format('%s|%s|%s|%s', details.hospital_currently_using, details.hmo_name, details.row_version, details.saved)
        from identity.read_my_profile_details('patient:b3a10000-0000-4000-8000-000000000001',
          'b3f10000-0000-4000-8000-000000000001') details) <> '||0|f' then
    raise exception 'Details before a save';
  end if;
  answer := pg_temp.save_details(1, 'Lagos General', null);
  if answer <> 'conflict|||0' then raise exception 'A first save with version 1: %', answer; end if;
  answer := pg_temp.save_details(0, 'Lagos General', 'Hygeia HMO');
  if answer <> 'saved|Lagos General|Hygeia HMO|1' then raise exception 'A first save: %', answer; end if;
  answer := pg_temp.save_details(0, 'Other', null);
  if answer <> 'conflict|Lagos General|Hygeia HMO|1' then raise exception 'A stale save: %', answer; end if;
  answer := pg_temp.save_details(1, null, 'Hygeia HMO');
  if answer <> 'saved||Hygeia HMO|2' then raise exception 'A second save: %', answer; end if;
  foreach answer in array array[pg_temp.save_details(2, repeat('a', 121), null),
      pg_temp.save_details(2, 'Line' || chr(10) || 'break', null), pg_temp.save_details(2, ' padded', null),
      pg_temp.save_details(2, '', null), pg_temp.save_details(-1, null, null)] loop
    if answer not like '22023 PATIENT_PROFILE_DETAILS_INVALID%' then raise exception 'A refused value: %', answer; end if;
  end loop;
  if exists (select 1 from identity.read_my_profile_details('patient:b3a10000-0000-4000-8000-000000000001',
       'b3f10000-0000-4000-8000-000000000009')) then
    raise exception 'A revoked session read the details';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
       and action = 'identity.patient.profile-details.update') <> 2
     or exists (select 1 from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
       and action = 'identity.patient.profile-details.update' and details::text ~ 'Lagos|Hygeia') then
    raise exception 'Profile details audit rows are wrong or carry the values';
  end if;
end $$;

-- 7. Photo (S).
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-photo-0001');
do $$
declare answer text;
begin
  if not identity.set_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
       'b3f10000-0000-4000-8000-000000000001', decode(repeat('ab', 100 + 29), 'hex'), 'image/jpeg', repeat('1', 64),
       100, 512, 512, 'nin-v7') then
    raise exception 'The photo was not saved';
  end if;
  if not identity.set_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
       'b3f10000-0000-4000-8000-000000000001', decode(repeat('cd', 200 + 29), 'hex'), 'image/png', repeat('2', 64),
       200, 300, 1024, 'nin-v7') then
    raise exception 'The photo was not replaced';
  end if;
  if (select format('%s|%s|%s|%s', photo.media_type, photo.sha256, photo.byte_size, octet_length(photo.ciphertext))
        from identity.read_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
          'b3f10000-0000-4000-8000-000000000001') photo) <> 'image/png|' || repeat('2', 64) || '|200|229'
     or pg_temp.contact('patient:b3a10000-0000-4000-8000-000000000001', 'b3f10000-0000-4000-8000-000000000001')
        not like '%|t' then
    raise exception 'The photo read back is not the last one saved';
  end if;
  if exists (select 1 from identity.read_my_profile_photo('synthetic:b3:other', 'b3f10000-0000-4000-8000-000000000001'))
     or exists (select 1 from identity.read_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
       'b3f10000-0000-4000-8000-000000000009')) then
    raise exception 'Another subject or a revoked session read the photo';
  end if;
  foreach answer in array array[
      pg_temp.sqlstate_of($q$select identity.set_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001', decode(repeat('ab', 129), 'hex'), 'image/gif', repeat('1', 64), 100,
        512, 512, 'nin-v7')$q$),
      pg_temp.sqlstate_of($q$select identity.set_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001', decode(repeat('ab', 129), 'hex'), 'image/jpeg', repeat('1', 64), 100,
        1025, 512, 'nin-v7')$q$),
      pg_temp.sqlstate_of($q$select identity.set_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001', decode(repeat('ab', 130), 'hex'), 'image/jpeg', repeat('1', 64), 100,
        512, 512, 'nin-v7')$q$),
      pg_temp.sqlstate_of(format($q$select identity.set_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001', decode(repeat('ab', %s), 'hex'), 'image/jpeg', repeat('1', 64), %s,
        512, 512, 'nin-v7')$q$, 307201 + 29, 307201))] loop
    if answer not like '23514%' then raise exception 'A photo the CHECKs refuse: %', answer; end if;
  end loop;
  if not identity.remove_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
       'b3f10000-0000-4000-8000-000000000001')
     or identity.remove_my_profile_photo('patient:b3a10000-0000-4000-8000-000000000001',
       'b3f10000-0000-4000-8000-000000000001') then
    raise exception 'Remove did not answer true and then false';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.patient_profile_photos where patient_id = 'b3b10000-0000-4000-8000-000000000001')
     or (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
          and action = 'identity.patient.photo.set') <> 2
     or (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
          and action = 'identity.patient.photo.remove') <> 1 then
    raise exception 'The photo''s rows and audit are wrong';
  end if;
end $$;

-- 8. EHR: S's own health information, then the doctor's read.
create function pg_temp.save_health(subject text, account text, session text, patient text, version bigint,
  blood text, genotype text, allergies text) returns text language plpgsql as $$
declare outcome record;
begin
  perform pg_temp.as_ehr_patient(subject, account, session, patient, 'b3-health-' || version);
  select * into outcome from ehr.save_my_reported_health_profile(version, blood, genotype, allergies,
    'Salbutamol inhaler', 'Asthma' || chr(10) || 'since 2010', null);
  return format('%s|%s|%s|%s|%s', outcome.outcome, outcome.blood_group, outcome.genotype, outcome.allergies,
    outcome.row_version);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.save_health(text, text, text, text, bigint, text, text, text) to public;
set local role hid_ehr_api_runtime;
do $$
declare answer text;
begin
  answer := pg_temp.save_health('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000001', 0, 'O+', 'AS', 'Penicillin');
  if answer <> 'saved|O+|AS|Penicillin|1' then raise exception 'S''s first save: %', answer; end if;
  answer := pg_temp.save_health('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000001', 0, 'A+', null, null);
  if answer <> 'conflict|O+|AS|Penicillin|1' then raise exception 'A stale save: %', answer; end if;
  answer := pg_temp.save_health('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000001', 1, 'O+', 'CC', null);
  if answer <> 'saved|O+|CC||2' then raise exception 'A second save: %', answer; end if;
  -- Refusals: unknown values, a tab, 1001 characters, a revoked session, another patient's id.
  foreach answer in array array[
      pg_temp.save_health('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000001', 2, 'Z+', null, null),
      pg_temp.save_health('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000001', 2, null, 'XX', null),
      pg_temp.save_health('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000001', 2, null, null, 'tab' || chr(9)),
      pg_temp.save_health('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
        'b3f10000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000001', 2, null, null, repeat('a', 1001))] loop
    if answer not like '22023 PATIENT_HEALTH_PROFILE_INVALID%' then raise exception 'A refused value: %', answer; end if;
  end loop;
  answer := pg_temp.save_health('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000009', 'b3b10000-0000-4000-8000-000000000001', 2, 'O+', null, null);
  if answer not like '42501%' then raise exception 'A revoked session saved: %', answer; end if;
  answer := pg_temp.save_health('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000004', 0, 'O+', null, null);
  if answer not like '42501%' then raise exception 'S saved for O: %', answer; end if;
  -- S reads it back under RLS; O's context reads nothing; nobody writes directly.
  perform pg_temp.as_ehr_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', 'b3b10000-0000-4000-8000-000000000001', 'b3-health-read-0001');
  if (select format('%s|%s|%s|%s|%s', blood_group, genotype, current_medications, chronic_conditions, row_version)
        from ehr.patient_reported_health_profiles) <> 'O+|CC|Salbutamol inhaler|Asthma' || chr(10) || 'since 2010|2' then
    raise exception 'S does not read their own values';
  end if;
  perform pg_temp.as_ehr_patient('synthetic:b3:other', 'b3a10000-0000-4000-8000-000000000004',
    'b3f10000-0000-4000-8000-000000000004', 'b3b10000-0000-4000-8000-000000000004', 'b3-health-read-0002');
  if exists (select 1 from ehr.patient_reported_health_profiles) then raise exception 'O read S''s values'; end if;
  if pg_temp.sqlstate_of($q$insert into ehr.patient_reported_health_profiles (patient_id, updated_by_account_id)
       values ('b3b10000-0000-4000-8000-000000000004', 'b3a10000-0000-4000-8000-000000000004')$q$) not like '42501%'
     or pg_temp.sqlstate_of($q$update ehr.patient_reported_health_profiles set blood_group = 'A+'$q$) not like '42501%'
     or pg_temp.sqlstate_of($q$delete from ehr.patient_reported_health_profiles$q$) not like '42501%' then
    raise exception 'The EHR runtime can write the table directly';
  end if;
  -- The doctor: with the grant at its facility, then at the other facility, then for O (no grant).
  perform pg_temp.as_staff('staff:b3-doctor', 'b3d30000-0000-4000-8000-000000000001',
    'b3d10000-0000-4000-8000-000000000002', 'direct-care', 'b3-health-staff-0001');
  if (select count(*) from ehr.patient_reported_health_profiles
       where patient_id = 'b3b10000-0000-4000-8000-000000000001' and blood_group = 'O+') <> 1 then
    raise exception 'The doctor with a grant does not read it';
  end if;
  perform pg_temp.as_staff('staff:b3-doctor', 'b3d30000-0000-4000-8000-000000000002',
    'b3d10000-0000-4000-8000-000000000003', 'direct-care', 'b3-health-staff-0002');
  if exists (select 1 from ehr.patient_reported_health_profiles) then
    raise exception 'The doctor read it at a facility without a grant';
  end if;
  perform pg_temp.as_staff('staff:b3-doctor', 'b3d30000-0000-4000-8000-000000000001',
    'b3d10000-0000-4000-8000-000000000002', 'healthcare-operations', 'b3-health-staff-0003');
  if exists (select 1 from ehr.patient_reported_health_profiles) then
    raise exception 'The doctor read it for a purpose the grant is not for';
  end if;
end $$;
reset role;
-- The grant ends: no more reads.
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(),
  revoked_by = 'b3a10000-0000-4000-8000-000000000001', revoked_reason = 'Synthetic revoke'
 where id = 'b3c30000-0000-4000-8000-000000000001';
set local role hid_ehr_api_runtime;
select pg_temp.as_staff('staff:b3-doctor', 'b3d30000-0000-4000-8000-000000000001',
  'b3d10000-0000-4000-8000-000000000002', 'direct-care', 'b3-health-staff-0004');
do $$
begin
  if exists (select 1 from ehr.patient_reported_health_profiles) then
    raise exception 'The doctor read it after the grant ended';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000001'
       and action = 'ehr.patient.self.health-profile.update' and actor_type = 'patient'
       and actor_account_id = 'b3a10000-0000-4000-8000-000000000001' and source_system = 'ehr-api') <> 2
     or exists (select 1 from audit.events where action = 'ehr.patient.self.health-profile.update'
       and details::text ~ 'Penicillin|Asthma|O\+') then
    raise exception 'The health information audit rows are wrong or carry values';
  end if;
end $$;
-- The clinician's read as ClinicalRepository records it (ehr.record.read on
-- patient-reported-health-profile) is a view in the patient's access log.
insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
  organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
  provenance, source_system, details)
values ('b3-health-staff-0001', 'staff', 'staff:b3-doctor', 'b3a10000-0000-4000-8000-000000000006',
  'b3d30000-0000-4000-8000-000000000001', 'b3d10000-0000-4000-8000-000000000001',
  'b3d10000-0000-4000-8000-000000000002', 'b3b10000-0000-4000-8000-000000000001', 'ehr.record.read', 'success',
  'patient-reported-health-profile', 'b3b10000-0000-4000-8000-000000000001', 'direct-care', 'application', 'ehr-api',
  '{"entered": true}');
set local role hid_identity_api_runtime;
select pg_temp.as_patient('patient:b3a10000-0000-4000-8000-000000000001', 'b3-access-log-0001');
do $$
declare entry jsonb;
begin
  entry := identity.patient_self_access_log('patient:b3a10000-0000-4000-8000-000000000001',
    'b3f10000-0000-4000-8000-000000000001', 10, null, null) -> 'events' -> 0;
  if entry ->> 'action' <> 'viewed' or entry ->> 'actorKind' <> 'clinician' or entry ->> 'actorName' <> 'Profile Doctor'
     or entry ->> 'facilityName' <> 'Profile Test Hospital' then
    raise exception 'The clinician''s read is not a view in the access log: %', entry;
  end if;
end $$;
reset role;

-- 9. U verifies the unverified address the account already has: the same
-- address goes through the code (any case), and its completion only sets it
-- verified (and the patient's contact email). The previous mailbox is the
-- same one, so U's other session, open recovery code and Google link (one
-- 0093 would link from a verified address, standing for anything the address
-- gave) all stay, no previous address is answered for a notice, and the audit
-- row says addressUnchanged. Once verified, the address is unchanged.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('b3f10000-0000-4000-8000-00000000007a', 'b3a10000-0000-4000-8000-000000000007', 'b3f10000-0000-4000-8000-00000000007a',
   md5('b3-u-other-device') || md5('b3-u-other-device'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'b3b10000-0000-4000-8000-000000000007');
insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac, verifier_key_version,
  expires_at, max_attempts, account_token_version) values
  ('b3c90000-0000-4000-8000-000000000007', 'b3a10000-0000-4000-8000-000000000007', repeat('7', 64), 'PASSWORD_RESET',
   'email', repeat('8', 64), 'otp-v3', clock_timestamp() + interval '10 minutes', 5, 1);
insert into auth.external_identities (id, account_id, issuer, subject, status, source_system) values
  ('b3c80000-0000-4000-8000-000000000007', 'b3a10000-0000-4000-8000-000000000007', 'https://accounts.google.com',
   'b3-google-auto-u', 'active', 'hid-google-verified-email-link');
update identity.patient_contact_changes set created_at = created_at - interval '61 seconds',
  expires_at = expires_at - interval '61 seconds', invalidated_at = invalidated_at - interval '61 seconds',
  completed_at = completed_at - interval '61 seconds'
 where patient_id = 'b3b10000-0000-4000-8000-000000000007';
set local role hid_identity_api_runtime;
select pg_temp.as_patient('synthetic:b3:unverified', 'b3-email-verify-0001');
do $$
declare outcome_row record;
begin
  if pg_temp.contact('synthetic:b3:unverified', 'b3f10000-0000-4000-8000-000000000007') not like 'u.unverified@example.invalid|f|%' then
    raise exception 'U''s address is not shown unverified';
  end if;
  if identity.start_my_email_change('synthetic:b3:unverified', 'b3f10000-0000-4000-8000-000000000007',
       'b3c10000-0000-4000-8000-000000000063', 'U.Unverified@Example.invalid', repeat('6', 63) || '3',
       decode(repeat('c7', 40), 'hex'), 'nin-v7', repeat('a', 63) || '8', 'otp-v3', 300, 5, 60) <> 'started' then
    raise exception 'U''s own unverified address did not start';
  end if;
  perform identity.record_my_contact_change_delivery('synthetic:b3:unverified', 'b3f10000-0000-4000-8000-000000000007',
    'b3c10000-0000-4000-8000-000000000063', 'accepted', 'brevo');
  select * into outcome_row from identity.complete_my_email_change('synthetic:b3:unverified',
    'b3f10000-0000-4000-8000-000000000007', 'b3c10000-0000-4000-8000-000000000063', repeat('a', 63) || '8',
    'u.unverified@example.invalid');
  if format('%s|%s|%s|%s|%s', outcome_row.outcome, outcome_row.email, outcome_row.previous_email,
       outcome_row.patient_first_name, outcome_row.patient_hid_code)
       <> 'completed|u.unverified@example.invalid||Uche|HID-UCHEEE' then
    raise exception 'U''s verification: %', outcome_row;
  end if;
  if pg_temp.contact('synthetic:b3:unverified', 'b3f10000-0000-4000-8000-000000000007') not like 'u.unverified@example.invalid|t|%' then
    raise exception 'U''s address is not shown verified';
  end if;
  -- Verified now: the same address (any case) is unchanged, and nothing is recorded.
  if identity.start_my_email_change('synthetic:b3:unverified', 'b3f10000-0000-4000-8000-000000000007',
       'b3c10000-0000-4000-8000-000000000064', 'u.UNVERIFIED@example.invalid', repeat('6', 63) || '3',
       decode(repeat('c7', 40), 'hex'), 'nin-v7', repeat('a', 63) || '9', 'otp-v3', 300, 5, 60) <> 'unchanged' then
    raise exception 'U''s verified address was not unchanged';
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from auth.accounts where id = 'b3a10000-0000-4000-8000-000000000007'
       and email = 'u.unverified@example.invalid' and email_verified_at > clock_timestamp() - interval '1 minute')
     or not exists (select 1 from identity.patients where id = 'b3b10000-0000-4000-8000-000000000007'
       and email_lookup_hmac = repeat('6', 63) || '3' and email_ciphertext = decode(repeat('c7', 40), 'hex'))
     or not exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000063'
       and state = 'completed' and not replaced_contact)
     or exists (select 1 from identity.patient_contact_changes where id = 'b3c10000-0000-4000-8000-000000000064') then
    raise exception 'U''s address was not verified as recorded';
  end if;
  if exists (select 1 from auth.sessions where account_id = 'b3a10000-0000-4000-8000-000000000007'
       and id in ('b3f10000-0000-4000-8000-000000000007', 'b3f10000-0000-4000-8000-00000000007a')
       and revoked_at is not null)
     or not exists (select 1 from auth.otp_challenges where id = 'b3c90000-0000-4000-8000-000000000007'
       and invalidated_at is null)
     or not exists (select 1 from auth.external_identities where id = 'b3c80000-0000-4000-8000-000000000007'
       and status = 'active' and revoked_at is null) then
    raise exception 'Verifying the same address ended a session, a recovery code or a Google link';
  end if;
  if (select count(*) from audit.events where patient_id = 'b3b10000-0000-4000-8000-000000000007'
       and action = 'identity.patient.contact-change.complete' and outcome = 'success'
       and resource_id = 'b3c10000-0000-4000-8000-000000000063'
       and details = '{"channel": "email", "result": "completed", "addressUnchanged": true}'::jsonb) <> 1
     or exists (select 1 from audit.events where actor_account_id = 'b3a10000-0000-4000-8000-000000000007'
       and action = 'auth.google.auto-link.revoke') then
    raise exception 'U''s verification is not audited as addressUnchanged (or a Google link was revoked)';
  end if;
end $$;

rollback;
