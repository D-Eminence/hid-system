-- 0111 One-person lab check (owner decision 33.3: "two-person lab check
-- default; a single-person facility may release with a typed, logged
-- reason"; and owner decision of 3 Nov 2026 13:00: "switch One-person lab
-- ON at Demo Laboratory only"; unsigned until the owner signs). Written on
-- 0103 (34d6955). The numbers 0104-0110 belong to other unreleased work and
-- are not on this branch; they may be applied before this file, which reads
-- or needs nothing they add (its preconditions pin only 0001-0103 objects).
--
-- The gap: lab.validate_result_governance() (0021, rewritten by 0077) refuses
-- every verification whose verifier entered the result version
-- (rev.entered_by = verified_by) with 23514 'Result verifier must be
-- independent and result must be eligible'. A laboratory with one scientist
-- can therefore never verify, and so never release, a result: the Lab API
-- answers 500 INTERNAL_ERROR (the error is not mapped), and the demo story's
-- two results (one login) cannot be checked.
--
-- The change (additive; no existing row is touched):
-- 1. identity.facility_lab_check_settings (new, append-only): each switch of
--    "One-person lab" by a facility administrator, with who (account and
--    membership), when, which way, the typed reason (10-500 characters) and
--    the correlation id. Without a row a facility is two-person (off).
-- 2. identity.facility_lab_check_current (new): one row per facility that
--    ever switched, naming its newest setting row. The setter updates it;
--    a self-check reads it FOR SHARE. That row lock (not an advisory lock)
--    is what makes a switch-off and a self-check exclusive even under the Lab
--    API's SERIALIZABLE transactions: a switch-off waits for an open
--    self-check to commit, and a self-check whose snapshot predates a
--    committed switch-off fails 40001 on the lock (the Lab API retries it and
--    the retry sees "off"). An advisory lock alone would not do: a
--    SERIALIZABLE self-check reads its old snapshot after the lock.
-- 3. lab.result_verifications: self_check boolean not null default false and
--    one_person_setting_id uuid null (FK (one_person_setting_id, facility_id)
--    to the setting row), with result_verifications_self_check_ck: a
--    self-check names a setting row and has a reason of 10-500 characters;
--    any other check names none. Every existing row is false/null and passes.
-- 4. identity.set_facility_one_person_lab(enabled, reason) and
--    identity.facility_one_person_lab_state() for the Identity API (an
--    organization.manage member at the session facility, a correlation id,
--    purpose healthcare-operations; else 42501
--    FACILITY_SETTING_PERMISSION_DENIED); the setter writes the setting row
--    and one audit.events row (identity.facility.one-person-lab.on/.off) and
--    answers P0001 FACILITY_SETTING_UNCHANGED, writing nothing, when the
--    facility is already that way; a reason outside 10-500 characters after
--    trimming is 22023 FACILITY_SETTING_REASON_INVALID.
--    "Trimming" here and below removes every whitespace character that
--    JavaScript's String.prototype.trim removes (spaces, tabs, line breaks,
--    form feeds, no-break and other Unicode spaces, U+FEFF), not only the
--    spaces of one-argument btrim(), so a reason of only whitespace is
--    refused by the database itself, not only by the services.
-- 5. lab.one_person_lab_enabled() for the Lab API: the caller's own
--    facility's switch (false without an active membership there).
-- 6. lab.validate_result_governance(): a new body. The binding checks, the
--    actor checks and the release and invalidation branches are byte for
--    byte 0077's. In the verification branch an invalidated version keeps
--    the old message; a same-person check is refused with
--    LAB_RESULT_SECOND_CHECK_REQUIRED (off), or
--    LAB_RESULT_SELF_CHECK_REASON_REQUIRED (on, but self_check not asked),
--    or 22023 LAB_RESULT_SELF_CHECK_REASON_INVALID (on, reason not 10-500);
--    otherwise it is accepted and one_person_setting_id is set to the newest
--    setting row (never the client's value). A different person's check is
--    as before; asking self_check for it is LAB_RESULT_SELF_CHECK_NOT_YOURS.
--    Release is unchanged (it never had an independence rule). Messages are
--    bare codes; the typed reason is never in an error, notice or log.
-- 7. The sealed demo (owner decision of 3 Nov 2026 13:00): One-person lab is
--    ON at Demo Laboratory (0098's facility 98d00002-...-000000000002) and
--    at no other facility, demo or real. identity.demo_one_person_lab_install()
--    (owner-only, SECURITY DEFINER, granted to no role) writes the one
--    setting row the setter would write (fixed id
--    98d0000b-0000-4000-8000-000000000001, one_person true, the reason
--    'Demo Laboratory works as a one-person lab for the demo (owner
--    decision, 3 Nov 2026).', correlation id
--    0111-sealed-demo-one-person-lab), its current row, and one audit row of
--    the migration's own (actor system, provenance migration, source system
--    hid-sealed-demo, action identity.facility.one-person-lab.on, resource
--    the facility, details settingId, onePersonLab true, previous false;
--    never a person as actor). The setting names the demo login's Demo
--    Laboratory membership as set_by (the columns are not null and must name
--    a member of the facility), as 0102 D4 names the patient's account; the
--    audit row says the migration wrote it. Every id it touches must be the
--    sealed demo's as 0098 left it (the facility, its organization, the demo
--    staff account and its lab membership there, each in
--    identity.sealed_demo_members where 0098 marks it); else 55000
--    0111: SEALED_DEMO_LAB_CHECK_NOT_DEMO and nothing is written. Once: when
--    Demo Laboratory already has any setting row (a tester or the owner
--    switched it since), it writes nothing and answers {"settings": 0}. As
--    0098 D3 and 0102 D1, it runs only on Amazon RDS (the role rds_superuser
--    exists), where 0098 seeded the demo; CI, acceptance, the rehearsals and
--    throwaway clusters get the function only, and the suite
--    lab-one-person-demo calls 0098's install and this one itself. It adds no
--    member to the demo and changes no seal trigger or policy, so the seal
--    is unchanged; the demo login can still switch it off at Demo Laboratory
--    (org_admin there), as any facility administrator can.
--    Before signing, the owner may run on production, as the owner of schema
--    identity, the install's own refusal test; it must answer true (false:
--    0111 stops with SEALED_DEMO_LAB_CHECK_NOT_DEMO and holds back the
--    release). The suite lab-one-person-demo runs this text and expects
--    false without the demo, true after 0098's install and false with
--    another Demo Laboratory code:
--      select identity.sealed_demo_facility('98d00002-0000-4000-8000-000000000002')
--         and identity.sealed_demo_account('98d00003-0000-4000-8000-000000000001')
--         and exists (select 1 from identity.sealed_demo_members m
--                      where m.member_kind = 'organization'
--                        and m.member_id = '98d00001-0000-4000-8000-000000000002')
--         and exists (select 1 from identity.facilities f
--                      where f.id = '98d00002-0000-4000-8000-000000000002'
--                        and f.organization_id = '98d00001-0000-4000-8000-000000000002'
--                        and upper(f.code) = 'DEMO-LABORATORY')
--         and exists (select 1 from identity.staff_facility_memberships s
--                      where s.id = '98d00005-0000-4000-8000-000000000002'
--                        and s.account_id = '98d00003-0000-4000-8000-000000000001'
--                        and s.facility_id = '98d00002-0000-4000-8000-000000000002'
--                        and s.organization_id = '98d00001-0000-4000-8000-000000000002')
--             as demo_laboratory_ready;
--
-- Services: today's images need nothing and give the same answers, except
-- that a same-person check now fails with a coded 23514 message (still 500 in
-- an old Lab API). The new Lab API maps the codes to 409/400 and reads the
-- switch; the new Identity API adds GET /api/v1/identity/facility-settings and
-- POST /api/v1/identity/facility-settings/one-person-lab.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0103 applied (0103's
--    identity.organization_application_admin_account body the marker); not
--    applied yet (neither new table, no self_check column, no demo seed
--    function); the bodies replaced or relied on are byte for byte 0001-0103's (md5 of
--    pg_proc.prosrc; 0098's sealed_demo_facility and sealed_demo_account
--    among them); the governance function's attributes and its three
--    triggers; organization.manage exists and the lab role does not hold it;
--    lab.result_verifications has exactly 0021's columns and constraints; one
--    owner for the governance function, the tables read or referenced and
--    schemas identity and lab; and, checked first, the applier is the owner
--    of schema identity or a member that inherits it and may SET ROLE to it
--    (else 42501).
-- 1. The two tables, the column change, the four functions and the new
--    body. New objects are given to that owner. The grants runtime-grants.sql
--    makes are repeated here (only when the role exists).
-- 2. Post-checks: the new body, the governance function's attributes, owner
--    and ACL, its triggers, the new objects' owners and ACLs, and no
--    row-level security, FORCE or policy change on any existing table.
-- 3. The demo seed (7), on Amazon RDS only. A refusal raises 55000 and the
--    release stops with nothing applied.
--
-- Locks (measured with pg_locks before commit on a 0103 copy), all held to
-- commit: ACCESS EXCLUSIVE on lab.result_verifications (ADD COLUMN with a
-- constant default, which PostgreSQL 16 adds as metadata only, and the two
-- constraints, whose validation reads the existing rows); SHARE ROW EXCLUSIVE
-- on identity.facilities, identity.staff_facility_memberships and
-- auth.accounts (the new tables' foreign keys; no row of them is read, and
-- their writers wait only for the commit); ACCESS SHARE on auth.permissions
-- and auth.role_permissions (section 0 reads them), on the pg_proc row
-- replaced, the schemas and the language; ACCESS EXCLUSIVE on the two new
-- tables. On Amazon RDS the demo seed (3) also takes ROW EXCLUSIVE on the
-- two new tables and audit.events. No other application table is locked (the post-check compares
-- policies without deparsing them, so it opens no table). The file takes
-- milliseconds on production's row counts. Behind an open transaction holding
-- any lock on lab.result_verifications (one that read or wrote it), or ROW
-- EXCLUSIVE or more on one of the three referenced tables, the runner
-- stops after its 5 s lock_timeout with nothing applied (measured: a session
-- holding ROW EXCLUSIVE on lab.result_verifications). A request already
-- running finishes with the old body; one that starts after commit
-- runs the new one. Applied migrations 0001 through 0103 are immutable.

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  schema_owner oid := (select namespace.nspowner from pg_namespace namespace where namespace.nspname = 'identity');
begin
  -- The applier first, from catalogs any role may read: the owner of schema
  -- identity, or a member that inherits it and may SET ROLE to it (never a
  -- superuser's bypass alone). Section d checks that one owner holds
  -- everything this file changes or references.
  if schema_owner is null then
    raise exception using errcode = '55000', message = '0111: 0001-0103 must be applied first';
  end if;
  if applier <> schema_owner
     and not (pg_has_role(applier, schema_owner, 'USAGE') and pg_has_role(applier, schema_owner, 'SET')) then
    raise exception using errcode = '42501',
      message = format('0111: %s is not %s and may not act as it (INHERIT and SET)', current_user,
        pg_get_userbyid(schema_owner));
  end if;
  -- a. Prerequisites: 0001-0103 (0103's gate body is the marker).
  if to_regprocedure('identity.organization_application_admin_account(text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = 'identity.organization_application_admin_account(text)'::regprocedure)
        is distinct from '186eb4ca420749b8bdb324bdc843bc50'
     or to_regclass('lab.result_verifications') is null
     or to_regclass('lab.result_revisions') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('audit.events') is null
     or to_regclass('identity.sealed_demo_members') is null then
    raise exception using errcode = '55000', message = '0111: 0001-0103 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('identity.facility_lab_check_settings') is not null
     or to_regclass('identity.facility_lab_check_current') is not null
     or to_regprocedure('identity.demo_one_person_lab_install()') is not null
     or exists (select 1 from pg_attribute attribute
                 where attribute.attrelid = 'lab.result_verifications'::regclass
                   and attribute.attname in ('self_check', 'one_person_setting_id') and not attribute.attisdropped) then
    raise exception using errcode = '55000', message = '0111: already applied';
  end if;
  -- c. The bodies replaced and relied on, as 0001-0103 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('lab.validate_result_governance()', '6bf52a22ce45e834d4f2a194a06babad'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_demo_account(uuid)', '16eae1d6c33b3bef793796cf66f1cdf6'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- The governance function's attributes (plpgsql, SECURITY DEFINER, not
  -- STRICT, VOLATILE, its search_path) and its three triggers, enabled.
  if mismatch is null and not exists (
       select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid = 'lab.validate_result_governance()'::regprocedure
          and language_row.lanname = 'plpgsql' and proc.prosecdef and not proc.proisstrict
          and proc.provolatile = 'v' and proc.prorettype = 'trigger'::regtype
          and proc.proconfig = '{"search_path=lab, platform, pg_temp"}'::text[]) then
    mismatch := 'attributes of lab.validate_result_governance()';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgfoid = 'lab.validate_result_governance()'::regprocedure
             and trigger_row.tgenabled = 'O' and not trigger_row.tgisinternal
             and pg_get_triggerdef(trigger_row.oid) in (
               'CREATE TRIGGER lab_verification_validate BEFORE INSERT ON lab.result_verifications '
                 || 'FOR EACH ROW EXECUTE FUNCTION lab.validate_result_governance()',
               'CREATE TRIGGER lab_release_validate BEFORE INSERT ON lab.result_releases '
                 || 'FOR EACH ROW EXECUTE FUNCTION lab.validate_result_governance()',
               'CREATE TRIGGER lab_invalidation_validate BEFORE INSERT ON lab.result_invalidations '
                 || 'FOR EACH ROW EXECUTE FUNCTION lab.validate_result_governance()')) <> 3
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgfoid = 'lab.validate_result_governance()'::regprocedure) <> 3 then
    mismatch := coalesce(mismatch, 'the three triggers of lab.validate_result_governance()');
  end if;
  -- organization.manage exists and is active; the lab role does not hold it.
  if mismatch is null
     and (not exists (select 1 from auth.permissions permission_row
                       where permission_row.code = 'organization.manage' and permission_row.active)
          or exists (select 1 from auth.role_permissions role_permission
                      where role_permission.role_code = 'lab'
                        and role_permission.permission_code = 'organization.manage')) then
    mismatch := 'organization.manage (missing, inactive, or held by the lab role)';
  end if;
  -- lab.result_verifications as 0021 left it: its columns and constraints.
  if mismatch is null
     and (select string_agg(attribute.attname || ':' || format_type(attribute.atttypid, attribute.atttypmod)
                            || ':' || attribute.attnotnull, ',' order by attribute.attnum)
            from pg_attribute attribute
           where attribute.attrelid = 'lab.result_verifications'::regclass
             and attribute.attnum > 0 and not attribute.attisdropped)
         is distinct from 'id:uuid:true,result_id:uuid:true,execution_id:uuid:true,patient_id:uuid:true,'
           || 'facility_id:uuid:true,result_version:bigint:true,method:text:true,verified_by:uuid:true,'
           || 'verified_by_membership_id:uuid:true,verified_at:timestamp with time zone:true,reason:text:true,'
           || 'idempotency_key:text:true,request_sha256:character(64):true,correlation_id:text:true' then
    mismatch := 'the columns of lab.result_verifications';
  end if;
  if mismatch is null
     and (select string_agg(constraint_row.conname || ':' || md5(pg_get_constraintdef(constraint_row.oid)), ','
                            order by constraint_row.conname)
            from pg_constraint constraint_row
           where constraint_row.conrelid = 'lab.result_verifications'::regclass)
         is distinct from 'result_verifications_facility_id_verified_by_idempotency_ke_key:a145a786c04d42a06ea46c59d786b722,'
           || 'result_verifications_id_result_id_result_version_patient_id_key:56764dd9766e1f7f6668086d55526fd8,'
           || 'result_verifications_method_check:86d00ba21d6dc855f50a1dc83bb8d87c,'
           || 'result_verifications_pkey:4c6419b3704337bbfe50f018842a9ad3,'
           || 'result_verifications_reason_check:d7a1564d4b6c5337e9ec34f86c3cb560,'
           || 'result_verifications_request_sha256_check:eff6e2f4f45ba4b3a68bc0bdb9927a6a,'
           || 'result_verifications_result_id_execution_id_patient_id_fac_fkey:f797d292f738214c7556524f8e5dd536,'
           || 'result_verifications_result_id_result_version_key:4c430513ea39a58cfa5355fa78742aba,'
           || 'result_verifications_result_version_check:c2b2ccfdc6631e490605b7f5b45015e6,'
           || 'result_verifications_verified_by_membership_id_facility_id_fkey:28abb36e2a0ed34de01a8e9032f98172' then
    mismatch := 'the constraints of lab.result_verifications';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0111: an object this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- d. One owner for the function replaced, the tables altered, read or
  -- referenced, and the two schemas the new objects go into (the applier was
  -- checked against it first).
  select string_agg(distinct pg_get_userbyid(owner_row.owner), ', ') into mismatch
    from (select proc.proowner as owner from pg_proc proc
           where proc.oid = 'lab.validate_result_governance()'::regprocedure
          union all
          select namespace.nspowner from pg_namespace namespace where namespace.nspname in ('identity', 'lab')
          union all
          select class_row.relowner from pg_class class_row
           where class_row.oid in ('lab.result_verifications'::regclass, 'lab.result_revisions'::regclass,
             'identity.facilities'::regclass, 'identity.staff_facility_memberships'::regclass,
             'identity.staff'::regclass, 'auth.accounts'::regclass, 'audit.events'::regclass)) owner_row;
  if mismatch is distinct from pg_get_userbyid(schema_owner) then
    raise exception using errcode = '55000',
      message = format('0111: the objects this migration changes or references must share one owner (found %s)', mismatch);
  end if;
  raise notice '0111: owners checked: identity=%, applier=%', pg_get_userbyid(schema_owner), current_user;
end;
$$;

-- The state before, for the post-checks: the governance function's owner and
-- ACL, and every existing table's row-level security, FORCE and policies.
create temporary table lab_one_person_0111_before on commit drop as
  select 'function'::text as kind, proc.oid::regprocedure::text as name,
         proc.proowner::text || ' ' || coalesce(proc.proacl::text, '') as state
    from pg_proc proc where proc.oid = 'lab.validate_result_governance()'::regprocedure
  union all
  select 'table', class_row.oid::regclass::text,
         class_row.relrowsecurity::text || ' ' || class_row.relforcerowsecurity::text || ' '
         || coalesce((select md5(string_agg(policy_row.polname || ':' || policy_row.polcmd::text || ':'
                                   || policy_row.polpermissive::text || ':' || policy_row.polroles::text || ':'
                                   || coalesce(policy_row.polqual::text, '') || ':'
                                   || coalesce(policy_row.polwithcheck::text, ''),
                                   ',' order by policy_row.polname))
                        from pg_policy policy_row where policy_row.polrelid = class_row.oid), '')
    from pg_class class_row join pg_namespace namespace on namespace.oid = class_row.relnamespace
   where class_row.relkind in ('r', 'p')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
     and namespace.nspname not like 'pg_temp%';

-- 1a. Every switch of One-person lab (append-only; the newest row of a
-- facility decides, through identity.facility_lab_check_current).
create table identity.facility_lab_check_settings (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null,
  organization_id uuid not null,
  one_person boolean not null,
  reason text not null check (reason = btrim(reason, U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    and length(reason) between 10 and 500),
  set_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  set_by_membership_id uuid not null,
  set_at timestamptz not null default clock_timestamp(),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  constraint facility_lab_check_settings_facility_fk foreign key (facility_id, organization_id)
    references identity.facilities(id, organization_id) on delete restrict,
  constraint facility_lab_check_settings_member_fk foreign key (set_by_membership_id, facility_id, set_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id),
  constraint facility_lab_check_settings_id_facility_key unique (id, facility_id)
);
create index facility_lab_check_settings_facility_idx
  on identity.facility_lab_check_settings (facility_id, set_at desc, id desc);
alter table identity.facility_lab_check_settings enable row level security;
alter table identity.facility_lab_check_settings force row level security;
create policy facility_lab_check_settings_command_read on identity.facility_lab_check_settings
  for select using (true);
create policy facility_lab_check_settings_command_insert on identity.facility_lab_check_settings
  for insert with check (true);
create policy facility_lab_check_settings_command_update on identity.facility_lab_check_settings
  for update using (true) with check (true);
create policy facility_lab_check_settings_command_delete on identity.facility_lab_check_settings
  for delete using (true);
revoke all on identity.facility_lab_check_settings from public;
create trigger facility_lab_check_settings_no_mutation
  before update or delete on identity.facility_lab_check_settings
  for each row execute function platform.reject_mutation();
comment on table identity.facility_lab_check_settings is
  'Owner decision 33.3: each switch of One-person lab by a facility administrator (append-only). Only owner functions read or write it.';

-- 1b. The newest setting of each facility that ever switched. Updated by the
-- setter only; a self-check holds it FOR SHARE (see the header). Never
-- deleted.
create table identity.facility_lab_check_current (
  facility_id uuid primary key,
  setting_id uuid not null,
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  constraint facility_lab_check_current_setting_fk foreign key (setting_id, facility_id)
    references identity.facility_lab_check_settings(id, facility_id)
);
alter table identity.facility_lab_check_current enable row level security;
alter table identity.facility_lab_check_current force row level security;
create policy facility_lab_check_current_command_read on identity.facility_lab_check_current
  for select using (true);
create policy facility_lab_check_current_command_insert on identity.facility_lab_check_current
  for insert with check (true);
create policy facility_lab_check_current_command_update on identity.facility_lab_check_current
  for update using (true) with check (true);
create policy facility_lab_check_current_command_delete on identity.facility_lab_check_current
  for delete using (true);
revoke all on identity.facility_lab_check_current from public;
create trigger facility_lab_check_current_no_delete
  before delete on identity.facility_lab_check_current
  for each row execute function platform.reject_mutation();
comment on table identity.facility_lab_check_current is
  'Owner decision 33.3: the newest One-person lab setting of a facility. Only owner functions read or write it.';

-- The tables belong to the owner of schema identity (a no-op when the applier
-- is that owner).
do $$
declare
  owner_name text := (select pg_get_userbyid(namespace.nspowner) from pg_namespace namespace
                       where namespace.nspname = 'identity');
begin
  if (select pg_get_userbyid(class_row.relowner) from pg_class class_row
       where class_row.oid = 'identity.facility_lab_check_settings'::regclass) <> owner_name then
    execute format('alter table identity.facility_lab_check_settings owner to %I', owner_name);
    execute format('alter table identity.facility_lab_check_current owner to %I', owner_name);
  end if;
end
$$;

-- 1c. lab.result_verifications: the explicit self-check and the setting in
-- force. Existing rows are false/null.
alter table lab.result_verifications
  add column self_check boolean not null default false,
  add column one_person_setting_id uuid,
  add constraint result_verifications_one_person_setting_fk foreign key (one_person_setting_id, facility_id)
    references identity.facility_lab_check_settings(id, facility_id),
  add constraint result_verifications_self_check_ck check (
    self_check = (one_person_setting_id is not null)
    and (not self_check or length(btrim(reason, U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) between 10 and 500));
comment on column lab.result_verifications.self_check is
  'Owner decision 33.3: the person who entered this version checked it themselves, in a One-person lab, with the typed reason in reason.';
comment on column lab.result_verifications.one_person_setting_id is
  'Owner decision 33.3: the One-person lab setting in force for a self-check (set by the database, never by the client).';

-- 1d. The facility administrator switches One-person lab for the session
-- facility.
create function identity.set_facility_one_person_lab(requested_enabled boolean, requested_reason text)
returns table (enabled boolean, changed_at timestamptz, setting_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  reason text := btrim(coalesce(requested_reason, ''), U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  facility_row identity.facilities%rowtype;
  current_row identity.facility_lab_check_current%rowtype;
  previous boolean := false;
  inserted identity.facility_lab_check_settings%rowtype;
begin
  if actor_account is null
     or actor_membership is null
     or actor_facility is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not identity.has_active_membership(actor_subject, actor_membership, actor_facility)
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'organization.manage') then
    raise exception using errcode = '42501', message = 'FACILITY_SETTING_PERMISSION_DENIED';
  end if;
  if requested_enabled is null then
    raise exception using errcode = '22023', message = 'FACILITY_SETTING_INVALID';
  end if;
  if length(reason) not between 10 and 500 then
    raise exception using errcode = '22023', message = 'FACILITY_SETTING_REASON_INVALID';
  end if;
  select facility.* into facility_row from identity.facilities facility where facility.id = actor_facility;
  -- One setter at a time per facility (the first switch inserts the current
  -- row); under READ COMMITTED the reads below see the previous setter.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('one-person-lab:' || actor_facility::text, 0));
  -- Waits for any open self-check of this facility (it holds the row FOR SHARE).
  select current_state.* into current_row from identity.facility_lab_check_current current_state
   where current_state.facility_id = actor_facility
   for update;
  if current_row.facility_id is not null then
    select setting.one_person into previous from identity.facility_lab_check_settings setting
     where setting.id = current_row.setting_id and setting.facility_id = actor_facility;
  end if;
  if previous = requested_enabled then
    raise exception using errcode = 'P0001', message = 'FACILITY_SETTING_UNCHANGED';
  end if;
  insert into identity.facility_lab_check_settings as setting (facility_id, organization_id, one_person, reason,
    set_by_account_id, set_by_membership_id, correlation_id)
  values (facility_row.id, facility_row.organization_id, requested_enabled, reason, actor_account, actor_membership,
    platform.current_correlation_id())
  returning setting.* into inserted;
  if current_row.facility_id is null then
    insert into identity.facility_lab_check_current (facility_id, setting_id) values (facility_row.id, inserted.id);
  else
    update identity.facility_lab_check_current current_state
       set setting_id = inserted.id, row_version = current_state.row_version + 1, updated_at = inserted.set_at
     where current_state.facility_id = facility_row.id;
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', actor_subject, actor_account, actor_membership,
    facility_row.organization_id, facility_row.id,
    case when requested_enabled then 'identity.facility.one-person-lab.on' else 'identity.facility.one-person-lab.off' end,
    'success', 'facility', facility_row.id::text, 'healthcare-operations', reason, 'application', 'identity-api',
    jsonb_build_object('settingId', inserted.id, 'onePersonLab', requested_enabled, 'previous', previous)
  );
  return query select inserted.one_person, inserted.set_at, inserted.id;
end;
$$;

-- 1e. The facility administrator reads the switch of the session facility.
create function identity.facility_one_person_lab_state()
returns table (enabled boolean, changed_at timestamptz, changed_by_name text, reason text)
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
begin
  if auth.account_id_for_subject(platform.current_actor_subject()) is null
     or actor_membership is null
     or actor_facility is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not identity.has_active_membership(actor_subject, actor_membership, actor_facility)
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'organization.manage') then
    raise exception using errcode = '42501', message = 'FACILITY_SETTING_PERMISSION_DENIED';
  end if;
  return query
    select coalesce(setting.one_person, false), setting.set_at,
           case when setting.id is null then null else coalesce(account.display_name, staff.full_name) end,
           setting.reason
      from (select 1) single_row
      left join identity.facility_lab_check_current current_state on current_state.facility_id = actor_facility
      left join identity.facility_lab_check_settings setting
        on setting.id = current_state.setting_id and setting.facility_id = current_state.facility_id
      left join identity.staff_facility_memberships membership on membership.id = setting.set_by_membership_id
      left join identity.staff staff on staff.id = membership.staff_id
      left join auth.accounts account on account.id = setting.set_by_account_id;
end;
$$;

-- 1f. The Lab API reads its own facility's switch. One boolean about the
-- caller's own facility; false without an active membership there.
create function lab.one_person_lab_enabled()
returns boolean
language sql stable security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
  select coalesce((
    select setting.one_person
      from identity.facility_lab_check_current current_state
      join identity.facility_lab_check_settings setting
        on setting.id = current_state.setting_id and setting.facility_id = current_state.facility_id
     where current_state.facility_id = platform.current_facility_id()
       and platform.current_actor_subject() is not null
       and platform.current_membership_id() is not null
       and identity.has_active_membership(platform.current_actor_subject(), platform.current_membership_id(),
         platform.current_facility_id())), false)
$$;

do $$
declare
  owner_name text := (select pg_get_userbyid(namespace.nspowner) from pg_namespace namespace
                       where namespace.nspname = 'identity');
begin
  if (select pg_get_userbyid(proc.proowner) from pg_proc proc
       where proc.oid = 'identity.set_facility_one_person_lab(boolean,text)'::regprocedure) <> owner_name then
    execute format('alter function identity.set_facility_one_person_lab(boolean,text) owner to %I', owner_name);
    execute format('alter function identity.facility_one_person_lab_state() owner to %I', owner_name);
    execute format('alter function lab.one_person_lab_enabled() owner to %I', owner_name);
  end if;
end
$$;

-- 1g. Result governance. Only the verification branch after the actor check
-- changes (see the header); everything else is 0077's text.
create or replace function lab.validate_result_governance()
returns trigger language plpgsql security definer
set search_path = lab, platform, pg_temp as $$
declare head lab.results%rowtype; rev lab.result_revisions%rowtype; verifier uuid;
  session_facility uuid := platform.current_facility_id();
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
  one_person_setting uuid;
  one_person_on boolean;
begin
  select * into head from lab.results where id=new.result_id;
  select * into rev from lab.result_revisions where result_id=new.result_id and version=new.result_version;
  if head.id is null or rev.id is null or session_facility is null
     or head.execution_id is distinct from new.execution_id
     or head.patient_id is distinct from new.patient_id
     or head.facility_id is distinct from new.facility_id
     or head.current_version is distinct from new.result_version
     or new.facility_id is distinct from session_facility then
    raise exception using errcode='23514',message='Governance command must bind the exact current result version';
  end if;
  if tg_table_name='result_verifications' then
    if actor_account is null or actor_membership is null
       or new.verified_by is distinct from actor_account
       or new.verified_by_membership_id is distinct from actor_membership then
      raise exception using errcode='42501',message='Verifier must match authenticated database context';
    end if;
    if exists(select 1 from lab.result_invalidations i where i.result_id=new.result_id and i.result_version=new.result_version) then
      raise exception using errcode='23514',message='Result verifier must be independent and result must be eligible';
    end if;
    if rev.entered_by is not distinct from new.verified_by then
      -- The same person (owner decision 33.3): only an explicit self-check in
      -- a One-person lab. The facility's current setting is held FOR SHARE
      -- until commit, so a switch-off waits for this check, and a snapshot
      -- older than a committed switch-off fails 40001 here.
      select current_state.setting_id, setting.one_person into one_person_setting, one_person_on
        from identity.facility_lab_check_current current_state
        join identity.facility_lab_check_settings setting
          on setting.id = current_state.setting_id and setting.facility_id = current_state.facility_id
       where current_state.facility_id = new.facility_id
         for share of current_state;
      if not coalesce(new.self_check, false) then
        raise exception using errcode='23514',message=case when coalesce(one_person_on, false)
          then 'LAB_RESULT_SELF_CHECK_REASON_REQUIRED' else 'LAB_RESULT_SECOND_CHECK_REQUIRED' end;
      end if;
      if not coalesce(one_person_on, false) then
        raise exception using errcode='23514',message='LAB_RESULT_SECOND_CHECK_REQUIRED';
      end if;
      if new.reason is null
         or pg_catalog.length(pg_catalog.btrim(new.reason, U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) not between 10 and 500 then
        raise exception using errcode='22023',message='LAB_RESULT_SELF_CHECK_REASON_INVALID';
      end if;
      new.one_person_setting_id := one_person_setting;
    else
      if coalesce(new.self_check, false) then
        raise exception using errcode='23514',message='LAB_RESULT_SELF_CHECK_NOT_YOURS';
      end if;
      new.one_person_setting_id := null;
    end if;
  elsif tg_table_name='result_releases' then
    if actor_account is null or actor_membership is null
       or new.released_by is distinct from actor_account
       or new.released_by_membership_id is distinct from actor_membership then
      raise exception using errcode='42501',message='Release actor must match authenticated database context';
    end if;
    select verified_by into verifier from lab.result_verifications
     where id=new.verification_id and result_id=new.result_id and result_version=new.result_version;
    if verifier is null
       or exists(select 1 from lab.result_invalidations i where i.result_id=new.result_id and i.result_version=new.result_version) then
      raise exception using errcode='23514',message='Release requires exact valid verification';
    end if;
  else
    if actor_account is null or actor_membership is null
       or new.actor_id is distinct from actor_account
       or new.actor_membership_id is distinct from actor_membership then
      raise exception using errcode='42501',message='Invalidation actor must match authenticated database context';
    end if;
  end if;
  return new;
end
$$;

-- 1h. Grants (here and in runtime-grants.sql). The tables: no runtime role.
revoke all on function identity.set_facility_one_person_lab(boolean,text),
  identity.facility_one_person_lab_state(), lab.one_person_lab_enabled() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.set_facility_one_person_lab(boolean,text),
      identity.facility_one_person_lab_state() to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    grant execute on function lab.one_person_lab_enabled() to hid_lab_runtime;
  end if;
end
$$;

-- 1i. The sealed demo's switch (header 7): One-person lab ON at Demo
-- Laboratory only. Owner-only, granted to no role; called below on Amazon RDS
-- and by the suite lab-one-person-demo.
create function identity.demo_one_person_lab_install()
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  laboratory constant uuid := '98d00002-0000-4000-8000-000000000002';
  laboratory_organization constant uuid := '98d00001-0000-4000-8000-000000000002';
  staff_account constant uuid := '98d00003-0000-4000-8000-000000000001';
  lab_membership constant uuid := '98d00005-0000-4000-8000-000000000002';
  setting constant uuid := '98d0000b-0000-4000-8000-000000000001';
  demo_reason constant text := 'Demo Laboratory works as a one-person lab for the demo (owner decision, 3 Nov 2026).';
  demo_correlation constant text := '0111-sealed-demo-one-person-lab';
begin
  -- The setter's lock family: one switch of this facility at a time.
  perform pg_advisory_xact_lock(hashtextextended('one-person-lab:' || laboratory::text, 0));
  -- Every id is the sealed demo's as 0098 left it; else nothing is written.
  if not identity.sealed_demo_facility(laboratory)
     or not identity.sealed_demo_account(staff_account)
     or not exists (select 1 from identity.sealed_demo_members member
                     where member.member_kind = 'organization' and member.member_id = laboratory_organization)
     or not exists (select 1 from identity.facilities facility
                     where facility.id = laboratory and facility.organization_id = laboratory_organization
                       and upper(facility.code) = 'DEMO-LABORATORY')
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.id = lab_membership and membership.account_id = staff_account
                       and membership.facility_id = laboratory
                       and membership.organization_id = laboratory_organization) then
    raise exception using errcode = '55000', message = '0111: SEALED_DEMO_LAB_CHECK_NOT_DEMO';
  end if;
  -- Once: any setting of Demo Laboratory (this one, or a later switch by a
  -- tester or the owner) is kept.
  if exists (select 1 from identity.facility_lab_check_settings existing where existing.facility_id = laboratory)
     or exists (select 1 from identity.facility_lab_check_current existing where existing.facility_id = laboratory) then
    return jsonb_build_object('settings', 0);
  end if;
  insert into identity.facility_lab_check_settings (id, facility_id, organization_id, one_person, reason,
    set_by_account_id, set_by_membership_id, correlation_id)
  values (setting, laboratory, laboratory_organization, true, demo_reason, staff_account, lab_membership,
    demo_correlation);
  insert into identity.facility_lab_check_current (facility_id, setting_id) values (laboratory, setting);
  insert into audit.events (correlation_id, actor_type, organization_id, facility_id, action, outcome,
    resource_type, resource_id, reason, provenance, source_system, details)
  values (demo_correlation, 'system', laboratory_organization, laboratory, 'identity.facility.one-person-lab.on',
    'success', 'facility', laboratory::text, demo_reason, 'migration', 'hid-sealed-demo',
    jsonb_build_object('settingId', setting, 'onePersonLab', true, 'previous', false));
  return jsonb_build_object('settings', 1);
end;
$$;
do $$
declare
  owner_name text := (select pg_get_userbyid(namespace.nspowner) from pg_namespace namespace
                       where namespace.nspname = 'identity');
begin
  if (select pg_get_userbyid(proc.proowner) from pg_proc proc
       where proc.oid = 'identity.demo_one_person_lab_install()'::regprocedure) <> owner_name then
    execute format('alter function identity.demo_one_person_lab_install() owner to %I', owner_name);
  end if;
end
$$;
revoke all on function identity.demo_one_person_lab_install() from public;
comment on function identity.demo_one_person_lab_install() is
  '0111: switches One-person lab ON at the sealed demo''s Demo Laboratory only (owner decision, 3 Nov 2026): one setting row, its current row and one migration audit row (actor system, provenance migration, hid-sealed-demo, 0111-sealed-demo-one-person-lab). Demo ids only (55000 otherwise); a second call, or any existing setting of Demo Laboratory, writes nothing.';

-- 2. Post-checks.
do $$
declare
  mismatch text;
  owner_oid oid := (select namespace.nspowner from pg_namespace namespace where namespace.nspname = 'identity');
begin
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'lab.validate_result_governance()'::regprocedure)
       is distinct from '998df11ada9a2260109850e776520946' then
    mismatch := 'the body of lab.validate_result_governance()';
  end if;
  if mismatch is null and not exists (
       select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid = 'lab.validate_result_governance()'::regprocedure
          and language_row.lanname = 'plpgsql' and proc.prosecdef and not proc.proisstrict
          and proc.provolatile = 'v' and proc.proconfig = '{"search_path=lab, platform, pg_temp"}'::text[]) then
    mismatch := 'the attributes of lab.validate_result_governance()';
  end if;
  if mismatch is null and (select count(*) from pg_trigger trigger_row
       where trigger_row.tgfoid = 'lab.validate_result_governance()'::regprocedure
         and trigger_row.tgenabled = 'O' and not trigger_row.tgisinternal) <> 3 then
    mismatch := 'the three governance triggers';
  end if;
  -- The governance function's owner and ACL, and every table that existed
  -- before: row-level security, FORCE and policies unchanged.
  if mismatch is null then
    select string_agg(before_row.kind || ' ' || before_row.name, ', ') into mismatch
      from lab_one_person_0111_before before_row
     where before_row.state is distinct from (
       case before_row.kind
         when 'function' then (select proc.proowner::text || ' ' || coalesce(proc.proacl::text, '') from pg_proc proc
                                where proc.oid = to_regprocedure(before_row.name))
         else (select class_row.relrowsecurity::text || ' ' || class_row.relforcerowsecurity::text || ' '
                 || coalesce((select md5(string_agg(policy_row.polname || ':' || policy_row.polcmd::text || ':'
                                   || policy_row.polpermissive::text || ':' || policy_row.polroles::text || ':'
                                   || coalesce(policy_row.polqual::text, '') || ':'
                                   || coalesce(policy_row.polwithcheck::text, ''),
                                   ',' order by policy_row.polname))
                                from pg_policy policy_row where policy_row.polrelid = class_row.oid), '')
                 from pg_class class_row where class_row.oid = to_regclass(before_row.name))
       end);
    if mismatch is not null then mismatch := 'changed: ' || mismatch; end if;
  end if;
  -- The new objects: the identity owner's; tables granted to no one;
  -- functions SECURITY DEFINER with their search paths and EXECUTE only for
  -- their runtime (and the owner). A function's NULL ACL is the default one
  -- (PUBLIC EXECUTE), so it is read as acldefault and fails.
  if mismatch is null and exists (
       select 1 from pg_class class_row
        where class_row.oid in ('identity.facility_lab_check_settings'::regclass,
                                'identity.facility_lab_check_current'::regclass)
          and (class_row.relowner <> owner_oid or not class_row.relrowsecurity or not class_row.relforcerowsecurity
               or exists (select 1 from aclexplode(class_row.relacl) acl where acl.grantee <> class_row.relowner))) then
    mismatch := 'the owner, row-level security or privileges of a new table';
  end if;
  if mismatch is null and (select count(*) from pg_proc proc
       where proc.proowner = owner_oid and proc.prosecdef and not proc.proisstrict
         and ((proc.oid = 'identity.set_facility_one_person_lab(boolean,text)'::regprocedure and proc.provolatile = 'v'
               and proc.proconfig = '{"search_path=pg_catalog, identity, auth, audit, platform, pg_temp"}'::text[])
           or (proc.oid = 'identity.facility_one_person_lab_state()'::regprocedure and proc.provolatile = 's'
               and proc.proconfig = '{"search_path=pg_catalog, identity, auth, audit, platform, pg_temp"}'::text[])
           or (proc.oid = 'lab.one_person_lab_enabled()'::regprocedure and proc.provolatile = 's'
               and proc.proconfig = '{"search_path=pg_catalog, identity, platform, pg_temp"}'::text[]))
         and not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                          where acl.grantee <> proc.proowner
                            and acl.grantee not in (select role_row.oid from pg_roles role_row
                              where role_row.rolname = case when proc.proname = 'one_person_lab_enabled'
                                then 'hid_lab_runtime' else 'hid_identity_runtime' end))) <> 3 then
    mismatch := 'the owner, attributes or EXECUTE of a new function';
  end if;
  if mismatch is null and not exists (
       select 1 from pg_proc proc
        where proc.oid = 'identity.demo_one_person_lab_install()'::regprocedure
          and proc.proowner = owner_oid and proc.prosecdef and proc.provolatile = 'v'
          and proc.proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[]
          and not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                           where acl.grantee <> proc.proowner)) then
    mismatch := 'the owner, attributes or EXECUTE of identity.demo_one_person_lab_install()';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0111: post-check failed: %s', mismatch);
  end if;
end;
$$;

-- 3. The demo seed (header 7), on Amazon RDS only, where 0098 seeded the
-- sealed demo. A refusal raises 55000 and the release stops with nothing
-- applied.
do $$
declare summary jsonb;
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'rds_superuser') then
    summary := identity.demo_one_person_lab_install();
    raise notice '0111: One-person lab at Demo Laboratory: %', summary::text;
  else
    raise notice '0111: not an Amazon RDS database; One-person lab is not switched on at Demo Laboratory (the function is installed)';
  end if;
end
$$;
