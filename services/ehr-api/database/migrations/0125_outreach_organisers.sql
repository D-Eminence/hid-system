-- 0125 Outreach organisers: anybody can sign up on outreach. and run campaigns
-- in their own small Outreach group (plan "Open sign-up on outreach.", PR-1).
-- The number is a placeholder: it is renumbered when it merges.
--
-- Owner decisions (11 Nov 2026, final):
-- 1. Health ID support checks each organiser once before their first
--    campaign can go Active (review_state 'reviewed'); the admin queue makes
--    that one click.
-- 2. No per-organiser limits. Anti-bot protection stays: Turnstile (in
--    Identity), the public application quota per network
--    (platform.consume_public_application_quota, 0049) and a per-network cap
--    on sign-ups started here; the pending-invitation cap stays as an abuse
--    guard.
-- 4. Joint-controller terms and the DPIA are approved: terms version
--    '2026-11-01'.
-- 5. A person who already has a Health ID staff login (a hospital worker)
--    may start an outreach group with the same login: a second membership at
--    their own new outreach group. The public sign-up still refuses an email
--    that already has an account (sign in and use "Start an outreach group").
-- 6. Free: no billing.
--
-- WHAT IT ADDS (additive, except where it says "replaces")
-- A. auth.roles outreach_organiser (outreach.campaign.read/write,
--    outreach.registration.read/write) and outreach_volunteer
--    (outreach.campaign.read, outreach.registration.read/write). No
--    workforce.manage and no identity.consent.write.
-- B. identity.outreach_organisations: one row per outreach group (its own
--    organization and facility, lifecycle 'verified' so its members' sessions
--    work), with review_state pending | reviewed | suspended. Forced RLS, no
--    runtime privilege: the commands below are the only path.
-- C. identity.outreach_organiser_signups: a public sign-up (email code,
--    phone as HMAC and ciphertext, group name, kind, optional CAC/IT number
--    stored and not checked). Forced RLS, no runtime privilege.
-- D. Commands for the Identity runtime (system:auth): start, resend code,
--    verify email, activate. Signed in (an existing staff login):
--    identity.activate_outreach_organiser_for_account.
-- E. The fence (trigger account_roles_outreach_fence on auth.account_roles):
--    at an outreach group's facility only outreach_organiser and
--    outreach_volunteer can be granted; those two roles nowhere else; nothing
--    while the group is suspended. A revocation always passes. An account may
--    therefore hold hospital roles at hospitals and outreach roles at
--    outreach groups, never a clinical role at a group nor a group role at a
--    hospital.
-- F. Outreach invitations (identity.outreach_invitations and four commands):
--    only an outreach_organiser invites, the role is always
--    outreach_volunteer, at most 50 pending per group. Hospital staff
--    invitations (create_staff_invitation and its helpers) are not touched.
-- G. Rules for outreach groups' data (trigger outreach_organiser_tenant_rules
--    on outreach.registration_cases, campaigns, campaign_members and
--    patient_mappings; acts only when the facility is an outreach group's):
--    a registration needs a campaign; operational notes at most 280
--    characters; a campaign cannot become Active before support's review;
--    nothing changes while the group is suspended; no link to a Health ID.
-- H. outreach.registration_consents: one consent row per registration (text
--    version, language, method, guardian name for under-18s, who captured
--    it), immutable; a deferred check refuses a group's registration that
--    has no consent row in the same transaction.
-- I. The control outreach_organiser_signup_enabled, seeded OFF:
--    replaces the control_settings key CHECK and platform.control_enabled
--    (0086's body plus the new key).
-- J. Support's commands (platform permissions, audited): list organisers,
--    review (optionally renaming), suspend (revokes the group's roles and
--    pending invitations), close a group's campaign, appoint a campaign
--    admin. The last two run inside a "support run": a row in
--    outreach.privileged_runs for the current transaction, which the
--    support policies on outreach.campaigns and outreach.campaign_members and
--    the replaced outreach.validate_campaign_write() (replaces 0122's body)
--    recognise. Runtime roles cannot write that table.
--
-- PRECONDITIONS (catalog reads only; 55000 or 42501, nothing applied):
-- 0001-0122 applied (0122's outreach.campaign_staff(uuid) is the marker and
-- outreach.validate_campaign_write() has 0122's body, md5
-- 7d6caf5f570aa38e8d33c63b27d9282c); not applied yet; platform.control_enabled
-- has 0086's body (md5 ed17b9d8097417363c0a6343e52aa47f) and the key CHECK
-- lists exactly 0086's ten keys; the two restrictive campaign member
-- policies are as 0122 made them; the applier may SET ROLE to the owner of
-- the outreach and identity tables touched.
--
-- LOCKS: SHARE ROW EXCLUSIVE (blocks writes, not reads) on auth.account_roles,
-- outreach.campaigns, outreach.campaign_members, outreach.registration_cases,
-- outreach.patient_mappings and platform.control_settings (ACCESS EXCLUSIVE
-- for the CHECK swap), taken NOWAIT every 10 ms for at most 5 seconds (then
-- 55P03, nothing applied), held to commit.

do $$
declare
  attempt integer := 0;
  outreach_owner oid;
  identity_owner oid;
begin
  -- a. Prerequisites.
  if to_regprocedure('outreach.campaign_staff(uuid)') is null
     or to_regprocedure('outreach.validate_campaign_write()') is null
     or (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'outreach.validate_campaign_write()'::regprocedure)
        is distinct from '7d6caf5f570aa38e8d33c63b27d9282c'
     or to_regprocedure('identity.enforce_review_before_facility_role()') is null
     or to_regprocedure('platform.consume_public_application_quota(char)') is null
     or to_regprocedure('platform.require_control_enabled(text)') is null
     or to_regprocedure('identity.sealed_demo_account(uuid)') is null then
    raise exception using errcode = '55000', message = '0125: 0001-0122 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('identity.outreach_organisations') is not null
     or exists (select 1 from auth.roles where code in ('outreach_organiser', 'outreach_volunteer')) then
    raise exception using errcode = '55000', message = '0125: already applied';
  end if;
  -- c. The bodies replaced here.
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'platform.control_enabled(text)'::regprocedure)
     is distinct from 'ed17b9d8097417363c0a6343e52aa47f' then
    raise exception using errcode = '55000', message = '0125: platform.control_enabled is not as 0086 left it';
  end if;
  if (select array_agg(match[1] order by match[1])
        from pg_constraint constraint_row,
             regexp_matches(pg_get_constraintdef(constraint_row.oid), '''([a-z_]+)''', 'g') match
       where constraint_row.conrelid = 'platform.control_settings'::regclass
         and constraint_row.conname = 'control_settings_control_key_check')
     is distinct from array['break_glass_enabled', 'cross_facility_orders_enabled',
       'cross_facility_route_access_enabled', 'maintenance_mode', 'outreach_portal_enabled',
       'patient_portal_enabled', 'provider_portal_enabled', 'provider_self_service_enabled',
       'staff_invitations_enabled', 'uploads_enabled'] then
    raise exception using errcode = '55000', message = '0125: the control key CHECK is not as 0086 left it';
  end if;
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'outreach.campaign_members'::regclass and not policy_row.polpermissive
         and policy_row.polname in ('outreach_campaign_members_admin_create', 'outreach_campaign_members_admin_delete')) <> 2 then
    raise exception using errcode = '55000', message = '0125: the campaign member policies are not as 0122 made them';
  end if;
  if not exists (select 1 from auth.permissions where code in ('outreach.campaign.read') and active)
     or not exists (select 1 from auth.permissions where code in ('outreach.campaign.write') and active)
     or not exists (select 1 from auth.permissions where code in ('outreach.registration.read') and active)
     or not exists (select 1 from auth.permissions where code in ('outreach.registration.write') and active) then
    raise exception using errcode = '55000', message = '0125: the outreach permissions are missing';
  end if;
  -- d. Who owns what this file changes.
  outreach_owner := (select relation.relowner from pg_class relation where relation.oid = 'outreach.campaigns'::regclass);
  identity_owner := (select relation.relowner from pg_class relation where relation.oid = 'auth.account_roles'::regclass);
  if not pg_has_role(current_user, outreach_owner, 'SET') or not pg_has_role(current_user, identity_owner, 'SET')
     or (select proc.proowner from pg_proc proc where proc.oid = 'outreach.validate_campaign_write()'::regprocedure) <> outreach_owner then
    raise exception using errcode = '42501', message = format(
      '0125: the applier (%s) must be able to SET ROLE to the owners of outreach.campaigns (%s) and auth.account_roles (%s)',
      current_user, pg_get_userbyid(outreach_owner), pg_get_userbyid(identity_owner));
  end if;
  -- e. Locks, NOWAIT, at most 5 seconds.
  loop
    attempt := attempt + 1;
    begin
      lock table auth.account_roles, outreach.campaigns, outreach.campaign_members,
        outreach.registration_cases, outreach.patient_mappings in share row exclusive mode nowait;
      lock table platform.control_settings in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0125: the outreach or role tables stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- A. Roles.
insert into auth.roles (code, description) values
  ('outreach_organiser', 'Runs an outreach group: creates campaigns, invites helpers, registers people (outreach only)'),
  ('outreach_volunteer', 'Helps an outreach group: registers people into campaigns (outreach only)');
insert into auth.role_permissions (role_code, permission_code) values
  ('outreach_organiser', 'outreach.campaign.read'),
  ('outreach_organiser', 'outreach.campaign.write'),
  ('outreach_organiser', 'outreach.registration.read'),
  ('outreach_organiser', 'outreach.registration.write'),
  ('outreach_volunteer', 'outreach.campaign.read'),
  ('outreach_volunteer', 'outreach.registration.read'),
  ('outreach_volunteer', 'outreach.registration.write');

-- Vocabulary (owner-only, immutable).
create function identity.outreach_organiser_terms_version()
returns text language sql immutable set search_path = pg_catalog as $$ select '2026-11-01'::text $$;

-- A group name may not suggest a hospital or a government body: words in any
-- case, acronyms in capitals (so "people who care" is fine, "WHO" is not).
create function identity.outreach_group_name_allowed(candidate text)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select candidate is not null
    and lower(candidate) !~ '(^|[^a-z])(hospital|hospitals|ministry|government|federal)([^a-z]|$)'
    and candidate !~ '(^|[^A-Za-z])(WHO|NCDC|LUTH|NHIS|NHIA)([^A-Za-z]|$)'
$$;

create function identity.outreach_text_valid(candidate text, minimum integer, maximum integer)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select candidate is not null and candidate = btrim(candidate) and length(candidate) between minimum and maximum
    and candidate !~ '[[:cntrl:]<>]' and candidate !~ '  '
$$;

create function identity.outreach_email_valid(candidate text)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select candidate is not null and candidate = lower(btrim(candidate)) and length(candidate) between 3 and 254
    and candidate ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
$$;

-- B. Outreach groups.
create table identity.outreach_organisations (
  organization_id uuid primary key references identity.organizations(id) on delete restrict,
  facility_id uuid not null unique,
  kind text not null check (kind in ('individual', 'group')),
  display_name text not null check (identity.outreach_text_valid(display_name, 2, 120)),
  registration_number text check (registration_number is null
    or (length(registration_number) between 2 and 40 and registration_number ~ '^[A-Za-z0-9][A-Za-z0-9 /-]*$')),
  organiser_account_id uuid not null references auth.accounts(id) on delete restrict,
  contact_phone_lookup_hmac char(64) not null check (contact_phone_lookup_hmac ~ '^[0-9a-f]{64}$'),
  contact_phone_ciphertext bytea not null check (octet_length(contact_phone_ciphertext) >= 30),
  contact_key_version text not null check (length(contact_key_version) between 1 and 64),
  origin text not null check (origin in ('signup', 'existing_account')),
  signup_id uuid,
  terms_version text not null check (terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  terms_accepted_at timestamptz not null,
  review_state text not null default 'pending' check (review_state in ('pending', 'reviewed', 'suspended')),
  reviewed_by_account_id uuid references auth.accounts(id) on delete restrict,
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(btrim(review_note)) between 2 and 500),
  suspended_by_account_id uuid references auth.accounts(id) on delete restrict,
  suspended_at timestamptz,
  suspension_reason text check (suspension_reason is null or length(btrim(suspension_reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  constraint outreach_organisations_facility_fk foreign key (facility_id, organization_id)
    references identity.facilities(id, organization_id) on delete restrict,
  constraint outreach_organisations_origin_ck check ((origin = 'signup') = (signup_id is not null)),
  constraint outreach_organisations_review_ck check (
    (reviewed_at is null) = (reviewed_by_account_id is null)
    and (review_state <> 'reviewed' or reviewed_at is not null)),
  constraint outreach_organisations_suspension_ck check (
    (review_state = 'suspended') = (suspended_at is not null)
    and (suspended_at is null) = (suspended_by_account_id is null)
    and (suspended_at is null) = (suspension_reason is null))
);
create index outreach_organisations_state_idx on identity.outreach_organisations (review_state, created_at);
create index outreach_organisations_organiser_idx on identity.outreach_organisations (organiser_account_id);
alter table identity.outreach_organisations enable row level security;
alter table identity.outreach_organisations force row level security;
create policy outreach_organisations_command_read on identity.outreach_organisations for select using (true);
create policy outreach_organisations_command_insert on identity.outreach_organisations for insert with check (true);
create policy outreach_organisations_command_update on identity.outreach_organisations
  for update using (true) with check (true);
create policy outreach_organisations_command_delete on identity.outreach_organisations for delete using (true);
revoke all on identity.outreach_organisations from public;
comment on table identity.outreach_organisations is
  '0125: an outreach group (its own organization and facility). review_state: pending until Health ID support checks it once; a campaign cannot go Active before that. Shown as "Unverified organiser" while pending.';

-- C. Public sign-ups.
create table identity.outreach_organiser_signups (
  id uuid primary key,
  token_hmac char(64) not null check (token_hmac ~ '^[0-9a-f]{64}$'),
  email text not null check (identity.outreach_email_valid(email)),
  organiser_name text not null check (identity.outreach_text_valid(organiser_name, 2, 80)),
  group_name text not null check (identity.outreach_text_valid(group_name, 2, 120)),
  kind text not null check (kind in ('individual', 'group')),
  registration_number text check (registration_number is null
    or (length(registration_number) between 2 and 40 and registration_number ~ '^[A-Za-z0-9][A-Za-z0-9 /-]*$')),
  phone_lookup_hmac char(64) not null check (phone_lookup_hmac ~ '^[0-9a-f]{64}$'),
  phone_ciphertext bytea not null check (octet_length(phone_ciphertext) >= 30),
  key_version text not null check (length(key_version) between 1 and 64),
  network_digest char(64) not null check (network_digest ~ '^[0-9a-f]{64}$'),
  code_hmac char(64) not null check (code_hmac ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz not null,
  code_attempts integer not null default 0 check (code_attempts between 0 and 5),
  code_send_count integer not null default 1 check (code_send_count between 1 and 5),
  code_last_sent_at timestamptz not null default clock_timestamp(),
  email_verified_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'verified', 'active', 'superseded')),
  expires_at timestamptz not null default clock_timestamp() + interval '24 hours',
  account_id uuid references auth.accounts(id) on delete restrict,
  organization_id uuid references identity.organizations(id) on delete restrict,
  activated_at timestamptz,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  constraint outreach_organiser_signups_verified_ck check (
    (status in ('verified', 'active')) <= (email_verified_at is not null)),
  constraint outreach_organiser_signups_active_ck check (
    (status = 'active') = (account_id is not null and organization_id is not null and activated_at is not null))
);
create index outreach_organiser_signups_email_idx on identity.outreach_organiser_signups (email)
  where status in ('pending', 'verified');
create index outreach_organiser_signups_network_idx on identity.outreach_organiser_signups (network_digest, created_at);
create index outreach_organiser_signups_created_idx on identity.outreach_organiser_signups (created_at);
alter table identity.outreach_organiser_signups enable row level security;
alter table identity.outreach_organiser_signups force row level security;
create policy outreach_organiser_signups_command_read on identity.outreach_organiser_signups for select using (true);
create policy outreach_organiser_signups_command_insert on identity.outreach_organiser_signups for insert with check (true);
create policy outreach_organiser_signups_command_update on identity.outreach_organiser_signups
  for update using (true) with check (true);
create policy outreach_organiser_signups_command_delete on identity.outreach_organiser_signups for delete using (true);
revoke all on identity.outreach_organiser_signups from public;
alter table identity.outreach_organisations
  add constraint outreach_organisations_signup_fk foreign key (signup_id)
  references identity.outreach_organiser_signups(id) on delete restrict;

-- F (table). Outreach invitations.
create table identity.outreach_invitations (
  id uuid primary key,
  organization_id uuid not null,
  facility_id uuid not null references identity.outreach_organisations(facility_id) on delete restrict,
  invited_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  invited_by_membership_id uuid not null,
  invitee_name text not null check (identity.outreach_text_valid(invitee_name, 2, 80)),
  invitee_email text not null check (identity.outreach_email_valid(invitee_email)),
  role_code text not null default 'outreach_volunteer' check (role_code = 'outreach_volunteer')
    references auth.roles(code) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  link_token_hmac char(64) not null check (link_token_hmac ~ '^[0-9a-f]{64}$'),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 10),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_account_id uuid references auth.accounts(id) on delete restrict,
  accepted_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  revoked_at timestamptz,
  revoked_by_account_id uuid references auth.accounts(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  constraint outreach_invitations_facility_fk foreign key (facility_id, organization_id)
    references identity.facilities(id, organization_id) on delete restrict,
  constraint outreach_invitations_inviter_fk foreign key (invited_by_membership_id, facility_id, invited_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint outreach_invitations_accepted_ck check (
    (status = 'accepted') = (accepted_at is not null and accepted_account_id is not null and accepted_membership_id is not null)),
  constraint outreach_invitations_revoked_ck check (
    (status = 'revoked') = (revoked_at is not null)
    and (revoked_at is null) = (revoked_by_account_id is null))
);
create unique index outreach_invitations_pending_email_uq
  on identity.outreach_invitations (facility_id, invitee_email) where status = 'pending';
create index outreach_invitations_facility_idx on identity.outreach_invitations (facility_id, status, created_at);
alter table identity.outreach_invitations enable row level security;
alter table identity.outreach_invitations force row level security;
create policy outreach_invitations_command_read on identity.outreach_invitations for select using (true);
create policy outreach_invitations_command_insert on identity.outreach_invitations for insert with check (true);
create policy outreach_invitations_command_update on identity.outreach_invitations
  for update using (true) with check (true);
create policy outreach_invitations_command_delete on identity.outreach_invitations for delete using (true);
revoke all on identity.outreach_invitations from public;

-- J (table). A support or retention run: one row for the current transaction,
-- written and deleted by the support and retention commands only.
create table outreach.privileged_runs (
  transaction_id xid8 primary key,
  kind text not null check (kind in ('support', 'retention')),
  started_at timestamptz not null default clock_timestamp()
);
alter table outreach.privileged_runs enable row level security;
alter table outreach.privileged_runs force row level security;
create policy privileged_runs_command_read on outreach.privileged_runs for select using (true);
create policy privileged_runs_command_insert on outreach.privileged_runs for insert with check (true);
create policy privileged_runs_command_update on outreach.privileged_runs for update using (true) with check (true);
create policy privileged_runs_command_delete on outreach.privileged_runs for delete using (true);
revoke all on outreach.privileged_runs from public;

-- Whether this transaction is inside a support or retention command. It never
-- assigns a transaction ID (a read-only transaction stays read-only).
create function outreach.privileged_run_active(requested_kind text)
returns boolean language sql stable security definer
set search_path = pg_catalog, outreach, pg_temp
as $$
  select exists (select 1 from outreach.privileged_runs run
                  where run.transaction_id = pg_current_xact_id_if_assigned()
                    and run.kind = requested_kind)
$$;

create function outreach.begin_privileged_run(requested_kind text)
returns void language plpgsql volatile set search_path = pg_catalog, outreach, pg_temp
as $$
begin
  insert into outreach.privileged_runs (transaction_id, kind) values (pg_current_xact_id(), requested_kind);
end
$$;

create function outreach.end_privileged_run()
returns void language plpgsql volatile set search_path = pg_catalog, outreach, pg_temp
as $$
begin
  delete from outreach.privileged_runs run where run.transaction_id = pg_current_xact_id();
end
$$;

-- The review state of the outreach group that owns a facility, or null for
-- every other facility (hospitals, laboratories, pharmacies, the demo).
create function outreach.organiser_tenant_state(target_facility_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, identity, pg_temp
as $$
  select organisation.review_state from identity.outreach_organisations organisation
   where organisation.facility_id = target_facility_id
$$;

-- The session facility's organiser state, for outreach-api's governance
-- endpoint: 'pending' | 'reviewed' | 'suspended', or null (not a group).
create function outreach.organiser_status()
returns text language sql stable security definer
set search_path = pg_catalog, platform, identity, pg_temp
as $$
  select organisation.review_state from identity.outreach_organisations organisation
   where organisation.facility_id = platform.current_facility_id()
$$;

-- E. The fence on auth.account_roles.
create function identity.enforce_outreach_tenant_roles()
returns trigger language plpgsql security definer
set search_path = pg_catalog, identity, auth, pg_temp
as $$
declare
  tenant_state text;
  outreach_role boolean := new.role_code in ('outreach_organiser', 'outreach_volunteer');
begin
  if new.revoked_at is not null then
    return new;
  end if;
  if new.scope_type = 'facility' then
    -- FOR SHARE: a suspension in flight finishes first.
    select organisation.review_state into tenant_state
      from identity.outreach_organisations organisation
     where organisation.facility_id = new.facility_id
     for share;
  end if;
  if outreach_role and tenant_state is null then
    raise exception using errcode = 'P0001', message = 'OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP';
  end if;
  if not outreach_role and tenant_state is not null then
    raise exception using errcode = 'P0001', message = 'OUTREACH_GROUP_ROLE_INVALID';
  end if;
  if tenant_state = 'suspended' then
    raise exception using errcode = 'P0001', message = 'OUTREACH_ORGANISER_SUSPENDED';
  end if;
  return new;
end
$$;
revoke all on function identity.enforce_outreach_tenant_roles() from public;
create trigger account_roles_outreach_fence
  before insert or update of role_code, scope_type, facility_id, membership_id, revoked_at
  on auth.account_roles
  for each row execute function identity.enforce_outreach_tenant_roles();

-- G. Rules for outreach groups' data.
create function outreach.enforce_organiser_tenant_rules()
returns trigger language plpgsql security definer
set search_path = pg_catalog, platform, identity, outreach, pg_temp
as $$
declare
  tenant_state text;
begin
  if tg_op = 'DELETE' then
    tenant_state := outreach.organiser_tenant_state(old.facility_id);
    if tenant_state = 'suspended' and not outreach.privileged_run_active('support') then
      raise exception using errcode = '55000', message = 'OUTREACH_ORGANISER_SUSPENDED';
    end if;
    return old;
  end if;
  tenant_state := outreach.organiser_tenant_state(new.facility_id);
  if tenant_state is null
     or outreach.privileged_run_active('support') or outreach.privileged_run_active('retention') then
    return new;
  end if;
  if tenant_state = 'suspended' then
    raise exception using errcode = '55000', message = 'OUTREACH_ORGANISER_SUSPENDED';
  end if;
  if tg_table_name = 'patient_mappings' then
    raise exception using errcode = '42501', message = 'OUTREACH_TENANT_NO_HEALTH_ID_LINK';
  elsif tg_table_name = 'registration_cases' then
    if tg_op = 'INSERT' and new.campaign_id is null then
      raise exception using errcode = '23514', message = 'OUTREACH_CAMPAIGN_REQUIRED';
    end if;
    if new.operational_notes is not null and length(new.operational_notes) > 280 then
      raise exception using errcode = '23514', message = 'OUTREACH_NOTES_TOO_LONG';
    end if;
    if tg_op = 'UPDATE' and new.status = 'identity_resolved' then
      raise exception using errcode = '42501', message = 'OUTREACH_TENANT_NO_HEALTH_ID_LINK';
    end if;
  elsif tg_table_name = 'campaigns' then
    if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active')
       and tenant_state <> 'reviewed' then
      raise exception using errcode = '55000', message = 'OUTREACH_ORGANISER_AWAITING_REVIEW';
    end if;
  end if;
  return new;
end
$$;
revoke all on function outreach.enforce_organiser_tenant_rules() from public;
create trigger outreach_organiser_tenant_rules
  before insert or update on outreach.registration_cases
  for each row execute function outreach.enforce_organiser_tenant_rules();
create trigger outreach_organiser_tenant_rules
  before insert or update on outreach.campaigns
  for each row execute function outreach.enforce_organiser_tenant_rules();
create trigger outreach_organiser_tenant_rules
  before insert or delete on outreach.campaign_members
  for each row execute function outreach.enforce_organiser_tenant_rules();
create trigger outreach_organiser_tenant_rules
  before insert on outreach.patient_mappings
  for each row execute function outreach.enforce_organiser_tenant_rules();

-- H. Consent for each registration.
create table outreach.registration_consents (
  registration_case_id uuid primary key references outreach.registration_cases(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  consent_text_version text not null check (consent_text_version ~ '^[a-z0-9][a-z0-9.-]{2,63}$'),
  language text not null check (language in ('en', 'yo', 'ha', 'ig', 'pcm')),
  method text not null check (method in ('verbal_read_aloud', 'self_ticked', 'guardian')),
  guardian_name text check (guardian_name is null or length(btrim(guardian_name)) between 2 and 120),
  captured_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  captured_by_membership_id uuid not null,
  captured_at timestamptz not null default clock_timestamp(),
  constraint registration_consents_member_fk foreign key (captured_by_membership_id, facility_id, captured_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint registration_consents_guardian_ck check (method <> 'guardian' or guardian_name is not null)
);
alter table outreach.registration_consents enable row level security;
alter table outreach.registration_consents force row level security;
create policy outreach_registration_consents_read on outreach.registration_consents for select
  using (outreach.context_allows(facility_id, 'outreach.registration.read'));
create policy outreach_registration_consents_create on outreach.registration_consents for insert
  with check (outreach.context_allows(facility_id, 'outreach.registration.write')
    and captured_by_account_id = platform.current_account_id()
    and captured_by_membership_id = platform.current_membership_id());
revoke all on outreach.registration_consents from public;

create function outreach.validate_registration_consent()
returns trigger language plpgsql security definer
set search_path = pg_catalog, platform, outreach, pg_temp
as $$
declare
  registration outreach.registration_cases%rowtype;
begin
  if tg_op = 'INSERT' then
    -- Read under the session's own policies: the capturer must see the case.
    select * into registration from outreach.registration_cases case_row
     where case_row.id = new.registration_case_id and case_row.facility_id = new.facility_id;
    if not found then
      raise exception using errcode = '23514', message = 'OUTREACH_CONSENT_CASE_INVALID';
    end if;
    if registration.age_years < 18 and new.guardian_name is null then
      raise exception using errcode = '23514', message = 'OUTREACH_CONSENT_GUARDIAN_REQUIRED';
    end if;
    new.captured_at := clock_timestamp();
    return new;
  end if;
  -- Immutable, except that a retention run (0126) redacts the guardian's name.
  if tg_op = 'UPDATE' and outreach.privileged_run_active('retention')
     and new.registration_case_id = old.registration_case_id and new.facility_id = old.facility_id
     and new.consent_text_version = old.consent_text_version and new.language = old.language
     and new.method = old.method and new.captured_by_account_id = old.captured_by_account_id
     and new.captured_by_membership_id = old.captured_by_membership_id and new.captured_at = old.captured_at
     and new.guardian_name is not distinct from (case when old.guardian_name is null then null else '[redacted]' end) then
    return new;
  end if;
  raise exception using errcode = '55000', message = 'Outreach consent cannot be changed';
end
$$;
revoke all on function outreach.validate_registration_consent() from public;
create trigger outreach_registration_consent_validate
  before insert or update or delete on outreach.registration_consents
  for each row execute function outreach.validate_registration_consent();

-- An outreach group's registration needs its consent row in the same
-- transaction (checked at commit, under the capturer's session).
create function outreach.require_registration_consent()
returns trigger language plpgsql security definer
set search_path = pg_catalog, platform, outreach, pg_temp
as $$
begin
  if outreach.organiser_tenant_state(new.facility_id) is not null
     and not exists (select 1 from outreach.registration_consents consent
                      where consent.registration_case_id = new.id) then
    raise exception using errcode = '23514', message = 'OUTREACH_CONSENT_REQUIRED';
  end if;
  return null;
end
$$;
revoke all on function outreach.require_registration_consent() from public;
create constraint trigger outreach_registration_consent_required
  after insert on outreach.registration_cases
  deferrable initially deferred
  for each row execute function outreach.require_registration_consent();

-- I. The control, seeded OFF.
alter table platform.control_settings drop constraint control_settings_control_key_check;
alter table platform.control_settings add constraint control_settings_control_key_check check (control_key in (
  'patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
  'maintenance_mode', 'uploads_enabled', 'break_glass_enabled',
  'provider_self_service_enabled', 'staff_invitations_enabled',
  'cross_facility_orders_enabled', 'cross_facility_route_access_enabled',
  'outreach_organiser_signup_enabled'
));
-- As 0086's seed: lift FORCE only for this insert, and only if it is on.
do $$
declare
  was_forced boolean;
begin
  select relation.relforcerowsecurity into was_forced
    from pg_class relation where relation.oid = 'platform.control_settings'::regclass;
  if was_forced then
    execute 'alter table platform.control_settings no force row level security';
  end if;
  insert into platform.control_settings (control_key, enabled, reason, updated_by)
  values ('outreach_organiser_signup_enabled', false,
    'Outreach organiser sign-up ships closed; enable by audited admin command', null)
  on conflict do nothing;
  if not exists (select 1 from platform.control_settings
                  where control_key = 'outreach_organiser_signup_enabled' and not enabled) then
    raise exception using errcode = '55000', message = '0125: the sign-up control is not seeded off';
  end if;
  if was_forced then
    execute 'alter table platform.control_settings force row level security';
  end if;
end
$$;
create or replace function platform.control_enabled(requested_key text)
returns boolean
language plpgsql
stable
security definer
set search_path=platform,pg_catalog,pg_temp
as $$
declare enabled_state boolean;
begin
  if requested_key not in (
    'patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled',
    'maintenance_mode','uploads_enabled','break_glass_enabled',
    'provider_self_service_enabled','staff_invitations_enabled',
    'cross_facility_orders_enabled','cross_facility_route_access_enabled',
    'outreach_organiser_signup_enabled'
  ) then
    raise exception using errcode='22023', message='PLATFORM_CONTROL_INVALID';
  end if;

  select enabled into enabled_state
  from platform.control_settings
  where control_key = requested_key;

  if enabled_state is null then
    raise exception using errcode='55000', message='PLATFORM_CONTROL_UNAVAILABLE';
  end if;

  return enabled_state;
end
$$;

-- D. Shared steps (owner-only).
create function identity.outreach_signup_context()
returns void language plpgsql stable set search_path = pg_catalog, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'OUTREACH_ORGANISER_SIGNUP_DENIED';
  end if;
end
$$;

-- An email already used by a live account or a staff record.
create function identity.outreach_email_registered(target_email text)
returns boolean language sql stable set search_path = pg_catalog, identity, auth, pg_temp
as $$
  select exists (select 1 from auth.accounts account
                  where lower(account.email) = lower(target_email) and account.status <> 'deleted')
      or exists (select 1 from identity.staff staff where lower(staff.email) = lower(target_email))
$$;

-- Creates the group's organization, facility, the organiser's membership and
-- role, the group row and the audit row. Returns the new ids.
create function identity.create_outreach_group(
  organiser_account uuid, organiser_staff uuid, group_name text, group_kind text, group_registration text,
  phone_lookup_hmac char(64), phone_ciphertext bytea, key_version text, accepted_terms text,
  group_origin text, group_signup uuid, make_primary boolean,
  out new_organization_id uuid, out new_facility_id uuid, out new_membership_id uuid
) language plpgsql volatile set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
begin
  new_organization_id := gen_random_uuid();
  new_facility_id := gen_random_uuid();
  new_membership_id := gen_random_uuid();
  insert into identity.organizations (id, name, slug, active, source_system)
  values (new_organization_id, group_name, 'outreach-' || replace(new_organization_id::text, '-', ''), true, 'hid');
  insert into identity.facilities (id, organization_id, name, code, active, lifecycle_status, timezone, source_system)
  values (new_facility_id, new_organization_id, group_name, 'OUT-' || upper(replace(new_facility_id::text, '-', '')),
    true, 'verified', 'Africa/Lagos', 'hid');
  insert into identity.outreach_organisations (organization_id, facility_id, kind, display_name, registration_number,
    organiser_account_id, contact_phone_lookup_hmac, contact_phone_ciphertext, contact_key_version, origin, signup_id,
    terms_version, terms_accepted_at)
  values (new_organization_id, new_facility_id, group_kind, group_name, group_registration, organiser_account,
    phone_lookup_hmac, phone_ciphertext, key_version, group_origin, group_signup, accepted_terms, clock_timestamp());
  insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, source_system)
  values (new_membership_id, organiser_staff, organiser_account, new_organization_id, new_facility_id,
    'outreach_organiser', 'outreach_organiser', make_primary, true, 'hid');
  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason)
  values (gen_random_uuid(), organiser_account, 'outreach_organiser', 'facility', new_membership_id, new_facility_id,
    null, 'Started their own outreach group on Health ID');
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance,
    source_system, details)
  values (platform.current_correlation_id(),
    case when group_origin = 'signup' then 'system' else 'staff' end,
    case when group_origin = 'signup' then null else platform.current_actor_subject() end,
    organiser_account, new_membership_id, new_organization_id, new_facility_id,
    'identity.outreach-organiser.activate', 'success', 'outreach-organisation', new_organization_id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('origin', group_origin, 'kind', group_kind, 'termsVersion', accepted_terms));
end
$$;
revoke all on function identity.create_outreach_group(uuid,uuid,text,text,text,char,bytea,text,text,text,uuid,boolean) from public;

-- D. Public sign-up commands (Identity runtime, system:auth).
-- Answers: 'started', 'email_registered' (sign in and use "Start an outreach
-- group" instead), 'name_not_allowed', 'rate_limited'. 55000
-- PLATFORM_CONTROL_DISABLED:outreach_organiser_signup_enabled while the
-- control is off; P4290 APPLICATION_QUOTA_EXCEEDED from the network quota;
-- 22023 OUTREACH_ORGANISER_SIGNUP_INVALID for a malformed field.
create function identity.start_outreach_organiser_signup(
  requested_signup_id uuid, requested_token_hmac char(64), requested_email text,
  requested_organiser_name text, requested_group_name text, requested_kind text,
  requested_registration_number text, requested_phone_lookup_hmac char(64), requested_phone_ciphertext bytea,
  requested_key_version text, requested_network_digest char(64), requested_code_hmac char(64)
) returns text language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  normalized_email text := lower(btrim(requested_email));
begin
  perform identity.outreach_signup_context();
  perform platform.require_control_enabled('outreach_organiser_signup_enabled');
  if requested_signup_id is null
     or coalesce(requested_token_hmac, '') !~ '^[0-9a-f]{64}$'
     or coalesce(requested_code_hmac, '') !~ '^[0-9a-f]{64}$'
     or coalesce(requested_phone_lookup_hmac, '') !~ '^[0-9a-f]{64}$'
     or coalesce(requested_network_digest, '') !~ '^[0-9a-f]{64}$'
     or requested_phone_ciphertext is null or octet_length(requested_phone_ciphertext) < 30
     or coalesce(length(requested_key_version), 0) not between 1 and 64
     or not identity.outreach_email_valid(normalized_email)
     or not identity.outreach_text_valid(requested_organiser_name, 2, 80)
     or not identity.outreach_text_valid(requested_group_name, 2, 120)
     or requested_kind is null or requested_kind not in ('individual', 'group')
     or (requested_registration_number is not null and (length(requested_registration_number) not between 2 and 40
         or requested_registration_number !~ '^[A-Za-z0-9][A-Za-z0-9 /-]*$')) then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_SIGNUP_INVALID';
  end if;
  if not identity.outreach_group_name_allowed(requested_group_name) then
    return 'name_not_allowed';
  end if;
  perform platform.consume_public_application_quota(requested_network_digest);
  if identity.outreach_email_registered(normalized_email) then
    return 'email_registered';
  end if;
  if (select count(*) from identity.outreach_organiser_signups signup
       where signup.network_digest = requested_network_digest
         and signup.created_at > clock_timestamp() - interval '24 hours') >= 5 then
    return 'rate_limited';
  end if;
  update identity.outreach_organiser_signups signup
     set status = 'superseded', updated_at = clock_timestamp(), row_version = signup.row_version + 1
   where signup.email = normalized_email and signup.status in ('pending', 'verified');
  insert into identity.outreach_organiser_signups (id, token_hmac, email, organiser_name, group_name, kind,
    registration_number, phone_lookup_hmac, phone_ciphertext, key_version, network_digest, code_hmac,
    code_expires_at, correlation_id)
  values (requested_signup_id, requested_token_hmac, normalized_email, requested_organiser_name, requested_group_name,
    requested_kind, requested_registration_number, requested_phone_lookup_hmac, requested_phone_ciphertext,
    requested_key_version, requested_network_digest, requested_code_hmac, clock_timestamp() + interval '15 minutes',
    platform.current_correlation_id());
  return 'started';
end
$$;

-- Answers: 'sent', 'too_soon' (wait a minute), 'too_many' (5 codes sent),
-- 'expired' (start again), 'denied'.
create function identity.resend_outreach_organiser_signup_code(
  requested_signup_id uuid, requested_token_hmac char(64), requested_code_hmac char(64)
) returns text language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
declare
  signup identity.outreach_organiser_signups%rowtype;
begin
  perform identity.outreach_signup_context();
  perform platform.require_control_enabled('outreach_organiser_signup_enabled');
  if coalesce(requested_code_hmac, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_SIGNUP_INVALID';
  end if;
  select * into signup from identity.outreach_organiser_signups row
   where row.id = requested_signup_id for update;
  if not found or signup.token_hmac is distinct from requested_token_hmac then
    return 'denied';
  end if;
  if signup.status <> 'pending' or signup.expires_at <= clock_timestamp() then
    return 'expired';
  end if;
  if signup.code_send_count >= 5 then
    return 'too_many';
  end if;
  if signup.code_last_sent_at > clock_timestamp() - interval '60 seconds' then
    return 'too_soon';
  end if;
  update identity.outreach_organiser_signups row
     set code_hmac = requested_code_hmac, code_expires_at = clock_timestamp() + interval '15 minutes',
         code_attempts = 0, code_send_count = row.code_send_count + 1, code_last_sent_at = clock_timestamp(),
         updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.id = signup.id;
  return 'sent';
end
$$;

-- Answers: 'verified', 'wrong_code', 'code_expired' (ask for a new code),
-- 'locked' (5 wrong codes: ask for a new code), 'expired' (start again),
-- 'denied'. A wrong code is counted (the answer commits).
create function identity.verify_outreach_organiser_email(
  requested_signup_id uuid, requested_token_hmac char(64), requested_code_hmac char(64)
) returns text language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
declare
  signup identity.outreach_organiser_signups%rowtype;
begin
  perform identity.outreach_signup_context();
  select * into signup from identity.outreach_organiser_signups row
   where row.id = requested_signup_id for update;
  if not found or signup.token_hmac is distinct from requested_token_hmac then
    return 'denied';
  end if;
  if signup.status = 'verified' then
    return 'verified';
  end if;
  if signup.status <> 'pending' or signup.expires_at <= clock_timestamp() then
    return 'expired';
  end if;
  if signup.code_attempts >= 5 then
    return 'locked';
  end if;
  if signup.code_expires_at <= clock_timestamp() then
    return 'code_expired';
  end if;
  if requested_code_hmac is distinct from signup.code_hmac then
    update identity.outreach_organiser_signups row
       set code_attempts = row.code_attempts + 1, updated_at = clock_timestamp(), row_version = row.row_version + 1
     where row.id = signup.id;
    return case when signup.code_attempts + 1 >= 5 then 'locked' else 'wrong_code' end;
  end if;
  update identity.outreach_organiser_signups row
     set status = 'verified', email_verified_at = clock_timestamp(),
         updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.id = signup.id;
  return 'verified';
end
$$;

-- Creates the account, the organiser's staff record and the group. Refusals:
-- 42501 OUTREACH_ORGANISER_SIGNUP_DENIED; 23514 OUTREACH_ORGANISER_SIGNUP_NOT_READY
-- (email not verified, or the 24 hours passed); 22023
-- OUTREACH_ORGANISER_PASSWORD_INVALID; 22023 OUTREACH_ORGANISER_TERMS_REQUIRED
-- (not the current terms version); 22023 OUTREACH_ORGANISER_NAME_NOT_ALLOWED;
-- 23505 OUTREACH_ORGANISER_EMAIL_REGISTERED. A repeat after success answers
-- the same ids with replayed = true.
create function identity.activate_outreach_organiser(
  requested_signup_id uuid, requested_token_hmac char(64), requested_password_hash text, requested_terms_version text
) returns table (organization_id uuid, facility_id uuid, account_id uuid, membership_id uuid, hid_subject text,
  replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
#variable_conflict use_column
declare
  signup identity.outreach_organiser_signups%rowtype;
  new_account uuid;
  new_staff uuid;
  created record;
begin
  perform identity.outreach_signup_context();
  perform platform.require_control_enabled('outreach_organiser_signup_enabled');
  select * into signup from identity.outreach_organiser_signups row
   where row.id = requested_signup_id for update;
  if not found or signup.token_hmac is distinct from requested_token_hmac then
    raise exception using errcode = '42501', message = 'OUTREACH_ORGANISER_SIGNUP_DENIED';
  end if;
  if signup.status = 'active' then
    return query select signup.organization_id, organisation.facility_id, signup.account_id, membership.id,
        account.subject, true
      from identity.outreach_organisations organisation
      join auth.accounts account on account.id = signup.account_id
      join identity.staff_facility_memberships membership
        on membership.facility_id = organisation.facility_id and membership.account_id = signup.account_id
     where organisation.organization_id = signup.organization_id
     limit 1;
    return;
  end if;
  if signup.status <> 'verified' or signup.expires_at <= clock_timestamp() or signup.email_verified_at is null then
    raise exception using errcode = '23514', message = 'OUTREACH_ORGANISER_SIGNUP_NOT_READY';
  end if;
  if requested_password_hash is null or requested_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$'
     or length(requested_password_hash) not between 64 and 512 then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_PASSWORD_INVALID';
  end if;
  if requested_terms_version is distinct from identity.outreach_organiser_terms_version() then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_TERMS_REQUIRED';
  end if;
  if not identity.outreach_group_name_allowed(signup.group_name) then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_NAME_NOT_ALLOWED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('account-email:' || signup.email, 0));
  if identity.outreach_email_registered(signup.email) then
    raise exception using errcode = '23505', message = 'OUTREACH_ORGANISER_EMAIL_REGISTERED';
  end if;
  new_account := gen_random_uuid();
  new_staff := gen_random_uuid();
  insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm,
    password_changed_at, email_verified_at, status, source_system)
  values (new_account, 'outreach-organiser:' || new_account::text, signup.email, signup.organiser_name,
    requested_password_hash, 'argon2id', clock_timestamp(), signup.email_verified_at, 'active', 'hid');
  insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active, source_system)
  values (new_staff, new_account, signup.organiser_name, signup.email, 'verified', 'outreach_organiser', true, 'hid');
  select * into created from identity.create_outreach_group(new_account, new_staff, signup.group_name, signup.kind,
    signup.registration_number, signup.phone_lookup_hmac, signup.phone_ciphertext, signup.key_version,
    requested_terms_version, 'signup', signup.id, true);
  update identity.outreach_organiser_signups row
     set status = 'active', account_id = new_account, organization_id = created.new_organization_id,
         activated_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.id = signup.id;
  return query select created.new_organization_id, created.new_facility_id, new_account, created.new_membership_id,
    'outreach-organiser:' || new_account::text, false;
end
$$;

-- D (signed in). An existing Health ID staff login starts its own outreach
-- group: a second membership, at the new group, as outreach_organiser. The
-- hospital memberships and roles are untouched. Context: the request's
-- subject, a correlation ID and the healthcare-operations purpose of use.
-- Answers: 'started'; 'already_organiser' (the account already runs a group
-- that is not suspended; its ids are returned); 'name_not_allowed';
-- 'not_eligible' (no active, verified staff record, a platform role, a
-- locked or disabled account, or a demo login). 42501
-- OUTREACH_ORGANISER_ACCOUNT_REQUIRED without a signed-in account; 22023
-- OUTREACH_ORGANISER_SIGNUP_INVALID or OUTREACH_ORGANISER_TERMS_REQUIRED.
create function identity.activate_outreach_organiser_for_account(
  requested_group_name text, requested_kind text, requested_registration_number text, requested_terms_version text,
  requested_phone_lookup_hmac char(64), requested_phone_ciphertext bytea, requested_key_version text
) returns table (result text, organization_id uuid, facility_id uuid, membership_id uuid)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
  staff_row identity.staff%rowtype;
  existing record;
  created record;
begin
  if actor_account is null or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations' then
    raise exception using errcode = '42501', message = 'OUTREACH_ORGANISER_ACCOUNT_REQUIRED';
  end if;
  perform platform.require_control_enabled('outreach_organiser_signup_enabled');
  if not identity.outreach_text_valid(requested_group_name, 2, 120)
     or requested_kind is null or requested_kind not in ('individual', 'group')
     or (requested_registration_number is not null and (length(requested_registration_number) not between 2 and 40
         or requested_registration_number !~ '^[A-Za-z0-9][A-Za-z0-9 /-]*$'))
     or coalesce(requested_phone_lookup_hmac, '') !~ '^[0-9a-f]{64}$'
     or requested_phone_ciphertext is null or octet_length(requested_phone_ciphertext) < 30
     or coalesce(length(requested_key_version), 0) not between 1 and 64 then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_SIGNUP_INVALID';
  end if;
  if requested_terms_version is distinct from identity.outreach_organiser_terms_version() then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_TERMS_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('outreach-organiser-account:' || actor_account::text, 0));
  select organisation.organization_id, organisation.facility_id, membership.id as membership_id into existing
    from identity.outreach_organisations organisation
    join auth.account_roles assignment
      on assignment.facility_id = organisation.facility_id and assignment.account_id = actor_account
     and assignment.role_code = 'outreach_organiser' and assignment.scope_type = 'facility'
     and assignment.revoked_at is null
    join identity.staff_facility_memberships membership on membership.id = assignment.membership_id
   where organisation.review_state <> 'suspended'
   order by organisation.created_at
   limit 1;
  if existing.organization_id is not null then
    return query select 'already_organiser'::text, existing.organization_id, existing.facility_id, existing.membership_id;
    return;
  end if;
  if not identity.outreach_group_name_allowed(requested_group_name) then
    return query select 'name_not_allowed'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select staff.* into staff_row from identity.staff staff where staff.account_id = actor_account;
  if staff_row.id is null or not staff_row.active
     or lower(staff_row.verification_status) not in ('verified', 'approved', 'active')
     or not exists (select 1 from auth.accounts account where account.id = actor_account and account.status = 'active'
                     and (account.disabled_until is null or account.disabled_until <= clock_timestamp()))
     or exists (select 1 from auth.account_roles assignment where assignment.account_id = actor_account
                 and assignment.scope_type = 'platform' and assignment.revoked_at is null)
     or identity.sealed_demo_account(actor_account) then
    return query select 'not_eligible'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select * into created from identity.create_outreach_group(actor_account, staff_row.id, requested_group_name,
    requested_kind, requested_registration_number, requested_phone_lookup_hmac, requested_phone_ciphertext,
    requested_key_version, requested_terms_version, 'existing_account', null,
    not exists (select 1 from identity.staff_facility_memberships membership
                 where membership.account_id = actor_account and membership.active));
  return query select 'started'::text, created.new_organization_id, created.new_facility_id, created.new_membership_id;
end
$$;

-- F. Outreach invitations.
-- The organiser in the request's session: an active membership at a group
-- that is not suspended, holding outreach_organiser there.
create function identity.outreach_organiser_actor(
  out actor_account uuid, out actor_membership uuid, out actor_facility uuid, out actor_organization uuid
) language plpgsql stable set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
begin
  actor_account := auth.account_id_for_subject(platform.current_actor_subject());
  actor_membership := platform.current_membership_id();
  actor_facility := platform.current_facility_id();
  if actor_account is null or actor_membership is null or actor_facility is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not identity.has_active_membership(platform.current_actor_subject(), actor_membership, actor_facility)
     or not exists (select 1 from auth.account_roles assignment
                     where assignment.account_id = actor_account and assignment.membership_id = actor_membership
                       and assignment.facility_id = actor_facility and assignment.scope_type = 'facility'
                       and assignment.role_code = 'outreach_organiser' and assignment.revoked_at is null) then
    raise exception using errcode = '42501', message = 'OUTREACH_ORGANISER_PERMISSION_DENIED';
  end if;
  select organisation.organization_id into actor_organization
    from identity.outreach_organisations organisation
   where organisation.facility_id = actor_facility and organisation.review_state <> 'suspended';
  if actor_organization is null then
    raise exception using errcode = '42501', message = 'OUTREACH_ORGANISER_PERMISSION_DENIED';
  end if;
end
$$;
revoke all on function identity.outreach_organiser_actor() from public;

-- Answers: 'created', 'already_member', 'already_invited', 'too_many_pending'
-- (50 pending invitations; an abuse guard). 22023 OUTREACH_INVITATION_INVALID.
-- The invitation lasts 7 days; Identity emails the link.
create function identity.create_outreach_invitation(
  requested_invitation_id uuid, requested_name text, requested_email text, requested_link_token_hmac char(64)
) returns table (result text, invitation_id uuid, expires_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  normalized_email text := lower(btrim(requested_email));
  new_expiry timestamptz := clock_timestamp() + interval '7 days';
begin
  select * into actor from identity.outreach_organiser_actor();
  if requested_invitation_id is null or not identity.outreach_text_valid(requested_name, 2, 80)
     or not identity.outreach_email_valid(normalized_email)
     or coalesce(requested_link_token_hmac, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'OUTREACH_INVITATION_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('outreach-invitations:' || actor.actor_facility::text, 0));
  update identity.outreach_invitations invitation
     set status = 'expired', updated_at = clock_timestamp(), row_version = invitation.row_version + 1
   where invitation.facility_id = actor.actor_facility and invitation.status = 'pending'
     and invitation.expires_at <= clock_timestamp();
  if exists (select 1 from identity.staff_facility_memberships membership
               join auth.accounts account on account.id = membership.account_id
              where membership.facility_id = actor.actor_facility and membership.active
                and lower(account.email) = normalized_email) then
    return query select 'already_member'::text, null::uuid, null::timestamptz;
    return;
  end if;
  if exists (select 1 from identity.outreach_invitations invitation
              where invitation.facility_id = actor.actor_facility and invitation.status = 'pending'
                and invitation.invitee_email = normalized_email) then
    return query select 'already_invited'::text, null::uuid, null::timestamptz;
    return;
  end if;
  if (select count(*) from identity.outreach_invitations invitation
       where invitation.facility_id = actor.actor_facility and invitation.status = 'pending') >= 50 then
    return query select 'too_many_pending'::text, null::uuid, null::timestamptz;
    return;
  end if;
  insert into identity.outreach_invitations (id, organization_id, facility_id, invited_by_account_id,
    invited_by_membership_id, invitee_name, invitee_email, link_token_hmac, expires_at)
  values (requested_invitation_id, actor.actor_organization, actor.actor_facility, actor.actor_account,
    actor.actor_membership, requested_name, normalized_email, requested_link_token_hmac, new_expiry);
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance,
    source_system, details)
  values (platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.actor_account,
    actor.actor_membership, actor.actor_organization, actor.actor_facility, 'identity.outreach-invitation.create',
    'success', 'outreach-invitation', requested_invitation_id::text, 'healthcare-operations', 'application',
    'identity-api', jsonb_build_object('roleCode', 'outreach_volunteer'));
  return query select 'created'::text, requested_invitation_id, new_expiry;
end
$$;

-- Answers 'revoked' or 'not_found' (no pending invitation of this group).
create function identity.revoke_outreach_invitation(requested_invitation_id uuid)
returns text language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
begin
  select * into actor from identity.outreach_organiser_actor();
  update identity.outreach_invitations invitation
     set status = 'revoked', revoked_at = clock_timestamp(), revoked_by_account_id = actor.actor_account,
         updated_at = clock_timestamp(), row_version = invitation.row_version + 1
   where invitation.id = requested_invitation_id and invitation.facility_id = actor.actor_facility
     and invitation.status = 'pending';
  if not found then
    return 'not_found';
  end if;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance,
    source_system, details)
  values (platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.actor_account,
    actor.actor_membership, actor.actor_organization, actor.actor_facility, 'identity.outreach-invitation.revoke',
    'success', 'outreach-invitation', requested_invitation_id::text, 'healthcare-operations', 'application',
    'identity-api', '{}'::jsonb);
  return 'revoked';
end
$$;

-- The group's team: its members (with their outreach role) and its pending
-- invitations, for the organiser's "Your team" panel. At most 500 rows.
create function identity.list_outreach_team()
returns table (entry_kind text, entry_id uuid, full_name text, email text, role_code text, status text,
  created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
begin
  select * into actor from identity.outreach_organiser_actor();
  return query
    select * from (
      select 'member'::text, membership.id, staff.full_name, lower(account.email),
        (select assignment.role_code from auth.account_roles assignment
          where assignment.membership_id = membership.id and assignment.revoked_at is null
            and assignment.scope_type = 'facility'
          order by assignment.role_code limit 1),
        case when membership.active then 'active' else 'ended' end, membership.created_at, null::timestamptz
        from identity.staff_facility_memberships membership
        join identity.staff staff on staff.id = membership.staff_id
        join auth.accounts account on account.id = membership.account_id
       where membership.facility_id = actor.actor_facility
      union all
      select 'invitation'::text, invitation.id, invitation.invitee_name, invitation.invitee_email, invitation.role_code,
        invitation.status, invitation.created_at, invitation.expires_at
        from identity.outreach_invitations invitation
       where invitation.facility_id = actor.actor_facility and invitation.status = 'pending'
         and invitation.expires_at > clock_timestamp()
    ) team(entry_kind, entry_id, full_name, email, role_code, status, created_at, expires_at)
    order by team.entry_kind desc, team.created_at, team.entry_id
    limit 500;
end
$$;

-- The invitation behind a link, locked, or a reason it cannot be used.
-- A wrong token counts against the invitation (10 wrong: expired).
create function identity.outreach_invitation_for_link(
  requested_invitation_id uuid, requested_link_token_hmac char(64), out answer text,
  out invitation identity.outreach_invitations
) language plpgsql volatile set search_path = pg_catalog, identity, pg_temp
as $$
begin
  select * into invitation from identity.outreach_invitations row where row.id = requested_invitation_id for update;
  if invitation.id is null then
    answer := 'invalid';
    return;
  end if;
  if invitation.link_token_hmac is distinct from requested_link_token_hmac then
    update identity.outreach_invitations row
       set failed_attempts = least(row.failed_attempts + 1, 10),
           status = case when row.status = 'pending' and row.failed_attempts + 1 >= 10 then 'expired' else row.status end,
           updated_at = clock_timestamp(), row_version = row.row_version + 1
     where row.id = invitation.id;
    answer := 'invalid';
    return;
  end if;
  if invitation.status = 'accepted' then
    answer := 'used';
  elsif invitation.status <> 'pending' or invitation.expires_at <= clock_timestamp() then
    answer := 'expired';
  elsif coalesce(outreach.organiser_tenant_state(invitation.facility_id), 'suspended') = 'suspended' then
    answer := 'group_unavailable';
  else
    answer := 'ready';
  end if;
end
$$;
revoke all on function identity.outreach_invitation_for_link(uuid,char) from public;

-- Attaches an account's staff record to the group as outreach_volunteer and
-- closes the invitation.
create function identity.attach_outreach_volunteer(invitation identity.outreach_invitations, target_account uuid,
  target_staff uuid, actor_type text) returns uuid
language plpgsql volatile set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  attached uuid := gen_random_uuid();
begin
  insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, source_system)
  values (attached, target_staff, target_account, invitation.organization_id, invitation.facility_id,
    'outreach_volunteer', 'outreach_volunteer',
    not exists (select 1 from identity.staff_facility_memberships membership
                 where membership.account_id = target_account and membership.active), true, 'hid');
  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason)
  values (gen_random_uuid(), target_account, 'outreach_volunteer', 'facility', attached, invitation.facility_id,
    invitation.invited_by_account_id, 'Accepted an invitation to help an outreach group');
  update identity.outreach_invitations row
     set status = 'accepted', accepted_at = clock_timestamp(), accepted_account_id = target_account,
         accepted_membership_id = attached, updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.id = invitation.id;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance,
    source_system, details)
  values (platform.current_correlation_id(), actor_type,
    case when actor_type = 'staff' then platform.current_actor_subject() end, target_account, attached,
    invitation.organization_id, invitation.facility_id, 'identity.outreach-invitation.accept', 'success',
    'outreach-invitation', invitation.id::text, 'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('roleCode', 'outreach_volunteer'));
  return attached;
end
$$;
revoke all on function identity.attach_outreach_volunteer(identity.outreach_invitations,uuid,uuid,text) from public;

-- What a link shows before accepting (system:auth). account_case: 'new' (set
-- a password here) or 'existing' (sign in first). Answers: 'ready',
-- 'invalid', 'expired', 'used', 'group_unavailable'.
create function identity.preview_outreach_invitation(requested_invitation_id uuid, requested_link_token_hmac char(64))
returns table (result text, group_name text, inviter_name text, invitee_name text, invitee_email text,
  account_case text, expires_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
#variable_conflict use_column
declare
  found_link record;
begin
  perform identity.outreach_signup_context();
  select * into found_link from identity.outreach_invitation_for_link(requested_invitation_id, requested_link_token_hmac);
  if found_link.answer <> 'ready' then
    return query select found_link.answer, null::text, null::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;
  return query
    select 'ready'::text, organisation.display_name, inviter.display_name, (found_link.invitation).invitee_name,
      (found_link.invitation).invitee_email,
      case when identity.outreach_email_registered((found_link.invitation).invitee_email) then 'existing' else 'new' end,
      (found_link.invitation).expires_at
      from identity.outreach_organisations organisation
      join auth.accounts inviter on inviter.id = (found_link.invitation).invited_by_account_id
     where organisation.facility_id = (found_link.invitation).facility_id;
end
$$;

-- A new helper sets a password (system:auth): the link proves the email.
-- Answers as preview, plus 'sign_in_required' (the email already has a
-- login: sign in and accept there). 22023 OUTREACH_INVITATION_PASSWORD_INVALID.
create function identity.accept_outreach_invitation_with_password(
  requested_invitation_id uuid, requested_link_token_hmac char(64), requested_password_hash text
) returns table (result text, account_id uuid, membership_id uuid, facility_id uuid, hid_subject text)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
#variable_conflict use_column
declare
  found_link record;
  new_account uuid;
  new_staff uuid;
  attached uuid;
begin
  perform identity.outreach_signup_context();
  if requested_password_hash is null or requested_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$'
     or length(requested_password_hash) not between 64 and 512 then
    raise exception using errcode = '22023', message = 'OUTREACH_INVITATION_PASSWORD_INVALID';
  end if;
  select * into found_link from identity.outreach_invitation_for_link(requested_invitation_id, requested_link_token_hmac);
  if found_link.answer <> 'ready' then
    return query select found_link.answer, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('account-email:' || (found_link.invitation).invitee_email, 0));
  if identity.outreach_email_registered((found_link.invitation).invitee_email) then
    return query select 'sign_in_required'::text, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;
  new_account := gen_random_uuid();
  new_staff := gen_random_uuid();
  insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm,
    password_changed_at, email_verified_at, status, source_system)
  values (new_account, 'outreach-volunteer:' || new_account::text, (found_link.invitation).invitee_email,
    (found_link.invitation).invitee_name, requested_password_hash, 'argon2id', clock_timestamp(), clock_timestamp(),
    'active', 'hid');
  insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active, source_system)
  values (new_staff, new_account, (found_link.invitation).invitee_name, (found_link.invitation).invitee_email,
    'verified', 'outreach_volunteer', true, 'hid');
  attached := identity.attach_outreach_volunteer(found_link.invitation, new_account, new_staff, 'system');
  return query select 'ready'::text, new_account, attached, (found_link.invitation).facility_id,
    'outreach-volunteer:' || new_account::text;
end
$$;

-- A signed-in staff login (for example a hospital worker) accepts with the
-- same login. Context as activate_outreach_organiser_for_account. Answers as
-- preview, plus 'email_mismatch', 'already_member', 'not_eligible'.
create function identity.accept_outreach_invitation_for_account(
  requested_invitation_id uuid, requested_link_token_hmac char(64)
) returns table (result text, membership_id uuid, facility_id uuid)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
  found_link record;
  staff_row identity.staff%rowtype;
  attached uuid;
begin
  if actor_account is null or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations' then
    raise exception using errcode = '42501', message = 'OUTREACH_ORGANISER_ACCOUNT_REQUIRED';
  end if;
  select * into found_link from identity.outreach_invitation_for_link(requested_invitation_id, requested_link_token_hmac);
  if found_link.answer <> 'ready' then
    return query select found_link.answer, null::uuid, null::uuid;
    return;
  end if;
  if not exists (select 1 from auth.accounts account where account.id = actor_account
                  and lower(account.email) = (found_link.invitation).invitee_email) then
    return query select 'email_mismatch'::text, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from identity.staff_facility_memberships membership
              where membership.account_id = actor_account and membership.facility_id = (found_link.invitation).facility_id
                and membership.active) then
    return query select 'already_member'::text, null::uuid, (found_link.invitation).facility_id;
    return;
  end if;
  select staff.* into staff_row from identity.staff staff where staff.account_id = actor_account;
  if staff_row.id is null or not staff_row.active
     or lower(staff_row.verification_status) not in ('verified', 'approved', 'active')
     or not exists (select 1 from auth.accounts account where account.id = actor_account and account.status = 'active')
     or exists (select 1 from auth.account_roles assignment where assignment.account_id = actor_account
                 and assignment.scope_type = 'platform' and assignment.revoked_at is null)
     or identity.sealed_demo_account(actor_account) then
    return query select 'not_eligible'::text, null::uuid, null::uuid;
    return;
  end if;
  attached := identity.attach_outreach_volunteer(found_link.invitation, actor_account, staff_row.id, 'staff');
  return query select 'ready'::text, attached, (found_link.invitation).facility_id;
end
$$;

-- J. Support's commands. Context: a platform account, a correlation ID, the
-- healthcare-operations purpose of use and platform.admin.access with, to
-- read, platform.facility.read and, to change, platform.facility.manage and
-- platform.facility.unlock; else 42501 ADMIN_PERMISSION_DENIED.
create function identity.outreach_support_actor(write_access boolean)
returns uuid language plpgsql stable set search_path = pg_catalog, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or (not write_access and not auth.account_has_platform_permission(actor_account, 'platform.facility.read'))
     or (write_access and (not auth.account_has_platform_permission(actor_account, 'platform.facility.manage')
       or not auth.account_has_platform_permission(actor_account, 'platform.facility.unlock'))) then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return actor_account;
end
$$;
revoke all on function identity.outreach_support_actor(boolean) from public;

create function identity.outreach_support_audit(actor_account uuid, target_organization uuid, target_facility uuid,
  audit_action text, audit_resource_type text, audit_resource text, audit_reason text, audit_details jsonb)
returns void language sql volatile set search_path = pg_catalog, audit, platform, pg_temp
as $$
  -- A platform actor's audit row names no facility or organization (audit_platform_scope_ck): they go in details.
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
    action, outcome, resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details)
  values (platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    audit_action, 'success', audit_resource_type, audit_resource,
    'healthcare-operations', audit_reason, 'application', 'identity-api',
    coalesce(audit_details, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object('organizationId', target_organization, 'facilityId', target_facility)))
$$;
revoke all on function identity.outreach_support_audit(uuid,uuid,uuid,text,text,text,text,jsonb) from public;

-- The queue: requested_state 'pending' (oldest first; the check queue),
-- 'reviewed', 'suspended' or 'all'. At most 500 rows. The contact phone is
-- returned as stored (ciphertext); Identity decrypts it for support.
create function identity.admin_list_outreach_organisers(requested_state text)
returns table (organization_id uuid, facility_id uuid, row_version bigint, display_name text, kind text,
  registration_number text, review_state text, origin text, organiser_account_id uuid, organiser_name text,
  organiser_email text, contact_phone_ciphertext bytea, contact_key_version text, terms_version text,
  created_at timestamptz, reviewed_at timestamptz, review_note text, suspended_at timestamptz,
  suspension_reason text, member_count integer, pending_invitation_count integer, campaign_count integer,
  active_campaign_count integer)
language plpgsql volatile security definer
set search_path = pg_catalog, identity, auth, outreach, platform, pg_temp
as $$
#variable_conflict use_column
begin
  perform identity.outreach_support_actor(false);
  if requested_state is null or requested_state not in ('pending', 'reviewed', 'suspended', 'all') then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_STATE_INVALID';
  end if;
  perform outreach.begin_privileged_run('support');
  return query
    select organisation.organization_id, organisation.facility_id, organisation.row_version, organisation.display_name,
      organisation.kind, organisation.registration_number, organisation.review_state, organisation.origin,
      organisation.organiser_account_id, account.display_name, lower(account.email),
      organisation.contact_phone_ciphertext, organisation.contact_key_version, organisation.terms_version,
      organisation.created_at, organisation.reviewed_at, organisation.review_note, organisation.suspended_at,
      organisation.suspension_reason,
      (select count(*)::integer from identity.staff_facility_memberships membership
        where membership.facility_id = organisation.facility_id and membership.active),
      (select count(*)::integer from identity.outreach_invitations invitation
        where invitation.facility_id = organisation.facility_id and invitation.status = 'pending'
          and invitation.expires_at > clock_timestamp()),
      (select count(*)::integer from outreach.campaigns campaign where campaign.facility_id = organisation.facility_id),
      (select count(*)::integer from outreach.campaigns campaign
        where campaign.facility_id = organisation.facility_id and campaign.status = 'active')
      from identity.outreach_organisations organisation
      join auth.accounts account on account.id = organisation.organiser_account_id
     where requested_state = 'all' or organisation.review_state = requested_state
     order by case when requested_state = 'pending' then organisation.created_at end asc,
       organisation.created_at desc, organisation.organization_id
     limit 500;
  perform outreach.end_privileged_run();
  perform identity.outreach_support_audit(platform.current_account_id(), null, null, 'admin.outreach-organiser.list',
    'outreach-organisation', null, null, jsonb_build_object('state', requested_state));
end
$$;

-- One click: the group is checked. Optionally renames it (the group's
-- organization, facility and display name) and keeps a note. Refusals: 22023
-- OUTREACH_ORGANISER_REVIEW_INVALID; P0002 OUTREACH_ORGANISER_NOT_FOUND;
-- 40001 OUTREACH_ORGANISER_VERSION_CONFLICT; 23514
-- OUTREACH_ORGANISER_NOT_PENDING.
create function identity.admin_review_outreach_organiser(target_organization_id uuid, expected_version bigint,
  requested_display_name text default null, requested_note text default null)
returns table (row_version bigint, review_state text)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.outreach_support_actor(true);
  organisation identity.outreach_organisations%rowtype;
begin
  if target_organization_id is null or expected_version is null
     or (requested_display_name is not null and not identity.outreach_text_valid(requested_display_name, 2, 120))
     or (requested_note is not null and length(btrim(requested_note)) not between 2 and 500) then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_REVIEW_INVALID';
  end if;
  select * into organisation from identity.outreach_organisations row
   where row.organization_id = target_organization_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'OUTREACH_ORGANISER_NOT_FOUND';
  end if;
  if organisation.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'OUTREACH_ORGANISER_VERSION_CONFLICT';
  end if;
  if organisation.review_state <> 'pending' then
    raise exception using errcode = '23514', message = 'OUTREACH_ORGANISER_NOT_PENDING';
  end if;
  if requested_display_name is not null and requested_display_name <> organisation.display_name then
    update identity.organizations row set name = requested_display_name, updated_at = clock_timestamp(),
      row_version = row.row_version + 1 where row.id = organisation.organization_id;
    update identity.facilities row set name = requested_display_name, updated_at = clock_timestamp(),
      row_version = row.row_version + 1 where row.id = organisation.facility_id;
  end if;
  update identity.outreach_organisations row
     set review_state = 'reviewed', reviewed_by_account_id = actor_account, reviewed_at = clock_timestamp(),
         review_note = requested_note, display_name = coalesce(requested_display_name, row.display_name),
         updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.organization_id = organisation.organization_id;
  perform identity.outreach_support_audit(actor_account, organisation.organization_id, organisation.facility_id,
    'admin.outreach-organiser.review', 'outreach-organisation', organisation.organization_id::text, requested_note,
    jsonb_build_object('renamed', requested_display_name is not null
      and requested_display_name <> organisation.display_name));
  return query select organisation.row_version + 1, 'reviewed'::text;
end
$$;

-- Suspends a group: every active role at it is revoked and its pending
-- invitations end; its campaigns and registrations stay, read-only. Refusals
-- as review, with 22023 OUTREACH_ORGANISER_SUSPEND_INVALID (a reason of
-- 8-500 characters is required) and 23514 OUTREACH_ORGANISER_ALREADY_SUSPENDED.
create function identity.admin_suspend_outreach_organiser(target_organization_id uuid, expected_version bigint,
  requested_reason text)
returns table (row_version bigint, review_state text, revoked_roles integer)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.outreach_support_actor(true);
  organisation identity.outreach_organisations%rowtype;
  revoked_count integer;
begin
  if target_organization_id is null or expected_version is null or requested_reason is null
     or length(btrim(requested_reason)) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_SUSPEND_INVALID';
  end if;
  select * into organisation from identity.outreach_organisations row
   where row.organization_id = target_organization_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'OUTREACH_ORGANISER_NOT_FOUND';
  end if;
  if organisation.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'OUTREACH_ORGANISER_VERSION_CONFLICT';
  end if;
  if organisation.review_state = 'suspended' then
    raise exception using errcode = '23514', message = 'OUTREACH_ORGANISER_ALREADY_SUSPENDED';
  end if;
  update identity.outreach_organisations row
     set review_state = 'suspended', suspended_at = clock_timestamp(), suspended_by_account_id = actor_account,
         suspension_reason = btrim(requested_reason), updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.organization_id = organisation.organization_id;
  update auth.account_roles assignment
     set revoked_at = clock_timestamp(), revoked_by = actor_account, revocation_reason = btrim(requested_reason),
         row_version = assignment.row_version + 1
   where assignment.facility_id = organisation.facility_id and assignment.scope_type = 'facility'
     and assignment.revoked_at is null;
  get diagnostics revoked_count = row_count;
  update identity.outreach_invitations invitation
     set status = 'revoked', revoked_at = clock_timestamp(), revoked_by_account_id = actor_account,
         updated_at = clock_timestamp(), row_version = invitation.row_version + 1
   where invitation.facility_id = organisation.facility_id and invitation.status = 'pending';
  perform identity.outreach_support_audit(actor_account, organisation.organization_id, organisation.facility_id,
    'admin.outreach-organiser.suspend', 'outreach-organisation', organisation.organization_id::text,
    btrim(requested_reason), jsonb_build_object('revokedRoles', revoked_count));
  return query select organisation.row_version + 1, 'suspended'::text, revoked_count;
end
$$;

-- Support closes an outreach group's campaign whose only admin has gone.
-- Refusals: 22023 OUTREACH_CAMPAIGN_RESCUE_INVALID; P0002
-- OUTREACH_CAMPAIGN_NOT_FOUND (no such campaign at an outreach group); 40001
-- OUTREACH_CAMPAIGN_VERSION_CONFLICT. Answers 'closed' or 'already_closed'.
create function identity.admin_close_outreach_campaign(target_campaign_id uuid, expected_version bigint,
  requested_reason text)
returns text language plpgsql security definer
set search_path = pg_catalog, identity, outreach, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.outreach_support_actor(true);
  campaign record;
begin
  if target_campaign_id is null or expected_version is null or requested_reason is null
     or length(btrim(requested_reason)) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'OUTREACH_CAMPAIGN_RESCUE_INVALID';
  end if;
  perform outreach.begin_privileged_run('support');
  select row.id, row.facility_id, row.status, row.row_version, organisation.organization_id into campaign
    from outreach.campaigns row
    join identity.outreach_organisations organisation on organisation.facility_id = row.facility_id
   where row.id = target_campaign_id
   for update of row;
  if campaign.id is null then
    raise exception using errcode = 'P0002', message = 'OUTREACH_CAMPAIGN_NOT_FOUND';
  end if;
  if campaign.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'OUTREACH_CAMPAIGN_VERSION_CONFLICT';
  end if;
  if campaign.status = 'closed' then
    perform outreach.end_privileged_run();
    return 'already_closed';
  end if;
  update outreach.campaigns row set status = 'closed', row_version = row.row_version + 1 where row.id = campaign.id;
  perform outreach.end_privileged_run();
  perform identity.outreach_support_audit(actor_account, campaign.organization_id, campaign.facility_id,
    'admin.outreach-campaign.close', 'outreach-campaign', campaign.id::text, btrim(requested_reason), null);
  return 'closed';
end
$$;

-- Support makes a member of the group an admin of one of its campaigns.
-- The membership must be active at the group with an outreach role. Answers
-- 'appointed' or 'already_admin'. Refusals as close, with 23514
-- OUTREACH_CAMPAIGN_ADMIN_NOT_ELIGIBLE.
create function identity.admin_appoint_outreach_campaign_admin(target_campaign_id uuid, target_membership_id uuid,
  requested_reason text)
returns text language plpgsql security definer
set search_path = pg_catalog, identity, auth, outreach, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.outreach_support_actor(true);
  campaign record;
  membership identity.staff_facility_memberships%rowtype;
  existing_role text;
begin
  if target_campaign_id is null or target_membership_id is null or requested_reason is null
     or length(btrim(requested_reason)) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'OUTREACH_CAMPAIGN_RESCUE_INVALID';
  end if;
  perform outreach.begin_privileged_run('support');
  select row.id, row.facility_id, organisation.organization_id into campaign
    from outreach.campaigns row
    join identity.outreach_organisations organisation on organisation.facility_id = row.facility_id
   where row.id = target_campaign_id
   for update of row;
  if campaign.id is null then
    raise exception using errcode = 'P0002', message = 'OUTREACH_CAMPAIGN_NOT_FOUND';
  end if;
  select row.* into membership from identity.staff_facility_memberships row
   where row.id = target_membership_id and row.facility_id = campaign.facility_id and row.active
     and row.migration_hold_reason is null
     and exists (select 1 from auth.account_roles assignment
                  where assignment.membership_id = row.id and assignment.revoked_at is null
                    and assignment.role_code in ('outreach_organiser', 'outreach_volunteer'));
  if membership.id is null then
    raise exception using errcode = '23514', message = 'OUTREACH_CAMPAIGN_ADMIN_NOT_ELIGIBLE';
  end if;
  select member.role into existing_role from outreach.campaign_members member
   where member.campaign_id = campaign.id and member.membership_id = membership.id;
  if existing_role = 'admin' then
    perform outreach.end_privileged_run();
    return 'already_admin';
  end if;
  if existing_role is not null then
    delete from outreach.campaign_members member
     where member.campaign_id = campaign.id and member.membership_id = membership.id;
  end if;
  -- The appointee is recorded as having added themself (the support account
  -- has no membership at the group); the audit row names support.
  insert into outreach.campaign_members (campaign_id, facility_id, membership_id, role, added_by_account_id,
    added_by_membership_id)
  values (campaign.id, campaign.facility_id, membership.id, 'admin', membership.account_id, membership.id);
  perform outreach.end_privileged_run();
  perform identity.outreach_support_audit(actor_account, campaign.organization_id, campaign.facility_id,
    'admin.outreach-campaign.appoint-admin', 'outreach-campaign', campaign.id::text,
    btrim(requested_reason), jsonb_build_object('membershipId', membership.id, 'previousRole', existing_role));
  return 'appointed';
end
$$;

-- G (policy). A campaign's own members may lock it FOR SHARE when they
-- register a person into it (0110's trigger), which PostgreSQL checks against
-- the UPDATE policies. 0038's policy asks for outreach.campaign.write, which
-- outreach_volunteer does not hold (a helper must not create campaigns). This
-- policy lets a member of the campaign who may register pass; an actual
-- UPDATE still needs an admin of the campaign (validate_campaign_write, 0122).
create policy outreach_campaigns_member_lock on outreach.campaigns for update
  using (outreach.context_allows(facility_id, 'outreach.registration.write')
    and outreach.registration_campaign_member(id, facility_id))
  with check (outreach.context_allows(facility_id, 'outreach.registration.write')
    and outreach.registration_campaign_member(id, facility_id));

-- J (policies and trigger). Support runs on the campaign tables.
create policy outreach_campaigns_support_read on outreach.campaigns for select
  using (outreach.privileged_run_active('support'));
create policy outreach_campaigns_support_update on outreach.campaigns for update
  using (outreach.privileged_run_active('support')) with check (outreach.privileged_run_active('support'));
create policy outreach_campaign_members_support_read on outreach.campaign_members for select
  using (outreach.privileged_run_active('support'));
create policy outreach_campaign_members_support_create on outreach.campaign_members for insert
  with check (outreach.privileged_run_active('support'));
create policy outreach_campaign_members_support_delete on outreach.campaign_members for delete
  using (outreach.privileged_run_active('support'));
alter policy outreach_campaign_members_admin_create on outreach.campaign_members
  with check (
    outreach.privileged_run_active('support')
    or exists (select 1 from outreach.campaign_members admin_member
             where admin_member.campaign_id = campaign_members.campaign_id
               and admin_member.facility_id = campaign_members.facility_id
               and admin_member.membership_id = platform.current_membership_id()
               and admin_member.role = 'admin')
    or (campaign_members.membership_id = platform.current_membership_id()
        and campaign_members.role = 'admin'
        and exists (select 1 from outreach.campaigns campaign
                     where campaign.id = campaign_members.campaign_id
                       and campaign.facility_id = campaign_members.facility_id
                       and campaign.created_by_membership_id = platform.current_membership_id())
        and not exists (select 1 from outreach.campaign_members existing
                         where existing.campaign_id = campaign_members.campaign_id))
  );
alter policy outreach_campaign_members_admin_delete on outreach.campaign_members
  using (
    outreach.privileged_run_active('support')
    or exists (select 1 from outreach.campaign_members admin_member
             where admin_member.campaign_id = campaign_members.campaign_id
               and admin_member.facility_id = campaign_members.facility_id
               and admin_member.membership_id = platform.current_membership_id()
               and admin_member.role = 'admin')
  );

-- 0122's body, with support's close first: only the status (to 'closed') and
-- the version change; nothing else.
create or replace function outreach.validate_campaign_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
declare
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
begin
  -- 0125: support closes an outreach group's campaign (identity.admin_close_outreach_campaign).
  if tg_op = 'UPDATE' and outreach.privileged_run_active('support') then
    if old.id is distinct from new.id or old.facility_id is distinct from new.facility_id
       or old.created_by_account_id is distinct from new.created_by_account_id
       or old.created_by_membership_id is distinct from new.created_by_membership_id
       or old.created_at is distinct from new.created_at or old.name is distinct from new.name
       or old.services is distinct from new.services or old.starts_at is distinct from new.starts_at
       or old.ends_at is distinct from new.ends_at or new.status is distinct from 'closed'
       or new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode='55000',message='Outreach campaign history cannot be overwritten';
    end if;
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if actor_facility is null or new.facility_id is distinct from actor_facility then
    raise exception using errcode='42501',message='Valid Outreach campaign context is required';
  end if;
  if tg_op = 'INSERT' then
    if actor_account is null
       or actor_membership is null
       or new.created_by_account_id is distinct from actor_account
       or new.created_by_membership_id is distinct from actor_membership then
      raise exception using errcode='42501',message='Valid Outreach campaign creator is required';
    end if;
  else
    if old.id is distinct from new.id or old.facility_id is distinct from new.facility_id
       or old.created_by_account_id is distinct from new.created_by_account_id
       or old.created_by_membership_id is distinct from new.created_by_membership_id
       or old.created_at is distinct from new.created_at
       or new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode='55000',message='Outreach campaign history cannot be overwritten';
    end if;
    -- 0122 (ADR-045 option B): only this campaign's own admins change it.
    if actor_membership is null or not exists (
         select 1 from outreach.campaign_members member
          where member.campaign_id = old.id and member.facility_id = old.facility_id
            and member.membership_id = actor_membership and member.role = 'admin') then
      raise exception using errcode='42501',message='Outreach campaign admin is required';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end $$;

comment on function outreach.validate_campaign_write() is
  '0077''s campaign checks, (0122, ADR-045 option B) on UPDATE the session''s membership must be an admin member of the campaign, and (0125) support''s close of an outreach group''s campaign inside a support run. A row lock fires no trigger, so a registration''s FOR SHARE of the campaign is unaffected.';

-- Ownership: every new function and table belongs to its schema's table owner
-- (a no-op when the applier is that owner, as on every database built by one
-- migration login).
do $$
declare
  outreach_owner name := pg_get_userbyid((select relowner from pg_class where oid = 'outreach.campaigns'::regclass));
  identity_owner name := pg_get_userbyid((select relowner from pg_class where oid = 'auth.account_roles'::regclass));
  item record;
begin
  for item in
    select proc.oid::regprocedure::text as signature, namespace.nspname
      from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
     where (namespace.nspname, proc.proname) in (
       ('outreach', 'privileged_run_active'), ('outreach', 'begin_privileged_run'), ('outreach', 'end_privileged_run'),
       ('outreach', 'organiser_tenant_state'), ('outreach', 'organiser_status'),
       ('outreach', 'enforce_organiser_tenant_rules'), ('outreach', 'validate_registration_consent'),
       ('outreach', 'require_registration_consent'))
       and pg_get_userbyid(proc.proowner) <> outreach_owner
  loop
    execute format('alter function %s owner to %I', item.signature, outreach_owner);
  end loop;
  if pg_get_userbyid((select relowner from pg_class where oid = 'outreach.privileged_runs'::regclass)) <> outreach_owner then
    execute format('alter table outreach.privileged_runs owner to %I', outreach_owner);
    execute format('alter table outreach.registration_consents owner to %I', outreach_owner);
  end if;
  if pg_get_userbyid((select relowner from pg_class where oid = 'identity.outreach_organisations'::regclass)) <> identity_owner then
    execute format('alter table identity.outreach_organisations owner to %I', identity_owner);
    execute format('alter table identity.outreach_organiser_signups owner to %I', identity_owner);
    execute format('alter table identity.outreach_invitations owner to %I', identity_owner);
  end if;
end
$$;

-- Grants (here and in runtime-grants.sql).
revoke all on function
  identity.outreach_organiser_terms_version(), identity.outreach_group_name_allowed(text),
  identity.outreach_text_valid(text,integer,integer), identity.outreach_email_valid(text),
  outreach.privileged_run_active(text), outreach.begin_privileged_run(text), outreach.end_privileged_run(),
  outreach.organiser_tenant_state(uuid), outreach.organiser_status(),
  identity.outreach_signup_context(), identity.outreach_email_registered(text),
  identity.start_outreach_organiser_signup(uuid,char,text,text,text,text,text,char,bytea,text,char,char),
  identity.resend_outreach_organiser_signup_code(uuid,char,char),
  identity.verify_outreach_organiser_email(uuid,char,char),
  identity.activate_outreach_organiser(uuid,char,text,text),
  identity.activate_outreach_organiser_for_account(text,text,text,text,char,bytea,text),
  identity.create_outreach_invitation(uuid,text,text,char), identity.revoke_outreach_invitation(uuid),
  identity.list_outreach_team(), identity.preview_outreach_invitation(uuid,char),
  identity.accept_outreach_invitation_with_password(uuid,char,text),
  identity.accept_outreach_invitation_for_account(uuid,char),
  identity.admin_list_outreach_organisers(text), identity.admin_review_outreach_organiser(uuid,bigint,text,text),
  identity.admin_suspend_outreach_organiser(uuid,bigint,text),
  identity.admin_close_outreach_campaign(uuid,bigint,text),
  identity.admin_appoint_outreach_campaign_admin(uuid,uuid,text)
  from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function
      identity.start_outreach_organiser_signup(uuid,char,text,text,text,text,text,char,bytea,text,char,char),
      identity.resend_outreach_organiser_signup_code(uuid,char,char),
      identity.verify_outreach_organiser_email(uuid,char,char),
      identity.activate_outreach_organiser(uuid,char,text,text),
      identity.activate_outreach_organiser_for_account(text,text,text,text,char,bytea,text),
      identity.create_outreach_invitation(uuid,text,text,char), identity.revoke_outreach_invitation(uuid),
      identity.list_outreach_team(), identity.preview_outreach_invitation(uuid,char),
      identity.accept_outreach_invitation_with_password(uuid,char,text),
      identity.accept_outreach_invitation_for_account(uuid,char),
      identity.admin_list_outreach_organisers(text), identity.admin_review_outreach_organiser(uuid,bigint,text,text),
      identity.admin_suspend_outreach_organiser(uuid,bigint,text),
      identity.admin_close_outreach_campaign(uuid,bigint,text),
      identity.admin_appoint_outreach_campaign_admin(uuid,uuid,text)
      to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_outreach_runtime') then
    grant select, insert on outreach.registration_consents to hid_outreach_runtime;
    -- Policies on the outreach tables call it as the querying role.
    grant execute on function outreach.privileged_run_active(text), outreach.organiser_status() to hid_outreach_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    -- It queries the outreach tables in the schema suite, whose policies call it.
    grant execute on function outreach.privileged_run_active(text) to hid_schema_test_runtime;
  end if;
end
$$;

-- Post-checks.
do $$
declare
  mismatch text;
begin
  if (select count(*) from auth.role_permissions where role_code in ('outreach_organiser', 'outreach_volunteer')) <> 7 then
    mismatch := 'the outreach roles';
  elsif not exists (select 1 from pg_trigger where tgrelid = 'auth.account_roles'::regclass
                     and tgname = 'account_roles_outreach_fence' and tgenabled = 'O') then
    mismatch := 'the fence trigger';
  elsif (select count(*) from pg_trigger where tgname = 'outreach_organiser_tenant_rules' and tgenabled = 'O') <> 4 then
    mismatch := 'the outreach group rules triggers';
  elsif (select prosrc from pg_proc where oid = 'outreach.validate_campaign_write()'::regprocedure)
        not like '%Outreach campaign admin is required%' then
    mismatch := 'the campaign trigger';
  elsif exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.pronamespace in ('identity'::regnamespace, 'outreach'::regnamespace)
                   and proc.prosecdef and acl.grantee = 0
                   and (proc.proname like '%outreach_organis%' or proc.proname like '%outreach_invitation%'
                     or proc.proname like '%outreach_campaign%' or proc.proname in ('list_outreach_team',
                       'privileged_run_active', 'organiser_tenant_state', 'organiser_status'))) then
    mismatch := 'a new function is executable by PUBLIC';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0125: not as this file makes it: %s', mismatch);
  end if;
end
$$;
