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
--    written) when either account or staff record is not 0123's (not a QA
--    account, deleted, another staff record: SEALED_QA_HOSPITAL_STAFF_UNEXPECTED),
--    or a fixed id is held by a row that is not this file's
--    (SEALED_QA_ID_TAKEN). Rows ON CONFLICT DO NOTHING, nothing existing
--    updated; one audit row with counts only when something was written; a
--    second call writes nothing. 0123's seal (G2q: a QA account only at a
--    QA facility; G3q: no platform role) applies to both rows.
-- D3 The migration calls it once (section 2). On production the QA tenant
--    exists (0123 seeded it), so the two memberships are written there and
--    nowhere real or demo; on every other database nothing is written.
--
-- 0. Preconditions (catalog reads only; 55000 or 42501, nothing applied):
--    0123's identity.sealed_qa_install() and identity.sealed_qa_facility(uuid)
--    and 0133's identity.facility_work_member_allows exist; this file's
--    function does not; the applier owns identity.staff_facility_memberships
--    and auth.account_roles or may SET ROLE to their owner.
-- 1. The function, as that owner.
-- 2. The call.
-- 3. Post-checks: the function's owner, SECURITY DEFINER, search_path and
--    ACL (its owner only); where the QA tenant is installed, both rows exist
--    exactly as D1 says.
--
-- Locks: none on existing data beyond the rows written (ROW EXCLUSIVE on
-- identity.staff_facility_memberships, auth.account_roles and audit.events
-- where the QA tenant is installed) and 0123's advisory install lock.
-- Old services are unaffected: two more memberships of two existing QA
-- logins. Applied migrations before 0134 are immutable.

-- 0. Preconditions.
do $$
declare
  applier oid := (select oid from pg_roles where rolname = current_user);
  owner_oid oid := (select relation.relowner from pg_class relation
                     where relation.oid = 'identity.staff_facility_memberships'::regclass);
begin
  if to_regprocedure('identity.sealed_qa_install()') is null
     or to_regprocedure('identity.sealed_qa_facility(uuid)') is null
     or to_regprocedure('identity.sealed_qa_account(uuid)') is null
     or to_regprocedure('identity.facility_work_member_allows(text,uuid,uuid,text)') is null then
    raise exception using errcode = '55000', message = '0134: 0001-0133 must be applied first';
  end if;
  if to_regprocedure('identity.sealed_qa_hospital_work_staff_install()') is not null then
    raise exception using errcode = '55000', message = '0134: already applied';
  end if;
  if (select relation.relowner from pg_class relation where relation.oid = 'auth.account_roles'::regclass) <> owner_oid
     or (select proc.proowner from pg_proc proc where proc.oid = 'identity.sealed_qa_install()'::regprocedure)
        <> owner_oid then
    raise exception using errcode = '55000',
      message = '0134: identity.staff_facility_memberships, auth.account_roles and 0123''s install have different owners';
  end if;
  if applier <> owner_oid and not pg_has_role(applier, owner_oid, 'SET') then
    raise exception using errcode = '42501',
      message = format('0134: %s is not %s and may not SET ROLE to it', current_user, pg_get_userbyid(owner_oid));
  end if;
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
  -- Both logins and staff records are 0123's.
  if (select count(*) from jsonb_to_recordset(staff_rows) qa(account uuid, staff uuid)
        join auth.accounts account on account.id = qa.account and account.status <> 'deleted'
        join identity.staff staff_row on staff_row.id = qa.staff and staff_row.account_id = qa.account
       where identity.sealed_qa_account(account.id)) <> 2 then
    raise exception using errcode = '55000', message = '0134: SEALED_QA_HOSPITAL_STAFF_UNEXPECTED';
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

  insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, source_system)
  select qa.membership, qa.staff, qa.account, qa_hospital_organization, qa_hospital, qa.role, qa.role, false, true,
         'hid-sealed-qa'
    from jsonb_to_recordset(staff_rows) qa(membership uuid, account uuid, staff uuid, role text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
  select qa.membership, qa.account, qa.role, 'facility', qa.membership, qa_hospital, role_reason
    from jsonb_to_recordset(staff_rows) qa(membership uuid, account uuid, role text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

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
begin
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'identity.sealed_qa_hospital_work_staff_install()'::regprocedure
                    and proc.proowner = owner_oid and proc.prosecdef and proc.provolatile = 'v'
                    and proc.proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[])
     or exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid = 'identity.sealed_qa_hospital_work_staff_install()'::regprocedure
                   and acl.grantee <> proc.proowner) then
    raise exception using errcode = '55000', message = '0134: the function is not as this file makes it';
  end if;
  if identity.sealed_qa_facility('c0a00002-0000-4000-8000-000000000001')
     and (select count(*) from identity.staff_facility_memberships membership
            join auth.account_roles assignment on assignment.id = membership.id
             and assignment.membership_id = membership.id and assignment.revoked_at is null
           where (membership.id, membership.account_id, assignment.role_code) in
                 (('c0a00005-0000-4000-8000-000000000032'::uuid, 'c0a00003-0000-4000-8000-000000000003'::uuid, 'lab'),
                  ('c0a00005-0000-4000-8000-000000000052'::uuid, 'c0a00003-0000-4000-8000-000000000005'::uuid,
                   'pharmacist'))
             and membership.facility_id = 'c0a00002-0000-4000-8000-000000000001'
             and membership.active) <> 2 then
    raise exception using errcode = '55000', message = '0134: the QA Hospital memberships are not written';
  end if;
end
$$;

reset role;
