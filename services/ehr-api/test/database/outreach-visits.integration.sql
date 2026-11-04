\set ON_ERROR_STOP on
-- Outreach visits, Health ID preview attempts and staff names (0115).
-- Rollback-only.
--
-- outreach.registration_case_visits and outreach.link_preview_attempts are
-- insert-only, force row-level security and are reached only through a case
-- the caller may read at the session facility. The two SECURITY DEFINER name
-- readers return staff full_name only, for the caller's facility and
-- campaigns, at most 200 ids, and lock no row.
--
-- The name readers run here twice: first under their owner as migrated, then
-- under an owner that is neither a superuser nor BYPASSRLS. In production
-- (and the release rehearsal) the migration login already is such an owner;
-- on a superuser-migrated database (CI, the acceptance runner) the readers
-- are lent to a role made in this transaction with the privileges they use,
-- until the ROLLBACK. Under such an owner the read tables' row-level security
-- applies inside the readers too, and the answers must be the same.
--
-- Fixtures are inserted with session_replication_role = replica (no triggers
-- or foreign-key checks); every case then runs with triggers, references and
-- row-level security enforced, as hid_outreach_api_runtime (outreach-api's
-- runtime role) with the session outreach-api sets
-- (services/outreach-api/src/database/database.service.ts). Each case
-- records the statement's single text answer, '(none)', or
-- 'SQLSTATE: message', and the suite fails at the end listing every case
-- whose outcome differs from the expected one. All data is fictional.
begin;

-- 1. The shape 0115 adds.
do $$
begin
  if (select count(*) from pg_class
       where oid in ('outreach.registration_case_visits'::regclass, 'outreach.link_preview_attempts'::regclass)
         and relrowsecurity and relforcerowsecurity) <> 2 then
    raise exception 'the 0115 tables must enable and force row-level security';
  end if;
  if (select count(*) from pg_proc
       where oid in ('outreach.member_display_names(uuid[])'::regprocedure,
                     'outreach.case_registrar_names(uuid[])'::regprocedure)
         and prosecdef and provolatile = 's'
         and proconfig = '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]) <> 2 then
    raise exception 'the name readers must be STABLE SECURITY DEFINER with the Outreach search_path';
  end if;
  -- No row lock anywhere in the readers (0045's lesson).
  if exists (select 1 from pg_proc
              where oid in ('outreach.member_display_names(uuid[])'::regprocedure,
                            'outreach.case_registrar_names(uuid[])'::regprocedure)
                and prosrc ~* '\mfor\s+(update|share|no\s+key\s+update|key\s+share)\M') then
    raise exception 'an Outreach name reader takes a row lock';
  end if;
  -- The readers answer two columns: an id and a name; nothing else.
  if (select string_agg(format('%s:%s', proname, array_to_string(proargnames, ',')), ';' order by proname)
        from pg_proc where oid in ('outreach.member_display_names(uuid[])'::regprocedure,
                                   'outreach.case_registrar_names(uuid[])'::regprocedure))
     <> 'case_registrar_names:case_ids,registration_case_id,display_name;member_display_names:membership_ids,membership_id,display_name' then
    raise exception 'the name readers answer more than an id and a name';
  end if;
  -- The runtime may only read and insert; nothing to PUBLIC.
  if has_table_privilege('hid_outreach_api_runtime', 'outreach.registration_case_visits', 'UPDATE')
     or has_table_privilege('hid_outreach_api_runtime', 'outreach.registration_case_visits', 'DELETE')
     or has_table_privilege('hid_outreach_api_runtime', 'outreach.link_preview_attempts', 'UPDATE')
     or has_table_privilege('hid_outreach_api_runtime', 'outreach.link_preview_attempts', 'DELETE')
     or not has_table_privilege('hid_outreach_api_runtime', 'outreach.registration_case_visits', 'SELECT, INSERT')
     or not has_table_privilege('hid_outreach_api_runtime', 'outreach.link_preview_attempts', 'SELECT, INSERT')
     or not has_function_privilege('hid_outreach_api_runtime', 'outreach.member_display_names(uuid[])', 'EXECUTE')
     or not has_function_privilege('hid_outreach_api_runtime', 'outreach.case_registrar_names(uuid[])', 'EXECUTE')
     or has_table_privilege('public', 'outreach.registration_case_visits', 'SELECT')
     or has_table_privilege('public', 'outreach.link_preview_attempts', 'SELECT')
     or has_function_privilege('public', 'outreach.member_display_names(uuid[])', 'EXECUTE')
     or has_function_privilege('public', 'outreach.case_registrar_names(uuid[])', 'EXECUTE')
     or has_function_privilege('public', 'outreach.validate_registration_case_visit()', 'EXECUTE') then
    raise exception 'the 0115 privileges differ from select and insert for the Outreach runtime only';
  end if;
end $$;

-- 2. Fictional fixtures: one organization; Clinic One (F1) with doctors A
-- and E (members of campaign K1) and B (no campaign); Clinic Two (F2) with
-- doctor C (member of K2). Registrations: R1 at F1 in K1 by A, R2 at F1 with
-- no campaign by B, R3 at F2 in K2 by C.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e1150000-0000-4000-8000-000000000001', 'Outreach 0115 Suite Organization', 'outreach-0115-suite-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1150000-0000-4000-8000-000000000002', 'e1150000-0000-4000-8000-000000000001', 'Outreach 0115 Clinic One',
   'OUTREACH-0115-ONE', 'Africa/Lagos', true, 'verified'),
  ('e1150000-0000-4000-8000-000000000003', 'e1150000-0000-4000-8000-000000000001', 'Outreach 0115 Clinic Two',
   'OUTREACH-0115-TWO', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
select format('e1151000-0000-4000-8000-00000000000%s', n)::uuid, 'synthetic:outreach-0115-' || m,
       format('outreach-0115-%s@example.invalid', m), 'Account display ' || upper(m), 'active'
  from (values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'e')) v(n, m);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, license_number)
select format('e1152000-0000-4000-8000-00000000000%s', n)::uuid, format('e1151000-0000-4000-8000-00000000000%s', n)::uuid,
       'Staff ' || upper(m) || ' Fictional', format('outreach-0115-%s@example.invalid', m), 'verified', 'doctor',
       'LIC-0115-' || upper(m)
  from (values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'e')) v(n, m);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role)
select format('e1153000-0000-4000-8000-00000000000%s', n)::uuid, format('e1152000-0000-4000-8000-00000000000%s', n)::uuid,
       format('e1151000-0000-4000-8000-00000000000%s', n)::uuid, 'e1150000-0000-4000-8000-000000000001',
       (case n when 3 then 'e1150000-0000-4000-8000-000000000003' else 'e1150000-0000-4000-8000-000000000002' end)::uuid,
       'doctor', 'doctor'
  from generate_series(1, 4) n;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select format('e1154000-0000-4000-8000-00000000000%s', n)::uuid, format('e1151000-0000-4000-8000-00000000000%s', n)::uuid,
       'doctor', 'facility', format('e1153000-0000-4000-8000-00000000000%s', n)::uuid,
       (case n when 3 then 'e1150000-0000-4000-8000-000000000003' else 'e1150000-0000-4000-8000-000000000002' end)::uuid,
       'Synthetic 0115 suite role'
  from generate_series(1, 4) n;
insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services,
  status, starts_at, ends_at) values
  ('e1155000-0000-4000-8000-000000000001', 'e1150000-0000-4000-8000-000000000002',
   'e1151000-0000-4000-8000-000000000001', 'e1153000-0000-4000-8000-000000000001', 'Outreach 0115 K1',
   array['registration'], 'active', clock_timestamp() - interval '1 day', null),
  ('e1155000-0000-4000-8000-000000000002', 'e1150000-0000-4000-8000-000000000003',
   'e1151000-0000-4000-8000-000000000003', 'e1153000-0000-4000-8000-000000000003', 'Outreach 0115 K2',
   array['registration'], 'active', clock_timestamp() - interval '1 day', null);
insert into outreach.campaign_members (id, campaign_id, facility_id, membership_id, role, added_by_account_id,
  added_by_membership_id) values
  ('e1156000-0000-4000-8000-000000000001', 'e1155000-0000-4000-8000-000000000001',
   'e1150000-0000-4000-8000-000000000002', 'e1153000-0000-4000-8000-000000000001', 'admin',
   'e1151000-0000-4000-8000-000000000001', 'e1153000-0000-4000-8000-000000000001'),
  ('e1156000-0000-4000-8000-000000000002', 'e1155000-0000-4000-8000-000000000001',
   'e1150000-0000-4000-8000-000000000002', 'e1153000-0000-4000-8000-000000000004', 'enumerator',
   'e1151000-0000-4000-8000-000000000001', 'e1153000-0000-4000-8000-000000000001'),
  ('e1156000-0000-4000-8000-000000000003', 'e1155000-0000-4000-8000-000000000002',
   'e1150000-0000-4000-8000-000000000003', 'e1153000-0000-4000-8000-000000000003', 'admin',
   'e1151000-0000-4000-8000-000000000003', 'e1153000-0000-4000-8000-000000000003');
insert into outreach.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id,
  local_command_id, temporary_patient_id, full_name, sex, age_years, campaign_id) values
  ('e1158000-0000-4000-8000-000000000001', 'e1150000-0000-4000-8000-000000000002',
   'e1151000-0000-4000-8000-000000000001', 'e1153000-0000-4000-8000-000000000001',
   'e1158000-0000-4000-8000-000000000011', 'tmp_e1158000-0000-4000-8000-000000000011', 'Person R1 Fictional',
   'unknown', 30, 'e1155000-0000-4000-8000-000000000001'),
  ('e1158000-0000-4000-8000-000000000002', 'e1150000-0000-4000-8000-000000000002',
   'e1151000-0000-4000-8000-000000000002', 'e1153000-0000-4000-8000-000000000002',
   'e1158000-0000-4000-8000-000000000012', 'tmp_e1158000-0000-4000-8000-000000000012', 'Person R2 Fictional',
   'female', 41, null),
  ('e1158000-0000-4000-8000-000000000003', 'e1150000-0000-4000-8000-000000000003',
   'e1151000-0000-4000-8000-000000000003', 'e1153000-0000-4000-8000-000000000003',
   'e1158000-0000-4000-8000-000000000013', 'tmp_e1158000-0000-4000-8000-000000000013', 'Person R3 Fictional',
   'male', 52, 'e1155000-0000-4000-8000-000000000002');
set local session_replication_role = origin;

-- 3. The case runner.
create temporary table outreach_0115_cases (
  seq integer generated always as identity, name text not null, expected text not null, actual text
) on commit drop;
grant select on outreach_0115_cases to public;

create function pg_temp.outreach_0115_facility(member text) returns text language sql immutable as $$
  select case member when 'c' then 'e1150000-0000-4000-8000-000000000003'
                     else 'e1150000-0000-4000-8000-000000000002' end
$$;
create function pg_temp.outreach_0115_account(member text) returns text language sql immutable as $$
  select format('e1151000-0000-4000-8000-00000000000%s',
    case member when 'a' then 1 when 'b' then 2 when 'c' then 3 else 4 end)
$$;
create function pg_temp.outreach_0115_membership(member text) returns text language sql immutable as $$
  select format('e1153000-0000-4000-8000-00000000000%s',
    case member when 'a' then 1 when 'b' then 2 when 'c' then 3 else 4 end)
$$;

-- Runs one statement that answers at most one text value, as
-- hid_outreach_api_runtime with the member's session (A, B, C or E at their
-- own clinic; '-' for no session). keep: the effect stays.
create function pg_temp.outreach_0115_try(member text, statement text, keep boolean)
returns text language plpgsql as $$
declare
  outcome text;
  answer text;
begin
  begin
    if member <> '-' then
      perform set_config('app.actor_subject', 'synthetic:outreach-0115-' || member, true),
              set_config('app.facility_id', pg_temp.outreach_0115_facility(member), true),
              set_config('app.correlation_id', 'outreach-0115-suite', true),
              set_config('app.membership_id', pg_temp.outreach_0115_membership(member), true),
              set_config('app.purpose_of_use', 'direct-care', true);
    else
      perform set_config('app.actor_subject', '', true), set_config('app.facility_id', '', true),
              set_config('app.correlation_id', '', true), set_config('app.membership_id', '', true),
              set_config('app.purpose_of_use', '', true);
    end if;
    set local role hid_outreach_api_runtime;
    execute statement into answer;
    reset role;
    outcome := coalesce(answer, '(none)');
    if not keep then raise exception using errcode = 'P0001', message = 'outreach-0115-suite: undo'; end if;
  exception when others then
    if sqlstate <> 'P0001' or sqlerrm <> 'outreach-0115-suite: undo' then
      outcome := sqlstate || ': ' || sqlerrm;
    end if;
  end;
  return outcome;
end $$;

create function pg_temp.outreach_0115_case(case_name text, expected text, member text, statement text,
  keep boolean default false)
returns void language plpgsql as $$
begin
  insert into outreach_0115_cases (name, expected, actual)
  values (case_name, expected, pg_temp.outreach_0115_try(member, statement, keep));
end $$;

-- outreach-api's visit insert (OutreachVisitsService.create), as the member
-- at their clinic unless a facility or recorder is given.
create function pg_temp.outreach_0115_visit(member text, registration_case text, key_suffix text,
  occurred_on text default null, follow_up_on text default null, referred_to text default null,
  notes text default null, kind text default 'visit', facility text default null, recorder text default null)
returns text language sql as $$
  select format($i$insert into outreach.registration_case_visits (
      registration_case_id,facility_id,kind,occurred_on,follow_up_on,referred_to,notes,
      recorded_by_account_id,recorded_by_membership_id,idempotency_key,request_sha256
    ) values (%L,%L,%L,%s,%L,%L,%L,%L,%L,%L,%L) returning 'ok'$i$,
    registration_case, coalesce(facility, pg_temp.outreach_0115_facility(member)), kind,
    coalesce(quote_literal(occurred_on) || '::date', '(clock_timestamp() at time zone ''Africa/Lagos'')::date'),
    follow_up_on, referred_to, notes,
    pg_temp.outreach_0115_account(coalesce(recorder, member)), pg_temp.outreach_0115_membership(coalesce(recorder, member)),
    'outreach-0115-visit-key-' || key_suffix, repeat('a', 64))
$$;

-- outreach-api's attempt insert (the Health ID preview).
create function pg_temp.outreach_0115_attempt(member text, registration_case text, recorder text default null)
returns text language sql as $$
  select format($i$insert into outreach.link_preview_attempts (
      registration_case_id,facility_id,requested_by_account_id,requested_by_membership_id
    ) values (%L,%L,%L,%L) returning 'ok'$i$,
    registration_case, pg_temp.outreach_0115_facility(member),
    pg_temp.outreach_0115_account(coalesce(recorder, member)), pg_temp.outreach_0115_membership(coalesce(recorder, member)))
$$;

-- 4. Visits.
select pg_temp.outreach_0115_case('member A records a visit on K1''s R1', 'ok', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'a-r1-1', '2026-10-30', '2026-11-20',
    null, E'Blood pressure checked.\nReturn in three weeks.'), true);
select pg_temp.outreach_0115_case('member A records a referral on R2 (no campaign)', 'ok', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000002', 'a-r2-1', null, null,
    'Fictional General Hospital', null, 'referral'), true);
select pg_temp.outreach_0115_case('member E records a follow-up on R1 today', 'ok', 'e',
  pg_temp.outreach_0115_visit('e', 'e1158000-0000-4000-8000-000000000001', 'e-r1-1', null, null, null, null,
    'follow_up'), true);
select pg_temp.outreach_0115_case('non-member B records a visit on K1''s R1',
  '42501: new row violates row-level security policy for table "registration_case_visits"', 'b',
  pg_temp.outreach_0115_visit('b', 'e1158000-0000-4000-8000-000000000001', 'b-r1-1'));
select pg_temp.outreach_0115_case('member A records a visit on clinic Two''s R3 at clinic One',
  '42501: new row violates row-level security policy for table "registration_case_visits"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000003', 'a-r3-1'));
select pg_temp.outreach_0115_case('member A records a visit on R3 claiming clinic Two',
  '42501: new row violates row-level security policy for table "registration_case_visits"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000003', 'a-r3-2',
    facility => 'e1150000-0000-4000-8000-000000000003'));
select pg_temp.outreach_0115_case('member A records R1''s visit at clinic Two (facility mismatch)',
  '42501: new row violates row-level security policy for table "registration_case_visits"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'a-r1-x',
    facility => 'e1150000-0000-4000-8000-000000000003'));
select pg_temp.outreach_0115_case('member A records a visit as member E',
  '42501: new row violates row-level security policy for table "registration_case_visits"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'a-r1-2', recorder => 'e'));
select pg_temp.outreach_0115_case('a visit without a session',
  '42501: new row violates row-level security policy for table "registration_case_visits"', '-',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'none-1'));
select pg_temp.outreach_0115_case('a visit dated tomorrow in Lagos',
  '23514: Outreach visit date cannot be after today in Africa/Lagos', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'a-r1-3',
    ((clock_timestamp() at time zone 'Africa/Lagos')::date + 1)::text));
select pg_temp.outreach_0115_case('a follow-up on the visit date',
  '23514: new row for relation "registration_case_visits" violates check constraint "registration_case_visits_follow_up_on_check"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'a-r1-4', '2026-10-30', '2026-10-30'));
select pg_temp.outreach_0115_case('a one-character referral place',
  '23514: new row for relation "registration_case_visits" violates check constraint "registration_case_visits_referred_to_check"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'a-r1-5', null, null, 'X'));
select pg_temp.outreach_0115_case('notes with a tab',
  '23514: new row for relation "registration_case_visits" violates check constraint "registration_case_visits_notes_check"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'a-r1-6', null, null, null, E'one\ttwo'));
select pg_temp.outreach_0115_case('notes of 1001 characters',
  '23514: new row for relation "registration_case_visits" violates check constraint "registration_case_visits_notes_check"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'a-r1-7', null, null, null, repeat('n', 1001)));
select pg_temp.outreach_0115_case('an unknown kind',
  '23514: new row for relation "registration_case_visits" violates check constraint "registration_case_visits_kind_check"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000001', 'a-r1-8', kind => 'home'));
select pg_temp.outreach_0115_case('the same Idempotency-Key again',
  '23505: duplicate key value violates unique constraint "registration_case_visits_idempotency_uq"', 'a',
  pg_temp.outreach_0115_visit('a', 'e1158000-0000-4000-8000-000000000002', 'a-r1-1'));
-- Reads go through the case.
select pg_temp.outreach_0115_case('member A reads R1''s visits', '2', 'a',
  $s$select count(*)::text from outreach.registration_case_visits
      where registration_case_id='e1158000-0000-4000-8000-000000000001'$s$);
select pg_temp.outreach_0115_case('member E reads R1''s visits', '2', 'e',
  $s$select count(*)::text from outreach.registration_case_visits
      where registration_case_id='e1158000-0000-4000-8000-000000000001'$s$);
select pg_temp.outreach_0115_case('non-member B reads R1''s visits', '0', 'b',
  $s$select count(*)::text from outreach.registration_case_visits
      where registration_case_id='e1158000-0000-4000-8000-000000000001'$s$);
select pg_temp.outreach_0115_case('B reads R2''s visits (no campaign, same clinic)', '1', 'b',
  $s$select count(*)::text from outreach.registration_case_visits
      where registration_case_id='e1158000-0000-4000-8000-000000000002'$s$);
select pg_temp.outreach_0115_case('C at clinic Two reads every visit', '0', 'c',
  $s$select count(*)::text from outreach.registration_case_visits$s$);
select pg_temp.outreach_0115_case('no session reads every visit', '0', '-',
  $s$select count(*)::text from outreach.registration_case_visits$s$);
select pg_temp.outreach_0115_case('the Lagos date and the database time are kept', 'ok', 'a',
  $s$select 'ok' from outreach.registration_case_visits
      where idempotency_key='outreach-0115-visit-key-a-r1-1' and occurred_on=date '2026-10-30'
        and follow_up_on=date '2026-11-20' and created_at <= clock_timestamp()$s$);
-- Insert-only.
select pg_temp.outreach_0115_case('the runtime updates a visit',
  '42501: permission denied for table registration_case_visits', 'a',
  $s$update outreach.registration_case_visits set notes='changed' returning 'ok'$s$);
select pg_temp.outreach_0115_case('the runtime deletes a visit',
  '42501: permission denied for table registration_case_visits', 'a',
  $s$delete from outreach.registration_case_visits returning 'ok'$s$);
select pg_temp.outreach_0115_case('the runtime locks a visit',
  '42501: permission denied for table registration_case_visits', 'a',
  $s$select 'ok' from outreach.registration_case_visits limit 1 for update$s$);

-- 5. Health ID preview attempts.
select pg_temp.outreach_0115_case('member A logs a preview on R1', 'ok', 'a',
  pg_temp.outreach_0115_attempt('a', 'e1158000-0000-4000-8000-000000000001'), true);
select pg_temp.outreach_0115_case('member A logs a preview on R2', 'ok', 'a',
  pg_temp.outreach_0115_attempt('a', 'e1158000-0000-4000-8000-000000000002'), true);
select pg_temp.outreach_0115_case('member A counts their last hour', '2', 'a',
  $s$select count(*)::text from outreach.link_preview_attempts
      where requested_by_membership_id='e1153000-0000-4000-8000-000000000001'
        and created_at > clock_timestamp() - interval '1 hour'$s$);
select pg_temp.outreach_0115_case('member E sees none of A''s attempts', '0', 'e',
  $s$select count(*)::text from outreach.link_preview_attempts$s$);
select pg_temp.outreach_0115_case('non-member B logs a preview on K1''s R1',
  '42501: new row violates row-level security policy for table "link_preview_attempts"', 'b',
  pg_temp.outreach_0115_attempt('b', 'e1158000-0000-4000-8000-000000000001'));
select pg_temp.outreach_0115_case('member A logs a preview as member E',
  '42501: new row violates row-level security policy for table "link_preview_attempts"', 'a',
  pg_temp.outreach_0115_attempt('a', 'e1158000-0000-4000-8000-000000000001', 'e'));
select pg_temp.outreach_0115_case('member A logs a preview on clinic Two''s R3',
  '42501: new row violates row-level security policy for table "link_preview_attempts"', 'a',
  pg_temp.outreach_0115_attempt('a', 'e1158000-0000-4000-8000-000000000003'));
select pg_temp.outreach_0115_case('the runtime deletes its attempts',
  '42501: permission denied for table link_preview_attempts', 'a',
  $s$delete from outreach.link_preview_attempts returning 'ok'$s$);
select pg_temp.outreach_0115_case('the attempt log has no Health ID column', '(none)', 'a',
  $s$select string_agg(attname, ',') from pg_attribute
      where attrelid='outreach.link_preview_attempts'::regclass and attnum > 0 and not attisdropped
        and attname ~* '(hid|health|name|phone)'$s$);

-- 6. Names, under the owner as migrated, then under an owner that does not
-- bypass row-level security.
create function pg_temp.outreach_0115_name_cases(phase text) returns void language plpgsql as $$
begin
  perform pg_temp.outreach_0115_case(phase || ': member A names memberships A, B, C, E', 'Staff A Fictional|Staff E Fictional', 'a',
    $s$select string_agg(display_name, '|' order by display_name) from outreach.member_display_names(array[
        'e1153000-0000-4000-8000-000000000001','e1153000-0000-4000-8000-000000000002',
        'e1153000-0000-4000-8000-000000000003','e1153000-0000-4000-8000-000000000004']::uuid[])$s$);
  perform pg_temp.outreach_0115_case(phase || ': the answer is the id and the name only', 'e1153000-0000-4000-8000-000000000004=Staff E Fictional', 'a',
    $s$select string_agg(row_to_json(n)::jsonb ->> 'membership_id' || '=' || (row_to_json(n)::jsonb ->> 'display_name'), ',')
        from outreach.member_display_names(array['e1153000-0000-4000-8000-000000000004']::uuid[]) n
       where (select count(*) from jsonb_object_keys(row_to_json(n)::jsonb)) = 2$s$);
  perform pg_temp.outreach_0115_case(phase || ': B (no campaign) names A and E', '(none)', 'b',
    $s$select string_agg(display_name, '|') from outreach.member_display_names(array[
        'e1153000-0000-4000-8000-000000000001','e1153000-0000-4000-8000-000000000004']::uuid[])$s$);
  perform pg_temp.outreach_0115_case(phase || ': C at clinic Two names A and C', 'Staff C Fictional', 'c',
    $s$select string_agg(display_name, '|') from outreach.member_display_names(array[
        'e1153000-0000-4000-8000-000000000001','e1153000-0000-4000-8000-000000000003']::uuid[])$s$);
  perform pg_temp.outreach_0115_case(phase || ': no session names A', '(none)', '-',
    $s$select string_agg(display_name, '|') from outreach.member_display_names(array[
        'e1153000-0000-4000-8000-000000000001']::uuid[])$s$);
  perform pg_temp.outreach_0115_case(phase || ': 201 membership ids', '22023: Between 0 and 200 membership ids are required', 'a',
    $s$select string_agg(display_name, '|') from outreach.member_display_names(
        array(select gen_random_uuid() from generate_series(1, 201)))$s$);
  perform pg_temp.outreach_0115_case(phase || ': 200 membership ids', '1', 'a',
    $s$select count(*)::text from outreach.member_display_names(
        array(select gen_random_uuid() from generate_series(1, 199))
        || 'e1153000-0000-4000-8000-000000000001'::uuid)$s$);
  perform pg_temp.outreach_0115_case(phase || ': member A names the registrars of R1, R2, R3',
    'e1158000-0000-4000-8000-000000000001=Staff A Fictional|e1158000-0000-4000-8000-000000000002=Staff B Fictional', 'a',
    $s$select string_agg(registration_case_id || '=' || display_name, '|' order by registration_case_id)
        from outreach.case_registrar_names(array['e1158000-0000-4000-8000-000000000001',
          'e1158000-0000-4000-8000-000000000002','e1158000-0000-4000-8000-000000000003']::uuid[])$s$);
  perform pg_temp.outreach_0115_case(phase || ': non-member B names the registrars of R1, R2',
    'e1158000-0000-4000-8000-000000000002=Staff B Fictional', 'b',
    $s$select string_agg(registration_case_id || '=' || display_name, '|' order by registration_case_id)
        from outreach.case_registrar_names(array['e1158000-0000-4000-8000-000000000001',
          'e1158000-0000-4000-8000-000000000002']::uuid[])$s$);
  perform pg_temp.outreach_0115_case(phase || ': C names the registrars of R1, R3',
    'e1158000-0000-4000-8000-000000000003=Staff C Fictional', 'c',
    $s$select string_agg(registration_case_id || '=' || display_name, '|' order by registration_case_id)
        from outreach.case_registrar_names(array['e1158000-0000-4000-8000-000000000001',
          'e1158000-0000-4000-8000-000000000003']::uuid[])$s$);
  perform pg_temp.outreach_0115_case(phase || ': no session names a registrar', '(none)', '-',
    $s$select string_agg(display_name, '|') from outreach.case_registrar_names(array[
        'e1158000-0000-4000-8000-000000000002']::uuid[])$s$);
  perform pg_temp.outreach_0115_case(phase || ': 201 case ids', '22023: Between 0 and 200 registration case ids are required', 'a',
    $s$select string_agg(display_name, '|') from outreach.case_registrar_names(
        array(select gen_random_uuid() from generate_series(1, 201)))$s$);
end $$;

select pg_temp.outreach_0115_name_cases('as migrated');

do $$
declare
  owner_role oid := (select proowner from pg_proc where oid = 'outreach.member_display_names(uuid[])'::regprocedure);
begin
  if (select rolsuper or rolbypassrls from pg_roles where oid = owner_role) then
    create role outreach_0115_suite_owner nologin nosuperuser nobypassrls noinherit;
    grant usage on schema outreach, platform, auth, identity to outreach_0115_suite_owner;
    grant select on identity.staff, identity.staff_facility_memberships, outreach.registration_cases,
      outreach.campaign_members to outreach_0115_suite_owner;
    grant execute on function outreach.context_allows(uuid, text), outreach.registration_campaign_member(uuid, uuid),
      platform.current_facility_id(), platform.current_membership_id() to outreach_0115_suite_owner;
    alter function outreach.member_display_names(uuid[]) owner to outreach_0115_suite_owner;
    alter function outreach.case_registrar_names(uuid[]) owner to outreach_0115_suite_owner;
    raise notice 'outreach-visits: the name readers are lent to outreach_0115_suite_owner (owner % bypasses RLS)',
      owner_role::regrole;
  else
    raise notice 'outreach-visits: the name readers run as their owner %', owner_role::regrole;
  end if;
  if exists (select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
              where p.oid in ('outreach.member_display_names(uuid[])'::regprocedure,
                              'outreach.case_registrar_names(uuid[])'::regprocedure)
                and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'the name readers must now run under an owner that does not bypass RLS';
  end if;
end $$;

select pg_temp.outreach_0115_name_cases('owner without BYPASSRLS');

-- 7. Every case as expected.
do $$
declare
  failures text;
  total integer;
begin
  select string_agg(format('#%s %s: expected [%s], got [%s]', seq, name, expected, coalesce(actual, 'null')),
           E'\n' order by seq), (select count(*) from outreach_0115_cases)
    into failures, total
    from outreach_0115_cases where actual is distinct from expected;
  if failures is not null then
    raise exception E'Outreach visits suite failed:\n%', failures;
  end if;
  raise notice 'Outreach visits suite: % cases passed', total;
end $$;

-- 8. Kept: the three visits and two attempts, and an append-only refusal
-- even for the superuser or owner running this suite.
do $$
begin
  if (select count(*) from outreach.registration_case_visits
       where idempotency_key like 'outreach-0115-visit-key-%') <> 3
     or (select count(*) from outreach.link_preview_attempts
          where registration_case_id::text like 'e1158000-0000-4000-8000-%') <> 2 then
    raise exception 'outreach-visits: the kept rows are not exactly three visits and two attempts';
  end if;
  begin
    update outreach.registration_case_visits set notes = 'changed'
     where idempotency_key = 'outreach-0115-visit-key-a-r1-1';
    raise exception 'outreach-visits: a visit was updated';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'outreach.registration_case_visits is append-only' then raise; end if;
  end;
  begin
    delete from outreach.link_preview_attempts where registration_case_id = 'e1158000-0000-4000-8000-000000000001';
    raise exception 'outreach-visits: an attempt was deleted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'outreach.link_preview_attempts is append-only' then raise; end if;
  end;
end $$;

rollback;
