\set ON_ERROR_STOP on
-- 0114: the sign-up fields Health ID now collects. Rollback-only. Every
-- command runs as the Identity API runtime role in the context Identity's
-- transactions set.
--
--   1. sign-up: the 11-argument code command refuses an incomplete or
--      invalid profile (no code is stored), stores a valid one with the code;
--      a resent code carries its own profile; activation copies the profile
--      of the code that opened the session (not an older one); a sign-up
--      through 0086's 7-argument command activates with no profile;
--   2. the administrator's read and save: workforce.manage at a self-service
--      facility only; If-Match (version conflict), Idempotency-Key (replay,
--      conflict), field-name-only audit, the first save of a facility with no
--      profile, an unchanged save;
--   3. a facility profile is never deleted; a code's profile goes with its
--      code;
--   4. the desk's patient contact: the case contact is all or none and
--      written by the desk only; the facility contact copies the case contact
--      exactly, at the case's facility, for the case's patient, and is read
--      only there; the runtime cannot change, erase or delete either;
--   5. erasure (NDPA): only the owner erases; only the erasable values change,
--      once; the row stays; an erased contact is never copied again; a
--      completed account deletion erases the patient's contacts and removes
--      their Health ID (and only that) from another person's case that
--      stated it; a case that never became a patient is erased by case; an
--      erasure function whose owner does not own the tables refuses.
begin;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('c1220000-0000-4000-8000-000000000001', 'synthetic:collect:super', 'super@collect.invalid', 'Collect Super Admin', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c1220100-0000-4000-8000-000000000001', 'c1220000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'Collect fields suite super admin');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('c1220600-0000-4000-8000-000000000001', 'HID-CLCTAB', 'Collect', 'Patient', 'Collect Patient', 'active'),
  ('c1220600-0000-4000-8000-000000000002', 'HID-CLCTAC', 'Other', 'Patient', 'Other Patient', 'active');

create function pg_temp.profile(trading text) returns jsonb language sql as $f$
  select jsonb_build_object(
    'trading_name', trading, 'ownership', 'private', 'care_level', 'secondary',
    'address_line', '12 Collect Road, Yaba', 'city', 'Lagos', 'state_code', 'LA', 'lga', 'Lagos Mainland',
    'gps_latitude', 6.5244, 'gps_longitude', 3.3792, 'phone_e164', '+2348012345678',
    'email', 'front.desk@collect.invalid', 'bed_count', 40, 'operating_hours', 'Mon-Sun 24 hours',
    'emergency_24h', true, 'departments', jsonb_build_array('general_outpatient', 'emergency', 'laboratory'),
    'services_offered', 'Outpatient care, emergency care and laboratory tests',
    'smoh_licence_number', 'LSMOH/2024/0001', 'has_registry_id', false, 'registry_id', null,
    'has_nhia_accreditation', true, 'nhia_accreditation_number', 'NHIA-0001',
    'medical_director_name', 'Dr Ada Collect', 'medical_director_mdcn', 'MDCN/12345',
    'expected_staff', 25, 'migrating_records', true, 'needs_interoperability', false)
$f$;
grant execute on function pg_temp.profile(text) to hid_identity_api_runtime;

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:collect:super', true),
  set_config('app.correlation_id', 'collect-open-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'Collect fields suite opens facility sign-up');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'collect-signup-0001', true),
  set_config('app.purpose_of_use', '', true);

-- 1. Sign-up. Application 1 sends two codes (profiles A then B) and confirms
-- the second; application 2 uses 0086's command.
do $$
declare
  application_id uuid;
  current_application record;
  activated record;
  attempt record;
  phone bytea := decode(repeat('ab', 40), 'hex');
begin
  application_id := identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9941220001',
    'Ada Collect Admin', 'ada@collect-hospital.invalid');
  select * into current_application from identity.public_get_organization_application(
    'RC9941220001', 'ada@collect-hospital.invalid', 'ehr');
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '99412201', 'RC9941220001', 'Ada Collect Hospital Ltd', 'Private Company Limited by Shares',
    '2017-07-01', '1 Registered Road, Lagos', 'active');
  perform set_config('hid.test.c_app_1', application_id::text, true);

  for attempt in select * from (values
      (1, pg_temp.profile('Ada Clinic') - 'lga', 'owner', 'a missing field'),
      (2, pg_temp.profile('Ada Clinic') || '{"logo": "x"}', 'owner', 'an unknown field'),
      (3, pg_temp.profile('Ada Clinic') || '{"state_code": "XX"}', 'owner', 'an unknown state'),
      (4, pg_temp.profile('Ada Clinic') || '{"departments": []}', 'owner', 'no department'),
      (5, pg_temp.profile('Ada Clinic') || '{"departments": ["icu", "icu"]}', 'owner', 'a repeated department'),
      (6, pg_temp.profile('Ada Clinic') || '{"departments": ["morgue"]}', 'owner', 'an unknown department'),
      (7, pg_temp.profile('Ada Clinic') || '{"phone_e164": "08012345678"}', 'owner', 'a local phone'),
      (8, pg_temp.profile('Ada Clinic') || '{"has_registry_id": true}', 'owner', 'a registry id said but missing'),
      (9, pg_temp.profile('Ada Clinic') || '{"medical_director_mdcn": "mdcn/1"}', 'owner', 'an unnormalized MDCN'),
      (10, pg_temp.profile('Ada Clinic') || '{"gps_latitude": 51.5}', 'owner', 'a pin outside Nigeria'),
      (11, pg_temp.profile('Ada Clinic') || '{"bed_count": "many"}', 'owner', 'a bed count in words'),
      (12, pg_temp.profile('Ada Clinic'), 'janitor', 'an unknown role'),
      (13, pg_temp.profile(' Ada Clinic'), 'owner', 'an untrimmed trading name')
    ) as rows(n, body, role_code, label) order by n loop
    begin
      perform identity.begin_self_service_provider_enrollment('RC9941220001', 'ada@collect-hospital.invalid', 'ehr',
        ('c1229000-0000-4000-8000-0000000001' || lpad(attempt.n::text, 2, '0'))::uuid,
        encode(sha256(('collect-bad-' || attempt.n)::bytea), 'hex'), 'Ada Collect Admin', 'hospital',
        attempt.body, attempt.role_code, phone, 'v1');
      raise exception 'Sign-up case % (%) was accepted', attempt.n, attempt.label;
    exception when invalid_parameter_value then
      if sqlerrm <> 'FACILITY_PROFILE_INVALID' then raise; end if;
    end;
  end loop;
  -- Code A, then code B a minute later (the resend wait is moved back by owner SQL below).
  if identity.begin_self_service_provider_enrollment('RC9941220001', 'ada@collect-hospital.invalid', 'ehr',
      'c1229100-0000-4000-8000-00000000000a', encode(sha256('collect-otp-a'::bytea), 'hex'), 'Ada Collect Admin',
      'hospital', pg_temp.profile('Ada Clinic A'), 'owner', phone, 'v1') is distinct from 'ada@collect-hospital.invalid' then
    raise exception 'Code A was not sent';
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from identity.organization_profile_completion_challenges challenge
       where challenge.application_id = current_setting('hid.test.c_app_1')::uuid) <> 1
     or exists (select 1 from identity.facility_profiles profile
                 where profile.challenge_id::text like 'c1229000-%') then
    raise exception 'A refused sign-up stored a code or a profile';
  end if;
end $$;
update identity.organization_profile_completion_challenges set created_at = created_at - interval '2 minutes'
 where id = 'c1229100-0000-4000-8000-00000000000a';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', 'collect-signup-0002', true);
do $$
declare
  activated record;
  phone bytea := decode(repeat('cd', 40), 'hex');
  application_id uuid;
  current_application record;
begin
  if identity.begin_self_service_provider_enrollment('RC9941220001', 'ada@collect-hospital.invalid', 'ehr',
      'c1229100-0000-4000-8000-00000000000b', encode(sha256('collect-otp-b'::bytea), 'hex'), 'Ada Collect Admin',
      'hospital', pg_temp.profile('Ada Clinic B'), 'medical_director', phone, 'v1') is null then
    raise exception 'Code B was not sent';
  end if;
  perform identity.verify_organization_profile_completion_challenge('c1229100-0000-4000-8000-00000000000b',
    encode(sha256('collect-otp-b'::bytea), 'hex'), encode(sha256('collect-session-1'::bytea), 'hex'));
  select * into activated from identity.activate_self_service_provider_enrollment(
    encode(sha256('collect-session-1'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.c_facility_1', activated.facility_id::text, true);
  perform set_config('hid.test.c_account_1', activated.account_id::text, true);
  perform set_config('hid.test.c_org_1', activated.organization_id::text, true);

  -- Application 2 through 0086's command: activates with no profile.
  application_id := identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9941220002',
    'Bola Collect Admin', 'bola@collect-lab.invalid');
  select * into current_application from identity.public_get_organization_application(
    'RC9941220002', 'bola@collect-lab.invalid', 'laboratory');
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '99412202', 'RC9941220002', 'Bola Collect Laboratory Ltd', 'Private Company Limited by Shares',
    '2018-07-01', '2 Registered Road, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment('RC9941220002', 'bola@collect-lab.invalid', 'laboratory',
    'c1229100-0000-4000-8000-00000000002a', encode(sha256('collect-otp-2'::bytea), 'hex'), 'Bola Collect Admin',
    'laboratory');
  perform identity.verify_organization_profile_completion_challenge('c1229100-0000-4000-8000-00000000002a',
    encode(sha256('collect-otp-2'::bytea), 'hex'), encode(sha256('collect-session-2'::bytea), 'hex'));
  select * into activated from identity.activate_self_service_provider_enrollment(
    encode(sha256('collect-session-2'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('c', 22) || '$' || repeat('d', 43));
  perform set_config('hid.test.c_facility_2', activated.facility_id::text, true);
  perform set_config('hid.test.c_account_2', activated.account_id::text, true);
end $$;
reset role;
do $$
declare copied identity.facility_profiles;
begin
  select * into copied from identity.facility_profiles where facility_id = current_setting('hid.test.c_facility_1')::uuid;
  if not found or copied.trading_name <> 'Ada Clinic B' or copied.submitter_role <> 'medical_director'
     or copied.submitter_phone_ciphertext <> decode(repeat('cd', 40), 'hex')
     or copied.submitter_phone_ref <> 'c1229100-0000-4000-8000-00000000000b'
     or copied.challenge_id is not null or copied.source <> 'self_service_signup' or copied.row_version <> 1
     or copied.departments <> array['general_outpatient', 'emergency', 'laboratory']
     or copied.gps_latitude <> 6.524400 or copied.medical_director_mdcn <> 'MDCN/12345' then
    raise exception 'Activation did not copy code B''s profile: %', row_to_json(copied);
  end if;
  if (select count(*) from identity.facility_profiles where challenge_id in
       ('c1229100-0000-4000-8000-00000000000a', 'c1229100-0000-4000-8000-00000000000b')) <> 2 then
    raise exception 'The codes'' own profiles are not kept with the codes';
  end if;
  if exists (select 1 from identity.facility_profiles where facility_id = current_setting('hid.test.c_facility_2')::uuid) then
    raise exception 'A sign-up without a profile got one';
  end if;
  if (select count(*) from audit.events where action = 'identity.facility-profile.activate'
        and facility_id = current_setting('hid.test.c_facility_1')::uuid
        and details = '{"source": "self_service_signup", "approvalMode": "self_service"}'::jsonb) <> 1 then
    raise exception 'The copy was not audited once without values';
  end if;
  -- 3. A facility's profile is never deleted; a code's goes with its code.
  begin
    delete from identity.facility_profiles where facility_id = current_setting('hid.test.c_facility_1')::uuid;
    raise exception 'A facility profile was deleted';
  exception when insufficient_privilege then null;
  end;
  delete from identity.organization_profile_completion_challenges where id = 'c1229100-0000-4000-8000-00000000000a';
  if exists (select 1 from identity.facility_profiles where challenge_id = 'c1229100-0000-4000-8000-00000000000a') then
    raise exception 'A code''s profile outlived its code';
  end if;
  begin
    update identity.facility_profiles set trading_name = 'Changed'
     where challenge_id = 'c1229100-0000-4000-8000-00000000000b';
    raise exception 'A code''s profile was changed';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('hid.test.c_membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.c_account_' || n)::uuid), true)
  from generate_series(1, 2) n;
create function pg_temp.as_admin(n integer, correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.c_account_' || n), true),
    set_config('app.membership_id', current_setting('hid.test.c_membership_' || n), true),
    set_config('app.facility_id', current_setting('hid.test.c_facility_' || n), true),
    set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
grant execute on function pg_temp.as_admin(integer,text) to hid_identity_api_runtime;

-- 2. The administrator's read and save.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'collect-read-1');
do $$
declare
  read_back record;
  saved record;
  changed jsonb := pg_temp.profile('Ada Clinic B') || '{"bed_count": 55, "lga": "Yaba"}';
begin
  select * into read_back from identity.read_facility_profile();
  if read_back.facility_id <> current_setting('hid.test.c_facility_1')::uuid or read_back.review_state <> 'pending'
     or read_back.facility_name <> 'Ada Collect Hospital Ltd'
     or read_back.profile_data ->> 'trading_name' <> 'Ada Clinic B'
     or (read_back.profile_data ->> 'row_version')::bigint <> 1
     or read_back.profile_data ? 'submitter_phone_ciphertext' or read_back.profile_data ? 'challenge_id'
     or not (read_back.profile_data ->> 'submitter_phone_on_record')::boolean then
    raise exception 'The read is wrong: %', row_to_json(read_back);
  end if;
  begin
    perform identity.set_facility_profile(7, changed, 'collect-key-0001', encode(sha256('r1'::bytea), 'hex'));
    raise exception 'A stale version was saved';
  exception when serialization_failure then
    if sqlerrm <> 'FACILITY_PROFILE_VERSION_CONFLICT' then raise; end if;
  end;
  begin
    perform identity.set_facility_profile(1, changed - 'city', 'collect-key-0001', encode(sha256('r1'::bytea), 'hex'));
    raise exception 'An incomplete save was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'FACILITY_PROFILE_INVALID' then raise; end if;
  end;
  select * into saved from identity.set_facility_profile(1, changed, 'collect-key-0001', encode(sha256('r1'::bytea), 'hex'));
  if saved.row_version <> 2 or saved.changed_fields <> array['bed_count', 'lga'] or saved.replayed then
    raise exception 'The save answered %', row_to_json(saved);
  end if;
  select * into saved from identity.set_facility_profile(1, changed, 'collect-key-0001', encode(sha256('r1'::bytea), 'hex'));
  if saved.row_version <> 2 or not saved.replayed or saved.changed_fields <> array['bed_count', 'lga'] then
    raise exception 'The replay answered %', row_to_json(saved);
  end if;
  begin
    perform identity.set_facility_profile(2, changed, 'collect-key-0001', encode(sha256('r2'::bytea), 'hex'));
    raise exception 'A reused key with another request was accepted';
  exception when unique_violation then
    if sqlerrm <> 'FACILITY_PROFILE_IDEMPOTENCY_CONFLICT' then raise; end if;
  end;
  select * into saved from identity.set_facility_profile(2, changed, 'collect-key-0002', encode(sha256('r3'::bytea), 'hex'));
  if saved.row_version <> 2 or cardinality(saved.changed_fields) <> 0 then
    raise exception 'An unchanged save answered %', row_to_json(saved);
  end if;
end $$;
-- Facility 2 has no profile: its first save is version 0.
select pg_temp.as_admin(2, 'collect-first-2');
do $$
declare saved record; read_back record;
begin
  select * into read_back from identity.read_facility_profile();
  if read_back.profile_data is not null then raise exception 'Facility 2 has a profile already'; end if;
  begin
    perform identity.set_facility_profile(1, pg_temp.profile('Bola Lab'), 'collect-key-0003', encode(sha256('r4'::bytea), 'hex'));
    raise exception 'A first save with version 1 was accepted';
  exception when serialization_failure then null;
  end;
  select * into saved from identity.set_facility_profile(0, pg_temp.profile('Bola Lab'), 'collect-key-0003',
    encode(sha256('r4'::bytea), 'hex'));
  if saved.row_version <> 1 or cardinality(saved.changed_fields) <> 26 then
    raise exception 'The first save answered %', row_to_json(saved);
  end if;
  select * into read_back from identity.read_facility_profile();
  if read_back.profile_data ->> 'source' <> 'facility_administrator'
     or (read_back.profile_data ->> 'submitter_phone_on_record')::boolean then
    raise exception 'The first save reads back as %', read_back.profile_data;
  end if;
end $$;
-- Someone without workforce.manage (no membership context) is refused.
select set_config('app.actor_subject', 'synthetic:collect:super', true), set_config('app.membership_id', '', true),
  set_config('app.facility_id', current_setting('hid.test.c_facility_1'), true);
do $$ begin
  perform identity.read_facility_profile();
  raise exception 'A platform account read a facility profile';
exception when insufficient_privilege then null;
end $$;
-- The runtime cannot touch the table directly.
do $$ begin
  perform 1 from identity.facility_profiles;
  raise exception 'The runtime read identity.facility_profiles';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$ begin
  if exists (select 1 from audit.events where action = 'identity.facility-profile.set'
              and (details::text like '%Yaba%' or details::text like '%55%' or details::text like '%Bola%'))
     or (select count(*) from audit.events where action = 'identity.facility-profile.set') <> 3
     or not exists (select 1 from audit.events where action = 'identity.facility-profile.set'
                     and details -> 'changedFields' = '["bed_count", "lga"]'::jsonb) then
    raise exception 'The saves were not audited with field names only';
  end if;
end $$;

-- 4. The desk's patient contact, at facility 1 after support's review (the
-- administrator then holds org_admin with identity.registration.write).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:collect:super', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'collect-review-1', true);
do $$
declare listed record;
begin
  select * into listed from identity.admin_list_self_service_facilities('unreviewed') item
   where item.facility_id = current_setting('hid.test.c_facility_1')::uuid;
  perform identity.admin_review_self_service_facility(listed.application_id, listed.row_version,
    'Checked the company and its administrator', 'none', 'regulator_register', null, null);
end $$;
select pg_temp.as_admin(1, 'collect-desk-1');
do $$
declare phone bytea := decode(repeat('11', 40), 'hex'); address bytea := decode(repeat('22', 60), 'hex');
begin
  insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
    first_name, last_name, full_name, dob, nin_ciphertext, nin_lookup_hmac, nin_last4, nin_key_version,
    verification_provider, verification_reference, verified_at, idempotency_key, request_sha256, resolved_patient_id)
  values ('c1227000-0000-4000-8000-000000000001', current_setting('hid.test.c_facility_1')::uuid,
    current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid,
    'resolved_existing_identity', 'Collect', 'Patient', 'Collect Patient', '1990-01-01', decode(repeat('00', 40), 'hex'),
    encode(sha256('collect-nin-1'::bytea), 'hex'), '0001', 'v1', 'fixture', 'ref-1', clock_timestamp(),
    'collect-case-key-0001', encode(sha256('collect-case-1'::bytea), 'hex'), 'c1220600-0000-4000-8000-000000000001');
  begin
    insert into identity.registration_case_contacts (registration_case_id, facility_id, phone_ciphertext,
      created_by_account_id, created_by_membership_id)
    values ('c1227000-0000-4000-8000-000000000001', current_setting('hid.test.c_facility_1')::uuid, phone,
      current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid);
    raise exception 'A case contact with a phone but no address was stored';
  exception when check_violation then null;
  end;
  begin
    insert into identity.registration_case_contacts (registration_case_id, facility_id, phone_ciphertext,
      address_ciphertext, key_version, created_by_account_id, created_by_membership_id, erased_at, erasure_reason)
    values ('c1227000-0000-4000-8000-000000000001', current_setting('hid.test.c_facility_1')::uuid, null, null, null,
      current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid,
      clock_timestamp(), 'erasure_request');
    raise exception 'The desk stored an already-erased case contact';
  exception when insufficient_privilege then null;
  end;
  insert into identity.registration_case_contacts (registration_case_id, facility_id, phone_ciphertext,
    address_ciphertext, key_version, stated_hid_code, created_by_account_id, created_by_membership_id)
  values ('c1227000-0000-4000-8000-000000000001', current_setting('hid.test.c_facility_1')::uuid, phone, address,
    'v1', 'HID-CLCTAB', current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid);
  begin
    insert into identity.patient_facility_contacts (patient_id, facility_id, registration_case_id, phone_ciphertext,
      address_ciphertext, key_version, created_by_account_id, created_by_membership_id)
    values ('c1220600-0000-4000-8000-000000000002', current_setting('hid.test.c_facility_1')::uuid,
      'c1227000-0000-4000-8000-000000000001', phone, address, 'v1', current_setting('hid.test.c_account_1')::uuid,
      current_setting('hid.test.c_membership_1')::uuid);
    raise exception 'A contact was stored for another patient than the case''s';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into identity.patient_facility_contacts (patient_id, facility_id, registration_case_id, phone_ciphertext,
      address_ciphertext, key_version, created_by_account_id, created_by_membership_id)
    values ('c1220600-0000-4000-8000-000000000001', current_setting('hid.test.c_facility_1')::uuid,
      'c1227000-0000-4000-8000-000000000001', decode(repeat('33', 40), 'hex'), address, 'v1',
      current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid);
    raise exception 'A contact that is not the case''s was stored';
  exception when insufficient_privilege then null;
  end;
  insert into identity.patient_facility_contacts (patient_id, facility_id, registration_case_id, phone_ciphertext,
    address_ciphertext, key_version, created_by_account_id, created_by_membership_id)
  values ('c1220600-0000-4000-8000-000000000001', current_setting('hid.test.c_facility_1')::uuid,
    'c1227000-0000-4000-8000-000000000001', phone, address, 'v1', current_setting('hid.test.c_account_1')::uuid,
    current_setting('hid.test.c_membership_1')::uuid);
  if (select count(*) from identity.patient_facility_contacts) <> 1
     or (select count(*) from identity.registration_case_contacts) <> 1 then
    raise exception 'The facility does not read its own contact';
  end if;
  -- The runtime holds no UPDATE or DELETE on either table.
  begin
    update identity.registration_case_contacts set key_version = 'v2'
     where registration_case_id = 'c1227000-0000-4000-8000-000000000001';
    raise exception 'The case''s contact was changed';
  exception when insufficient_privilege then null;
  end;
  begin
    update identity.patient_facility_contacts set phone_ciphertext = null, address_ciphertext = null,
      key_version = null, erased_at = clock_timestamp(), erasure_reason = 'erasure_request';
    raise exception 'The runtime erased a facility contact';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from identity.patient_facility_contacts;
    raise exception 'The runtime deleted a facility contact';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.erase_patient_facility_contacts('c1220600-0000-4000-8000-000000000001', 'erasure_request');
    raise exception 'The runtime ran the owner-only erasure';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.erase_registration_case_contact('c1227000-0000-4000-8000-000000000001', 'erasure_request');
    raise exception 'The runtime ran the owner-only erasure by case';
  exception when insufficient_privilege then null;
  end;
end $$;
-- Another facility's administrator reads nothing, and cannot add a contact to
-- facility 1's case.
select pg_temp.as_admin(2, 'collect-desk-2');
do $$ begin
  if exists (select 1 from identity.patient_facility_contacts)
     or exists (select 1 from identity.registration_case_contacts) then
    raise exception 'Another facility read the contact';
  end if;
end $$;
reset role;

-- 5. Erasure (NDPA). As the owner: a change other than erasure, a second
-- erasure and a delete are refused; erasure nulls the values and keeps the row.
do $$
declare erased record;
begin
  begin
    update identity.patient_facility_contacts set key_version = 'v2';
    raise exception 'A facility contact was changed without erasure';
  exception when insufficient_privilege then null;
  end;
  begin
    update identity.registration_case_contacts set stated_hid_code = 'HID-CLCTAC', erased_at = clock_timestamp(),
      erasure_reason = 'erasure_request', phone_ciphertext = null, address_ciphertext = null, key_version = null;
    raise exception 'An erasure kept the stated Health ID';
  exception when check_violation then null;
  end;
  begin
    update identity.patient_facility_contacts set patient_id = 'c1220600-0000-4000-8000-000000000002',
      erased_at = clock_timestamp(), erasure_reason = 'erasure_request', phone_ciphertext = null,
      address_ciphertext = null, key_version = null;
    raise exception 'An erasure moved the contact to another patient';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from identity.registration_case_contacts;
    raise exception 'A case contact was deleted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.erase_patient_facility_contacts('c1220600-0000-4000-8000-000000000001', 'because');
    raise exception 'An erasure with an unknown reason ran';
  exception when invalid_parameter_value then null;
  end;
  select * into erased from identity.erase_patient_facility_contacts('c1220600-0000-4000-8000-000000000001',
    'erasure_request');
  if erased.facility_contacts <> 1 or erased.registration_contacts <> 1 or erased.stated_health_ids <> 0 then
    raise exception 'The erasure did not reach both rows: %', row_to_json(erased);
  end if;
  if exists (select 1 from identity.patient_facility_contacts
              where phone_ciphertext is not null or address_ciphertext is not null or key_version is not null
                 or erased_at is null or erasure_reason <> 'erasure_request')
     or exists (select 1 from identity.registration_case_contacts
              where phone_ciphertext is not null or address_ciphertext is not null or key_version is not null
                 or stated_hid_code is not null or erased_at is null)
     or (select count(*) from identity.patient_facility_contacts) <> 1 then
    raise exception 'The erasure left a value or removed the row';
  end if;
  if not exists (select 1 from audit.events where action = 'identity.patient-facility-contact.erase'
                  and details = '{"reason": "erasure_request", "facilityContacts": 1, "registrationContacts": 1, "statedHealthIds": 0}'::jsonb) then
    raise exception 'The erasure was not audited with counts only';
  end if;
  begin
    update identity.patient_facility_contacts set erased_at = clock_timestamp();
    raise exception 'An erased contact was changed again';
  exception when insufficient_privilege then null;
  end;
  -- Nothing is left to erase: a second request erases nothing.
  select * into erased from identity.erase_patient_facility_contacts('c1220600-0000-4000-8000-000000000001',
    'erasure_request');
  if erased.facility_contacts <> 0 or erased.registration_contacts <> 0 or erased.stated_health_ids <> 0 then
    raise exception 'A second erasure changed rows';
  end if;
end $$;

-- An erased case contact is never copied again.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'collect-desk-3');
do $$ begin
  insert into identity.patient_facility_contacts (patient_id, facility_id, registration_case_id, phone_ciphertext,
    address_ciphertext, key_version, created_by_account_id, created_by_membership_id)
  values ('c1220600-0000-4000-8000-000000000001', current_setting('hid.test.c_facility_1')::uuid,
    'c1227000-0000-4000-8000-000000000001', decode(repeat('11', 40), 'hex'), decode(repeat('22', 60), 'hex'), 'v1',
    current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid);
  raise exception 'An erased contact was copied again';
exception when insufficient_privilege or unique_violation then null;
end $$;
-- A second case for the other patient, then that patient's account deletion
-- completes: the trigger erases its contacts ('account_deleted').
do $$
declare phone bytea := decode(repeat('44', 40), 'hex'); address bytea := decode(repeat('55', 60), 'hex');
begin
  insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
    first_name, last_name, full_name, dob, nin_ciphertext, nin_lookup_hmac, nin_last4, nin_key_version,
    verification_provider, verification_reference, verified_at, idempotency_key, request_sha256, resolved_patient_id)
  values ('c1227000-0000-4000-8000-000000000002', current_setting('hid.test.c_facility_1')::uuid,
    current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid,
    'resolved_existing_identity', 'Other', 'Patient', 'Other Patient', '1991-01-01', decode(repeat('00', 40), 'hex'),
    encode(sha256('collect-nin-2'::bytea), 'hex'), '0002', 'v1', 'fixture', 'ref-2', clock_timestamp(),
    'collect-case-key-0002', encode(sha256('collect-case-2'::bytea), 'hex'), 'c1220600-0000-4000-8000-000000000002');
  insert into identity.registration_case_contacts (registration_case_id, facility_id, phone_ciphertext,
    address_ciphertext, key_version, created_by_account_id, created_by_membership_id)
  values ('c1227000-0000-4000-8000-000000000002', current_setting('hid.test.c_facility_1')::uuid, phone, address,
    'v1', current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid);
  insert into identity.patient_facility_contacts (patient_id, facility_id, registration_case_id, phone_ciphertext,
    address_ciphertext, key_version, created_by_account_id, created_by_membership_id)
  values ('c1220600-0000-4000-8000-000000000002', current_setting('hid.test.c_facility_1')::uuid,
    'c1227000-0000-4000-8000-000000000002', phone, address, 'v1', current_setting('hid.test.c_account_1')::uuid,
    current_setting('hid.test.c_membership_1')::uuid);
  -- A third person's case, never reviewed (no patient), that stated the other
  -- patient's Health ID (in lower case, as typed; Identity upper-cases it).
  insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
    first_name, last_name, full_name, dob, nin_ciphertext, nin_lookup_hmac, nin_last4, nin_key_version,
    verification_provider, verification_reference, verified_at, idempotency_key, request_sha256)
  values ('c1227000-0000-4000-8000-000000000003', current_setting('hid.test.c_facility_1')::uuid,
    current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid,
    'review_required', 'Third', 'Person', 'Third Person', '1992-01-01', decode(repeat('00', 40), 'hex'),
    encode(sha256('collect-nin-3'::bytea), 'hex'), '0003', 'v1', 'fixture', 'ref-3', clock_timestamp(),
    'collect-case-key-0003', encode(sha256('collect-case-3'::bytea), 'hex'));
  insert into identity.registration_case_contacts (registration_case_id, facility_id, phone_ciphertext,
    address_ciphertext, key_version, stated_hid_code, created_by_account_id, created_by_membership_id)
  values ('c1227000-0000-4000-8000-000000000003', current_setting('hid.test.c_facility_1')::uuid,
    decode(repeat('66', 40), 'hex'), decode(repeat('77', 60), 'hex'), 'v1', upper('hid-clctac'),
    current_setting('hid.test.c_account_1')::uuid, current_setting('hid.test.c_membership_1')::uuid);
end $$;
reset role;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('c1220000-0000-4000-8000-000000000009', 'synthetic:collect:patient2', 'patient2@collect.invalid',
   'Other Patient', 'active');
insert into identity.patient_account_deletion_requests (id, account_id, patient_id, requested_session_id, state,
  confirmation_token_sha256, confirmation_expires_at, confirmation_consumed_at, confirmed_at, waiting_period,
  scheduled_for, correlation_id)
values ('c1229000-0000-4000-8000-000000000001', 'c1220000-0000-4000-8000-000000000009',
  'c1220600-0000-4000-8000-000000000002', 'c1229100-0000-4000-8000-000000000001', 'pending',
  encode(sha256('collect-deletion-1'::bytea), 'hex'), clock_timestamp() + interval '10 minutes', clock_timestamp(),
  clock_timestamp(), interval '0', clock_timestamp(), 'collect-deletion-0001');
do $$ begin
  if (select count(*) from identity.patient_facility_contacts
       where patient_id = 'c1220600-0000-4000-8000-000000000002' and erased_at is null) <> 1 then
    raise exception 'A pending deletion erased the contact';
  end if;
end $$;
update identity.patient_account_deletion_requests set state = 'completed', completed_at = clock_timestamp(),
  row_version = row_version + 1 where id = 'c1229000-0000-4000-8000-000000000001';
do $$ begin
  if exists (select 1 from identity.patient_facility_contacts
              where patient_id = 'c1220600-0000-4000-8000-000000000002'
                and (erased_at is null or erasure_reason <> 'account_deleted' or phone_ciphertext is not null))
     or exists (select 1 from identity.registration_case_contacts
              where registration_case_id = 'c1227000-0000-4000-8000-000000000002' and erased_at is null) then
    raise exception 'A completed account deletion did not erase the facility contacts';
  end if;
  -- The third person's case lost only the deleted patient's Health ID.
  if not exists (select 1 from identity.registration_case_contacts
                  where registration_case_id = 'c1227000-0000-4000-8000-000000000003'
                    and stated_hid_code is null and erased_at is null and erasure_reason is null
                    and phone_ciphertext = decode(repeat('66', 40), 'hex')
                    and address_ciphertext = decode(repeat('77', 60), 'hex') and key_version = 'v1') then
    raise exception 'The deleted patient''s Health ID stayed on another case, or that case lost more';
  end if;
  if not exists (select 1 from audit.events where action = 'identity.patient-facility-contact.erase'
                  and patient_id = 'c1220600-0000-4000-8000-000000000002'
                  and details = '{"reason": "account_deleted", "facilityContacts": 1, "registrationContacts": 1, "statedHealthIds": 1}'::jsonb) then
    raise exception 'The account-deletion erasure was not audited with counts only';
  end if;
end $$;

-- Only the stated Health ID alone may be removed; nothing else changes
-- without erasure.
do $$ begin
  begin
    update identity.registration_case_contacts set key_version = 'v9'
     where registration_case_id = 'c1227000-0000-4000-8000-000000000003';
    raise exception 'A case contact was changed without erasure';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A case that never became a patient is erased by case (an erasure request
-- only); a second run erases nothing.
do $$
declare erased record;
begin
  begin
    perform identity.erase_registration_case_contact('c1227000-0000-4000-8000-000000000003', 'account_deleted');
    raise exception 'An erasure by case ran for an account deletion';
  exception when invalid_parameter_value then null;
  end;
  select * into erased from identity.erase_registration_case_contact('c1227000-0000-4000-8000-000000000003',
    'erasure_request');
  if erased.facility_contacts <> 0 or erased.registration_contacts <> 1 then
    raise exception 'The erasure by case did not erase the case contact: %', row_to_json(erased);
  end if;
  if not exists (select 1 from identity.registration_case_contacts
                  where registration_case_id = 'c1227000-0000-4000-8000-000000000003'
                    and phone_ciphertext is null and address_ciphertext is null and key_version is null
                    and stated_hid_code is null and erased_at is not null and erasure_reason = 'erasure_request') then
    raise exception 'The erasure by case left a value or removed the row';
  end if;
  if not exists (select 1 from audit.events where action = 'identity.registration-case-contact.erase'
                  and resource_id = 'c1227000-0000-4000-8000-000000000003' and patient_id is null
                  and facility_id = current_setting('hid.test.c_facility_1')::uuid
                  and details = '{"reason": "erasure_request", "facilityContacts": 0, "registrationContacts": 1}'::jsonb) then
    raise exception 'The erasure by case was not audited with counts only';
  end if;
  select * into erased from identity.erase_registration_case_contact('c1227000-0000-4000-8000-000000000003',
    'erasure_request');
  if erased.facility_contacts <> 0 or erased.registration_contacts <> 0 then
    raise exception 'A second erasure by case changed rows';
  end if;
end $$;

-- An erasure function whose owner does not own the contact tables (an owner
-- changed later) refuses instead of erasing nothing. Needs a superuser to
-- change the owner; skipped otherwise.
do $$
declare refused boolean := false;
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    return;
  end if;
  create role hid_collect_suite_other_owner nologin;
  grant usage on schema identity, audit, platform to hid_collect_suite_other_owner;
  grant execute on function identity.assert_facility_contact_eraser() to hid_collect_suite_other_owner;
  alter function identity.erase_registration_case_contact(uuid, text) owner to hid_collect_suite_other_owner;
  begin
    perform identity.erase_registration_case_contact('c1227000-0000-4000-8000-000000000001', 'erasure_request');
  exception when insufficient_privilege then
    refused := sqlerrm = 'Facility-held contacts can only be erased by the owner of their tables';
  end;
  if not refused then
    raise exception 'An erasure run by a role that does not own the tables did not refuse';
  end if;
end $$;

rollback;
