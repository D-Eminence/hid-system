-- 0151 QA-2: a fictional front-desk login and a fictional nurse login at QA
-- Hospital, sealed QA only. Written on claude/q141b-doctors-readings-qa-desk
-- at a093c199 (staging-novu-ci-20261005 at d519e5d1, that is 0001-0149
-- applied: Release A, Release B and Release C, live since 24 November 2026
-- 19:47 UTC, plus 0150, Q141 B, in the same pull request, hid-system#330).
-- Numbers are given at merge. The declaration in
-- config/production-schema-compatibility.json is signed separately: its
-- reviewed_by stays as it is until the owner signs this file.
--
-- Owner decision (D-Eminence, 24 November 2026), verbatim:
--   "Q141 B and add front-desk or nurse login"
-- then, asked whether frontdesk@healthidentitydirectory.com and
-- nurse@healthidentitydirectory.com both receive mail:
--   "yes both receive mail"
-- then:
--   "go ahead"
-- 0150 is the "Q141 B" part. This file is the "add front-desk or nurse login"
-- part, both of them (QA-2, after 0134's QA-1): today no QA login is a
-- receptionist or a nurse, and a QA facility administrator cannot invite a new
-- login (0123 D9: the invited account would be real, and the seal refuses a
-- real account at a QA facility), so only a migration can add them.
--
-- What it does, seeded exactly as 0123 seeded its seven staff logins (0123's
-- sealed_qa_install, section 10), at QA Hospital only:
-- E1 identity.sealed_qa_members   two QA accounts (member_kind 'account'),
--                                 first, so that 0123's seal sees them;
-- E2 auth.accounts                two fictional logins, pending_reset, no
--                                 password (no password or hash is in this
--                                 file), the email verified, source_system
--                                 hid-sealed-qa, subject sealed-qa:<id>:
--      frontdesk@healthidentitydirectory.com "QA Front Desk"
--        account c0a00003-0000-4000-8000-000000000008;
--      nurse@healthidentitydirectory.com "QA Nurse"
--        account c0a00003-0000-4000-8000-000000000009;
-- E3 identity.staff               one verified, active staff record each
--                                 (c0a00004-...0008 and ...0009), the same
--                                 name and address, default_role receptionist
--                                 and nurse;
-- E4 identity.staff_facility_memberships  one membership each, at QA Hospital
--                                 (organization c0a00001-...0001, facility
--                                 c0a00002-...0001), primary, active:
--                                 receptionist c0a00005-...0081 and nurse
--                                 c0a00005-...0091 (membership_role and
--                                 app_role the role, as 0123's);
-- E5 auth.account_roles           one facility role per membership, with the
--                                 membership's id (0123's rule): receptionist
--                                 and nurse, grant_reason "Sealed QA tenant:
--                                 QA Hospital front desk and nurse (0151,
--                                 owner decision Q141)";
-- E6 audit.events                 one row per login, as the system actor:
--                                 identity.sealed-qa.staff-login-add,
--                                 resource staff-membership, the membership
--                                 id, facility QA Hospital, details the
--                                 membership id, the role, the migration and
--                                 the decision; no account, address, name,
--                                 organization or patient.
-- What each login can do is what its role already gives every receptionist
-- and nurse (nothing here changes a role): receptionist as 0136 C1 leaves it
-- (17 codes: ehr.document.read-own, ehr.document.write, ehr.encounter.read,
-- ehr.encounter.write, ehr.vital.read, identity.authorization.check,
-- identity.consent.read, identity.consent.write, identity.patient.read,
-- identity.registration.write, ocr.job.read-own, ocr.job.start,
-- ocr.job.write, outreach.campaign.read, outreach.campaign.write,
-- outreach.registration.read, outreach.registration.write) and nurse as
-- Release C and 0150 leave it (38 codes, md5 pinned below). Both sign in on
-- ehr. (and migrate.), like every hospital role (section 53 of the contract).
--
-- Where: only where 0123 installed the sealed QA tenant, that is where QA
-- Hospital is a QA facility (0123 section 10 seeds it on Amazon RDS only,
-- where rds_superuser exists: production and staging). On every other
-- database (CI, acceptance, the staging upgrade rehearsal, throwaway
-- clusters) nothing is written, not even an audit row, and a NOTICE says so.
--
-- The seal (0123, unchanged): both accounts are QA members, so 0123's G2q
-- refuses them a membership at any real or demo facility (42501
-- SEALED_QA_MEMBERSHIP_REFUSED) and G3q any platform role (42501
-- SEALED_QA_PLATFORM_ROLE_REFUSED); identity.patients' registration read lets
-- a QA facility read QA patients only; every other place 0123 seals applies
-- to them as to its seven logins. They never reach a real or demo facility,
-- patient or person.
--
-- Activation (as 0123's logins): the owner sets each password through the
-- mailbox. On the EHR sign-in page (ehr.healthidentitydirectory.com; on
-- staging ehr.staging.healthidentitydirectory.com) choose Forgot password,
-- enter the address, enter the code from the reset email that arrives in that
-- mailbox and choose a password; then sign in and pick QA Hospital. The live
-- recovery hold (24 hours before patient approvals, new shares, the PIN,
-- emergency contacts or invitations) applies as for any login.
--
-- Refusals (55000, nothing written, the release stops):
--   0151: SEALED_QA_ADDRESS_TAKEN  an address belongs to an account (not
--     deleted) or a staff record other than this file's, is the first
--     administrator of an open organization application (pending_verification
--     or ready_for_review) or the invitee of a pending staff invitation not
--     yet expired, any case (0123's rule, word for word). Before signing, the
--     owner may run, read-only, on production (each of the four counts must
--     be 0 for both addresses):
--       with addresses(email) as (values ('frontdesk@healthidentitydirectory.com'),
--                                        ('nurse@healthidentitydirectory.com'))
--       select x.email,
--              (select count(*) from auth.accounts a where lower(a.email) = x.email
--                and a.status <> 'deleted') as accounts,
--              (select count(*) from identity.staff s where lower(s.email) = x.email) as staff,
--              (select count(*) from identity.organization_applications o
--                where lower(o.administrator_email) = x.email
--                  and o.status in ('pending_verification', 'ready_for_review')) as open_applications,
--              (select count(*) from identity.staff_invitations i where lower(i.invitee_email) = x.email
--                and i.status = 'pending' and i.expires_at > clock_timestamp()) as pending_invitations
--         from addresses x order by x.email;
--   0151: SEALED_QA_ID_TAKEN  a fixed id of this file is held by a row that
--     is not exactly this file's (when they are all exactly this file's:
--     "0151: already applied").
--
-- Locks, taken first, NOWAIT: ROW EXCLUSIVE on the six tables it writes
-- (identity.sealed_qa_members, auth.accounts, identity.staff,
-- identity.staff_facility_memberships, auth.account_roles, audit.events);
-- SHARE on identity.staff_invitations and identity.organization_applications
-- (other writers wait, every reader goes on), so no invitation or
-- application can name either address between the check and commit, and on
-- auth.role_permissions, so the two roles' pinned codes cannot change before
-- commit (accounts and staff records cannot take an address meanwhile: their
-- unique indexes on lower(email) stop a second one); ROW SHARE on the tables
-- the new rows' foreign keys and 0123's and 0098's triggers check
-- (auth.roles, identity.organizations, identity.facilities,
-- identity.patients, identity.outreach_organisations) and ACCESS SHARE on
-- identity.sealed_demo_members (0123's demo-overlap trigger reads it); and
-- 0123's sealed QA install lock (the transaction advisory lock
-- hid-sealed-qa-install, tried, not waited for). The same locks are taken on
-- a database without the QA tenant, where nothing is written. That is every
-- existing table this file locks, at the strongest mode it takes (pg_locks
-- before commit; the suite compares them). Besides tables it locks only
-- indexes (ACCESS SHARE for planning, ROW EXCLUSIVE for the new rows'
-- entries) and, where it writes, audit.events' identity sequence; the
-- preconditions read the catalog at ACCESS SHARE. A busy table, or the
-- install lock held by another session, fails the attempt at once, and its
-- subtransaction releases every lock the attempt took. The attempt is made
-- 50 times, 100 ms apart (about 5 seconds), so the file never waits for one
-- of its locks while holding the others; then 55P03, nothing applied. When
-- this transaction already holds an earlier migration's locks that stop
-- other sessions' reads or writes (the runner's dry run applies every
-- pending file in one transaction, 0150 among them), one attempt and no
-- sleep: 55P03 at once, nothing applied. Both refusals begin "0151: " and end
-- "run the release again at a quieter time", so the runner's dry run rolls
-- back and tries again (hid-system#306). Other waits are not NOWAIT, and the
-- runner's lock_timeout ends each after 5 seconds (55P03 lock timeout: not a
-- busy refusal, so not retried; nothing applied): a row of a referenced table
-- another session holds FOR UPDATE, DDL in flight on audit.events' identity
-- sequence, or an index or catalog that maintenance holds.
--
-- No function, policy, grant, role or table changes, so runtime-grants.sql
-- is unchanged. Old services are unaffected: two more QA logins.
--
-- Undo (not in the ledger; a migration only if the owner signs it): set both
-- accounts' status to disabled, so that neither can sign in; their rows stay
-- for the record, as every login's do.
--
-- The whole file is one statement (do $qa2$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while one is busy).
-- 1. Preconditions (55000, or 42501 for ownership; nothing applied):
--    a. 0001-0150 applied (0134's install function, 0147's two roles,
--       0148's and 0149's tables, 0150's row doctor/ocr.job.start);
--    b. not applied yet ("0151: already applied" when every fixed id is
--       exactly this file's; SEALED_QA_ID_TAKEN when any is held otherwise);
--    c. every column it writes or reads, by name and type;
--    d. 0123's helpers and seal triggers it relies on, byte for byte (md5 of
--       pg_proc.prosrc: identity.sealed_qa_facility, sealed_qa_account,
--       sealed_qa_recipient, sealed_qa_members_not_demo,
--       staff_memberships_sealed_qa, account_roles_sealed_qa), and 0098's two
--       it relies on beside them (staff_memberships_sealed_demo,
--       account_roles_sealed_demo); each of those five triggers present,
--       enabled, on its table, calling its function; both addresses are
--       addresses of the owner's domain (identity.sealed_qa_recipient);
--    e. roles receptionist and nurse active, with exactly the pinned codes;
--    f. one owner (identity.sealed_qa_members') owns the six tables written
--       and 0123's helpers; the applier is that owner, or inherits it and may
--       SET ROLE to it (42501 otherwise); the rows are written as that owner.
-- 2. Where the QA tenant is installed: SEALED_QA_ADDRESS_TAKEN, then E1-E6;
--    elsewhere a NOTICE and nothing.
-- 3. Post-checks: where installed, exactly E1-E6 (each login one membership,
--    one role, no platform role, a QA account; the two roles' codes
--    unchanged; two audit rows); elsewhere no fixed id and no audit row.

do $qa2$
declare
  attempt integer := 0;
  holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  qa_hospital_organization constant uuid := 'c0a00001-0000-4000-8000-000000000001';
  qa_hospital constant uuid := 'c0a00002-0000-4000-8000-000000000001';
  role_reason constant text := 'Sealed QA tenant: QA Hospital front desk and nurse (0151, owner decision Q141)';
  audit_reason constant text := 'Owner decision Q141 (24 November 2026): a front-desk and a nurse login at QA Hospital, sealed QA only';
  correlation constant text := '0151-sealed-qa-front-desk-nurse';
  logins constant jsonb := '[
    {"account": "c0a00003-0000-4000-8000-000000000008", "staff": "c0a00004-0000-4000-8000-000000000008",
     "membership": "c0a00005-0000-4000-8000-000000000081",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-000000000008",
     "email": "frontdesk@healthidentitydirectory.com", "name": "QA Front Desk", "role": "receptionist"},
    {"account": "c0a00003-0000-4000-8000-000000000009", "staff": "c0a00004-0000-4000-8000-000000000009",
     "membership": "c0a00005-0000-4000-8000-000000000091",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-000000000009",
     "email": "nurse@healthidentitydirectory.com", "name": "QA Nurse", "role": "nurse"}]';
  -- The two roles' codes as Release C and 0150 leave them: md5 of the codes in
  -- byte order (collate "C"), joined by ','.
  receptionist_md5 constant text := 'a06d876a6f2e1bbd524ed89e59acd110';
  nurse_md5 constant text := '1cf6eca65a5ea51b817db099e32a0ef2';
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
  saved_role text;
  installed boolean;
  exact integer;
  held integer;
  step bigint;
  written integer := 0;
begin
  loop
  attempt := attempt + 1;
  begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  lock table identity.sealed_qa_members, auth.accounts, identity.staff, identity.staff_facility_memberships,
             auth.account_roles, audit.events
    in row exclusive mode nowait;
  lock table identity.staff_invitations, identity.organization_applications, auth.role_permissions
    in share mode nowait;
  lock table auth.roles, identity.organizations, identity.facilities, identity.patients,
             identity.outreach_organisations
    in row share mode nowait;
  lock table identity.sealed_demo_members
    in access share mode nowait;
  if not pg_try_advisory_xact_lock(hashtextextended('hid-sealed-qa-install', 0)) then
    raise exception using errcode = '55P03', message = '0151: the sealed QA install lock is held';
  end if;
  exit;

  exception when lock_not_available then
    -- Only these NOWAIT locks are in the attempt, so only they are retried.
    if holding then
      raise exception using errcode = '55P03',
        message = '0151: a table 0151 writes or checks (the sealed QA members, accounts, staff records, staff '
          || 'memberships, account roles, audit events, staff invitations, organization applications, the role '
          || 'table and the tables their keys reference) or the sealed QA install lock is busy, and this '
          || 'transaction already holds an earlier migration''s locks, so it does not wait; nothing applied; run '
          || 'the release again at a quieter time';
    end if;
    if attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0151: a table 0151 writes or checks (the sealed QA members, accounts, staff records, staff '
          || 'memberships, account roles, audit events, staff invitations, organization applications, the role '
          || 'table and the tables their keys reference) or the sealed QA install lock stayed busy for 5 seconds; '
          || 'nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- a. 0001-0150 applied.
  if to_regprocedure('identity.sealed_qa_hospital_work_staff_install()') is null
     or to_regprocedure('identity.sealed_qa_install()') is null
     or not exists (select 1 from auth.roles where code = 'reading_starter')
     or not exists (select 1 from auth.roles where code = 'work_list_reader')
     or to_regclass('pharmacy.prescription_changes_after_dispensing') is null
     or to_regclass('ehr.catalog_versions') is null
     or not exists (select 1 from auth.role_permissions
                     where role_code = 'doctor' and permission_code = 'ocr.job.start') then
    raise exception using errcode = '55000', message = '0151: 0001-0150 must be applied first';
  end if;

  -- c. Every column it writes or reads, by name and type.
  with expected(schema_name, relation_name, column_names) as (values
         ('identity', 'sealed_qa_members', array['member_kind text', 'member_id uuid']),
         ('identity', 'organizations', array['id uuid']),
         ('identity', 'facilities', array['id uuid', 'organization_id uuid']),
         ('auth', 'accounts', array['id uuid', 'subject text', 'email text', 'display_name text', 'status text',
           'email_verified_at timestamp with time zone', 'source_system text', 'password_hash text']),
         ('identity', 'staff', array['id uuid', 'account_id uuid', 'full_name text', 'email text',
           'verification_status text', 'default_role text', 'active boolean', 'source_system text']),
         ('identity', 'staff_facility_memberships', array['id uuid', 'staff_id uuid', 'account_id uuid',
           'organization_id uuid', 'facility_id uuid', 'membership_role text', 'app_role text', 'is_primary boolean',
           'active boolean', 'source_system text']),
         ('auth', 'account_roles', array['id uuid', 'account_id uuid', 'role_code text', 'scope_type text',
           'membership_id uuid', 'facility_id uuid', 'grant_reason text', 'revoked_at timestamp with time zone']),
         ('auth', 'role_permissions', array['role_code text', 'permission_code text']),
         ('auth', 'roles', array['code text', 'active boolean']),
         ('identity', 'organization_applications', array['administrator_email text', 'status text']),
         ('identity', 'staff_invitations', array['invitee_email text', 'status text',
           'expires_at timestamp with time zone']),
         ('audit', 'events', array['correlation_id text', 'actor_type text', 'facility_id uuid', 'action text',
           'outcome text', 'resource_type text', 'resource_id text', 'purpose_of_use text', 'reason text',
           'provenance text', 'source_system text', 'details jsonb'])),
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
      message = format('0151: a column this migration relies on is missing or of another type: %s', missing);
  end if;

  -- d. 0123's helpers and seal triggers, and 0098's two beside them, byte for
  -- byte; the five triggers in place and enabled.
  with expected(signature, digest) as (values
         ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
         ('identity.sealed_qa_account(uuid)', '2c19c76bff02b394097724f99e09fc9d'),
         ('identity.sealed_qa_recipient(text)', '7bb9434e607271d72c1e02f0961bce13'),
         ('identity.sealed_qa_members_not_demo()', 'b306df4f70f9d207467cedbf75a5c7aa'),
         ('identity.staff_memberships_sealed_qa()', '4c00d810e3be5d047b55c6d90573527f'),
         ('identity.account_roles_sealed_qa()', '6a95d1dd699daca074d901decd68d138'),
         ('identity.staff_memberships_sealed_demo()', 'cf5745fe353d90ce79b095983085266c'),
         ('identity.account_roles_sealed_demo()', 'f852b9f89d084a99f7489d9427a779fc')),
       differing as (
         select expected.signature from expected
          where to_regprocedure(expected.signature) is null
             or not exists (select 1 from pg_proc proc
                             where proc.oid = to_regprocedure(expected.signature)
                               and md5(proc.prosrc) = expected.digest))
  select exists (select 1 from differing), (select string_agg(differing.signature, ', ') from differing)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0151: these functions differ from 0123''s (and 0098''s) or are missing: %s', missing);
  end if;
  select string_agg(expected.trigger_name, ', ' order by expected.trigger_name) into missing
    from (values ('identity.sealed_qa_members', 'sealed_qa_members_not_demo', 'identity.sealed_qa_members_not_demo()'),
                 ('identity.staff_facility_memberships', 'staff_memberships_sealed_qa',
                  'identity.staff_memberships_sealed_qa()'),
                 ('identity.staff_facility_memberships', 'staff_memberships_sealed_demo',
                  'identity.staff_memberships_sealed_demo()'),
                 ('auth.account_roles', 'account_roles_sealed_qa', 'identity.account_roles_sealed_qa()'),
                 ('auth.account_roles', 'account_roles_sealed_demo', 'identity.account_roles_sealed_demo()'))
           expected(table_name, trigger_name, function_signature)
   where not exists (select 1 from pg_trigger trigger_row
                      where trigger_row.tgrelid = to_regclass(expected.table_name)
                        and trigger_row.tgname = expected.trigger_name and not trigger_row.tgisinternal
                        and trigger_row.tgenabled = 'O'
                        and trigger_row.tgfoid = to_regprocedure(expected.function_signature));
  if missing is not null then
    raise exception using errcode = '55000',
      message = '0151: these seal triggers are missing, disabled or call another function: ' || missing;
  end if;
  if exists (select 1 from jsonb_to_recordset(logins) login(email text)
              where not identity.sealed_qa_recipient(login.email)) then
    raise exception using errcode = '55000', message = '0151: an address is not of the owner''s domain';
  end if;

  -- e. The two roles, active, with exactly the pinned codes.
  if (select count(*) from auth.roles role_row
       where role_row.code in ('receptionist', 'nurse') and role_row.active) <> 2
     or (select md5(string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C"))
           from auth.role_permissions grant_row where grant_row.role_code = 'receptionist')
        is distinct from receptionist_md5
     or (select md5(string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C"))
           from auth.role_permissions grant_row where grant_row.role_code = 'nurse')
        is distinct from nurse_md5 then
    raise exception using errcode = '55000',
      message = '0151: the receptionist or nurse role is inactive or its codes differ from Release C and 0150; '
        || 'nothing applied';
  end if;

  -- f. One owner, and an applier that is it or may act as it.
  owner_oid := (select relation.relowner from pg_class relation
                 where relation.oid = 'identity.sealed_qa_members'::regclass);
  with foreign_owned as (
         select expected.table_name as what
           from (values ('auth.accounts'), ('identity.staff'), ('identity.staff_facility_memberships'),
                        ('auth.account_roles'), ('audit.events')) expected(table_name)
          where not exists (select 1 from pg_class relation
                             where relation.oid = to_regclass(expected.table_name) and relation.relowner = owner_oid)
         union all
         select expected.signature
           from (values ('identity.sealed_qa_facility(uuid)'), ('identity.sealed_qa_account(uuid)'),
                        ('identity.sealed_qa_install()')) expected(signature)
          where not exists (select 1 from pg_proc proc
                             where proc.oid = to_regprocedure(expected.signature) and proc.proowner = owner_oid))
  select exists (select 1 from foreign_owned), (select string_agg(foreign_owned.what, ', ') from foreign_owned)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501',
      message = format('0151: these are not owned by %s, the owner of identity.sealed_qa_members: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), missing);
  end if;
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0151: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of '
        || 'identity.sealed_qa_members and 0123''s sealed QA install', current_user, pg_get_userbyid(owner_oid));
  end if;

  -- b. Not applied yet: no fixed id of this file is held. All of them exactly
  -- this file's: already applied. Any other holder: refused.
  select count(*) into held
    from jsonb_to_recordset(logins) login(account uuid, staff uuid, membership uuid)
   where exists (select 1 from auth.accounts account where account.id = login.account)
      or identity.sealed_qa_account(login.account)
      or exists (select 1 from identity.staff staff_row where staff_row.id = login.staff)
      or exists (select 1 from identity.staff_facility_memberships membership where membership.id = login.membership)
      or exists (select 1 from auth.account_roles assignment where assignment.id = login.membership);
  select count(*) into exact
    from jsonb_to_recordset(logins) login(account uuid, staff uuid, membership uuid, subject text, email text,
           role text)
    join auth.accounts account on account.id = login.account and account.subject = login.subject
     and lower(account.email) = login.email and account.status <> 'deleted'
    join identity.staff staff_row on staff_row.id = login.staff and staff_row.account_id = login.account
    join identity.staff_facility_memberships membership on membership.id = login.membership
     and membership.staff_id = login.staff and membership.account_id = login.account
     and membership.organization_id = qa_hospital_organization and membership.facility_id = qa_hospital
     and membership.membership_role = login.role
    join auth.account_roles assignment on assignment.id = login.membership and assignment.account_id = login.account
     and assignment.membership_id = login.membership and assignment.facility_id = qa_hospital
     and assignment.scope_type = 'facility' and assignment.role_code = login.role
   where identity.sealed_qa_account(login.account);
  if held > 0 then
    if exact = 2 and (select count(*) from audit.events event_row where event_row.correlation_id = correlation) = 2 then
      raise exception using errcode = '55000', message = '0151: already applied';
    end if;
    raise exception using errcode = '55000', message = '0151: SEALED_QA_ID_TAKEN';
  end if;

  installed := exists (select 1 from identity.facilities facility
                        where facility.id = qa_hospital and facility.organization_id = qa_hospital_organization)
               and identity.sealed_qa_facility(qa_hospital);

  -- 2. The logins, where the QA tenant is installed.
  if not installed then
    raise notice '0151: the sealed QA tenant is not installed here (QA Hospital is not a QA facility): nothing written';
  else
    -- An address held elsewhere (0123's rule).
    if exists (select 1 from auth.accounts account
                 join jsonb_to_recordset(logins) login(account uuid, email text) on lower(account.email) = login.email
                where account.status <> 'deleted' and account.id <> login.account)
       or exists (select 1 from identity.staff staff_row
                    join jsonb_to_recordset(logins) login(staff uuid, email text) on lower(staff_row.email) = login.email
                   where staff_row.id is distinct from login.staff)
       or exists (select 1 from identity.organization_applications application
                    join jsonb_to_recordset(logins) login(email text)
                      on lower(application.administrator_email) = login.email
                   where application.status in ('pending_verification', 'ready_for_review'))
       or exists (select 1 from identity.staff_invitations invitation
                    join jsonb_to_recordset(logins) login(email text) on lower(invitation.invitee_email) = login.email
                   where invitation.status = 'pending' and invitation.expires_at > clock_timestamp()) then
      raise exception using errcode = '55000', message = '0151: SEALED_QA_ADDRESS_TAKEN';
    end if;

    -- As the owner of identity.sealed_qa_members (its policy admits only its
    -- owner); the applier's role is set back below.
    saved_role := current_setting('role');
    if applier <> owner_oid then
      execute format('set local role %I', pg_get_userbyid(owner_oid));
    end if;

    -- Members first, so that the seal sees them; then the rows (0123's order).
    insert into identity.sealed_qa_members (member_kind, member_id)
    select 'account', login.account from jsonb_to_recordset(logins) login(account uuid);
    get diagnostics step = row_count; written := written + step;

    insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system)
    select login.account, login.subject, login.email, login.name, 'pending_reset', clock_timestamp(), 'hid-sealed-qa'
      from jsonb_to_recordset(logins) login(account uuid, subject text, email text, name text);
    get diagnostics step = row_count; written := written + step;

    insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active,
      source_system)
    select login.staff, login.account, login.name, login.email, 'verified', login.role, true, 'hid-sealed-qa'
      from jsonb_to_recordset(logins) login(account uuid, staff uuid, email text, name text, role text);
    get diagnostics step = row_count; written := written + step;

    insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active, source_system)
    select login.membership, login.staff, login.account, qa_hospital_organization, qa_hospital, login.role, login.role,
           true, true, 'hid-sealed-qa'
      from jsonb_to_recordset(logins) login(account uuid, staff uuid, membership uuid, role text);
    get diagnostics step = row_count; written := written + step;

    -- One facility role per membership, with the membership's id.
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    select login.membership, login.account, login.role, 'facility', login.membership, qa_hospital, role_reason
      from jsonb_to_recordset(logins) login(account uuid, membership uuid, role text);
    get diagnostics step = row_count; written := written + step;

    -- One audit row per login: the membership and the facility only.
    insert into audit.events (correlation_id, actor_type, facility_id, action, outcome, resource_type, resource_id,
      purpose_of_use, reason, provenance, source_system, details)
    select correlation, 'system', qa_hospital, 'identity.sealed-qa.staff-login-add', 'success', 'staff-membership',
           login.membership::text, 'healthcare-operations', audit_reason, 'migration', 'hid-sealed-qa',
           jsonb_build_object('membershipId', login.membership, 'roleCode', login.role, 'migration', '0151',
             'decision', 'Q141 (QA-2)')
      from jsonb_to_recordset(logins) login(membership uuid, role text);
    get diagnostics step = row_count; written := written + step;

    perform set_config('role', saved_role, true);
  end if;

  -- 3. Post-checks.
  if installed then
    if written <> 12
       or (select count(*)
             from jsonb_to_recordset(logins) login(account uuid, staff uuid, membership uuid, subject text, email text,
                    name text, role text)
             join auth.accounts account on account.id = login.account and account.subject = login.subject
              and account.email = login.email and account.display_name = login.name
              and account.status = 'pending_reset' and account.password_hash is null
              and account.email_verified_at is not null and account.source_system = 'hid-sealed-qa'
             join identity.staff staff_row on staff_row.id = login.staff and staff_row.account_id = login.account
              and staff_row.email = login.email and staff_row.full_name = login.name
              and staff_row.verification_status = 'verified' and staff_row.active
              and staff_row.default_role = login.role
            where identity.sealed_qa_account(login.account)
              -- Exactly one membership, at QA Hospital, in this role.
              and (select count(*) from identity.staff_facility_memberships membership
                    where membership.account_id = login.account) = 1
              and exists (select 1 from identity.staff_facility_memberships membership
                           where membership.id = login.membership and membership.account_id = login.account
                             and membership.staff_id = login.staff
                             and membership.organization_id = qa_hospital_organization
                             and membership.facility_id = qa_hospital and membership.membership_role = login.role
                             and membership.app_role = login.role and membership.is_primary and membership.active)
              -- Exactly one role, at that membership; no platform role.
              and (select count(*) from auth.account_roles assignment where assignment.account_id = login.account) = 1
              and exists (select 1 from auth.account_roles assignment
                           where assignment.id = login.membership and assignment.account_id = login.account
                             and assignment.membership_id = login.membership and assignment.facility_id = qa_hospital
                             and assignment.scope_type = 'facility' and assignment.role_code = login.role
                             and assignment.revoked_at is null)
              -- No other live account or staff record holds the address.
              and (select count(*) from auth.accounts other
                    where lower(other.email) = login.email and other.status <> 'deleted') = 1
              and (select count(*) from identity.staff other where lower(other.email) = login.email) = 1) <> 2
       or (select count(*) from audit.events event_row
            where event_row.correlation_id = correlation and event_row.actor_type = 'system'
              and event_row.facility_id = qa_hospital and event_row.organization_id is null
              and event_row.patient_id is null and event_row.actor_account_id is null
              and event_row.actor_membership_id is null
              and event_row.resource_id in ('c0a00005-0000-4000-8000-000000000081',
                                            'c0a00005-0000-4000-8000-000000000091')) <> 2
       or (select count(*) from audit.events event_row where event_row.correlation_id = correlation) <> 2 then
      raise exception using errcode = '55000', message = '0151: post-check failed: the two logins are not as written';
    end if;
  elsif exists (select 1 from jsonb_to_recordset(logins) login(account uuid, staff uuid, membership uuid)
                 where exists (select 1 from auth.accounts account where account.id = login.account)
                    or identity.sealed_qa_account(login.account)
                    or exists (select 1 from identity.staff staff_row where staff_row.id = login.staff)
                    or exists (select 1 from identity.staff_facility_memberships membership
                                where membership.id = login.membership)
                    or exists (select 1 from auth.account_roles assignment where assignment.id = login.membership))
        or exists (select 1 from audit.events event_row where event_row.correlation_id = correlation) then
    raise exception using errcode = '55000', message = '0151: post-check failed: rows written without the QA tenant';
  end if;
  if (select md5(string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C"))
        from auth.role_permissions grant_row where grant_row.role_code = 'receptionist')
     is distinct from receptionist_md5
     or (select md5(string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C"))
           from auth.role_permissions grant_row where grant_row.role_code = 'nurse')
        is distinct from nurse_md5
     or current_user <> (select role_row.rolname from pg_roles role_row where role_row.oid = applier) then
    raise exception using errcode = '55000', message = '0151: post-check failed: a role''s codes or the role changed';
  end if;

  if installed then
    raise notice '0151: QA Front Desk (receptionist) and QA Nurse (nurse) at QA Hospital, sealed QA, pending_reset (the owner sets each password with Forgot password); two audit rows.';
  end if;
end
$qa2$;
