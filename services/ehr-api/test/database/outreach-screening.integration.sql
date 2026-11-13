\set ON_ERROR_STOP on
-- Outreach screening (0118): one screening per outreach registration, with
-- the registration's row-level security (its facility and its campaign's
-- members only), versioned, range-checked, never deleted by the runtime and
-- deleted when the registration is redacted; the registration's area (set
-- once, cleared on redaction); the outreach-group notes cap at 1000; the
-- organiser terms 2026-11-01 and 2026-11-14. Rollback-only. Fictional people
-- and places only; ids start 5c0.
--
-- Fixtures are inserted with session_replication_role = replica (the
-- retention suite's). Every case runs as the production runtime role under
-- the session that service sets; the suite fails at the end listing every
-- case whose outcome differs.
begin;

do $$
begin
  if to_regclass('outreach.registration_screenings') is null
     or has_table_privilege('hid_outreach_api_runtime', 'outreach.registration_screenings', 'DELETE')
     or not has_table_privilege('hid_outreach_api_runtime', 'outreach.registration_screenings', 'SELECT,INSERT,UPDATE')
     or has_table_privilege('hid_identity_api_runtime', 'outreach.registration_screenings', 'SELECT')
     or has_table_privilege('hid_ehr_api_runtime', 'outreach.registration_screenings', 'SELECT')
     or not exists (select 1 from pg_class where oid = 'outreach.registration_screenings'::regclass
                     and relrowsecurity and relforcerowsecurity)
     or exists (select 1 from pg_roles role_row where role_row.rolname like 'hid\_%'
                 and (has_function_privilege(role_row.oid, 'outreach.validate_registration_screening()', 'EXECUTE')
                      or has_function_privilege(role_row.oid, 'outreach.registration_case_screening_redact()', 'EXECUTE')
                      or has_function_privilege(role_row.oid, 'outreach.registration_case_area_guard()', 'EXECUTE')))
     or not exists (select 1 from pg_proc where oid = 'outreach.validate_registration_screening()'::regprocedure
                     and prosecdef and proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[])
     or (select prosrc from pg_proc where oid = 'outreach.enforce_organiser_tenant_rules()'::regprocedure)
          not like '%length(new.operational_notes) > 1000%'
     or (select count(*) from pg_proc
          where oid in ('identity.activate_outreach_organiser(uuid,character,text,text)'::regprocedure,
            'identity.activate_outreach_organiser_for_account(text,text,text,text,character,bytea,text)'::regprocedure)
            and prosrc like '%not in (''2026-11-01'', ''2026-11-14'')%') <> 2 then
    raise exception 'the screening objects are not as 0118 makes them';
  end if;
end $$;

-- Fixtures. Outreach group G (5c00...02, active) with organiser O (n=1);
-- hospital H (5c00...12) with doctor D (n=2); support S (n=3).
-- Campaigns at G: 1 closed 400 days ago; 2 closed 10 days ago; 3 active,
-- started 400 days ago; 4 closed before 0116 (no closed_at), last changed 400
-- days ago; 5 active, started yesterday. Campaign 6 at H closed 400 days ago.
-- One unlinked registration in each (cases 1-6), with a guardian's name and
-- an idempotency record.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('5c000000-0000-4000-8000-000000000001', 'Screening Test Group', 'screening-test-group'),
  ('5c000000-0000-4000-8000-000000000011', 'Screening Test Hospital Group', 'screening-test-hospital-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('5c000000-0000-4000-8000-000000000002', '5c000000-0000-4000-8000-000000000001', 'Screening Test Group',
   'SCREENING-G', 'Africa/Lagos', true, 'verified'),
  ('5c000000-0000-4000-8000-000000000012', '5c000000-0000-4000-8000-000000000011', 'Screening Test Hospital',
   'SCREENING-H', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('5c010000-0000-4000-8000-000000000001', 'synthetic:sc-organiser', 'sc-organiser@example.invalid', 'Ife Organiser', 'active'),
  ('5c010000-0000-4000-8000-000000000002', 'synthetic:sc-doctor', 'sc-doctor@example.invalid', 'Jide Doctor', 'active'),
  ('5c010000-0000-4000-8000-000000000003', 'synthetic:sc-support', 'sc-support@example.invalid', 'Kunle Support', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('5c020000-0000-4000-8000-000000000001', '5c010000-0000-4000-8000-000000000001', 'Ife Organiser', 'sc-organiser@example.invalid', 'verified', 'outreach_organiser'),
  ('5c020000-0000-4000-8000-000000000002', '5c010000-0000-4000-8000-000000000002', 'Jide Doctor', 'sc-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('5c030000-0000-4000-8000-000000000001', '5c020000-0000-4000-8000-000000000001', '5c010000-0000-4000-8000-000000000001',
   '5c000000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000002', 'outreach_organiser', 'outreach_organiser', true, true),
  ('5c030000-0000-4000-8000-000000000002', '5c020000-0000-4000-8000-000000000002', '5c010000-0000-4000-8000-000000000002',
   '5c000000-0000-4000-8000-000000000011', '5c000000-0000-4000-8000-000000000012', 'doctor', 'doctor', true, true);
insert into identity.outreach_organisations (organization_id, facility_id, kind, display_name, organiser_account_id,
  contact_phone_lookup_hmac, contact_phone_ciphertext, contact_key_version, origin, terms_version, terms_accepted_at,
  status) values
  ('5c000000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000002', 'group', 'Screening Test Group',
   '5c010000-0000-4000-8000-000000000001', repeat('a', 64), decode(repeat('ab', 32), 'hex'), 'k1', 'existing_account',
   '2026-11-01', clock_timestamp(), 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  (gen_random_uuid(), '5c010000-0000-4000-8000-000000000001', 'outreach_organiser', 'facility',
   '5c030000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000002', 'Synthetic retention suite role'),
  (gen_random_uuid(), '5c010000-0000-4000-8000-000000000002', 'doctor', 'facility',
   '5c030000-0000-4000-8000-000000000002', '5c000000-0000-4000-8000-000000000012', 'Synthetic retention suite role'),
  (gen_random_uuid(), '5c010000-0000-4000-8000-000000000003', 'platform_admin', 'platform', null, null,
   'Synthetic retention suite support role');
-- Invitations of G never accepted: cancelled 40 days ago, expired 40 days
-- ago (left pending, and marked expired), expired 5 days ago, and one still
-- waiting.
insert into identity.outreach_invitations (id, organization_id, facility_id, invited_by_account_id,
  invited_by_membership_id, invitee_name, invitee_email, status, link_token_hmac, expires_at, revoked_at,
  revoked_by_account_id, created_at)
select ('5c090000-0000-4000-8000-00000000000' || n)::uuid, '5c000000-0000-4000-8000-000000000001',
  '5c000000-0000-4000-8000-000000000002', '5c010000-0000-4000-8000-000000000001',
  '5c030000-0000-4000-8000-000000000001', 'Invitee Person ' || n, 'invitee' || n || '@example.invalid', status,
  repeat(n::text, 64), now() + expires, revoked, case when revoked is not null then '5c010000-0000-4000-8000-000000000001'::uuid end,
  now() + expires - interval '7 days'
from (values (1, 'revoked', interval '-40 days', now() - interval '40 days'),
             (2, 'pending', interval '-40 days', null::timestamptz),
             (3, 'expired', interval '-40 days', null),
             (4, 'expired', interval '-5 days', null),
             (5, 'pending', interval '5 days', null)) v(n, status, expires, revoked);
create temporary table sc_campaigns (n integer primary key, facility uuid, member uuid, account uuid, status text,
  starts_at timestamptz, updated_at timestamptz, closed_at timestamptz) on commit drop;
insert into sc_campaigns values
  (1, '5c000000-0000-4000-8000-000000000002', '5c030000-0000-4000-8000-000000000001', '5c010000-0000-4000-8000-000000000001',
   'closed', now() - interval '500 days', now() - interval '400 days', now() - interval '400 days'),
  (2, '5c000000-0000-4000-8000-000000000002', '5c030000-0000-4000-8000-000000000001', '5c010000-0000-4000-8000-000000000001',
   'closed', now() - interval '500 days', now() - interval '10 days', now() - interval '10 days'),
  (3, '5c000000-0000-4000-8000-000000000002', '5c030000-0000-4000-8000-000000000001', '5c010000-0000-4000-8000-000000000001',
   'active', now() - interval '400 days', now() - interval '400 days', null),
  (4, '5c000000-0000-4000-8000-000000000002', '5c030000-0000-4000-8000-000000000001', '5c010000-0000-4000-8000-000000000001',
   'closed', now() - interval '500 days', now() - interval '400 days', null),
  (5, '5c000000-0000-4000-8000-000000000002', '5c030000-0000-4000-8000-000000000001', '5c010000-0000-4000-8000-000000000001',
   'active', now() - interval '1 day', now() - interval '1 day', null),
  (6, '5c000000-0000-4000-8000-000000000012', '5c030000-0000-4000-8000-000000000002', '5c010000-0000-4000-8000-000000000002',
   'closed', now() - interval '500 days', now() - interval '400 days', now() - interval '400 days');
insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services, status,
  starts_at, updated_at, closed_at)
select ('5c070000-0000-4000-8000-00000000000' || n)::uuid, facility, account, member, 'Screening Campaign ' || n,
  array['registration']::text[], status, starts_at, updated_at, closed_at from sc_campaigns;
insert into outreach.campaign_members (campaign_id, facility_id, membership_id, role, added_by_account_id, added_by_membership_id)
select ('5c070000-0000-4000-8000-00000000000' || n)::uuid, facility, member, 'admin', account, member from sc_campaigns;
insert into outreach.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, local_command_id,
  temporary_patient_id, full_name, sex, age_years, phone, operational_notes, campaign_id, created_at)
select ('5c080000-0000-4000-8000-00000000000' || n)::uuid, facility, account, member, gen_random_uuid(),
  'tmp_' || gen_random_uuid(), 'Lola Person ' || n, 'female', 15, '+234800000000' || n, 'Checked blood pressure',
  ('5c070000-0000-4000-8000-00000000000' || n)::uuid, starts_at + interval '1 hour' from sc_campaigns;
insert into outreach.registration_consents (registration_case_id, facility_id, consent_text_version, language, method,
  guardian_name, captured_by_account_id, captured_by_membership_id)
select ('5c080000-0000-4000-8000-00000000000' || n)::uuid, facility, 'notice-2026-11-01', 'ha', 'guardian',
  'Mama Person ' || n, account, member from sc_campaigns;
insert into outreach.command_idempotency (requester_account_id, requester_membership_id, facility_id, operation,
  idempotency_key, request_sha256, registration_case_id)
select account, member, facility, 'registration_case_create', 'screening-key-' || n, repeat('f', 64),
  ('5c080000-0000-4000-8000-00000000000' || n)::uuid from sc_campaigns;
-- Volunteer V (n=4) at G, an outreach volunteer who is in no campaign.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('5c010000-0000-4000-8000-000000000004', 'synthetic:sc-volunteer', 'sc-volunteer@example.invalid', 'Lara Volunteer', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('5c020000-0000-4000-8000-000000000004', '5c010000-0000-4000-8000-000000000004', 'Lara Volunteer',
   'sc-volunteer@example.invalid', 'verified', 'outreach_volunteer');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('5c030000-0000-4000-8000-000000000004', '5c020000-0000-4000-8000-000000000004', '5c010000-0000-4000-8000-000000000004',
   '5c000000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000002', 'outreach_volunteer',
   'outreach_volunteer', false, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  (gen_random_uuid(), '5c010000-0000-4000-8000-000000000004', 'outreach_volunteer', 'facility',
   '5c030000-0000-4000-8000-000000000004', '5c000000-0000-4000-8000-000000000002', 'Synthetic screening suite role');
set local session_replication_role = origin;

create temporary table sc_cases (seq serial, name text primary key, expected text not null, actual text) on commit drop;
grant select, insert on sc_cases to public;
grant usage on sequence sc_cases_seq_seq to public;

create function pg_temp.sc_try(run_role text, subject text, facility text, membership text, purpose text,
  statement text, keep boolean, kind text) returns text language plpgsql as $$
declare outcome text; affected bigint;
begin
  perform set_config('app.actor_subject', coalesce(subject, ''), true),
          set_config('app.facility_id', coalesce(facility, ''), true),
          set_config('app.membership_id', coalesce(membership, ''), true),
          set_config('app.correlation_id', 'outreach-screening-suite', true),
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
    if not keep then raise exception using errcode = 'P0001', message = 'outreach-screening-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'outreach-screening-suite: undo' then outcome := sqlstate || ': ' || sqlerrm; end if;
  end;
  reset role;
  return outcome;
end $$;
create function pg_temp.sc_case(case_name text, expected text, run_role text, subject text, facility text,
  membership text, purpose text, statement text, keep boolean default false, kind text default 'query')
returns void language plpgsql as $$
begin
  insert into pg_temp.sc_cases (name, expected, actual)
  values (case_name, expected, pg_temp.sc_try(run_role, subject, facility, membership, purpose, statement, keep, kind));
end $$;
create function pg_temp.sweeper(case_name text, expected text, statement text, keep boolean default true)
returns void language sql as $$
  select pg_temp.sc_case(case_name, expected, 'hid_identity_api_runtime', 'system:auth', null, null, null, statement, keep) $$;
create function pg_temp.support(case_name text, expected text, subject text, statement text, keep boolean default true)
returns void language sql as $$
  select pg_temp.sc_case(case_name, expected, 'hid_identity_api_runtime', subject, null, null, 'healthcare-operations',
    statement, keep) $$;
create function pg_temp.organiser(case_name text, expected text, statement text, keep boolean default false,
  kind text default 'query') returns void language sql as $$
  select pg_temp.sc_case(case_name, expected, 'hid_outreach_api_runtime', 'synthetic:sc-organiser',
    '5c000000-0000-4000-8000-000000000002', '5c030000-0000-4000-8000-000000000001', 'direct-care', statement, keep, kind) $$;
-- What a registration looks like now (read as the superuser).
create function pg_temp.state(n integer) returns text language sql stable as $$
  select case_row.full_name || '/' || coalesce(case_row.phone, '-') || '/' || coalesce(case_row.operational_notes, '-')
      || '/' || case_row.sex || '/' || case_row.age_years || '/' || consent.guardian_name || '/'
      || left(command.request_sha256, 4)
    from outreach.registration_cases case_row
    join outreach.registration_consents consent on consent.registration_case_id = case_row.id
    join outreach.command_idempotency command on command.registration_case_id = case_row.id
   where case_row.id = ('5c080000-0000-4000-8000-00000000000' || n)::uuid $$;


-- Screening statements: G's organiser O on registration n, with extra columns.
create function pg_temp.screen_insert(n integer, cols text, vals text, account text default '5c010000-0000-4000-8000-000000000001',
  membership text default '5c030000-0000-4000-8000-000000000001', version integer default 1) returns text language sql as $$
  select format($i$insert into outreach.registration_screenings (registration_case_id, facility_id, version,
      recorded_by_account_id, recorded_by_membership_id, updated_by_account_id, updated_by_membership_id,
      idempotency_key, request_sha256%s) values ('5c080000-0000-4000-8000-00000000000%s', (select facility_id from
      outreach.registration_cases where id = '5c080000-0000-4000-8000-00000000000%s'), %s, %L, %L, %L, %L,
      'screening-suite-key-0001', repeat('a', 64)%s)$i$,
    case when cols = '' then '' else ', ' || cols end, n, n, version, account, membership, account, membership,
    case when vals = '' then '' else ', ' || vals end) $$;
create function pg_temp.volunteer(case_name text, expected text, statement text, keep boolean default false,
  kind text default 'query') returns void language sql as $$
  select pg_temp.sc_case(case_name, expected, 'hid_outreach_api_runtime', 'synthetic:sc-volunteer',
    '5c000000-0000-4000-8000-000000000002', '5c030000-0000-4000-8000-000000000004', 'direct-care', statement, keep, kind) $$;
create function pg_temp.doctor(case_name text, expected text, statement text, keep boolean default false,
  kind text default 'query') returns void language sql as $$
  select pg_temp.sc_case(case_name, expected, 'hid_outreach_api_runtime', 'synthetic:sc-doctor',
    '5c000000-0000-4000-8000-000000000012', '5c030000-0000-4000-8000-000000000002', 'direct-care', statement, keep, kind) $$;
grant execute on function pg_temp.screen_insert(integer, text, text, text, text, integer) to public;

-- 1. Recording a screening (registration 5, in G's active campaign 5).
select pg_temp.organiser('1a the organiser records a full screening', 'rows 1',
  pg_temp.screen_insert(5, 'bp_systolic, bp_diastolic, pulse_bpm, temperature_c, weight_kg, height_cm, glucose_value, '
    || 'glucose_unit, glucose_timing, malaria_rdt, hearing_left, hearing_right, main_complaint, seen_by_clinician, '
    || 'clinician_name, outcome, medicines_given, referred, referred_to',
    $v$128, 84, 76, 36.9, 71.5, 168, 6.1, 'mmol/L', 'random', 'negative', 'pass', 'refer', 'Headache for two days', true,
      'Dr Ade, GP', 'Advised fluids and rest', '[{"name": "Paracetamol 500 mg", "dose": "2 tablets three times a day"}]',
      true, 'Ilorin General Hospital ENT clinic'$v$), true, 'count');
select pg_temp.organiser('1b it reads back, version 1, recorded by O', '128/84/1/5c030000-0000-4000-8000-000000000001/1',
  $s$select concat_ws('/', bp_systolic, bp_diastolic, version, recorded_by_membership_id, jsonb_array_length(medicines_given))
      from outreach.registration_screenings where registration_case_id = '5c080000-0000-4000-8000-000000000005'$s$);
select pg_temp.organiser('1c a second insert for the same registration is refused',
  '23505: duplicate key value violates unique constraint "registration_screenings_pkey"',
  pg_temp.screen_insert(5, 'pulse_bpm', '80'), false, 'statement');
select pg_temp.organiser('1d the next version replaces it', 'rows 1',
  $s$update outreach.registration_screenings set pulse_bpm = 90, version = 2,
      idempotency_key = 'screening-suite-key-0002', request_sha256 = repeat('b', 64)
      where registration_case_id = '5c080000-0000-4000-8000-000000000005' and version = 1$s$, true, 'count');
select pg_temp.organiser('1e skipping a version is refused', '23514: OUTREACH_SCREENING_VERSION_INVALID',
  $s$update outreach.registration_screenings set version = 4
      where registration_case_id = '5c080000-0000-4000-8000-000000000005'$s$, false, 'statement');
select pg_temp.organiser('1f the first recording never changes', '23514: OUTREACH_SCREENING_VERSION_INVALID',
  $s$update outreach.registration_screenings set version = 3, recorded_by_membership_id = '5c030000-0000-4000-8000-000000000004'
      where registration_case_id = '5c080000-0000-4000-8000-000000000005'$s$, false, 'statement');
select pg_temp.organiser('1g another account cannot be named as the recorder', '42501: OUTREACH_SCREENING_ACTOR_MISMATCH',
  pg_temp.screen_insert(3, 'pulse_bpm', '80', '5c010000-0000-4000-8000-000000000004', '5c030000-0000-4000-8000-000000000004'),
  false, 'statement');
select pg_temp.organiser('1h the runtime never deletes a screening', '42501: permission denied for table registration_screenings',
  $s$delete from outreach.registration_screenings where registration_case_id = '5c080000-0000-4000-8000-000000000005'$s$,
  false, 'statement');
select pg_temp.organiser('1i an empty screening is allowed', 'rows 1', pg_temp.screen_insert(3, '', ''), false, 'count');

-- 2. Plausible ranges and completeness.
select pg_temp.organiser('2a systolic 400', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_bp_systolic_check"',
  pg_temp.screen_insert(3, 'bp_systolic, bp_diastolic', '400, 80'), false, 'statement');
select pg_temp.organiser('2b diastolic above systolic', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_bp_ck"',
  pg_temp.screen_insert(3, 'bp_systolic, bp_diastolic', '90, 120'), false, 'statement');
select pg_temp.organiser('2c systolic without diastolic', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_bp_ck"',
  pg_temp.screen_insert(3, 'bp_systolic', '120'), false, 'statement');
select pg_temp.organiser('2d glucose without unit', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_glucose_ck"',
  pg_temp.screen_insert(3, 'glucose_value, glucose_timing', '5.5, ''fasting'''), false, 'statement');
select pg_temp.organiser('2e glucose 60 mmol/L', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_glucose_ck"',
  pg_temp.screen_insert(3, 'glucose_value, glucose_unit, glucose_timing', '60, ''mmol/L'', ''fasting'''), false, 'statement');
select pg_temp.organiser('2f glucose 110 mg/dL is fine', 'ok',
  pg_temp.screen_insert(3, 'glucose_value, glucose_unit, glucose_timing', '110, ''mg/dL'', ''fasting'''), false, 'statement');
select pg_temp.organiser('2g temperature 50', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_temperature_c_check"',
  pg_temp.screen_insert(3, 'temperature_c', '50'), false, 'statement');
select pg_temp.organiser('2h referred to, not referred', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_referral_ck"',
  pg_temp.screen_insert(3, 'referred_to', '''Ilorin General Hospital'''), false, 'statement');
select pg_temp.organiser('2i eleven medicines', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_medicines_given_check"',
  pg_temp.screen_insert(3, 'medicines_given',
    $v$(select jsonb_agg(jsonb_build_object('name', 'Medicine ' || n)) from generate_series(1, 11) n)$v$), false, 'statement');
select pg_temp.organiser('2j a medicine with another key', '23514: OUTREACH_SCREENING_MEDICINES_INVALID',
  pg_temp.screen_insert(3, 'medicines_given', $v$'[{"name": "Paracetamol", "price": 200}]'$v$), false, 'statement');
select pg_temp.organiser('2k a medicine without a name', '23514: OUTREACH_SCREENING_MEDICINES_INVALID',
  pg_temp.screen_insert(3, 'medicines_given', $v$'[{"dose": "1 tablet"}]'$v$), false, 'statement');
select pg_temp.organiser('2l a complaint over 200 characters', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_main_complaint_check"',
  pg_temp.screen_insert(3, 'main_complaint', 'repeat(''a'', 201)'), false, 'statement');
select pg_temp.organiser('2m malaria "maybe"', '23514: new row for relation "registration_screenings" violates check constraint "registration_screenings_malaria_rdt_check"',
  pg_temp.screen_insert(3, 'malaria_rdt', '''maybe'''), false, 'statement');

-- 3. Who sees it: the campaign's members at the group only.
select pg_temp.volunteer('3a a volunteer in no campaign sees no screening', 'none',
  $s$select registration_case_id from outreach.registration_screenings$s$);
-- (Refused by the case check, or by row-level security where the owner bypasses it.)
select pg_temp.volunteer('3b nor records one', 'P0002: refused',
  format($d$do $x$ begin %s; exception when insufficient_privilege or check_violation then
    raise exception using errcode = 'P0002', message = 'refused'; end $x$$d$,
    pg_temp.screen_insert(3, 'pulse_bpm', '80', '5c010000-0000-4000-8000-000000000004', '5c030000-0000-4000-8000-000000000004')),
  false, 'statement');
select pg_temp.doctor('3c a doctor at another facility sees none', 'none',
  $s$select registration_case_id from outreach.registration_screenings$s$);

-- 4. The registration's area and the notes cap at an outreach group.
create function pg_temp.registration_insert(notes_length integer, area text) returns text language sql as $$
  select format($i$insert into outreach.registration_cases (id, facility_id, created_by_account_id,
      created_by_membership_id, local_command_id, temporary_patient_id, full_name, sex, age_years,
      operational_notes, campaign_id, area) values (gen_random_uuid(), '5c000000-0000-4000-8000-000000000002',
      '5c010000-0000-4000-8000-000000000001', '5c030000-0000-4000-8000-000000000001', gen_random_uuid(),
      'tmp_' || gen_random_uuid(), 'Bisi Person', 'female', 40, repeat('n', %s), '5c070000-0000-4000-8000-000000000005',
      %L)$i$, notes_length, area) $$;
grant execute on function pg_temp.registration_insert(integer, text) to public;
select pg_temp.organiser('4a notes of 1000 characters and an area are taken at an outreach group', 'rows 1',
  pg_temp.registration_insert(1000, 'Tanke, Ilorin South'), false, 'count');
select pg_temp.organiser('4b notes of 1001 characters are not', '23514: OUTREACH_NOTES_TOO_LONG',
  pg_temp.registration_insert(1001, null), false, 'statement');
select pg_temp.organiser('4c an area over 100 characters is not', '23514: new row for relation "registration_cases" violates check constraint "registration_cases_area_ck"',
  pg_temp.registration_insert(10, repeat('a', 101)), false, 'statement');
set local session_replication_role = replica;
-- Registration 2's person was registered as '[redacted]' (the 0024 check allows it): its redaction must still clear.
update outreach.registration_cases set full_name = '[redacted]' where id = '5c080000-0000-4000-8000-000000000002';
update outreach.registration_cases set area = 'Oja Oba, Ilorin West'
 where id in ('5c080000-0000-4000-8000-000000000002', '5c080000-0000-4000-8000-000000000005');
set local session_replication_role = origin;
select pg_temp.sc_case('4d the area never changes', '23514: OUTREACH_REGISTRATION_AREA_IMMUTABLE', session_user::text,
  null, null, null, null,
  $s$update outreach.registration_cases set area = 'Elsewhere' where id = '5c080000-0000-4000-8000-000000000005'$s$,
  false, 'statement');

-- 4e. A suspended outreach group records no screening.
select pg_temp.sc_case('4e a suspended group records no screening', '55000: OUTREACH_ORGANISER_SUSPENDED',
  session_user::text, null, null, null, null,
  format($d$do $x$ begin
    update identity.outreach_organisations set status = 'suspended', suspended_at = clock_timestamp(),
      suspended_by_account_id = '5c010000-0000-4000-8000-000000000003', suspension_reason = 'Synthetic suspension for the suite'
     where facility_id = '5c000000-0000-4000-8000-000000000002';
    perform set_config('app.actor_subject', 'synthetic:sc-organiser', true),
            set_config('app.facility_id', '5c000000-0000-4000-8000-000000000002', true),
            set_config('app.membership_id', '5c030000-0000-4000-8000-000000000001', true),
            set_config('app.purpose_of_use', 'direct-care', true);
    set local role hid_outreach_api_runtime;
    %s;
  end $x$$d$, pg_temp.screen_insert(3, 'pulse_bpm', '80')), false, 'statement');

-- 5. Redaction: support redacts registration 5; its screening goes and its area is cleared.
select pg_temp.support('5a support redacts the registration', 'redacted', 'synthetic:sc-support',
  $s$select identity.admin_redact_outreach_registration('5c080000-0000-4000-8000-000000000005', 'Caller asked us to delete her details')$s$);
select pg_temp.sc_case('5b its screening is gone and its area cleared', '0/null', session_user::text, null, null, null,
  null, $s$select (select count(*) from outreach.registration_screenings
                    where registration_case_id = '5c080000-0000-4000-8000-000000000005')::text || '/'
              || coalesce((select area from outreach.registration_cases
                            where id = '5c080000-0000-4000-8000-000000000005'), 'null')$s$);
select pg_temp.organiser('5c no screening can be recorded for it again', '55000: OUTREACH_REGISTRATION_REDACTED',
  pg_temp.screen_insert(5, 'pulse_bpm', '80'), false, 'statement');
-- The sweeper: registration 1 (closed 400 days ago) is expired, registration 2 (closed 10 days ago) is not.
select pg_temp.organiser('5d a screening on registration 2 (kept: closed 10 days ago)', 'rows 1', pg_temp.screen_insert(2, 'pulse_bpm', '70'),
  true, 'count');
set local session_replication_role = replica;
insert into outreach.registration_screenings (registration_case_id, facility_id, pulse_bpm, version,
  recorded_by_account_id, recorded_by_membership_id, updated_by_account_id, updated_by_membership_id, idempotency_key,
  request_sha256)
values ('5c080000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000002', 66, 1,
  '5c010000-0000-4000-8000-000000000001', '5c030000-0000-4000-8000-000000000001', '5c010000-0000-4000-8000-000000000001',
  '5c030000-0000-4000-8000-000000000001', 'screening-suite-key-0009', repeat('c', 64));
set local session_replication_role = origin;
select pg_temp.sweeper('5e the sweeper redacts the expired registrations', 'true',
  $s$select identity.sweep_expired_outreach_registrations(100) >= 1$s$);
select pg_temp.sc_case('5f the expired one''s screening is gone; the others'' are kept', '1:0|2:1', session_user::text,
  null, null, null, null,
  $s$select string_agg(right(case_id::text, 1) || ':' || (select count(*) from outreach.registration_screenings screening
                                 where screening.registration_case_id = case_id), '|' order by case_id)
       from unnest(array['5c080000-0000-4000-8000-000000000001', '5c080000-0000-4000-8000-000000000002']::uuid[]) case_id$s$);

select pg_temp.support('5g support redacts registration 2, whose person was registered as "[redacted]"', 'redacted',
  'synthetic:sc-support',
  $s$select identity.admin_redact_outreach_registration('5c080000-0000-4000-8000-000000000002', 'Caller asked us to delete her details')$s$);
select pg_temp.sc_case('5h its screening is gone and its area cleared all the same', '0/null', session_user::text, null,
  null, null, null, $s$select (select count(*) from outreach.registration_screenings
                    where registration_case_id = '5c080000-0000-4000-8000-000000000002')::text || '/'
              || coalesce((select area from outreach.registration_cases
                            where id = '5c080000-0000-4000-8000-000000000002'), 'null')$s$);

-- 6. Result.
do $$
declare failed text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, coalesce(actual, 'null')), E'\n' order by seq)
    into failed from pg_temp.sc_cases where actual is distinct from expected;
  if failed is not null then
    raise exception E'Outreach screening suite failed:\n%', failed;
  end if;
  raise notice 'Outreach screening suite: % cases passed', (select count(*) from pg_temp.sc_cases);
end $$;

rollback;
