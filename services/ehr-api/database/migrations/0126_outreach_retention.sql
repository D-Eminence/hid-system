-- 0126 Outreach retention: registrations an outreach group collected and
-- that were never linked to a Health ID are kept 1 year, then redacted (plan
-- "Open sign-up on outreach.", PR-2; owner decision 3 of 11 Nov 2026). Must
-- be live before the sign-up control is switched on. The number is a
-- placeholder: it is renumbered when it merges, always after 0125.
--
-- WHAT IT DOES
-- 1. outreach.campaigns gains closed_at, stamped by the trigger
--    outreach_campaign_closed_at whenever a campaign becomes closed (cleared
--    if it is opened again); nobody can set it directly.
--    outreach.registration_retain_until(campaign): closed_at + 365 days or,
--    for a campaign closed before 0126, the time it was last changed + 365
--    days; starts_at + 365 days if the campaign is not closed.
-- 2. Redaction. A redacted registration keeps its sex, age, campaign,
--    status, dates and temporary ID (so counts stay right); its full_name
--    becomes '[redacted]', its phone and operational notes become null; the
--    consent's guardian name becomes '[redacted]'; the request hash in
--    outreach.command_idempotency becomes 64 zeros. One row in
--    outreach.registration_redactions records it, and an audit row. Only a
--    registration of an outreach group that was never linked (status
--    identity_resolution_pending) is redacted.
--    Redaction runs inside a "retention run" (0125's outreach.privileged_runs,
--    a row for the current transaction that only these commands write). The
--    replaced trigger bodies and the policies below allow exactly that change
--    inside a retention run and nothing else:
--    - outreach.validate_registration_case_write() (replaces 0024's body,
--      md5 a12d2b2573c5c7e52bcb5a8cdb1ec190): every rule unchanged, plus the
--      redaction transition;
--    - outreach.validate_registration_campaign_write() (replaces 0110's
--      body, md5 69469315f04554d2639dfa9f83591d4d): unchanged, but a
--      redaction needs no campaign membership;
--    - outreach.command_idempotency's no-mutation trigger now refuses every
--      change but the redaction of request_sha256;
--    - permissive retention policies (read, update) on
--      outreach.registration_cases, outreach.campaigns,
--      outreach.command_idempotency and outreach.registration_consents; the
--      two restrictive campaign-member policies on registration_cases
--      (0045) also pass inside a retention run.
-- 3. Commands, for the Identity runtime only (never the Outreach runtime):
--    - identity.sweep_expired_outreach_registrations(limit): system:auth;
--      redacts up to limit (1-5000) expired registrations, oldest first, and
--      deletes sign-ups never activated after 30 days. Identity runs it on a
--      schedule.
--    - identity.admin_redact_outreach_registration(case, reason): support,
--      on a person's request (helpline, voice call or message), with
--      platform.admin.access, platform.facility.manage and
--      platform.facility.unlock.
--
-- PRECONDITIONS (catalog reads only; 55000 or 42501, nothing applied):
-- 0125 applied (outreach.privileged_run_active(text) is the marker); not
-- applied yet; the two replaced bodies as 0024 and 0110 left them; the
-- no-mutation trigger on outreach.command_idempotency calls
-- platform.reject_mutation(); the restrictive registration policies as 0045
-- made them; the applier may SET ROLE to the outreach tables' owner.
--
-- LOCKS: ACCESS EXCLUSIVE on outreach.campaigns (the new column, metadata
-- only, no rewrite), SHARE ROW EXCLUSIVE on outreach.registration_cases,
-- outreach.command_idempotency and outreach.registration_consents, NOWAIT
-- every 10 ms for at most 5 seconds (then 55P03, nothing applied), to commit.

do $$
declare
  attempt integer := 0;
  outreach_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'outreach.campaigns'::regclass);
begin
  if to_regprocedure('outreach.privileged_run_active(text)') is null
     or to_regclass('outreach.registration_consents') is null then
    raise exception using errcode = '55000', message = '0126: 0125 must be applied first';
  end if;
  if to_regclass('outreach.registration_redactions') is not null then
    raise exception using errcode = '55000', message = '0126: already applied';
  end if;
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'outreach.validate_registration_case_write()'::regprocedure)
       is distinct from 'a12d2b2573c5c7e52bcb5a8cdb1ec190'
     or (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'outreach.validate_registration_campaign_write()'::regprocedure)
       is distinct from '69469315f04554d2639dfa9f83591d4d' then
    raise exception using errcode = '55000', message = '0126: the registration triggers are not as 0024 and 0110 left them';
  end if;
  if not exists (select 1 from pg_trigger trigger_row
                  where trigger_row.tgrelid = 'outreach.command_idempotency'::regclass
                    and trigger_row.tgname = 'outreach_command_idempotency_no_mutation'
                    and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure) then
    raise exception using errcode = '55000', message = '0126: outreach.command_idempotency is not as 0024 left it';
  end if;
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'outreach.registration_cases'::regclass and not policy_row.polpermissive
         and ((policy_row.polname = 'outreach_registration_campaign_read'
               and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                   = 'outreach.registration_campaign_member(campaign_id, facility_id)')
           or (policy_row.polname = 'outreach_registration_campaign_resolve'
               and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                   = 'outreach.registration_campaign_member(campaign_id, facility_id)'
               and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
                   = 'outreach.registration_campaign_member(campaign_id, facility_id)'))) <> 2 then
    raise exception using errcode = '55000', message = '0126: the registration policies are not as 0045 made them';
  end if;
  if not pg_has_role(current_user, outreach_owner, 'SET')
     or exists (select 1 from pg_proc proc where proc.oid in ('outreach.validate_registration_case_write()'::regprocedure,
                  'outreach.validate_registration_campaign_write()'::regprocedure) and proc.proowner <> outreach_owner) then
    raise exception using errcode = '42501', message = format(
      '0126: the applier (%s) must be able to SET ROLE to the outreach tables'' owner (%s), which owns the triggers',
      current_user, pg_get_userbyid(outreach_owner));
  end if;
  loop
    attempt := attempt + 1;
    begin
      lock table outreach.campaigns in access exclusive mode nowait;
      lock table outreach.registration_cases, outreach.command_idempotency, outreach.registration_consents
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0126: the outreach tables stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 1. When a campaign closed.
alter table outreach.campaigns add column closed_at timestamptz;
comment on column outreach.campaigns.closed_at is
  '0126: when the campaign last became closed (null while it is not closed); stamped by outreach_campaign_closed_at, never written by a caller.';
create function outreach.stamp_campaign_closed_at()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status <> 'closed' then
    new.closed_at := null;
  elsif tg_op = 'UPDATE' and old.status = 'closed' then
    new.closed_at := old.closed_at;
  else
    new.closed_at := clock_timestamp();
  end if;
  return new;
end
$$;
create trigger outreach_campaign_closed_at
  before insert or update on outreach.campaigns
  for each row execute function outreach.stamp_campaign_closed_at();

create function outreach.registration_retain_until(campaign outreach.campaigns)
returns timestamptz language sql stable set search_path = pg_catalog, pg_temp
as $$
  select case when campaign.status = 'closed' then coalesce(campaign.closed_at, campaign.updated_at)
              else campaign.starts_at end + interval '365 days'
$$;

-- 2. Redactions.
create table outreach.registration_redactions (
  registration_case_id uuid primary key references outreach.registration_cases(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  campaign_id uuid references outreach.campaigns(id) on delete restrict,
  kind text not null check (kind in ('retention', 'request')),
  reason text not null check (length(btrim(reason)) between 8 and 500),
  requested_by_account_id uuid references auth.accounts(id) on delete restrict,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  redacted_at timestamptz not null default clock_timestamp(),
  constraint registration_redactions_requester_ck check ((kind = 'request') = (requested_by_account_id is not null))
);
create index registration_redactions_facility_idx on outreach.registration_redactions (facility_id, redacted_at);
alter table outreach.registration_redactions enable row level security;
alter table outreach.registration_redactions force row level security;
create policy registration_redactions_command_read on outreach.registration_redactions for select using (true);
create policy registration_redactions_command_insert on outreach.registration_redactions for insert with check (true);
create policy registration_redactions_command_update on outreach.registration_redactions
  for update using (true) with check (true);
create policy registration_redactions_command_delete on outreach.registration_redactions for delete using (true);
revoke all on outreach.registration_redactions from public;
create trigger outreach_registration_redactions_no_mutation
  before update or delete on outreach.registration_redactions
  for each row execute function platform.reject_mutation();

-- 0024's body; inside a retention run, exactly the redaction.
create or replace function outreach.validate_registration_case_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
declare
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
begin
  -- 0126: a retention run redacts an unlinked registration and nothing else.
  if tg_op = 'UPDATE' and outreach.privileged_run_active('retention') then
    if old.status is distinct from 'identity_resolution_pending'
       or new.status is distinct from old.status
       or new.row_version is distinct from old.row_version + 1
       or new.full_name is distinct from '[redacted]'
       or new.phone is not null
       or new.operational_notes is not null
       or new.id is distinct from old.id
       or new.facility_id is distinct from old.facility_id
       or new.campaign_id is distinct from old.campaign_id
       or new.created_by_account_id is distinct from old.created_by_account_id
       or new.created_by_membership_id is distinct from old.created_by_membership_id
       or new.local_command_id is distinct from old.local_command_id
       or new.temporary_patient_id is distinct from old.temporary_patient_id
       or new.sex is distinct from old.sex
       or new.age_years is distinct from old.age_years
       or new.resolved_patient_id is not null
       or new.created_at is distinct from old.created_at then
      raise exception using errcode = '55000', message = 'Outreach registration history cannot be overwritten';
    end if;
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if actor_account is null
     or actor_membership is null
     or actor_facility is null
     or platform.current_purpose_of_use() is distinct from 'direct-care'
     or new.facility_id is distinct from actor_facility then
    raise exception using errcode = '42501', message = 'Valid Outreach registration context is required';
  end if;

  if tg_op = 'INSERT' then
    if new.created_by_account_id is distinct from actor_account
       or new.created_by_membership_id is distinct from actor_membership
       or new.status is distinct from 'identity_resolution_pending'
       or new.row_version is distinct from 1 then
      raise exception using errcode = '42501', message = 'Outreach registration starts unresolved';
    end if;
    return new;
  end if;

  if old.status is distinct from 'identity_resolution_pending'
     or new.status is distinct from 'identity_resolved'
     or new.row_version is distinct from old.row_version + 1
     or new.resolution_kind is distinct from 'linked_existing'
     or new.resolved_by_account_id is distinct from actor_account
     or new.resolved_by_membership_id is distinct from actor_membership
     or new.id is distinct from old.id
     or new.facility_id is distinct from old.facility_id
     or new.created_by_account_id is distinct from old.created_by_account_id
     or new.created_by_membership_id is distinct from old.created_by_membership_id
     or new.local_command_id is distinct from old.local_command_id
     or new.temporary_patient_id is distinct from old.temporary_patient_id
     or new.full_name is distinct from old.full_name
     or new.sex is distinct from old.sex
     or new.age_years is distinct from old.age_years
     or new.phone is distinct from old.phone
     or new.operational_notes is distinct from old.operational_notes
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'Outreach registration history cannot be overwritten';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;

-- 0110's body; a redaction (inside a retention run) needs no membership.
create or replace function outreach.validate_registration_campaign_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
declare
  campaign_status text;
  campaign_services text[];
  campaign_starts_at timestamptz;
  campaign_ends_at timestamptz;
begin
  if tg_op = 'UPDATE' and new.campaign_id is distinct from old.campaign_id then
    raise exception using errcode = '55000',
      message = 'Outreach registration campaign association cannot be overwritten';
  end if;
  if new.campaign_id is null then return new; end if;
  -- 0126: validate_registration_case_write checks the redaction itself.
  if tg_op = 'UPDATE' and outreach.privileged_run_active('retention') then return new; end if;

  -- The campaign row lock serializes capture with a campaign status change.
  -- The membership is read, not locked: outreach.campaign_members forces
  -- row-level security and has no UPDATE policy, so a lock on it finds no row
  -- for an owner without BYPASSRLS (0110).
  select campaign.status, campaign.services, campaign.starts_at, campaign.ends_at
    into campaign_status, campaign_services, campaign_starts_at, campaign_ends_at
  from outreach.campaigns campaign
  join outreach.campaign_members member
    on member.campaign_id = campaign.id
   and member.facility_id = campaign.facility_id
   and member.membership_id = platform.current_membership_id()
  where campaign.id = new.campaign_id and campaign.facility_id = new.facility_id
  for share of campaign;
  if not found then
    raise exception using errcode = '42501',
      message = 'Exact Outreach campaign membership is required';
  end if;

  if tg_op = 'INSERT' and (
    campaign_status <> 'active'
    or not ('registration' = any(campaign_services))
    or campaign_starts_at > clock_timestamp()
    or (campaign_ends_at is not null and campaign_ends_at <= clock_timestamp())
  ) then
    raise exception using errcode = '23514',
      message = 'Outreach campaign is not accepting registrations';
  end if;
  return new;
end
$$;

-- The idempotency record stays immutable except for the redaction of its
-- request hash inside a retention run.
create function outreach.guard_command_idempotency_mutation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, outreach, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and outreach.privileged_run_active('retention')
     and new.id = old.id and new.requester_account_id = old.requester_account_id
     and new.requester_membership_id = old.requester_membership_id and new.facility_id = old.facility_id
     and new.operation = old.operation and new.idempotency_key = old.idempotency_key
     and new.registration_case_id = old.registration_case_id and new.created_at = old.created_at
     and new.request_sha256 = repeat('0', 64) then
    return new;
  end if;
  raise exception using errcode = '55000', message = 'Outreach command history cannot be overwritten';
end
$$;
drop trigger outreach_command_idempotency_no_mutation on outreach.command_idempotency;
create trigger outreach_command_idempotency_no_mutation
  before update or delete on outreach.command_idempotency
  for each row execute function outreach.guard_command_idempotency_mutation();

-- Retention policies.
create policy outreach_registration_cases_retention_read on outreach.registration_cases for select
  using (outreach.privileged_run_active('retention'));
create policy outreach_registration_cases_retention_update on outreach.registration_cases for update
  using (outreach.privileged_run_active('retention')) with check (outreach.privileged_run_active('retention'));
alter policy outreach_registration_campaign_read on outreach.registration_cases
  using (outreach.registration_campaign_member(campaign_id, facility_id) or outreach.privileged_run_active('retention'));
alter policy outreach_registration_campaign_resolve on outreach.registration_cases
  using (outreach.registration_campaign_member(campaign_id, facility_id) or outreach.privileged_run_active('retention'))
  with check (outreach.registration_campaign_member(campaign_id, facility_id) or outreach.privileged_run_active('retention'));
create policy outreach_campaigns_retention_read on outreach.campaigns for select
  using (outreach.privileged_run_active('retention'));
create policy outreach_command_idempotency_retention_read on outreach.command_idempotency for select
  using (outreach.privileged_run_active('retention'));
create policy outreach_command_idempotency_retention_update on outreach.command_idempotency for update
  using (outreach.privileged_run_active('retention')) with check (outreach.privileged_run_active('retention'));
create policy outreach_registration_consents_retention_read on outreach.registration_consents for select
  using (outreach.privileged_run_active('retention'));
create policy outreach_registration_consents_retention_update on outreach.registration_consents for update
  using (outreach.privileged_run_active('retention')) with check (outreach.privileged_run_active('retention'));

-- The redaction itself (owner-only; called inside a retention run). Returns
-- false when the registration is not an unlinked registration of an outreach
-- group, or is already redacted.
create function outreach.redact_registration_case(target_case_id uuid, redaction_kind text, redaction_reason text,
  requester uuid) returns boolean
language plpgsql volatile set search_path = pg_catalog, platform, outreach, pg_temp
as $$
declare
  registration outreach.registration_cases%rowtype;
begin
  select case_row.* into registration from outreach.registration_cases case_row
   where case_row.id = target_case_id
     and case_row.status = 'identity_resolution_pending'
     and outreach.organiser_tenant_state(case_row.facility_id) is not null
     and not exists (select 1 from outreach.registration_redactions redaction
                      where redaction.registration_case_id = case_row.id)
   for update;
  if registration.id is null then
    return false;
  end if;
  insert into outreach.registration_redactions (registration_case_id, facility_id, campaign_id, kind, reason,
    requested_by_account_id, correlation_id)
  values (registration.id, registration.facility_id, registration.campaign_id, redaction_kind, redaction_reason,
    requester, platform.current_correlation_id());
  update outreach.registration_cases case_row
     set full_name = '[redacted]', phone = null, operational_notes = null, row_version = case_row.row_version + 1
   where case_row.id = registration.id;
  update outreach.registration_consents consent
     set guardian_name = '[redacted]'
   where consent.registration_case_id = registration.id and consent.guardian_name is not null;
  update outreach.command_idempotency command
     set request_sha256 = repeat('0', 64)
   where command.registration_case_id = registration.id and command.request_sha256 <> repeat('0', 64);
  return true;
end
$$;
revoke all on function outreach.redact_registration_case(uuid,text,text,uuid) from public;

-- 3a. The sweeper (Identity, system:auth). Returns how many registrations
-- were redacted; also deletes sign-ups never activated after 30 days.
create function identity.sweep_expired_outreach_registrations(requested_limit integer)
returns integer language plpgsql security definer
set search_path = pg_catalog, identity, outreach, audit, platform, pg_temp
as $$
declare
  candidate record;
  redacted integer := 0;
  deleted_signups integer;
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'OUTREACH_RETENTION_DENIED';
  end if;
  if requested_limit is null or requested_limit not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'OUTREACH_RETENTION_LIMIT_INVALID';
  end if;
  perform outreach.begin_privileged_run('retention');
  for candidate in
    select case_row.id
      from outreach.registration_cases case_row
      join outreach.campaigns campaign on campaign.id = case_row.campaign_id and campaign.facility_id = case_row.facility_id
      join identity.outreach_organisations organisation on organisation.facility_id = case_row.facility_id
     where case_row.status = 'identity_resolution_pending'
       and outreach.registration_retain_until(campaign) <= clock_timestamp()
       and not exists (select 1 from outreach.registration_redactions redaction
                        where redaction.registration_case_id = case_row.id)
     order by case_row.created_at, case_row.id
     limit requested_limit
  loop
    if outreach.redact_registration_case(candidate.id, 'retention',
         'Kept 1 year and never linked to a Health ID', null) then
      redacted := redacted + 1;
    end if;
  end loop;
  perform outreach.end_privileged_run();
  delete from identity.outreach_organiser_signups signup
   where signup.ctid in (select stale.ctid from identity.outreach_organiser_signups stale
                          where stale.status <> 'active' and stale.created_at < clock_timestamp() - interval '30 days'
                          order by stale.created_at limit 1000);
  get diagnostics deleted_signups = row_count;
  if redacted > 0 or deleted_signups > 0 then
    insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, purpose_of_use,
      provenance, source_system, details)
    values (platform.current_correlation_id(), 'system', 'outreach.registration.retention-sweep', 'success',
      'outreach-registration', 'healthcare-operations', 'application', 'identity-api',
      jsonb_build_object('redacted', redacted, 'deletedSignups', deleted_signups));
  end if;
  return redacted;
end
$$;

-- 3b. Support redacts one registration on the person's request. Answers
-- 'redacted' or 'not_redactable' (not an unlinked registration of an
-- outreach group, or already redacted). 42501 ADMIN_PERMISSION_DENIED; 22023
-- OUTREACH_REDACTION_INVALID (a reason of 8-500 characters is required).
create function identity.admin_redact_outreach_registration(target_case_id uuid, requested_reason text)
returns text language plpgsql security definer
set search_path = pg_catalog, identity, outreach, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.outreach_support_actor(true);
  done boolean;
  target_facility uuid;
begin
  if target_case_id is null or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'OUTREACH_REDACTION_INVALID';
  end if;
  perform outreach.begin_privileged_run('retention');
  done := outreach.redact_registration_case(target_case_id, 'request', btrim(requested_reason), actor_account);
  select redaction.facility_id into target_facility from outreach.registration_redactions redaction
   where redaction.registration_case_id = target_case_id;
  perform outreach.end_privileged_run();
  if not done then
    return 'not_redactable';
  end if;
  perform identity.outreach_support_audit(actor_account,
    (select facility.organization_id from identity.facilities facility where facility.id = target_facility),
    target_facility, 'admin.outreach-registration.redact', 'outreach-registration', target_case_id::text,
    btrim(requested_reason), null);
  return 'redacted';
end
$$;

-- Ownership, as 0125.
do $$
declare
  outreach_owner name := pg_get_userbyid((select relowner from pg_class where oid = 'outreach.campaigns'::regclass));
  item record;
begin
  for item in
    select proc.oid::regprocedure::text as signature
      from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
     where (namespace.nspname, proc.proname) in (('outreach', 'stamp_campaign_closed_at'),
       ('outreach', 'registration_retain_until'), ('outreach', 'guard_command_idempotency_mutation'),
       ('outreach', 'redact_registration_case'))
       and pg_get_userbyid(proc.proowner) <> outreach_owner
  loop
    execute format('alter function %s owner to %I', item.signature, outreach_owner);
  end loop;
  if pg_get_userbyid((select relowner from pg_class where oid = 'outreach.registration_redactions'::regclass)) <> outreach_owner then
    execute format('alter table outreach.registration_redactions owner to %I', outreach_owner);
  end if;
end
$$;

-- Grants (here and in runtime-grants.sql).
revoke all on function outreach.stamp_campaign_closed_at(), outreach.registration_retain_until(outreach.campaigns),
  outreach.guard_command_idempotency_mutation(),
  identity.sweep_expired_outreach_registrations(integer), identity.admin_redact_outreach_registration(uuid,text)
  from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.sweep_expired_outreach_registrations(integer),
      identity.admin_redact_outreach_registration(uuid,text) to hid_identity_runtime;
  end if;
end
$$;

-- Post-checks.
do $$
declare
  mismatch text;
begin
  if not exists (select 1 from pg_attribute where attrelid = 'outreach.campaigns'::regclass and attname = 'closed_at'
                  and not attisdropped) then
    mismatch := 'campaigns.closed_at';
  elsif (select prosrc from pg_proc where oid = 'outreach.validate_registration_case_write()'::regprocedure)
        not like '%privileged_run_active(''retention'')%'
     or (select prosrc from pg_proc where oid = 'outreach.validate_registration_campaign_write()'::regprocedure)
        not like '%privileged_run_active(''retention'')%' then
    mismatch := 'the registration triggers';
  elsif (select count(*) from pg_policy where polname like '%retention%') <> 8 then
    mismatch := 'the retention policies';
  elsif exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid in ('identity.sweep_expired_outreach_registrations(integer)'::regprocedure,
                   'identity.admin_redact_outreach_registration(uuid,text)'::regprocedure)
                   and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) in ('hid_outreach_runtime', 'hid_outreach_api_runtime'))) then
    mismatch := 'the retention commands are executable by PUBLIC or the Outreach runtime';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0126: not as this file makes it: %s', mismatch);
  end if;
end
$$;
