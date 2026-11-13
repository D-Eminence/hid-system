\set ON_ERROR_STOP on
-- Assisted Health ID at an outreach (0119): the registration a volunteer may
-- use, the email codes (daily cap, cooldown, attempts, expiry), creating the
-- account and patient (no password, email verified, no date of birth), the
-- registration's Health ID record, replay, email and phone already on a Health
-- ID, under 18, no phone, redaction, suspension, the sealed demo, campaign
-- membership and another facility, and the privileges of every new object.
-- Rollback-only. Fictional people and places only; ids start 6c0.
begin;

do $$
declare
  command text;
begin
  foreach command in array array['identity.outreach_health_id_registration(uuid)',
      'identity.outreach_health_id_start(uuid,uuid,text,char,bytea,char,text,char,text,integer,integer)',
      'identity.outreach_health_id_delivery_failed(uuid)', 'identity.outreach_health_id_open_challenge(uuid)',
      'identity.outreach_health_id_confirm(uuid,uuid,char,text,text,bytea,char)'] loop
    if not has_function_privilege('hid_identity_api_runtime', command, 'EXECUTE')
       or has_function_privilege('hid_outreach_api_runtime', command, 'EXECUTE')
       or not exists (select 1 from pg_proc where oid = command::regprocedure and prosecdef
                       and proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[]) then
      raise exception '% must be SECURITY DEFINER, pinned, for the Identity runtime only', command;
    end if;
  end loop;
  if not has_function_privilege('hid_outreach_api_runtime', 'identity.outreach_registration_health_ids_for(uuid[])', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'identity.outreach_health_id_eligible(uuid)', 'EXECUTE')
     or has_table_privilege('hid_identity_api_runtime', 'identity.outreach_health_id_challenges', 'SELECT')
     or has_table_privilege('hid_outreach_api_runtime', 'identity.outreach_registration_health_ids', 'SELECT')
     or exists (select 1 from pg_class where oid in ('identity.outreach_health_id_challenges'::regclass,
                 'identity.outreach_registration_health_ids'::regclass) and not (relrowsecurity and relforcerowsecurity)) then
    raise exception 'the 0119 privileges are not as written';
  end if;
end $$;

-- Fixtures. Outreach group G (6c00...02, active) with organiser O (n=1);
-- hospital H (6c00...12) with doctor D (n=2); support S (n=3).
-- Campaigns at G: 1 closed 400 days ago; 2 closed 10 days ago; 3 active,
-- started 400 days ago; 4 closed before 0116 (no closed_at), last changed 400
-- days ago; 5 active, started yesterday. Campaign 6 at H closed 400 days ago.
-- One unlinked registration in each (cases 1-6), with a guardian's name and
-- an idempotency record.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('6c000000-0000-4000-8000-000000000001', 'Health ID Test Group', 'healthid-test-group'),
  ('6c000000-0000-4000-8000-000000000011', 'Health ID Test Hospital Group', 'healthid-test-hospital-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('6c000000-0000-4000-8000-000000000002', '6c000000-0000-4000-8000-000000000001', 'Health ID Test Group',
   'HEALTHID-G', 'Africa/Lagos', true, 'verified'),
  ('6c000000-0000-4000-8000-000000000012', '6c000000-0000-4000-8000-000000000011', 'Health ID Test Hospital',
   'HEALTHID-H', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('6c010000-0000-4000-8000-000000000001', 'synthetic:hi-organiser', 'hi-organiser@example.invalid', 'Ife Organiser', 'active'),
  ('6c010000-0000-4000-8000-000000000002', 'synthetic:hi-doctor', 'hi-doctor@example.invalid', 'Jide Doctor', 'active'),
  ('6c010000-0000-4000-8000-000000000003', 'synthetic:hi-support', 'hi-support@example.invalid', 'Kunle Support', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('6c020000-0000-4000-8000-000000000001', '6c010000-0000-4000-8000-000000000001', 'Ife Organiser', 'hi-organiser@example.invalid', 'verified', 'outreach_organiser'),
  ('6c020000-0000-4000-8000-000000000002', '6c010000-0000-4000-8000-000000000002', 'Jide Doctor', 'hi-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('6c030000-0000-4000-8000-000000000001', '6c020000-0000-4000-8000-000000000001', '6c010000-0000-4000-8000-000000000001',
   '6c000000-0000-4000-8000-000000000001', '6c000000-0000-4000-8000-000000000002', 'outreach_organiser', 'outreach_organiser', true, true),
  ('6c030000-0000-4000-8000-000000000002', '6c020000-0000-4000-8000-000000000002', '6c010000-0000-4000-8000-000000000002',
   '6c000000-0000-4000-8000-000000000011', '6c000000-0000-4000-8000-000000000012', 'doctor', 'doctor', true, true);
insert into identity.outreach_organisations (organization_id, facility_id, kind, display_name, organiser_account_id,
  contact_phone_lookup_hmac, contact_phone_ciphertext, contact_key_version, origin, terms_version, terms_accepted_at,
  status) values
  ('6c000000-0000-4000-8000-000000000001', '6c000000-0000-4000-8000-000000000002', 'group', 'Health ID Test Group',
   '6c010000-0000-4000-8000-000000000001', repeat('a', 64), decode(repeat('ab', 32), 'hex'), 'k1', 'existing_account',
   '2026-11-01', clock_timestamp(), 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  (gen_random_uuid(), '6c010000-0000-4000-8000-000000000001', 'outreach_organiser', 'facility',
   '6c030000-0000-4000-8000-000000000001', '6c000000-0000-4000-8000-000000000002', 'Synthetic retention suite role'),
  (gen_random_uuid(), '6c010000-0000-4000-8000-000000000002', 'doctor', 'facility',
   '6c030000-0000-4000-8000-000000000002', '6c000000-0000-4000-8000-000000000012', 'Synthetic retention suite role'),
  (gen_random_uuid(), '6c010000-0000-4000-8000-000000000003', 'platform_admin', 'platform', null, null,
   'Synthetic retention suite support role');
-- Invitations of G never accepted: cancelled 40 days ago, expired 40 days
-- ago (left pending, and marked expired), expired 5 days ago, and one still
-- waiting.
insert into identity.outreach_invitations (id, organization_id, facility_id, invited_by_account_id,
  invited_by_membership_id, invitee_name, invitee_email, status, link_token_hmac, expires_at, revoked_at,
  revoked_by_account_id, created_at)
select ('6c090000-0000-4000-8000-00000000000' || n)::uuid, '6c000000-0000-4000-8000-000000000001',
  '6c000000-0000-4000-8000-000000000002', '6c010000-0000-4000-8000-000000000001',
  '6c030000-0000-4000-8000-000000000001', 'Invitee Person ' || n, 'invitee' || n || '@example.invalid', status,
  repeat(n::text, 64), now() + expires, revoked, case when revoked is not null then '6c010000-0000-4000-8000-000000000001'::uuid end,
  now() + expires - interval '7 days'
from (values (1, 'revoked', interval '-40 days', now() - interval '40 days'),
             (2, 'pending', interval '-40 days', null::timestamptz),
             (3, 'expired', interval '-40 days', null),
             (4, 'expired', interval '-5 days', null),
             (5, 'pending', interval '5 days', null)) v(n, status, expires, revoked);
create temporary table hi_campaigns (n integer primary key, facility uuid, member uuid, account uuid, status text,
  starts_at timestamptz, updated_at timestamptz, closed_at timestamptz) on commit drop;
insert into hi_campaigns values
  (1, '6c000000-0000-4000-8000-000000000002', '6c030000-0000-4000-8000-000000000001', '6c010000-0000-4000-8000-000000000001',
   'closed', now() - interval '500 days', now() - interval '400 days', now() - interval '400 days'),
  (2, '6c000000-0000-4000-8000-000000000002', '6c030000-0000-4000-8000-000000000001', '6c010000-0000-4000-8000-000000000001',
   'closed', now() - interval '500 days', now() - interval '10 days', now() - interval '10 days'),
  (3, '6c000000-0000-4000-8000-000000000002', '6c030000-0000-4000-8000-000000000001', '6c010000-0000-4000-8000-000000000001',
   'active', now() - interval '400 days', now() - interval '400 days', null),
  (4, '6c000000-0000-4000-8000-000000000002', '6c030000-0000-4000-8000-000000000001', '6c010000-0000-4000-8000-000000000001',
   'closed', now() - interval '500 days', now() - interval '400 days', null),
  (5, '6c000000-0000-4000-8000-000000000002', '6c030000-0000-4000-8000-000000000001', '6c010000-0000-4000-8000-000000000001',
   'active', now() - interval '1 day', now() - interval '1 day', null),
  (6, '6c000000-0000-4000-8000-000000000012', '6c030000-0000-4000-8000-000000000002', '6c010000-0000-4000-8000-000000000002',
   'closed', now() - interval '500 days', now() - interval '400 days', now() - interval '400 days');
insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services, status,
  starts_at, updated_at, closed_at)
select ('6c070000-0000-4000-8000-00000000000' || n)::uuid, facility, account, member, 'Health ID Campaign ' || n,
  array['registration']::text[], status, starts_at, updated_at, closed_at from hi_campaigns;
insert into outreach.campaign_members (campaign_id, facility_id, membership_id, role, added_by_account_id, added_by_membership_id)
select ('6c070000-0000-4000-8000-00000000000' || n)::uuid, facility, member, 'admin', account, member from hi_campaigns;
insert into outreach.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, local_command_id,
  temporary_patient_id, full_name, sex, age_years, phone, operational_notes, campaign_id, created_at)
select ('6c080000-0000-4000-8000-00000000000' || n)::uuid, facility, account, member, gen_random_uuid(),
  'tmp_' || gen_random_uuid(), 'Lola Person ' || n, 'female', 15, '+234800000000' || n, 'Checked blood pressure',
  ('6c070000-0000-4000-8000-00000000000' || n)::uuid, starts_at + interval '1 hour' from hi_campaigns;
insert into outreach.registration_consents (registration_case_id, facility_id, consent_text_version, language, method,
  guardian_name, captured_by_account_id, captured_by_membership_id)
select ('6c080000-0000-4000-8000-00000000000' || n)::uuid, facility, 'notice-2026-11-01', 'ha', 'guardian',
  'Mama Person ' || n, account, member from hi_campaigns;
insert into outreach.command_idempotency (requester_account_id, requester_membership_id, facility_id, operation,
  idempotency_key, request_sha256, registration_case_id)
select account, member, facility, 'registration_case_create', 'healthid-key-' || n, repeat('f', 64),
  ('6c080000-0000-4000-8000-00000000000' || n)::uuid from hi_campaigns;
-- Volunteer V (n=4) at G, an outreach volunteer who is in no campaign.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('6c010000-0000-4000-8000-000000000004', 'synthetic:hi-volunteer', 'hi-volunteer@example.invalid', 'Lara Volunteer', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('6c020000-0000-4000-8000-000000000004', '6c010000-0000-4000-8000-000000000004', 'Lara Volunteer',
   'hi-volunteer@example.invalid', 'verified', 'outreach_volunteer');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('6c030000-0000-4000-8000-000000000004', '6c020000-0000-4000-8000-000000000004', '6c010000-0000-4000-8000-000000000004',
   '6c000000-0000-4000-8000-000000000001', '6c000000-0000-4000-8000-000000000002', 'outreach_volunteer',
   'outreach_volunteer', false, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  (gen_random_uuid(), '6c010000-0000-4000-8000-000000000004', 'outreach_volunteer', 'facility',
   '6c030000-0000-4000-8000-000000000004', '6c000000-0000-4000-8000-000000000002', 'Synthetic screening suite role');
-- Adults on registrations 3 and 5 (registration 1, aged 15, stays a child);
-- registration 3 shares registration 5's phone for the duplicate check.
update outreach.registration_cases set age_years = 40 where id in ('6c080000-0000-4000-8000-000000000003',
  '6c080000-0000-4000-8000-000000000005', '6c080000-0000-4000-8000-000000000002');
update outreach.registration_cases set phone = '+2348000000005' where id = '6c080000-0000-4000-8000-000000000003';
set local session_replication_role = origin;

create temporary table hi_cases (seq serial, name text primary key, expected text not null, actual text) on commit drop;
grant select, insert on hi_cases to public;
grant usage on sequence hi_cases_seq_seq to public;

create function pg_temp.hi_try(run_role text, subject text, facility text, membership text, purpose text,
  statement text, keep boolean, kind text) returns text language plpgsql as $$
declare outcome text; affected bigint;
begin
  perform set_config('app.actor_subject', coalesce(subject, ''), true),
          set_config('app.facility_id', coalesce(facility, ''), true),
          set_config('app.membership_id', coalesce(membership, ''), true),
          set_config('app.correlation_id', 'outreach-health-id-suite', true),
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
    if not keep then raise exception using errcode = 'P0001', message = 'outreach-health-id-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'outreach-health-id-suite: undo' then outcome := sqlstate || ': ' || sqlerrm; end if;
  end;
  reset role;
  return outcome;
end $$;
create function pg_temp.hi_case(case_name text, expected text, run_role text, subject text, facility text,
  membership text, purpose text, statement text, keep boolean default false, kind text default 'query')
returns void language plpgsql as $$
begin
  insert into pg_temp.hi_cases (name, expected, actual)
  values (case_name, expected, pg_temp.hi_try(run_role, subject, facility, membership, purpose, statement, keep, kind));
end $$;
create function pg_temp.sweeper(case_name text, expected text, statement text, keep boolean default true)
returns void language sql as $$
  select pg_temp.hi_case(case_name, expected, 'hid_identity_api_runtime', 'system:auth', null, null, null, statement, keep) $$;
create function pg_temp.support(case_name text, expected text, subject text, statement text, keep boolean default true)
returns void language sql as $$
  select pg_temp.hi_case(case_name, expected, 'hid_identity_api_runtime', subject, null, null, 'healthcare-operations',
    statement, keep) $$;
create function pg_temp.organiser(case_name text, expected text, statement text, keep boolean default false,
  kind text default 'query') returns void language sql as $$
  select pg_temp.hi_case(case_name, expected, 'hid_outreach_api_runtime', 'synthetic:hi-organiser',
    '6c000000-0000-4000-8000-000000000002', '6c030000-0000-4000-8000-000000000001', 'direct-care', statement, keep, kind) $$;
-- What a registration looks like now (read as the superuser).
create function pg_temp.state(n integer) returns text language sql stable as $$
  select case_row.full_name || '/' || coalesce(case_row.phone, '-') || '/' || coalesce(case_row.operational_notes, '-')
      || '/' || case_row.sex || '/' || case_row.age_years || '/' || consent.guardian_name || '/'
      || left(command.request_sha256, 4)
    from outreach.registration_cases case_row
    join outreach.registration_consents consent on consent.registration_case_id = case_row.id
    join outreach.command_idempotency command on command.registration_case_id = case_row.id
   where case_row.id = ('6c080000-0000-4000-8000-00000000000' || n)::uuid $$;



create function pg_temp.idrt(case_name text, expected text, statement text, keep boolean default false,
  kind text default 'query', subject text default 'synthetic:hi-organiser',
  membership text default '6c030000-0000-4000-8000-000000000001',
  facility text default '6c000000-0000-4000-8000-000000000002') returns void language sql as $$
  select pg_temp.hi_case(case_name, expected, 'hid_identity_api_runtime', subject, facility, membership, 'direct-care',
    statement, keep, kind) $$;
create function pg_temp.start_sql(n integer, challenge text, email text, phone_hmac text, max_attempts integer default 5)
returns text language sql as $$
  select format($i$select challenge_id::text from identity.outreach_health_id_start('6c080000-0000-4000-8000-00000000000%s',
    %L, %L, %L, decode(repeat('ab', 40), 'hex'), %L, 'contact-v1', repeat('e', 64), 'otp-v1', 600, %s)$i$,
    n, challenge, email, encode(sha256(convert_to(lower(email), 'utf8')), 'hex'), phone_hmac, max_attempts) $$;
create function pg_temp.confirm_sql(n integer, challenge text, verifier text, email text, hid text, phone_hmac text)
returns text language sql as $$
  select format($i$select concat_ws('/', outcome, hid_code) from identity.outreach_health_id_confirm(
    '6c080000-0000-4000-8000-00000000000%s', %L, %L, %L, %L, decode(repeat('cd', 40), 'hex'), %L)$i$,
    n, challenge, verifier, email, hid, phone_hmac) $$;
grant execute on function pg_temp.start_sql(integer, text, text, text, integer),
  pg_temp.confirm_sql(integer, text, text, text, text, text) to public;

-- 1. The registration the volunteer may use.
select pg_temp.idrt('1a the organiser reads registration 5', 'Lola Person 5/female/40/+2348000000005/Health ID Test Group',
  $s$select concat_ws('/', full_name, sex, age_years, phone, group_name) from identity.outreach_health_id_registration(
    '6c080000-0000-4000-8000-000000000005')$s$);
select pg_temp.idrt('1b a volunteer in no campaign cannot', '42501: OUTREACH_REGISTRATION_NOT_FOUND',
  $s$select full_name from identity.outreach_health_id_registration('6c080000-0000-4000-8000-000000000005')$s$,
  false, 'query', 'synthetic:hi-volunteer', '6c030000-0000-4000-8000-000000000004');
select pg_temp.idrt('1c a hospital''s registration is not an outreach group''s', 'P0002: refused',
  $s$do $x$ begin perform identity.outreach_health_id_registration('6c080000-0000-4000-8000-000000000006');
     exception when insufficient_privilege then raise exception using errcode = 'P0002', message = 'refused'; end $x$$s$,
  false, 'statement', 'synthetic:hi-doctor', '6c030000-0000-4000-8000-000000000002', '6c000000-0000-4000-8000-000000000012');
select pg_temp.idrt('1d under 18 is refused', '23514: OUTREACH_HEALTH_ID_UNDER_18',
  pg_temp.start_sql(1, '6c0a0000-0000-4000-8000-000000000001', 'child@example.invalid', repeat('1', 64)));

-- 2. Codes.
select pg_temp.idrt('2a a code for registration 5', '6c0a0000-0000-4000-8000-000000000005',
  pg_temp.start_sql(5, '6c0a0000-0000-4000-8000-000000000005', 'Lola.Person5@Example.invalid', repeat('5', 64)), true);
select pg_temp.idrt('2b another within 60 seconds is refused', 'P0001: OUTREACH_HEALTH_ID_TOO_MANY_CODES',
  pg_temp.start_sql(5, '6c0a0000-0000-4000-8000-000000000015', 'lola.person5@example.invalid', repeat('5', 64)));
select pg_temp.idrt('2c the open code', '6c0a0000-0000-4000-8000-000000000005/otp-v1/contact-v1',
  $s$select concat_ws('/', challenge_id, verifier_key_version, key_version) from identity.outreach_health_id_open_challenge(
    '6c080000-0000-4000-8000-000000000005')$s$);
select pg_temp.idrt('2d a wrong code counts', 'invalid',
  pg_temp.confirm_sql(5, '6c0a0000-0000-4000-8000-000000000005', repeat('0', 64), 'lola.person5@example.invalid',
    'HID-RTE6C5', repeat('5', 64)), true);
select pg_temp.hi_case('2e the failure is kept', '1', session_user::text, null, null, null, null,
  $s$select failed_attempts::text from identity.outreach_health_id_challenges where id = '6c0a0000-0000-4000-8000-000000000005'$s$);

-- 3. The Health ID.
select pg_temp.idrt('3a the right code creates it', 'created/HID-RTE6C5',
  pg_temp.confirm_sql(5, '6c0a0000-0000-4000-8000-000000000005', repeat('e', 64), 'lola.person5@example.invalid',
    'HID-RTE6C5', repeat('5', 64)), true);
select pg_temp.hi_case('3b the account: no password, pending reset, email verified', 'pending_reset/lola.person5@example.invalid/t/t',
  session_user::text, null, null, null, null,
  $s$select concat_ws('/', account.status, account.email, account.password_hash is null, account.email_verified_at is not null)
       from auth.accounts account join identity.patients patient on patient.account_id = account.id
      where patient.hid_code = 'HID-RTE6C5'$s$);
select pg_temp.hi_case('3c the patient: the registration''s name and sex, no date of birth, the contacts', 'Lola/Person 5/female/t/t/t/CONTACT_VERIFIED',
  session_user::text, null, null, null, null,
  $s$select concat_ws('/', patient.first_name, patient.last_name, patient.gender, patient.dob is null,
          patient.phone_lookup_hmac = repeat('5', 64), patient.email_lookup_hmac is not null, assurance.state)
       from identity.patients patient join identity.patient_assurance_states assurance on assurance.patient_id = patient.id
      where patient.hid_code = 'HID-RTE6C5'$s$);
select pg_temp.idrt('3d a replay answers the same Health ID', 'replayed/HID-RTE6C5',
  pg_temp.confirm_sql(5, '6c0a0000-0000-4000-8000-000000000005', repeat('e', 64), 'lola.person5@example.invalid',
    'HID-RTE6C5', repeat('5', 64)));
select pg_temp.idrt('3e a new code for it: already created', '23505: OUTREACH_HEALTH_ID_ALREADY_CREATED',
  pg_temp.start_sql(5, '6c0a0000-0000-4000-8000-000000000025', 'other@example.invalid', repeat('5', 64)));
select pg_temp.idrt('3f the registration read shows it', 'HID-RTE6C5',
  $s$select existing_hid_code from identity.outreach_health_id_registration('6c080000-0000-4000-8000-000000000005')$s$);
select pg_temp.hi_case('3g outreach-api sees it for a registration it can see', '6c080000-0000-4000-8000-000000000005=HID-RTE6C5',
  'hid_outreach_api_runtime', 'synthetic:hi-organiser', '6c000000-0000-4000-8000-000000000002',
  '6c030000-0000-4000-8000-000000000001', 'direct-care',
  $s$select registration_case_id || '=' || hid_code from identity.outreach_registration_health_ids_for(
    array['6c080000-0000-4000-8000-000000000005', '6c080000-0000-4000-8000-000000000003']::uuid[])$s$);
select pg_temp.hi_case('3h a volunteer in no campaign does not', 'none', 'hid_outreach_api_runtime', 'synthetic:hi-volunteer',
  '6c000000-0000-4000-8000-000000000002', '6c030000-0000-4000-8000-000000000004', 'direct-care',
  $s$select hid_code from identity.outreach_registration_health_ids_for(array['6c080000-0000-4000-8000-000000000005']::uuid[])$s$);
select pg_temp.hi_case('3i the record never changes', '55000: OUTREACH_HEALTH_ID_RECORD_IMMUTABLE', session_user::text,
  null, null, null, null,
  $s$update identity.outreach_registration_health_ids set hid_code = 'HID-XTHER2' where hid_code = 'HID-RTE6C5'$s$,
  false, 'statement');
select pg_temp.hi_case('3j audit rows carry ids and counts only', '2/0', session_user::text, null, null, null, null,
  $s$select (select count(*) from audit.events where action in ('outreach.health-id.code-sent', 'outreach.health-id.created')
              and resource_id = '6c080000-0000-4000-8000-000000000005')::text || '/'
         || (select count(*) from audit.events where action like 'outreach.health-id.%'
              and (details::text ilike '%lola%' or details::text ilike '%example.invalid%' or details::text like '%+234%'))::text$s$);

-- 4. Duplicates: the same email or phone on another registration.
select pg_temp.idrt('4a the email is taken', '23505: OUTREACH_HEALTH_ID_EMAIL_TAKEN',
  pg_temp.start_sql(3, '6c0a0000-0000-4000-8000-000000000003', 'LOLA.person5@example.invalid', repeat('3', 64)));
select pg_temp.idrt('4b the phone is taken', '23505: OUTREACH_HEALTH_ID_PHONE_TAKEN',
  pg_temp.start_sql(3, '6c0a0000-0000-4000-8000-000000000003', 'someone.else@example.invalid', repeat('5', 64)));
select pg_temp.idrt('4c an invalid email', '22023: OUTREACH_HEALTH_ID_EMAIL_INVALID',
  pg_temp.start_sql(3, '6c0a0000-0000-4000-8000-000000000003', 'not-an-email', repeat('3', 64)));

-- 5. Attempts and expiry (registration 3).
select pg_temp.idrt('5a a code allowing one attempt', '6c0a0000-0000-4000-8000-000000000033',
  pg_temp.start_sql(3, '6c0a0000-0000-4000-8000-000000000033', 'ade.three@example.invalid', repeat('3', 64), 1), true);
select pg_temp.idrt('5b one wrong code ends it', 'too_many_tries',
  pg_temp.confirm_sql(3, '6c0a0000-0000-4000-8000-000000000033', repeat('0', 64), 'ade.three@example.invalid',
    'HID-RTE6C3', repeat('3', 64)), true);
select pg_temp.idrt('5c then even the right code is expired', 'expired',
  pg_temp.confirm_sql(3, '6c0a0000-0000-4000-8000-000000000033', repeat('e', 64), 'ade.three@example.invalid',
    'HID-RTE6C3', repeat('3', 64)));
update identity.outreach_health_id_challenges set created_at = created_at - interval '2 minutes'
 where registration_case_id = '6c080000-0000-4000-8000-000000000003';
select pg_temp.idrt('5d a second code (two today)', '6c0a0000-0000-4000-8000-000000000034',
  pg_temp.start_sql(3, '6c0a0000-0000-4000-8000-000000000034', 'ade.three@example.invalid', repeat('3', 64)), true);
update identity.outreach_health_id_challenges set expires_at = clock_timestamp() - interval '1 second',
  created_at = created_at - interval '2 minutes' where id = '6c0a0000-0000-4000-8000-000000000034';
select pg_temp.idrt('5e an expired code', 'expired',
  pg_temp.confirm_sql(3, '6c0a0000-0000-4000-8000-000000000034', repeat('e', 64), 'ade.three@example.invalid',
    'HID-RTE6C3', repeat('3', 64)));
select pg_temp.idrt('5f a third code', '6c0a0000-0000-4000-8000-000000000035',
  pg_temp.start_sql(3, '6c0a0000-0000-4000-8000-000000000035', 'ade.three@example.invalid', repeat('3', 64)), true);
update identity.outreach_health_id_challenges set created_at = created_at - interval '2 minutes'
 where id = '6c0a0000-0000-4000-8000-000000000035';
select pg_temp.idrt('5g a fourth in 24 hours is refused', 'P0001: OUTREACH_HEALTH_ID_TOO_MANY_CODES',
  pg_temp.start_sql(3, '6c0a0000-0000-4000-8000-000000000036', 'ade.three@example.invalid', repeat('3', 64)));

-- 6. No phone, suspension, the sealed demo, redaction.
select pg_temp.hi_case('6a no phone: the email path still works', 'ok', session_user::text, null, null, null, null,
  format($d$do $x$ begin
    set local session_replication_role = replica;
    update outreach.registration_cases set phone = null where id = '6c080000-0000-4000-8000-000000000002';
    set local session_replication_role = origin;
    perform set_config('app.actor_subject', 'synthetic:hi-organiser', true),
      set_config('app.facility_id', '6c000000-0000-4000-8000-000000000002', true),
      set_config('app.membership_id', '6c030000-0000-4000-8000-000000000001', true),
      set_config('app.purpose_of_use', 'direct-care', true);
    set local role hid_identity_api_runtime;
    %s;
  end $x$$d$, replace(pg_temp.start_sql(2, '6c0a0000-0000-4000-8000-000000000002', 'two@example.invalid', null),
    'select challenge_id::text from', 'perform challenge_id from')), false, 'statement');
select pg_temp.hi_case('6a2 no phone, but a phone hash is sent', '22023: OUTREACH_HEALTH_ID_EMAIL_INVALID', session_user::text, null, null, null, null,
  format($d$do $x$ begin
    set local session_replication_role = replica;
    update outreach.registration_cases set phone = null where id = '6c080000-0000-4000-8000-000000000002';
    set local session_replication_role = origin;
    perform set_config('app.actor_subject', 'synthetic:hi-organiser', true),
      set_config('app.facility_id', '6c000000-0000-4000-8000-000000000002', true),
      set_config('app.membership_id', '6c030000-0000-4000-8000-000000000001', true),
      set_config('app.purpose_of_use', 'direct-care', true);
    set local role hid_identity_api_runtime;
    %s;
  end $x$$d$, replace(pg_temp.start_sql(2, '6c0a0000-0000-4000-8000-000000000002', 'two@example.invalid', repeat('2', 64)),
    'select challenge_id::text from', 'perform challenge_id from')), false, 'statement');
select pg_temp.hi_case('6b a suspended group', '55000: OUTREACH_ORGANISER_SUSPENDED', session_user::text, null, null, null,
  null, $d$do $x$ begin
    update identity.outreach_organisations set status = 'suspended', suspended_at = clock_timestamp(),
      suspended_by_account_id = '6c010000-0000-4000-8000-000000000003', suspension_reason = 'Synthetic suspension for the suite'
     where facility_id = '6c000000-0000-4000-8000-000000000002';
    perform set_config('app.actor_subject', 'synthetic:hi-organiser', true),
      set_config('app.facility_id', '6c000000-0000-4000-8000-000000000002', true),
      set_config('app.membership_id', '6c030000-0000-4000-8000-000000000001', true),
      set_config('app.purpose_of_use', 'direct-care', true);
    set local role hid_identity_api_runtime;
    perform identity.outreach_health_id_registration('6c080000-0000-4000-8000-000000000002');
  end $x$$d$, false, 'statement');
select pg_temp.hi_case('6c a sealed demo group', '42501: OUTREACH_HEALTH_ID_NOT_AVAILABLE', session_user::text, null, null,
  null, null, $d$do $x$ begin
    insert into identity.sealed_demo_members (member_kind, member_id) values ('facility', '6c000000-0000-4000-8000-000000000002');
    perform set_config('app.actor_subject', 'synthetic:hi-organiser', true),
      set_config('app.facility_id', '6c000000-0000-4000-8000-000000000002', true),
      set_config('app.membership_id', '6c030000-0000-4000-8000-000000000001', true),
      set_config('app.purpose_of_use', 'direct-care', true);
    set local role hid_identity_api_runtime;
    perform identity.outreach_health_id_registration('6c080000-0000-4000-8000-000000000002');
  end $x$$d$, false, 'statement');
select pg_temp.support('6d support redacts registration 2', 'redacted', 'synthetic:hi-support',
  $s$select identity.admin_redact_outreach_registration('6c080000-0000-4000-8000-000000000002', 'Caller asked us to delete her details')$s$);
select pg_temp.idrt('6e a redacted registration', '55000: OUTREACH_REGISTRATION_REDACTED',
  $s$select full_name from identity.outreach_health_id_registration('6c080000-0000-4000-8000-000000000002')$s$);

-- 7. Result.
do $$
declare failed text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, coalesce(actual, 'null')), E'\n' order by seq)
    into failed from pg_temp.hi_cases where actual is distinct from expected;
  if failed is not null then
    raise exception E'Outreach Health ID suite failed:\n%', failed;
  end if;
  raise notice 'Outreach Health ID suite: % cases passed', (select count(*) from pg_temp.hi_cases);
end $$;

rollback;
