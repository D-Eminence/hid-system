\set ON_ERROR_STOP on
-- Outreach campaigns are managed by their own admins (0111, ADR-045 option B).
-- Rollback-only. Fictional staff, facilities and campaigns only.
--
-- Fixtures are inserted with session_replication_role = replica. Every case then
-- runs as hid_outreach_api_runtime, with every trigger and RLS policy, under the
-- session outreach-api sets (actor subject, facility, membership, direct care).
-- Each case records its outcome ('ok', a row count, the rows a function
-- answered, or the SQLSTATE and message raised) and the suite fails at the end
-- listing every case whose outcome differs.
begin;

-- 1. The function, policies and trigger as 0111 makes them.
do $$
begin
  if to_regprocedure('outreach.campaign_staff(uuid)') is null
     or (select count(*) from pg_policy
          where polrelid = 'outreach.campaign_members'::regclass and not polpermissive
            and polname in ('outreach_campaign_members_admin_create', 'outreach_campaign_members_admin_delete')) <> 2
     or not exists (select 1 from pg_proc where oid = 'outreach.validate_campaign_write()'::regprocedure
                     and prosrc like '%Outreach campaign admin is required%') then
    raise exception 'the campaign admin rules are not as 0111 makes them';
  end if;
end $$;

-- 2. Fixtures. Clinic K (ca00...02) and another clinic L (...03). Staff A, B, E,
-- N and X at K, and Y at L; each with a facility-scoped doctor role, which
-- carries outreach.campaign.read and .write. X's membership is inactive.
-- C1 (ca07...01): planned, created by A; A admin, B enumerator.
-- C2 (...02): planned, created by E; E admin.
-- C4 (...04): planned, created by A; B admin, A not a member.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('ca000000-0000-4000-8000-000000000001', 'Campaign Admin Test Organization', 'campaign-admin-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('ca000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001', 'Campaign Admin Clinic K',
   'CAMPAIGN-ADMIN-K', 'Africa/Lagos', true, 'verified'),
  ('ca000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'Campaign Admin Clinic L',
   'CAMPAIGN-ADMIN-L', 'Africa/Lagos', true, 'verified');
create temporary table campaign_people (
  n integer primary key, letter text not null, facility uuid not null, active boolean not null
) on commit drop;
insert into campaign_people values
  (1, 'a', 'ca000000-0000-4000-8000-000000000002', true),
  (2, 'b', 'ca000000-0000-4000-8000-000000000002', true),
  (5, 'e', 'ca000000-0000-4000-8000-000000000002', true),
  (6, 'n', 'ca000000-0000-4000-8000-000000000002', true),
  (7, 'x', 'ca000000-0000-4000-8000-000000000002', false),
  (8, 'y', 'ca000000-0000-4000-8000-000000000003', true);
insert into auth.accounts (id, subject, email, display_name, status)
select ('ca010000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:campaign-admin-' || letter,
       'campaign-admin-' || letter || '@example.invalid', 'Campaign Admin ' || upper(letter), 'active'
  from campaign_people;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('ca020000-0000-4000-8000-00000000000' || n)::uuid, ('ca010000-0000-4000-8000-00000000000' || n)::uuid,
       'Campaign Person ' || upper(letter), 'campaign-admin-' || letter || '@example.invalid', 'verified', 'doctor'
  from campaign_people;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, active)
select ('ca030000-0000-4000-8000-00000000000' || n)::uuid, ('ca020000-0000-4000-8000-00000000000' || n)::uuid,
       ('ca010000-0000-4000-8000-00000000000' || n)::uuid, 'ca000000-0000-4000-8000-000000000001', facility,
       'doctor', 'doctor', active
  from campaign_people;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('ca040000-0000-4000-8000-00000000000' || n)::uuid, ('ca010000-0000-4000-8000-00000000000' || n)::uuid,
       'doctor', 'facility', ('ca030000-0000-4000-8000-00000000000' || n)::uuid, facility, 'Synthetic campaign admin role'
  from campaign_people;
insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services,
  starts_at) values
  ('ca070000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
   'ca010000-0000-4000-8000-000000000001', 'ca030000-0000-4000-8000-000000000001', 'Campaign One',
   array['registration']::text[], clock_timestamp() - interval '1 day'),
  ('ca070000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000002',
   'ca010000-0000-4000-8000-000000000005', 'ca030000-0000-4000-8000-000000000005', 'Campaign Two',
   array['registration']::text[], clock_timestamp() - interval '1 day'),
  ('ca070000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-000000000002',
   'ca010000-0000-4000-8000-000000000001', 'ca030000-0000-4000-8000-000000000001', 'Campaign Four',
   array['registration']::text[], clock_timestamp() - interval '1 day');
insert into outreach.campaign_members (id, campaign_id, facility_id, membership_id, role, added_by_account_id,
  added_by_membership_id) values
  ('ca080000-0000-4000-8000-000000000001', 'ca070000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
   'ca030000-0000-4000-8000-000000000001', 'admin', 'ca010000-0000-4000-8000-000000000001', 'ca030000-0000-4000-8000-000000000001'),
  ('ca080000-0000-4000-8000-000000000002', 'ca070000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
   'ca030000-0000-4000-8000-000000000002', 'enumerator', 'ca010000-0000-4000-8000-000000000001', 'ca030000-0000-4000-8000-000000000001'),
  ('ca080000-0000-4000-8000-000000000005', 'ca070000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000002',
   'ca030000-0000-4000-8000-000000000005', 'admin', 'ca010000-0000-4000-8000-000000000005', 'ca030000-0000-4000-8000-000000000005'),
  ('ca080000-0000-4000-8000-000000000004', 'ca070000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-000000000002',
   'ca030000-0000-4000-8000-000000000002', 'admin', 'ca010000-0000-4000-8000-000000000001', 'ca030000-0000-4000-8000-000000000001');
set local session_replication_role = origin;

create temporary table campaign_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on campaign_cases to public;
grant usage on sequence campaign_cases_seq_seq to public;

-- Runs statement as hid_outreach_api_runtime in member n's full session at
-- clinic K (or at facility): 'ok', 'rows <n>' for a DELETE or UPDATE, the rows a
-- query answered joined by ' | ', or the SQLSTATE and message it raised. With
-- keep = false a successful statement is undone.
create function pg_temp.campaign_try(member integer, statement text, keep boolean, kind text,
  facility text default 'ca000000-0000-4000-8000-000000000002') returns text language plpgsql as $$
declare outcome text; affected bigint;
begin
  perform set_config('app.actor_subject', 'synthetic:campaign-admin-' || (select letter from pg_temp.campaign_people where n = member), true),
          set_config('app.facility_id', facility, true),
          set_config('app.correlation_id', 'campaign-admin-suite', true),
          set_config('app.membership_id', 'ca030000-0000-4000-8000-00000000000' || member, true),
          set_config('app.purpose_of_use', 'direct-care', true);
  set local role hid_outreach_api_runtime;
  begin
    if kind = 'query' then
      execute format('select coalesce(string_agg(row_text, %L), %L) from (%s) answered(row_text)', ' | ', 'none', statement)
        into outcome;
    else
      execute statement;
      get diagnostics affected = row_count;
      outcome := case when kind = 'count' then 'rows ' || affected else 'ok' end;
    end if;
    if not keep then raise exception using errcode = 'P0001', message = 'campaign-admin-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'campaign-admin-suite: undo' then outcome := sqlstate || ': ' || sqlerrm; end if;
  end;
  reset role;
  return outcome;
end $$;
create function pg_temp.campaign_case(case_name text, member integer, expected text, statement text,
  keep boolean default false, kind text default 'statement',
  facility text default 'ca000000-0000-4000-8000-000000000002') returns void language plpgsql as $$
begin
  insert into pg_temp.campaign_cases (name, expected, actual)
  values (case_name, expected, pg_temp.campaign_try(member, statement, keep, kind, facility));
end $$;
create function pg_temp.status(campaign text, next_status text) returns text language sql as $$
  select format('update outreach.campaigns set status=%L,row_version=row_version+1 where id=%L and facility_id=%L',
    next_status, campaign, 'ca000000-0000-4000-8000-000000000002')
$$;
create function pg_temp.add_member(campaign text, member integer, role text, by_member integer) returns text language sql as $$
  select format($s$insert into outreach.campaign_members
      (campaign_id,facility_id,membership_id,role,added_by_account_id,added_by_membership_id)
      values (%L,%L,%L,%L,%L,%L)$s$, campaign, 'ca000000-0000-4000-8000-000000000002',
    'ca030000-0000-4000-8000-00000000000' || member, role,
    'ca010000-0000-4000-8000-00000000000' || by_member, 'ca030000-0000-4000-8000-00000000000' || by_member)
$$;
create function pg_temp.staff_of(campaign text) returns text language sql as $$
  select format('select display_name || %L || coalesce(campaign_role, %L) from outreach.campaign_staff(%L)',
    ' ', '-', campaign)
$$;
grant execute on function pg_temp.status(text, text), pg_temp.add_member(text, integer, text, integer),
  pg_temp.staff_of(text) to public;

-- 3. Opening and closing: only the campaign's own admins.
select pg_temp.campaign_case('1a admin A opens C1', 1, 'rows 1', pg_temp.status('ca070000-0000-4000-8000-000000000001', 'active'), false, 'count');
select pg_temp.campaign_case('1b enumerator B may not open C1', 2, '42501: Outreach campaign admin is required',
  pg_temp.status('ca070000-0000-4000-8000-000000000001', 'active'), false, 'count');
select pg_temp.campaign_case('1c non-member E may not open C1', 5, '42501: Outreach campaign admin is required',
  pg_temp.status('ca070000-0000-4000-8000-000000000001', 'active'), false, 'count');
select pg_temp.campaign_case('1d A, admin of C1, may not close E''s C2', 1, '42501: Outreach campaign admin is required',
  pg_temp.status('ca070000-0000-4000-8000-000000000002', 'closed'), false, 'count');
select pg_temp.campaign_case('1e the creator A, no longer an admin of C4, may not close it', 1,
  '42501: Outreach campaign admin is required', pg_temp.status('ca070000-0000-4000-8000-000000000004', 'closed'), false, 'count');
select pg_temp.campaign_case('1f B, admin of C4, closes it', 2, 'rows 1',
  pg_temp.status('ca070000-0000-4000-8000-000000000004', 'closed'), false, 'count');
select pg_temp.campaign_case('1g another clinic''s session changes nothing of C1', 8, 'rows 0',
  pg_temp.status('ca070000-0000-4000-8000-000000000001', 'active'), false, 'count', 'ca000000-0000-4000-8000-000000000003');

-- 4. A member registering into a campaign locks it FOR SHARE: no trigger fires,
-- so the admin rule does not stand in the way (0045's capture path).
select pg_temp.campaign_case('2a enumerator B locks C1 for share', 2, 'rows 1',
  'select 1 from outreach.campaigns where id = ''ca070000-0000-4000-8000-000000000001'' for share', false, 'count');

-- 5. Adding members: only the campaign's own admins; its creator seeds themself.
select pg_temp.campaign_case('3a admin A adds N to C1', 1, 'ok',
  pg_temp.add_member('ca070000-0000-4000-8000-000000000001', 6, 'health_worker', 1));
select pg_temp.campaign_case('3b admin A adds E to C1 as a second admin', 1, 'ok',
  pg_temp.add_member('ca070000-0000-4000-8000-000000000001', 5, 'admin', 1));
select pg_temp.campaign_case('3c enumerator B may not add N to C1', 2,
  '42501: new row violates row-level security policy "outreach_campaign_members_admin_create" for table "campaign_members"',
  pg_temp.add_member('ca070000-0000-4000-8000-000000000001', 6, 'enumerator', 2));
select pg_temp.campaign_case('3d non-member E may not add themself to C1 as admin', 5,
  '42501: new row violates row-level security policy "outreach_campaign_members_admin_create" for table "campaign_members"',
  pg_temp.add_member('ca070000-0000-4000-8000-000000000001', 5, 'admin', 5));
select pg_temp.campaign_case('3e enumerator B may not make themself an admin of C1', 2,
  '42501: new row violates row-level security policy "outreach_campaign_members_admin_create" for table "campaign_members"',
  pg_temp.add_member('ca070000-0000-4000-8000-000000000001', 2, 'admin', 2));
select pg_temp.campaign_case('3f creator A may not seed themself into C4, which has members', 1,
  '42501: new row violates row-level security policy "outreach_campaign_members_admin_create" for table "campaign_members"',
  pg_temp.add_member('ca070000-0000-4000-8000-000000000004', 1, 'admin', 1));
select pg_temp.campaign_case('3g E creates C3 and seeds themself as its admin', 5, 'ok',
  format($s$with created as (
      insert into outreach.campaigns (id,facility_id,created_by_account_id,created_by_membership_id,name,services,starts_at)
      values (%L,%L,%L,%L,'Campaign Three',array['registration']::text[],clock_timestamp()) returning id)
    select 1 from created$s$, 'ca070000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000002',
    'ca010000-0000-4000-8000-000000000005', 'ca030000-0000-4000-8000-000000000005')
  || '; ' || pg_temp.add_member('ca070000-0000-4000-8000-000000000003', 5, 'admin', 5));
select pg_temp.campaign_case('3h E may not seed someone else as C3''s first admin', 5,
  '42501: new row violates row-level security policy "outreach_campaign_members_admin_create" for table "campaign_members"',
  format($s$insert into outreach.campaigns (id,facility_id,created_by_account_id,created_by_membership_id,name,services,starts_at)
      values (%L,%L,%L,%L,'Campaign Three',array['registration']::text[],clock_timestamp())$s$,
    'ca070000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000002',
    'ca010000-0000-4000-8000-000000000005', 'ca030000-0000-4000-8000-000000000005')
  || '; ' || pg_temp.add_member('ca070000-0000-4000-8000-000000000003', 6, 'admin', 5));
-- No API command removes a member; the database lets only an admin do it.
select pg_temp.campaign_case('3i enumerator B removes no member of C1', 2, 'rows 0',
  'delete from outreach.campaign_members where campaign_id = ''ca070000-0000-4000-8000-000000000001''', false, 'count');
select pg_temp.campaign_case('3j admin A may remove B from C1', 1, 'rows 1',
  'delete from outreach.campaign_members where id = ''ca080000-0000-4000-8000-000000000002''', false, 'count');

-- 6. Who is in a campaign, and who could be added.
select pg_temp.campaign_case('4a admin A: the members, then the active staff who could be added', 1,
  'Campaign Person A admin | Campaign Person B enumerator | Campaign Person E - | Campaign Person N -',
  pg_temp.staff_of('ca070000-0000-4000-8000-000000000001'), false, 'query');
select pg_temp.campaign_case('4b enumerator B: the members only', 2,
  'Campaign Person A admin | Campaign Person B enumerator',
  pg_temp.staff_of('ca070000-0000-4000-8000-000000000001'), false, 'query');
select pg_temp.campaign_case('4c non-member E: no one', 5, 'none',
  pg_temp.staff_of('ca070000-0000-4000-8000-000000000001'), false, 'query');
select pg_temp.campaign_case('4d another clinic''s session: no one', 8, 'none',
  pg_temp.staff_of('ca070000-0000-4000-8000-000000000001'), false, 'query', 'ca000000-0000-4000-8000-000000000003');
select pg_temp.campaign_case('4e an unknown campaign: no one', 1, 'none',
  pg_temp.staff_of('ca07ffff-0000-4000-8000-000000000001'), false, 'query');

-- 7. Who may call campaign_staff: Outreach alone.
do $$
declare outcome text;
begin
  set local role hid_ehr_runtime;
  begin
    perform * from outreach.campaign_staff('ca070000-0000-4000-8000-000000000001');
    outcome := 'ok';
  exception when others then outcome := sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  insert into pg_temp.campaign_cases (name, expected, actual)
  values ('5a the EHR runtime may not call campaign_staff', '42501: permission denied for schema outreach', outcome);
end $$;

-- 8. Result.
do $$
declare failed text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, coalesce(actual, 'null')), E'\n' order by seq)
    into failed from pg_temp.campaign_cases where actual is distinct from expected;
  if failed is not null then
    raise exception E'Outreach campaign admin suite failed:\n%', failed;
  end if;
  raise notice 'Outreach campaign admin suite: % cases passed', (select count(*) from pg_temp.campaign_cases);
end $$;

rollback;
