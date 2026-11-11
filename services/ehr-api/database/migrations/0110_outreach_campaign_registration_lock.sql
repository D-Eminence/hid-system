-- 0110 Outreach: a staff member can register a person into a campaign again
-- (coordinator, 2026-11-04: "0120 first (prove it, then fix)"; first numbered
-- 0120, renumbered 0110 on 2026-11-11 because the release contract needs a
-- contiguous list: production ends at 0108 and 0109 (support Health ID
-- matches, #213) releases first; signed by the owner, see the declaration).
-- Written on 0105 (f11c9ec9). It applies after 0109 and uses nothing 0106-0109
-- add: none of them changes an object this migration reads, pins or replaces.
--
-- The gap: every registration into a campaign is refused in production. The
-- campaign trigger outreach.validate_registration_campaign_write (0045) reads
-- the campaign and the registering staff member's campaign membership and
-- locks both rows (SELECT ... FOR SHARE OF campaign, member). The function is
-- SECURITY DEFINER, so it runs as its owner, the migration login, which in
-- production is neither a superuser nor BYPASSRLS. outreach.campaign_members
-- forces row-level security (0038) and has SELECT, INSERT and DELETE
-- policies but no UPDATE policy, and a locking read must also pass the
-- table's UPDATE policies. So the lock found no row and the trigger raised
-- 42501 "Exact Outreach campaign membership is required" for a member of an
-- active campaign, which outreach-api answered as 500. Measured on a
-- throwaway PostgreSQL 16.15 database built by the runner (MIGRATION_TARGET=
-- rds) as such an owner: the member row read plainly 1, FOR SHARE 0; the
-- trigger's query locking the campaign only 1, locking campaign and member 0.
-- Resolving a campaign-linked registration was blocked the same way: the
-- trigger also runs on UPDATE, so linkExisting's resolve UPDATE raised the
-- same 42501 for a member. A registration without a campaign was never
-- affected. CI and the acceptance runner apply migrations as a superuser, so
-- their suites passed.
-- 0102 (D11) reported it and changed nothing.
--
-- The change (body only; signature, language, volatility, SECURITY DEFINER,
-- search_path, owner, ACL and the trigger unchanged): the trigger locks the
-- campaign row only (FOR SHARE OF campaign) and reads the membership in the
-- same query without locking it. Every check and message is 0045's:
-- 55000 "Outreach registration campaign association cannot be overwritten",
-- 42501 "Exact Outreach campaign membership is required" (no such campaign
-- at that facility, or the session's membership is not a member of it, or
-- the session may not read or lock it), and 23514 "Outreach campaign is not
-- accepting registrations" on insert. The campaign lock still serializes a
-- registration with a campaign status change (updateCampaignStatus locks the
-- campaign FOR UPDATE). Not locking the membership: no API command changes or
-- deletes a membership (campaign_members is append-only by its
-- outreach_campaign_members_no_update trigger, and only DELETE could remove
-- one); outreach-api's create() runs SERIALIZABLE, and its own check already
-- reads the membership without a lock (outreach.service.ts). A membership
-- removed while a registration is being written is no longer waited for: the
-- registration, checked against the membership it read, orders before the
-- removal. Nothing
-- is granted to anyone, and no policy, row-level security or FORCE setting
-- changes: the runtime still cannot update or lock outreach.campaign_members
-- (no UPDATE privilege, no UPDATE policy).
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0109 applied (0109's
--    identity.support_health_id_matches(text[]), body md5
--    e4f1577e17334abde24784ff9c5c6c66, the marker); not
--    applied yet (else "0110: already applied"); the body replaced is exactly
--    0045's (md5 of pg_proc.prosrc afabd66c378c6e076062f35e80de9cb2, the pin
--    0102 also checked) and the helpers relied on are as 0001-0109 left them
--    (platform.current_membership_id, outreach.context_allows,
--    platform.reject_mutation); the function's attributes; the trigger that
--    calls it; the columns read have their types and NOT NULLs; the policies
--    of outreach.campaigns and outreach.campaign_members (no UPDATE policy on
--    the members) and their row-level security; the applier is the
--    function's owner or a member that inherits it and may SET ROLE to it.
-- 1. The body (CREATE OR REPLACE keeps owner, ACL and the trigger). Here and
--    in runtime-grants.sql (0110 block): revoke from PUBLIC, as 0045 did; no
--    grant changes.
-- 2. Post-checks: the body is this file's (md5
--    69469315f04554d2639dfa9f83591d4d), attributes, owner and ACL as before,
--    the trigger kept, and still no UPDATE policy on the members.
--
-- Locks (measured with pg_locks before commit on a 0105 copy): SHARE UPDATE
-- EXCLUSIVE on the function (its comment), ROW EXCLUSIVE on pg_description,
-- ACCESS SHARE on the catalogs read, the schema and language read locks, and
-- the session's own temporary table and schema (the ACL snapshot); no lock on
-- any application table. Behind any held conflicting lock the runner stops
-- after its 5 s lock_timeout and applies nothing. A registration already
-- running finishes with the old body; one that starts after commit runs the
-- new one.
--
-- Old services on this schema: today's outreach-api image sends the same
-- statements and now gets the row instead of the refusal. The image of this
-- release also answers a refusal that still comes from this trigger, after
-- its own check passed, as that check does (403 OUTREACH_CAMPAIGN_ACCESS_DENIED,
-- 409 OUTREACH_CAMPAIGN_NOT_ACCEPTING_REGISTRATIONS); today's image answers it
-- 500. Applied migrations 0001 through 0109 are immutable.

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  function_owner oid;
begin
  -- a. Prerequisites: 0001-0109 (0109's support Health ID check is the marker).
  if to_regclass('outreach.campaign_members') is null
     or to_regprocedure('outreach.validate_registration_campaign_write()') is null
     or to_regprocedure('identity.support_health_id_matches(text[])') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('identity.support_health_id_matches(text[])'))
        is distinct from 'e4f1577e17334abde24784ff9c5c6c66' then
    raise exception using errcode = '55000', message = '0110: 0001-0109 must be applied first';
  end if;
  -- b. Not applied yet.
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = 'outreach.validate_registration_campaign_write()'::regprocedure)
     = '69469315f04554d2639dfa9f83591d4d' then
    raise exception using errcode = '55000', message = '0110: already applied';
  end if;
  -- c. The body replaced and the helpers relied on, as 0001-0109 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('outreach.validate_registration_campaign_write()', 'afabd66c378c6e076062f35e80de9cb2'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('outreach.context_allows(uuid,text)', '1e0e660ba5fd9288f1c1aeca5a7137ac'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- The function's attributes: a plpgsql SECURITY DEFINER trigger function,
  -- VOLATILE, not STRICT, with 0045's search_path.
  if mismatch is null and not exists (
       select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid = 'outreach.validate_registration_campaign_write()'::regprocedure
          and language_row.lanname = 'plpgsql' and proc.prosecdef and not proc.proisstrict
          and proc.provolatile = 'v' and proc.prorettype = 'trigger'::regtype
          and proc.proconfig = '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]) then
    mismatch := 'attributes of outreach.validate_registration_campaign_write()';
  end if;
  -- The trigger that calls it, exactly as 0045 made it, and enabled.
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'outreach.registration_cases'::regclass
             and trigger_row.tgname = 'outreach_registration_campaign_validate' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER outreach_registration_campaign_validate BEFORE INSERT OR UPDATE ON '
               || 'outreach.registration_cases FOR EACH ROW EXECUTE FUNCTION '
               || 'outreach.validate_registration_campaign_write()') <> 1 then
    mismatch := 'the trigger outreach_registration_campaign_validate';
  end if;
  -- The members stay append-only (0038's trigger).
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'outreach.campaign_members'::regclass
             and trigger_row.tgname = 'outreach_campaign_members_no_update' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER outreach_campaign_members_no_update BEFORE UPDATE ON outreach.campaign_members '
               || 'FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()') <> 1 then
    mismatch := 'the trigger outreach_campaign_members_no_update';
  end if;
  -- The columns read, with their types and NOT NULLs.
  if mismatch is null then
    select string_agg(format('%s.%s', expected.relation, expected.column_name), ', ') into mismatch
      from (values
        ('outreach.campaigns', 'id', 'uuid', true),
        ('outreach.campaigns', 'facility_id', 'uuid', true),
        ('outreach.campaigns', 'status', 'text', true),
        ('outreach.campaigns', 'services', 'text[]', true),
        ('outreach.campaigns', 'starts_at', 'timestamp with time zone', true),
        ('outreach.campaigns', 'ends_at', 'timestamp with time zone', false),
        ('outreach.campaign_members', 'campaign_id', 'uuid', true),
        ('outreach.campaign_members', 'facility_id', 'uuid', true),
        ('outreach.campaign_members', 'membership_id', 'uuid', true),
        ('outreach.registration_cases', 'campaign_id', 'uuid', false),
        ('outreach.registration_cases', 'facility_id', 'uuid', true))
           expected(relation, column_name, type_name, not_null)
     where not exists (select 1 from pg_attribute attribute
                        where attribute.attrelid = to_regclass(expected.relation)
                          and attribute.attname = expected.column_name and not attribute.attisdropped
                          and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name
                          and attribute.attnotnull = expected.not_null);
    if mismatch is not null then mismatch := 'columns ' || mismatch; end if;
  end if;
  -- The policies the read and the lock pass (0038), and no UPDATE policy on
  -- the members: row-level security enabled and forced on all three tables.
  if mismatch is null
     and (select count(*) from pg_policy policy_row
           where policy_row.polrelid in ('outreach.campaigns'::regclass, 'outreach.campaign_members'::regclass)
             and policy_row.polpermissive and policy_row.polroles = '{0}'::oid[]
             and (policy_row.polrelid::regclass::text, policy_row.polname, policy_row.polcmd,
                  md5(coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '')),
                  md5(coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), ''))) in (
               ('outreach.campaigns', 'outreach_campaigns_read', 'r',
                '680a885bf5f25e549d3b68ee11e5e0fe', 'd41d8cd98f00b204e9800998ecf8427e'),
               ('outreach.campaigns', 'outreach_campaigns_update', 'w',
                'a41db96c3f6a513c86f56d23859d8cd7', 'a41db96c3f6a513c86f56d23859d8cd7'),
               ('outreach.campaign_members', 'outreach_campaign_members_read', 'r',
                '680a885bf5f25e549d3b68ee11e5e0fe', 'd41d8cd98f00b204e9800998ecf8427e'))) <> 3 then
    mismatch := 'the policies outreach_campaigns_read, outreach_campaigns_update, outreach_campaign_members_read';
  end if;
  if mismatch is null and exists (
       select 1 from pg_policy policy_row
        where policy_row.polrelid = 'outreach.campaign_members'::regclass and policy_row.polcmd in ('w', '*')) then
    mismatch := 'an UPDATE or ALL policy on outreach.campaign_members';
  end if;
  if mismatch is null
     and (select count(*) from pg_class class_row
           where class_row.oid in ('outreach.campaigns'::regclass, 'outreach.campaign_members'::regclass,
                                   'outreach.registration_cases'::regclass)
             and class_row.relrowsecurity and class_row.relforcerowsecurity) <> 3 then
    mismatch := 'row-level security of outreach.campaigns, campaign_members or registration_cases';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0110: an object this migration relies on differs from 0001-0109: %s', mismatch);
  end if;
  -- d. The applier may replace the function (its owner, or a member that
  -- inherits the owner and may SET ROLE to it; never a superuser's bypass
  -- alone).
  function_owner := (select proc.proowner from pg_proc proc
                      where proc.oid = 'outreach.validate_registration_campaign_write()'::regprocedure);
  if applier <> function_owner
     and not (pg_has_role(applier, function_owner, 'USAGE') and pg_has_role(applier, function_owner, 'SET')) then
    raise exception using errcode = '42501',
      message = format('0110: %s is not %s and may not act as it (INHERIT and SET)', current_user,
        pg_get_userbyid(function_owner));
  end if;
  raise notice '0110: owner checked: outreach.validate_registration_campaign_write()=%, applier=%',
    pg_get_userbyid(function_owner), current_user;
end;
$$;

-- The owner and ACL before, for the post-check.
create temporary table outreach_campaign_registration_0110_acl on commit drop as
  select proc.oid as function_oid, proc.proowner, proc.proacl
    from pg_proc proc
   where proc.oid = 'outreach.validate_registration_campaign_write()'::regprocedure;

-- 1. The body: 0045's, locking the campaign row only.
create or replace function outreach.validate_registration_campaign_write()
returns trigger
language plpgsql security definer
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

comment on function outreach.validate_registration_campaign_write() is
  'Campaign-linked registration capture: exact campaign membership, and on insert an active registration campaign. Locks the campaign row only (0110).';

-- Here and in runtime-grants.sql: granted to no role; a trigger needs no
-- EXECUTE to fire.
revoke all on function outreach.validate_registration_campaign_write() from public;

-- 2. Post-checks.
do $$
declare
  mismatch text;
begin
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = 'outreach.validate_registration_campaign_write()'::regprocedure)
     is distinct from '69469315f04554d2639dfa9f83591d4d' then
    mismatch := 'the body of outreach.validate_registration_campaign_write()';
  end if;
  if mismatch is null and exists (
       select 1 from outreach_campaign_registration_0110_acl before_row
         left join pg_proc proc on proc.oid = before_row.function_oid
         left join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid is null or proc.proowner <> before_row.proowner
           or proc.proacl::text is distinct from before_row.proacl::text
           or language_row.lanname is distinct from 'plpgsql'
           or not proc.prosecdef or proc.proisstrict or proc.provolatile <> 'v'
           or proc.proconfig is distinct from '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]) then
    mismatch := 'the owner, ACL or attributes of outreach.validate_registration_campaign_write()';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'outreach.registration_cases'::regclass
             and trigger_row.tgname = 'outreach_registration_campaign_validate' and trigger_row.tgenabled = 'O'
             and trigger_row.tgfoid = 'outreach.validate_registration_campaign_write()'::regprocedure) <> 1 then
    mismatch := 'the trigger outreach_registration_campaign_validate';
  end if;
  if mismatch is null and exists (
       select 1 from pg_policy policy_row
        where policy_row.polrelid = 'outreach.campaign_members'::regclass and policy_row.polcmd in ('w', '*')) then
    mismatch := 'an UPDATE or ALL policy on outreach.campaign_members';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0110: post-check failed: %s', mismatch);
  end if;
end;
$$;
