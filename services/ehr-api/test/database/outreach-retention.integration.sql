\set ON_ERROR_STOP on
-- Outreach retention (0126): an outreach group's registrations never linked to
-- a Health ID are kept 1 year (closed_at + 365 days, or starts_at + 365 days
-- for a campaign never closed), then redacted by the sweeper; support redacts
-- one on request. Rollback-only. Fictional people and places only.
--
-- Fixtures are inserted with session_replication_role = replica. Every case
-- then runs, with every trigger and RLS policy, as the production runtime role
-- that would run it (hid_identity_api_runtime for the sweeper and support,
-- hid_outreach_api_runtime for outreach-api) under the session that service
-- sets. Each case records its outcome and the suite fails at the end listing
-- every case whose outcome differs.
begin;

do $$
begin
  if to_regclass('outreach.registration_redactions') is null
     or to_regprocedure('identity.sweep_expired_outreach_registrations(integer)') is null
     or has_function_privilege('hid_outreach_api_runtime', 'identity.sweep_expired_outreach_registrations(integer)', 'EXECUTE')
     or has_function_privilege('hid_outreach_api_runtime', 'identity.admin_redact_outreach_registration(uuid,text)', 'EXECUTE')
     or has_table_privilege('hid_outreach_api_runtime', 'outreach.privileged_runs', 'INSERT') then
    raise exception 'the retention objects are not as 0126 makes them';
  end if;
end $$;

-- Fixtures. Outreach group G (0f00...02, reviewed) with organiser O (n=1);
-- hospital H (0f00...12) with doctor D (n=2); support S (n=3).
-- Campaigns at G: 1 closed 400 days ago; 2 closed 10 days ago; 3 active,
-- started 400 days ago; 4 closed before 0126 (no closed_at), last changed 400
-- days ago; 5 active, started yesterday. Campaign 6 at H closed 400 days ago.
-- One unlinked registration in each (cases 1-6), with a guardian's name and
-- an idempotency record.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('0f000000-0000-4000-8000-000000000001', 'Retention Test Group', 'retention-test-group'),
  ('0f000000-0000-4000-8000-000000000011', 'Retention Test Hospital Group', 'retention-test-hospital-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('0f000000-0000-4000-8000-000000000002', '0f000000-0000-4000-8000-000000000001', 'Retention Test Group',
   'RETENTION-G', 'Africa/Lagos', true, 'verified'),
  ('0f000000-0000-4000-8000-000000000012', '0f000000-0000-4000-8000-000000000011', 'Retention Test Hospital',
   'RETENTION-H', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('0f010000-0000-4000-8000-000000000001', 'synthetic:rt-organiser', 'rt-organiser@example.invalid', 'Ife Organiser', 'active'),
  ('0f010000-0000-4000-8000-000000000002', 'synthetic:rt-doctor', 'rt-doctor@example.invalid', 'Jide Doctor', 'active'),
  ('0f010000-0000-4000-8000-000000000003', 'synthetic:rt-support', 'rt-support@example.invalid', 'Kunle Support', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('0f020000-0000-4000-8000-000000000001', '0f010000-0000-4000-8000-000000000001', 'Ife Organiser', 'rt-organiser@example.invalid', 'verified', 'outreach_organiser'),
  ('0f020000-0000-4000-8000-000000000002', '0f010000-0000-4000-8000-000000000002', 'Jide Doctor', 'rt-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('0f030000-0000-4000-8000-000000000001', '0f020000-0000-4000-8000-000000000001', '0f010000-0000-4000-8000-000000000001',
   '0f000000-0000-4000-8000-000000000001', '0f000000-0000-4000-8000-000000000002', 'outreach_organiser', 'outreach_organiser', true, true),
  ('0f030000-0000-4000-8000-000000000002', '0f020000-0000-4000-8000-000000000002', '0f010000-0000-4000-8000-000000000002',
   '0f000000-0000-4000-8000-000000000011', '0f000000-0000-4000-8000-000000000012', 'doctor', 'doctor', true, true);
insert into identity.outreach_organisations (organization_id, facility_id, kind, display_name, organiser_account_id,
  contact_phone_lookup_hmac, contact_phone_ciphertext, contact_key_version, origin, terms_version, terms_accepted_at,
  review_state, reviewed_by_account_id, reviewed_at) values
  ('0f000000-0000-4000-8000-000000000001', '0f000000-0000-4000-8000-000000000002', 'group', 'Retention Test Group',
   '0f010000-0000-4000-8000-000000000001', repeat('a', 64), decode(repeat('ab', 32), 'hex'), 'k1', 'existing_account',
   '2026-11-01', clock_timestamp(), 'reviewed', '0f010000-0000-4000-8000-000000000003', clock_timestamp());
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  (gen_random_uuid(), '0f010000-0000-4000-8000-000000000001', 'outreach_organiser', 'facility',
   '0f030000-0000-4000-8000-000000000001', '0f000000-0000-4000-8000-000000000002', 'Synthetic retention suite role'),
  (gen_random_uuid(), '0f010000-0000-4000-8000-000000000002', 'doctor', 'facility',
   '0f030000-0000-4000-8000-000000000002', '0f000000-0000-4000-8000-000000000012', 'Synthetic retention suite role'),
  (gen_random_uuid(), '0f010000-0000-4000-8000-000000000003', 'platform_admin', 'platform', null, null,
   'Synthetic retention suite support role');
create temporary table rt_campaigns (n integer primary key, facility uuid, member uuid, account uuid, status text,
  starts_at timestamptz, updated_at timestamptz, closed_at timestamptz) on commit drop;
insert into rt_campaigns values
  (1, '0f000000-0000-4000-8000-000000000002', '0f030000-0000-4000-8000-000000000001', '0f010000-0000-4000-8000-000000000001',
   'closed', now() - interval '500 days', now() - interval '400 days', now() - interval '400 days'),
  (2, '0f000000-0000-4000-8000-000000000002', '0f030000-0000-4000-8000-000000000001', '0f010000-0000-4000-8000-000000000001',
   'closed', now() - interval '500 days', now() - interval '10 days', now() - interval '10 days'),
  (3, '0f000000-0000-4000-8000-000000000002', '0f030000-0000-4000-8000-000000000001', '0f010000-0000-4000-8000-000000000001',
   'active', now() - interval '400 days', now() - interval '400 days', null),
  (4, '0f000000-0000-4000-8000-000000000002', '0f030000-0000-4000-8000-000000000001', '0f010000-0000-4000-8000-000000000001',
   'closed', now() - interval '500 days', now() - interval '400 days', null),
  (5, '0f000000-0000-4000-8000-000000000002', '0f030000-0000-4000-8000-000000000001', '0f010000-0000-4000-8000-000000000001',
   'active', now() - interval '1 day', now() - interval '1 day', null),
  (6, '0f000000-0000-4000-8000-000000000012', '0f030000-0000-4000-8000-000000000002', '0f010000-0000-4000-8000-000000000002',
   'closed', now() - interval '500 days', now() - interval '400 days', now() - interval '400 days');
insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services, status,
  starts_at, updated_at, closed_at)
select ('0f070000-0000-4000-8000-00000000000' || n)::uuid, facility, account, member, 'Retention Campaign ' || n,
  array['registration']::text[], status, starts_at, updated_at, closed_at from rt_campaigns;
insert into outreach.campaign_members (campaign_id, facility_id, membership_id, role, added_by_account_id, added_by_membership_id)
select ('0f070000-0000-4000-8000-00000000000' || n)::uuid, facility, member, 'admin', account, member from rt_campaigns;
insert into outreach.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, local_command_id,
  temporary_patient_id, full_name, sex, age_years, phone, operational_notes, campaign_id, created_at)
select ('0f080000-0000-4000-8000-00000000000' || n)::uuid, facility, account, member, gen_random_uuid(),
  'tmp_' || gen_random_uuid(), 'Lola Person ' || n, 'female', 15, '+234800000000' || n, 'Checked blood pressure',
  ('0f070000-0000-4000-8000-00000000000' || n)::uuid, starts_at + interval '1 hour' from rt_campaigns;
insert into outreach.registration_consents (registration_case_id, facility_id, consent_text_version, language, method,
  guardian_name, captured_by_account_id, captured_by_membership_id)
select ('0f080000-0000-4000-8000-00000000000' || n)::uuid, facility, 'notice-2026-11-01', 'ha', 'guardian',
  'Mama Person ' || n, account, member from rt_campaigns;
insert into outreach.command_idempotency (requester_account_id, requester_membership_id, facility_id, operation,
  idempotency_key, request_sha256, registration_case_id)
select account, member, facility, 'registration_case_create', 'retention-key-' || n, repeat('f', 64),
  ('0f080000-0000-4000-8000-00000000000' || n)::uuid from rt_campaigns;
set local session_replication_role = origin;

create temporary table rt_cases (seq serial, name text primary key, expected text not null, actual text) on commit drop;
grant select, insert on rt_cases to public;
grant usage on sequence rt_cases_seq_seq to public;

create function pg_temp.rt_try(run_role text, subject text, facility text, membership text, purpose text,
  statement text, keep boolean, kind text) returns text language plpgsql as $$
declare outcome text; affected bigint;
begin
  perform set_config('app.actor_subject', coalesce(subject, ''), true),
          set_config('app.facility_id', coalesce(facility, ''), true),
          set_config('app.membership_id', coalesce(membership, ''), true),
          set_config('app.correlation_id', 'outreach-retention-suite', true),
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
    if not keep then raise exception using errcode = 'P0001', message = 'outreach-retention-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'outreach-retention-suite: undo' then outcome := sqlstate || ': ' || sqlerrm; end if;
  end;
  reset role;
  return outcome;
end $$;
create function pg_temp.rt_case(case_name text, expected text, run_role text, subject text, facility text,
  membership text, purpose text, statement text, keep boolean default false, kind text default 'query')
returns void language plpgsql as $$
begin
  insert into pg_temp.rt_cases (name, expected, actual)
  values (case_name, expected, pg_temp.rt_try(run_role, subject, facility, membership, purpose, statement, keep, kind));
end $$;
create function pg_temp.sweeper(case_name text, expected text, statement text, keep boolean default true)
returns void language sql as $$
  select pg_temp.rt_case(case_name, expected, 'hid_identity_api_runtime', 'system:auth', null, null, null, statement, keep) $$;
create function pg_temp.support(case_name text, expected text, subject text, statement text, keep boolean default true)
returns void language sql as $$
  select pg_temp.rt_case(case_name, expected, 'hid_identity_api_runtime', subject, null, null, 'healthcare-operations',
    statement, keep) $$;
create function pg_temp.organiser(case_name text, expected text, statement text, keep boolean default false,
  kind text default 'query') returns void language sql as $$
  select pg_temp.rt_case(case_name, expected, 'hid_outreach_api_runtime', 'synthetic:rt-organiser',
    '0f000000-0000-4000-8000-000000000002', '0f030000-0000-4000-8000-000000000001', 'direct-care', statement, keep, kind) $$;
-- What a registration looks like now (read as the superuser).
create function pg_temp.state(n integer) returns text language sql stable as $$
  select case_row.full_name || '/' || coalesce(case_row.phone, '-') || '/' || coalesce(case_row.operational_notes, '-')
      || '/' || case_row.sex || '/' || case_row.age_years || '/' || consent.guardian_name || '/'
      || left(command.request_sha256, 4)
    from outreach.registration_cases case_row
    join outreach.registration_consents consent on consent.registration_case_id = case_row.id
    join outreach.command_idempotency command on command.registration_case_id = case_row.id
   where case_row.id = ('0f080000-0000-4000-8000-00000000000' || n)::uuid $$;

-- 1. Who may run it.
select pg_temp.rt_case('1a the Outreach runtime cannot run the sweeper',
  '42501: permission denied for function sweep_expired_outreach_registrations', 'hid_outreach_api_runtime',
  'system:auth', null, null, null, 'select identity.sweep_expired_outreach_registrations(100)');
select pg_temp.rt_case('1b the Outreach runtime cannot open a retention run',
  '42501: permission denied for table privileged_runs', 'hid_outreach_api_runtime',
  'synthetic:rt-organiser', '0f000000-0000-4000-8000-000000000002', '0f030000-0000-4000-8000-000000000001', 'direct-care',
  $s$insert into outreach.privileged_runs (transaction_id, kind) values (pg_current_xact_id(), 'retention')$s$, false, 'statement');
select pg_temp.organiser('1c the organiser cannot redact a registration themself',
  '55000: Outreach registration history cannot be overwritten',
  $s$update outreach.registration_cases set full_name = '[redacted]', phone = null, operational_notes = null,
      row_version = row_version + 1 where id = '0f080000-0000-4000-8000-000000000005'$s$, false, 'statement');
select pg_temp.organiser('1d the organiser cannot change an idempotency record', '42501: permission denied for table command_idempotency',
  $s$update outreach.command_idempotency set request_sha256 = repeat('0', 64)
      where registration_case_id = '0f080000-0000-4000-8000-000000000005'$s$, false, 'statement');
select pg_temp.rt_case('1e the sweeper refuses any caller but Identity''s system context', '42501: OUTREACH_RETENTION_DENIED',
  'hid_identity_api_runtime', 'synthetic:rt-doctor', null, null, 'healthcare-operations',
  'select identity.sweep_expired_outreach_registrations(100)');

-- 2. When a registration expires.
select pg_temp.rt_case('2a retain until: closed + 365 days, legacy close, start + 365 days', '1 t | 2 f | 3 t | 4 t | 5 f | 6 t',
  'pgrun', null, null, null, null,
  $s$select right(campaign.name, 1) || ' ' || (outreach.registration_retain_until(campaign) <= now())::text::char
      from outreach.campaigns campaign where campaign.name like 'Retention Campaign %' order by campaign.name$s$);

-- 3. The sweep.
select pg_temp.sweeper('3a the sweeper redacts the three expired registrations of the group', '3',
  'select identity.sweep_expired_outreach_registrations(100)');
select pg_temp.rt_case('3b what is left of an expired registration', '[redacted]/-/-/female/15/[redacted]/0000',
  'pgrun', null, null, null, null, 'select pg_temp.state(1)');
select pg_temp.rt_case('3c a registration whose campaign never closed, after a year', '[redacted]/-/-/female/15/[redacted]/0000',
  'pgrun', null, null, null, null, 'select pg_temp.state(3)');
select pg_temp.rt_case('3d a recent registration is untouched', 'Lola Person 2/+2348000000002/Checked blood pressure/female/15/Mama Person 2/ffff',
  'pgrun', null, null, null, null, 'select pg_temp.state(2)');
select pg_temp.rt_case('3e a hospital''s registration is untouched', 'Lola Person 6/+2348000000006/Checked blood pressure/female/15/Mama Person 6/ffff',
  'pgrun', null, null, null, null, 'select pg_temp.state(6)');
select pg_temp.rt_case('3f each redaction is recorded, and the sweep audited', '1 retention | 3 retention | 4 retention | audit 1',
  'pgrun', null, null, null, null,
  $s$select right(registration_case_id::text, 1) || ' ' || kind from outreach.registration_redactions
     union all select 'audit ' || count(*) from audit.events where action = 'outreach.registration.retention-sweep'
       and correlation_id = 'outreach-retention-suite' order by 1$s$);
select pg_temp.sweeper('3g a second sweep finds nothing', '0', 'select identity.sweep_expired_outreach_registrations(100)');
select pg_temp.organiser('3h the organiser still counts the redacted registrations', '5',
  $s$select count(*)::text from outreach.registration_cases where facility_id = '0f000000-0000-4000-8000-000000000002'$s$);
select pg_temp.rt_case('3i no retention run is left behind', '0', 'pgrun', null, null, null, null,
  'select count(*)::text from outreach.privileged_runs');

-- 4. On request.
select pg_temp.support('4a support redacts one registration on the person''s request', 'redacted', 'synthetic:rt-support',
  $s$select identity.admin_redact_outreach_registration('0f080000-0000-4000-8000-000000000002', 'Caller asked us to delete her details')$s$);
select pg_temp.rt_case('4b it is gone', '[redacted]/-/-/female/15/[redacted]/0000', 'pgrun', null, null, null, null,
  'select pg_temp.state(2)');
select pg_temp.support('4c again: nothing left to redact', 'not_redactable', 'synthetic:rt-support',
  $s$select identity.admin_redact_outreach_registration('0f080000-0000-4000-8000-000000000002', 'Caller asked us again')$s$);
select pg_temp.support('4d a hospital registration is not redacted here', 'not_redactable', 'synthetic:rt-support',
  $s$select identity.admin_redact_outreach_registration('0f080000-0000-4000-8000-000000000006', 'Not an outreach group record')$s$);
select pg_temp.support('4e a doctor cannot use support''s redaction', '42501: ADMIN_PERMISSION_DENIED', 'synthetic:rt-doctor',
  $s$select identity.admin_redact_outreach_registration('0f080000-0000-4000-8000-000000000005', 'Not support at all')$s$, false);
select pg_temp.rt_case('4f the request is recorded with who asked', '2 request 0f010000-0000-4000-8000-000000000003',
  'pgrun', null, null, null, null,
  $s$select right(registration_case_id::text, 1) || ' ' || kind || ' ' || requested_by_account_id
       from outreach.registration_redactions where kind = 'request'$s$);

-- 5. closed_at is stamped, never written by a caller.
select pg_temp.organiser('5a the admin closes a campaign, trying to back-date closed_at', 'rows 1',
  $s$update outreach.campaigns set status = 'closed', closed_at = now() - interval '900 days',
      row_version = row_version + 1 where id = '0f070000-0000-4000-8000-000000000005'$s$, true, 'count');
select pg_temp.organiser('5b closed_at is the moment it closed, not the date the caller gave', 't',
  $s$select (closed_at > now() - interval '1 minute')::text::char from outreach.campaigns
      where id = '0f070000-0000-4000-8000-000000000005'$s$);
select pg_temp.organiser('5c reopening clears closed_at', 'rows 1',
  $s$update outreach.campaigns set status = 'active', row_version = row_version + 1
      where id = '0f070000-0000-4000-8000-000000000005'$s$, true, 'count');
select pg_temp.rt_case('5d closed_at is null while open', 'null', 'pgrun', null, null, null, null,
  $s$select coalesce(closed_at::text, 'null') from outreach.campaigns where id = '0f070000-0000-4000-8000-000000000005'$s$);

-- 6. Result.
do $$
declare failed text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, coalesce(actual, 'null')), E'\n' order by seq)
    into failed from pg_temp.rt_cases where actual is distinct from expected;
  if failed is not null then
    raise exception E'Outreach retention suite failed:\n%', failed;
  end if;
  raise notice 'Outreach retention suite: % cases passed', (select count(*) from pg_temp.rt_cases);
end $$;

rollback;
