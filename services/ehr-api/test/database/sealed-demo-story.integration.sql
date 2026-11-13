\set ON_ERROR_STOP on
-- The sealed demo story (0102, owner request of 2026-11-02). Rollback-only.
-- On the databases CI and the release rehearsals use (plain PostgreSQL, no
-- rds_superuser) 0098 and 0102 install their functions and seed nothing, so
-- this suite calls identity.sealed_demo_install() and then
-- identity.demo_story_install() itself, as the owner, inside its
-- transaction, with a PIN hash of its own (the test PIN 9157, made here with
-- pgcrypto; it is not the owner's).
--   1. structure: the three functions (owner, SECURITY DEFINER for the seed
--      only, search_path, no grant), and nothing seeded by the migration
--      here (no demo PIN, no story audit row);
--   2. refusals, each writing nothing: a hash that is not bcrypt cost 12, a
--      target that is not the demo's, the demo logins before the owner's
--      password resets, cross-facility orders or route access switched off,
--      a revoked share; and, asked before any order command runs, what those
--      commands would refuse on live data: Demo Laboratory or Demo Pharmacy
--      unlisted by support, a patient's deny directive naming Demo
--      Laboratory, a revoked doctor role or an inactive lab membership, the
--      daily send limit and the daily wrong-patient tries;
--   3. the owner's hash: stored verbatim, cost 12, in the table's shape, and
--      an envelope pgcrypto accepts (undone; never verified against a PIN);
--   4. the seed: names, display names, the staff name; profile details and
--      health information; the completion items SQL holds; the PINs as
--      set_my_patient_access_pin stores them, no grant revoked; Adaeze's
--      visit before and today, Chinedu checked in; six orders sent and
--      accepted through the live commands, two results entered and not
--      released, two dispensings; Outreach; every row demo, every row read
--      back through the runtime roles' row-level security;
--   5. nothing sent: the order notices read, no outbox row but the work
--      items' integration events, no identity outbox, no delivery;
--   6. the audit: one migration row per row written, none naming a patient
--      or clinician, no hash in any;
--   7. a second call changes nothing;
--   8. the PIN at Demo Hospital (demo doctor membership, direct care): the
--      test PIN opens Adaeze's record, a wrong one does not;
--   9. emergency: the demo login break-glasses Abubakar Bello (Patient
--      Three) and Adaeze (who also has a share) for the emergency purpose:
--      read-only grants; the platform control and the hourly limit as they
--      stand;
--   10. 0098's install still passes after the story (a second call inserts
--      nothing).
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
  ('direct-care', 'Direct patient care', 'sealed-story-test'), ('emergency', 'Emergency', 'sealed-story-test')
  on conflict (code) do update set active = true;

create function pg_temp.assert(label text, condition boolean, detail text default null)
returns void language plpgsql as $f$
begin
  if condition is not true then
    raise exception 'sealed demo story: % failed%', label, coalesce(': ' || detail, '');
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
create function pg_temp.as_demo_staff(site integer, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', 'sealed-demo:98d00003-0000-4000-8000-000000000001', true),
    set_config('app.membership_id', '98d00005-0000-4000-8000-00000000000' || site, true),
    set_config('app.facility_id', '98d00002-0000-4000-8000-00000000000' || site, true),
    set_config('app.correlation_id', 'sealed-story-' || substr(md5(random()::text), 1, 12), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true),
    set_config('app.session_id', '', true),
    set_config('app.account_id', '', true);
$f$;
-- A count of every table the story writes, to compare before and after.
create function pg_temp.story_counts()
returns text language sql as $f$
  select concat_ws(',',
    (select count(*) from identity.patients), (select count(*) from auth.accounts),
    (select count(*) from identity.patient_profile_details), (select count(*) from ehr.patient_reported_health_profiles),
    (select count(*) from identity.patient_access_pins), (select count(*) from identity.consent_grants),
    (select count(*) from ehr.encounters), (select count(*) from ehr.clinical_notes),
    (select count(*) from ehr.clinical_note_revisions), (select count(*) from ehr.vitals),
    (select count(*) from ehr.diagnoses), (select count(*) from ehr.prescriptions), (select count(*) from ehr.lab_requests),
    (select count(*) from ehr.record_versions), (select count(*) from ehr.order_routes),
    (select count(*) from ehr.order_route_events), (select count(*) from lab.work_items),
    (select count(*) from lab.accessions), (select count(*) from lab.specimens), (select count(*) from lab.test_executions),
    (select count(*) from lab.results), (select count(*) from lab.result_revisions),
    (select count(*) from lab.result_verifications), (select count(*) from lab.result_releases),
    (select count(*) from pharmacy.work_items), (select count(*) from pharmacy.dispensings),
    (select count(*) from outreach.campaigns), (select count(*) from outreach.registration_cases),
    (select count(*) from notification.inbox_items), (select count(*) from notification.inbox_items where read_at is null),
    (select count(*) from lab.outbox_events), (select count(*) from pharmacy.outbox_events),
    (select count(*) from identity.outbox_events), (select count(*) from notification.delivery_attempts),
    (select count(*) from audit.events),
    (select string_agg(patient.full_name, '/' order by patient.hid_code) from identity.patients patient
      where identity.sealed_demo_patient(patient.id)),
    (select string_agg(account.display_name, '/' order by account.id) from auth.accounts account
      where identity.sealed_demo_account(account.id)));
$f$;

-- 1. Structure, and nothing seeded by the migration on this database.
do $$
begin
  perform pg_temp.assert('the three functions are the owner''s alone, the seed SECURITY DEFINER',
    (select count(*) from pg_proc proc
      where proc.oid in ('identity.demo_story_context(text,uuid,uuid,text)'::regprocedure,
                         'identity.demo_story_lab_result(uuid,uuid,uuid,text,text,text,text,text,text)'::regprocedure,
                         'identity.demo_story_install(text)'::regprocedure)
        and proc.prosecdef = (proc.proname = 'demo_story_install')
        and proc.proconfig = array['search_path=pg_catalog, pg_temp']
        and not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                         where acl.grantee <> proc.proowner)) = 3);
  perform pg_temp.assert('no runtime role may run them',
    not exists (select 1 from pg_roles role_row
                 where role_row.rolname like 'hid\_%'
                   -- the functions' owner (the migration login, whatever its name) is not a runtime role
                   and role_row.oid <> (select proowner from pg_proc
                                         where oid = 'identity.demo_story_install(text)'::regprocedure)
                   and (has_function_privilege(role_row.oid, 'identity.demo_story_install(text)', 'execute')
                     or has_function_privilege(role_row.oid,
                          'identity.demo_story_context(text,uuid,uuid,text)', 'execute'))
                   and not role_row.rolsuper));
  perform pg_temp.assert('the migration seeded nothing here (not Amazon RDS)',
    not exists (select 1 from audit.events where correlation_id = '0102-sealed-demo-story')
    and not exists (select 1 from identity.patient_access_pins pin where pin.source_system = 'hid-sealed-demo'));
end $$;

select identity.sealed_demo_install();
-- The 0098 shares, an hour old (the suite is one transaction, whose
-- CURRENT_TIMESTAMP, which the read gate compares grants with, precedes them).
update identity.consent_grants set starts_at = starts_at - interval '1 hour'
 where correlation_id = '0098-sealed-demo-install';
select set_config('hid.test.pin_hash', public.crypt('9157', public.gen_salt('bf', 12)), true);

-- 2. Refusals, each in a savepoint, each writing nothing.
select set_config('hid.test.before', pg_temp.story_counts(), true);
do $$
begin
  perform pg_temp.assert('a hash that is not bcrypt cost 12 is refused',
    pg_temp.try(format('select identity.demo_story_install(%L)', public.crypt('9157', public.gen_salt('bf', 10))))
      = '22023 0102: SEALED_DEMO_STORY_PIN_HASH_INVALID'
    and pg_temp.try($q$select identity.demo_story_install('9157')$q$)
      = '22023 0102: SEALED_DEMO_STORY_PIN_HASH_INVALID');
  perform pg_temp.assert('before the owner''s password resets the logins are not ready',
    pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
      = '55000 0102: SEALED_DEMO_STORY_LOGINS_NOT_READY');
  perform pg_temp.assert('nothing written by a refusal', pg_temp.story_counts() = current_setting('hid.test.before'));
end $$;
savepoint not_demo;
update identity.patients set account_id = null where id = '98d00009-0000-4000-8000-000000000001';
select pg_temp.assert('a target that is not the demo''s as 0098 left it is refused',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_NOT_DEMO');
rollback to savepoint not_demo;

-- Recovery as the owner does it (0098's suite, 6a): forgot-password to each
-- mailbox, the code verified, auth.complete_recovery_otp with the
-- repository's non-hash placeholder; each account becomes active.
insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac, verifier_key_version,
  expires_at, max_attempts, verified_at, completion_token_hmac, completion_expires_at, account_token_version)
select ('98a1020f-0000-4000-8000-00000000000' || n)::uuid, account.id, md5('story-recipient-' || n) || md5('r' || n),
  'PASSWORD_RESET', 'email', md5('story-verifier-' || n) || md5('v' || n), 'story-test-v1',
  clock_timestamp() + interval '10 minutes', 5, clock_timestamp(), md5('story-completion-' || n) || md5('c' || n),
  clock_timestamp() + interval '10 minutes', account.token_version
  from (values (1, '98d00003-0000-4000-8000-000000000001'::uuid), (2, '98d00008-0000-4000-8000-000000000001'::uuid),
               (3, '98d00008-0000-4000-8000-000000000002'::uuid)) target(n, account_id)
  join auth.accounts account on account.id = target.account_id;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'sealed-story-recovery', true);
select pg_temp.assert('recovery completes for the three demo logins',
  (select bool_and(auth.complete_recovery_otp(('98a1020f-0000-4000-8000-00000000000' || n)::uuid, 'PASSWORD_RESET',
     md5('story-completion-' || n) || md5('c' || n),
     '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43)))
     from generate_series(1, 3) n));
reset role;
select set_config('app.actor_subject', '', true), set_config('app.correlation_id', '', true);
select set_config('hid.test.before', pg_temp.story_counts(), true);
savepoint orders_off;
update platform.control_settings set enabled = false where control_key = 'cross_facility_orders_enabled';
select pg_temp.assert('cross-facility orders switched off: refused',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_ORDERS_OFF');
rollback to savepoint orders_off;
savepoint share_revoked;
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(),
  revoked_by = '98d00008-0000-4000-8000-000000000002', revoked_reason = 'Revoked by the patient'
 where correlation_id = '0098-sealed-demo-install' and patient_id = '98d00009-0000-4000-8000-000000000002'
   and membership_id = '98d00005-0000-4000-8000-000000000001';
select pg_temp.assert('a revoked share at Demo Hospital: refused',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_SHARE_MISSING');
rollback to savepoint share_revoked;
savepoint route_access_off;
update platform.control_settings set enabled = false where control_key = 'cross_facility_route_access_enabled';
select pg_temp.assert('route access between facilities switched off: refused',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_ORDERS_OFF');
rollback to savepoint route_access_off;
savepoint lab_unlisted;
insert into identity.order_route_destination_settings (facility_id, organization_id, listed, reason,
  set_by_account_id, set_at, correlation_id)
select facility.id, facility.organization_id, false, 'Paused for a test', '98d00003-0000-4000-8000-000000000001',
  clock_timestamp(), 'sealed-story-test'
  from identity.facilities facility where facility.id = '98d00002-0000-4000-8000-000000000002';
select pg_temp.assert('Demo Laboratory unlisted by support: refused before any order is sent',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_DESTINATION_OFF');
rollback to savepoint lab_unlisted;
savepoint pharmacy_unlisted;
insert into identity.order_route_destination_settings (facility_id, organization_id, listed, reason,
  set_by_account_id, set_at, correlation_id)
select facility.id, facility.organization_id, false, 'Paused for a test', '98d00003-0000-4000-8000-000000000001',
  clock_timestamp(), 'sealed-story-test'
  from identity.facilities facility where facility.id = '98d00002-0000-4000-8000-000000000003';
select pg_temp.assert('Demo Pharmacy unlisted by support: refused before any order is sent',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_DESTINATION_OFF');
rollback to savepoint pharmacy_unlisted;
savepoint patient_denies;
insert into identity.consent_directives (id, patient_id)
values ('98a10200-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002');
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, starts_at, source_reference, reason, content_sha256)
values ('98a10200-0000-4000-8000-000000000002', '98a10200-0000-4000-8000-000000000001',
  '98d00009-0000-4000-8000-000000000002', 1, 'active', 'deny', 'facility', '98d00002-0000-4000-8000-000000000002',
  clock_timestamp() - interval '1 minute', 'sealed-story-test', 'Not this laboratory', repeat('a', 64));
select pg_temp.assert('Chinedu''s deny directive naming Demo Laboratory: refused before any order is sent',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_PATIENT_RESTRICTED');
rollback to savepoint patient_denies;
savepoint doctor_revoked;
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = '98d00003-0000-4000-8000-000000000001',
  revocation_reason = 'Revoked for a test' where id = '98d00006-0000-4000-8000-000000000011';
select pg_temp.assert('the demo doctor role revoked: refused',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_ROLE_MISSING');
rollback to savepoint doctor_revoked;
savepoint lab_inactive;
update identity.staff_facility_memberships set active = false where id = '98d00005-0000-4000-8000-000000000002';
select pg_temp.assert('the demo lab membership inactive: refused',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_ROLE_MISSING');
rollback to savepoint lab_inactive;
savepoint send_limit;
create or replace function ehr.order_route_limits()
returns table (sends_per_member_per_day integer, sends_per_pair_per_day integer, open_per_destination integer,
  routes_per_order integer, searches_per_member_per_hour integer, respond_days integer, work_days integer,
  after_completion_days integer, access_cap_days integer, read_after_cancel_days integer,
  mismatches_per_route integer, mismatches_per_member_per_day integer, mismatches_per_route_any integer)
language sql immutable parallel safe set search_path = pg_catalog, pg_temp
as $f$ select 5, 200, 500, 5, 60, 7, 30, 14, 45, 7, 5, 20, 20 $f$;
select pg_temp.assert('six sends would pass the daily send limit: refused before any order is sent',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_ORDER_LIMIT');
rollback to savepoint send_limit;
savepoint tries_used;
create or replace function ehr.order_route_limits()
returns table (sends_per_member_per_day integer, sends_per_pair_per_day integer, open_per_destination integer,
  routes_per_order integer, searches_per_member_per_hour integer, respond_days integer, work_days integer,
  after_completion_days integer, access_cap_days integer, read_after_cancel_days integer,
  mismatches_per_route integer, mismatches_per_member_per_day integer, mismatches_per_route_any integer)
language sql immutable parallel safe set search_path = pg_catalog, pg_temp
as $f$ select 100, 200, 500, 5, 60, 7, 30, 14, 45, 7, 5, 0, 20 $f$;
select pg_temp.assert('the receivers'' daily wrong-patient tries used: refused',
  pg_temp.try(format('select identity.demo_story_install(%L)', current_setting('hid.test.pin_hash')))
    = '55000 0102: SEALED_DEMO_STORY_ORDER_LIMIT');
rollback to savepoint tries_used;
select pg_temp.assert('nothing written by the refusals', pg_temp.story_counts() = current_setting('hid.test.before'));

-- 3. The owner's hash (the constant 0102 seeds on production): stored
-- verbatim, cost 12, in the table's shape, as the verifier reads it ($2a$,
-- unchanged by its $2b$/$2y$ normalization), and an envelope pgcrypto
-- accepts: crypt of a value that can never be a PIN (PINs are 4-8 digits)
-- answers a 60-character hash on the same salt. Never verified against any
-- PIN. Undone.
savepoint owner_hash;
select identity.demo_story_install('$2a$12$6wGzpNmtDSCbABUkV4L3RuycrhLro8DjP6iLEPZmOL/CLLJ0zfwcO');
select pg_temp.assert('the owner''s hash is stored verbatim for both patients, cost 12, in the verifier''s shape',
  (select count(*) from identity.patient_access_pins pin
    where pin.patient_id in ('98d00009-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002')
      and pin.pin_hash = '$2a$12$6wGzpNmtDSCbABUkV4L3RuycrhLro8DjP6iLEPZmOL/CLLJ0zfwcO'
      and substring(pin.pin_hash from 5 for 2)::integer = 12
      and pin.pin_hash ~ '^\$2[aby]\$(0[4-9]|1[0-2])\$[./A-Za-z0-9]{53}$'
      and pin.pin_hash !~ E'^\\$2[by]\\$'
      and pin.status = 'active' and pin.hash_algorithm = 'bcrypt') = 2
  and length(public.crypt('not-a-pin', '$2a$12$6wGzpNmtDSCbABUkV4L3RuycrhLro8DjP6iLEPZmOL/CLLJ0zfwcO')) = 60
  and left(public.crypt('not-a-pin', '$2a$12$6wGzpNmtDSCbABUkV4L3RuycrhLro8DjP6iLEPZmOL/CLLJ0zfwcO'), 29)
      = left('$2a$12$6wGzpNmtDSCbABUkV4L3RuycrhLro8DjP6iLEPZmOL/CLLJ0zfwcO', 29)
  and not exists (select 1 from audit.events event where event.correlation_id = '0102-sealed-demo-story'
                   and event.details::text like '%$2a$%'));
rollback to savepoint owner_hash;

-- 4. The seed, with the suite's own hash.
select set_config('hid.test.grants_before', (select count(*) from identity.consent_grants
  where status = 'active')::text, true);
select set_config('hid.test.audit_before', (select coalesce(max(sequence_id), 0) from audit.events)::text, true);
select set_config('hid.test.started', clock_timestamp()::text, true);
select set_config('hid.test.summary', identity.demo_story_install(current_setting('hid.test.pin_hash'))::text, true);
do $$
declare summary jsonb := current_setting('hid.test.summary')::jsonb;
begin
  perform pg_temp.assert('the summary', summary->>'renamed' = '10' and summary->>'pins' = '2'
    and summary->>'profiles' = '4' and summary->>'charts' = 'true' and summary->>'orders' = '6'
    and summary->>'registrationCases' = '4' and summary->>'audited' = '56' and summary->>'changed' = '20',
    summary::text);
  perform pg_temp.assert('the caller''s context is restored',
    coalesce(current_setting('app.actor_subject', true), '') = ''
    and coalesce(current_setting('app.correlation_id', true), '') = '');
  -- Names (D2).
  perform pg_temp.assert('the ten names, Health IDs, sex and dates of birth',
    (select string_agg(patient.hid_code || ' ' || patient.full_name || ' ' || patient.gender || ' ' || patient.dob,
       '; ' order by patient.hid_code)
       from identity.patients patient where identity.sealed_demo_patient(patient.id))
    = 'HID-ZDEMAAA2 Adaeze Okafor female 1991-03-04; HID-ZDEMAAA3 Chinedu Okafor male 1990-07-02; '
      || 'HID-ZDEMBBB2 Abubakar Bello male 1950-01-10; HID-ZDEMBBB3 Halima Yusuf female 1962-05-21; '
      || 'HID-ZDEMBBB4 Emeka Nwosu male 1971-09-30; HID-ZDEMBBB5 Ngozi Eze female 1978-12-02; '
      || 'HID-ZDEMBBB6 Musa Ibrahim male 1999-04-18; HID-ZDEMBBB7 Funke Adebayo female 2004-08-25; '
      || 'HID-ZDEMBBB8 Ifeanyi Okeke male 2012-02-11; HID-ZDEMBBB9 Zainab Lawal female 2020-06-06');
  perform pg_temp.assert('first and last names, state and country of the two logins',
    (select count(*) from identity.patients patient
      where (patient.id, patient.first_name, patient.last_name, patient.state, patient.country) in
        (('98d00009-0000-4000-8000-000000000001'::uuid, 'Adaeze', 'Okafor', 'Lagos', 'Nigeria'),
         ('98d00009-0000-4000-8000-000000000002'::uuid, 'Chinedu', 'Okafor', 'Lagos', 'Nigeria'))) = 2);
  perform pg_temp.assert('display names and the staff record''s name',
    (select string_agg(account.display_name, '/' order by account.id) from auth.accounts account
      where identity.sealed_demo_account(account.id)) = 'Dr Tunde Bello/Adaeze Okafor/Chinedu Okafor'
    and (select full_name from identity.staff where id = '98d00004-0000-4000-8000-000000000001') = 'Dr Tunde Bello');
  -- Profile (D4).
  perform pg_temp.assert('profile details and health information',
    (select hospital_currently_using || '|' || hmo_name from identity.patient_profile_details
      where patient_id = '98d00009-0000-4000-8000-000000000001') = 'Sample Teaching Hospital|Sample HMO'
    and (select concat_ws('|', blood_group, genotype, allergies, current_medications, chronic_conditions,
           coalesce(medical_notes, '-'), updated_by_account_id)
           from ehr.patient_reported_health_profiles where patient_id = '98d00009-0000-4000-8000-000000000001')
        = 'O+|AA|Penicillin — rash|Ferrous sulphate 200 mg tablets, one a day|Iron deficiency anaemia|-|'
          || '98d00008-0000-4000-8000-000000000001'
    and (select blood_group || genotype from ehr.patient_reported_health_profiles
          where patient_id = '98d00009-0000-4000-8000-000000000002') = 'A+AS');
  -- The completion card's items SQL can hold, for Adaeze: a verified email,
  -- gender, date of birth, state, hospital, HMO, blood group, genotype (8 of
  -- 12); no phone, photo, NIN or emergency contact.
  perform pg_temp.assert('Adaeze: 8 of the 12 completion items, none of the four SQL cannot hold',
    (select (account.email is not null and account.email_verified_at is not null)::int
            + (patient.gender is not null)::int + (patient.dob is not null)::int + (patient.state is not null)::int
            + (details.hospital_currently_using is not null)::int + (details.hmo_name is not null)::int
            + (health.blood_group is not null)::int + (health.genotype is not null)::int
       from identity.patients patient
       join auth.accounts account on account.id = patient.account_id
       join identity.patient_profile_details details on details.patient_id = patient.id
       join ehr.patient_reported_health_profiles health on health.patient_id = patient.id
      where patient.id = '98d00009-0000-4000-8000-000000000001') = 8
    and (select patient.phone_e164_ciphertext is null and patient.nin_hash is null
                and patient.emergency_contact_ciphertext is null
           from identity.patients patient where patient.id = '98d00009-0000-4000-8000-000000000001')
    and not exists (select 1 from identity.patient_profile_photos where identity.sealed_demo_patient(patient_id))
    and not exists (select 1 from identity.patient_emergency_contacts where identity.sealed_demo_patient(patient_id)));
  -- PINs (D5).
  perform pg_temp.assert('the PINs as set_my_patient_access_pin stores them, no grant revoked',
    (select count(*) from identity.patient_access_pins pin
      where pin.patient_id in ('98d00009-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002')
        and pin.pin_hash = current_setting('hid.test.pin_hash') and pin.status = 'active'
        and pin.hash_algorithm = 'bcrypt' and pin.disabled_at is null and pin.disabled_reason is null
        and pin.source_system = 'hid-sealed-demo' and pin.row_version = 1) = 2
    and (select count(*) from identity.consent_grants where status = 'active')::text
        = current_setting('hid.test.grants_before'));
end $$;

-- The charts (D6-D9).
do $$
begin
  perform pg_temp.assert('Adaeze: the visit six weeks ago, completed, and today''s in progress',
    (select string_agg(encounter.status || ':' || encounter.chief_complaint || ':'
       || round(extract(epoch from (current_setting('hid.test.started')::timestamptz - encounter.started_at)) / 86400),
       ' / ' order by encounter.started_at)
       from ehr.encounters encounter where encounter.patient_id = '98d00009-0000-4000-8000-000000000001')
    = 'completed:Tiredness and dizziness for 2 weeks:42 / in_progress:Fever, headache and body aches for 3 days:0');
  perform pg_temp.assert('Adaeze''s vitals, before and today',
    (select string_agg(concat_ws(' ', vitals.systolic_mmhg || '/' || vitals.diastolic_mmhg, vitals.pulse_bpm,
       vitals.temperature_c, vitals.oxygen_saturation_percent, vitals.weight_kg, vitals.height_cm,
       vitals.respiratory_rate), ' | ' order by vitals.recorded_at)
       from ehr.vitals vitals where vitals.patient_id = '98d00009-0000-4000-8000-000000000001')
    = '112/70 88 36.8 99.00 70.100 168.00 16 | 128/82 78 37.9 98.00 72.400 168.00',
    (select string_agg(concat_ws(' ', vitals.systolic_mmhg || '/' || vitals.diastolic_mmhg, vitals.pulse_bpm,
       vitals.temperature_c, vitals.oxygen_saturation_percent, vitals.weight_kg, vitals.height_cm,
       vitals.respiratory_rate), ' | ' order by vitals.recorded_at)
       from ehr.vitals vitals where vitals.patient_id = '98d00009-0000-4000-8000-000000000001'));
  perform pg_temp.assert('three signed notes with their first revision',
    (select string_agg(note.note_type || ':' || note.title || ':' || note.status || ':' || revision.revision_no,
       ' / ' order by note.created_at)
       from ehr.clinical_notes note
       join ehr.clinical_note_revisions revision on revision.clinical_note_id = note.id
      where note.patient_id = '98d00009-0000-4000-8000-000000000001')
    = 'consultation:Tiredness and dizziness:signed:1 / patient_summary:Patient summary:signed:1 / '
      || 'consultation:Fever for 3 days:signed:1'
    and exists (select 1 from ehr.clinical_note_revisions revision
                 where revision.content like '%Warm to touch, mild pallor, no neck stiffness.')
    and not exists (select 1 from ehr.clinical_note_revisions revision
                     where identity.sealed_demo_patient(revision.patient_id) and revision.content ~ '[0-9]{3} [0-9]{3} [0-9]{4}'));
  perform pg_temp.assert('the diagnoses',
    (select string_agg(diagnosis.code || ' ' || diagnosis.display || ' ' || diagnosis.clinical_status || ' '
       || diagnosis.verification_status, ' / ' order by diagnosis.created_at)
       from ehr.diagnoses diagnosis where diagnosis.patient_id = '98d00009-0000-4000-8000-000000000001')
    = 'D50.9 Iron deficiency anaemia active confirmed / Z88.0 Allergy to penicillin (rash) active confirmed / '
      || 'B54 Malaria (uncomplicated) active confirmed');
  perform pg_temp.assert('the prescriptions',
    (select string_agg(rx.medication_display || ' ' || coalesce(trim_scale(rx.dose_quantity)::text, '-') || ' ' || rx.frequency,
       ' / ' order by rx.patient_id, rx.created_at)
       from ehr.prescriptions rx where identity.sealed_demo_patient(rx.patient_id))
    = 'Ferrous sulphate 200 mg tablets 1 Once a day for 3 months / '
      || 'Artemether-lumefantrine 80/480 mg tablets 1 Twice daily for 3 days / '
      || 'Paracetamol 500 mg tablets 2 Three times daily for 3 days / '
      || 'Paracetamol 500 mg tablets 2 Three times daily for 3 days');
  perform pg_temp.assert('Chinedu: checked in and waiting, triage done',
    (select count(*) from ehr.encounters where patient_id = '98d00009-0000-4000-8000-000000000002'
       and status = 'in_progress') = 1
    and (select count(*) from ehr.vitals where patient_id = '98d00009-0000-4000-8000-000000000002') = 1);
  perform pg_temp.assert('the orders: lab requests accepted at Demo Laboratory; two prescriptions dispensed, one waiting',
    (select string_agg(route.kind || ':' || route.state || ':' || facility.name, ' / '
       order by route.patient_id, route.kind, route.state)
       from ehr.order_routes route join identity.facilities facility on facility.id = route.receiving_facility_id
      where identity.sealed_demo_patient(route.patient_id))
    = 'lab_request:accepted:Demo Laboratory / lab_request:accepted:Demo Laboratory / '
      || 'prescription:completed:Demo Pharmacy / prescription:completed:Demo Pharmacy / '
      || 'lab_request:accepted:Demo Laboratory / prescription:accepted:Demo Pharmacy');
  perform pg_temp.assert('two results entered, not checked or released (a second person must check)',
    (select string_agg(revision.text_value || ' [' || coalesce(revision.reference_range, '-') || '] '
       || revision.abnormal_flag, ' / ' order by revision.text_value desc)
       from lab.result_revisions revision where identity.sealed_demo_patient(revision.patient_id))
    = 'Positive (P. falciparum) [Negative] abnormal / Hb 12.8 g/dL, WBC 7.2 ×10^9/L, platelets 210 ×10^9/L [-] normal'
    and not exists (select 1 from lab.result_verifications where identity.sealed_demo_patient(patient_id))
    and not exists (select 1 from lab.result_releases where identity.sealed_demo_patient(patient_id))
    and (select count(*) from lab.specimens where identity.sealed_demo_patient(patient_id) and status = 'received') = 2
    and (select count(*) from lab.work_items work where identity.sealed_demo_patient(work.patient_id)
          and not exists (select 1 from lab.accessions accession where accession.work_item_id = work.id)) = 1);
  perform pg_temp.assert('the dispensings: 6 and 18 tablets, the video''s reason',
    (select string_agg(dispensing.medication_display || ' ' || dispensing.quantity_dispensed::integer || ' '
       || dispensing.quantity_unit, ' / ' order by dispensing.quantity_dispensed)
       from pharmacy.dispensings dispensing where identity.sealed_demo_patient(dispensing.patient_id))
    = 'Artemether-lumefantrine 80/480 mg tablets 6 tablets / Paracetamol 500 mg tablets 18 tablets'
    and (select bool_and(reason = 'Dispensed as prescribed. Counselled to take with food and finish the course.')
           from pharmacy.dispensings where identity.sealed_demo_patient(patient_id)));
  perform pg_temp.assert('Outreach: one active campaign, one planned, four registrations awaiting resolution',
    (select string_agg(campaign.name || ':' || campaign.status, ' / ' order by campaign.name)
       from outreach.campaigns campaign where campaign.facility_id = '98d00002-0000-4000-8000-000000000004')
    = 'Ajegunle health week:active / Makoko school screening:planned'
    and (select string_agg(registered.full_name || ':' || registered.age_years || ':' || registered.sex || ':'
           || (registered.campaign_id is not null) || ':' || registered.status || ':' || coalesce(registered.phone, '-'),
           ' / ' order by registered.created_at desc)
           from outreach.registration_cases registered
          where registered.facility_id = '98d00002-0000-4000-8000-000000000004')
    = 'Kemi Balogun:34:female:false:identity_resolution_pending:- / '
      || 'Ibrahim Musa:61:male:false:identity_resolution_pending:- / '
      || 'Chiamaka Obi:8:female:false:identity_resolution_pending:- / '
      || 'Segun Adewale:45:unknown:false:identity_resolution_pending:-');
  perform pg_temp.assert('every row written since the seed began is the demo''s',
    not exists (select 1 from ehr.record_versions where recorded_at >= current_setting('hid.test.started')::timestamptz
                 and not identity.sealed_demo_patient(patient_id))
    and not exists (select 1 from ehr.order_routes where created_at >= current_setting('hid.test.started')::timestamptz
                     and not (identity.sealed_demo_facility(ordering_facility_id)
                              and identity.sealed_demo_facility(receiving_facility_id)))
    and not exists (select 1 from lab.work_items where not identity.sealed_demo_facility(facility_id)
                     and accepted_at >= current_setting('hid.test.started')::timestamptz)
    and not exists (select 1 from notification.inbox_items where created_at >= current_setting('hid.test.started')::timestamptz
                     and not identity.sealed_demo_account(account_id)));
end $$;

-- Read back through the runtime roles' row-level security, as each site's
-- service reads it (the seed's rows pass the same policies).
set local role hid_ehr_api_runtime;
select pg_temp.as_demo_staff(1);
select pg_temp.assert('the EHR at Demo Hospital reads both charts',
  (select concat_ws(',', (select count(*) from ehr.encounters), (select count(*) from ehr.vitals),
     (select count(*) from ehr.clinical_notes), (select count(*) from ehr.clinical_note_revisions),
     (select count(*) from ehr.diagnoses), (select count(*) from ehr.prescriptions),
     (select count(*) from ehr.lab_requests))) = '3,3,3,3,3,4,3');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_demo_staff(2);
select pg_temp.assert('Demo Laboratory reads its three work items and the two results',
  (select count(*) from lab.work_items) = 3 and (select count(*) from lab.results) = 2
  and (select count(*) from lab.specimens) = 2);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_demo_staff(3);
select pg_temp.assert('Demo Pharmacy reads its three work items and the two dispensings',
  (select count(*) from pharmacy.work_items) = 3 and (select count(*) from pharmacy.dispensings) = 2);
reset role;
set local role hid_outreach_api_runtime;
select pg_temp.as_demo_staff(4);
select pg_temp.assert('Demo Outreach reads its campaigns and registrations',
  (select count(*) from outreach.campaigns) = 2 and (select count(*) from outreach.registration_cases) = 4);
reset role;
select set_config('app.actor_subject', '', true), set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true), set_config('app.correlation_id', '', true),
  set_config('app.purpose_of_use', '', true);

-- 5. Nothing sent (D12).
do $$
begin
  perform pg_temp.assert('the order notices are in the inboxes, read',
    (select count(*) from notification.inbox_items item
      where item.account_id in ('98d00008-0000-4000-8000-000000000001', '98d00008-0000-4000-8000-000000000002')
        and item.resource_type = 'order-route') = 12
    and not exists (select 1 from notification.inbox_items item
                     where item.created_at >= current_setting('hid.test.started')::timestamptz and item.read_at is null));
  perform pg_temp.assert('no outbox row but the work items'' integration events; no identity outbox, no delivery',
    (select string_agg(event_type || ':' || n, ',' order by event_type) from (
       select event_type, count(*) n from lab.outbox_events where occurred_at >= current_setting('hid.test.started')::timestamptz
        group by event_type
       union all
       select event_type, count(*) from pharmacy.outbox_events where occurred_at >= current_setting('hid.test.started')::timestamptz
        group by event_type) events) = 'LabWorkItemCreated:3,PharmacyWorkItemCreated:3'
    and not exists (select 1 from identity.outbox_events where created_at >= current_setting('hid.test.started')::timestamptz)
    and not exists (select 1 from notification.delivery_attempts)
    and not exists (select 1 from outreach.outbox_events where created_at >= current_setting('hid.test.started')::timestamptz));
end $$;

-- 6. The audit (D13).
do $$
begin
  perform pg_temp.assert('one migration row per row written, the story''s row with counts',
    (select string_agg(action || ':' || n, ',' order by action) from (
       select action, count(*) n from audit.events
        where correlation_id = '0102-sealed-demo-story' and provenance = 'migration'
          and source_system = 'hid-sealed-demo' and actor_type = 'system'
          and actor_subject is null and actor_account_id is null and actor_membership_id is null
        group by action) seeded)
    = 'identity.sealed-demo.seed-access-pin:2,identity.sealed-demo.seed-name:14,identity.sealed-demo.seed-order:6,'
      || 'identity.sealed-demo.seed-profile:4,identity.sealed-demo.seed-record:30,identity.sealed-demo.seed-story:1');
  perform pg_temp.assert('no audit row since the seed began names a patient or a clinician as its actor',
    not exists (select 1 from audit.events where sequence_id > current_setting('hid.test.audit_before')::bigint
                 and (actor_type <> 'system' or actor_subject is not null or actor_account_id is not null)));
  perform pg_temp.assert('the only other rows are the order commands'' own system rows',
    (select string_agg(action || ':' || n, ',' order by action) from (
       select action, count(*) n from audit.events
        where sequence_id > current_setting('hid.test.audit_before')::bigint and provenance <> 'migration'
        group by action) others)
    = 'ehr.order-route.accepted:6,ehr.order-route.dispensing-returned:2,ehr.order-route.received:6');
  perform pg_temp.assert('no hash, name or Health ID in any audit row of the story',
    not exists (select 1 from audit.events where sequence_id > current_setting('hid.test.audit_before')::bigint
                 and (details::text like '%$2a$%' or details::text like '%Okafor%' or details::text like '%HID-%')));
end $$;

-- 7. A second call changes nothing.
select set_config('hid.test.after', pg_temp.story_counts(), true);
select pg_temp.assert('a second call changes nothing and answers zero counts',
  identity.demo_story_install(current_setting('hid.test.pin_hash'))
    = '{"pins": 0, "charts": false, "orders": 0, "audited": 0, "changed": 0, "renamed": 0, "profiles": 0,
        "registrationCases": 0}'::jsonb
  and pg_temp.story_counts() = current_setting('hid.test.after'));

-- 8. The PIN at Demo Hospital, as the EHR asks it (the demo login's doctor
-- membership, direct care): the test PIN opens Adaeze's record for 30
-- minutes; a wrong one does not.
set local role hid_identity_api_runtime;
select pg_temp.as_demo_staff(1);
select pg_temp.assert('a wrong PIN is refused',
  (select not verified from identity.access_patient_with_pin('HID-ZDEMAAA2', '1111', 30)));
select pg_temp.assert('the test PIN opens Adaeze''s record (a read grant by PIN)',
  (select verified and grant_status = 'active' from identity.access_patient_with_pin('HID-ZDEMAAA2', '9157', 30)));
reset role;
select pg_temp.assert('the grant is the PIN''s, at Demo Hospital, for direct care',
  exists (select 1 from identity.consent_grants grant_row
           where grant_row.patient_id = '98d00009-0000-4000-8000-000000000001'
             and grant_row.authorization_method = 'patient_access_pin' and grant_row.status = 'active'
             and grant_row.facility_id = '98d00002-0000-4000-8000-000000000001'
             and grant_row.purpose_of_use = 'direct-care' and grant_row.scope = 'read_records'));
set local role hid_identity_api_runtime;
select pg_temp.as_demo_staff(1);
select pg_temp.assert('Chinedu''s record opens with the same test PIN, not with a wrong one',
  (select not verified from identity.access_patient_with_pin('HID-ZDEMAAA3', '2222', 30))
  and (select verified from identity.access_patient_with_pin('HID-ZDEMAAA3', '9157', 30)));
reset role;

-- 9. Emergency: break-glass by the demo login at Demo Hospital (emergency
-- purpose, a reason): Abubakar Bello (Patient Three, no share) and Adaeze
-- (who has one); each a read-only emergency grant.
select pg_temp.assert('break-glass is switched on here, as on production',
  platform.control_enabled('break_glass_enabled'));
set local role hid_identity_api_runtime;
select pg_temp.as_demo_staff(1, 'emergency');
select set_config('hid.test.bg_three', (select consent_grant_id::text
  from identity.activate_break_glass('HID-ZDEMBBB2', 'Unconscious on arrival at the emergency room', 60)), true);
select set_config('hid.test.bg_one', (select consent_grant_id::text
  from identity.activate_break_glass('HID-ZDEMAAA2', 'Collapsed in the waiting area, not responding', 60)), true);
reset role;
select pg_temp.assert('two active break-glass grants for the emergency purpose',
  (select count(*) from identity.consent_grants grant_row
    where grant_row.id in (current_setting('hid.test.bg_three')::uuid, current_setting('hid.test.bg_one')::uuid)
      and grant_row.break_glass and grant_row.status = 'active' and grant_row.purpose_of_use = 'emergency'
      and grant_row.scope = 'break_glass') = 2);
update identity.consent_grants set starts_at = starts_at - interval '1 hour'
 where id in (current_setting('hid.test.bg_three')::uuid, current_setting('hid.test.bg_one')::uuid);
set local role hid_ehr_api_runtime;
select pg_temp.as_demo_staff(1, 'emergency');
select pg_temp.assert('the emergency purpose reads Abubakar''s and Adaeze''s records, and writes neither',
  ehr.context_allows('98d00009-0000-4000-8000-000000000003', '98d00002-0000-4000-8000-000000000001', 'read_records')
  and ehr.context_allows('98d00009-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001', 'read_records')
  and not ehr.context_allows('98d00009-0000-4000-8000-000000000003', '98d00002-0000-4000-8000-000000000001',
    'write_records'));
select pg_temp.assert('Adaeze''s chart under the emergency purpose shows the story',
  (select count(*) from ehr.diagnoses where patient_id = '98d00009-0000-4000-8000-000000000001') = 3);
reset role;
select pg_temp.assert('the break-glass limit: 2 of 10 this hour for the shared login',
  (select count(*) from identity.consent_grants grant_row
    where grant_row.account_id = '98d00003-0000-4000-8000-000000000001' and grant_row.break_glass
      and grant_row.created_at > clock_timestamp() - interval '1 hour') = 2);

-- 10. 0098's install still passes after the story and inserts nothing.
select pg_temp.assert('0098''s install after the story inserts nothing',
  (identity.sealed_demo_install()->>'inserted')::integer = 0);

rollback;
