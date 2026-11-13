-- 0121: the two registration read policies and identity.outreach_registration_health_ids_for check each session
-- condition once per query; who can see which row is exactly as before. Fictional data, rolled back.
--
-- For every actor below (an organiser, a volunteer, a volunteer removed from the campaign, a member whose membership
-- is deactivated, another group's volunteer, a suspended group's organiser, a hospital nurse, wrong purpose, wrong
-- facility, no session, a retention run) and every runtime role that may read registrations, the suite compares:
--   the rows the new policies admit  =  the rows the pre-0121 policy expressions admit, evaluated by the same role
--   with the same session over a plain copy of the fixture rows (outreach.context_allows,
--   outreach.registration_campaign_member and outreach.privileged_run_active, exactly as 0045/0116 wrote them);
--   the Health IDs 0121's lookup answers = what 0120's rules answer (the same functions, per row);
--   outreach-api's list without the repeated campaign-member filter = with it.
-- And it names the expected rows for the cases the owner asked for.
\set ON_ERROR_STOP 1
begin;

-- 0. The form 0121 left.
do $$
begin
  if exists (select 1 from pg_policy where polrelid = 'outreach.registration_cases'::regclass
              and polname in ('outreach_registration_cases_read', 'outreach_registration_campaign_read')
              and pg_get_expr(polqual, polrelid) like '%registration_campaign_member%')
     or not exists (select 1 from pg_policy where polrelid = 'outreach.registration_cases'::regclass
                     and polname = 'outreach_registration_campaign_read' and not polpermissive
                     and pg_get_expr(polqual, polrelid) like '%session_campaign_pairs()%')
     or not exists (select 1 from pg_proc pairs join pg_proc member on member.oid = 'outreach.registration_campaign_member(uuid,uuid)'::regprocedure
                     where pairs.oid = 'outreach.session_campaign_pairs()'::regprocedure and pairs.prosecdef
                       and pairs.proowner = member.proowner and pairs.proconfig = member.proconfig)
     or has_function_privilege('public', 'outreach.session_campaign_pairs()', 'EXECUTE')
     or not has_function_privilege('hid_outreach_runtime', 'outreach.session_campaign_pairs()', 'EXECUTE') then
    raise exception '0121: the read policies or outreach.session_campaign_pairs are not as 0121 wrote them';
  end if;
end $$;

-- 1. Fixtures. G: an outreach group (campaigns A and B); H: another outreach group (campaign C); S: a suspended
-- outreach group (campaign D); K: a hospital (campaign E). People (n): 1 G organiser (A, B), 2 G volunteer (A),
-- 3 G volunteer removed from A, 4 G member deactivated (still listed in A), 5 H volunteer (C), 6 S organiser (D),
-- 7 K nurse (E). Registrations: a1 a2 b1 g0 (no campaign) ar (A, redacted) at G; c1 h0 at H; d1 at S; e1 k0 at K.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('7f000000-0000-4000-8000-000000000001', 'Read Once Group G', 'read-once-group-g'),
  ('7f000000-0000-4000-8000-000000000011', 'Read Once Group H', 'read-once-group-h'),
  ('7f000000-0000-4000-8000-000000000021', 'Read Once Group S', 'read-once-group-s'),
  ('7f000000-0000-4000-8000-000000000031', 'Read Once Hospital K', 'read-once-hospital-k');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
select ('7f000000-0000-4000-8000-0000000000' || n)::uuid, ('7f000000-0000-4000-8000-0000000000' || o)::uuid, name, code,
  'Africa/Lagos', true, 'verified'
  from (values ('02', '01', 'Read Once Group G', 'READONCE-G'), ('12', '11', 'Read Once Group H', 'READONCE-H'),
               ('22', '21', 'Read Once Group S', 'READONCE-S'), ('32', '31', 'Read Once Hospital K', 'READONCE-K')) v(n, o, name, code);
create temporary table ro_people (n integer primary key, facility uuid, organization uuid, role text, active boolean) on commit drop;
insert into ro_people values
  (1, '7f000000-0000-4000-8000-000000000002', '7f000000-0000-4000-8000-000000000001', 'outreach_organiser', true),
  (2, '7f000000-0000-4000-8000-000000000002', '7f000000-0000-4000-8000-000000000001', 'outreach_volunteer', true),
  (3, '7f000000-0000-4000-8000-000000000002', '7f000000-0000-4000-8000-000000000001', 'outreach_volunteer', true),
  (4, '7f000000-0000-4000-8000-000000000002', '7f000000-0000-4000-8000-000000000001', 'outreach_volunteer', false),
  (5, '7f000000-0000-4000-8000-000000000012', '7f000000-0000-4000-8000-000000000011', 'outreach_volunteer', true),
  (6, '7f000000-0000-4000-8000-000000000022', '7f000000-0000-4000-8000-000000000021', 'outreach_organiser', true),
  (7, '7f000000-0000-4000-8000-000000000032', '7f000000-0000-4000-8000-000000000031', 'nurse', true);
insert into auth.accounts (id, subject, email, display_name, status)
select ('7f010000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:read-once-' || n, 'read-once-' || n || '@example.invalid',
  'Read Once Person ' || n, 'active' from ro_people;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('7f020000-0000-4000-8000-00000000000' || n)::uuid, ('7f010000-0000-4000-8000-00000000000' || n)::uuid,
  'Read Once Person ' || n, 'read-once-' || n || '@example.invalid', 'verified', role from ro_people;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id, membership_role,
  app_role, is_primary, active)
select ('7f030000-0000-4000-8000-00000000000' || n)::uuid, ('7f020000-0000-4000-8000-00000000000' || n)::uuid,
  ('7f010000-0000-4000-8000-00000000000' || n)::uuid, organization, facility, role, role, true, active from ro_people;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('7f010000-0000-4000-8000-00000000000' || n)::uuid, role, 'facility',
  ('7f030000-0000-4000-8000-00000000000' || n)::uuid, facility, 'Synthetic 0121 suite role' from ro_people;
insert into identity.outreach_organisations (organization_id, facility_id, kind, display_name, organiser_account_id,
  contact_phone_lookup_hmac, contact_phone_ciphertext, contact_key_version, origin, terms_version, terms_accepted_at, status,
  suspended_at, suspended_by_account_id, suspension_reason)
select organization, facility, 'group', 'Read Once ' || n, ('7f010000-0000-4000-8000-00000000000' || n)::uuid,
  repeat(n::text, 64), decode(repeat('ab', 32), 'hex'), 'k1', 'existing_account', '2026-11-01', clock_timestamp(),
  case when n = 6 then 'suspended' else 'active' end, case when n = 6 then clock_timestamp() end,
  case when n = 6 then '7f010000-0000-4000-8000-000000000001'::uuid end, case when n = 6 then 'Synthetic suspension' end
  from ro_people where n in (1, 5, 6);
create temporary table ro_campaigns (label text primary key, id uuid, facility uuid) on commit drop;
insert into ro_campaigns values
  ('A', '7f070000-0000-4000-8000-00000000000a', '7f000000-0000-4000-8000-000000000002'),
  ('B', '7f070000-0000-4000-8000-00000000000b', '7f000000-0000-4000-8000-000000000002'),
  ('C', '7f070000-0000-4000-8000-00000000000c', '7f000000-0000-4000-8000-000000000012'),
  ('D', '7f070000-0000-4000-8000-00000000000d', '7f000000-0000-4000-8000-000000000022'),
  ('E', '7f070000-0000-4000-8000-00000000000e', '7f000000-0000-4000-8000-000000000032');
insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services, status, starts_at, updated_at)
select id, facility, '7f010000-0000-4000-8000-000000000001', '7f030000-0000-4000-8000-000000000001', 'Read Once ' || label,
  array['registration'], 'active', now() - interval '1 day', now() from ro_campaigns;
insert into outreach.campaign_members (campaign_id, facility_id, membership_id, role, added_by_account_id, added_by_membership_id)
select c.id, c.facility, ('7f030000-0000-4000-8000-00000000000' || m.n)::uuid, m.role,
  '7f010000-0000-4000-8000-000000000001', '7f030000-0000-4000-8000-000000000001'
  from (values ('A', 1, 'admin'), ('B', 1, 'admin'), ('A', 2, 'enumerator'), ('A', 4, 'enumerator'), ('C', 5, 'admin'),
               ('D', 6, 'admin'), ('E', 7, 'admin')) m(campaign, n, role)
  join ro_campaigns c on c.label = m.campaign;
create temporary table ro_cases (label text primary key, id uuid, facility uuid, campaign text, creator integer) on commit drop;
insert into ro_cases values
  ('a1', '7f080000-0000-4000-8000-0000000000a1', '7f000000-0000-4000-8000-000000000002', 'A', 2),
  ('a2', '7f080000-0000-4000-8000-0000000000a2', '7f000000-0000-4000-8000-000000000002', 'A', 2),
  ('ar', '7f080000-0000-4000-8000-0000000000a3', '7f000000-0000-4000-8000-000000000002', 'A', 2),
  ('b1', '7f080000-0000-4000-8000-0000000000b1', '7f000000-0000-4000-8000-000000000002', 'B', 1),
  ('g0', '7f080000-0000-4000-8000-0000000000c0', '7f000000-0000-4000-8000-000000000002', null, 1),
  ('c1', '7f080000-0000-4000-8000-0000000000d1', '7f000000-0000-4000-8000-000000000012', 'C', 5),
  ('h0', '7f080000-0000-4000-8000-0000000000d0', '7f000000-0000-4000-8000-000000000012', null, 5),
  ('d1', '7f080000-0000-4000-8000-0000000000e1', '7f000000-0000-4000-8000-000000000022', 'D', 6),
  ('e1', '7f080000-0000-4000-8000-0000000000f1', '7f000000-0000-4000-8000-000000000032', 'E', 7),
  ('k0', '7f080000-0000-4000-8000-0000000000f0', '7f000000-0000-4000-8000-000000000032', null, 7);
insert into outreach.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, local_command_id,
  temporary_patient_id, full_name, sex, age_years, phone, campaign_id)
select r.id, r.facility, ('7f010000-0000-4000-8000-00000000000' || r.creator)::uuid,
  ('7f030000-0000-4000-8000-00000000000' || r.creator)::uuid, gen_random_uuid(), 'tmp_' || gen_random_uuid(),
  'Read Once ' || r.label, 'female', 30, null, c.id
  from ro_cases r left join ro_campaigns c on c.label = r.campaign;
insert into outreach.registration_redactions (registration_case_id, facility_id, campaign_id, kind, reason, requested_by_account_id, correlation_id)
values ('7f080000-0000-4000-8000-0000000000a3', '7f000000-0000-4000-8000-000000000002', '7f070000-0000-4000-8000-00000000000a',
        'request', 'Synthetic redaction', '7f010000-0000-4000-8000-000000000001', 'read-once-suite');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, source_system, status)
select ('7f050000-0000-4000-8000-0000000000' || right(r.id::text, 2))::uuid, 'HID-RDNCE' || translate(upper(r.label), '01', 'XY'), 'Read', 'Once',
  'Read Once ' || r.label, 'female', 'read-once-suite', 'active'
  from ro_cases r where r.label in ('a1', 'ar', 'b1', 'c1', 'd1', 'e1');
insert into identity.outreach_registration_health_ids (registration_case_id, facility_id, patient_id, account_id, hid_code,
  challenge_id, created_via, possible_duplicate, created_by_account_id, created_by_membership_id)
select r.id, r.facility, ('7f050000-0000-4000-8000-0000000000' || right(r.id::text, 2))::uuid, null, 'HID-RDNCE' || translate(upper(r.label), '01', 'XY'),
  null, 'unclaimed', false, ('7f010000-0000-4000-8000-00000000000' || r.creator)::uuid,
  ('7f030000-0000-4000-8000-00000000000' || r.creator)::uuid
  from ro_cases r where r.label in ('a1', 'ar', 'b1', 'c1', 'd1', 'e1');
set local session_replication_role = origin;

-- A plain copy of the fixture rows: the reference evaluates the pre-0121 expressions over it.
create temporary table ro_plain on commit drop as
  select c.id, c.facility_id, c.campaign_id, l.label from outreach.registration_cases c join ro_cases l on l.id = c.id;
create temporary table ro_plain_links on commit drop as
  select link.registration_case_id, link.facility_id, link.hid_code, link.created_via
    from identity.outreach_registration_health_ids link join ro_cases l on l.id = link.registration_case_id;
grant select on ro_plain, ro_plain_links, ro_cases to public;

create temporary table ro_sessions (label text primary key, n integer, facility text, purpose text, retention boolean) on commit drop;
insert into ro_sessions values
  ('G organiser', 1, '7f000000-0000-4000-8000-000000000002', 'direct-care', false),
  ('G volunteer in A', 2, '7f000000-0000-4000-8000-000000000002', 'direct-care', false),
  ('G volunteer removed from A', 3, '7f000000-0000-4000-8000-000000000002', 'direct-care', false),
  ('G member deactivated', 4, '7f000000-0000-4000-8000-000000000002', 'direct-care', false),
  ('H volunteer (another group)', 5, '7f000000-0000-4000-8000-000000000012', 'direct-care', false),
  ('H volunteer claiming G', 5, '7f000000-0000-4000-8000-000000000002', 'direct-care', false),
  ('S organiser (suspended group)', 6, '7f000000-0000-4000-8000-000000000022', 'direct-care', false),
  ('K nurse (hospital)', 7, '7f000000-0000-4000-8000-000000000032', 'direct-care', false),
  ('G volunteer in A, purpose emergency', 2, '7f000000-0000-4000-8000-000000000002', 'emergency', false),
  ('no session', null, '', '', false),
  ('G volunteer in A, retention run', 2, '7f000000-0000-4000-8000-000000000002', 'direct-care', true);
create temporary table ro_results (session text, role_name text, check_name text, actual text, expected text) on commit drop;
grant insert, select on ro_results to public;

create function pg_temp.ro_labels(statement text) returns text language plpgsql as $$
declare result text;
begin
  execute statement into result;
  return coalesce(result, '');
exception when others then return 'ERR ' || sqlstate;
end $$;

do $$
declare s record; r record; facility_value text;
begin
  for s in select * from ro_sessions loop
    for r in select unnest(array['hid_outreach_runtime', 'hid_outreach_api_runtime', 'hid_schema_test_runtime']) rolname loop
      perform set_config('app.actor_subject', case when s.n is null then '' else 'synthetic:read-once-' || s.n end, true),
              set_config('app.facility_id', s.facility, true),
              set_config('app.membership_id', case when s.n is null then '' else '7f030000-0000-4000-8000-00000000000' || s.n end, true),
              set_config('app.purpose_of_use', s.purpose, true), set_config('app.correlation_id', 'read-once-suite', true);
      if s.retention then insert into outreach.privileged_runs (transaction_id, kind) values (pg_current_xact_id(), 'retention'); end if;
      facility_value := coalesce(nullif(s.facility, ''), '7f000000-0000-4000-8000-000000000002');
      execute format('set local role %I', r.rolname);
      -- Rows: the policies now, against the pre-0121 expressions over the plain copy.
      insert into ro_results values (s.label, r.rolname, 'rows',
        pg_temp.ro_labels($q$select string_agg(l.label, ',' order by l.label) from outreach.registration_cases c join ro_cases l on l.id = c.id$q$),
        pg_temp.ro_labels($q$select string_agg(p.label, ',' order by p.label) from ro_plain p
          where (outreach.context_allows(p.facility_id, 'outreach.registration.read') or outreach.privileged_run_active('retention'))
            and (outreach.registration_campaign_member(p.campaign_id, p.facility_id) or outreach.privileged_run_active('retention'))$q$));
      -- outreach-api's list: without the repeated filter (0121) = with it. Not inside a retention run, where the
      -- restrictive policy admits every row by design: no runtime role can start one (checked in section 3), so
      -- outreach-api's list never runs inside one.
      if not s.retention then
      insert into ro_results values (s.label, r.rolname, 'list',
        pg_temp.ro_labels(format($q$select string_agg(l.label, ',' order by l.label) from outreach.registration_cases c
          join ro_cases l on l.id = c.id where c.facility_id = %L$q$, facility_value)),
        pg_temp.ro_labels(format($q$select string_agg(l.label, ',' order by l.label) from outreach.registration_cases c
          join ro_cases l on l.id = c.id where c.facility_id = %L and outreach.registration_campaign_member(c.campaign_id, c.facility_id)$q$, facility_value)));
      end if;
      -- The Health ID lookup now, against 0120's rules over the plain copy (the same functions, per row).
      insert into ro_results values (s.label, r.rolname, 'health ids',
        pg_temp.ro_labels($q$select string_agg(l.label || '=' || h.hid_code, ',' order by l.label)
          from identity.outreach_registration_health_ids_for((select array_agg(id) from ro_cases)) h join ro_cases l on l.id = h.registration_case_id$q$),
        pg_temp.ro_labels($q$select string_agg(l.label || '=' || link.hid_code, ',' order by l.label) from ro_plain_links link
          join ro_cases l on l.id = link.registration_case_id join ro_plain p on p.id = link.registration_case_id
          where link.facility_id = platform.current_facility_id()
            and outreach.context_allows(link.facility_id, 'outreach.registration.read')
            and l.label <> 'ar'
            and (outreach.context_allows(p.facility_id, 'outreach.registration.read') or outreach.privileged_run_active('retention'))
            and (outreach.registration_campaign_member(p.campaign_id, p.facility_id) or outreach.privileged_run_active('retention'))
            and outreach.registration_campaign_member(p.campaign_id, p.facility_id)$q$));
      execute 'reset role';
      if s.retention then delete from outreach.privileged_runs where transaction_id = pg_current_xact_id(); end if;
    end loop;
  end loop;
end $$;

-- 2. The named cases (as the Outreach runtime): the rows each sees.
create temporary table ro_named (session text primary key, rows_expected text, health_ids_expected text) on commit drop;
insert into ro_named values
  ('G organiser', 'a1,a2,ar,b1,g0', 'a1=HID-RDNCEAY,b1=HID-RDNCEBY'),
  ('G volunteer in A', 'a1,a2,ar,g0', 'a1=HID-RDNCEAY'),
  ('G volunteer removed from A', 'g0', ''),
  ('G member deactivated', '', ''),
  ('H volunteer (another group)', 'c1,h0', 'c1=HID-RDNCECY'),
  ('H volunteer claiming G', '', ''),
  ('S organiser (suspended group)', 'd1', 'd1=HID-RDNCEDY'),
  ('K nurse (hospital)', 'e1,k0', 'e1=HID-RDNCEEY'),
  ('G volunteer in A, purpose emergency', '', ''),
  ('no session', '', ''),
  ('G volunteer in A, retention run', 'a1,a2,ar,b1,c1,d1,e1,g0,h0,k0', 'a1=HID-RDNCEAY');

-- 3. No runtime role can start a retention run (so outreach-api's list never runs inside one).
do $$
begin
  if exists (select 1 from pg_roles role_row where role_row.rolname ~ '^hid_'
              and (has_table_privilege(role_row.oid, 'outreach.privileged_runs', 'INSERT')
                   or has_function_privilege(role_row.oid, 'outreach.begin_privileged_run(text)', 'EXECUTE'))) then
    raise exception '0121: a runtime role can start a privileged run';
  end if;
end $$;

do $$
declare failures text;
begin
  select string_agg(format('%s / %s / %s: got [%s], the pre-0121 rules give [%s]', session, role_name, check_name, actual, expected), E'\n')
    into failures from ro_results where actual is distinct from expected;
  if failures is null then
    select string_agg(format('%s: %s [%s], expected [%s]', r.session, r.check_name, r.actual,
             case r.check_name when 'rows' then n.rows_expected else n.health_ids_expected end), E'\n')
      into failures
      from ro_results r join ro_named n on n.session = r.session
     where r.role_name = 'hid_outreach_api_runtime' and r.check_name in ('rows', 'health ids')
       and r.actual is distinct from case r.check_name when 'rows' then n.rows_expected else n.health_ids_expected end;
  end if;
  if failures is not null then
    raise exception E'0121 read-once suite failed:\n%', failures;
  end if;
  raise notice 'Outreach registration read-once suite: % comparisons and % named cases passed',
    (select count(*) from ro_results), (select count(*) * 2 from ro_named);
end $$;
rollback;
