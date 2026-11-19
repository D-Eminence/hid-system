-- 0134 Sealed QA only: a fictional pharmacist and a fictional lab scientist
-- at QA Hospital (QA-1 of the Akos EHR plan of 18 November 2026, Release A,
-- lane D). Written on staging-novu-ci-20261005 at 1f5e2c2a; it requires
-- 0001-0133 applied (0123's sealed QA tenant and 0133's own-facility
-- pharmacy and lab work). The declaration is signed separately (the release
-- integrator's).
--
-- Owner, 18 November 2026 (Q102, recommended answer accepted): "a fictional
-- QA pharmacist and lab worker at QA Hospital, sealed QA only", so the owner
-- can test, at QA Hospital, a prescription sent by itself to the hospital's
-- own pharmacy and a lab request worked on by the hospital's own lab (0133),
-- which today nobody at QA Hospital can see.
--
-- WHAT IT DOES
-- D1 No new person, login, address or password. The two fictional logins
--    0123 already seeded at QA Laboratory and QA Pharmacy gain a second
--    membership, at QA Hospital (an account may hold memberships at several
--    facilities, as 0123's QA Facility Admin does at all three):
--      lab@healthidentitydirectory.com "QA Lab Scientist" (0123's account
--        c0a00003-...0003): role lab at QA Hospital, membership and role
--        c0a00005-0000-4000-8000-000000000032;
--      pharmacy@healthidentitydirectory.com "QA Pharmacist" (0123's account
--        c0a00003-...0005): role pharmacist at QA Hospital, membership and
--        role c0a00005-0000-4000-8000-000000000052.
--    Both not primary; the owner picks QA Hospital when signing in. Their
--    existing memberships at QA Laboratory and QA Pharmacy are unchanged.
-- D2 identity.sealed_qa_hospital_work_staff_install() (SECURITY DEFINER,
--    the owner's alone, no EXECUTE for anyone else) writes them, under
--    0123's install lock: where the QA tenant is not installed (QA Hospital
--    is not a QA facility: CI, acceptance, rehearsals, throwaway clusters)
--    it writes nothing and answers 0. Otherwise it refuses (55000, nothing
--    written) when a fixed id is held by a row that is not this file's
--    (SEALED_QA_ID_TAKEN). Each of the two is written only when nothing
--    already stands for it, and is otherwise left alone, with a notice and
--    nothing written for it (the release goes on):
--      the login or its staff record is not 0123's now (deleted, no longer
--        a sealed QA account, or another staff record);
--      the QA Facility Admin already gave that staff record that role at QA
--        Hospital (an invitation the QA login accepted, active or since
--        deactivated: 0002's staff_memberships_scoped_uq allows one
--        membership per staff record, organization, facility and role).
--    Rows ON CONFLICT DO NOTHING, nothing existing updated; one audit row
--    with counts only when something was written; a second call writes
--    nothing. 0123's seal (G2q: a QA account only at a QA facility; G3q: no
--    platform role) applies to both rows.
-- D3 The migration calls it once (section 2). Where 0123 installed the
--    sealed QA tenant (0123 section 10 seeds it on Amazon RDS only, where
--    the rds_superuser role exists: production and staging), the two
--    memberships are written there and nowhere real or demo; on every other
--    database (CI, acceptance, rehearsals, throwaway clusters) nothing is
--    written and the function answers 0.
--
-- 0. Preconditions (catalog reads only, from pg_class, pg_proc,
--    pg_namespace and pg_attribute; each is a presence check that raises
--    when the thing is absent, never a comparison that can be null; each
--    failure raises 55000 or 42501 and nothing is applied):
--    a. 0001-0133 applied (the markers: 0123's identity.sealed_qa_install(),
--       identity.sealed_qa_facility(uuid) and identity.sealed_qa_account(uuid),
--       and 0133's identity.facility_work_member_allows and
--       pharmacy.own_prescription_sends);
--    b. 0134 not applied (no function of this file's name);
--    c. every column the function reads or writes, by name and type;
--    d. 0123's two helpers the function calls are byte for byte 0123's
--       (md5 of pg_proc.prosrc; a missing one counts as a mismatch);
--    e. one owner (identity.staff_facility_memberships') owns
--       auth.account_roles, audit.events, identity.facilities,
--       identity.staff, auth.accounts and 0123's install and two helpers;
--       the applier is that owner, or a member that inherits it and may SET
--       ROLE to it (else 42501).
-- 1. The function, as that owner.
-- 2. The call.
-- 3. Post-checks: the function's body (md5), owner, SECURITY DEFINER,
--    volatility, language, not STRICT, search_path and ACL (its owner only,
--    PUBLIC included, decided by EXISTS); where the QA tenant is installed,
--    each of the two memberships and roles exists exactly as D1 says, or is
--    left alone for one of D2's two reasons; where it is not, neither fixed
--    id exists.
--
-- Locks: no table lock beyond the rows written (ROW EXCLUSIVE on
-- identity.staff_facility_memberships, auth.account_roles and audit.events,
-- where the QA tenant is installed; it waits only behind DDL on them, and
-- the runner's 5 s lock_timeout stops it there with nothing applied) and
-- 0123's advisory install lock. Old services are unaffected: two more
-- memberships of two existing QA logins. Applied migrations before 0134 are
-- immutable.

-- 0. Preconditions.
do $$
declare
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
begin
  -- a. 0001-0133 applied.
  if not exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where (namespace.nspname, proc.proname, pg_catalog.oidvectortypes(proc.proargtypes)) in (
                    ('identity', 'sealed_qa_install', ''),
                    ('identity', 'sealed_qa_facility', 'uuid'),
                    ('identity', 'sealed_qa_account', 'uuid'),
                    ('identity', 'facility_work_member_allows', 'text, uuid, uuid, text'))
                 having count(distinct proc.oid) = 4)
     or not exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                     where namespace.nspname = 'pharmacy' and relation.relname = 'own_prescription_sends'
                       and relation.relkind = 'r') then
    raise exception using errcode = '55000', message = '0134: 0001-0133 must be applied first';
  end if;
  -- b. Not applied yet.
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'identity' and proc.proname = 'sealed_qa_hospital_work_staff_install') then
    raise exception using errcode = '55000', message = '0134: already applied';
  end if;
  -- c. Every column the function reads or writes, by name and type.
  with expected(schema_name, relation_name, column_names) as (values
         ('identity', 'facilities', array['id uuid', 'organization_id uuid']),
         ('auth', 'accounts', array['id uuid', 'status text']),
         ('identity', 'staff', array['id uuid', 'account_id uuid']),
         ('identity', 'staff_facility_memberships', array['id uuid', 'staff_id uuid', 'account_id uuid',
           'organization_id uuid', 'facility_id uuid', 'membership_role text', 'app_role text', 'is_primary boolean',
           'active boolean', 'source_system text']),
         ('auth', 'account_roles', array['id uuid', 'account_id uuid', 'role_code text', 'scope_type text',
           'membership_id uuid', 'facility_id uuid', 'grant_reason text', 'revoked_at timestamp with time zone']),
         ('audit', 'events', array['correlation_id text', 'actor_type text', 'action text', 'outcome text',
           'resource_type text', 'provenance text', 'source_system text', 'details jsonb'])),
       absent as (
         select expected.schema_name, expected.relation_name, wanted.column_name
           from expected cross join unnest(expected.column_names) wanted(column_name)
          where not exists (
            select 1 from pg_attribute attribute_row
              join pg_class relation on relation.oid = attribute_row.attrelid
              join pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = expected.schema_name and relation.relname = expected.relation_name
               and relation.relkind in ('r', 'p') and attribute_row.attnum > 0 and not attribute_row.attisdropped
               and attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
                   = wanted.column_name))
  select exists (select 1 from absent),
         (select string_agg(format('%s.%s.%s', absent.schema_name, absent.relation_name, absent.column_name), '; ')
            from absent)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0134: a column this migration relies on is missing or of another type: %s', missing);
  end if;
  -- d. 0123's helpers, byte for byte.
  with expected(proc_name, digest) as (values
         ('sealed_qa_facility', 'fe9846d94cd744bf37c3f72053d9931f'),
         ('sealed_qa_account', '2c19c76bff02b394097724f99e09fc9d')),
       differing as (
         select expected.* from expected
          where not exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                             where namespace.nspname = 'identity' and proc.proname = expected.proc_name
                               and pg_catalog.oidvectortypes(proc.proargtypes) = 'uuid'
                               and md5(proc.prosrc) = expected.digest))
  select exists (select 1 from differing), (select string_agg(differing.proc_name, ', ') from differing)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0134: 0123''s helpers differ from 0123 or are missing: %s', missing);
  end if;
  -- e. One owner, and an applier that is it or may act as it.
  owner_oid := (select relation.relowner from pg_class relation
                  join pg_namespace namespace on namespace.oid = relation.relnamespace
                 where namespace.nspname = 'identity' and relation.relname = 'staff_facility_memberships'
                   and relation.relkind = 'r');
  with foreign_owned as (
         select format('%s.%s', expected.schema_name, expected.relation_name) as what
           from (values ('auth', 'account_roles'), ('audit', 'events'), ('identity', 'facilities'), ('identity', 'staff'),
                        ('auth', 'accounts')) expected(schema_name, relation_name)
          where not exists (select 1 from pg_class relation
                              join pg_namespace namespace on namespace.oid = relation.relnamespace
                             where namespace.nspname = expected.schema_name
                               and relation.relname = expected.relation_name and relation.relowner = owner_oid)
         union all
         select format('identity.%s()', expected.proc_name)
           from (values ('sealed_qa_install'), ('sealed_qa_facility'), ('sealed_qa_account')) expected(proc_name)
          where not exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                             where namespace.nspname = 'identity' and proc.proname = expected.proc_name
                               and proc.proowner = owner_oid))
  select exists (select 1 from foreign_owned), (select string_agg(foreign_owned.what, ', ') from foreign_owned)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501',
      message = format('0134: these are not owned by %s, the owner of identity.staff_facility_memberships: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), missing);
  end if;
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0134: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of '
        || 'identity.staff_facility_memberships, auth.account_roles and 0123''s sealed QA install', current_user,
        pg_get_userbyid(owner_oid));
  end if;
  raise notice '0134: preconditions checked; applier %; owner %', current_user, pg_get_userbyid(owner_oid);
end
$$;

-- 1. The function, as the owner (a no-op when the applier is the owner).
do $$
declare
  owner_name text := (select pg_get_userbyid(relation.relowner) from pg_class relation
                       where relation.oid = 'identity.staff_facility_memberships'::regclass);
begin
  if owner_name <> current_user then
    execute format('set local role %I', owner_name);
  end if;
end
$$;

create function identity.sealed_qa_hospital_work_staff_install()
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  qa_hospital_organization constant uuid := 'c0a00001-0000-4000-8000-000000000001';
  qa_hospital constant uuid := 'c0a00002-0000-4000-8000-000000000001';
  role_reason constant text := 'Sealed QA tenant: QA Hospital''s own pharmacy and lab (0134, owner decision Q102)';
  correlation constant text := '0134-sealed-qa-hospital-staff';
  staff_rows constant jsonb := '[
    {"membership": "c0a00005-0000-4000-8000-000000000032", "account": "c0a00003-0000-4000-8000-000000000003",
     "staff": "c0a00004-0000-4000-8000-000000000003", "role": "lab"},
    {"membership": "c0a00005-0000-4000-8000-000000000052", "account": "c0a00003-0000-4000-8000-000000000005",
     "staff": "c0a00004-0000-4000-8000-000000000005", "role": "pharmacist"}]';
  wanted record;
  step bigint;
  inserted integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('hid-sealed-qa-install', 0));
  -- The QA tenant is not installed here: nothing to do.
  if not exists (select 1 from identity.facilities facility
                  where facility.id = qa_hospital and facility.organization_id = qa_hospital_organization)
     or not identity.sealed_qa_facility(qa_hospital) then
    return 0;
  end if;
  -- A fixed id held by a row that is not this file's.
  if exists (select 1 from identity.staff_facility_memberships membership
               join jsonb_to_recordset(staff_rows) qa(membership uuid, account uuid, staff uuid, role text)
                 on qa.membership = membership.id
              where membership.account_id <> qa.account or membership.staff_id <> qa.staff
                 or membership.facility_id <> qa_hospital or membership.organization_id <> qa_hospital_organization)
     or exists (select 1 from auth.account_roles assignment
                  join jsonb_to_recordset(staff_rows) qa(membership uuid, account uuid, role text)
                    on qa.membership = assignment.id
                 where assignment.account_id <> qa.account or assignment.scope_type <> 'facility'
                    or assignment.membership_id is distinct from qa.membership
                    or assignment.role_code <> qa.role) then
    raise exception using errcode = '55000', message = '0134: SEALED_QA_ID_TAKEN';
  end if;

  for wanted in select * from jsonb_to_recordset(staff_rows) qa(membership uuid, account uuid, staff uuid, role text)
  loop
    -- The login and its staff record are 0123's now (not deleted, still a
    -- sealed QA account): else nothing is written for it.
    if not exists (select 1 from auth.accounts account
                     join identity.staff staff_row on staff_row.account_id = account.id
                    where account.id = wanted.account and account.status <> 'deleted'
                      and staff_row.id = wanted.staff and identity.sealed_qa_account(account.id)) then
      raise notice '0134: the QA % login is not 0123''s now; nothing written for it', wanted.role;
      continue;
    end if;
    -- The QA Facility Admin already gave this staff record this role at QA
    -- Hospital (another id, active or not): left as it is.
    if exists (select 1 from identity.staff_facility_memberships membership
                where membership.staff_id = wanted.staff and membership.organization_id = qa_hospital_organization
                  and membership.facility_id = qa_hospital and membership.membership_role = wanted.role
                  and membership.id <> wanted.membership) then
      raise notice '0134: the QA % login already has that role at QA Hospital; left as it is', wanted.role;
      continue;
    end if;
    insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active, source_system)
    values (wanted.membership, wanted.staff, wanted.account, qa_hospital_organization, qa_hospital, wanted.role,
      wanted.role, false, true, 'hid-sealed-qa')
    on conflict (id) do nothing;
    get diagnostics step = row_count; inserted := inserted + step;
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values (wanted.membership, wanted.account, wanted.role, 'facility', wanted.membership, qa_hospital, role_reason)
    on conflict (id) do nothing;
    get diagnostics step = row_count; inserted := inserted + step;
  end loop;

  if inserted > 0 then
    insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, provenance,
      source_system, details)
    values (correlation, 'system', 'identity.sealed-qa.hospital-work-staff', 'success', 'sealed-qa-tenant',
      'migration', 'hid-sealed-qa', jsonb_build_object('rowsInserted', inserted, 'memberships', 2));
  end if;
  return inserted;
end;
$$;

revoke all on function identity.sealed_qa_hospital_work_staff_install() from public;

comment on function identity.sealed_qa_hospital_work_staff_install() is
  '0134: where the sealed QA tenant (0123) is installed, gives its QA Lab Scientist and QA Pharmacist logins a lab and a pharmacist membership at QA Hospital (fixed ids, once); elsewhere nothing. The owner''s alone.';

-- 2. The call (nothing where the QA tenant is not installed).
select identity.sealed_qa_hospital_work_staff_install();

-- 3. Post-checks.
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation
                     where relation.oid = 'identity.staff_facility_memberships'::regclass);
  install oid := 'identity.sealed_qa_hospital_work_staff_install()'::regprocedure;
begin
  -- The function: this file's body, plpgsql, SECURITY DEFINER, volatile, not
  -- STRICT, this search_path, owned with the memberships, executable by its
  -- owner only (PUBLIC included).
  if not exists (
       select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid = install and language_row.lanname = 'plpgsql' and proc.prosecdef and proc.provolatile = 'v'
          and not proc.proisstrict and proc.proowner = owner_oid
          and proc.proconfig = array['search_path=pg_catalog, pg_temp']
          and md5(proc.prosrc) = 'ddce099c7c25ad606a2c3b290bd63b40')
     or (select count(*) from pg_proc proc
          where proc.pronamespace = 'identity'::regnamespace and proc.proname = 'sealed_qa_hospital_work_staff_install') <> 1
     or exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
                 where proc.oid = install and privilege.grantee <> proc.proowner) then
    raise exception using errcode = '55000', message = '0134: the function is not as this file makes it';
  end if;
  -- Where the QA tenant is installed, each of the two exactly, or left
  -- alone for one of D2's reasons; elsewhere, neither fixed id exists.
  if identity.sealed_qa_facility('c0a00002-0000-4000-8000-000000000001') then
    if exists (
         select 1
           from (values ('c0a00005-0000-4000-8000-000000000032'::uuid, 'c0a00003-0000-4000-8000-000000000003'::uuid,
                         'c0a00004-0000-4000-8000-000000000003'::uuid, 'lab'),
                        ('c0a00005-0000-4000-8000-000000000052'::uuid, 'c0a00003-0000-4000-8000-000000000005'::uuid,
                         'c0a00004-0000-4000-8000-000000000005'::uuid, 'pharmacist'))
                wanted(membership_id, account_id, staff_id, role_code)
          where not exists (
                  select 1 from identity.staff_facility_memberships membership
                    join auth.account_roles assignment on assignment.id = membership.id
                     and assignment.membership_id = membership.id and assignment.revoked_at is null
                   where membership.id = wanted.membership_id and membership.account_id = wanted.account_id
                     and membership.staff_id = wanted.staff_id and assignment.role_code = wanted.role_code
                     and membership.membership_role = wanted.role_code
                     and membership.facility_id = 'c0a00002-0000-4000-8000-000000000001'
                     and membership.organization_id = 'c0a00001-0000-4000-8000-000000000001'
                     and assignment.facility_id = 'c0a00002-0000-4000-8000-000000000001'
                     and assignment.scope_type = 'facility' and membership.active and not membership.is_primary)
            and not exists (
                  select 1 from identity.staff_facility_memberships membership
                   where membership.staff_id = wanted.staff_id and membership.membership_role = wanted.role_code
                     and membership.facility_id = 'c0a00002-0000-4000-8000-000000000001'
                     and membership.organization_id = 'c0a00001-0000-4000-8000-000000000001'
                     and membership.id <> wanted.membership_id)
            and exists (
                  select 1 from auth.accounts account
                    join identity.staff staff_row on staff_row.account_id = account.id
                   where account.id = wanted.account_id and account.status <> 'deleted'
                     and staff_row.id = wanted.staff_id and identity.sealed_qa_account(account.id))) then
      raise exception using errcode = '55000', message = '0134: the QA Hospital memberships are not written';
    end if;
  elsif exists (select 1 from identity.staff_facility_memberships membership
                 where membership.id in ('c0a00005-0000-4000-8000-000000000032', 'c0a00005-0000-4000-8000-000000000052'))
     or exists (select 1 from auth.account_roles assignment
                 where assignment.id in ('c0a00005-0000-4000-8000-000000000032', 'c0a00005-0000-4000-8000-000000000052')) then
    raise exception using errcode = '55000', message = '0134: QA Hospital rows exist where the QA tenant is not installed';
  end if;
end
$$;

reset role;
