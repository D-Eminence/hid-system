\set ON_ERROR_STOP on
-- Patient parity with hid-1.0, identity (0093; owner decisions of
-- 2026-10-28). Rollback-only; synthetic values only; uuid prefix b2.
--   1. Security properties and privileges of the six new functions and the
--      two replaced ones.
--   2. The sign-up activation admits E.164 of any country (7-15 digits) and
--      a Nigerian +234 number, still refuses a number without its +, and
--      replays as before.
--   3. auth.find_patient_account: a migrated hid-1.0 patient, which RLS hides
--      from Identity's direct query, is found by Health ID and by phone HMAC
--      (also as one of a Nigerian number's two HMACs, through
--      patients_phone_hmac_uq; two accounts across the two answer nothing);
--      a public patient too; a suspended one with disabled_now; a deleted
--      account or a malformed value finds nothing; workforce is flagged; the
--      password hash only for Health ID and phone; system:auth only.
--   4. auth.patient_email_registered.
--   5. auth.link_google_identity_by_verified_email: every outcome, the link
--      row, the audit row and the inbox notice; the candidates through
--      accounts_email_ci_uq and patients_email_hmac_uq; system:auth only.
--   6. auth.record_account_security_notice: evidence, once per evidence, the
--      hourly reset limit, no PHI, nothing for staff-only or deleted
--      accounts or unknown codes; system:auth only.
--   7. identity.close_own_consent_grant: the patient's notice when the
--      clinician ends a grant early (facilityName only), none on a replay or
--      after expiry; its answer and audit unchanged; another clinician P0002.
--   8. identity.count_my_unread_notifications: inbox plus imported hid-1.0
--      unread, bound to the live session.
--   9. identity.patient_self_access_log: kinds, exclusions, names, collapsing,
--      keyset pages, the 2000-row scan cap, session binding, cursor checks;
--      document downloads, OCR reads and routed orders as views and changes.
set plpgsql.variable_conflict = error;
begin;
set constraints all deferred;

-- 1. Security properties and privileges.
do $$
declare
  mismatch text;
  role_name text;
  proc_name text;
begin
  select string_agg(expected.proc, ', ') into mismatch
    from (values
      ('auth.find_patient_account(text,text)', 's'),
      ('auth.patient_email_registered(text,char)', 's'),
      ('auth.link_google_identity_by_verified_email(text,text,char)', 'v'),
      ('auth.record_account_security_notice(uuid,text)', 'v'),
      ('identity.count_my_unread_notifications(text,uuid)', 's'),
      ('identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)', 's')) expected(proc, volatility)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where proc.oid is null or not proc.prosecdef or proc.provolatile <> expected.volatility
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  if mismatch is not null then raise exception 'New functions lost SECURITY DEFINER, volatility or search_path: %', mismatch; end if;
  if not exists (select 1 from pg_proc where oid = 'identity.close_own_consent_grant(uuid,text)'::regprocedure
                  and prosecdef and provolatile = 'v'
                  and proconfig = '{"search_path=identity, auth, audit, platform, pg_temp"}'::text[])
     or not exists (select 1 from pg_proc
                  where oid = 'identity.activate_public_patient_signup(uuid,char,text,text,text,text,char)'::regprocedure
                    and prosecdef and provolatile = 'v'
                    and proconfig = '{"search_path=pg_catalog, identity, auth, audit, platform, public, pg_temp"}'::text[]) then
    raise exception 'A replaced function changed its security properties';
  end if;
  foreach proc_name in array array['auth.find_patient_account(text,text)', 'auth.patient_email_registered(text,char)',
      'auth.link_google_identity_by_verified_email(text,text,char)', 'auth.record_account_security_notice(uuid,text)',
      'identity.count_my_unread_notifications(text,uuid)',
      'identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)',
      'identity.close_own_consent_grant(uuid,text)',
      'identity.activate_public_patient_signup(uuid,char,text,text,text,text,char)'] loop
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
  if has_function_privilege('hid_identity_api_runtime', 'notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', 'EXECUTE') then
    raise exception 'The inbox enqueue must stay owner-only';
  end if;
end $$;

-- Transaction contexts as Identity sets them.
create function pg_temp.as_system(correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', correlation, true),
    set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
    set_config('app.purpose_of_use', '', true);
$$;
create function pg_temp.as_patient(subject text, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.as_staff(subject text, membership text, facility text, purpose text, correlation text)
returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
    set_config('app.membership_id', membership, true), set_config('app.purpose_of_use', purpose, true),
    set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.sqlstate_of(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.as_system(text), pg_temp.as_patient(text, text),
  pg_temp.as_staff(text, text, text, text, text), pg_temp.sqlstate_of(text) to public;

-- 2. Sign-up activation with an international phone. Before any migrated
-- patient exists, so identity.patient_contact_lookup_ready() is true.
create function pg_temp.signup_profile(n integer, phone text) returns text language sql as $$
  select format('{"kind":"signup","firstName":"Signup","lastName":"Person%s","email":"signup%s@example.invalid","phone":"%s","gender":"female"}',
    n, n, phone);
$$;
create function pg_temp.add_signup(n integer, phone text) returns void language sql as $$
  insert into identity.public_patient_enrollments (id, profile_ciphertext, profile_sha256, key_version, request_hmac,
    token_hmac, state, contact_channel, contact_hmac, contact_lookup_hmac, contact_ciphertext, contact_verified_at,
    verified_challenge_id, signup_email_lookup_hmac, signup_phone_lookup_hmac, signup_phone_ciphertext)
  values (('b2e10000-0000-4000-8000-00000000000' || n)::uuid, decode(repeat('b1', 32), 'hex'),
    encode(public.digest(pg_temp.signup_profile(n, phone), 'sha256'), 'hex'), 'fixture',
    repeat(n::text, 64), repeat('f', 63) || n, 'set_password', 'email', repeat('c', 63) || n,
    repeat('d', 63) || n, decode(repeat('e1', 32), 'hex'), clock_timestamp(),
    ('b2e20000-0000-4000-8000-00000000000' || n)::uuid, repeat('d', 63) || n, repeat('a', 63) || n,
    decode(repeat('a1', 32), 'hex'));
  insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, verifier_hmac,
    verifier_key_version, expires_at, max_attempts, delivery_outcome, verified_at, consumed_at)
  values (('b2e20000-0000-4000-8000-00000000000' || n)::uuid, ('b2e10000-0000-4000-8000-00000000000' || n)::uuid,
    repeat('c', 63) || n, 'email', repeat('7', 64), 'fixture', clock_timestamp() + interval '10 minutes', 5,
    'accepted', clock_timestamp(), clock_timestamp());
$$;
create function pg_temp.activate_signup(n integer, phone text, hid text) returns text language plpgsql as $$
declare
  outcome record;
begin
  select * into outcome from identity.activate_public_patient_signup(
    ('b2e10000-0000-4000-8000-00000000000' || n)::uuid, repeat('f', 63) || n, pg_temp.signup_profile(n, phone),
    'signup' || n || '@example.invalid', hid,
    '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljLXNhbHQ$synthetic-password-digest-not-an-operational-secret',
    repeat('d', 63) || n);
  return format('ok %s replayed=%s', outcome.hid_code, outcome.replayed);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.signup_profile(integer, text), pg_temp.activate_signup(integer, text, text) to public;
select pg_temp.add_signup(1, '+447700900123'), pg_temp.add_signup(2, '+6834002'), pg_temp.add_signup(3, '+2348031234567'),
  pg_temp.add_signup(4, '447700900124'), pg_temp.add_signup(5, '+234803123');
set local role hid_identity_api_runtime;
select pg_temp.as_system('parity-signup-0001');
do $$
declare
  answer text;
begin
  answer := pg_temp.activate_signup(1, '+447700900123', 'HID-SGNAAA');
  if answer <> 'ok HID-SGNAAA replayed=f' then raise exception 'A UK E.164 sign-up did not activate: %', answer; end if;
  answer := pg_temp.activate_signup(2, '+6834002', 'HID-SGNBBB');
  if answer <> 'ok HID-SGNBBB replayed=f' then raise exception 'A 7-digit E.164 sign-up did not activate: %', answer; end if;
  answer := pg_temp.activate_signup(3, '+2348031234567', 'HID-SGNCCC');
  if answer <> 'ok HID-SGNCCC replayed=f' then raise exception 'A Nigerian sign-up did not activate: %', answer; end if;
  answer := pg_temp.activate_signup(4, '447700900124', 'HID-SGNDDD');
  if answer not like '23514 PATIENT_IDENTITY_INVALID%' then raise exception 'A phone without + was admitted: %', answer; end if;
  answer := pg_temp.activate_signup(5, '+234803123', 'HID-SGNEEE');
  if answer <> 'ok HID-SGNEEE replayed=f' then raise exception 'A 9-digit E.164 sign-up did not activate: %', answer; end if;
  answer := pg_temp.activate_signup(1, '+447700900123', 'HID-SGNAAA');
  if answer <> 'ok HID-SGNAAA replayed=t' then raise exception 'A replay changed: %', answer; end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from identity.patients where hid_code in ('HID-SGNAAA', 'HID-SGNBBB', 'HID-SGNCCC', 'HID-SGNEEE')
        and source_system = 'hid-public-qoreid-enrollment') <> 4
     or (select count(*) from auth.accounts where email like 'signup_@example.invalid' and email_verified_at is not null) <> 4
     or exists (select 1 from identity.patients where hid_code = 'HID-SGNDDD')
     or (select count(*) from audit.events where correlation_id = 'parity-signup-0001'
          and action = 'identity.public-patient-enrollment.activated') <> 4 then
    raise exception 'The sign-up activation did not write exactly what 0092 writes';
  end if;
end $$;

-- 3-9. Fixtures. Accounts (b2a1...n): 1 migrated patient L (Health ID,
-- phone, verified email, a live patient session), 2 migrated and suspended
-- (disabled_until), 3 public-enrollment patient P, 4 deleted, 5 patient and
-- staff W, 6 unverified email U, 7 and 8 two patients sharing an email
-- (account email of 7, contact email HMAC of 8), 9 staff-only T, 10 migrated
-- pending_reset R, 11 patient K with a Google link, 12 the doctor, 13
-- patient Q (another patient, with a session).
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'parity-test'), ('emergency', 'Emergency treatment', 'parity-test')
  on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, disabled_until, email_verified_at, source_system,
  password_hash, password_algorithm) values
  ('b2a10000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000001', 'Legacy.One@example.invalid',
   'Legacy One', 'active', null, clock_timestamp(), 'legacy_identity', '$2b$10$syntheticsyntheticsyntheticsyntheticsyntheticsy', 'bcrypt_legacy'),
  ('b2a10000-0000-4000-8000-000000000002', 'b2a10000-0000-4000-8000-000000000002', 'legacy.banned@example.invalid',
   'Legacy Banned', 'active', clock_timestamp() + interval '30 days', clock_timestamp(), 'legacy_identity', null, null),
  ('b2a10000-0000-4000-8000-000000000003', 'patient:b2a10000-0000-4000-8000-000000000003', 'public.one@example.invalid',
   'Public One', 'active', null, clock_timestamp(), 'hid-public-qoreid-enrollment', null, null),
  ('b2a10000-0000-4000-8000-000000000004', 'synthetic:parity:deleted', 'deleted.one@example.invalid',
   'Deleted One', 'deleted', null, clock_timestamp(), 'legacy_identity', null, null),
  ('b2a10000-0000-4000-8000-000000000005', 'synthetic:parity:worker', 'worker@example.invalid',
   'Worker Patient', 'active', null, clock_timestamp(), 'hid', null, null),
  ('b2a10000-0000-4000-8000-000000000006', 'synthetic:parity:unverified', 'unverified@example.invalid',
   'Unverified One', 'active', null, null, 'legacy_identity', null, null),
  ('b2a10000-0000-4000-8000-000000000007', 'synthetic:parity:shared-a', 'shared@example.invalid',
   'Shared A', 'active', null, clock_timestamp(), 'legacy_identity', null, null),
  ('b2a10000-0000-4000-8000-000000000008', 'synthetic:parity:shared-b', 'other@example.invalid',
   'Shared B', 'active', null, clock_timestamp(), 'legacy_identity', null, null),
  ('b2a10000-0000-4000-8000-000000000009', 'synthetic:parity:staff-only', 'staffonly@example.invalid',
   'Staff Only', 'active', null, clock_timestamp(), 'hid', null, null),
  ('b2a10000-0000-4000-8000-000000000010', 'synthetic:parity:pending', 'pending@example.invalid',
   'Pending Reset', 'pending_reset', null, clock_timestamp(), 'legacy_identity', null, null),
  ('b2a10000-0000-4000-8000-000000000011', 'synthetic:parity:linked', 'linked@example.invalid',
   'Linked K', 'active', null, clock_timestamp(), 'legacy_identity', null, null),
  ('b2a10000-0000-4000-8000-000000000012', 'staff:parity-doctor', 'parity-doctor@example.invalid',
   'Parity Doctor', 'active', null, clock_timestamp(), 'hid', null, null),
  ('b2a10000-0000-4000-8000-000000000013', 'synthetic:parity:q', 'q.patient@example.invalid',
   'Q Patient', 'active', null, clock_timestamp(), 'hid', null, null);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system,
  phone_e164_ciphertext, phone_lookup_hmac, email_ciphertext, email_lookup_hmac, contact_key_version) values
  ('b2b10000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000001', 'HID-LGCYAA', 'Lami', 'Legacy',
   'Lami Legacy', 'active', 'legacy_identity', '\x01', repeat('1', 64), null, null, 'fixture'),
  ('b2b10000-0000-4000-8000-000000000002', 'b2a10000-0000-4000-8000-000000000002', 'HID-LGCYBB', 'Bisi', 'Banned',
   'Bisi Banned', 'active', 'legacy_identity', '\x02', repeat('2', 64), null, null, 'fixture'),
  ('b2b10000-0000-4000-8000-000000000003', 'b2a10000-0000-4000-8000-000000000003', 'HID-PUBCCC', 'Pele', 'Public',
   'Pele Public', 'active', 'hid-public-qoreid-enrollment', '\x03', repeat('3', 64), null, null, 'fixture'),
  ('b2b10000-0000-4000-8000-000000000004', 'b2a10000-0000-4000-8000-000000000004', 'HID-DELDDD', 'Dayo', 'Deleted',
   'Dayo Deleted', 'active', 'legacy_identity', '\x04', repeat('4', 64), null, null, 'fixture'),
  ('b2b10000-0000-4000-8000-000000000005', 'b2a10000-0000-4000-8000-000000000005', 'HID-WRKEEE', 'Wale', 'Worker',
   'Wale Worker', 'active', 'hid', null, null, null, null, null),
  ('b2b10000-0000-4000-8000-000000000006', 'b2a10000-0000-4000-8000-000000000006', 'HID-UNVFFF', 'Uche', 'Unverified',
   'Uche Unverified', 'active', 'legacy_identity', null, null, null, null, null),
  ('b2b10000-0000-4000-8000-000000000007', 'b2a10000-0000-4000-8000-000000000007', 'HID-AMBGGG', 'Amaka', 'Shared',
   'Amaka Shared', 'active', 'legacy_identity', null, null, null, null, null),
  ('b2b10000-0000-4000-8000-000000000008', 'b2a10000-0000-4000-8000-000000000008', 'HID-AMBHHH', 'Ade', 'Shared',
   'Ade Shared', 'active', 'legacy_identity', null, null, '\x08', repeat('e', 64), 'fixture'),
  ('b2b10000-0000-4000-8000-000000000010', 'b2a10000-0000-4000-8000-000000000010', 'HID-PNDJJJ', 'Pat', 'Pending',
   'Pat Pending', 'active', 'legacy_identity', null, null, null, null, null),
  ('b2b10000-0000-4000-8000-000000000011', 'b2a10000-0000-4000-8000-000000000011', 'HID-LNKKKK', 'Kemi', 'Linked',
   'Kemi Linked', 'active', 'legacy_identity', null, null, null, null, null),
  ('b2b10000-0000-4000-8000-000000000013', 'b2a10000-0000-4000-8000-000000000013', 'HID-QPTMMM', 'Quadri', 'Patient',
   'Quadri Patient', 'active', 'hid', null, null, null, null, null);
insert into auth.external_identities (id, account_id, issuer, subject, status, source_system) values
  ('b2c10000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000011', 'https://accounts.google.com',
   'google-existing-k', 'active', 'fixture'),
  ('b2c10000-0000-4000-8000-000000000002', 'b2a10000-0000-4000-8000-000000000002', 'https://accounts.google.com',
   'google-banned-s', 'disabled', 'fixture');
insert into identity.organizations (id, name, slug) values
  ('b2d10000-0000-4000-8000-000000000001', 'Parity Test Org', 'parity-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('b2d10000-0000-4000-8000-000000000002', 'b2d10000-0000-4000-8000-000000000001', 'Parity Test Hospital', 'PAR-H',
   'Africa/Lagos', true, 'verified'),
  ('b2d10000-0000-4000-8000-000000000003', 'b2d10000-0000-4000-8000-000000000001', 'Parity Laboratory', 'PAR-L',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('b2d20000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000012', 'Parity Doctor',
   'parity-doctor@example.invalid', 'verified', 'doctor'),
  ('b2d20000-0000-4000-8000-000000000002', 'b2a10000-0000-4000-8000-000000000005', 'Wale Worker',
   'worker@example.invalid', 'verified', 'nurse'),
  ('b2d20000-0000-4000-8000-000000000003', 'b2a10000-0000-4000-8000-000000000009', 'Staff Only',
   'staffonly@example.invalid', 'verified', 'nurse');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('b2d30000-0000-4000-8000-000000000001', 'b2d20000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000012',
   'b2d10000-0000-4000-8000-000000000001', 'b2d10000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('b2d40000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000012', 'doctor', 'facility',
   'b2d30000-0000-4000-8000-000000000001', 'b2d10000-0000-4000-8000-000000000002', 'Parity test doctor');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id, revoked_at,
  revocation_reason) values
  ('b2f10000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000001', 'b2f10000-0000-4000-8000-000000000001',
   md5('parity1') || md5('parity1'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'b2b10000-0000-4000-8000-000000000001', null, null),
  ('b2f10000-0000-4000-8000-000000000002', 'b2a10000-0000-4000-8000-000000000001', 'b2f10000-0000-4000-8000-000000000002',
   md5('parity2') || md5('parity2'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'b2b10000-0000-4000-8000-000000000001', clock_timestamp(), 'synthetic-test'),
  ('b2f10000-0000-4000-8000-000000000013', 'b2a10000-0000-4000-8000-000000000013', 'b2f10000-0000-4000-8000-000000000013',
   md5('parity13') || md5('parity13'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'b2b10000-0000-4000-8000-000000000013', null, null);

-- 3. auth.find_patient_account.
create function pg_temp.found(kind text, requested text) returns text language sql as $$
  select coalesce((select format('%s|%s|%s|%s|%s|%s|%s|%s', found.account_id, found.account_status,
      found.disabled_now::text, found.workforce::text, (found.password_hash is not null)::text,
      found.email_verified::text, found.patient_first_name, found.patient_hid_code)
    from auth.find_patient_account(kind, requested) found), 'none');
$$;
grant execute on function pg_temp.found(text, text) to public;
-- 2,000 other patients, each with an account, a phone and an email, and
-- fresh statistics, so that the planner reads these tables as it would in
-- production: by index wherever the comparison allows one.
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system)
select ('b2a90000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'synthetic:parity:bulk:' || n,
  'bulk' || n || '@example.invalid', 'Bulk ' || n, 'active', clock_timestamp(), 'legacy_identity'
  from generate_series(1, 2000) n;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system,
  phone_e164_ciphertext, phone_lookup_hmac, email_ciphertext, email_lookup_hmac, contact_key_version)
select ('b2b90000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('b2a90000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'HID-B' || translate(lpad(n::text, 5, '0'), '0123456789', 'ABCDEFGHJK'), 'Bulk', 'Patient', 'Bulk Patient',
  'active', 'legacy_identity', '\x01', md5('bulk-phone-' || n) || md5('bulk-phone-x-' || n), '\x01',
  md5('bulk-email-' || n) || md5('bulk-email-x-' || n), 'fixture'
  from generate_series(1, 2000) n;
analyze auth.accounts, identity.patients;
select set_config('hid.phone_index', 'identity.patients_phone_hmac_uq'::regclass::oid::text, true);
set local role hid_identity_api_runtime;
select pg_temp.as_system('parity-lookup-0001');
-- The phone is compared as char(64), the column's type, so that
-- patients_phone_hmac_uq answers it: a text comparison can only read every
-- patient, which no planner setting changes. With sequential scans off too,
-- each phone lookup scans the index.
set local enable_seqscan = off;
do $$
declare
  scans_before bigint := pg_stat_get_xact_numscans(current_setting('hid.phone_index')::oid);
begin
  if pg_temp.found('phone', repeat('1', 64)) not like 'b2a10000-0000-4000-8000-000000000001|%'
     or pg_temp.found('phone', repeat('9', 64) || ',' || repeat('1', 64))
        not like 'b2a10000-0000-4000-8000-000000000001|%' then
    raise exception 'The indexed phone lookup did not find patient L';
  end if;
  if pg_stat_get_xact_numscans(current_setting('hid.phone_index')::oid) < scans_before + 2 then
    raise exception 'The phone lookup does not use patients_phone_hmac_uq';
  end if;
end $$;
set local enable_seqscan = on;
do $$
declare
  mismatch text;
begin
  -- The bug the lookup fixes: Identity's direct query sees public patients only.
  if (select count(*) from identity.patients where upper(hid_code) = 'HID-LGCYAA') <> 0
     or (select count(*) from identity.patients where upper(hid_code) = 'HID-PUBCCC') <> 1 then
    raise exception 'The RLS premise changed: a direct query sees migrated patients, or not public ones';
  end if;
  select string_agg(format('%s/%s=%s', expected.kind, expected.requested, pg_temp.found(expected.kind, expected.requested)), '; ')
    into mismatch
    from (values
      ('hid', 'hid-lgcyaa', 'b2a10000-0000-4000-8000-000000000001|active|false|false|true|true|Lami|HID-LGCYAA'),
      ('hid', 'HID-LGCYAA', 'b2a10000-0000-4000-8000-000000000001|active|false|false|true|true|Lami|HID-LGCYAA'),
      ('phone', repeat('1', 64), 'b2a10000-0000-4000-8000-000000000001|active|false|false|true|true|Lami|HID-LGCYAA'),
      -- A Nigerian number's two forms (+234... and +2340...): one matches.
      ('phone', repeat('9', 64) || ',' || repeat('1', 64),
       'b2a10000-0000-4000-8000-000000000001|active|false|false|true|true|Lami|HID-LGCYAA'),
      ('phone', repeat('1', 64) || ',' || repeat('9', 64),
       'b2a10000-0000-4000-8000-000000000001|active|false|false|true|true|Lami|HID-LGCYAA'),
      ('phone', repeat('1', 64) || ',' || repeat('1', 64),
       'b2a10000-0000-4000-8000-000000000001|active|false|false|true|true|Lami|HID-LGCYAA'),
      -- Two accounts across the two forms answer as unknown.
      ('phone', repeat('1', 64) || ',' || repeat('3', 64), 'none'),
      ('phone', repeat('9', 64) || ',' || repeat('4', 64), 'none'),
      ('phone', repeat('1', 64) || ',', 'none'),
      ('phone', repeat('1', 64) || ',' || repeat('9', 64) || ',' || repeat('3', 64), 'none'),
      ('phone', upper(repeat('a', 64)), 'none'),
      ('account', 'b2a10000-0000-4000-8000-000000000001',
       'b2a10000-0000-4000-8000-000000000001|active|false|false|false|true|Lami|HID-LGCYAA'),
      ('hid', 'HID-LGCYBB', 'b2a10000-0000-4000-8000-000000000002|active|true|false|false|true|Bisi|HID-LGCYBB'),
      ('phone', repeat('3', 64), 'b2a10000-0000-4000-8000-000000000003|active|false|false|false|true|Pele|HID-PUBCCC'),
      ('hid', 'HID-WRKEEE', 'b2a10000-0000-4000-8000-000000000005|active|false|true|false|true|Wale|HID-WRKEEE'),
      ('hid', 'HID-PNDJJJ', 'b2a10000-0000-4000-8000-000000000010|pending_reset|false|false|false|true|Pat|HID-PNDJJJ'),
      ('hid', 'HID-UNVFFF', 'b2a10000-0000-4000-8000-000000000006|active|false|false|false|false|Uche|HID-UNVFFF'),
      ('hid', 'HID-DELDDD', 'none'),
      ('phone', repeat('4', 64), 'none'),
      ('phone', repeat('9', 64), 'none'),
      ('account', 'b2a10000-0000-4000-8000-000000000009', 'none'),
      ('hid', 'HID-0000AA', 'none'),
      ('hid', 'HID-LGCYAA'' or true --', 'none'),
      ('phone', 'zz', 'none'),
      ('email', 'legacy.one@example.invalid', 'none'),
      ('account', 'not-a-uuid', 'none')) expected(kind, requested, answer)
   where pg_temp.found(expected.kind, expected.requested) is distinct from expected.answer;
  if mismatch is not null then raise exception 'auth.find_patient_account answered: %', mismatch; end if;
  perform set_config('app.actor_subject', 'synthetic:parity:q', true);
  if pg_temp.sqlstate_of($q$select * from auth.find_patient_account('hid', 'HID-LGCYAA')$q$) not like '42501%' then
    raise exception 'auth.find_patient_account ran for a patient subject';
  end if;
  perform pg_temp.as_system('');
  if pg_temp.sqlstate_of($q$select * from auth.find_patient_account('hid', 'HID-LGCYAA')$q$) not like '42501%' then
    raise exception 'auth.find_patient_account ran without a correlation id';
  end if;
end $$;

-- 4. auth.patient_email_registered.
select pg_temp.as_system('parity-email-0001');
do $$
begin
  if not auth.patient_email_registered(' LEGACY.one@example.invalid ', null)
     or not auth.patient_email_registered('nobody@example.invalid', repeat('e', 64))
     or not auth.patient_email_registered('signup1@example.invalid', null)
     or auth.patient_email_registered('staffonly@example.invalid', null)
     or auth.patient_email_registered('deleted.one@example.invalid', null)
     or auth.patient_email_registered('nobody@example.invalid', null)
     or auth.patient_email_registered('', null)
     or auth.patient_email_registered('nobody@example.invalid', 'not-a-hmac') then
    raise exception 'auth.patient_email_registered answered wrongly';
  end if;
  perform set_config('app.actor_subject', 'synthetic:parity:q', true);
  if pg_temp.sqlstate_of($q$select auth.patient_email_registered('legacy.one@example.invalid', null)$q$) not like '42501%' then
    raise exception 'auth.patient_email_registered ran for a patient subject';
  end if;
end $$;

-- 5. auth.link_google_identity_by_verified_email.
create function pg_temp.google(subject text, email text, lookup text) returns text language sql as $$
  select coalesce((select format('%s|%s', linked.outcome, coalesce(linked.account_id::text, '-'))
    from auth.link_google_identity_by_verified_email(subject, email, lookup) linked), 'no row');
$$;
grant execute on function pg_temp.google(text, text, text) to public;
select set_config('hid.account_email_index', 'auth.accounts_email_ci_uq'::regclass::oid::text, true),
  set_config('hid.patient_email_index', 'identity.patients_email_hmac_uq'::regclass::oid::text, true);
select pg_temp.as_system('parity-google-0001');
-- The candidates come from two index lookups, not one OR across both tables
-- (which joins every patient whatever the planner may do): with sequential
-- scans off, an unlinked Google email scans both indexes.
set local enable_seqscan = off;
do $$
declare
  account_scans bigint := pg_stat_get_xact_numscans(current_setting('hid.account_email_index')::oid);
  patient_scans bigint := pg_stat_get_xact_numscans(current_setting('hid.patient_email_index')::oid);
begin
  if pg_temp.google('google-new-0', 'nobody@example.invalid', repeat('f', 64)) <> 'none|-' then
    raise exception 'An unknown Google email was not none';
  end if;
  if pg_stat_get_xact_numscans(current_setting('hid.account_email_index')::oid) <= account_scans
     or pg_stat_get_xact_numscans(current_setting('hid.patient_email_index')::oid) <= patient_scans then
    raise exception 'The Google candidates do not use accounts_email_ci_uq and patients_email_hmac_uq';
  end if;
end $$;
set local enable_seqscan = on;
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s/%s=%s', expected.subject, expected.email, expected.answer), '; ') into mismatch
    from (values
      ('google-banned-s', null, 'suspended|b2a10000-0000-4000-8000-000000000002'),
      ('google-existing-k', 'linked@example.invalid', 'already_linked|-'),
      ('google-new-0', null, 'unverified|-'),
      ('google-new-0', 'not an email', 'unverified|-'),
      ('google-new-0', 'nobody@example.invalid', 'none|-'),
      ('google-new-0', 'staffonly@example.invalid', 'none|-'),
      ('google-new-0', 'deleted.one@example.invalid', 'none|-'),
      ('google-new-0', 'unverified@example.invalid', 'not_verified|-'),
      ('google-new-0', 'worker@example.invalid', 'workforce|-'),
      ('google-new-0', 'legacy.banned@example.invalid', 'suspended|b2a10000-0000-4000-8000-000000000002'),
      ('google-new-0', 'pending@example.invalid', 'not_verified|-'),
      ('google-new-0', 'linked@example.invalid', 'linked_elsewhere|-')) expected(subject, email, answer)
   where pg_temp.google(expected.subject, expected.email, null) is distinct from expected.answer;
  if mismatch is not null then raise exception 'Google link outcomes differ (expected): %', mismatch; end if;
  -- Account 7's email and account 8's contact email HMAC: two patients.
  if pg_temp.google('google-new-0', 'shared@example.invalid', repeat('e', 64)) <> 'ambiguous|-' then
    raise exception 'Two patients with the email were not ambiguous';
  end if;
  -- Without the HMAC only account 7 matches, and it is linked.
  if pg_temp.google('google-new-7', 'shared@example.invalid', null) <> 'linked|b2a10000-0000-4000-8000-000000000007' then
    raise exception 'The one verified match was not linked';
  end if;
  if pg_temp.google('google-new-1', ' Legacy.One@Example.Invalid ', null) <> 'linked|b2a10000-0000-4000-8000-000000000001' then
    raise exception 'A migrated patient was not linked by verified email';
  end if;
  if pg_temp.google('google-new-1', 'legacy.one@example.invalid', null) <> 'already_linked|-'
     or pg_temp.google('google-new-2', 'legacy.one@example.invalid', null) <> 'linked_elsewhere|-' then
    raise exception 'A second link was not refused';
  end if;
  if (select account_id from auth.resolve_google_identity('google-new-1')) <> 'b2a10000-0000-4000-8000-000000000001' then
    raise exception 'The new link does not resolve as a linked Google sign-in';
  end if;
  if pg_temp.google('google-banned-s', 'legacy.banned@example.invalid', null)
       <> 'suspended|b2a10000-0000-4000-8000-000000000002' then
    raise exception 'A suspended linked patient was not told so';
  end if;
  perform set_config('app.actor_subject', 'synthetic:parity:q', true);
  if pg_temp.sqlstate_of($q$select * from auth.link_google_identity_by_verified_email('google-new-9', 'linked@example.invalid', null)$q$)
       not like '42501%' then
    raise exception 'The Google link ran for a patient subject';
  end if;
  perform pg_temp.as_system('parity-google-0001');
  if pg_temp.sqlstate_of($q$select * from auth.link_google_identity_by_verified_email(repeat('x', 256), 'linked@example.invalid', null)$q$)
       not like '42501%' then
    raise exception 'The Google link took an over-long subject';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from auth.external_identities where source_system = 'hid-google-verified-email-link') <> 2
     or not exists (select 1 from auth.external_identities where subject = 'google-new-1' and status = 'active'
                     and account_id = 'b2a10000-0000-4000-8000-000000000001'
                     and issuer = 'https://accounts.google.com')
     or exists (select 1 from auth.external_identities where subject in ('google-new-0', 'google-new-2', 'google-new-9')) then
    raise exception 'The Google link rows differ';
  end if;
  if (select count(*) from audit.events where correlation_id = 'parity-google-0001' and action = 'auth.google.auto-link'
        and outcome = 'success' and actor_type = 'patient' and details = '{"method": "verified_email"}'::jsonb) <> 2
     or not exists (select 1 from audit.events where correlation_id = 'parity-google-0001' and action = 'auth.google.auto-link'
                     and patient_id = 'b2b10000-0000-4000-8000-000000000001'
                     and actor_subject = 'b2a10000-0000-4000-8000-000000000001') then
    raise exception 'The Google link audit rows differ';
  end if;
  if (select count(*) from notification.inbox_items where notification_code = 'SECURITY_GOOGLE_LINKED') <> 2
     or exists (select 1 from notification.inbox_items where notification_code = 'SECURITY_GOOGLE_LINKED'
                 and (resource_type <> 'account' or resource_id is not null or metadata <> '{}'::jsonb)) then
    raise exception 'The Google linked notices differ';
  end if;
end $$;

-- 6. auth.record_account_security_notice.
insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac, verifier_key_version,
  expires_at, max_attempts, account_token_version) values
  ('b2c20000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000001', repeat('c', 64), 'PASSWORD_RESET',
   'email', repeat('b', 64), 'fixture', clock_timestamp() + interval '10 minutes', 5, 1),
  ('b2c20000-0000-4000-8000-000000000011', 'b2a10000-0000-4000-8000-000000000011', repeat('c', 52) || '000000000011', 'PASSWORD_RESET',
   'email', repeat('b', 64), 'fixture', clock_timestamp() + interval '10 minutes', 5, 1),
  ('b2c20000-0000-4000-8000-000000000009', 'b2a10000-0000-4000-8000-000000000009', repeat('c', 52) || '000000000009', 'PASSWORD_RESET',
   'email', repeat('b', 64), 'fixture', clock_timestamp() + interval '10 minutes', 5, 1),
  ('b2c20000-0000-4000-8000-000000000004', 'b2a10000-0000-4000-8000-000000000004', repeat('c', 52) || '000000000004', 'PASSWORD_RESET',
   'email', repeat('b', 64), 'fixture', clock_timestamp() + interval '10 minutes', 5, 1);
create function pg_temp.notice(account text, code text) returns text language sql as $$
  select case when auth.record_account_security_notice(account::uuid, code) is null then 'null' else 'item' end;
$$;
grant execute on function pg_temp.notice(text, text) to public;
set local role hid_identity_api_runtime;
select pg_temp.as_system('parity-notice-0001');
do $$
declare
  expected record;
  answer text;
begin
  -- In order: the second reset request within the hour writes nothing.
  for expected in select * from (values
      (1, 'b2a10000-0000-4000-8000-000000000001', 'SECURITY_PASSWORD_RESET_REQUESTED', 'item'),
      (2, 'b2a10000-0000-4000-8000-000000000001', 'SECURITY_PASSWORD_RESET_REQUESTED', 'null'),
      -- No password change; the automatic link of section 5 already told.
      (3, 'b2a10000-0000-4000-8000-000000000001', 'SECURITY_PASSWORD_CHANGED', 'null'),
      (4, 'b2a10000-0000-4000-8000-000000000001', 'SECURITY_GOOGLE_LINKED', 'null'),
      -- No recovery challenge, a staff-only account, a deleted login.
      (5, 'b2a10000-0000-4000-8000-000000000003', 'SECURITY_PASSWORD_RESET_REQUESTED', 'null'),
      (6, 'b2a10000-0000-4000-8000-000000000009', 'SECURITY_PASSWORD_RESET_REQUESTED', 'null'),
      (7, 'b2a10000-0000-4000-8000-000000000004', 'SECURITY_PASSWORD_RESET_REQUESTED', 'null'),
      -- Codes outside the allowlist, an unknown account.
      (8, 'b2a10000-0000-4000-8000-000000000001', 'SECURITY_NEW_SIGN_IN', 'null'),
      (9, 'b2a10000-0000-4000-8000-000000000001', 'security_password_changed', 'null'),
      (10, 'b2a10000-0000-4000-8000-0000000000ff', 'SECURITY_PASSWORD_CHANGED', 'null'))
      steps(step, account, code, answer) order by step loop
    answer := pg_temp.notice(expected.account, expected.code);
    if answer <> expected.answer then
      raise exception 'Security notice step % (%/%) answered %', expected.step, expected.account, expected.code, answer;
    end if;
  end loop;
  if auth.record_account_security_notice(null, 'SECURITY_PASSWORD_CHANGED') is not null
     or auth.record_account_security_notice('b2a10000-0000-4000-8000-000000000001', null) is not null then
    raise exception 'A null argument wrote a notice';
  end if;
  -- The explicit link (0059) as Identity calls it, then its notice.
  perform auth.link_google_identity_to_patient_account('b2a10000-0000-4000-8000-000000000003', 'google-explicit-p');
  if pg_temp.notice('b2a10000-0000-4000-8000-000000000003', 'SECURITY_GOOGLE_LINKED') <> 'item'
     or pg_temp.notice('b2a10000-0000-4000-8000-000000000003', 'SECURITY_GOOGLE_LINKED') <> 'null' then
    raise exception 'The explicit link''s notice was not written exactly once';
  end if;
  perform set_config('app.actor_subject', 'synthetic:parity:q', true);
  if pg_temp.sqlstate_of($q$select auth.record_account_security_notice('b2a10000-0000-4000-8000-000000000001', 'SECURITY_PASSWORD_CHANGED')$q$)
       not like '42501%' then
    raise exception 'A security notice was written for a patient subject';
  end if;
end $$;
-- A completed recovery as Identity completes it (0029), then its notice
-- (patient K, so that L's session stays live for sections 8 and 9).
reset role;
update auth.otp_challenges set verified_at = clock_timestamp(), completion_token_hmac = repeat('a', 64),
  completion_expires_at = clock_timestamp() + interval '5 minutes' where id = 'b2c20000-0000-4000-8000-000000000011';
set local role hid_identity_api_runtime;
select pg_temp.as_system('parity-notice-0002');
do $$
begin
  if not auth.complete_recovery_otp('b2c20000-0000-4000-8000-000000000011', 'PASSWORD_RESET', repeat('a', 64),
      '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljLXNhbHQ$synthetic-password-digest-not-an-operational-secret') then
    raise exception 'The fixture recovery did not complete';
  end if;
  if pg_temp.notice('b2a10000-0000-4000-8000-000000000011', 'SECURITY_PASSWORD_CHANGED') <> 'item'
     or pg_temp.notice('b2a10000-0000-4000-8000-000000000011', 'SECURITY_PASSWORD_CHANGED') <> 'null' then
    raise exception 'The password-changed notice was not written exactly once';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from notification.inbox_items where account_id = 'b2a10000-0000-4000-8000-000000000001'
        and notification_code in ('SECURITY_PASSWORD_RESET_REQUESTED', 'SECURITY_GOOGLE_LINKED')) <> 2
     or (select count(*) from notification.inbox_items where account_id = 'b2a10000-0000-4000-8000-000000000011'
        and notification_code = 'SECURITY_PASSWORD_CHANGED') <> 1
     or exists (select 1 from notification.inbox_items where notification_code like 'SECURITY\_%'
                 and (resource_type <> 'account' or resource_id is not null or metadata <> '{}'::jsonb
                   or patient_id is null))
     or exists (select 1 from notification.inbox_items where account_id in ('b2a10000-0000-4000-8000-000000000004',
                 'b2a10000-0000-4000-8000-000000000009')) then
    raise exception 'The security notices in the inbox differ';
  end if;
end $$;

-- 7. A clinician ending their own access early.
set local role hid_identity_api_runtime;
select pg_temp.as_staff('staff:parity-doctor', 'b2d30000-0000-4000-8000-000000000001',
  'b2d10000-0000-4000-8000-000000000002', 'direct-care', 'parity-close-0001');
select set_config('hid.request', (select access_request_id::text
  from identity.create_access_request('HID-LGCYAA', 'read_records', 'Follow-up visit for review', 60)), true);
select pg_temp.as_patient('b2a10000-0000-4000-8000-000000000001', 'parity-close-0002');
select set_config('hid.grant', (select consent_grant_id::text
  from identity.approve_access_request(current_setting('hid.request')::uuid)), true);
reset role;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('b2c30000-0000-4000-8000-000000000001', 'b2b10000-0000-4000-8000-000000000001', 'b2d20000-0000-4000-8000-000000000001',
   'b2a10000-0000-4000-8000-000000000012', 'b2d30000-0000-4000-8000-000000000001', 'b2d10000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Expired workforce grant', clock_timestamp() - interval '2 hours',
   clock_timestamp() - interval '1 hour', false, 'parity-close-0003', 'hid'),
  ('b2c30000-0000-4000-8000-000000000002', 'b2b10000-0000-4000-8000-000000000004', 'b2d20000-0000-4000-8000-000000000001',
   'b2a10000-0000-4000-8000-000000000012', 'b2d30000-0000-4000-8000-000000000001', 'b2d10000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Grant on a deleted login', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'parity-close-0004', 'hid');
create function pg_temp.close_grant(grant_id text, reason text) returns text language plpgsql as $$
declare
  outcome record;
begin
  select * into outcome from identity.close_own_consent_grant(grant_id::uuid, reason);
  return format('%s replayed=%s', outcome.grant_status, outcome.already_closed);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.close_grant(text, text) to public;
set local role hid_identity_api_runtime;
select pg_temp.as_staff('staff:parity-doctor', 'b2d30000-0000-4000-8000-000000000001',
  'b2d10000-0000-4000-8000-000000000002', 'direct-care', 'parity-close-0005');
do $$
declare
  answer text;
begin
  answer := pg_temp.close_grant(current_setting('hid.grant'), 'Clinician finished this episode');
  if answer <> 'revoked replayed=f' then raise exception 'The close answered %', answer; end if;
  answer := pg_temp.close_grant(current_setting('hid.grant'), 'Clinician finished this episode');
  if answer <> 'revoked replayed=t' then raise exception 'The replay answered %', answer; end if;
  answer := pg_temp.close_grant('b2c30000-0000-4000-8000-000000000001', 'Closing an expired grant');
  if answer <> 'revoked replayed=f' then raise exception 'The expired close answered %', answer; end if;
  answer := pg_temp.close_grant('b2c30000-0000-4000-8000-000000000002', 'Closing a deleted login grant');
  if answer <> 'revoked replayed=f' then raise exception 'The deleted-login close answered %', answer; end if;
  answer := pg_temp.close_grant('b2c30000-0000-4000-8000-0000000000ff', 'No such grant here');
  if answer not like 'P0002%' then raise exception 'An unknown grant answered %', answer; end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from notification.inbox_items where notification_code = 'CONSENT_GRANT_ENDED_BY_CLINICIAN') <> 1
     or not exists (select 1 from notification.inbox_items
                     where notification_code = 'CONSENT_GRANT_ENDED_BY_CLINICIAN'
                       and account_id = 'b2a10000-0000-4000-8000-000000000001'
                       and patient_id = 'b2b10000-0000-4000-8000-000000000001'
                       and resource_type = 'consent-grant' and resource_id = current_setting('hid.grant')::uuid
                       and metadata = '{"facilityName": "Parity Test Hospital"}'::jsonb) then
    raise exception 'The early-end notice differs (one, facilityName only; none on replay, after expiry or for a deleted login)';
  end if;
  if (select count(*) from audit.events where correlation_id = 'parity-close-0005'
        and action = 'identity.consent-grant.close' and reason = 'Clinician finished this episode'
        and details = '{"existing_closure": false}'::jsonb) <> 1
     or (select count(*) from audit.events where correlation_id = 'parity-close-0005'
        and action = 'identity.consent-grant.close.replay') <> 1 then
    raise exception 'The close''s audit rows changed';
  end if;
end $$;
-- Another clinician cannot close it.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('b2a10000-0000-4000-8000-000000000014', 'staff:parity-other', 'parity-other@example.invalid', 'Other Doctor', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('b2d20000-0000-4000-8000-000000000004', 'b2a10000-0000-4000-8000-000000000014', 'Other Doctor',
   'parity-other@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('b2d30000-0000-4000-8000-000000000004', 'b2d20000-0000-4000-8000-000000000004', 'b2a10000-0000-4000-8000-000000000014',
   'b2d10000-0000-4000-8000-000000000001', 'b2d10000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('b2d40000-0000-4000-8000-000000000004', 'b2a10000-0000-4000-8000-000000000014', 'doctor', 'facility',
   'b2d30000-0000-4000-8000-000000000004', 'b2d10000-0000-4000-8000-000000000002', 'Parity other doctor');
set local role hid_identity_api_runtime;
select pg_temp.as_staff('staff:parity-other', 'b2d30000-0000-4000-8000-000000000004',
  'b2d10000-0000-4000-8000-000000000002', 'direct-care', 'parity-close-0006');
do $$
begin
  if pg_temp.close_grant(current_setting('hid.grant'), 'Not my grant to close') not like 'P0002%' then
    raise exception 'Another clinician could close the grant';
  end if;
end $$;
reset role;

-- 8. The unread count.
insert into migration.runs (id, source_system, source_snapshot, mode, status, started_by, completed_at)
values ('b2c40000-0000-4000-8000-000000000001', 'hid-1.0', 'fixture', 'stage', 'completed', 'parity-test', clock_timestamp());
insert into notification.imported_inbox_items (id, account_id, patient_id, source_run_id, title, message,
  notification_type, source_read_at, source_created_at, source_payload, source_sha256) values
  ('b2c50000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000001', 'b2b10000-0000-4000-8000-000000000001',
   'b2c40000-0000-4000-8000-000000000001', 'Old unread', 'Unread', 'info', null, clock_timestamp() - interval '9 days',
   '{}', repeat('a', 64)),
  ('b2c50000-0000-4000-8000-000000000002', 'b2a10000-0000-4000-8000-000000000001', 'b2b10000-0000-4000-8000-000000000001',
   'b2c40000-0000-4000-8000-000000000001', 'Old read there', 'Read in hid-1.0', 'info', clock_timestamp() - interval '8 days',
   clock_timestamp() - interval '9 days', '{}', repeat('b', 64)),
  ('b2c50000-0000-4000-8000-000000000003', 'b2a10000-0000-4000-8000-000000000001', 'b2b10000-0000-4000-8000-000000000001',
   'b2c40000-0000-4000-8000-000000000001', 'Old read here', 'Read on Health ID', 'info', null,
   clock_timestamp() - interval '9 days', '{}', repeat('c', 64)),
  ('b2c50000-0000-4000-8000-000000000004', 'b2a10000-0000-4000-8000-000000000013', 'b2b10000-0000-4000-8000-000000000013',
   'b2c40000-0000-4000-8000-000000000001', 'Not hers', 'Another patient', 'info', null,
   clock_timestamp() - interval '9 days', '{}', repeat('d', 64));
insert into notification.imported_inbox_reads (item_id, account_id) values
  ('b2c50000-0000-4000-8000-000000000003', 'b2a10000-0000-4000-8000-000000000001');
insert into notification.inbox_items (account_id, patient_id, notification_code, read_at) values
  ('b2a10000-0000-4000-8000-000000000001', 'b2b10000-0000-4000-8000-000000000001', 'SYNTHETIC_READ', clock_timestamp()),
  ('b2a10000-0000-4000-8000-000000000013', 'b2b10000-0000-4000-8000-000000000013', 'SYNTHETIC_OTHER', null);
set local role hid_identity_api_runtime;
select pg_temp.as_patient('b2a10000-0000-4000-8000-000000000001', 'parity-count-0001');
do $$
declare
  unread integer;
  first_item uuid;
begin
  -- Inbox: the reset request, the Google link, section 7's access request
  -- and its early end (4 unread; one read item); imported: one unread of
  -- three.
  unread := identity.count_my_unread_notifications('b2a10000-0000-4000-8000-000000000001',
    'b2f10000-0000-4000-8000-000000000001');
  if unread is distinct from 5 then raise exception 'The unread count is %, not 5', unread; end if;
  select id into first_item from identity.list_my_notification_inbox(100) where read_at is null limit 1;
  perform identity.mark_my_notification_read(first_item);
  perform identity.mark_my_imported_notification_read('b2c50000-0000-4000-8000-000000000001');
  unread := identity.count_my_unread_notifications('b2a10000-0000-4000-8000-000000000001',
    'b2f10000-0000-4000-8000-000000000001');
  if unread is distinct from 3 then raise exception 'The unread count after two reads is %, not 3', unread; end if;
  if identity.count_my_unread_notifications('b2a10000-0000-4000-8000-000000000001',
       'b2f10000-0000-4000-8000-000000000002') is not null
     or identity.count_my_unread_notifications('b2a10000-0000-4000-8000-000000000001',
       'b2f10000-0000-4000-8000-000000000013') is not null
     or identity.count_my_unread_notifications('b2a10000-0000-4000-8000-000000000013',
       'b2f10000-0000-4000-8000-000000000013') is not null then
    raise exception 'The count answered for a revoked session, another patient''s session or another subject';
  end if;
end $$;
select pg_temp.as_patient('synthetic:parity:q', 'parity-count-0002');
do $$
begin
  if identity.count_my_unread_notifications('synthetic:parity:q',
       'b2f10000-0000-4000-8000-000000000013') is distinct from 2 then
    raise exception 'Another patient''s count is not their own';
  end if;
end $$;
reset role;

-- 9. The access log. Audit rows for patient L as the services write them.
create function pg_temp.audit_row(minutes_ago integer, actor_type text, actor_subject text, actor_account text,
  membership text, facility text, patient text, action text, outcome text, provenance text default 'application')
returns void language sql as $$
  insert into audit.events (occurred_at, correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id, action, outcome, provenance, source_system,
    source_event_id, details)
  values (clock_timestamp() - make_interval(mins => minutes_ago), 'parity-access-log-0001', actor_type, actor_subject,
    actor_account::uuid, membership::uuid, case when facility is null then null else 'b2d10000-0000-4000-8000-000000000001'::uuid end,
    facility::uuid, patient::uuid, action, outcome, provenance,
    case when provenance = 'legacy_identity' then 'hid-1.0' else 'parity-test' end,
    case when provenance = 'legacy_identity' then 'legacy-event-1' end, '{"resource": "never shown"}'::jsonb);
$$;
select set_config('hid.doctor', 'b2a10000-0000-4000-8000-000000000012', true),
  set_config('hid.membership', 'b2d30000-0000-4000-8000-000000000001', true),
  set_config('hid.hospital', 'b2d10000-0000-4000-8000-000000000002', true),
  set_config('hid.lab', 'b2d10000-0000-4000-8000-000000000003', true),
  set_config('hid.patient', 'b2b10000-0000-4000-8000-000000000001', true);
select pg_temp.audit_row(120, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'ehr.encounter.list', 'success'),
  pg_temp.audit_row(119, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'ehr.note.list', 'success'),
  pg_temp.audit_row(118, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'ehr.note.create', 'success'),
  pg_temp.audit_row(117, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'ehr.note.read', 'denied'),
  pg_temp.audit_row(116, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'api.ehr.note.read.request', 'success'),
  pg_temp.audit_row(115, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'identity.authorization.check', 'success'),
  pg_temp.audit_row(114, 'patient', 'b2a10000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000001', null,
    null, current_setting('hid.patient'), 'ehr.patient.self.records.read', 'success'),
  pg_temp.audit_row(113, 'legacy', null, null, null, null, current_setting('hid.patient'), 'ehr.encounter.read', 'success',
    'legacy_identity'),
  pg_temp.audit_row(112, 'workload', 'workload:lab-api', null, null, current_setting('hid.lab'), current_setting('hid.patient'),
    'lab.result.release', 'success'),
  pg_temp.audit_row(111, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'ehr.encounter.read', 'success'),
  pg_temp.audit_row(110, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), 'b2b10000-0000-4000-8000-000000000013', 'ehr.encounter.read', 'success'),
  pg_temp.audit_row(95, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'ehr.vital.list', 'success'),
  pg_temp.audit_row(90, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'identity.break-glass.activate', 'success'),
  pg_temp.audit_row(89, 'staff', 'staff:parity-doctor', current_setting('hid.doctor'), current_setting('hid.membership'),
    current_setting('hid.hospital'), current_setting('hid.patient'), 'identity.break-glass.replay', 'success');
-- Expected, newest first: section 7's two closes of L's grants (the expired
-- one, then the approved one; the replay is left out), the approval,
-- emergency access, two views, the laboratory's change, the doctor's change,
-- and the two first views as one entry at the later time.
create function pg_temp.access_page(lim integer, before_at text, before_sequence text) returns jsonb language sql as $$
  select identity.patient_self_access_log('b2a10000-0000-4000-8000-000000000001',
    'b2f10000-0000-4000-8000-000000000001', lim, before_at::timestamptz, before_sequence::bigint);
$$;
create function pg_temp.shape(events jsonb) returns text language sql as $$
  select coalesce(string_agg(format('%s/%s/%s/%s', event->>'action', event->>'actorKind',
      coalesce(event->>'actorName', '-'), coalesce(event->>'facilityName', '-')), ', ' order by ordinality), '')
    from jsonb_array_elements(events) with ordinality as listed(event, ordinality);
$$;
grant execute on function pg_temp.access_page(integer, text, text), pg_temp.shape(jsonb) to public;
select set_config('hid.collapsed_event', (select event_id::text from audit.events
  where correlation_id = 'parity-access-log-0001' and action = 'ehr.note.list'), true);
set local role hid_identity_api_runtime;
select pg_temp.as_patient('b2a10000-0000-4000-8000-000000000001', 'parity-access-log-0002');
do $$
declare
  expected constant text := 'access_ended/clinician/Parity Doctor/Parity Test Hospital, '
    || 'access_ended/clinician/Parity Doctor/Parity Test Hospital, '
    || 'access_granted/patient/-/Parity Test Hospital, '
    || 'emergency_access/clinician/Parity Doctor/Parity Test Hospital, '
    || 'viewed/clinician/Parity Doctor/Parity Test Hospital, '
    || 'viewed/clinician/Parity Doctor/Parity Test Hospital, '
    || 'changed/facility/-/Parity Laboratory, '
    || 'changed/clinician/Parity Doctor/Parity Test Hospital, '
    || 'viewed/clinician/Parity Doctor/Parity Test Hospital';
  whole jsonb;
  page jsonb;
  collected jsonb := '[]'::jsonb;
  pages integer := 0;
  before_at text;
  before_sequence text;
begin
  whole := pg_temp.access_page(50, null, null);
  if pg_temp.shape(whole->'events') <> expected or whole->'next' <> 'null'::jsonb then
    raise exception 'The access log differs: % (next %)', pg_temp.shape(whole->'events'), whole->'next';
  end if;
  if exists (select 1 from jsonb_array_elements(whole->'events') event
              where (select array_agg(key order by key) from jsonb_object_keys(event) key)
                    <> array['action', 'actorKind', 'actorName', 'at', 'facilityName', 'id']
                 or event->>'at' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$') then
    raise exception 'An access-log entry has other keys or another time format';
  end if;
  if whole::text like '%never shown%' or whole::text like '%Follow-up visit%' or whole::text like '%Clinician finished%' then
    raise exception 'The access log carries details or reasons';
  end if;
  -- The first two views are one entry at the later time, with its event id.
  if (whole->'events'->8->>'id') <> current_setting('hid.collapsed_event') then
    raise exception 'The collapsed entry does not carry its latest event';
  end if;
  -- Keyset pages of 3 give the same entries in the same order.
  loop
    page := pg_temp.access_page(3, before_at, before_sequence);
    pages := pages + 1;
    collected := collected || (page->'events');
    exit when page->'next' = 'null'::jsonb or pages > 10;
    before_at := page->'next'->>'occurredAt';
    before_sequence := page->'next'->>'sequenceId';
  end loop;
  if pages <> 3 or collected <> whole->'events' then
    raise exception 'Keyset pages differ: % pages, %', pages, pg_temp.shape(collected);
  end if;
  if pg_temp.sqlstate_of($q$select pg_temp.access_page(3, '2026-01-01T00:00:00Z', null)$q$) not like '22023%' then
    raise exception 'A half cursor was accepted';
  end if;
  if (pg_temp.access_page(0, null, null)->'events') <> (pg_temp.access_page(1, null, null)->'events')
     or jsonb_array_length(pg_temp.access_page(500, null, null)->'events') <> 9 then
    raise exception 'The limit is not bounded to 1-100';
  end if;
  if identity.patient_self_access_log('b2a10000-0000-4000-8000-000000000001', 'b2f10000-0000-4000-8000-000000000002',
       50, null, null) is not null
     or identity.patient_self_access_log('b2a10000-0000-4000-8000-000000000001', 'b2f10000-0000-4000-8000-000000000013',
       50, null, null) is not null
     or identity.patient_self_access_log('b2a10000-0000-4000-8000-000000000013', 'b2f10000-0000-4000-8000-000000000013',
       50, null, null) is not null then
    raise exception 'The access log answered for a revoked session, another session or another subject';
  end if;
end $$;
select pg_temp.as_patient('synthetic:parity:q', 'parity-access-log-0003');
do $$
begin
  if pg_temp.shape(identity.patient_self_access_log('synthetic:parity:q',
       'b2f10000-0000-4000-8000-000000000013', 50, null, null)->'events')
       <> 'viewed/clinician/Parity Doctor/Parity Test Hospital' then
    raise exception 'Another patient''s log is not exactly their own';
  end if;
end $$;
reset role;
-- The scan cap: 2,100 rows the log leaves out, newer than the emergency access.
insert into audit.events (occurred_at, correlation_id, actor_type, actor_account_id, patient_id, action, outcome,
  provenance, source_system)
select clock_timestamp() - interval '80 minutes' + make_interval(secs => n), 'parity-access-log-0004', 'patient',
  'b2a10000-0000-4000-8000-000000000001', 'b2b10000-0000-4000-8000-000000000001', 'identity.patient.self.profile',
  'success', 'application', 'parity-test'
  from generate_series(1, 2100) n;
set local role hid_identity_api_runtime;
select pg_temp.as_patient('b2a10000-0000-4000-8000-000000000001', 'parity-access-log-0005');
do $$
declare
  page jsonb;
  collected jsonb := '[]'::jsonb;
  pages integer := 0;
  before_at text;
  before_sequence text;
  whole_shape text;
begin
  loop
    page := pg_temp.access_page(100, before_at, before_sequence);
    pages := pages + 1;
    collected := collected || (page->'events');
    exit when page->'next' = 'null'::jsonb or pages > 10;
    before_at := page->'next'->>'occurredAt';
    before_sequence := page->'next'->>'sequenceId';
  end loop;
  whole_shape := 'access_ended/clinician/Parity Doctor/Parity Test Hospital, '
    || 'access_ended/clinician/Parity Doctor/Parity Test Hospital, '
    || 'access_granted/patient/-/Parity Test Hospital, '
    || 'emergency_access/clinician/Parity Doctor/Parity Test Hospital, '
    || 'viewed/clinician/Parity Doctor/Parity Test Hospital, '
    || 'viewed/clinician/Parity Doctor/Parity Test Hospital, '
    || 'changed/facility/-/Parity Laboratory, '
    || 'changed/clinician/Parity Doctor/Parity Test Hospital, '
    || 'viewed/clinician/Parity Doctor/Parity Test Hospital';
  if pages < 2 or pg_temp.shape(collected) <> whole_shape
     or (select count(distinct event->>'id') from jsonb_array_elements(collected) event) <> 9 then
    raise exception 'Past the scan cap the pages differ: % pages, %', pages, pg_temp.shape(collected);
  end if;
end $$;
reset role;

-- Document downloads and OCR source reads (ehr-api), OCR reads (ocr-api),
-- routed orders sent and withdrawn (ehr-api), read, accepted and settled by
-- the receiving laboratory or pharmacy, and work items accepted, as the
-- services write them, for patient Q, 12 minutes apart (no collapsing). A
-- refused download, an interceptor row, the attestation text, a worker's
-- publication and a decline (which names no patient when written) are left
-- out.
-- The doctor also works at the laboratory (a second membership), so that
-- the receiving side's rows name a clinician there.
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('b2d30000-0000-4000-8000-000000000002', 'b2d20000-0000-4000-8000-000000000001', 'b2a10000-0000-4000-8000-000000000012',
   'b2d10000-0000-4000-8000-000000000001', 'b2d10000-0000-4000-8000-000000000003', 'doctor', 'doctor', false, true);
select pg_temp.audit_row(minutes_ago, 'staff', 'staff:parity-doctor', 'b2a10000-0000-4000-8000-000000000012',
    case facility when 'b2d10000-0000-4000-8000-000000000003' then 'b2d30000-0000-4000-8000-000000000002'
      else 'b2d30000-0000-4000-8000-000000000001' end,
    facility, 'b2b10000-0000-4000-8000-000000000013', action, outcome)
  from (values
    (200, 'b2d10000-0000-4000-8000-000000000002', 'ehr.document.download', 'success'),
    (212, 'b2d10000-0000-4000-8000-000000000002', 'ehr.document.download', 'denied'),
    (224, 'b2d10000-0000-4000-8000-000000000002', 'ehr.document.download.request', 'success'),
    (236, 'b2d10000-0000-4000-8000-000000000002', 'ehr.document.ocr-source.read', 'success'),
    (248, 'b2d10000-0000-4000-8000-000000000002', 'ehr.order-route.list', 'success'),
    (260, 'b2d10000-0000-4000-8000-000000000002', 'ehr.order-route.attestation-text.read', 'success'),
    (272, 'b2d10000-0000-4000-8000-000000000002', 'ehr.order-route.send', 'success'),
    (284, 'b2d10000-0000-4000-8000-000000000002', 'ehr.order-route.withdraw', 'success'),
    (296, 'b2d10000-0000-4000-8000-000000000002', 'ocr.job.read', 'success'),
    (308, 'b2d10000-0000-4000-8000-000000000002', 'ocr.extraction.list', 'success'),
    (320, 'b2d10000-0000-4000-8000-000000000002', 'ocr.validation.list', 'success'),
    (332, 'b2d10000-0000-4000-8000-000000000002', 'ocr.publication.list', 'success'),
    (344, 'b2d10000-0000-4000-8000-000000000002', 'ocr.publication.succeed', 'success'),
    (356, 'b2d10000-0000-4000-8000-000000000003', 'lab.order-route.read', 'success'),
    (368, 'b2d10000-0000-4000-8000-000000000003', 'lab.order-route.accept', 'success'),
    (380, 'b2d10000-0000-4000-8000-000000000003', 'lab.work-item.accept', 'success'),
    (392, 'b2d10000-0000-4000-8000-000000000003', 'lab.order-route.cannot-complete', 'success'),
    (404, 'b2d10000-0000-4000-8000-000000000003', 'lab.order-route.wrong-patient', 'success'),
    (416, 'b2d10000-0000-4000-8000-000000000003', 'lab.order-route.wrong-patient-correction', 'success'),
    (428, 'b2d10000-0000-4000-8000-000000000003', 'lab.order-route.decline', 'success'),
    (440, 'b2d10000-0000-4000-8000-000000000003', 'pharmacy.order-route.read', 'success'),
    (452, 'b2d10000-0000-4000-8000-000000000003', 'pharmacy.order-route.accept', 'success'),
    (464, 'b2d10000-0000-4000-8000-000000000003', 'pharmacy.work-item.accept', 'success'),
    (476, 'b2d10000-0000-4000-8000-000000000003', 'pharmacy.order-route.cannot-complete', 'success'),
    (488, 'b2d10000-0000-4000-8000-000000000003', 'pharmacy.order-route.wrong-patient', 'success'),
    (500, 'b2d10000-0000-4000-8000-000000000003', 'pharmacy.order-route.wrong-patient-correction', 'success'))
    q_rows(minutes_ago, facility, action, outcome);
set local role hid_identity_api_runtime;
select pg_temp.as_patient('synthetic:parity:q', 'parity-access-log-0006');
do $$
declare
  hospital_view constant text := 'viewed/clinician/Parity Doctor/Parity Test Hospital';
  hospital_change constant text := 'changed/clinician/Parity Doctor/Parity Test Hospital';
  lab_view constant text := 'viewed/clinician/Parity Doctor/Parity Laboratory';
  lab_change constant text := 'changed/clinician/Parity Doctor/Parity Laboratory';
  expected text;
  answer jsonb;
begin
  expected := array_to_string(array[
    hospital_view,                                  -- section 9's encounter read
    hospital_view, hospital_view, hospital_view,    -- download, OCR source, order-route list
    hospital_change, hospital_change,               -- send, withdraw
    hospital_view, hospital_view, hospital_view, hospital_view,  -- OCR job, extraction, validation, publication
    lab_view, lab_view,                             -- laboratory route read, accept
    lab_change, lab_change, lab_change, lab_change, -- work item, cannot complete, wrong patient, correction
    lab_view, lab_view,                             -- pharmacy route read, accept
    lab_change, lab_change, lab_change, lab_change], ', ');
  answer := identity.patient_self_access_log('synthetic:parity:q', 'b2f10000-0000-4000-8000-000000000013', 50, null, null);
  if pg_temp.shape(answer->'events') <> expected or answer->'next' <> 'null'::jsonb then
    raise exception 'Downloads, OCR reads and routed orders in the access log differ: %', pg_temp.shape(answer->'events');
  end if;
end $$;
reset role;

rollback;
