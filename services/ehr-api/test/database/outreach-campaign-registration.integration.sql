\set ON_ERROR_STOP on
-- Outreach: registering a person into a campaign (0110). Rollback-only.
--
-- The campaign trigger outreach.validate_registration_campaign_write (0045) is
-- SECURITY DEFINER and runs as its owner. In production that owner, the
-- migration login, is neither a superuser nor BYPASSRLS, and until 0110 the
-- trigger locked the campaign membership row (FOR SHARE OF campaign, member).
-- outreach.campaign_members forces row-level security and has no UPDATE
-- policy, so that lock found no row and every registration into a campaign
-- raised 42501 "Exact Outreach campaign membership is required", for members
-- too. Since 0110 the trigger locks the campaign row only and reads the
-- membership without a lock.
--
-- So that this suite proves it wherever it runs, the trigger always runs here
-- under an owner that is neither a superuser nor BYPASSRLS: the database's own
-- owner when it already is one (production, the release rehearsal), otherwise
-- (CI and the acceptance runner migrate as a superuser) a role made in this
-- transaction with the privileges the owner uses here (schema USAGE, SELECT
-- and UPDATE on outreach.campaigns and outreach.campaign_members, EXECUTE on
-- outreach.context_allows), to which the function is lent until the ROLLBACK.
-- Before 0110 (on 0109) the member's registration below is refused, and so is the member's
-- resolution of a campaign-linked registration (linkExisting's UPDATE, which
-- the same trigger checks); with 0110 both are kept. Section 1 also stops
-- before 0110: the trigger must lock the campaign only.
--
-- Fixtures are inserted with session_replication_role = replica (no triggers
-- or foreign-key checks); every case then runs with triggers, references and
-- row-level security enforced, as hid_outreach_api_runtime (outreach-api's
-- runtime role) with the session outreach-api sets
-- (services/outreach-api/src/database/database.service.ts) and the API's own
-- statements (services/outreach-api/src/outreach/outreach.service.ts). Each
-- case records 'ok' or 'SQLSTATE: message', and the suite fails at the end
-- listing every case whose outcome differs from the expected one. All data is
-- fictional.
begin;

-- 0. The trigger's owner: neither a superuser nor BYPASSRLS.
do $$
declare
  owner_role oid := (select proowner from pg_proc
                      where oid = 'outreach.validate_registration_campaign_write()'::regprocedure);
begin
  if (select rolsuper or rolbypassrls from pg_roles where oid = owner_role) then
    create role outreach_0110_suite_owner nologin nosuperuser nobypassrls noinherit;
    grant usage on schema outreach, platform, auth, identity to outreach_0110_suite_owner;
    grant select, update on outreach.campaigns, outreach.campaign_members to outreach_0110_suite_owner;
    grant execute on function outreach.context_allows(uuid, text) to outreach_0110_suite_owner;
    alter function outreach.validate_registration_campaign_write() owner to outreach_0110_suite_owner;
    raise notice 'outreach-campaign-registration: the trigger is lent to outreach_0110_suite_owner (owner % bypasses RLS)',
      owner_role::regrole;
  else
    raise notice 'outreach-campaign-registration: the trigger runs as its owner %', owner_role::regrole;
  end if;
  if (select rolsuper or rolbypassrls from pg_roles
       where oid = (select proowner from pg_proc
                     where oid = 'outreach.validate_registration_campaign_write()'::regprocedure)) then
    raise exception 'the campaign trigger must run under an owner that does not bypass RLS';
  end if;
end $$;

-- 1. The shape 0110 keeps: SECURITY DEFINER and 0045's search_path, the
-- trigger, and no way for the runtime to update or lock a membership (no
-- UPDATE privilege, no UPDATE or ALL policy, the append-only trigger).
do $$
begin
  if not exists (select 1 from pg_proc p
                  where p.oid = 'outreach.validate_registration_campaign_write()'::regprocedure
                    and p.prosecdef and p.provolatile = 'v'
                    and p.proconfig = '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]) then
    raise exception 'outreach.validate_registration_campaign_write attributes changed';
  end if;
  -- The trigger locks the campaign row only, never the member's membership
  -- (0110's body; 0045's locked both and is refused under such an owner).
  if position('for share of campaign' in pg_get_functiondef('outreach.validate_registration_campaign_write()'::regprocedure)) = 0
     or position('of campaign, member' in pg_get_functiondef('outreach.validate_registration_campaign_write()'::regprocedure)) > 0
     or (select md5(prosrc) from pg_proc
          where oid = 'outreach.validate_registration_campaign_write()'::regprocedure)
        <> '69469315f04554d2639dfa9f83591d4d' then
    raise exception 'outreach.validate_registration_campaign_write must lock the campaign only (FOR SHARE OF campaign), not the membership';
  end if;
  if (select count(*) from pg_trigger
       where tgrelid = 'outreach.registration_cases'::regclass and tgname = 'outreach_registration_campaign_validate'
         and tgfoid = 'outreach.validate_registration_campaign_write()'::regprocedure and tgenabled = 'O') <> 1 then
    raise exception 'the campaign trigger on outreach.registration_cases changed';
  end if;
  if has_table_privilege('hid_outreach_api_runtime', 'outreach.campaign_members', 'UPDATE')
     or has_table_privilege('hid_outreach_runtime', 'outreach.campaign_members', 'UPDATE')
     or exists (select 1 from information_schema.column_privileges
                 where table_schema = 'outreach' and table_name = 'campaign_members'
                   and privilege_type = 'UPDATE'
                   and grantee in ('hid_outreach_api_runtime', 'hid_outreach_runtime', 'PUBLIC')) then
    raise exception 'the Outreach runtime may update outreach.campaign_members';
  end if;
  if exists (select 1 from pg_policy
              where polrelid = 'outreach.campaign_members'::regclass and polcmd in ('w', '*')) then
    raise exception 'outreach.campaign_members has an UPDATE or ALL policy';
  end if;
  if not exists (select 1 from pg_class
                  where oid = 'outreach.campaign_members'::regclass and relrowsecurity and relforcerowsecurity)
     or (select count(*) from pg_trigger
          where tgrelid = 'outreach.campaign_members'::regclass and tgname = 'outreach_campaign_members_no_update'
            and tgfoid = 'platform.reject_mutation()'::regprocedure and tgenabled = 'O') <> 1 then
    raise exception 'outreach.campaign_members is no longer forced-RLS and append-only';
  end if;
end $$;

-- 2. Fictional fixtures: one organization; Clinic One (F1) with doctors A
-- (a campaign member) and B (not a member); Clinic Two (F2) with doctor C.
-- Campaigns: K1 active registration at F1 (A admin), K2 active registration at
-- F2 (C admin), K3 planned at F1 (A admin). R1 is a pending registration A
-- captured into K1 earlier (kept, local command e128...02), and P1 the
-- existing patient it is resolved to.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e1200000-0000-4000-8000-000000000001', 'Outreach 0110 Suite Organization', 'outreach-0110-suite-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1200000-0000-4000-8000-000000000002', 'e1200000-0000-4000-8000-000000000001', 'Outreach 0110 Clinic One',
   'OUTREACH-0110-ONE', 'Africa/Lagos', true, 'verified'),
  ('e1200000-0000-4000-8000-000000000003', 'e1200000-0000-4000-8000-000000000001', 'Outreach 0110 Clinic Two',
   'OUTREACH-0110-TWO', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1210000-0000-4000-8000-000000000001', 'synthetic:outreach-0110-a', 'outreach-0110-a@example.invalid',
   'Outreach 0110 A', 'active'),
  ('e1210000-0000-4000-8000-000000000002', 'synthetic:outreach-0110-b', 'outreach-0110-b@example.invalid',
   'Outreach 0110 B', 'active'),
  ('e1210000-0000-4000-8000-000000000003', 'synthetic:outreach-0110-c', 'outreach-0110-c@example.invalid',
   'Outreach 0110 C', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e1220000-0000-4000-8000-000000000001', 'e1210000-0000-4000-8000-000000000001', 'Outreach 0110 A',
   'outreach-0110-a@example.invalid', 'verified', 'doctor'),
  ('e1220000-0000-4000-8000-000000000002', 'e1210000-0000-4000-8000-000000000002', 'Outreach 0110 B',
   'outreach-0110-b@example.invalid', 'verified', 'doctor'),
  ('e1220000-0000-4000-8000-000000000003', 'e1210000-0000-4000-8000-000000000003', 'Outreach 0110 C',
   'outreach-0110-c@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role) values
  ('e1230000-0000-4000-8000-000000000001', 'e1220000-0000-4000-8000-000000000001',
   'e1210000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001',
   'e1200000-0000-4000-8000-000000000002', 'doctor', 'doctor'),
  ('e1230000-0000-4000-8000-000000000002', 'e1220000-0000-4000-8000-000000000002',
   'e1210000-0000-4000-8000-000000000002', 'e1200000-0000-4000-8000-000000000001',
   'e1200000-0000-4000-8000-000000000002', 'doctor', 'doctor'),
  ('e1230000-0000-4000-8000-000000000003', 'e1220000-0000-4000-8000-000000000003',
   'e1210000-0000-4000-8000-000000000003', 'e1200000-0000-4000-8000-000000000001',
   'e1200000-0000-4000-8000-000000000003', 'doctor', 'doctor');
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('e1240000-0000-4000-8000-000000000001', 'e1210000-0000-4000-8000-000000000001', 'doctor', 'facility',
   'e1230000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000002', 'Synthetic 0110 suite role'),
  ('e1240000-0000-4000-8000-000000000002', 'e1210000-0000-4000-8000-000000000002', 'doctor', 'facility',
   'e1230000-0000-4000-8000-000000000002', 'e1200000-0000-4000-8000-000000000002', 'Synthetic 0110 suite role'),
  ('e1240000-0000-4000-8000-000000000003', 'e1210000-0000-4000-8000-000000000003', 'doctor', 'facility',
   'e1230000-0000-4000-8000-000000000003', 'e1200000-0000-4000-8000-000000000003', 'Synthetic 0110 suite role');
insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services,
  status, starts_at, ends_at) values
  ('e1250000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000002',
   'e1210000-0000-4000-8000-000000000001', 'e1230000-0000-4000-8000-000000000001', 'Outreach 0110 K1',
   array['registration', 'vitals'], 'active', clock_timestamp() - interval '1 day', null),
  ('e1250000-0000-4000-8000-000000000002', 'e1200000-0000-4000-8000-000000000003',
   'e1210000-0000-4000-8000-000000000003', 'e1230000-0000-4000-8000-000000000003', 'Outreach 0110 K2',
   array['registration'], 'active', clock_timestamp() - interval '1 day', null),
  ('e1250000-0000-4000-8000-000000000003', 'e1200000-0000-4000-8000-000000000002',
   'e1210000-0000-4000-8000-000000000001', 'e1230000-0000-4000-8000-000000000001', 'Outreach 0110 K3',
   array['registration'], 'planned', clock_timestamp() + interval '10 days', null);
insert into outreach.campaign_members (id, campaign_id, facility_id, membership_id, role, added_by_account_id,
  added_by_membership_id) values
  ('e1260000-0000-4000-8000-000000000001', 'e1250000-0000-4000-8000-000000000001',
   'e1200000-0000-4000-8000-000000000002', 'e1230000-0000-4000-8000-000000000001', 'admin',
   'e1210000-0000-4000-8000-000000000001', 'e1230000-0000-4000-8000-000000000001'),
  ('e1260000-0000-4000-8000-000000000002', 'e1250000-0000-4000-8000-000000000002',
   'e1200000-0000-4000-8000-000000000003', 'e1230000-0000-4000-8000-000000000003', 'admin',
   'e1210000-0000-4000-8000-000000000003', 'e1230000-0000-4000-8000-000000000003'),
  ('e1260000-0000-4000-8000-000000000003', 'e1250000-0000-4000-8000-000000000003',
   'e1200000-0000-4000-8000-000000000002', 'e1230000-0000-4000-8000-000000000001', 'admin',
   'e1210000-0000-4000-8000-000000000001', 'e1230000-0000-4000-8000-000000000001');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e1290000-0000-4000-8000-000000000001', 'HID-E2ZPATA2', 'Outreach', 'Patient', 'Outreach 0110 Patient', 'active');
insert into outreach.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id,
  local_command_id, temporary_patient_id, full_name, sex, age_years, campaign_id) values
  ('e1280000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000002',
   'e1210000-0000-4000-8000-000000000001', 'e1230000-0000-4000-8000-000000000001',
   'e1280000-0000-4000-8000-000000000002', 'tmp_e1280000-0000-4000-8000-000000000002', 'Outreach 0110 Person R1',
   'unknown', 30, 'e1250000-0000-4000-8000-000000000001');
set local session_replication_role = origin;

-- 3. The case runner.
create temporary table outreach_0110_cases (
  seq integer generated always as identity, name text not null, expected text not null, actual text
) on commit drop;
grant select on outreach_0110_cases to public;

-- Runs one statement as hid_outreach_api_runtime with the member's session
-- (A, B or C at their own clinic). keep: the row stays (later cases read it);
-- otherwise the statement is undone. expected_rows: rows it must process.
create function pg_temp.outreach_0110_try(member text, statement text, keep boolean, expected_rows integer)
returns text language plpgsql as $$
declare
  outcome text;
  processed bigint;
begin
  begin
    perform set_config('app.actor_subject', 'synthetic:outreach-0110-' || member, true),
            set_config('app.facility_id', case member when 'c' then 'e1200000-0000-4000-8000-000000000003'
                                           else 'e1200000-0000-4000-8000-000000000002' end, true),
            set_config('app.correlation_id', 'outreach-0110-suite', true),
            set_config('app.membership_id', case member when 'a' then 'e1230000-0000-4000-8000-000000000001'
                                             when 'b' then 'e1230000-0000-4000-8000-000000000002'
                                             else 'e1230000-0000-4000-8000-000000000003' end, true),
            set_config('app.purpose_of_use', 'direct-care', true);
    set local role hid_outreach_api_runtime;
    execute statement;
    get diagnostics processed = row_count;
    reset role;
    if processed <> expected_rows then
      raise exception using errcode = 'P0002',
        message = format('outreach-0110-suite: expected %s row(s), processed %s', expected_rows, processed);
    end if;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'outreach-0110-suite: undo'; end if;
  exception when others then
    if sqlstate <> 'P0001' or sqlerrm <> 'outreach-0110-suite: undo' then
      outcome := sqlstate || ': ' || sqlerrm;
    end if;
  end;
  return outcome;
end $$;

create function pg_temp.outreach_0110_case(case_name text, expected text, member text, statement text,
  keep boolean default false, expected_rows integer default 1)
returns void language plpgsql as $$
begin
  insert into outreach_0110_cases (name, expected, actual)
  values (case_name, expected, pg_temp.outreach_0110_try(member, statement, keep, expected_rows));
end $$;

-- OutreachService.create's registration insert, at the member's clinic, into
-- a campaign (or none), for local command e127...nn.
create function pg_temp.outreach_0110_register(member text, campaign text, command integer) returns text
language sql as $$
  select format($i$insert into outreach.registration_cases (
          facility_id,created_by_account_id,created_by_membership_id,local_command_id,
          temporary_patient_id,full_name,sex,age_years,phone,operational_notes,campaign_id
        ) values (%L,%L,%L,%L,%L,%L,%L,%s,%L,%L,%L) returning *$i$,
    case member when 'c' then 'e1200000-0000-4000-8000-000000000003' else 'e1200000-0000-4000-8000-000000000002' end,
    case member when 'a' then 'e1210000-0000-4000-8000-000000000001' when 'b' then 'e1210000-0000-4000-8000-000000000002'
      else 'e1210000-0000-4000-8000-000000000003' end,
    case member when 'a' then 'e1230000-0000-4000-8000-000000000001' when 'b' then 'e1230000-0000-4000-8000-000000000002'
      else 'e1230000-0000-4000-8000-000000000003' end,
    format('e1270000-0000-4000-8000-%s', lpad(command::text, 12, '0')),
    format('tmp_e1270000-0000-4000-8000-%s', lpad(command::text, 12, '0')),
    'Outreach 0110 Person ' || command, 'unknown', 30, null, null, campaign)
$$;

-- OutreachService.assertCampaignAcceptsRegistration's read (its own check,
-- which locks the campaign only), at clinic One.
create function pg_temp.outreach_0110_service_check(campaign text, membership text) returns text
language sql as $$
  select format($s$select campaign.status,campaign.services,
        campaign.starts_at,campaign.ends_at from outreach.campaigns campaign
        join outreach.campaign_members member on member.campaign_id=campaign.id
          and member.facility_id=campaign.facility_id and member.membership_id=%L
        where campaign.id=%L and campaign.facility_id=%L for share of campaign$s$,
    membership, campaign, 'e1200000-0000-4000-8000-000000000002')
$$;

-- OutreachService.linkExisting's resolve UPDATE, by the member, of
-- registration R1 at its current row_version, to patient P1.
create function pg_temp.outreach_0110_link_existing(member text) returns text
language sql as $$
  select format($u$update outreach.registration_cases set
          status='identity_resolved',resolved_patient_id=%L,resolution_kind='linked_existing',
          resolved_by_account_id=%L,resolved_by_membership_id=%L,resolution_reason=%L,
          resolved_at=clock_timestamp(),row_version=row_version+1
          where id=%L and row_version=%s returning *$u$,
    'e1290000-0000-4000-8000-000000000001',
    case member when 'a' then 'e1210000-0000-4000-8000-000000000001' when 'b' then 'e1210000-0000-4000-8000-000000000002'
      else 'e1210000-0000-4000-8000-000000000003' end,
    case member when 'a' then 'e1230000-0000-4000-8000-000000000001' when 'b' then 'e1230000-0000-4000-8000-000000000002'
      else 'e1230000-0000-4000-8000-000000000003' end,
    'Matched the existing patient record by Health ID in person',
    'e1280000-0000-4000-8000-000000000001',
    (select row_version from outreach.registration_cases where id = 'e1280000-0000-4000-8000-000000000001'))
$$;

-- 4. Cases.
-- A member registers a person into an active campaign: the service's check
-- finds the campaign, the insert is kept (it was 42501 before 0110).
select pg_temp.outreach_0110_case('member A: the service check finds K1', 'ok', 'a',
  pg_temp.outreach_0110_service_check('e1250000-0000-4000-8000-000000000001', 'e1230000-0000-4000-8000-000000000001'));
select pg_temp.outreach_0110_case('member A registers into active K1', 'ok', 'a',
  pg_temp.outreach_0110_register('a', 'e1250000-0000-4000-8000-000000000001', 1), true);
select pg_temp.outreach_0110_case('member A: the K1 registration is listed', 'ok', 'a',
  $s$select * from outreach.registration_cases
      where facility_id='e1200000-0000-4000-8000-000000000002'
        and campaign_id='e1250000-0000-4000-8000-000000000001'
        and local_command_id='e1270000-0000-4000-8000-000000000001'
        and outreach.registration_campaign_member(campaign_id, facility_id)$s$);
select pg_temp.outreach_0110_case('member A registers without a campaign', 'ok', 'a',
  pg_temp.outreach_0110_register('a', null, 2));
-- The campaign association still cannot be overwritten.
select pg_temp.outreach_0110_case('member A moves the K1 registration out of K1',
  '55000: Outreach registration campaign association cannot be overwritten', 'a',
  $s$update outreach.registration_cases set campaign_id=null
      where local_command_id='e1270000-0000-4000-8000-000000000001'$s$);
-- A campaign that is not accepting registrations is refused as before.
select pg_temp.outreach_0110_case('member A registers into planned K3',
  '23514: Outreach campaign is not accepting registrations', 'a',
  pg_temp.outreach_0110_register('a', 'e1250000-0000-4000-8000-000000000003', 3));
-- A non-member of the same clinic is refused with the same message.
select pg_temp.outreach_0110_case('non-member B: the service check finds no campaign', 'ok', 'b',
  pg_temp.outreach_0110_service_check('e1250000-0000-4000-8000-000000000001', 'e1230000-0000-4000-8000-000000000002'),
  false, 0);
select pg_temp.outreach_0110_case('non-member B registers into K1',
  '42501: Exact Outreach campaign membership is required', 'b',
  pg_temp.outreach_0110_register('b', 'e1250000-0000-4000-8000-000000000001', 4));
-- Another facility's campaign is refused with the same message, and its own
-- member there still registers into it.
select pg_temp.outreach_0110_case('member A registers into clinic Two''s K2',
  '42501: Exact Outreach campaign membership is required', 'a',
  pg_temp.outreach_0110_register('a', 'e1250000-0000-4000-8000-000000000002', 5));
select pg_temp.outreach_0110_case('member C registers into K2 at clinic Two', 'ok', 'c',
  pg_temp.outreach_0110_register('c', 'e1250000-0000-4000-8000-000000000002', 6));
-- Resolving a campaign-linked registration runs the same trigger (on
-- update): the member resolves R1 with linkExisting's UPDATE and it is kept
-- (it was 42501 before 0110); the non-member's same UPDATE finds no row.
select pg_temp.outreach_0110_case('non-member B resolves K1''s R1 (no row)', 'ok', 'b',
  pg_temp.outreach_0110_link_existing('b'), false, 0);
select pg_temp.outreach_0110_case('member A resolves K1''s R1', 'ok', 'a',
  pg_temp.outreach_0110_link_existing('a'), true);
-- The runtime still cannot update or lock a campaign membership; it can read
-- its own clinic's.
select pg_temp.outreach_0110_case('runtime reads the K1 membership', 'ok', 'a',
  $s$select * from outreach.campaign_members where campaign_id='e1250000-0000-4000-8000-000000000001'$s$);
select pg_temp.outreach_0110_case('runtime locks the K1 membership FOR SHARE',
  '42501: permission denied for table campaign_members', 'a',
  $s$select * from outreach.campaign_members where campaign_id='e1250000-0000-4000-8000-000000000001' for share$s$);
select pg_temp.outreach_0110_case('runtime locks the K1 membership FOR KEY SHARE',
  '42501: permission denied for table campaign_members', 'a',
  $s$select * from outreach.campaign_members where campaign_id='e1250000-0000-4000-8000-000000000001' for key share$s$);
select pg_temp.outreach_0110_case('runtime updates the K1 membership',
  '42501: permission denied for table campaign_members', 'a',
  $s$update outreach.campaign_members set role=role where campaign_id='e1250000-0000-4000-8000-000000000001'$s$);
select pg_temp.outreach_0110_case('runtime locks the membership through the service join',
  '42501: permission denied for table campaign_members', 'a',
  $s$select 1 from outreach.campaigns campaign join outreach.campaign_members member on member.campaign_id=campaign.id
      where campaign.id='e1250000-0000-4000-8000-000000000001' for share of campaign, member$s$);

-- 5. Every case as expected.
do $$
declare
  failures text;
  total integer;
begin
  select string_agg(format('#%s %s: expected [%s], got [%s]', seq, name, expected, coalesce(actual, 'null')),
           E'\n' order by seq), (select count(*) from outreach_0110_cases)
    into failures, total
    from outreach_0110_cases where actual is distinct from expected;
  if failures is not null then
    raise exception E'Outreach campaign registration suite failed:\n%', failures;
  end if;
  raise notice 'Outreach campaign registration suite: % cases passed', total;
end $$;

-- 6. Kept: exactly the member's K1 registration (and C's undone K2 case), and
-- R1 resolved by member A.
do $$
begin
  if (select count(*) from outreach.registration_cases
       where local_command_id::text like 'e1270000-0000-4000-8000-%') <> 1
     or not exists (select 1 from outreach.registration_cases
                     where local_command_id = 'e1270000-0000-4000-8000-000000000001'
                       and campaign_id = 'e1250000-0000-4000-8000-000000000001'
                       and created_by_membership_id = 'e1230000-0000-4000-8000-000000000001'
                       and status = 'identity_resolution_pending') then
    raise exception 'outreach-campaign-registration: the kept registration is not exactly member A''s K1 case';
  end if;
  if not exists (select 1 from outreach.registration_cases
                  where id = 'e1280000-0000-4000-8000-000000000001'
                    and campaign_id = 'e1250000-0000-4000-8000-000000000001'
                    and status = 'identity_resolved' and resolution_kind = 'linked_existing'
                    and resolved_patient_id = 'e1290000-0000-4000-8000-000000000001'
                    and resolved_by_membership_id = 'e1230000-0000-4000-8000-000000000001'
                    and row_version = 2) then
    raise exception 'outreach-campaign-registration: R1 is not resolved by member A to P1';
  end if;
end $$;

rollback;
