\set ON_ERROR_STOP on
-- The Outreach guards refuse a missing session account, membership, facility
-- or purpose of use wherever they compare it (Phase 4 Stage 8, 0077).
-- Rollback-only.
--
-- outreach.validate_registration_case_write and validate_registration_case_event
-- (0024) and outreach.validate_campaign_write (0045) compared the row's actor
-- and facility, and the purpose of use, with the session using <>. Without a
-- session account, membership, facility or purpose (no app.* setting, an
-- unknown or disabled subject, an empty membership, facility or purpose) the
-- comparison was NULL and the guard let the row through. Forced RLS refuses the
-- Outreach runtime, but a session that bypasses RLS (a superuser, or a table
-- owner without FORCE ROW LEVEL SECURITY) could record a registration, a
-- resolution, an event or a campaign attributed to any member. Since 0077 each
-- guard refuses a missing session value with its existing code and message. As
-- in 0024 the event guard compares neither the facility nor the purpose; as in
-- 0045 the campaign guard does not compare the purpose, and a campaign update
-- compares only the facility.
--
-- The Outreach runtime also needs EXECUTE on auth.account_id_for_subject(text)
-- (runtime-grants.sql, Stage 8): its RLS policies and the invoker-rights event
-- guard call platform.current_account_id(), which calls it. Without that grant
-- the runtime can neither look up nor record an idempotency record, and cannot
-- record a registration event, a patient mapping, a campaign, a campaign member
-- or a campaign event (42501 permission denied for function
-- account_id_for_subject).
--
-- Isolated cases: fixtures are inserted with session_replication_role =
-- replica, which skips triggers and foreign-key checks (CHECK constraints still
-- apply), and the three guard triggers are enabled with ENABLE ALWAYS TRIGGER,
-- so only the guard under test runs. They run as the suite runner, a superuser
-- that bypasses RLS: exactly the exposure. Runtime cases: every trigger,
-- reference and RLS policy applies, and the statements are the Outreach API's
-- own, run as hid_outreach_api_runtime with the session the API sets. A guard
-- fires before the RLS check of an insert, so a missing session value is now
-- refused by the guard; an update's RLS USING clause hides the row from such a
-- session before any trigger runs. Probe cases are undone; lifecycle steps are
-- kept. Each case records 'ok' or 'SQLSTATE: message', and the suite fails at
-- the end listing every case whose outcome differs from the expected one.
--
-- The rehearsal also runs this suite with a schema owner that is neither a
-- superuser nor BYPASSRLS (release checklist P8). The definer guards read only
-- the session (the account through auth.account_id_for_subject); the event
-- guard reads the registration case with its caller's rights. The owner probe
-- records whether the owner resolves member A's session and sees the parent
-- fixtures; if it does not, a negative case need only be refused, and every
-- positive case must still pass.
begin;

-- Security properties that CREATE OR REPLACE must keep: SECURITY DEFINER (and
-- invoker rights for the event guard), the exact search_path, volatility, and
-- the owner shared with outreach.validate_registration_campaign_write, which
-- 0077 does not replace; and the three guard triggers.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: definer=%s config=%s volatility=%s owner=%s', p.oid::regprocedure,
           p.prosecdef, p.proconfig, p.provolatile, p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values ('outreach.validate_registration_case_write()'::regprocedure, true,
                  '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]),
                 ('outreach.validate_registration_case_event()'::regprocedure, false,
                  '{"search_path=pg_catalog, platform, outreach"}'::text[]),
                 ('outreach.validate_campaign_write()'::regprocedure, true,
                  '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]))
      expected(proc, definer, config) on p.oid = expected.proc
   where p.prosecdef <> expected.definer or p.proconfig is distinct from expected.config or p.provolatile <> 'v'
      or p.proowner <> (select proowner from pg_proc
                         where oid = 'outreach.validate_registration_campaign_write()'::regprocedure);
  if mismatch is not null then
    raise exception 'Outreach guard security properties changed: %', mismatch;
  end if;
  if (select count(*) from pg_trigger
       where (tgrelid, tgname, tgfoid) in (
         ('outreach.registration_cases'::regclass, 'outreach_registration_case_validate',
          'outreach.validate_registration_case_write()'::regprocedure),
         ('outreach.registration_case_events'::regclass, 'outreach_registration_event_validate',
          'outreach.validate_registration_case_event()'::regprocedure),
         ('outreach.campaigns'::regclass, 'outreach_campaign_validate',
          'outreach.validate_campaign_write()'::regprocedure))
         and tgenabled = 'O' and not tgisinternal) <> 3 then
    raise exception 'the Outreach guard triggers must stay enabled on their tables';
  end if;
end $$;

set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e8e00000-0000-4000-8000-000000000001', 'Outreach Guard Test Organization', 'outreach-guard-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e8e00000-0000-4000-8000-000000000002', 'e8e00000-0000-4000-8000-000000000001', 'Outreach Guard Clinic',
   'OUTREACH-GUARD', 'Africa/Lagos', true, 'verified');
-- Doctors A (e8e1...01) and B (...02) are active; C's account (...03) is
-- disabled and D's (...04) is disabled until tomorrow. Member n has staff
-- e8e2...0n, one membership e8e3...0n in the clinic, and a facility-scoped
-- doctor role e8e4...0n, which carries the Outreach registration and campaign
-- permissions that outreach.context_allows requires.
insert into auth.accounts (id, subject, email, display_name, status, disabled_until)
select ('e8e10000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:outreach-guard-' || x,
       'outreach-guard-' || x || '@example.invalid', 'Outreach Guard ' || upper(x),
       case when x = 'c' then 'disabled' else 'active' end,
       case when x = 'd' then clock_timestamp() + interval '1 day' end
  from (values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')) member(n, x);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e8e20000-0000-4000-8000-00000000000' || n)::uuid, ('e8e10000-0000-4000-8000-00000000000' || n)::uuid,
       'Outreach Guard ' || upper(x), 'outreach-guard-' || x || '@example.invalid', 'verified', 'doctor'
  from (values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')) member(n, x);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role)
select ('e8e30000-0000-4000-8000-00000000000' || n)::uuid, ('e8e20000-0000-4000-8000-00000000000' || n)::uuid,
       ('e8e10000-0000-4000-8000-00000000000' || n)::uuid, 'e8e00000-0000-4000-8000-000000000001',
       'e8e00000-0000-4000-8000-000000000002', 'doctor', 'doctor'
  from generate_series(1, 4) n;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e8e40000-0000-4000-8000-00000000000' || n)::uuid, ('e8e10000-0000-4000-8000-00000000000' || n)::uuid,
       'doctor', 'facility', ('e8e30000-0000-4000-8000-00000000000' || n)::uuid,
       'e8e00000-0000-4000-8000-000000000002', 'Synthetic Outreach guard role'
  from generate_series(1, 4) n;
-- The canonical patient a registration is linked to.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e8e50000-0000-4000-8000-000000000001', 'HID-E8EPAT2A', 'Guard', 'Patient', 'Guard Patient', 'active');
-- R1 (e8e6...01) is a pending registration captured by A without a campaign
-- (local command e8e8...01); C1 (e8e7...01) is a planned campaign created by A.
insert into outreach.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id,
  local_command_id, temporary_patient_id, full_name, sex, age_years) values
  ('e8e60000-0000-4000-8000-000000000001', 'e8e00000-0000-4000-8000-000000000002',
   'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001',
   'e8e80000-0000-4000-8000-000000000001', 'tmp_e8e80000-0000-4000-8000-000000000001', 'Outreach Guard Person',
   'unknown', 30);
insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services,
  starts_at) values
  ('e8e70000-0000-4000-8000-000000000001', 'e8e00000-0000-4000-8000-000000000002',
   'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001', 'Outreach Guard Campaign',
   array['registration']::text[], clock_timestamp() - interval '1 day');
set local session_replication_role = origin;

-- The session, exactly as services/outreach-api/src/database/database.service.ts
-- sets it (lines 44-47). An empty value reads as missing, as an unset one does
-- (platform.current_* apply nullif(current_setting(name, true), '')).
create function pg_temp.as_member(subject text, facility text, correlation text, membership text, purpose text)
returns void language plpgsql as $$
begin
  perform set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
          set_config('app.correlation_id', correlation, true), set_config('app.membership_id', membership, true),
          set_config('app.purpose_of_use', purpose, true);
end $$;

-- Does the guards' owner resolve member A's session and see the parent
-- fixtures (R1 and C1, both under forced RLS)?
select pg_temp.as_member('synthetic:outreach-guard-a', 'e8e00000-0000-4000-8000-000000000002',
  'outreach-guard-suite', 'e8e30000-0000-4000-8000-000000000001', 'direct-care');
do $$
declare
  owner_role name := (select proowner::regrole::name from pg_proc
                       where oid = 'outreach.validate_registration_case_write()'::regprocedure);
  visible boolean;
begin
  execute format('set local role %I', owner_role);
  select platform.current_account_id() is not distinct from 'e8e10000-0000-4000-8000-000000000001'::uuid
     and exists (select 1 from outreach.registration_cases where id = 'e8e60000-0000-4000-8000-000000000001')
     and exists (select 1 from outreach.campaigns where id = 'e8e70000-0000-4000-8000-000000000001')
    into visible;
  reset role;
  perform set_config('outreach_guard.owner_sees', visible::text, true);
end $$;

-- The sessions every guard is checked under. Each case's row names one member
-- (its account and membership) as creator, resolver or event actor, so that
-- only the session differs. 'No session values' empties all five app.*
-- settings; the other sessions keep the suite's correlation id.
create temporary table outreach_guard_sessions (
  seq integer primary key, session_name text not null, named text not null, subject text not null,
  facility text not null, correlation text not null, membership text not null, purpose text not null,
  actor uuid not null, actor_membership uuid not null
) on commit drop;
grant select on outreach_guard_sessions to public;
insert into outreach_guard_sessions
select seq, session_name, named, subject, facility, case when seq = 1 then '' else 'outreach-guard-suite' end,
       membership, purpose, ('e8e10000-0000-4000-8000-00000000000' || member)::uuid,
       ('e8e30000-0000-4000-8000-00000000000' || member)::uuid
  from (values
    (1, 'no session values', 'B', '', '', '', '', 2),
    (2, 'A without a membership', 'A', 'synthetic:outreach-guard-a', 'e8e00000-0000-4000-8000-000000000002', '',
     'direct-care', 1),
    (3, 'an unknown subject with B''s membership', 'B', 'synthetic:outreach-guard-unknown',
     'e8e00000-0000-4000-8000-000000000002', 'e8e30000-0000-4000-8000-000000000002', 'direct-care', 2),
    (4, 'disabled C', 'C', 'synthetic:outreach-guard-c', 'e8e00000-0000-4000-8000-000000000002',
     'e8e30000-0000-4000-8000-000000000003', 'direct-care', 3),
    (5, 'D disabled until tomorrow', 'D', 'synthetic:outreach-guard-d', 'e8e00000-0000-4000-8000-000000000002',
     'e8e30000-0000-4000-8000-000000000004', 'direct-care', 4),
    (6, 'A without a facility', 'A', 'synthetic:outreach-guard-a', '', 'e8e30000-0000-4000-8000-000000000001',
     'direct-care', 1),
    (7, 'A without a purpose of use', 'A', 'synthetic:outreach-guard-a', 'e8e00000-0000-4000-8000-000000000002',
     'e8e30000-0000-4000-8000-000000000001', '', 1),
    (8, 'A for healthcare operations', 'A', 'synthetic:outreach-guard-a', 'e8e00000-0000-4000-8000-000000000002',
     'e8e30000-0000-4000-8000-000000000001', 'healthcare-operations', 1),
    (9, 'A', 'B', 'synthetic:outreach-guard-a', 'e8e00000-0000-4000-8000-000000000002',
     'e8e30000-0000-4000-8000-000000000001', 'direct-care', 2),
    (10, 'A', 'A', 'synthetic:outreach-guard-a', 'e8e00000-0000-4000-8000-000000000002',
     'e8e30000-0000-4000-8000-000000000001', 'direct-care', 1)
  ) variant(seq, session_name, named, subject, facility, membership, purpose, member);

-- Each case also records the role and replication mode it ran in, so a case
-- that silently ran in the wrong mode fails the suite.
create temporary table outreach_guard_cases (
  seq serial, area text not null, name text not null, expected text not null, actual text,
  run_as name not null default current_user,
  replication text not null default current_setting('session_replication_role'),
  primary key (area, name)
) on commit drop;
-- The runtime cases run as the Outreach API runtime and record their own outcome.
grant select, insert on outreach_guard_cases to public;
grant usage on sequence outreach_guard_cases_seq_seq to public;

-- Runs a statement as the current role: 'ok', or 'SQLSTATE: message'. With
-- capture set, the statement must return exactly one row (an update that RLS
-- hides returns none: P0002), whose id is stored in that setting. Otherwise it
-- must process exactly expected_rows rows: an insert that a BEFORE trigger
-- silently skips is not 'ok'. With keep = false a successful statement is
-- undone.
create function pg_temp.outreach_try(statement text, keep boolean, capture text, expected_rows integer)
returns text language plpgsql as $$
declare
  outcome text;
  returned record;
  processed bigint;
begin
  begin
    if capture is null then
      execute statement;
      get diagnostics processed = row_count;
      if processed <> expected_rows then
        raise exception using errcode = 'P0002',
          message = format('outreach-guard-suite: expected %s row(s), processed %s', expected_rows, processed);
      end if;
    else
      execute statement into strict returned;
      perform set_config(capture, to_jsonb(returned) ->> 'id', true);
    end if;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'outreach-guard-suite: undo'; end if;
  exception when others then
    if sqlstate <> 'P0001' or sqlerrm <> 'outreach-guard-suite: undo' then
      outcome := sqlstate || ': ' || sqlerrm;
    end if;
  end;
  return outcome;
end $$;
-- Sets the numbered session, then runs and records one case.
create function pg_temp.outreach_case(area text, case_name text, expected text, session_seq integer,
  statement text, keep boolean default false, capture text default null, expected_rows integer default 1)
returns void language plpgsql as $$
declare chosen outreach_guard_sessions%rowtype;
begin
  select * into strict chosen from outreach_guard_sessions where seq = session_seq;
  perform pg_temp.as_member(chosen.subject, chosen.facility, chosen.correlation, chosen.membership,
    chosen.purpose);
  insert into outreach_guard_cases (area, name, expected, actual)
  values (area, case_name, expected, pg_temp.outreach_try(statement, keep, capture, expected_rows));
end $$;
-- Each refusal, as recorded.
create function pg_temp.refusal(reason text) returns text language sql immutable as $$
  select case reason
    when 'registration context' then '42501: Valid Outreach registration context is required'
    when 'registration start' then '42501: Outreach registration starts unresolved'
    when 'registration history' then '55000: Outreach registration history cannot be overwritten'
    when 'event actor' then '42501: Outreach event actor must match request context'
    when 'event case' then '23514: Outreach event must match its registration case'
    when 'campaign context' then '42501: Valid Outreach campaign context is required'
    when 'campaign creator' then '42501: Valid Outreach campaign creator is required'
    when 'campaign history' then '55000: Outreach campaign history cannot be overwritten'
    when 'campaign rls' then '42501: new row violates row-level security policy for table "campaigns"'
    when 'no row' then 'P0002: query returned no rows' end
$$;

-- The Outreach API's statements (services/outreach-api/src/outreach/outreach.service.ts),
-- with their parameters filled in for the clinic (e8e0...02). The API takes the
-- facility and the actor from the request context.
-- OutreachService.create, the registration without a campaign (lines 37-43),
-- for local command e8e8...nn and temporary patient tmp_e8e8...nn.
create function pg_temp.registration_insert(creator uuid, creator_membership uuid, command uuid) returns text
language sql as $$
  select format($i$insert into outreach.registration_cases (
          facility_id,created_by_account_id,created_by_membership_id,local_command_id,
          temporary_patient_id,full_name,sex,age_years,phone,operational_notes,campaign_id
        ) values (%L,%L,%L,%L,%L,%L,%L,%s,%L,%L,%L) returning *$i$,
    'e8e00000-0000-4000-8000-000000000002', creator, creator_membership, command, 'tmp_' || command,
    'Outreach Guard Person', 'unknown', 30, null, null, null)
$$;
-- Its received event (lines 46-49).
create function pg_temp.received_event_insert(registration uuid, temporary text, actor uuid, actor_membership uuid)
returns text language sql as $$
  select format($i$insert into outreach.registration_case_events (
          registration_case_id,event_type,facility_id,temporary_patient_id,actor_account_id,actor_membership_id
        ) values (%L,'registration_case_received',%L,%L,%L,%L)$i$,
    registration, 'e8e00000-0000-4000-8000-000000000002', temporary, actor, actor_membership)
$$;
-- OutreachService.linkExisting, the resolution of version 1 to the patient
-- (lines 112-118).
create function pg_temp.resolution_update(registration uuid, resolver uuid, resolver_membership uuid) returns text
language sql as $$
  select format($u$update outreach.registration_cases set
          status='identity_resolved',resolved_patient_id=%L,resolution_kind='linked_existing',
          resolved_by_account_id=%L,resolved_by_membership_id=%L,resolution_reason=%L,
          resolved_at=clock_timestamp(),row_version=row_version+1
          where id=%L and row_version=%s returning *$u$,
    'e8e50000-0000-4000-8000-000000000001', resolver, resolver_membership, 'Synthetic exact existing patient',
    registration, 1)
$$;
-- OutreachService.createCampaign, the campaign (lines 164-169).
create function pg_temp.campaign_insert(creator uuid, creator_membership uuid, campaign_name text) returns text
language sql as $$
  select format($i$insert into outreach.campaigns
        (facility_id,created_by_account_id,created_by_membership_id,name,services,starts_at,ends_at)
        values (%L,%L,%L,%L,%L,%L,%L) returning id,facility_id as "facilityId",name,services,status,
        starts_at as "startsAt",ends_at as "endsAt",row_version as "rowVersion",created_at as "createdAt",$i$
      || $i$updated_at as "updatedAt"$i$,
    'e8e00000-0000-4000-8000-000000000002', creator, creator_membership, campaign_name, '{registration}',
    '2026-10-01T08:00:00.000Z', null)
$$;
-- OutreachService.updateCampaignStatus, the status change (line 201).
create function pg_temp.campaign_status_update(campaign uuid, status text) returns text language sql as $$
  select format($u$update outreach.campaigns set status=%L,row_version=row_version+1 $u$
      || $u$where id=%L and facility_id=%L returning *$u$, status, campaign, 'e8e00000-0000-4000-8000-000000000002')
$$;
-- Not an API statement: a direct update that rewrites the campaign's creator.
create function pg_temp.campaign_creator_update(campaign uuid, creator uuid, creator_membership uuid) returns text
language sql as $$
  select format($u$update outreach.campaigns set created_by_account_id=%L,created_by_membership_id=%L,
          row_version=row_version+1 where id=%L returning *$u$, creator, creator_membership, campaign)
$$;

-- Isolated guard cases, as the superuser runner, which bypasses RLS: only the
-- guard can refuse. Each session captures a registration naming the member
-- (local command e8e8...10), resolves R1 as the member, records a received
-- event of R1 by the member, creates a campaign by the member, and changes C1's
-- status (in the 'A, naming B' session, rewrites C1's creator to B). The event
-- guard compares neither the facility nor the purpose (0024), the campaign
-- guard does not compare the purpose, and a campaign update compares only the
-- facility (0045): those cases are accepted here. The runtime cannot make those
-- writes: RLS hides R1 from the event guard, refuses the campaign, or hides C1
-- from the update (runtime cases below).
set local session_replication_role = replica;
alter table outreach.registration_cases enable always trigger outreach_registration_case_validate;
alter table outreach.registration_case_events enable always trigger outreach_registration_event_validate;
alter table outreach.campaigns enable always trigger outreach_campaign_validate;
select pg_temp.outreach_case('isolated', 'registration: ' || session_name || ', naming ' || named,
    case seq when 10 then 'ok' when 9 then pg_temp.refusal('registration start')
      else pg_temp.refusal('registration context') end, seq,
    pg_temp.registration_insert(actor, actor_membership, 'e8e80000-0000-4000-8000-000000000010'))
  from outreach_guard_sessions order by seq;
select pg_temp.outreach_case('isolated', 'resolution: ' || session_name || ', naming ' || named,
    case seq when 10 then 'ok' when 9 then pg_temp.refusal('registration history')
      else pg_temp.refusal('registration context') end, seq,
    pg_temp.resolution_update('e8e60000-0000-4000-8000-000000000001', actor, actor_membership),
    false, 'outreach_guard.returned')
  from outreach_guard_sessions order by seq;
select pg_temp.outreach_case('isolated', 'event: ' || session_name || ', naming ' || named,
    case when seq in (6, 7, 8, 10) then 'ok' else pg_temp.refusal('event actor') end, seq,
    pg_temp.received_event_insert('e8e60000-0000-4000-8000-000000000001', 'tmp_e8e80000-0000-4000-8000-000000000001',
      actor, actor_membership))
  from outreach_guard_sessions order by seq;
-- The event guard still binds the event to its registration case.
select pg_temp.outreach_case('isolated', 'event: A, naming A, with another temporary patient',
  pg_temp.refusal('event case'), 10,
  pg_temp.received_event_insert('e8e60000-0000-4000-8000-000000000001', 'tmp_e8e80000-0000-4000-8000-0000000000ff',
    'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001'));
select pg_temp.outreach_case('isolated', 'campaign: ' || session_name || ', naming ' || named,
    case when seq in (7, 8, 10) then 'ok' when seq in (1, 6) then pg_temp.refusal('campaign context')
      else pg_temp.refusal('campaign creator') end, seq,
    pg_temp.campaign_insert(actor, actor_membership, 'Outreach Guard Probe Campaign'))
  from outreach_guard_sessions order by seq;
select pg_temp.outreach_case('isolated', 'campaign update: ' || session_name
      || case when seq = 9 then ', rewriting the creator to B' else ', planned to active' end,
    case when seq = 9 then pg_temp.refusal('campaign history')
      when seq in (1, 6) then pg_temp.refusal('campaign context') else 'ok' end, seq,
    case when seq = 9 then pg_temp.campaign_creator_update('e8e70000-0000-4000-8000-000000000001', actor,
      actor_membership) else pg_temp.campaign_status_update('e8e70000-0000-4000-8000-000000000001', 'active') end,
    false, 'outreach_guard.returned')
  from outreach_guard_sessions order by seq;
alter table outreach.registration_cases enable trigger outreach_registration_case_validate;
alter table outreach.registration_case_events enable trigger outreach_registration_event_validate;
alter table outreach.campaigns enable trigger outreach_campaign_validate;
set local session_replication_role = origin;

-- Runtime cases: the same statements as hid_outreach_api_runtime, with every
-- trigger, reference and RLS policy. An insert's guard fires before its RLS
-- check. The event guard, with invoker rights, cannot see R1 under a session
-- without the facility or the direct-care purpose (RLS on the registration
-- case), and refuses the event as not matching its case. An update's RLS USING
-- clause hides R1 and C1 from a session without the full context, so the
-- update changes no row and its guard is not reached, before 0077 and since.
set local role hid_outreach_api_runtime;
select pg_temp.outreach_case('runtime', 'registration: ' || session_name || ', naming ' || named,
    case seq when 10 then 'ok' when 9 then pg_temp.refusal('registration start')
      else pg_temp.refusal('registration context') end, seq,
    pg_temp.registration_insert(actor, actor_membership, 'e8e80000-0000-4000-8000-000000000010'))
  from outreach_guard_sessions order by seq;
select pg_temp.outreach_case('runtime', 'event: ' || session_name || ', naming ' || named,
    case when seq = 10 then 'ok' when seq in (6, 7, 8) then pg_temp.refusal('event case')
      else pg_temp.refusal('event actor') end, seq,
    pg_temp.received_event_insert('e8e60000-0000-4000-8000-000000000001', 'tmp_e8e80000-0000-4000-8000-000000000001',
      actor, actor_membership))
  from outreach_guard_sessions order by seq;
select pg_temp.outreach_case('runtime', 'campaign: ' || session_name || ', naming ' || named,
    case when seq = 10 then 'ok' when seq in (1, 6) then pg_temp.refusal('campaign context')
      when seq in (7, 8) then pg_temp.refusal('campaign rls') else pg_temp.refusal('campaign creator') end, seq,
    pg_temp.campaign_insert(actor, actor_membership, 'Outreach Guard Probe Campaign'))
  from outreach_guard_sessions order by seq;
select pg_temp.outreach_case('runtime', 'resolution: ' || session_name || ', naming ' || named,
    case seq when 10 then 'ok' when 9 then pg_temp.refusal('registration history') else pg_temp.refusal('no row') end,
    seq, pg_temp.resolution_update('e8e60000-0000-4000-8000-000000000001', actor, actor_membership),
    false, 'outreach_guard.returned')
  from outreach_guard_sessions order by seq;
select pg_temp.outreach_case('runtime', 'campaign update: ' || session_name
      || case when seq = 9 then ', rewriting the creator to B' else ', planned to active' end,
    case seq when 10 then 'ok' when 9 then pg_temp.refusal('campaign history') else pg_temp.refusal('no row') end,
    seq,
    case when seq = 9 then pg_temp.campaign_creator_update('e8e70000-0000-4000-8000-000000000001', actor,
      actor_membership) else pg_temp.campaign_status_update('e8e70000-0000-4000-8000-000000000001', 'active') end,
    false, 'outreach_guard.returned')
  from outreach_guard_sessions order by seq;

-- Lifecycle (kept), as member A with the full session: the Outreach API's
-- create, link-existing, campaign creation and campaign status commands, each
-- statement in order. Not run here: the audit insert of each command
-- (services/outreach-api/src/audit/audit.service.ts:9-17), which no Outreach
-- guard reads; campaign-linked capture, whose check
-- (assertCampaignAcceptsRegistration, outreach.service.ts:263-271) locks
-- outreach.campaign_members FOR SHARE, which needs an UPDATE privilege the
-- Outreach runtime does not have (42501, a separate release blocker); and
-- addCampaignMember (lines 224-248), which writes only outreach.campaign_members
-- and outreach.campaign_events, tables no 0077 guard covers. The SELECT ... FOR
-- UPDATE locks of linkExisting and updateCampaignStatus run: the runtime may
-- update both tables. Each insert must write its row; each replay lookup must
-- find no earlier command.
-- create (lines 27-66): replay lookup (250-255), registration (37-43, kept as
-- outreach_guard.case_id), event (46-49), idempotency record (50-54), outbox
-- event (55-57, 293-298).
select pg_temp.outreach_case('lifecycle', 'create: replay lookup', 'ok', 10,
  format($s$select request_sha256,registration_case_id
      from outreach.command_idempotency where requester_account_id=%L and facility_id=%L
      and operation=%L and idempotency_key=%L$s$, 'e8e10000-0000-4000-8000-000000000001',
    'e8e00000-0000-4000-8000-000000000002', 'registration_case_create', 'outreach-guard-create-0020'), true,
  expected_rows => 0);
select pg_temp.outreach_case('lifecycle', 'create: registration', 'ok', 10,
  pg_temp.registration_insert('e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001',
    'e8e80000-0000-4000-8000-000000000020'), true, 'outreach_guard.case_id');
select pg_temp.outreach_case('lifecycle', 'create: received event', 'ok', 10,
  pg_temp.received_event_insert(current_setting('outreach_guard.case_id', true)::uuid,
    'tmp_e8e80000-0000-4000-8000-000000000020', 'e8e10000-0000-4000-8000-000000000001',
    'e8e30000-0000-4000-8000-000000000001'), true);
select pg_temp.outreach_case('lifecycle', 'create: idempotency record', 'ok', 10,
  format($s$insert into outreach.command_idempotency (
          requester_account_id,requester_membership_id,facility_id,operation,idempotency_key,
          request_sha256,registration_case_id
        ) values (%L,%L,%L,'registration_case_create',%L,%L,%L)$s$,
    'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001',
    'e8e00000-0000-4000-8000-000000000002', 'outreach-guard-create-0020', repeat('a', 64),
    current_setting('outreach_guard.case_id', true)), true);
select pg_temp.outreach_case('lifecycle', 'create: outbox event', 'ok', 10,
  format($s$insert into outreach.outbox_events (
      event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload
    ) values (%L,%L,%s,%L,%L,%L,%L::jsonb)$s$,
    'OutreachRegistrationCaseCreated', current_setting('outreach_guard.case_id', true), 1,
    'e8e00000-0000-4000-8000-000000000002', null, 'outreach-guard-suite',
    json_build_object('registrationCaseId', current_setting('outreach_guard.case_id', true),
      'temporaryPatientId', 'tmp_e8e80000-0000-4000-8000-000000000020', 'campaignId', null,
      'status', 'identity_resolution_pending')), true);
-- linkExisting (lines 87-147), of the registration just created: replay lookup
-- (94-95), lock (97-98), patient mapping (106-111), resolution (112-118), event
-- (122-127), idempotency record (128-132), outbox event (133-137); then the
-- deferred mapping consistency check that the commit runs.
select pg_temp.outreach_case('lifecycle', 'link: replay lookup', 'ok', 10,
  format($s$select request_sha256,registration_case_id
      from outreach.command_idempotency where requester_account_id=%L and facility_id=%L
      and operation=%L and idempotency_key=%L$s$, 'e8e10000-0000-4000-8000-000000000001',
    'e8e00000-0000-4000-8000-000000000002', 'registration_case_link_existing', 'outreach-guard-link-0020'), true,
  expected_rows => 0);
select pg_temp.outreach_case('lifecycle', 'link: lock the registration', 'ok', 10,
  format('select * from outreach.registration_cases where id=%L for update',
    current_setting('outreach_guard.case_id', true)), true, 'outreach_guard.returned');
select pg_temp.outreach_case('lifecycle', 'link: patient mapping', 'ok', 10,
  format($s$insert into outreach.patient_mappings (
          registration_case_id,facility_id,temporary_patient_id,canonical_patient_id,
          resolution_kind,resolved_by_account_id,resolved_by_membership_id,reason
        ) values (%L,%L,%L,%L,'linked_existing',%L,%L,%L)$s$,
    current_setting('outreach_guard.case_id', true), 'e8e00000-0000-4000-8000-000000000002',
    'tmp_e8e80000-0000-4000-8000-000000000020', 'e8e50000-0000-4000-8000-000000000001',
    'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001',
    'Synthetic exact existing patient'), true);
select pg_temp.outreach_case('lifecycle', 'link: resolution', 'ok', 10,
  pg_temp.resolution_update(current_setting('outreach_guard.case_id', true)::uuid,
    'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001'), true, 'outreach_guard.returned');
select pg_temp.outreach_case('lifecycle', 'link: existing-patient event', 'ok', 10,
  format($s$insert into outreach.registration_case_events (
          registration_case_id,event_type,facility_id,temporary_patient_id,canonical_patient_id,
          actor_account_id,actor_membership_id,reason
        ) values (%L,'existing_patient_linked',%L,%L,%L,%L,%L,%L)$s$,
    current_setting('outreach_guard.case_id', true), 'e8e00000-0000-4000-8000-000000000002',
    'tmp_e8e80000-0000-4000-8000-000000000020', 'e8e50000-0000-4000-8000-000000000001',
    'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001',
    'Synthetic exact existing patient'), true);
select pg_temp.outreach_case('lifecycle', 'link: idempotency record', 'ok', 10,
  format($s$insert into outreach.command_idempotency (
          requester_account_id,requester_membership_id,facility_id,operation,idempotency_key,
          request_sha256,registration_case_id
        ) values (%L,%L,%L,'registration_case_link_existing',%L,%L,%L)$s$,
    'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001',
    'e8e00000-0000-4000-8000-000000000002', 'outreach-guard-link-0020', repeat('b', 64),
    current_setting('outreach_guard.case_id', true)), true);
select pg_temp.outreach_case('lifecycle', 'link: outbox event', 'ok', 10,
  format($s$insert into outreach.outbox_events (
      event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload
    ) values (%L,%L,%s,%L,%L,%L,%L::jsonb)$s$,
    'OutreachPatientResolved', current_setting('outreach_guard.case_id', true), 2,
    'e8e00000-0000-4000-8000-000000000002', 'e8e50000-0000-4000-8000-000000000001', 'outreach-guard-suite',
    json_build_object('registrationCaseId', current_setting('outreach_guard.case_id', true),
      'temporaryPatientId', 'tmp_e8e80000-0000-4000-8000-000000000020', 'campaignId', null,
      'canonicalPatientId', 'e8e50000-0000-4000-8000-000000000001', 'resolutionKind', 'linked_existing')), true);
select pg_temp.outreach_case('lifecycle', 'link: deferred mapping consistency, as at commit', 'ok', 10,
  'set constraints all immediate', true, expected_rows => 0);
set constraints all deferred;
-- createCampaign (lines 161-191): campaign (164-169, kept as
-- outreach_guard.campaign_id), creator as admin member (172-175), created and
-- member-added events (176-185).
select pg_temp.outreach_case('lifecycle', 'create campaign: campaign', 'ok', 10,
  pg_temp.campaign_insert('e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001',
    'Outreach Guard Runtime Campaign'), true, 'outreach_guard.campaign_id');
select pg_temp.outreach_case('lifecycle', 'create campaign: creator as admin member', 'ok', 10,
  format($s$insert into outreach.campaign_members
        (campaign_id,facility_id,membership_id,role,added_by_account_id,added_by_membership_id)
        values (%L,%L,%L,'admin',%L,%3$L)$s$,
    current_setting('outreach_guard.campaign_id', true), 'e8e00000-0000-4000-8000-000000000002',
    'e8e30000-0000-4000-8000-000000000001', 'e8e10000-0000-4000-8000-000000000001'), true);
select pg_temp.outreach_case('lifecycle', 'create campaign: ' || event_type || ' event', 'ok', 10,
  format($s$insert into outreach.campaign_events
        (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
        values (%L,%L,%L,%L,%L,%L::jsonb,%L)$s$,
    current_setting('outreach_guard.campaign_id', true), 'e8e00000-0000-4000-8000-000000000002', event_type,
    'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001', details, 'outreach-guard-suite'),
  true)
  from (values
    (1, 'campaign_created', json_build_object('name', 'Outreach Guard Runtime Campaign',
      'services', json_build_array('registration'))),
    (2, 'campaign_member_added', json_build_object('membershipId', 'e8e30000-0000-4000-8000-000000000001',
      'role', 'admin'))
  ) campaign_event(n, event_type, details) order by n;
-- updateCampaignStatus (lines 193-212) of C1: lock (195), status change (201),
-- event (202-206).
select pg_temp.outreach_case('lifecycle', 'campaign status: lock C1', 'ok', 10,
  format('select * from outreach.campaigns where id=%L and facility_id=%L for update',
    'e8e70000-0000-4000-8000-000000000001', 'e8e00000-0000-4000-8000-000000000002'), true, 'outreach_guard.returned');
select pg_temp.outreach_case('lifecycle', 'campaign status: planned to active', 'ok', 10,
  pg_temp.campaign_status_update('e8e70000-0000-4000-8000-000000000001', 'active'), true, 'outreach_guard.returned');
select pg_temp.outreach_case('lifecycle', 'campaign status: status-changed event', 'ok', 10,
  format($s$insert into outreach.campaign_events
        (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
        values (%L,%L,'campaign_status_changed',%L,%L,%L::jsonb,%L)$s$,
    'e8e70000-0000-4000-8000-000000000001', 'e8e00000-0000-4000-8000-000000000002',
    'e8e10000-0000-4000-8000-000000000001', 'e8e30000-0000-4000-8000-000000000001',
    json_build_object('from', 'planned', 'to', 'active', 'reason', 'Synthetic campaign start'),
    'outreach-guard-suite'), true);
reset role;

-- Every case ran, and every outcome is the expected one. If the guards' owner
-- does not resolve the session or see the fixtures (P8), a case expected to be
-- refused need only be refused; a case expected to pass must pass.
do $$
declare
  owner_sees boolean := current_setting('outreach_guard.owner_sees')::boolean;
  mismatches text;
begin
  if (select count(*) from outreach_guard_cases) <> 121
     or exists (select 1 from outreach_guard_cases where actual is null) then
    raise exception 'the Outreach guard suite did not run every case (% recorded)',
      (select count(*) from outreach_guard_cases);
  end if;
  select string_agg(format('%s / %s: ran as %s with replication %s', area, name, run_as, replication), E'\n'
           order by seq)
    into mismatches
    from outreach_guard_cases case_row
   where case when case_row.area = 'isolated'
              then case_row.replication is distinct from 'replica'
                or not exists (select 1 from pg_roles role_row where role_row.rolname = case_row.run_as
                                 and (role_row.rolsuper or role_row.rolbypassrls))
              else case_row.replication is distinct from 'origin'
                or case_row.run_as is distinct from 'hid_outreach_api_runtime' end;
  if mismatches is not null then
    raise exception E'Outreach guard cases ran in the wrong mode:\n%', mismatches;
  end if;
  select string_agg(format('%s / %s: expected %s, got %s', area, name, expected, actual), E'\n' order by seq)
    into mismatches
    from outreach_guard_cases
   where case when owner_sees or expected = 'ok' then actual is distinct from expected
              else actual is not distinct from 'ok' end;
  if mismatches is not null then
    raise exception E'Outreach session guard cases failed (owner sees fixtures: %):\n%', owner_sees, mismatches;
  end if;
  raise notice 'Outreach session guard suite: % cases passed (owner sees fixtures: %)',
    (select count(*) from outreach_guard_cases), owner_sees;
end $$;

rollback;
