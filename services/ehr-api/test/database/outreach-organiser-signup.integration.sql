\set ON_ERROR_STOP on
-- Outreach organisers (0125): public sign-up, the signed-in "Start an
-- outreach group", the role fence, support's review before Active, consent,
-- outreach invitations, suspension and support's campaign rescue.
-- Rollback-only. Fictional people, groups and places only.
--
-- A registration's consent is checked at commit (a deferred constraint
-- trigger); cases fire it early with SET CONSTRAINTS ... IMMEDIATE and set it
-- back to deferred.
--
-- Fixtures are inserted with session_replication_role = replica. Every case
-- then runs, with every trigger and RLS policy, as the production runtime
-- role that would run it (hid_identity_api_runtime for Identity's commands,
-- hid_outreach_api_runtime for outreach-api's writes) under the session that
-- service sets, or, for the fence, as the owner of auth.account_roles (on a
-- production-shaped database the NOSUPERUSER NOBYPASSRLS migration login), so
-- that not even the owner can write a forbidden role. Each case records its
-- outcome ('ok', a row count, the rows a query answered, or the SQLSTATE and
-- message raised) and the suite fails at the end listing every case whose
-- outcome differs.
begin;

-- 1. The objects as 0125 makes them.
do $$
begin
  if to_regclass('identity.outreach_organisations') is null
     or not exists (select 1 from pg_trigger where tgname = 'account_roles_outreach_fence' and tgenabled = 'O')
     or (select count(*) from pg_trigger where tgname = 'outreach_organiser_tenant_rules' and tgenabled = 'O') <> 4
     or not exists (select 1 from auth.roles where code = 'outreach_organiser')
     or exists (select 1 from auth.role_permissions where role_code in ('outreach_organiser', 'outreach_volunteer')
                 and permission_code not like 'outreach.%') then
    raise exception 'the outreach organiser objects are not as 0125 makes them';
  end if;
end $$;

-- The control functions' owner may not bypass row-level security (production):
-- lift FORCE on the control table for this transaction, as the other control
-- suites do.
do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

-- 2. Fixtures. Hospital H (0e000000-...-0002) with doctor D (n=1) and nurse N
-- (n=2); support admin S (n=3) holding platform_admin; patient-only account
-- P (n=4).
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('0e000000-0000-4000-8000-000000000001', 'Signup Test Hospital Group', 'signup-test-hospital-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('0e000000-0000-4000-8000-000000000002', '0e000000-0000-4000-8000-000000000001', 'Signup Test Hospital',
   'SIGNUP-TEST-H', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('0e010000-0000-4000-8000-000000000001', 'synthetic:os-doctor', 'os-doctor@example.invalid', 'Ada Doctor', 'active'),
  ('0e010000-0000-4000-8000-000000000002', 'synthetic:os-nurse', 'os-nurse@example.invalid', 'Bisi Nurse', 'active'),
  ('0e010000-0000-4000-8000-000000000003', 'synthetic:os-support', 'os-support@example.invalid', 'Chidi Support', 'active'),
  ('0e010000-0000-4000-8000-000000000004', 'synthetic:os-patient', 'os-patient@example.invalid', 'Dayo Patient', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('0e020000-0000-4000-8000-000000000001', '0e010000-0000-4000-8000-000000000001', 'Ada Doctor', 'os-doctor@example.invalid', 'verified', 'doctor'),
  ('0e020000-0000-4000-8000-000000000002', '0e010000-0000-4000-8000-000000000002', 'Bisi Nurse', 'os-nurse@example.invalid', 'verified', 'nurse');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('0e030000-0000-4000-8000-000000000001', '0e020000-0000-4000-8000-000000000001', '0e010000-0000-4000-8000-000000000001',
   '0e000000-0000-4000-8000-000000000001', '0e000000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true),
  ('0e030000-0000-4000-8000-000000000002', '0e020000-0000-4000-8000-000000000002', '0e010000-0000-4000-8000-000000000002',
   '0e000000-0000-4000-8000-000000000001', '0e000000-0000-4000-8000-000000000002', 'nurse', 'nurse', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('0e040000-0000-4000-8000-000000000001', '0e010000-0000-4000-8000-000000000001', 'doctor', 'facility',
   '0e030000-0000-4000-8000-000000000001', '0e000000-0000-4000-8000-000000000002', 'Synthetic signup suite role'),
  ('0e040000-0000-4000-8000-000000000002', '0e010000-0000-4000-8000-000000000002', 'nurse', 'facility',
   '0e030000-0000-4000-8000-000000000002', '0e000000-0000-4000-8000-000000000002', 'Synthetic signup suite role'),
  ('0e040000-0000-4000-8000-000000000003', '0e010000-0000-4000-8000-000000000003', 'platform_admin', 'platform',
   null, null, 'Synthetic signup suite support role');
-- A hospital campaign, to show hospital outreach is unchanged.
insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services, starts_at)
values ('0e070000-0000-4000-8000-000000000001', '0e000000-0000-4000-8000-000000000002',
  '0e010000-0000-4000-8000-000000000001', '0e030000-0000-4000-8000-000000000001', 'Hospital Campaign',
  array['registration']::text[], clock_timestamp() - interval '1 day');
insert into outreach.campaign_members (campaign_id, facility_id, membership_id, role, added_by_account_id, added_by_membership_id)
values ('0e070000-0000-4000-8000-000000000001', '0e000000-0000-4000-8000-000000000002',
  '0e030000-0000-4000-8000-000000000001', 'admin', '0e010000-0000-4000-8000-000000000001',
  '0e030000-0000-4000-8000-000000000001');
set local session_replication_role = origin;

create temporary table os_cases (seq serial, name text primary key, expected text not null, actual text) on commit drop;
grant select, insert on os_cases to public;
grant usage on sequence os_cases_seq_seq to public;
-- Ids the commands hand back, for later cases.
create temporary table os_ids (label text primary key, id uuid) on commit drop;
grant select, insert, update on os_ids to public;

create function pg_temp.hex(seed text) returns text language sql immutable as $$
  select encode(sha256(convert_to(seed, 'UTF8')), 'hex') $$;
create function pg_temp.id(wanted text) returns text language sql stable as $$
  select id::text from pg_temp.os_ids where label = wanted $$;
grant execute on function pg_temp.hex(text), pg_temp.id(text) to public;

-- Runs statement as run_role with the session a service sets: 'ok', 'rows <n>',
-- the rows a query answered joined by ' | ', or the SQLSTATE and message.
-- With keep = false a successful statement is undone.
create function pg_temp.os_try(run_role text, subject text, facility text, membership text, purpose text,
  statement text, keep boolean, kind text) returns text language plpgsql as $$
declare outcome text; affected bigint;
begin
  perform set_config('app.actor_subject', coalesce(subject, ''), true),
          set_config('app.facility_id', coalesce(facility, ''), true),
          set_config('app.membership_id', coalesce(membership, ''), true),
          set_config('app.correlation_id', 'outreach-signup-suite', true),
          set_config('app.purpose_of_use', coalesce(purpose, ''), true);
  execute format('set local role %I', run_role);
  begin
    if kind = 'query' then
      execute format('select coalesce(string_agg(row_text::text, %L), %L) from (%s) answered(row_text)', ' | ', 'none', statement)
        into outcome;
    else
      execute statement;
      get diagnostics affected = row_count;
      outcome := case when kind = 'count' then 'rows ' || affected else 'ok' end;
    end if;
    if not keep then raise exception using errcode = 'P0001', message = 'outreach-signup-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'outreach-signup-suite: undo' then outcome := sqlstate || ': ' || sqlerrm; end if;
  end;
  reset role;
  return outcome;
end $$;
create function pg_temp.os_case(case_name text, expected text, run_role text, subject text, facility text,
  membership text, purpose text, statement text, keep boolean default false, kind text default 'statement')
returns void language plpgsql as $$
begin
  insert into pg_temp.os_cases (name, expected, actual)
  values (case_name, expected, pg_temp.os_try(run_role, subject, facility, membership, purpose, statement, keep, kind));
end $$;
-- Identity's accountless commands (system:auth).
create function pg_temp.auth_case(case_name text, expected text, statement text, keep boolean default true,
  kind text default 'query') returns void language sql as $$
  select pg_temp.os_case(case_name, expected, 'hid_identity_api_runtime', 'system:auth', null, null, null,
    statement, keep, kind) $$;
-- Identity's signed-in commands (a staff login, healthcare-operations).
create function pg_temp.staff_case(case_name text, expected text, subject text, statement text,
  keep boolean default true, kind text default 'query', facility text default null, membership text default null)
returns void language sql as $$
  select pg_temp.os_case(case_name, expected, 'hid_identity_api_runtime', subject, facility, membership,
    'healthcare-operations', statement, keep, kind) $$;
-- outreach-api's writes (direct care at the session facility).
create function pg_temp.outreach_case(case_name text, expected text, subject text, facility text, membership text,
  statement text, keep boolean default false, kind text default 'statement') returns void language sql as $$
  select pg_temp.os_case(case_name, expected, 'hid_outreach_api_runtime', subject, facility, membership,
    'direct-care', statement, keep, kind) $$;
-- The fence, as the owner of auth.account_roles.
create function pg_temp.owner_case(case_name text, expected text, statement text) returns void language sql as $$
  select pg_temp.os_case(case_name, expected,
    (select pg_get_userbyid(relowner) from pg_class where oid = 'auth.account_roles'::regclass),
    null, null, null, null, statement, false, 'statement') $$;

create function pg_temp.start_signup(signup_label text, email text, group_name text) returns text language sql as $$
  select format($s$select identity.start_outreach_organiser_signup(%L::uuid, %L, %L, 'Efe Organiser', %L, 'group',
      'IT-123456', %L, decode(repeat('ab', 32), 'hex'), 'k1', %L, %L)$s$,
    gen_random_uuid(), pg_temp.hex('token-' || signup_label), email, group_name, pg_temp.hex('phone-' || signup_label),
    pg_temp.hex('network-' || signup_label), pg_temp.hex('code-' || signup_label)) $$;
create function pg_temp.password_hash() returns text language sql immutable as $$
  select '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljc2FsdA$' || repeat('A', 43) $$;
grant execute on function pg_temp.password_hash() to public;

-- 3. The control is off: sign-up is refused.
select pg_temp.auth_case('1a sign-up while the control is off', '55000: PLATFORM_CONTROL_DISABLED:outreach_organiser_signup_enabled',
  pg_temp.start_signup('off', 'off@example.invalid', 'Off Group'), false);
update platform.control_settings set enabled = true where control_key = 'outreach_organiser_signup_enabled';

-- 4. Public sign-up.
insert into os_ids select 'signup1', gen_random_uuid();
select pg_temp.auth_case('1b start a sign-up', 'started',
  format($s$select identity.start_outreach_organiser_signup(%L::uuid, %L, 'Organiser.One@Example.invalid', 'Efe Organiser',
      'Lagos Island Health Volunteers', 'group', null, %L, decode(repeat('ab', 32), 'hex'), 'k1', %L, %L)$s$,
    pg_temp.id('signup1'), pg_temp.hex('token-1'), pg_temp.hex('phone-1'), pg_temp.hex('network-1'), pg_temp.hex('code-1')));
select pg_temp.auth_case('1c a hospital-sounding name is refused', 'name_not_allowed',
  pg_temp.start_signup('2', 'two@example.invalid', 'Ikeja General Hospital Outreach'), false);
select pg_temp.auth_case('1d a government acronym is refused', 'name_not_allowed',
  pg_temp.start_signup('3', 'three@example.invalid', 'NCDC Volunteers'), false);
select pg_temp.auth_case('1e an everyday "who" is fine', 'started',
  pg_temp.start_signup('4', 'four@example.invalid', 'People who care Yaba'), false);
select pg_temp.auth_case('1f an email with a login is refused (sign in instead)', 'email_registered',
  pg_temp.start_signup('5', 'os-nurse@example.invalid', 'Nurses Who Walk'), false);
select pg_temp.auth_case('1g a malformed email is refused', '22023: OUTREACH_ORGANISER_SIGNUP_INVALID',
  pg_temp.start_signup('6', 'not-an-email', 'Some Group'), false);
select pg_temp.os_case('1h the Outreach runtime cannot start a sign-up',
  '42501: permission denied for function start_outreach_organiser_signup', 'hid_outreach_api_runtime', 'system:auth',
  null, null, null, pg_temp.start_signup('7', 'seven@example.invalid', 'Seven Group'), false, 'query');
select pg_temp.auth_case('1i activate before the email is verified', '23514: OUTREACH_ORGANISER_SIGNUP_NOT_READY',
  format('select 1 from identity.activate_outreach_organiser(%L, %L, %L, %L)', pg_temp.id('signup1'),
    pg_temp.hex('token-1'), pg_temp.password_hash(), '2026-11-01'), false);
select pg_temp.auth_case('1j a wrong code is counted', 'wrong_code',
  format('select identity.verify_outreach_organiser_email(%L, %L, %L)', pg_temp.id('signup1'), pg_temp.hex('token-1'),
    pg_temp.hex('wrong')));
select pg_temp.auth_case('1k a wrong token is denied', 'denied',
  format('select identity.verify_outreach_organiser_email(%L, %L, %L)', pg_temp.id('signup1'), pg_temp.hex('nope'),
    pg_temp.hex('code-1')));
select pg_temp.auth_case('1l the right code verifies the email', 'verified',
  format('select identity.verify_outreach_organiser_email(%L, %L, %L)', pg_temp.id('signup1'), pg_temp.hex('token-1'),
    pg_temp.hex('code-1')));
select pg_temp.auth_case('1m old terms are refused', '22023: OUTREACH_ORGANISER_TERMS_REQUIRED',
  format('select 1 from identity.activate_outreach_organiser(%L, %L, %L, %L)', pg_temp.id('signup1'),
    pg_temp.hex('token-1'), pg_temp.password_hash(), '2026-01-01'), false);
select pg_temp.auth_case('1n activation creates the group', 'rows 4',
  format($s$insert into pg_temp.os_ids (label, id)
    select unnest(array['org1', 'fac1', 'acct1', 'mem1']),
           unnest(array[organization_id, facility_id, account_id, membership_id])
      from identity.activate_outreach_organiser(%L, %L, %L, %L) where not replayed$s$, pg_temp.id('signup1'),
    pg_temp.hex('token-1'), pg_temp.password_hash(), '2026-11-01'), true, 'count');
select pg_temp.auth_case('1o a repeat answers the same group', 'true',
  format('select (replayed and organization_id = %L)::text from identity.activate_outreach_organiser(%L, %L, %L, %L)',
    pg_temp.id('org1'), pg_temp.id('signup1'), pg_temp.hex('token-1'), pg_temp.password_hash(), '2026-11-01'));

-- The new group as stored.
select pg_temp.os_case('1p the group is pending, its facility verified, the organiser holds outreach_organiser only',
  'pending verified outreach_organiser outreach-organiser:', 'pgrun', null, null, null, null,
  format($s$select organisation.review_state || ' ' || facility.lifecycle_status || ' '
      || (select string_agg(role_code, ',') from auth.account_roles where account_id = %L and revoked_at is null) || ' '
      || left(account.subject, 19)
      from identity.outreach_organisations organisation
      join identity.facilities facility on facility.id = organisation.facility_id
      join auth.accounts account on account.id = organisation.organiser_account_id
     where organisation.organization_id = %L$s$, pg_temp.id('acct1'), pg_temp.id('org1')), false, 'query');
create function pg_temp.subject_of(account_label text) returns text language sql stable as $$
  select subject from auth.accounts where id = pg_temp.id(account_label)::uuid $$;
grant execute on function pg_temp.subject_of(text) to public;

-- 5. Campaigns before and after support's review.
insert into os_ids values ('camp1', gen_random_uuid());
select pg_temp.outreach_case('2a the organiser creates a planned campaign and seeds themself as its admin', 'ok',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  format($s$insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services,
      starts_at) values (%L, %L, %L, %L, 'Market Day Screening', array['registration']::text[], clock_timestamp() - interval '1 hour');
    insert into outreach.campaign_members (campaign_id, facility_id, membership_id, role, added_by_account_id,
      added_by_membership_id) values (%L, %L, %L, 'admin', %L, %L)$s$,
    pg_temp.id('camp1'), pg_temp.id('fac1'), pg_temp.id('acct1'), pg_temp.id('mem1'),
    pg_temp.id('camp1'), pg_temp.id('fac1'), pg_temp.id('mem1'), pg_temp.id('acct1'), pg_temp.id('mem1')), true);
select pg_temp.outreach_case('2b Active before review is refused (update)', '55000: OUTREACH_ORGANISER_AWAITING_REVIEW',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  format($s$update outreach.campaigns set status = 'active', row_version = row_version + 1 where id = %L$s$, pg_temp.id('camp1')));
select pg_temp.outreach_case('2c Active before review is refused (insert)', '55000: OUTREACH_ORGANISER_AWAITING_REVIEW',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  format($s$insert into outreach.campaigns (facility_id, created_by_account_id, created_by_membership_id, name, services,
      status, starts_at) values (%L, %L, %L, 'Straight To Active', array['registration']::text[], 'active', clock_timestamp())$s$,
    pg_temp.id('fac1'), pg_temp.id('acct1'), pg_temp.id('mem1')));
select pg_temp.outreach_case('2d a hospital campaign still opens without any review', 'rows 1',
  'synthetic:os-doctor', '0e000000-0000-4000-8000-000000000002', '0e030000-0000-4000-8000-000000000001',
  $s$update outreach.campaigns set status = 'active', row_version = row_version + 1
      where id = '0e070000-0000-4000-8000-000000000001'$s$, true, 'count');
select pg_temp.staff_case('2e an organiser cannot use support''s review', '42501: ADMIN_PERMISSION_DENIED',
  pg_temp.subject_of('acct1'), format('select review_state from identity.admin_review_outreach_organiser(%L, 1)',
    pg_temp.id('org1')), false);
select pg_temp.staff_case('2f the check queue lists the group', 'Lagos Island Health Volunteers pending 1 0',
  'synthetic:os-support', $s$select display_name || ' ' || review_state || ' ' || member_count || ' ' || active_campaign_count
      from identity.admin_list_outreach_organisers('pending')$s$, false);
select pg_temp.staff_case('2g one click: support reviews the group', 'reviewed', 'synthetic:os-support',
  format('select review_state from identity.admin_review_outreach_organiser(%L, 1)', pg_temp.id('org1')));
select pg_temp.staff_case('2h a second review is refused', '23514: OUTREACH_ORGANISER_NOT_PENDING', 'synthetic:os-support',
  format('select review_state from identity.admin_review_outreach_organiser(%L, 2)', pg_temp.id('org1')), false);
select pg_temp.outreach_case('2i after review the admin opens the campaign', 'rows 1',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  format($s$update outreach.campaigns set status = 'active', row_version = row_version + 1 where id = %L$s$, pg_temp.id('camp1')),
  true, 'count');

-- 6. Registrations at a group: campaign, notes cap, consent, no Health ID link.
create function pg_temp.registration(case_id text, campaign text, age integer, notes text) returns text language sql as $$
  select format($s$insert into outreach.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id,
      local_command_id, temporary_patient_id, full_name, sex, age_years, phone, operational_notes, campaign_id)
    values (%L, %L, %L, %L, gen_random_uuid(), 'tmp_' || gen_random_uuid(), 'Funke Example', 'female', %s, '+2348000000001', %L, %L)$s$,
    case_id, pg_temp.id('fac1'), pg_temp.id('acct1'), pg_temp.id('mem1'), age, notes, campaign) $$;
create function pg_temp.consent(case_id text, method text, guardian text) returns text language sql as $$
  select format($s$insert into outreach.registration_consents (registration_case_id, facility_id, consent_text_version,
      language, method, guardian_name, captured_by_account_id, captured_by_membership_id)
    values (%L, %L, 'notice-2026-11-01', 'yo', %L, %L, %L, %L)$s$,
    case_id, pg_temp.id('fac1'), method, guardian, pg_temp.id('acct1'), pg_temp.id('mem1')) $$;
grant execute on function pg_temp.registration(text, text, integer, text), pg_temp.consent(text, text, text) to public;
insert into os_ids values ('case1', gen_random_uuid()), ('case2', gen_random_uuid());
select pg_temp.outreach_case('3a a registration without a campaign is refused', '23514: OUTREACH_CAMPAIGN_REQUIRED',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'), pg_temp.registration(pg_temp.id('case2'), null, 30, null));
select pg_temp.outreach_case('3b notes over 280 characters are refused', '23514: OUTREACH_NOTES_TOO_LONG',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  pg_temp.registration(pg_temp.id('case2'), pg_temp.id('camp1'), 30, repeat('n', 281)));
select pg_temp.outreach_case('3c a registration without consent is refused at commit', '23514: OUTREACH_CONSENT_REQUIRED',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  pg_temp.registration(pg_temp.id('case2'), pg_temp.id('camp1'), 30, null) || '; set constraints outreach.outreach_registration_consent_required immediate; set constraints outreach.outreach_registration_consent_required deferred');
select pg_temp.outreach_case('3d an under-18 consent needs a guardian', '23514: OUTREACH_CONSENT_GUARDIAN_REQUIRED',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  pg_temp.registration(pg_temp.id('case2'), pg_temp.id('camp1'), 12, null) || '; '
    || pg_temp.consent(pg_temp.id('case2'), 'verbal_read_aloud', null));
select pg_temp.outreach_case('3e a registration with consent is kept', 'ok',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  pg_temp.registration(pg_temp.id('case1'), pg_temp.id('camp1'), 15, 'Blood pressure check') || '; '
    || pg_temp.consent(pg_temp.id('case1'), 'guardian', 'Kemi Example') || '; set constraints outreach.outreach_registration_consent_required immediate; set constraints outreach.outreach_registration_consent_required deferred', true);
select pg_temp.outreach_case('3f consent cannot be changed', '42501: permission denied for table registration_consents',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  format('update outreach.registration_consents set language = %L where registration_case_id = %L', 'en', pg_temp.id('case1')));
select pg_temp.outreach_case('3g a group cannot link a person to a Health ID', '42501: OUTREACH_TENANT_NO_HEALTH_ID_LINK',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  format($s$update outreach.registration_cases set status = 'identity_resolved', resolved_patient_id = gen_random_uuid(),
      resolution_kind = 'linked_existing', resolved_by_account_id = %L, resolved_by_membership_id = %L,
      resolution_reason = 'Synthetic link attempt', resolved_at = clock_timestamp(), row_version = row_version + 1
     where id = %L$s$, pg_temp.id('acct1'), pg_temp.id('mem1'), pg_temp.id('case1')));
select pg_temp.outreach_case('3h nor write a patient mapping', '42501: OUTREACH_TENANT_NO_HEALTH_ID_LINK',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  format($s$insert into outreach.patient_mappings (registration_case_id, facility_id, temporary_patient_id,
      canonical_patient_id, resolution_kind, resolved_by_account_id, resolved_by_membership_id, reason)
    select id, facility_id, temporary_patient_id, gen_random_uuid(), 'linked_existing', %L, %L, 'Synthetic link attempt'
      from outreach.registration_cases where id = %L$s$, pg_temp.id('acct1'), pg_temp.id('mem1'), pg_temp.id('case1')));
select pg_temp.outreach_case('3i a hospital registration needs no campaign and no consent (unchanged)', 'ok',
  'synthetic:os-doctor', '0e000000-0000-4000-8000-000000000002', '0e030000-0000-4000-8000-000000000001',
  $s$insert into outreach.registration_cases (facility_id, created_by_account_id, created_by_membership_id,
      local_command_id, temporary_patient_id, full_name, sex, age_years)
    values ('0e000000-0000-4000-8000-000000000002', '0e010000-0000-4000-8000-000000000001',
      '0e030000-0000-4000-8000-000000000001', gen_random_uuid(), 'tmp_' || gen_random_uuid(), 'Gbenga Example', 'male', 40);
    set constraints outreach.outreach_registration_consent_required immediate; set constraints outreach.outreach_registration_consent_required deferred$s$);

-- 7. Isolation, both ways.
select pg_temp.outreach_case('4a the hospital doctor sees none of the group''s registrations', 'none',
  'synthetic:os-doctor', '0e000000-0000-4000-8000-000000000002', '0e030000-0000-4000-8000-000000000001',
  format('select full_name from outreach.registration_cases where facility_id = %L', pg_temp.id('fac1')), false, 'query');
select pg_temp.outreach_case('4b the organiser sees none of the hospital''s campaigns', 'none',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  $s$select name from outreach.campaigns where facility_id = '0e000000-0000-4000-8000-000000000002'$s$, false, 'query');
select pg_temp.outreach_case('4c the organiser claiming the hospital as session facility sees nothing', 'none',
  pg_temp.subject_of('acct1'), '0e000000-0000-4000-8000-000000000002', pg_temp.id('mem1'),
  'select name from outreach.campaigns', false, 'query');
select pg_temp.outreach_case('4d the organiser sees their own registration', 'Funke Example',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  format('select full_name from outreach.registration_cases where id = %L', pg_temp.id('case1')), false, 'query');
select pg_temp.os_case('4e the group never appears in the clinician directory', 'false', 'pgrun', null, null, null, null,
  format('select identity.share_provider_eligible(%L)::text', pg_temp.id('mem1')), false, 'query');
select pg_temp.outreach_case('4f outreach-api reads the organiser status', 'reviewed',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'), 'select outreach.organiser_status()', false, 'query');

-- 8. The fence (as the table owner).
select pg_temp.owner_case('5a a doctor role at a group is refused', 'P0001: OUTREACH_GROUP_ROLE_INVALID',
  format($s$insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values (gen_random_uuid(), %L, 'doctor', 'facility', %L, %L, 'Synthetic forbidden grant')$s$,
    pg_temp.id('acct1'), pg_temp.id('mem1'), pg_temp.id('fac1')));
select pg_temp.owner_case('5b outreach_organiser at a hospital is refused', 'P0001: OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP',
  $s$insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values (gen_random_uuid(), '0e010000-0000-4000-8000-000000000001', 'outreach_organiser', 'facility',
      '0e030000-0000-4000-8000-000000000001', '0e000000-0000-4000-8000-000000000002', 'Synthetic forbidden grant')$s$);
select pg_temp.owner_case('5c an outreach role at platform scope is refused', 'P0001: OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP',
  $s$insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values (gen_random_uuid(), '0e010000-0000-4000-8000-000000000003', 'outreach_volunteer', 'platform', 'Synthetic forbidden grant')$s$);
select pg_temp.owner_case('5d turning the organiser''s role into a doctor role is refused', 'P0001: OUTREACH_GROUP_ROLE_INVALID',
  format($s$update auth.account_roles set role_code = 'doctor' where membership_id = %L$s$, pg_temp.id('mem1')));

-- 9. The same login: a hospital nurse starts their own group.
create function pg_temp.start_for_account(group_name text) returns text language sql as $$
  select format($s$select result || case when organization_id is not null then ' true' else '' end
      from identity.activate_outreach_organiser_for_account(%L, 'individual', null, '2026-11-01', %L,
        decode(repeat('cd', 32), 'hex'), 'k1')$s$, group_name, pg_temp.hex('phone-nurse')) $$;
select pg_temp.staff_case('6a a hospital nurse starts an outreach group with the same login', 'started true',
  'synthetic:os-nurse', pg_temp.start_for_account('Bisi Community Checks'));
insert into os_ids select 'fac2', organisation.facility_id from identity.outreach_organisations organisation
 where organisation.organiser_account_id = '0e010000-0000-4000-8000-000000000002';
insert into os_ids select 'mem2', membership.id from identity.staff_facility_memberships membership
 where membership.account_id = '0e010000-0000-4000-8000-000000000002' and membership.facility_id = pg_temp.id('fac2')::uuid;
select pg_temp.staff_case('6b again: already an organiser', 'already_organiser true', 'synthetic:os-nurse',
  pg_temp.start_for_account('Another Group'), false);
select pg_temp.os_case('6c the nurse keeps the hospital role and gains the outreach role', 'nurse,outreach_organiser',
  'pgrun', null, null, null, null,
  $s$select string_agg(role_code, ',' order by role_code) from auth.account_roles
      where account_id = '0e010000-0000-4000-8000-000000000002' and revoked_at is null$s$, false, 'query');
select pg_temp.owner_case('6d a nurse role at the nurse''s own group is refused', 'P0001: OUTREACH_GROUP_ROLE_INVALID',
  format($s$insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values (gen_random_uuid(), '0e010000-0000-4000-8000-000000000002', 'nurse', 'facility', %L, %L, 'Synthetic forbidden grant')$s$,
    pg_temp.id('mem2'), pg_temp.id('fac2')));
select pg_temp.staff_case('6e a support (platform) login is not eligible', 'not_eligible', 'synthetic:os-support',
  pg_temp.start_for_account('Support Group'), false);
select pg_temp.staff_case('6f an account without a staff record is not eligible', 'not_eligible', 'synthetic:os-patient',
  pg_temp.start_for_account('Patient Group'), false);
select pg_temp.staff_case('6g a hospital-sounding name is refused here too', 'name_not_allowed', 'synthetic:os-doctor',
  pg_temp.start_for_account('Federal Medical Outreach'), false);
select pg_temp.auth_case('6h the public sign-up still refuses the nurse''s email', 'email_registered',
  pg_temp.start_signup('8', 'os-nurse@example.invalid', 'Nurse Group Two'), false);

-- 10. Outreach invitations.
create function pg_temp.invite(invitation_label text, name text, email text) returns text language sql as $$
  select format('select result from identity.create_outreach_invitation(%L, %L, %L, %L)', pg_temp.id(invitation_label),
    name, email, pg_temp.hex('link-' || invitation_label)) $$;
create function pg_temp.organiser1(case_name text, expected text, statement text, keep boolean default true)
returns void language sql as $$
  select pg_temp.staff_case(case_name, expected, pg_temp.subject_of('acct1'), statement, keep, 'query',
    pg_temp.id('fac1'), pg_temp.id('mem1')) $$;
insert into os_ids values ('inv1', gen_random_uuid()), ('inv2', gen_random_uuid()), ('inv3', gen_random_uuid());
select pg_temp.organiser1('7a the organiser invites a new helper', 'created',
  pg_temp.invite('inv1', 'Gift Helper', 'Gift.Helper@example.invalid'));
select pg_temp.organiser1('7b the same email again', 'already_invited',
  pg_temp.invite('inv3', 'Gift Helper', 'gift.helper@example.invalid'), false);
select pg_temp.auth_case('7c a wrong link token shows nothing', 'invalid',
  format('select result from identity.preview_outreach_invitation(%L, %L)', pg_temp.id('inv1'), pg_temp.hex('wrong')));
select pg_temp.auth_case('7d the link shows the group to a new helper', 'ready Lagos Island Health Volunteers new',
  format($s$select result || ' ' || group_name || ' ' || account_case from identity.preview_outreach_invitation(%L, %L)$s$,
    pg_temp.id('inv1'), pg_temp.hex('link-inv1')));
select pg_temp.auth_case('7e the helper sets a password and joins', 'rows 2',
  format($s$insert into pg_temp.os_ids (label, id)
    select unnest(array['acct3', 'mem3']), unnest(array[account_id, membership_id])
      from identity.accept_outreach_invitation_with_password(%L, %L, %L) where result = 'ready'$s$,
    pg_temp.id('inv1'), pg_temp.hex('link-inv1'), pg_temp.password_hash()), true, 'count');
select pg_temp.auth_case('7f the link cannot be used twice', 'used',
  format('select result from identity.accept_outreach_invitation_with_password(%L, %L, %L)',
    pg_temp.id('inv1'), pg_temp.hex('link-inv1'), pg_temp.password_hash()), false);
select pg_temp.os_case('7g the helper holds outreach_volunteer only', 'outreach_volunteer', 'pgrun', null, null, null, null,
  format('select string_agg(role_code, %L) from auth.account_roles where account_id = %L and revoked_at is null', ',',
    pg_temp.id('acct3')), false, 'query');
select pg_temp.staff_case('7h a helper cannot invite', '42501: OUTREACH_ORGANISER_PERMISSION_DENIED',
  pg_temp.subject_of('acct3'), pg_temp.invite('inv3', 'Someone Else', 'someone@example.invalid'), false, 'query',
  pg_temp.id('fac1'), pg_temp.id('mem3'));
-- A helper registers into a campaign they are a member of (0125's member-lock
-- policy lets their FOR SHARE through) but cannot create or change campaigns.
select pg_temp.outreach_case('7p the organiser adds the helper to the campaign', 'ok',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'),
  format($s$insert into outreach.campaign_members (campaign_id, facility_id, membership_id, role, added_by_account_id,
      added_by_membership_id) values (%L, %L, %L, 'enumerator', %L, %L)$s$,
    pg_temp.id('camp1'), pg_temp.id('fac1'), pg_temp.id('mem3'), pg_temp.id('acct1'), pg_temp.id('mem1')), true);
insert into os_ids values ('case3', gen_random_uuid());
select pg_temp.outreach_case('7q the helper registers a person with consent', 'ok',
  pg_temp.subject_of('acct3'), pg_temp.id('fac1'), pg_temp.id('mem3'),
  replace(replace(pg_temp.registration(pg_temp.id('case3'), pg_temp.id('camp1'), 40, null), pg_temp.id('acct1'), pg_temp.id('acct3')),
    pg_temp.id('mem1'), pg_temp.id('mem3')) || '; '
  || replace(replace(pg_temp.consent(pg_temp.id('case3'), 'self_ticked', null), pg_temp.id('acct1'), pg_temp.id('acct3')),
    pg_temp.id('mem1'), pg_temp.id('mem3')) || '; set constraints outreach.outreach_registration_consent_required immediate; set constraints outreach.outreach_registration_consent_required deferred');
select pg_temp.outreach_case('7r the helper cannot create a campaign',
  '42501: new row violates row-level security policy for table "campaigns"',
  pg_temp.subject_of('acct3'), pg_temp.id('fac1'), pg_temp.id('mem3'),
  format($s$insert into outreach.campaigns (facility_id, created_by_account_id, created_by_membership_id, name, services,
      starts_at) values (%L, %L, %L, 'Helper Campaign', array['registration']::text[], clock_timestamp())$s$,
    pg_temp.id('fac1'), pg_temp.id('acct3'), pg_temp.id('mem3')));
select pg_temp.outreach_case('7s the helper cannot close the campaign', '42501: Outreach campaign admin is required',
  pg_temp.subject_of('acct3'), pg_temp.id('fac1'), pg_temp.id('mem3'),
  format($s$update outreach.campaigns set status = 'closed', row_version = row_version + 1 where id = %L$s$, pg_temp.id('camp1')));
select pg_temp.organiser1('7i the organiser invites the hospital doctor', 'created',
  pg_temp.invite('inv2', 'Ada Doctor', 'os-doctor@example.invalid'));
select pg_temp.auth_case('7j a password cannot be set for an email that has a login', 'sign_in_required',
  format('select result from identity.accept_outreach_invitation_with_password(%L, %L, %L)',
    pg_temp.id('inv2'), pg_temp.hex('link-inv2'), pg_temp.password_hash()), false);
select pg_temp.staff_case('7k another login cannot accept it', 'email_mismatch', 'synthetic:os-nurse',
  format('select result from identity.accept_outreach_invitation_for_account(%L, %L)', pg_temp.id('inv2'),
    pg_temp.hex('link-inv2')), false);
select pg_temp.staff_case('7l the doctor accepts with the same login', 'ready', 'synthetic:os-doctor',
  format('select result from identity.accept_outreach_invitation_for_account(%L, %L)', pg_temp.id('inv2'),
    pg_temp.hex('link-inv2')));
select pg_temp.os_case('7m the doctor keeps the hospital role and helps the group', 'doctor,outreach_volunteer',
  'pgrun', null, null, null, null,
  $s$select string_agg(role_code, ',' order by role_code) from auth.account_roles
      where account_id = '0e010000-0000-4000-8000-000000000001' and revoked_at is null$s$, false, 'query');
select pg_temp.organiser1('7n the team panel', 'invitation:0 member:3',
  $s$select string_agg(entry_kind || ':' || n, ' ' order by entry_kind) from (
      select entry_kind, count(*) as n from identity.list_outreach_team() group by entry_kind
      union all select 'invitation', 0 where not exists (select 1 from identity.list_outreach_team() where entry_kind = 'invitation')) t$s$,
  false);
select pg_temp.organiser1('7o 50 pending invitations is the most (an abuse guard)', 'too_many_pending',
  $s$select (select count(*) from (select identity.create_outreach_invitation(gen_random_uuid(), 'Helper Number',
        'helper' || n || '@example.invalid', encode(sha256(convert_to('cap' || n, 'UTF8')), 'hex')) from generate_series(1, 50) n) made)::text
      || (select result from identity.create_outreach_invitation(gen_random_uuid(), 'One Too Many', 'toomany@example.invalid',
        encode(sha256(convert_to('cap-over', 'UTF8')), 'hex')))$s$, false);
update os_cases set actual = regexp_replace(actual, '^50', '') where name = '7o 50 pending invitations is the most (an abuse guard)';

-- 11. Support's campaign rescue (the nurse's group, not yet reviewed).
insert into os_ids values ('camp2', gen_random_uuid());
select pg_temp.outreach_case('8a the nurse creates a campaign in their group', 'ok',
  'synthetic:os-nurse', pg_temp.id('fac2'), pg_temp.id('mem2'),
  format($s$insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services,
      starts_at) values (%L, %L, '0e010000-0000-4000-8000-000000000002', %L, 'Church Hall Day', array['registration']::text[],
      clock_timestamp())$s$, pg_temp.id('camp2'), pg_temp.id('fac2'), pg_temp.id('mem2')), true);
select pg_temp.staff_case('8b support appoints the nurse admin of the campaign', 'appointed', 'synthetic:os-support',
  format($s$select identity.admin_appoint_outreach_campaign_admin(%L, %L, 'Only admin left the group')$s$,
    pg_temp.id('camp2'), pg_temp.id('mem2')));
select pg_temp.staff_case('8c a membership of another group cannot be appointed', '23514: OUTREACH_CAMPAIGN_ADMIN_NOT_ELIGIBLE',
  'synthetic:os-support', format($s$select identity.admin_appoint_outreach_campaign_admin(%L, %L, 'Wrong group member')$s$,
    pg_temp.id('camp2'), pg_temp.id('mem1')), false);
select pg_temp.staff_case('8d support closes the campaign', 'closed', 'synthetic:os-support',
  format($s$select identity.admin_close_outreach_campaign(%L, 1, 'Organiser asked us to close it')$s$, pg_temp.id('camp2')));
select pg_temp.staff_case('8e a hospital campaign is not support''s to close here', 'P0002: OUTREACH_CAMPAIGN_NOT_FOUND',
  'synthetic:os-support', $s$select identity.admin_close_outreach_campaign('0e070000-0000-4000-8000-000000000001', 2,
    'Not an outreach group campaign')$s$, false);
select pg_temp.staff_case('8f a doctor cannot use support''s rescue', '42501: ADMIN_PERMISSION_DENIED', 'synthetic:os-doctor',
  format($s$select identity.admin_close_outreach_campaign(%L, 1, 'Not support at all')$s$, pg_temp.id('camp2')), false);
select pg_temp.os_case('8g no support run is left behind', '0', 'pgrun', null, null, null, null,
  'select count(*)::text from outreach.privileged_runs', false, 'query');

-- 12. Suspension.
select pg_temp.staff_case('9a support suspends the first group', 'suspended 3', 'synthetic:os-support',
  format($s$select review_state || ' ' || revoked_roles from identity.admin_suspend_outreach_organiser(%L, 2,
    'Reported for collecting numbers under a false name')$s$, pg_temp.id('org1')));
select pg_temp.outreach_case('9b the organiser can no longer read or change anything', 'none',
  pg_temp.subject_of('acct1'), pg_temp.id('fac1'), pg_temp.id('mem1'), 'select name from outreach.campaigns', false, 'query');
select pg_temp.owner_case('9c no role can be granted at a suspended group', 'P0001: OUTREACH_ORGANISER_SUSPENDED',
  format($s$insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values (gen_random_uuid(), %L, 'outreach_volunteer', 'facility', %L, %L, 'Synthetic forbidden grant')$s$,
    pg_temp.id('acct3'), pg_temp.id('mem3'), pg_temp.id('fac1')));
select pg_temp.os_case('9d the doctor keeps the hospital role after the group''s suspension', 'doctor',
  'pgrun', null, null, null, null,
  $s$select string_agg(role_code, ',' order by role_code) from auth.account_roles
      where account_id = '0e010000-0000-4000-8000-000000000001' and revoked_at is null$s$, false, 'query');
select pg_temp.staff_case('9e the suspended organiser may start a new group', 'started true', pg_temp.subject_of('acct1'),
  pg_temp.start_for_account('Fresh Start Volunteers'), false);

-- 13. Result.
do $$
declare failed text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, coalesce(actual, 'null')), E'\n' order by seq)
    into failed from pg_temp.os_cases where actual is distinct from expected;
  if failed is not null then
    raise exception E'Outreach organiser sign-up suite failed:\n%', failed;
  end if;
  raise notice 'Outreach organiser sign-up suite: % cases passed', (select count(*) from pg_temp.os_cases);
end $$;

rollback;
