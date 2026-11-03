\set ON_ERROR_STOP on
-- The sealed demo profiles complete (0119, owner decision of 2026-11-03).
-- Rollback-only. On the databases CI and the release rehearsals use (plain
-- PostgreSQL, no rds_superuser) 0098, 0102 and 0119 install their functions
-- and seed nothing, so this suite calls identity.sealed_demo_install(),
-- identity.demo_story_install() (with a PIN hash of its own) and
-- identity.demo_profile_install() itself, as the owner, inside its
-- transaction.
--   1. structure: the two new functions (owner, SECURITY DEFINER,
--      search_path, ACLs: the phone check to the Identity and schema test
--      runtimes only, the seed to no role), G5's trigger as 0098 made it, the
--      nine sealed demo triggers enabled, 0098's fifteen sealed_demo_*
--      functions unchanged in number; nothing seeded here;
--   2. the seed's refusals, each writing nothing: the logins before the
--      owner's password resets, a patient that is not the demo's, the doctor
--      membership inactive or without identity.registration.write;
--   3. the phone: Adaeze's and Chinedu's own fictional numbers pass the
--      check and change_my_phone answers changed, and patient_self_contact
--      then returns the number Identity wrote; refused with 22023 and
--      nothing written: no check asked (an Identity image before 0119), a
--      wrong number (nearby numbers and other forms of the same digits, for
--      each patient), the other patient's number, a malformed HMAC, a
--      recorded HMAC that is not the change's, a value recorded for the
--      other patient; the check answers 42501 without a session; a real
--      patient's phone change is unaffected (no check needed, and the check
--      answers true), except that the two demo numbers are refused to a real
--      patient (false, nothing recorded or written);
--   4. the NIN seed: one resolved registration case and one nin identifier
--      per patient, with no NIN in either; the audit; patient_self_profile
--      answers ninVerified true and assuranceState CONTACT_VERIFIED; no
--      verification evidence, authoritative profile, NIN hash or QoreID
--      quota row; the self-check's eligibility answers denied for any HMAC;
--      sign-up's NIN check finds none of the typed values; G6 still refuses
--      the demo accounts; a second call writes nothing; a fixed id held by
--      another row is refused;
--   5. the completion card: with a photo and an email emergency contact
--      added as Identity adds them, all twelve items for Adaeze and for
--      Chinedu, and the owner's post-deploy query in the header answers true
--      in every column for both.
-- Synthetic values only: the real fixture uses uuid prefix 98b119 and an
-- @example.invalid address.
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
 where control_key in ('cross_facility_orders_enabled', 'break_glass_enabled');
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'sealed-profile-test'), ('emergency', 'Emergency', 'sealed-profile-test')
  on conflict (code) do update set active = true;

create function pg_temp.assert(label text, condition boolean, detail text default null)
returns void language plpgsql as $f$
begin
  if condition is not true then
    raise exception 'sealed demo profile: % failed%', label, coalesce(': ' || detail, '');
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
create function pg_temp.as_patient(subject text, account uuid, session uuid, patient uuid)
returns void language sql as $f$
  select set_config('app.actor_subject', subject, true),
    set_config('app.account_id', account::text, true),
    set_config('app.session_id', session::text, true),
    set_config('app.patient_id', patient::text, true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '5 minutes')::text, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'sealed-profile-patient-' || substr(md5(random()::text), 1, 12), true),
    set_config('app.purpose_of_use', 'patient-self', true);
$f$;
create function pg_temp.as_demo_patient(n integer)
returns void language sql as $f$
  select pg_temp.as_patient('patient:98d00008-0000-4000-8000-00000000000' || n,
    ('98d00008-0000-4000-8000-00000000000' || n)::uuid, ('98b1190b-0000-4000-8000-00000000000' || n)::uuid,
    ('98d00009-0000-4000-8000-00000000000' || n)::uuid);
$f$;
create function pg_temp.as_real_patient()
returns void language sql as $f$
  select pg_temp.as_patient('synthetic:sealed-profile:patient', '98b11908-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000009', '98b11909-0000-4000-8000-000000000001');
$f$;
create function pg_temp.clear_context()
returns void language sql as $f$
  select set_config('app.actor_subject', '', true), set_config('app.account_id', '', true),
    set_config('app.session_id', '', true), set_config('app.patient_id', '', true),
    set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
    set_config('app.correlation_id', '', true), set_config('app.purpose_of_use', '', true),
    set_config('hid.sealed_demo_phone_hmac', '', true);
$f$;
-- Identity's phone change as PatientContactChangeService.changePhone makes
-- it (ask = whether it asks the 0119 check first): its outcome, or the
-- SQLSTATE and message. The HMAC stands for the number's contact lookup HMAC.
create function pg_temp.change_phone(n integer, phone text, hmac text, ask boolean)
returns text language plpgsql as $f$
declare
  subject text := 'patient:98d00008-0000-4000-8000-00000000000' || n;
  session uuid := ('98b1190b-0000-4000-8000-00000000000' || n)::uuid;
  answer text;
begin
  if ask and not identity.demo_profile_phone_allowed(subject, session, phone, hmac::char(64)) then
    return 'not allowed';
  end if;
  select outcome into answer from identity.change_my_phone(subject, session, gen_random_uuid(), hmac::char(64),
    array[]::char(64)[], convert_to('sealed-profile-test-phone:' || phone, 'UTF8'), 'sealed-profile-v1', true);
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- What the seed and the phone change write, to compare before and after.
create function pg_temp.profile_counts()
returns text language sql as $f$
  select concat_ws(',',
    (select count(*) from identity.registration_cases), (select count(*) from identity.patient_identifiers),
    (select count(*) from identity.verification_evidence), (select count(*) from identity.patient_authoritative_profiles),
    (select count(*) from platform.qoreid_quota_counters), (select count(*) from identity.patient_contact_changes),
    (select count(*) from audit.events),
    (select string_agg(assurance.state || '/' || assurance.source_system, ';' order by assurance.patient_id)
       from identity.patient_assurance_states assurance where identity.sealed_demo_patient(assurance.patient_id)),
    (select count(*) from identity.patients where phone_lookup_hmac is not null or nin_hash is not null
                                             or nin_ciphertext is not null));
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_identity_api_runtime', proc.signature);
  end loop;
end $$;

-- 1. Structure, and nothing seeded by the migration on this database.
do $$
begin
  perform pg_temp.assert('the two functions are the owner''s, SECURITY DEFINER, with the fixed search_path',
    (select count(*) from pg_proc proc
      where proc.oid in ('identity.demo_profile_phone_allowed(text,uuid,text,character)'::regprocedure,
                         'identity.demo_profile_install()'::regprocedure)
        and proc.prosecdef and proc.provolatile = 'v'
        and proc.proowner = (select proc_row.proowner from pg_proc proc_row
                              where proc_row.oid = 'identity.sealed_demo_install()'::regprocedure)
        and proc.proconfig = array['search_path=pg_catalog, pg_temp']) = 2);
  perform pg_temp.assert('the phone check: the Identity and schema test runtimes only; the seed: no role',
    (select array_agg(role_row.rolname::text order by role_row.rolname) from pg_proc proc,
       aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       join pg_roles role_row on role_row.oid = acl.grantee
      where proc.oid = 'identity.demo_profile_phone_allowed(text,uuid,text,character)'::regprocedure
        and acl.grantee <> proc.proowner) = array['hid_identity_runtime', 'hid_schema_test_runtime']
    and has_function_privilege('hid_identity_api_runtime',
          'identity.demo_profile_phone_allowed(text,uuid,text,character)', 'EXECUTE')
    and not exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                     where proc.oid = 'identity.demo_profile_install()'::regprocedure and acl.grantee <> proc.proowner)
    and not exists (select 1 from pg_roles role_row
                     where role_row.rolname in ('hid_ehr_runtime', 'hid_lab_runtime', 'hid_pharmacy_runtime',
                       'hid_notification_runtime', 'hid_outreach_runtime', 'hid_ocr_runtime', 'hid_ehr_api_runtime')
                       and has_function_privilege(role_row.oid,
                             'identity.demo_profile_phone_allowed(text,uuid,text,character)', 'EXECUTE')));
  perform pg_temp.assert('G5: trigger, SECURITY DEFINER, search_path and ACL as 0098 made them; its new body',
    (select pg_get_triggerdef(trigger_row.oid) from pg_trigger trigger_row
      where trigger_row.tgname = 'patient_contact_changes_sealed_demo')
      = 'CREATE TRIGGER patient_contact_changes_sealed_demo BEFORE INSERT ON identity.patient_contact_changes FOR EACH '
        || 'ROW WHEN ((new.channel = ''phone''::text)) EXECUTE FUNCTION identity.patient_contact_changes_sealed_demo()'
    and (select proc.prosecdef and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                and not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                                 where acl.grantee <> proc.proowner)
                and proc.prosrc like '%hid.sealed_demo_phone_hmac%new.patient_id::text || '':'' || new.new_lookup_hmac%'
           from pg_proc proc where proc.oid = 'identity.patient_contact_changes_sealed_demo()'::regprocedure)
    and (select md5(prosrc) from pg_proc where oid = 'identity.qoreid_quota_counters_sealed_demo()'::regprocedure)
        = 'c36f6bf340c57501397fa844045df5f8');
  perform pg_temp.assert('nine sealed demo triggers enabled; still fifteen sealed_demo_* functions',
    (select count(*) from pg_trigger trigger_row where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
      and trigger_row.tgname in ('sealed_demo_members_immutable', 'sealed_demo_members_no_truncate',
        'consent_grants_sealed_demo', 'staff_memberships_sealed_demo', 'account_roles_sealed_demo',
        'patient_share_invitations_sealed_demo', 'patient_contact_changes_sealed_demo',
        'qoreid_quota_counters_sealed_demo', 'patient_emergency_contacts_sealed_demo')) = 9
    and (select count(*) from pg_proc proc
          where proc.pronamespace = 'identity'::regnamespace
            and (proc.proname like 'sealed\_demo\_%' or proc.proname like '%\_sealed\_demo')) = 15);
  perform pg_temp.assert('the migration seeded nothing here (not Amazon RDS)',
    not exists (select 1 from audit.events where correlation_id = '0119-sealed-demo-profile')
    and not exists (select 1 from identity.registration_cases where verification_provider = 'hid-sealed-demo'));
end $$;

select identity.sealed_demo_install();
update identity.consent_grants set starts_at = starts_at - interval '1 hour'
 where correlation_id = '0098-sealed-demo-install';
select set_config('hid.test.pin_hash', public.crypt('9157', public.gen_salt('bf', 12)), true);

-- 2. Refusals before the logins are ready.
select set_config('hid.test.before', pg_temp.profile_counts(), true);
select pg_temp.assert('before the owner''s password resets the patients are not ready, nothing written',
  pg_temp.try('select identity.demo_profile_install()') = '55000 0119: SEALED_DEMO_PROFILE_PATIENT_NOT_READY'
  and pg_temp.profile_counts() = current_setting('hid.test.before'));

-- Recovery as the owner does it (0098's and 0102's suites).
insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac, verifier_key_version,
  expires_at, max_attempts, verified_at, completion_token_hmac, completion_expires_at, account_token_version)
select ('98b1190f-0000-4000-8000-00000000000' || n)::uuid, account.id, md5('profile-recipient-' || n) || md5('r' || n),
  'PASSWORD_RESET', 'email', md5('profile-verifier-' || n) || md5('v' || n), 'profile-test-v1',
  clock_timestamp() + interval '10 minutes', 5, clock_timestamp(), md5('profile-completion-' || n) || md5('c' || n),
  clock_timestamp() + interval '10 minutes', account.token_version
  from (values (1, '98d00003-0000-4000-8000-000000000001'::uuid), (2, '98d00008-0000-4000-8000-000000000001'::uuid),
               (3, '98d00008-0000-4000-8000-000000000002'::uuid)) target(n, account_id)
  join auth.accounts account on account.id = target.account_id;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'sealed-profile-recovery', true);
select pg_temp.assert('recovery completes for the three demo logins',
  (select bool_and(auth.complete_recovery_otp(('98b1190f-0000-4000-8000-00000000000' || n)::uuid, 'PASSWORD_RESET',
     md5('profile-completion-' || n) || md5('c' || n),
     '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43)))
     from generate_series(1, 3) n));
reset role;
select pg_temp.clear_context();
select identity.demo_story_install(current_setting('hid.test.pin_hash'));
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('98b1190b-0000-4000-8000-00000000000' || n)::uuid, ('98d00008-0000-4000-8000-00000000000' || n)::uuid,
  ('98b1190b-0000-4000-8000-00000000000' || n)::uuid, md5('sealed-profile-' || n) || md5('sealed-profile-' || n),
  gen_random_uuid(), 2, 'password', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours', 'patient', ('98d00009-0000-4000-8000-00000000000' || n)::uuid
  from generate_series(1, 2) n;
-- A real patient (not demo) with a login and a session.
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at) values
  ('98b11908-0000-4000-8000-000000000001', 'synthetic:sealed-profile:patient', 'sealed-profile-patient@example.invalid',
   'Real Profile Patient', 'active', clock_timestamp());
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('98b11909-0000-4000-8000-000000000001', '98b11908-0000-4000-8000-000000000001', 'HID-SRPRFA', 'Rhoda', 'Realprofile',
   'Rhoda Realprofile', 'female', '1982-05-05', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('98b1190b-0000-4000-8000-000000000009', '98b11908-0000-4000-8000-000000000001', '98b1190b-0000-4000-8000-000000000009',
   md5('sealed-profile-real') || md5('sealed-profile-real'), gen_random_uuid(), 1, 'password',
   clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
   'patient', '98b11909-0000-4000-8000-000000000001');

-- Refusals with the logins ready, each in a savepoint, each writing nothing.
select set_config('hid.test.before', pg_temp.profile_counts(), true);
savepoint not_demo;
update identity.patients set account_id = null where id = '98d00009-0000-4000-8000-000000000002';
select pg_temp.assert('a patient that is not the demo''s as 0098 left it is refused',
  pg_temp.try('select identity.demo_profile_install()') = '55000 0119: SEALED_DEMO_PROFILE_NOT_DEMO');
rollback to savepoint not_demo;
savepoint doctor_inactive;
update identity.staff_facility_memberships set active = false where id = '98d00005-0000-4000-8000-000000000001';
select pg_temp.assert('the demo doctor membership inactive: refused',
  pg_temp.try('select identity.demo_profile_install()') = '55000 0119: SEALED_DEMO_PROFILE_ROLE_MISSING');
rollback to savepoint doctor_inactive;
savepoint doctor_revoked;
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = '98d00003-0000-4000-8000-000000000001',
  revocation_reason = 'Revoked for a test'
 where membership_id = '98d00005-0000-4000-8000-000000000001' and revoked_at is null;
select pg_temp.assert('the demo doctor without identity.registration.write: refused',
  pg_temp.try('select identity.demo_profile_install()') = '55000 0119: SEALED_DEMO_PROFILE_ROLE_MISSING');
rollback to savepoint doctor_revoked;
savepoint patient_inactive;
update identity.patients set status = 'inactive' where id = '98d00009-0000-4000-8000-000000000001';
select pg_temp.assert('Adaeze not active: refused',
  pg_temp.try('select identity.demo_profile_install()') = '55000 0119: SEALED_DEMO_PROFILE_PATIENT_NOT_READY');
rollback to savepoint patient_inactive;
select pg_temp.assert('nothing written by the refusals', pg_temp.profile_counts() = current_setting('hid.test.before'));

-- 3. The phone.
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(1);
select pg_temp.assert('the check answers true for Adaeze''s own number only, and records it for her',
  identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', '+447700900102', repeat('a', 64))
  and current_setting('hid.sealed_demo_phone_hmac') = '98d00009-0000-4000-8000-000000000001:' || repeat('a', 64)
  and not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', '+447700900103', repeat('a', 64))
  and current_setting('hid.sealed_demo_phone_hmac') = ''
  and not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', '+2348031234567', repeat('a', 64))
  and (select bool_and(not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
         '98b1190b-0000-4000-8000-000000000001', other, repeat('a', 64)))
         from unnest(array['+447700900101', '+447700900104', '+447700900112', '+447700900120',
           '+2347700900102', '+4407700900102', '+44770090010', '+4477009001020', '447700900102', '07700900102']) other)
  and current_setting('hid.sealed_demo_phone_hmac') = ''
  and not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', '+447700900102', repeat('A', 64))
  and not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', '+447700900102', null)
  and not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', null, repeat('a', 64))
  and not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', ' +447700900102', repeat('a', 64)));
select pg_temp.as_demo_patient(1);
select pg_temp.assert('the check answers 42501 without a live session (another patient''s session too)',
  pg_temp.try($q$select identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    gen_random_uuid(), '+447700900102', repeat('a', 64))$q$) = '42501 Patient self session is required'
  and pg_temp.try($q$select identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000002', '+447700900102', repeat('a', 64))$q$)
    = '42501 Patient self session is required');
reset role;
select set_config('hid.test.before', pg_temp.profile_counts(), true);
set local role hid_identity_api_runtime;
-- Refused with 22023, nothing written: no check asked (an Identity image
-- before 0119); a wrong number; the other patient's number; a recorded HMAC
-- that is not the change's; Adaeze's value recorded and Chinedu's change.
select pg_temp.as_demo_patient(1);
select set_config('hid.sealed_demo_phone_hmac', '', true);
select pg_temp.assert('a demo phone change without the check is refused (old Identity images)',
  pg_temp.change_phone(1, '+447700900102', repeat('b', 64), false) = '22023 PATIENT_CONTACT_CHANGE_INVALID');
select pg_temp.as_demo_patient(1);
select pg_temp.assert('a number other than Adaeze''s, or Chinedu''s, is not allowed and cannot be written',
  pg_temp.change_phone(1, '+447700900123', repeat('b', 64), true) = 'not allowed'
  and pg_temp.change_phone(1, '+447700900103', repeat('b', 64), true) = 'not allowed'
  and pg_temp.change_phone(1, '+447700900103', repeat('b', 64), false) = '22023 PATIENT_CONTACT_CHANGE_INVALID');
select pg_temp.as_demo_patient(1);
select pg_temp.assert('a recorded HMAC that is not the change''s is refused',
  identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', '+447700900102', repeat('c', 64))
  and pg_temp.change_phone(1, '+447700900102', repeat('b', 64), false) = '22023 PATIENT_CONTACT_CHANGE_INVALID');
select pg_temp.as_demo_patient(1);
select pg_temp.assert('a value recorded for Adaeze does not admit Chinedu''s change with the same HMAC',
  identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', '+447700900102', repeat('c', 64)));
select pg_temp.as_demo_patient(2);
select pg_temp.assert('... (Chinedu''s change refused)',
  pg_temp.change_phone(2, '+447700900102', repeat('c', 64), false) = '22023 PATIENT_CONTACT_CHANGE_INVALID');
select pg_temp.as_demo_patient(2);
select pg_temp.assert('the check answers false for Chinedu with any number but his own (the swap, nearby, other forms)',
  (select bool_and(not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000002',
     '98b1190b-0000-4000-8000-000000000002', other, repeat('a', 64))
     and current_setting('hid.sealed_demo_phone_hmac') = '')
     from unnest(array['+447700900102', '+447700900101', '+447700900104', '+447700900113', '+447700900130',
       '+2347700900103', '+4407700900103', '+44770090010', '+4477009001030', '+2348031234567', ' +447700900103',
       '447700900103', '07700900103']) other)
  and not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000002',
    '98b1190b-0000-4000-8000-000000000002', '+447700900103', repeat('A', 64))
  and not identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000002',
    '98b1190b-0000-4000-8000-000000000002', '+447700900103', null)
  and current_setting('hid.sealed_demo_phone_hmac') = '');
select pg_temp.as_demo_patient(2);
select pg_temp.assert('Chinedu: Adaeze''s number (the swap) and nearby numbers are not allowed and cannot be written',
  pg_temp.change_phone(2, '+447700900102', repeat('b', 64), true) = 'not allowed'
  and pg_temp.change_phone(2, '+447700900101', repeat('b', 64), true) = 'not allowed'
  and pg_temp.change_phone(2, '+447700900104', repeat('b', 64), true) = 'not allowed'
  and pg_temp.change_phone(2, '+2347700900103', repeat('b', 64), true) = 'not allowed'
  and pg_temp.change_phone(2, '+447700900104', repeat('b', 64), false) = '22023 PATIENT_CONTACT_CHANGE_INVALID');
select pg_temp.as_demo_patient(2);
select pg_temp.assert('Chinedu''s session cannot ask the check for Adaeze (42501)',
  pg_temp.try($q$select identity.demo_profile_phone_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000002', '+447700900102', repeat('a', 64))$q$)
    = '42501 Patient self session is required');
reset role;
select pg_temp.assert('nothing written by the refused phone changes',
  pg_temp.profile_counts() = current_setting('hid.test.before'));
select pg_temp.clear_context();
-- The eight fictional patients have no number: the trigger refuses them
-- whatever is recorded (owner SQL, as no session exists for them).
savepoint fictional_patient;
select set_config('hid.sealed_demo_phone_hmac', '98d00009-0000-4000-8000-000000000003:' || repeat('d', 64), true);
select pg_temp.assert('a fictional patient without a login: G5 admits only a value recorded for that patient',
  pg_temp.try($q$insert into identity.patient_contact_changes (id, patient_id, account_id, channel, state,
    new_lookup_hmac, new_ciphertext, key_version, replaced_contact, completed_at)
    values (gen_random_uuid(), '98d00009-0000-4000-8000-000000000003', '98d00008-0000-4000-8000-000000000001',
      'phone', 'completed', repeat('e', 64), decode(repeat('ab', 40), 'hex'), 'sealed-profile-v1', false,
      clock_timestamp())$q$) = '22023 PATIENT_CONTACT_CHANGE_INVALID');
rollback to savepoint fictional_patient;
select pg_temp.clear_context();

-- Allowed: each patient's own number, with the check asked as Identity asks it.
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(1);
select pg_temp.assert('Adaeze: her number passes the check and is changed',
  pg_temp.change_phone(1, '+447700900102', repeat('1', 64), true) = 'changed');
select pg_temp.as_demo_patient(2);
select pg_temp.assert('Chinedu: his number passes the check and is changed',
  pg_temp.change_phone(2, '+447700900103', repeat('2', 64), true) = 'changed');
select pg_temp.as_demo_patient(1);
select pg_temp.assert('patient_self_contact returns the number Identity wrote, with its change row (shown)',
  (select convert_from(contact.phone_ciphertext, 'UTF8') = 'sealed-profile-test-phone:+447700900102'
          and contact.phone_lookup_hmac = repeat('1', 64) and contact.phone_change_id is not null
          and contact.phone_change_key_version = 'sealed-profile-v1'
     from identity.patient_self_contact('patient:98d00008-0000-4000-8000-000000000001',
       '98b1190b-0000-4000-8000-000000000001') contact));
select pg_temp.as_demo_patient(1);
select pg_temp.assert('the same number again is unchanged; another number is still refused',
  pg_temp.value_of($q$select outcome from identity.change_my_phone('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', gen_random_uuid(), repeat('1', 64), array[]::char(64)[],
    decode(repeat('ab', 40), 'hex'), 'sealed-profile-v1', false)$q$) = 'unchanged'
  and pg_temp.change_phone(1, '+447700900104', repeat('3', 64), true) = 'not allowed');
-- A real patient: no check needed (as today), and the check answers true
-- without recording anything.
select pg_temp.as_real_patient();
select pg_temp.assert('a real patient: the check is true and records nothing; the change works without it',
  identity.demo_profile_phone_allowed('synthetic:sealed-profile:patient', '98b1190b-0000-4000-8000-000000000009',
    '+447700900555', repeat('5', 64))
  and coalesce(current_setting('hid.sealed_demo_phone_hmac', true), '') = ''
  and pg_temp.value_of($q$select outcome from identity.change_my_phone('synthetic:sealed-profile:patient',
    '98b1190b-0000-4000-8000-000000000009', gen_random_uuid(), repeat('5', 64), array[]::char(64)[],
    decode(repeat('ab', 40), 'hex'), 'sealed-profile-v1', true)$q$) = 'changed');
-- The two demo numbers are the demo's alone: a real patient asking for one
-- gets false and nothing is recorded; Identity then changes nothing (its
-- phone and change rows, read as the owner, are as before).
reset role;
create function pg_temp.real_phone_state()
returns text language sql as $f$
  select concat_ws(',', patient.phone_lookup_hmac,
    (select count(*) from identity.patient_contact_changes change_row where change_row.patient_id = patient.id))
    from identity.patients patient where patient.id = '98b11909-0000-4000-8000-000000000001';
$f$;
select set_config('hid.test.real_before', pg_temp.real_phone_state(), true);
set local role hid_identity_api_runtime;
select pg_temp.as_real_patient();
select pg_temp.assert('a real patient may not take a demo number: false, and nothing recorded',
  not identity.demo_profile_phone_allowed('synthetic:sealed-profile:patient', '98b1190b-0000-4000-8000-000000000009',
    '+447700900102', repeat('7', 64))
  and coalesce(current_setting('hid.sealed_demo_phone_hmac', true), '') = ''
  and not identity.demo_profile_phone_allowed('synthetic:sealed-profile:patient',
    '98b1190b-0000-4000-8000-000000000009', '+447700900103', repeat('7', 64))
  and coalesce(current_setting('hid.sealed_demo_phone_hmac', true), '') = ''
  and identity.demo_profile_phone_allowed('synthetic:sealed-profile:patient', '98b1190b-0000-4000-8000-000000000009',
    '+447700900104', repeat('7', 64))
  and (select bool_and(identity.demo_profile_phone_allowed('synthetic:sealed-profile:patient',
         '98b1190b-0000-4000-8000-000000000009', other, repeat('7', 64)))
         from unnest(array['+447700900101', '+2347700900102', '+2347700900103']) other)
  and coalesce(current_setting('hid.sealed_demo_phone_hmac', true), '') = '');
reset role;
select pg_temp.assert('a real patient refused a demo number: no phone or change row written',
  pg_temp.real_phone_state() = current_setting('hid.test.real_before'));
select pg_temp.clear_context();
select pg_temp.assert('the phone rows: one completed change each, no SMS due (no enrollment), phone not verified',
  (select count(*) from identity.patient_contact_changes change_row
    where identity.sealed_demo_patient(change_row.patient_id)) = 2
  and (select count(*) from identity.patient_contact_changes change_row
        where identity.sealed_demo_patient(change_row.patient_id) and change_row.state = 'completed'
          and change_row.channel = 'phone') = 2
  and not exists (select 1 from identity.public_patient_enrollments enrollment
                   where identity.sealed_demo_patient(enrollment.patient_id))
  and (select count(*) from identity.patients patient
        where identity.sealed_demo_patient(patient.id) and patient.phone_lookup_hmac is not null) = 2);

-- 4. The NIN seed.
select set_config('hid.test.before', pg_temp.profile_counts(), true);
select set_config('hid.test.audit_before', (select coalesce(max(sequence_id), 0) from audit.events)::text, true);
select set_config('hid.test.summary', identity.demo_profile_install()::text, true);
do $$
declare summary jsonb := current_setting('hid.test.summary')::jsonb;
begin
  perform pg_temp.assert('the summary', summary = '{"registrationCases": 2, "ninIdentifiers": 2, "audited": 4}'::jsonb,
    summary::text);
  perform pg_temp.assert('the caller''s context is restored',
    coalesce(current_setting('app.actor_subject', true), '') = ''
    and coalesce(current_setting('app.correlation_id', true), '') = '');
  perform pg_temp.assert('one resolved registration case each at Demo Hospital, as the demo doctor, with no NIN',
    (select count(*) from identity.registration_cases registration
       join identity.patients patient on patient.id = registration.resolved_patient_id
      where registration.id in ('98d00119-0000-4000-8000-000000000001', '98d00119-0000-4000-8000-000000000002')
        and registration.resolved_patient_id = ('98d00009-0000-4000-8000-00000000000'
                                                 || right(registration.id::text, 1))::uuid
        and registration.facility_id = '98d00002-0000-4000-8000-000000000001'
        and registration.created_by_account_id = '98d00003-0000-4000-8000-000000000001'
        and registration.created_by_membership_id = '98d00005-0000-4000-8000-000000000001'
        and registration.status = 'resolved_existing_identity' and registration.reviewed_by_account_id is null
        and (registration.first_name, registration.last_name, registration.full_name, registration.dob,
             registration.gender) = (patient.first_name, patient.last_name, patient.full_name, patient.dob,
             patient.gender)
        and convert_from(registration.nin_ciphertext, 'UTF8')
            = 'hid-sealed-demo:0119:no-nin-stored:' || registration.resolved_patient_id
        and get_byte(registration.nin_ciphertext, 0) <> 1
        and registration.nin_lookup_hmac = encode(sha256(convert_to('hid-sealed-demo:0119:nin:'
                                                   || registration.resolved_patient_id, 'UTF8')), 'hex')
        and registration.nin_last4 = '0000' and registration.nin_key_version = 'hid-sealed-demo'
        and registration.verification_provider = 'hid-sealed-demo'
        and registration.verification_reference = '0119-sealed-demo-profile'
        and registration.idempotency_key = 'sealed-demo-0119-nin-' || registration.resolved_patient_id
        and registration.request_sha256 = encode(sha256(convert_to(registration.idempotency_key, 'UTF8')), 'hex'))
      = 2
    and (select string_agg(patient.full_name, '/' order by patient.id) from identity.registration_cases registration
          join identity.patients patient on patient.id = registration.resolved_patient_id
         where registration.verification_provider = 'hid-sealed-demo') = 'Adaeze Okafor/Chinedu Okafor');
  perform pg_temp.assert('one nin identifier each, naming its case, the same marker values, hint ****0000',
    (select count(*) from identity.patient_identifiers identifier
       join identity.registration_cases registration on registration.id = identifier.registration_case_id
      where identifier.identifier_type = 'nin' and identity.sealed_demo_patient(identifier.patient_id)
        and identifier.id = ('98d00119-0000-4000-8000-00000000001' || right(registration.id::text, 1))::uuid
        and identifier.patient_id = registration.resolved_patient_id
        and identifier.verified and identifier.verified_at is not null and identifier.revoked_at is null
        and identifier.value_ciphertext = registration.nin_ciphertext
        and identifier.lookup_hmac = registration.nin_lookup_hmac
        and identifier.encryption_key_version = 'hid-sealed-demo' and identifier.display_hint = '****0000'
        and identifier.source_system = 'hid-sealed-demo' and identifier.verification_provider = 'hid-sealed-demo'
        and identifier.verification_reference = '0119-sealed-demo-profile'
        and identifier.public_enrollment_id is null and identifier.patient_self_evidence_id is null) = 2
    and (select count(*) from identity.patient_identifiers identifier
          where identifier.identifier_type = 'nin' and identity.sealed_demo_patient(identifier.patient_id)) = 2);
  perform pg_temp.assert('no evidence, authoritative profile, NIN hash, QoreID quota row; assurance unchanged',
    split_part(pg_temp.profile_counts(), ',', 3) = split_part(current_setting('hid.test.before'), ',', 3)
    and split_part(pg_temp.profile_counts(), ',', 4) = split_part(current_setting('hid.test.before'), ',', 4)
    and split_part(pg_temp.profile_counts(), ',', 5) = split_part(current_setting('hid.test.before'), ',', 5)
    and split_part(pg_temp.profile_counts(), ',', 6) = split_part(current_setting('hid.test.before'), ',', 6)
    and split_part(pg_temp.profile_counts(), ',', 8) = split_part(current_setting('hid.test.before'), ',', 8)
    and split_part(pg_temp.profile_counts(), ',', 9) = split_part(current_setting('hid.test.before'), ',', 9)
    and (select count(*) from identity.patient_assurance_states assurance
          where identity.sealed_demo_patient(assurance.patient_id) and assurance.state = 'NIN_VERIFIED') = 0
    and not exists (select 1 from identity.patients patient
                     where identity.sealed_demo_patient(patient.id)
                       and (patient.nin_hash is not null or patient.nin_ciphertext is not null)));
  perform pg_temp.assert('the audit: four migration rows (ids only) and one summary, no patient or clinician actor',
    (select count(*) from audit.events event
      where event.sequence_id > current_setting('hid.test.audit_before')::bigint
        and event.correlation_id = '0119-sealed-demo-profile' and event.actor_type = 'system'
        and event.actor_subject is null and event.actor_account_id is null and event.actor_membership_id is null
        and event.provenance = 'migration' and event.source_system = 'hid-sealed-demo'
        and event.action = 'identity.sealed-demo.seed-record'
        and event.facility_id = '98d00002-0000-4000-8000-000000000001' and event.details = '{}'::jsonb
        and (event.resource_type, event.resource_id) in (
          ('registration-case', '98d00119-0000-4000-8000-000000000001'),
          ('registration-case', '98d00119-0000-4000-8000-000000000002'),
          ('patient-identifier', '98d00119-0000-4000-8000-000000000011'),
          ('patient-identifier', '98d00119-0000-4000-8000-000000000012'))) = 4
    and (select count(*) from audit.events event
          where event.sequence_id > current_setting('hid.test.audit_before')::bigint
            and event.correlation_id = '0119-sealed-demo-profile' and event.actor_type = 'system'
            and event.action = 'identity.sealed-demo.seed-profile' and event.patient_id is null
            and event.details = '{"rowsAudited": 4, "registrationCases": 2, "ninIdentifiers": 2}'::jsonb) = 1
    and (select count(*) from audit.events event
          where event.sequence_id > current_setting('hid.test.audit_before')::bigint) = 5
    and not exists (select 1 from audit.events event
                     where event.correlation_id = '0119-sealed-demo-profile'
                       and (event.details::text like '%0000%' or event.details::text ~ '[0-9a-f]{64}')));
end $$;
select pg_temp.assert('a second call writes nothing',
  identity.demo_profile_install() = '{"registrationCases": 0, "ninIdentifiers": 0, "audited": 0}'::jsonb
  and (select count(*) from identity.registration_cases where verification_provider = 'hid-sealed-demo') = 2
  and (select count(*) from audit.events where correlation_id = '0119-sealed-demo-profile') = 5);
savepoint id_taken;
delete from identity.patient_identifiers where id = '98d00119-0000-4000-8000-000000000011';
select pg_temp.assert('a fixed case id whose identifier is gone: refused (the seed never writes over a row)',
  pg_temp.try('select identity.demo_profile_install()') = '55000 0119: SEALED_DEMO_PROFILE_ID_TAKEN');
rollback to savepoint id_taken;
select pg_temp.assert('0098''s and 0102''s installs still pass after the seed (a second call of each writes nothing)',
  (identity.sealed_demo_install()->>'inserted')::int = 0
  and (identity.demo_story_install(current_setting('hid.test.pin_hash'))->>'changed')::int = 0);
select pg_temp.clear_context();

-- What the portal and the NIN checks read.
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(1);
select pg_temp.assert('patient_self_profile: ninVerified true, assurance CONTACT_VERIFIED (Adaeze)',
  (select profile->>'ninVerified' = 'true' and profile->>'assuranceState' = 'CONTACT_VERIFIED'
     from identity.patient_self_profile('patient:98d00008-0000-4000-8000-000000000001',
       '98b1190b-0000-4000-8000-000000000001') profile));
select pg_temp.as_demo_patient(1);
select pg_temp.assert('the NIN self-check is denied for any HMAC before quota or QoreID (Adaeze), its own value too',
  identity.patient_self_nin_eligibility('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', repeat('7', 64)) = 'denied'
  and identity.patient_self_nin_eligibility('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', md5('x') || md5('y')) = 'denied'
  and identity.patient_self_nin_eligibility('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', encode(sha256(convert_to('hid-sealed-demo:0119:nin:'
      || '98d00009-0000-4000-8000-000000000002', 'UTF8')), 'hex')) = 'denied');
select pg_temp.as_demo_patient(2);
select pg_temp.assert('patient_self_profile and the self-check for Chinedu',
  (select profile->>'ninVerified' = 'true' and profile->>'assuranceState' = 'CONTACT_VERIFIED'
     from identity.patient_self_profile('patient:98d00008-0000-4000-8000-000000000002',
       '98b1190b-0000-4000-8000-000000000002') profile)
  and identity.patient_self_nin_eligibility('patient:98d00008-0000-4000-8000-000000000002',
    '98b1190b-0000-4000-8000-000000000002', repeat('8', 64)) = 'denied');
select pg_temp.as_demo_patient(1);
select pg_temp.assert('G6 still refuses QoreID quota for a demo account',
  pg_temp.try($q$select platform.consume_qoreid_quota('patient_nin', null, '98b1190b-0000-4000-8000-000000000001',
    null, null)$q$) like '42501 %');
reset role;
select pg_temp.clear_context();
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'sealed-profile-signup', true);
select pg_temp.assert('sign-up''s NIN check finds no typed value (random HMACs)',
  not identity.public_patient_nin_already_bound(repeat('7', 64))
  and not identity.public_patient_nin_already_bound(md5('typed-nin-1') || md5('typed-nin-2')));
reset role;
select pg_temp.clear_context();

-- 5. The completion card: a photo and an email emergency contact, added as
-- Identity adds them (the contact with the check's recorded HMAC), then the
-- twelve items counted as profileCompletion.ts counts them.
set local role hid_identity_api_runtime;
select pg_temp.as_demo_patient(1);
select pg_temp.assert('Adaeze adds her photo and an email emergency contact to a demo mailbox',
  pg_temp.try($q$select identity.set_my_profile_photo('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', decode(repeat('ab', 30), 'hex'), 'image/jpeg', repeat('f', 64), 1, 1, 1,
    'sealed-profile-v1')$q$) = 'ok'
  and identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', 'email', 'operations@healthidentitydirectory.com', repeat('9', 64))
  and pg_temp.try($q$select identity.add_my_emergency_contact('patient:98d00008-0000-4000-8000-000000000001',
    '98b1190b-0000-4000-8000-000000000001', gen_random_uuid(), 'sibling', 'email', decode(repeat('ab', 40), 'hex'),
    'sealed-profile-v1', repeat('9', 64), true)$q$) = 'ok');
select pg_temp.as_demo_patient(2);
select pg_temp.assert('Chinedu adds his photo and an email emergency contact to a demo mailbox',
  pg_temp.try($q$select identity.set_my_profile_photo('patient:98d00008-0000-4000-8000-000000000002',
    '98b1190b-0000-4000-8000-000000000002', decode(repeat('ab', 30), 'hex'), 'image/jpeg', repeat('f', 64), 1, 1, 1,
    'sealed-profile-v1')$q$) = 'ok'
  and identity.sealed_demo_contact_allowed('patient:98d00008-0000-4000-8000-000000000002',
    '98b1190b-0000-4000-8000-000000000002', 'email', 'patient1@healthidentitydirectory.com', repeat('6', 64))
  and pg_temp.try($q$select identity.add_my_emergency_contact('patient:98d00008-0000-4000-8000-000000000002',
    '98b1190b-0000-4000-8000-000000000002', gen_random_uuid(), 'sibling', 'email', decode(repeat('ab', 40), 'hex'),
    'sealed-profile-v1', repeat('6', 64), true)$q$) = 'ok');
reset role;
select pg_temp.clear_context();
-- What Identity reads for the card (identity/me: the profile and the contact),
-- as the Identity runtime, for each patient.
create function pg_temp.read_card(n integer)
returns void language plpgsql as $f$
declare
  subject text := 'patient:98d00008-0000-4000-8000-00000000000' || n;
  session uuid := ('98b1190b-0000-4000-8000-00000000000' || n)::uuid;
begin
  perform pg_temp.as_demo_patient(n);
  perform set_config('hid.test.profile' || n, identity.patient_self_profile(subject, session)::text, true);
  perform pg_temp.as_demo_patient(n);
  perform set_config('hid.test.contact' || n,
    (select to_jsonb(contact) from identity.patient_self_contact(subject, session) contact)::text, true);
end
$f$;
grant execute on function pg_temp.read_card(integer) to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.read_card(1), pg_temp.read_card(2);
reset role;
select pg_temp.clear_context();
-- The twelve items as profileCompletion.ts counts them; the hospital, HMO,
-- blood group and genotype from the rows the portal's own reads return.
create function pg_temp.completion(n integer)
returns integer language plpgsql as $f$
declare
  patient uuid := ('98d00009-0000-4000-8000-00000000000' || n)::uuid;
  profile jsonb := current_setting('hid.test.profile' || n)::jsonb;
  contact jsonb := current_setting('hid.test.contact' || n)::jsonb;
  done integer;
begin
  select (contact->>'email' is not null and (contact->>'email_verified')::boolean)::int
         -- Identity shows a phone it wrote (the change row it decrypts with).
         + (contact->>'phone_ciphertext' is not null and contact->>'phone_change_id' is not null)::int
         + (nullif(btrim(profile->>'gender'), '') is not null)::int
         + (nullif(btrim(profile->>'dateOfBirth'), '') is not null)::int
         + (nullif(btrim(profile->>'state'), '') is not null)::int
         + coalesce((contact->>'has_photo')::boolean, false)::int
         + coalesce((select (nullif(btrim(details.hospital_currently_using), '') is not null)::int
                            + (nullif(btrim(details.hmo_name), '') is not null)::int
                       from identity.patient_profile_details details where details.patient_id = patient), 0)
         + coalesce((select (health.blood_group is not null)::int + (health.genotype is not null)::int
                       from ehr.patient_reported_health_profiles health where health.patient_id = patient), 0)
         -- ninVerifiedOf: ninVerified, otherwise assurance NIN_VERIFIED.
         + (profile->>'ninVerified' = 'true' or profile->>'assuranceState' = 'NIN_VERIFIED')::int
         + (exists (select 1 from identity.patient_emergency_contacts emergency
                     where emergency.patient_id = patient and emergency.status <> 'deactivated'))::int
    into done;
  return done;
end
$f$;
select pg_temp.assert('the completion card: 12 of 12 for Adaeze and for Chinedu',
  pg_temp.completion(1) = 12 and pg_temp.completion(2) = 12,
  pg_temp.completion(1)::text || ' and ' || pg_temp.completion(2)::text);
-- The owner's post-deploy query in the migration's header, verbatim: true in
-- every column for both patients now.
create temporary table post_deploy on commit drop as
  select patient.hid_code,
         patient.phone_lookup_hmac is not null and exists (select 1 from identity.patient_contact_changes change_row
           where change_row.patient_id = patient.id and change_row.channel = 'phone'
             and change_row.state = 'completed' and change_row.new_lookup_hmac = patient.phone_lookup_hmac) as phone,
         exists (select 1 from identity.patient_profile_photos photo where photo.patient_id = patient.id) as photo,
         exists (select 1 from identity.patient_emergency_contacts contact where contact.patient_id = patient.id
           and contact.status <> 'deactivated') as emergency_contact,
         exists (select 1 from identity.patient_identifiers identifier where identifier.patient_id = patient.id
           and identifier.identifier_type = 'nin' and identifier.verified and identifier.revoked_at is null
           and identifier.source_system = 'hid-sealed-demo') as nin,
         patient.gender is not null and patient.dob is not null
           and nullif(btrim(patient.state), '') is not null as gender_dob_state,
         exists (select 1 from identity.patient_profile_details detail where detail.patient_id = patient.id
           and nullif(btrim(detail.hospital_currently_using), '') is not null
           and nullif(btrim(detail.hmo_name), '') is not null) as hospital_hmo,
         exists (select 1 from ehr.patient_reported_health_profiles health where health.patient_id = patient.id
           and health.blood_group is not null and health.genotype is not null) as blood_genotype
    from identity.patients patient
   where patient.id in ('98d00009-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002')
   order by patient.hid_code;
select pg_temp.assert('the post-deploy query: both patients true in every column',
  (select count(*) from post_deploy where phone and photo and emergency_contact and nin and gender_dob_state
     and hospital_hmo and blood_genotype) = 2,
  (select string_agg(to_jsonb(post_deploy)::text, '; ') from post_deploy));

rollback;
