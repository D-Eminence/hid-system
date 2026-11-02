-- 0103 Platform administrators review organization applications (owner
-- request of 2026-11-01, D-Eminence: "fix the two dashboard errors now"; the
-- admin Overview said "Organization applications: Your account does not have
-- permission" for the platform super admin). main 0067's gate fix, carried
-- onto this branch's 0064 audit model; the declaration is signed separately.
-- Written on 0101 (f9827905). It does not use or need anything 0102 adds, so
-- it applies on 0101 alone or on 0101 + 0102.
--
-- The gap: identity.organization_application_admin_account (0046) requires
-- identity.has_active_membership for the session's facility and membership.
-- The Identity API runs every admin route in a platform transaction
-- (DatabaseService.withPlatformTransaction), which sets app.facility_id and
-- app.membership_id to '' for an administrator with no facility, so
-- has_active_membership(subject, null, null) is false and the list, the
-- application read, the CAC check, approve and reject all failed 42501
-- (403 in the admin console) for the platform super admin. The three writers
-- also audit as actor_type 'staff' with the session's (null) facility, which
-- 0064's audit_actor_facility_ck refuses, so they would still fail once the
-- gate let the administrator in.
--
-- The change (bodies only; signatures, language, volatility, SECURITY
-- DEFINER, search_path, owner and ACL unchanged):
-- 1. identity.organization_application_admin_account(text): a platform-scoped
--    call (no facility and no membership in the request context, and the
--    account holds platform.admin.access) no longer needs a facility
--    membership; it is authorized by auth.account_has_platform_permission(
--    actor, requested_permission) alone. Every other call keeps exactly
--    today's check: a session that names a facility or a membership still
--    needs an active membership of that facility. The account, correlation
--    id and purpose of use rules are unchanged, and the requested permission
--    is still required of everyone. No permission is granted to anyone.
-- 2. identity.admin_record_organization_cac_result,
--    identity.admin_approve_organization_application and
--    identity.admin_reject_organization_application: in a platform-scoped
--    call (no facility and no membership; the gate has then already required
--    platform.admin.access) the audit row is actor_type 'platform', action
--    admin.organization-application.cac-verify / .approve / .reject, with
--    facility, membership and organization null (approve keeps the new
--    organization's id in details.organizationId), which 0064's
--    audit_platform_scope_ck and audit_actor_facility_ck accept and its
--    audit_platform_authority trigger checks again. A facility-scoped call
--    writes exactly today's row (actor_type 'staff', identity.organization.
--    application.* actions, its facility, membership and organization).
-- Callers that need no change: admin_list_organization_applications,
-- admin_get_organization_application and platform.consume_qoreid_quota
-- ('application_cac') call the gate and now let the platform administrator
-- in; their bodies are pinned below and not replaced.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0101 applied (0101's
--    pharmacy.validate_dispensing body the marker); not applied yet; the four
--    bodies replaced are exactly the ones 0046/0048/0056 left (md5 of
--    pg_proc.prosrc), as are the three callers kept and the session, account
--    and permission helpers they read; the four functions' attributes;
--    0064's three audit constraints and its authority trigger; the applier is
--    the functions' owner or a member that inherits it and may SET ROLE to it.
-- 1. The four bodies replaced (CREATE OR REPLACE keeps owner, ACL and
--    dependants). runtime-grants.sql gains a 0103 block (no grant changes).
-- 2. Post-checks: each body is this file's, attributes and ACLs as before,
--    and the callers and audit rules are untouched.
--
-- Locks (measured with pg_locks before commit on a 0101 copy): ACCESS SHARE
-- on schema identity and the language, the pg_proc rows replaced, and the
-- session's own temporary table and schema (the ACL snapshot); no lock on any
-- application table is held to commit. Compiling the new bodies resolves
-- %ROWTYPE of identity.organization_applications and section 0 reads
-- audit.events' constraints, so behind a session holding ACCESS EXCLUSIVE on
-- either (DDL) the runner stops after its 5 s lock_timeout with nothing
-- applied; behind ROW EXCLUSIVE on either (rows being written) it applied at
-- once. A request already running finishes with the old body; one that
-- starts after commit runs the new one.
--
-- Old services on this schema: today's Identity API image sends the same
-- calls in the same transactions, so this needs no service change; the admin
-- console's Applications page then lists, checks, approves and rejects for a
-- platform administrator. Applied migrations 0001 through 0101 are immutable.

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  function_owner oid;
begin
  -- a. Prerequisites: 0001-0101 (0101's body is the marker).
  if to_regprocedure('pharmacy.validate_dispensing()') is null
     or (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure)
        is distinct from '17f7e8897bd2ab240332e4d2c9f757b7'
     or to_regclass('audit.events') is null
     or to_regclass('identity.organization_applications') is null then
    raise exception using errcode = '55000', message = '0103: 0001-0101 must be applied first';
  end if;
  -- b. Not applied yet.
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = to_regprocedure('identity.organization_application_admin_account(text)'))
     = '186eb4ca420749b8bdb324bdc843bc50' then
    raise exception using errcode = '55000', message = '0103: already applied';
  end if;
  -- c. The bodies replaced and relied on, as 0001-0101 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.organization_application_admin_account(text)', '4ce43509b97996cdbb5997dc18c8c400'),
      ('identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text,text)',
       '3b1aca8cd1a4854d465c5b300bc10aca'),
      ('identity.admin_approve_organization_application(uuid,bigint,uuid,uuid,text)', '532e5003f0d2084437c28c3706a95ecd'),
      ('identity.admin_reject_organization_application(uuid,bigint,text)', 'cd34d46405bc32eeef38a2108309991e'),
      ('identity.admin_list_organization_applications(text)', '38b2cddb8540ef801f837f35c49340ec'),
      ('identity.admin_get_organization_application(uuid)', 'a92157ef404478cb2e487508419226e0'),
      ('platform.consume_qoreid_quota(text,uuid,uuid,character,character)', '5e2aee48fb68322660e4938d15e85c58'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('auth.account_has_platform_permission(uuid,text)', '2145c72b864abf1b69d23d96265e5ba7'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- The four functions' attributes (all SECURITY DEFINER plpgsql, not
  -- STRICT; the gate STABLE, the writers VOLATILE; their search_paths).
  if mismatch is null then
    select string_agg(expected.proc, '; ') into mismatch
      from (values
        ('identity.organization_application_admin_account(text)', 's',
         '{"search_path=pg_catalog, identity, auth, platform, pg_temp"}'),
        ('identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text,text)', 'v',
         '{"search_path=pg_catalog, identity, auth, audit, platform, pg_temp"}'),
        ('identity.admin_approve_organization_application(uuid,bigint,uuid,uuid,text)', 'v',
         '{"search_path=pg_catalog, identity, auth, audit, platform, pg_temp"}'),
        ('identity.admin_reject_organization_application(uuid,bigint,text)', 'v',
         '{"search_path=pg_catalog, identity, auth, audit, platform, pg_temp"}'))
           expected(proc, volatility, config)
     where not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                        where proc.oid = to_regprocedure(expected.proc)
                          and language_row.lanname = 'plpgsql' and proc.prosecdef and not proc.proisstrict
                          and proc.provolatile = expected.volatility::"char"
                          and proc.proconfig = expected.config::text[]);
    if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  end if;
  -- 0064's audit rules the platform rows must satisfy.
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid = 'audit.events'::regclass and constraint_row.contype = 'c'
             and constraint_row.convalidated
             and (constraint_row.conname, md5(pg_get_constraintdef(constraint_row.oid))) in (
               ('audit_actor_type_ck', 'd630642d19ec60d7d0cfab2d90533dba'),
               ('audit_actor_facility_ck', 'd74856f4b11b9e7e378d1a586f3a284b'),
               ('audit_platform_scope_ck', 'bc5f610696515dc7475eadde912e0a30'))) <> 3 then
    mismatch := 'the audit.events constraints audit_actor_type_ck, audit_actor_facility_ck, audit_platform_scope_ck';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'audit.events'::regclass
             and trigger_row.tgname = 'audit_platform_authority' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER audit_platform_authority BEFORE INSERT ON audit.events '
               || 'FOR EACH ROW EXECUTE FUNCTION audit.authorize_platform_event()') <> 1 then
    mismatch := 'the trigger audit_platform_authority';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0103: an object this migration relies on differs from 0001-0101: %s', mismatch);
  end if;
  -- d. The applier may replace the four functions (owner, or a member that
  -- inherits the owner and may SET ROLE to it; never a superuser's bypass
  -- alone). One owner for all four.
  select string_agg(distinct pg_get_userbyid(proc.proowner), ', ') into mismatch
    from pg_proc proc
   where proc.oid in ('identity.organization_application_admin_account(text)'::regprocedure,
     'identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text,text)'::regprocedure,
     'identity.admin_approve_organization_application(uuid,bigint,uuid,uuid,text)'::regprocedure,
     'identity.admin_reject_organization_application(uuid,bigint,text)'::regprocedure);
  function_owner := (select proc.proowner from pg_proc proc
                      where proc.oid = 'identity.organization_application_admin_account(text)'::regprocedure);
  if mismatch is distinct from pg_get_userbyid(function_owner) then
    raise exception using errcode = '55000',
      message = format('0103: the four functions must share one owner (found %s)', mismatch);
  end if;
  if applier <> function_owner
     and not (pg_has_role(applier, function_owner, 'USAGE') and pg_has_role(applier, function_owner, 'SET')) then
    raise exception using errcode = '42501',
      message = format('0103: %s is not %s and may not act as it (INHERIT and SET)', current_user,
        pg_get_userbyid(function_owner));
  end if;
  raise notice '0103: owners checked: identity.organization_application_admin_account(text)=%, applier=%',
    pg_get_userbyid(function_owner), current_user;
end;
$$;

-- The ACLs before, for the post-check.
create temporary table organization_applications_0103_acl on commit drop as
  select proc.oid as function_oid, proc.proowner, proc.proacl
    from pg_proc proc
   where proc.oid in ('identity.organization_application_admin_account(text)'::regprocedure,
     'identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text,text)'::regprocedure,
     'identity.admin_approve_organization_application(uuid,bigint,uuid,uuid,text)'::regprocedure,
     'identity.admin_reject_organization_application(uuid,bigint,text)'::regprocedure);

-- 1. The gate. A platform-scoped call (no facility and no membership, and
-- platform.admin.access) is authorized by the requested platform permission
-- alone; every other call keeps 0046's active-membership check.
create or replace function identity.organization_application_admin_account(requested_permission text)
returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or (not (platform.current_facility_id() is null
              and platform.current_membership_id() is null
              and auth.account_has_platform_permission(actor_account, 'platform.admin.access'))
         and not identity.has_active_membership(
           platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id()
         ))
     or not auth.account_has_platform_permission(actor_account, requested_permission) then
    raise exception using errcode = '42501', message = 'Organization onboarding administration is required';
  end if;
  return actor_account;
end;
$$;

-- 2. The CAC check result (0056's body; only the audit row's actor type and
-- action follow the scope).
create or replace function identity.admin_record_organization_cac_result(
  requested_application_id uuid,
  expected_version bigint,
  requested_result text,
  requested_provider_reference text,
  requested_failure_category text,
  requested_verified_registration_number text,
  requested_verified_organization_name text,
  requested_verified_entity_type text,
  requested_verified_registration_date text,
  requested_verified_address text,
  requested_verified_registry_status text
) returns table (application_status text, row_version bigint)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.organization_application_admin_account('platform.facility.manage');
  platform_scoped boolean := platform.current_facility_id() is null and platform.current_membership_id() is null;
  application identity.organization_applications%rowtype;
  provider_date date;
  provider_name text;
  provider_type text;
  provider_address text;
  provider_status text;
  merged_name text;
  merged_type text;
  merged_date date;
  merged_address text;
  merged_status text;
  name_source text;
  type_source text;
  date_source text;
  address_source_value text;
  status_source text;
  completion_state text;
begin
  if requested_result is null
     or requested_result not in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')
     or requested_provider_reference is not null and (
       length(requested_provider_reference) not between 1 and 255
       or requested_provider_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
     )
     or (requested_result = 'verified' and (
       requested_failure_category is not null
       or requested_provider_reference is null
       or requested_provider_reference !~ '^[0-9]+$'
     ))
     or (requested_result = 'not_verified' and requested_failure_category is distinct from 'not_verified')
     or (requested_result = 'incomplete' and requested_failure_category is distinct from 'incomplete')
     or (requested_result = 'disabled' and requested_failure_category is distinct from 'disabled')
     or (requested_result = 'provider_error' and (requested_failure_category is null
       or requested_failure_category not in (
         'provider_authentication', 'provider_unavailable', 'timeout', 'network',
         'malformed_response', 'unexpected_response'
       ))) then
    raise exception using errcode = '22023', message = 'Invalid CAC verification result';
  end if;
  select * into application from identity.organization_applications row
   where row.id = requested_application_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Organization application not found'; end if;
  if application.status not in ('pending_verification', 'ready_for_review') then
    raise exception using errcode = '23514', message = 'Organization application is closed';
  end if;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;

  if requested_result = 'verified' then
    if requested_verified_registration_number is distinct from application.cac_registration_number
       or (requested_verified_organization_name is not null and (
         length(btrim(requested_verified_organization_name)) not between 2 and 200
         or requested_verified_organization_name ~ '[[:cntrl:]]'))
       or (requested_verified_entity_type is not null and (
         length(btrim(requested_verified_entity_type)) not between 2 and 120
         or requested_verified_entity_type ~ '[[:cntrl:]]'))
       or (requested_verified_address is not null and (
         length(btrim(requested_verified_address)) not between 5 and 1000
         or requested_verified_address ~ '[[:cntrl:]]'))
       or (requested_verified_registry_status is not null and (
         length(btrim(requested_verified_registry_status)) not between 1 and 40
         or requested_verified_registry_status ~ '[[:cntrl:]]'))
       or (requested_verified_registration_date is not null
         and requested_verified_registration_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
      raise exception using errcode = '22023', message = 'Invalid provider CAC profile';
    end if;
    if requested_verified_registration_date is not null then
      begin
        provider_date := requested_verified_registration_date::date;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception using errcode = '22023', message = 'Invalid CAC registration date';
      end;
      if provider_date::text <> requested_verified_registration_date
         or provider_date < date '1800-01-01' or provider_date > current_date then
        raise exception using errcode = '22023', message = 'Invalid CAC registration date';
      end if;
    end if;
    provider_name := coalesce(btrim(requested_verified_organization_name),
      case when application.verification_result = 'verified' then application.qoreid_organization_name end);
    provider_type := coalesce(btrim(requested_verified_entity_type),
      case when application.verification_result = 'verified' then application.qoreid_entity_type end);
    provider_date := coalesce(provider_date,
      case when application.verification_result = 'verified' then application.qoreid_registration_date end);
    provider_address := coalesce(btrim(requested_verified_address),
      case when application.verification_result = 'verified' then application.qoreid_address end);
    provider_status := coalesce(requested_verified_registry_status,
      case when application.verification_result = 'verified' then application.qoreid_registry_status end);
    merged_name := coalesce(provider_name,
      case when application.verification_result = 'verified'
        and application.organization_name_source = 'user_provided' then application.verified_organization_name end);
    merged_type := coalesce(provider_type,
      case when application.verification_result = 'verified'
        and application.entity_type_source = 'user_provided' then application.verified_entity_type end);
    merged_date := coalesce(provider_date,
      case when application.verification_result = 'verified'
        and application.registration_date_source = 'user_provided' then application.verified_registration_date end);
    merged_address := coalesce(provider_address,
      case when application.verification_result = 'verified'
        and application.address_source = 'user_provided' then application.verified_address end);
    merged_status := coalesce(provider_status,
      case when application.verification_result = 'verified'
        and application.registry_status_source = 'user_provided' then application.verified_registry_status end);
    name_source := case when provider_name is not null then 'qoreid'
      when merged_name is not null then 'user_provided' end;
    type_source := case when provider_type is not null then 'qoreid'
      when merged_type is not null then 'user_provided' end;
    date_source := case when provider_date is not null then 'qoreid'
      when merged_date is not null then 'user_provided' end;
    address_source_value := case when provider_address is not null then 'qoreid'
      when merged_address is not null then 'user_provided' end;
    status_source := case when provider_status is not null then 'qoreid'
      when merged_status is not null then 'user_provided' end;
    completion_state := case when merged_name is not null and merged_type is not null
      and merged_date is not null and merged_address is not null and merged_status = 'active'
      then 'complete' else 'incomplete' end;
  elsif requested_verified_registration_number is not null
     or requested_verified_organization_name is not null
     or requested_verified_entity_type is not null
     or requested_verified_registration_date is not null
     or requested_verified_address is not null
     or requested_verified_registry_status is not null then
    raise exception using errcode = '22023', message = 'Unverified CAC result cannot carry registry identity';
  end if;

  update identity.organization_applications row
     set status = case when requested_result = 'verified' and completion_state = 'complete'
           then 'ready_for_review' else 'pending_verification' end,
         verification_result = requested_result,
         verification_failure_category = requested_failure_category,
         provider_reference = requested_provider_reference,
         provider_verified_registration_number = case when requested_result = 'verified'
           then requested_verified_registration_number else null end,
         profile_state = completion_state,
         qoreid_organization_name = provider_name,
         qoreid_entity_type = provider_type,
         qoreid_registration_date = provider_date,
         qoreid_address = provider_address,
         qoreid_registry_status = provider_status,
         organization_name = merged_name,
         verified_organization_name = merged_name,
         verified_entity_type = merged_type,
         verified_registration_date = merged_date,
         verified_address = merged_address,
         verified_registry_status = merged_status,
         organization_name_source = name_source,
         entity_type_source = type_source,
         registration_date_source = date_source,
         address_source = address_source_value,
         registry_status_source = status_source,
         verified_at = case when requested_result = 'verified' then clock_timestamp() else null end,
         updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.id = requested_application_id
   returning row.* into application;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), case when platform_scoped then 'platform' else 'staff' end,
    platform.current_actor_subject(), actor_account,
    platform.current_membership_id(), platform.current_facility_id(),
    case when platform_scoped then 'admin.organization-application.cac-verify'
      else 'identity.organization.application.cac-verify' end,
    case when requested_result = 'verified' then 'success'
      when requested_result in ('not_verified', 'incomplete') then 'denied' else 'failure' end,
    'organization-application', application.id::text, 'healthcare-operations',
    'application', 'identity-api', jsonb_build_object(
      'productCode', application.product_code, 'result', requested_result,
      'profileState', application.profile_state, 'failureCategory', requested_failure_category
    )
  );
  return query select application.status, application.row_version;
end;
$$;

-- 3. Approve (0056's body; the audit row's actor type, action and
-- organization follow the scope; a platform row keeps the organization in
-- details.organizationId).
create or replace function identity.admin_approve_organization_application(
  requested_application_id uuid,
  expected_version bigint,
  requested_existing_organization_id uuid,
  requested_existing_facility_id uuid,
  requested_reason text
) returns table (organization_id uuid, facility_id uuid, first_admin_account_id uuid, row_version bigint,
  organization_reused boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.organization_application_admin_account('platform.facility.manage');
  platform_scoped boolean := platform.current_facility_id() is null and platform.current_membership_id() is null;
  application identity.organization_applications%rowtype;
  registration identity.organization_cac_registrations%rowtype;
  new_organization_id uuid;
  new_facility_id uuid;
  new_account_id uuid;
  new_staff_id uuid;
  new_membership_id uuid;
  reused boolean := false;
  product_status text;
begin
  if not auth.account_has_platform_permission(actor_account, 'platform.principal.manage')
     or not auth.account_has_platform_permission(actor_account, 'platform.role.manage') then
    raise exception using errcode = '42501', message = 'Organization administrator provisioning is not authorized';
  end if;
  if length(btrim(coalesce(requested_reason, ''))) < 8
     or (requested_existing_organization_id is null) <> (requested_existing_facility_id is null) then
    raise exception using errcode = '22023', message = 'Invalid organization approval';
  end if;
  select * into application from identity.organization_applications row
   where row.id = requested_application_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Organization application not found'; end if;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  if application.status <> 'ready_for_review' or application.verification_result <> 'verified'
     or application.verified_at is null or application.verified_organization_name is null then
    raise exception using errcode = '23514', message = 'Verified CAC and pending review are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('org-cac:' || application.cac_registration_number, 0));
  select * into registration from identity.organization_cac_registrations row
   where row.cac_registration_number = application.cac_registration_number for update;
  if found then
    new_organization_id := registration.organization_id;
    new_facility_id := registration.primary_facility_id;
    reused := true;
    if requested_existing_organization_id is null
       or requested_existing_organization_id <> new_organization_id
       or requested_existing_facility_id <> new_facility_id then
      raise exception using errcode = '23514', message = 'Existing organization requires explicit review';
    end if;
  elsif requested_existing_organization_id is not null then
    new_organization_id := requested_existing_organization_id;
    new_facility_id := requested_existing_facility_id;
    reused := true;
    if exists (select 1 from identity.organization_cac_registrations row
      where row.organization_id = new_organization_id) then
      raise exception using errcode = '23514', message = 'Organization already has a different CAC binding';
    end if;
  else
    if exists (select 1 from identity.organizations row
      where lower(row.name) = lower(application.verified_organization_name)) then
      raise exception using errcode = '23514', message = 'Existing organization must be reviewed and linked';
    end if;
    new_organization_id := gen_random_uuid();
    new_facility_id := gen_random_uuid();
    insert into identity.organizations (id, name, slug, active, source_system)
      values (new_organization_id, application.verified_organization_name,
        'org-' || replace(new_organization_id::text, '-', ''), true, 'hid');
    insert into identity.facilities (
      id, organization_id, name, code, active, lifecycle_status, timezone, source_system
    ) values (
      new_facility_id, new_organization_id, application.verified_organization_name,
      'ORG-' || replace(new_facility_id::text, '-', ''), true, 'verified', 'Africa/Lagos', 'hid'
    );
  end if;

  -- A registry result for one legal entity must never be attached to a
  -- different legacy organization merely because the same administrator can
  -- access it. A name change needs a separate evidence-backed reconciliation.
  if reused and not exists (
    select 1 from identity.organizations organization
    where organization.id = new_organization_id
      and lower(btrim(organization.name)) = lower(btrim(application.verified_organization_name))
  ) then
    raise exception using errcode = '23514', message = 'Existing organization legal name requires separate review';
  end if;

  if not exists (
    select 1 from identity.organizations organization
    join identity.facilities facility
      on facility.organization_id = organization.id
    where organization.id = new_organization_id and organization.active
      and facility.id = new_facility_id and facility.active
      and facility.lifecycle_status = 'verified'
  ) then
    raise exception using errcode = '23514', message = 'Active verified organization facility is required';
  end if;
  if registration.cac_registration_number is null then
    insert into identity.organization_cac_registrations (
      cac_registration_number, organization_id, primary_facility_id, source_application_id
    ) values (
      application.cac_registration_number, new_organization_id, new_facility_id, application.id
    );
  end if;

  select product.status into product_status from identity.organization_products product
    where product.organization_id = new_organization_id and product.product_code = application.product_code;
  if product_status = 'suspended' then
    raise exception using errcode = '23514', message = 'Suspended product enrollment requires separate review';
  end if;
  if product_status is null then
    insert into identity.organization_products (
      organization_id, product_code, facility_id, source_application_id
    ) values (new_organization_id, application.product_code, new_facility_id, application.id);
  end if;

  if reused then
    -- A CAC lookup proves registry status, not this applicant's authority to
    -- administer an existing HID organization. Reuse requires an already
    -- active organization administrator with the submitted contact email.
    select account.id into new_account_id
      from auth.accounts account
      join identity.staff staff on staff.account_id = account.id
      join identity.staff_facility_memberships membership
        on membership.staff_id = staff.id and membership.account_id = account.id
      join auth.account_roles assignment
        on assignment.account_id = account.id
       and assignment.membership_id = membership.id
       and assignment.facility_id = membership.facility_id
       and assignment.role_code = 'org_admin'
       and assignment.revoked_at is null
     where lower(account.email) = application.administrator_email
       and account.status = 'active' and staff.active and membership.active
       and membership.organization_id = new_organization_id
       and membership.facility_id = new_facility_id
     limit 1;
    if new_account_id is null then
      raise exception using errcode = '23514',
        message = 'Existing organization administrator requires manual resolution';
    end if;
  else
    if exists (select 1 from auth.accounts account
        where lower(account.email) = application.administrator_email and account.status <> 'deleted')
       or exists (select 1 from identity.staff staff
        where lower(staff.email) = application.administrator_email) then
      raise exception using errcode = '23505', message = 'First administrator email requires manual resolution';
    end if;
    new_account_id := gen_random_uuid();
    new_staff_id := gen_random_uuid();
    new_membership_id := gen_random_uuid();
    insert into auth.accounts (
      id, subject, email, display_name, status, source_system
    ) values (
      new_account_id, 'org-onboarding:' || new_account_id::text,
      application.administrator_email, application.administrator_name, 'pending_reset', 'hid'
    );
    insert into identity.staff (
      id, account_id, full_name, email, verification_status, default_role, active, source_system
    ) values (
      new_staff_id, new_account_id, application.administrator_name,
      application.administrator_email, 'verified', 'org_admin', true, 'hid'
    );
    insert into identity.staff_facility_memberships (
      id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active, source_system
    ) values (
      new_membership_id, new_staff_id, new_account_id, new_organization_id, new_facility_id,
      'org_admin', 'org_admin', true, true, 'hid'
    );
    insert into auth.account_roles (
      id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
    ) values (
      gen_random_uuid(), new_account_id, 'org_admin', 'facility', new_membership_id,
      new_facility_id, actor_account, 'Approved verified organization application'
    );
  end if;

  update identity.organization_applications row
     set status = 'approved', organization_id = new_organization_id,
         facility_id = new_facility_id, first_admin_account_id = new_account_id,
         reviewed_by_account_id = actor_account, review_reason = btrim(requested_reason),
         reviewed_at = clock_timestamp(), updated_at = clock_timestamp(),
         row_version = row.row_version + 1
   where row.id = application.id returning row.* into application;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), case when platform_scoped then 'platform' else 'staff' end,
    platform.current_actor_subject(), actor_account,
    platform.current_membership_id(), case when platform_scoped then null else new_organization_id end,
    platform.current_facility_id(),
    case when platform_scoped then 'admin.organization-application.approve'
      else 'identity.organization.application.approve' end, 'success',
    'organization-application', application.id::text, 'healthcare-operations',
    btrim(requested_reason), 'application', 'identity-api', jsonb_build_object(
      'productCode', application.product_code, 'organizationReused', reused,
      'firstAdminPendingEmailOtp', not reused
    ) || case when platform_scoped then jsonb_build_object('organizationId', new_organization_id)
      else '{}'::jsonb end
  );
  return query select new_organization_id, new_facility_id, new_account_id,
    application.row_version, reused;
end;
$$;

-- 4. Reject (0046's body; the audit row's actor type and action follow the
-- scope).
create or replace function identity.admin_reject_organization_application(
  requested_application_id uuid,
  expected_version bigint,
  requested_reason text
) returns table (application_status text, row_version bigint)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.organization_application_admin_account('platform.facility.manage');
  platform_scoped boolean := platform.current_facility_id() is null and platform.current_membership_id() is null;
  application identity.organization_applications%rowtype;
begin
  if length(btrim(coalesce(requested_reason, ''))) < 8 then
    raise exception using errcode = '22023', message = 'Review reason is required';
  end if;
  select * into application from identity.organization_applications row
    where row.id = requested_application_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Organization application not found'; end if;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  if application.status not in ('pending_verification', 'ready_for_review') then
    raise exception using errcode = '23514', message = 'Organization application is closed';
  end if;
  update identity.organization_applications row
     set status = 'rejected', reviewed_by_account_id = actor_account,
         review_reason = btrim(requested_reason), reviewed_at = clock_timestamp(),
         updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.id = application.id returning row.* into application;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), case when platform_scoped then 'platform' else 'staff' end,
    platform.current_actor_subject(), actor_account,
    platform.current_membership_id(), platform.current_facility_id(),
    case when platform_scoped then 'admin.organization-application.reject'
      else 'identity.organization.application.reject' end, 'denied', 'organization-application',
    application.id::text, 'healthcare-operations', btrim(requested_reason),
    'application', 'identity-api', jsonb_build_object('productCode', application.product_code)
  );
  return query select application.status, application.row_version;
end;
$$;

-- 5. Post-checks.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.organization_application_admin_account(text)', '186eb4ca420749b8bdb324bdc843bc50'),
      ('identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text,text)',
       '99aeaad4074f9d74c3f036817aedaeb6'),
      ('identity.admin_approve_organization_application(uuid,bigint,uuid,uuid,text)',
       '258e24e471d555b716dc0f57bab185e3'),
      ('identity.admin_reject_organization_application(uuid,bigint,text)', '8f449d98d58cfffff2e74a3b776a2055'),
      ('identity.admin_list_organization_applications(text)', '38b2cddb8540ef801f837f35c49340ec'),
      ('identity.admin_get_organization_application(uuid)', 'a92157ef404478cb2e487508419226e0'),
      ('platform.consume_qoreid_quota(text,uuid,uuid,character,character)', '5e2aee48fb68322660e4938d15e85c58'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is null and exists (
       select 1 from organization_applications_0103_acl before_row
         left join pg_proc proc on proc.oid = before_row.function_oid
        where proc.oid is null or proc.proowner <> before_row.proowner
           or proc.proacl::text is distinct from before_row.proacl::text
           or not proc.prosecdef or proc.proisstrict) then
    mismatch := 'an owner, ACL or SECURITY DEFINER changed';
  end if;
  if mismatch is null and (
       (select provolatile from pg_proc where oid = 'identity.organization_application_admin_account(text)'::regprocedure) <> 's'
       or (select count(*) from pg_proc
            where oid in ('identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text,text)'::regprocedure,
                          'identity.admin_approve_organization_application(uuid,bigint,uuid,uuid,text)'::regprocedure,
                          'identity.admin_reject_organization_application(uuid,bigint,text)'::regprocedure)
              and provolatile = 'v') <> 3) then
    mismatch := 'a volatility changed';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0103: post-check failed: %s', mismatch);
  end if;
end;
$$;
