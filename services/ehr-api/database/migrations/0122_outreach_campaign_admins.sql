-- 0122 Outreach campaigns are managed by their own admins (ADR-045 option B).
-- Written on staging-novu-ci-20261005 at c9b59eff (migrations 0001-0108
-- applied). Its number is the next free one when it merges (open PRs hold
-- 0109-0111 and 0113-0121), so it may be renumbered then.
--
-- Decision (relayed by the user in chat, 2026-11-11, answering which rule
-- campaign management should follow): "Campaign admins only". Any staff member
-- allowed to write campaigns (outreach.campaign.write) may create one and
-- becomes its admin (outreach-api's createCampaign seeds the creator as an
-- `admin` member, unchanged). Only that campaign's own admins can open or close
-- it and add members; anyone else is refused, here and in outreach-api. Until
-- now Identity refused outreach.campaign.write altogether (ADR-045), because
-- any holder of it could add themselves to any campaign as admin, read the
-- campaign's linked registrations (0045) and close or open any campaign. The
-- declaration in config/production-schema-compatibility.json is signed
-- separately: its reviewed_by stays empty until the owner signs it there.
--
-- WHAT IT DOES
-- 1. outreach.validate_campaign_write() (0077's body, BEFORE INSERT OR UPDATE
--    on outreach.campaigns) keeps every check it had and, on UPDATE, also
--    requires the session's membership to be an `admin` member of that
--    campaign: else 42501 "Outreach campaign admin is required". A row lock
--    fires no trigger, so a member registering a person into the campaign
--    (0045's FOR SHARE of the campaign) is unaffected.
-- 2. Two RESTRICTIVE policies on outreach.campaign_members:
--    - insert: the session's membership is an `admin` member of that campaign,
--      or the row is the campaign's creator seeding themself as its first
--      `admin` (the campaign's created_by_membership_id, no member yet);
--    - delete: the session's membership is an `admin` member of that campaign
--      (no API command deletes a member; this keeps 0038's delete policy from
--      letting any writer remove one).
--    0038's permissive policies stay, so outreach.campaign.write at the
--    facility and added_by = the session are still required too.
-- 3. outreach.campaign_staff(uuid): for a campaign at the session facility, to
--    a holder of outreach.campaign.read who is a member of it, the campaign's
--    members with their names and campaign roles; to its admins, also every
--    active staff membership at the facility that could be added (campaign
--    role null). Anyone else gets no row. Names are identity.staff.full_name;
--    nothing else about a person. At most 1000 rows. SECURITY DEFINER, owned
--    by outreach.campaigns' owner; only hid_outreach_runtime may execute it.
--
-- No table, column, constraint, index, role or other function changes; no row
-- is read or written by this file. BACKWARD COMPATIBLE: today's outreach-api
-- reaches no campaign write (Identity refuses outreach.campaign.write), and the
-- campaign reads and registrations are unchanged.
--
-- PRECONDITIONS (catalog reads only; 55000 or 42501, nothing applied):
-- 0001-0108 applied (0108's records-processing cover body md5
-- 6928763d3b69f0e4b4acf96a6a255736 is the marker); not applied yet (else
-- "0122: already applied"); validate_campaign_write's body is 0077's (md5
-- 1ac1e424e645378ab6e88a45542fccf9), SECURITY DEFINER with its search_path;
-- outreach.campaigns and outreach.campaign_members force row-level security
-- and carry 0038's policies; identity.staff and
-- identity.staff_facility_memberships do not force it (the function reads
-- names as its owner); the applier may SET ROLE to the owner, which has
-- CREATE on schema outreach.

do $$
declare
  table_owner oid;
begin
  -- a. Prerequisites (0001-0108; 0108's cover body is the marker).
  if to_regclass('outreach.campaigns') is null
     or to_regclass('outreach.campaign_members') is null
     or to_regclass('identity.staff') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regprocedure('outreach.validate_campaign_write()') is null
     or to_regprocedure('outreach.context_allows(uuid,text)') is null
     or to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'))
        is distinct from '6928763d3b69f0e4b4acf96a6a255736' then
    raise exception using errcode = '55000', message = '0122: 0001-0108 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regprocedure('outreach.campaign_staff(uuid)') is not null then
    raise exception using errcode = '55000', message = '0122: already applied';
  end if;
  -- c. The trigger function replaced here, as 0077 left it.
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'outreach.validate_campaign_write()'::regprocedure
                    and md5(proc.prosrc) = '1ac1e424e645378ab6e88a45542fccf9'
                    and proc.prosecdef
                    and proc.proconfig = '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]) then
    raise exception using errcode = '55000', message = '0122: outreach.validate_campaign_write() is not as 0077 left it';
  end if;
  if not exists (select 1 from pg_trigger trigger_row
                  where trigger_row.tgrelid = 'outreach.campaigns'::regclass
                    and trigger_row.tgname = 'outreach_campaign_validate'
                    and trigger_row.tgfoid = 'outreach.validate_campaign_write()'::regprocedure
                    and not trigger_row.tgisinternal) then
    raise exception using errcode = '55000', message = '0122: the campaign trigger is missing';
  end if;
  -- d. Row-level security and 0038's policies.
  if (select count(*) from pg_class relation
       where relation.oid in ('outreach.campaigns'::regclass, 'outreach.campaign_members'::regclass)
         and relation.relrowsecurity and relation.relforcerowsecurity) <> 2
     or (select count(*) from pg_policy policy_row
          where (policy_row.polrelid, policy_row.polname) in (
                  ('outreach.campaigns'::regclass, 'outreach_campaigns_update'),
                  ('outreach.campaign_members'::regclass, 'outreach_campaign_members_read'),
                  ('outreach.campaign_members'::regclass, 'outreach_campaign_members_create'),
                  ('outreach.campaign_members'::regclass, 'outreach_campaign_members_delete'))
            and policy_row.polpermissive) <> 4
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid = 'outreach.campaign_members'::regclass
                   and policy_row.polname in ('outreach_campaign_members_admin_create', 'outreach_campaign_members_admin_delete')) then
    raise exception using errcode = '55000', message = '0122: the campaign tables are not as 0038 left them';
  end if;
  if exists (select 1 from pg_class relation
              where relation.oid in ('identity.staff'::regclass, 'identity.staff_facility_memberships'::regclass)
                and relation.relforcerowsecurity) then
    raise exception using errcode = '55000', message = '0122: identity staff tables force row-level security';
  end if;
  -- e. Who will own the function.
  table_owner := (select relation.relowner from pg_class relation where relation.oid = 'outreach.campaigns'::regclass);
  if not pg_has_role(current_user, table_owner, 'SET')
     or not has_schema_privilege(table_owner, 'outreach', 'CREATE')
     or (select proc.proowner from pg_proc proc where proc.oid = 'outreach.validate_campaign_write()'::regprocedure) <> table_owner then
    raise exception using errcode = '42501', message = format(
      '0122: the applier (%s) must be able to SET ROLE to outreach.campaigns'' owner (%s), which owns the trigger function and needs CREATE on schema outreach',
      current_user, pg_get_userbyid(table_owner));
  end if;
end
$$;

-- 1. Only a campaign's own admins change it (open, close).
create or replace function outreach.validate_campaign_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
declare
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
begin
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
  '0077''s campaign checks, and (0122, ADR-045 option B) on UPDATE the session''s membership must be an admin member of the campaign. A row lock fires no trigger, so a registration''s FOR SHARE of the campaign is unaffected.';

-- 2. Only a campaign's own admins add (or remove) its members; its creator seeds
-- themself as its first admin.
create policy outreach_campaign_members_admin_create on outreach.campaign_members
  as restrictive for insert
  with check (
    exists (select 1 from outreach.campaign_members admin_member
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
create policy outreach_campaign_members_admin_delete on outreach.campaign_members
  as restrictive for delete
  using (
    exists (select 1 from outreach.campaign_members admin_member
             where admin_member.campaign_id = campaign_members.campaign_id
               and admin_member.facility_id = campaign_members.facility_id
               and admin_member.membership_id = platform.current_membership_id()
               and admin_member.role = 'admin')
  );

-- 3. Who is in a campaign, by name, and (to its admins) who could be added.
create function outreach.campaign_staff(requested_campaign_id uuid)
returns table (membership_id uuid, display_name text, campaign_role text)
language plpgsql stable security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
#variable_conflict use_column
declare
  campaign_facility uuid;
  caller_role text;
begin
  select campaign.facility_id into campaign_facility
    from outreach.campaigns campaign
   where campaign.id = requested_campaign_id
     and campaign.facility_id = platform.current_facility_id();
  if campaign_facility is null or not outreach.context_allows(campaign_facility, 'outreach.campaign.read') then
    return;
  end if;
  select member.role into caller_role
    from outreach.campaign_members member
   where member.campaign_id = requested_campaign_id
     and member.facility_id = campaign_facility
     and member.membership_id = platform.current_membership_id();
  if caller_role is null then
    return;
  end if;
  return query
    select membership.id, staff.full_name, member.role
      from identity.staff_facility_memberships membership
      join identity.staff staff on staff.id = membership.staff_id and staff.account_id = membership.account_id
      left join outreach.campaign_members member
        on member.campaign_id = requested_campaign_id
       and member.facility_id = campaign_facility
       and member.membership_id = membership.id
     where membership.facility_id = campaign_facility
       and (member.id is not null
            or (caller_role = 'admin' and membership.active and staff.active
                and membership.migration_hold_reason is null))
     order by member.id is null, lower(staff.full_name), membership.id
     limit 1000;
end
$$;

comment on function outreach.campaign_staff(uuid) is
  '0122: a campaign''s members (membership, staff full_name, campaign role) to a member of it holding outreach.campaign.read at the session facility; to its admins also every active staff membership at the facility that could be added (campaign role null). Anyone else gets no row. At most 1000 rows.';

-- The campaigns' owner owns the new function (a no-op when the applier is that
-- owner, as on every database built by one migration login).
do $$
declare
  table_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'outreach.campaigns'::regclass);
begin
  if (select proc.proowner from pg_proc proc where proc.oid = 'outreach.campaign_staff(uuid)'::regprocedure) <> table_owner then
    execute format('alter function outreach.campaign_staff(uuid) owner to %I', pg_get_userbyid(table_owner));
  end if;
end
$$;

-- Grants (here and in runtime-grants.sql).
revoke all on function outreach.campaign_staff(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_outreach_runtime') then
    grant execute on function outreach.campaign_staff(uuid) to hid_outreach_runtime;
  end if;
end
$$;

-- 4. Post-checks.
do $$
declare
  mismatch text;
  table_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'outreach.campaigns'::regclass);
begin
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'outreach.validate_campaign_write()'::regprocedure
                    and proc.prosrc like '%Outreach campaign admin is required%'
                    and proc.prosecdef and proc.proowner = table_owner
                    and proc.proconfig = '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]) then
    mismatch := 'the trigger function';
  elsif (select count(*) from pg_policy policy_row
          where policy_row.polrelid = 'outreach.campaign_members'::regclass
            and not policy_row.polpermissive
            and ((policy_row.polname = 'outreach_campaign_members_admin_create' and policy_row.polcmd = 'a')
              or (policy_row.polname = 'outreach_campaign_members_admin_delete' and policy_row.polcmd = 'd'))) <> 2 then
    mismatch := 'the restrictive member policies';
  elsif not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                     where proc.oid = 'outreach.campaign_staff(uuid)'::regprocedure
                       and proc.proowner = table_owner and language_row.lanname = 'plpgsql'
                       and proc.prosecdef and proc.provolatile = 's' and proc.proretset
                       and proc.proconfig = '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]
                       and pg_get_function_result(proc.oid) = 'TABLE(membership_id uuid, display_name text, campaign_role text)') then
    mismatch := 'campaign_staff''s owner, attributes or result';
  else
    select string_agg(granted.what, '; ') into mismatch
      from (
        select case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
               || ' ' || acl.privilege_type || ' on campaign_staff' as what
          from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
         where proc.oid = 'outreach.campaign_staff(uuid)'::regprocedure
           and acl.grantee <> proc.proowner
           and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_outreach_runtime' or acl.privilege_type <> 'EXECUTE')
        union all
        select 'missing hid_outreach_runtime EXECUTE on campaign_staff'
          from pg_roles role_row
         where role_row.rolname = 'hid_outreach_runtime'
           and not exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
                            where proc.oid = 'outreach.campaign_staff(uuid)'::regprocedure
                              and acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0122: not as this file makes it: %s', mismatch);
  end if;
end
$$;
