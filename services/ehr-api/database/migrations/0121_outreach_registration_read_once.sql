-- Outreach registration reads: each session check once per query (owner,
-- 2026-11-13, Q74: "the registration speed fix ... ships with 0120"). The
-- number 0121 is a placeholder; it releases right after 0120.
--
-- WHY
--   The two read policies on outreach.registration_cases called
--   outreach.context_allows(facility_id, ...) and
--   outreach.registration_campaign_member(campaign_id, facility_id) once per
--   ROW, though for one request both answer the same for every row: about
--   2-4 ms a row. With 500 registrations at an outreach group the
--   registration list took about 1.9 s and each new registration about
--   1.2 s (its duplicate hint reads the campaign's registrations); 0119's
--   identity.outreach_registration_health_ids_for added about 0.4 s per 100
--   (outreach-day load test, hid-system #249).
--
-- WHAT IT DOES (who can see which row does not change)
--   1. outreach.session_campaign_pairs(): the (campaign, facility) pairs of
--      the session's membership in outreach.campaign_members, read exactly as
--      outreach.registration_campaign_member reads them: SECURITY DEFINER,
--      STABLE, the same owner and search_path, EXECUTE for exactly the roles
--      that may execute outreach.registration_campaign_member. So
--      registration_campaign_member(c, f) is true exactly when c is null or
--      (c, f) is one of these pairs.
--   2. Two read policies on outreach.registration_cases, the same rules with
--      the session-constant parts evaluated once per query:
--      - outreach_registration_cases_read (permissive): facility_id is the
--        session facility and context_allows(session facility,
--        'outreach.registration.read') - which is context_allows(facility_id,
--        ...) on every row it admits;
--      - outreach_registration_campaign_read (restrictive): campaign_id is
--        null, or (campaign_id, facility_id) is one of the session's pairs, or
--        a retention run is active.
--      Nothing else on the table changes (the write, retention and create
--      policies keep their per-row form).
--   3. identity.outreach_registration_health_ids_for(uuid[]) (0120's), the
--      same rules with the same once-per-query forms.
--   outreach-api's registration list stops repeating the campaign-member
--   check in its own WHERE (the restrictive policy above already applies it).
--
-- PRECONDITIONS (catalog reads only; 55000, nothing applied): 0120 applied;
-- the two policies exactly as 0045 and 0116 left them; the bodies of
-- outreach.registration_campaign_member (0045) and
-- identity.outreach_registration_health_ids_for (0120) by md5; not applied
-- yet.
--
-- LOCKS: ALTER POLICY takes ACCESS EXCLUSIVE on outreach.registration_cases,
-- NOWAIT every 10 ms for at most 5 seconds (then 55P03, nothing applied), to
-- commit. No row is read or written.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if not exists (select 1 from pg_attribute where attrelid = 'identity.outreach_registration_health_ids'::regclass
                  and attname = 'created_via' and not attisdropped) then
    raise exception using errcode = '55000', message = '0121: 0120 must be applied first';
  end if;
  if to_regprocedure('outreach.session_campaign_pairs()') is not null then
    raise exception using errcode = '55000', message = '0121: already applied';
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('outreach.registration_campaign_member(uuid,uuid)', '001d3745e8710e8b9210cc37cba24b4a'),
      ('identity.outreach_registration_health_ids_for(uuid[])', '59e950ad828d0ca2e37f61c3f30799cd')) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0121: these bodies are not as expected: ' || mismatch;
  end if;
  if not exists (select 1 from pg_proc where oid = 'outreach.registration_campaign_member(uuid,uuid)'::regprocedure
                  and prosecdef and provolatile = 's'
                  and proconfig = array['search_path=pg_catalog, platform, auth, identity, outreach']) then
    raise exception using errcode = '55000', message = '0121: outreach.registration_campaign_member is not as 0045 made it';
  end if;
  if (select array_agg(policy_row.polname::text || ':' || policy_row.polcmd::text || ':' || policy_row.polpermissive::text
                       || ':' || policy_row.polroles::text || ':' || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '')
                       || ':' || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '')
                       order by policy_row.polname)
        from pg_policy policy_row
       where policy_row.polrelid = 'outreach.registration_cases'::regclass
         and policy_row.polname in ('outreach_registration_cases_read', 'outreach_registration_campaign_read'))
     is distinct from array[
       'outreach_registration_campaign_read:r:false:{0}:(outreach.registration_campaign_member(campaign_id, facility_id) OR outreach.privileged_run_active(''retention''::text)):',
       'outreach_registration_cases_read:r:true:{0}:outreach.context_allows(facility_id, ''outreach.registration.read''::text):'] then
    raise exception using errcode = '55000', message = '0121: the two registration read policies are not as 0045 and 0116 left them';
  end if;
end
$$;

-- 1. The session's campaign memberships, read as registration_campaign_member reads them.
create function outreach.session_campaign_pairs()
returns table (campaign_id uuid, facility_id uuid)
language sql stable security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
  select member.campaign_id, member.facility_id
    from outreach.campaign_members member
   where member.membership_id = platform.current_membership_id()
$$;

comment on function outreach.session_campaign_pairs() is
  '0121: the (campaign, facility) pairs of the session membership in outreach.campaign_members, read as outreach.registration_campaign_member reads them (SECURITY DEFINER, its owner and search_path): registration_campaign_member(c, f) is c is null or (c, f) among these. For policies and functions that check campaign membership once per query.';

revoke all on function outreach.session_campaign_pairs() from public;

-- Its owner and EXECUTE exactly as registration_campaign_member's.
do $$
declare
  member_function regprocedure := 'outreach.registration_campaign_member(uuid,uuid)'::regprocedure;
  member_owner name := (select pg_get_userbyid(proowner) from pg_proc where oid = 'outreach.registration_campaign_member(uuid,uuid)'::regprocedure);
  grantee_name name;
begin
  if member_owner <> current_user then
    execute format('alter function outreach.session_campaign_pairs() owner to %I', member_owner);
  end if;
  for grantee_name in
    select distinct pg_get_userbyid(privilege.grantee)
      from pg_proc proc cross join aclexplode(proc.proacl) privilege
     where proc.oid = member_function and privilege.privilege_type = 'EXECUTE'
       and privilege.grantee <> 0 and privilege.grantee <> proc.proowner
  loop
    execute format('grant execute on function outreach.session_campaign_pairs() to %I', grantee_name);
  end loop;
end
$$;

-- 2. The two read policies (ACCESS EXCLUSIVE, bounded).
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table outreach.registration_cases in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0121: outreach.registration_cases stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

alter policy outreach_registration_cases_read on outreach.registration_cases
  using (facility_id = (select platform.current_facility_id())
         and (select outreach.context_allows(platform.current_facility_id(), 'outreach.registration.read')));

alter policy outreach_registration_campaign_read on outreach.registration_cases
  using (campaign_id is null
         or (campaign_id, facility_id) in (select pair.campaign_id, pair.facility_id
                                             from outreach.session_campaign_pairs() pair)
         or (select outreach.privileged_run_active('retention')));

-- 3. 0120's Health ID lookup for the Outreach runtime, the same rules once per query.
create or replace function identity.outreach_registration_health_ids_for(requested_case_ids uuid[])
returns table (registration_case_id uuid, hid_code text, created_via text)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select link.registration_case_id, link.hid_code, link.created_via
    from identity.outreach_registration_health_ids link
   where link.registration_case_id = any(requested_case_ids)
     and cardinality(requested_case_ids) <= 500
     and link.facility_id = (select platform.current_facility_id())
     and (select outreach.context_allows(platform.current_facility_id(), 'outreach.registration.read'))
     and not exists (select 1 from outreach.registration_redactions redaction
                      where redaction.registration_case_id = link.registration_case_id)
     and exists (select 1 from outreach.registration_cases case_row where case_row.id = link.registration_case_id
                  and case_row.facility_id = link.facility_id
                  and (case_row.campaign_id is null
                       or (case_row.campaign_id, case_row.facility_id) in
                          (select pair.campaign_id, pair.facility_id from outreach.session_campaign_pairs() pair)))
$$;

comment on function identity.outreach_registration_health_ids_for(uuid[]) is
  '0119, 0120, 0121: for the Outreach runtime, the Health IDs created at outreach, how (created_via email or unclaimed), for up to 500 registrations at the session facility that the session can see: the facility, outreach.registration.read for direct care (outreach.context_allows) and campaign membership (outreach.session_campaign_pairs), each checked once per query, and by the registration''s row-level security; never a redacted registration.';

-- 4. Post-checks.
do $$
declare
  member_function regprocedure := 'outreach.registration_campaign_member(uuid,uuid)'::regprocedure;
  pairs_function regprocedure := 'outreach.session_campaign_pairs()'::regprocedure;
begin
  if not exists (select 1 from pg_proc pairs join pg_proc member on member.oid = member_function
                  where pairs.oid = pairs_function and pairs.prosecdef and pairs.provolatile = 's'
                    and pairs.proowner = member.proowner and pairs.proconfig = member.proconfig)
     or (select array_agg(pg_get_userbyid(privilege.grantee) order by 1) from pg_proc proc cross join aclexplode(proc.proacl) privilege
          where proc.oid = pairs_function and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> proc.proowner)
        is distinct from
        (select array_agg(pg_get_userbyid(privilege.grantee) order by 1) from pg_proc proc cross join aclexplode(proc.proacl) privilege
          where proc.oid = member_function and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> proc.proowner) then
    raise exception using errcode = '55000', message = '0121: session_campaign_pairs is not registration_campaign_member''s twin';
  end if;
  if exists (select 1 from pg_policy policy_row
              where policy_row.polrelid = 'outreach.registration_cases'::regclass
                and policy_row.polname in ('outreach_registration_cases_read', 'outreach_registration_campaign_read')
                and pg_get_expr(policy_row.polqual, policy_row.polrelid) like '%registration_campaign_member%')
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'outreach.registration_cases'::regclass
                       and policy_row.polname = 'outreach_registration_cases_read' and policy_row.polcmd = 'r'
                       and policy_row.polpermissive and policy_row.polroles = '{0}'
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid) like '%SELECT platform.current_facility_id()%'
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                           like '%SELECT outreach.context_allows(platform.current_facility_id(), ''outreach.registration.read''::text)%')
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'outreach.registration_cases'::regclass
                       and policy_row.polname = 'outreach_registration_campaign_read' and policy_row.polcmd = 'r'
                       and not policy_row.polpermissive and policy_row.polroles = '{0}'
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid) like '%FROM outreach.session_campaign_pairs()%'
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                           like '%SELECT outreach.privileged_run_active(''retention''::text)%')
     or (select count(*) from pg_policy where polrelid = 'outreach.registration_cases'::regclass) <> 8 then
    raise exception using errcode = '55000', message = '0121: the registration read policies are not as written';
  end if;
  if (select prosrc from pg_proc where oid = 'identity.outreach_registration_health_ids_for(uuid[])'::regprocedure)
       not like '%outreach.session_campaign_pairs()%'
     or exists (select 1 from pg_proc where oid = 'identity.outreach_registration_health_ids_for(uuid[])'::regprocedure
                 and prosrc like '%registration_campaign_member%') then
    raise exception using errcode = '55000', message = '0121: identity.outreach_registration_health_ids_for is not as written';
  end if;
end
$$;
