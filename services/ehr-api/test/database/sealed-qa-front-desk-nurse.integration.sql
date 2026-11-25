\set ON_ERROR_STOP on
-- 0151 (QA-2; owner, 24 November 2026: "Q141 B and add front-desk or nurse
-- login", "yes both receive mail", "go ahead"): a fictional front-desk login
-- (frontdesk@, receptionist) and a fictional nurse login (nurse@, nurse) at
-- the sealed QA Hospital. Rollback-only, apart from the dblink extension
-- below. On a migrated database 0151 has run already (without the QA tenant,
-- so it wrote nothing); the migration file is run here again as written (psql
-- \ir), as the runner runs it inside its transaction:
--   1. busy refusals, first, before this transaction locks any table: a
--      second session (dblink) holds identity.staff_invitations in ROW
--      EXCLUSIVE mode (0151's SHARE cannot be had): 0151 tries for about 5
--      seconds and refuses with 55P03 "0151: ... stayed busy for 5 seconds;
--      nothing applied; run the release again at a quieter time"; when this
--      transaction already holds another file's strong lock it refuses at
--      once ("... so it does not wait; ..."); the same for 0123's install
--      lock held by the second session. The messages are the ones the
--      runner's dry run retries, and nothing is applied;
--   2. without the QA tenant (every database but Amazon RDS): the migration
--      wrote nothing (no fixed id, no audit row), and running it again writes
--      nothing either (a NOTICE says so); the locks it takes are exactly the
--      ones its Locks paragraph declares;
--   3. with the QA tenant (0123's install, as the 0123 and 0134 suites call
--      it): both logins, each a QA account, pending_reset without a password,
--      its email verified, a verified staff record, exactly one membership
--      (QA Hospital, primary) and one role (receptionist, nurse), no platform
--      role; two audit rows with the membership and the facility only; once
--      the owner has set a password (status active): through
--      auth.membership_has_permission, exactly the role's codes at QA
--      Hospital and nothing at QA Laboratory, QA Pharmacy or a real facility;
--      no other row of the QA tenant changes; the locks it takes stay within
--      the declared ones;
--   4. a second run answers "0151: already applied" (55000) and changes
--      nothing;
--   5. the seal: neither login can be given a membership at a real or a demo
--      facility nor a platform role; the front desk at QA Hospital reads QA
--      patients only (identity.patients' registration read), never a real
--      or demo one;
--   6. an address already held (an account, any case; a staff record; an
--      open organization application; a pending staff invitation): 55000
--      "0151: SEALED_QA_ADDRESS_TAKEN", nothing written; a deleted account,
--      a closed application or an expired invitation does not hold it; a fixed
--      id held by another row: "0151: SEALED_QA_ID_TAKEN";
--   7. the preconditions refuse (55000, nothing written): the receptionist's
--      codes changed, a seal trigger disabled, 0123's helper replaced.
-- Synthetic values only: uuid prefix e151, @example.invalid addresses for
-- real people; the QA logins are fictional and the file holds no password.
set plpgsql.variable_conflict = error;

select exists (select 1 from pg_available_extensions where name = 'dblink') as qa2_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as qa2_dblink_create \gset
\if :qa2_dblink_available
\if :qa2_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

-- Runs 0151 as written and keeps what it answered (SQLSTATE and message, or
-- 'applied'). 0151 is one statement, so when it raises, ON_ERROR_ROLLBACK
-- undoes all of it, as the runner's transaction does.
\set run0151 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0151_sealed_qa_front_desk_and_nurse_logins.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0151 sealed QA front desk and nurse suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  if to_regclass('pg_temp.qa2_passed') is null then
    perform set_config('qa2.passed', (coalesce(nullif(current_setting('qa2.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.qa2_passed');
  end if;
  raise notice '0151 suite: % passed', case_name;
end
$$;
create function pg_temp.busy_refusal(sqlstate text, message text) returns text language sql immutable as $$
  select case when sqlstate = '55P03' and message ~ '^0151: '
                   and message ~ '(so it does not wait|stayed busy for 5 seconds)(; nothing applied)?; run the release again at a quieter time$'
              then 'busy refusal: ' || substring(message from '(so it does not wait|stayed busy for 5 seconds)')
              else sqlstate || ' ' || message end;
$$;
-- What 0151 wrote: the rows at its fixed ids and its audit rows.
create function pg_temp.made() returns text language sql as $$
  select (select count(*) from auth.accounts where id in ('c0a00003-0000-4000-8000-000000000008',
            'c0a00003-0000-4000-8000-000000000009'))
      + (select count(*) from identity.staff where id in ('c0a00004-0000-4000-8000-000000000008',
            'c0a00004-0000-4000-8000-000000000009'))
      + (select count(*) from identity.staff_facility_memberships where id in ('c0a00005-0000-4000-8000-000000000081',
            'c0a00005-0000-4000-8000-000000000091'))
      + (select count(*) from auth.account_roles where id in ('c0a00005-0000-4000-8000-000000000081',
            'c0a00005-0000-4000-8000-000000000091'))
      + (select count(*) from identity.sealed_qa_members where member_id in ('c0a00003-0000-4000-8000-000000000008',
            'c0a00003-0000-4000-8000-000000000009'))
      || ' rows, ' || (select count(*) from audit.events where correlation_id = '0151-sealed-qa-front-desk-nurse')
      || ' audit rows';
$$;
create function pg_temp.answer(sqlstate text, message text) returns text language sql immutable as $$
  select case when message = 'applied' then 'applied' else sqlstate || ' ' || message end;
$$;

-- 1. Busy refusals.
\if :qa2_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('qa2_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select public.dblink_exec('qa2_blocker', 'begin') as began \gset
select public.dblink_exec('qa2_blocker', 'lock table identity.staff_invitations in row exclusive mode') as blocked \gset
select pg_temp.made() as made_before_busy \gset
:run0151
select pg_temp.expect('1b identity.staff_invitations written by another session: 0151 tries for 5 seconds, then refuses as the runner retries',
  'busy refusal: stayed busy for 5 seconds | ' || :'made_before_busy',
  pg_temp.busy_refusal(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0151
select pg_temp.made() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: refuses at once',
  'busy refusal: so it does not wait | ' || :'made_before_busy',
  pg_temp.busy_refusal(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made_holding');
select public.dblink_exec('qa2_blocker', 'rollback') as ended \gset
select public.dblink_exec('qa2_blocker', 'begin') as began \gset
select held.locked as held_install from public.dblink('qa2_blocker',
  'select pg_advisory_xact_lock(hashtextextended(''hid-sealed-qa-install'', 0))::text') as held(locked text) \gset
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0151
select pg_temp.made() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1d 0123''s install lock held by another session: refused as busy, nothing applied',
  'busy refusal: so it does not wait | ' || :'made_before_busy',
  pg_temp.busy_refusal(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made_holding');
select public.dblink_exec('qa2_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('qa2_blocker') as disconnected \gset
\else
\echo '0151 suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence qa2_passed;
select setval('pg_temp.qa2_passed', coalesce(nullif(current_setting('qa2.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- The locks 0151 declares, at their strongest mode.
create function pg_temp.lock_rank(mode text) returns integer language sql immutable as $$
  select array_position(array['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
    'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'], mode);
$$;
create temporary table declared_locks (table_name text primary key, mode text not null) on commit drop;
insert into declared_locks values
  ('audit.events', 'RowExclusiveLock'), ('auth.account_roles', 'RowExclusiveLock'),
  ('auth.accounts', 'RowExclusiveLock'), ('auth.role_permissions', 'ShareLock'), ('auth.roles', 'RowShareLock'),
  ('identity.facilities', 'RowShareLock'), ('identity.organization_applications', 'ShareLock'),
  ('identity.organizations', 'RowShareLock'), ('identity.outreach_organisations', 'RowShareLock'),
  ('identity.patients', 'RowShareLock'), ('identity.sealed_demo_members', 'AccessShareLock'),
  ('identity.sealed_qa_members', 'RowExclusiveLock'), ('identity.staff', 'RowExclusiveLock'),
  ('identity.staff_facility_memberships', 'RowExclusiveLock'), ('identity.staff_invitations', 'ShareLock');
create temporary table locks_before (relation oid, mode text) on commit drop;
create temporary table locks_after (relation oid, mode text) on commit drop;
create function pg_temp.record_locks(target text) returns void language plpgsql as $$
begin
  execute format('delete from %I', target);
  execute format('insert into %I select lock_row.relation, lock_row.mode from pg_locks lock_row
                   where lock_row.pid = pg_backend_pid() and lock_row.granted and lock_row.locktype = ''relation''',
                 target);
end
$$;
-- Each table whose lock 0151 added or strengthened, at its strongest mode.
create function pg_temp.added_locks() returns table (table_name text, mode text) language sql as $$
  select namespace.nspname || '.' || class.relname,
         (array_agg(locks_after.mode order by pg_temp.lock_rank(locks_after.mode) desc))[1]
    from locks_after
    join pg_class class on class.oid = locks_after.relation and class.relkind in ('r', 'p')
    join pg_namespace namespace on namespace.oid = class.relnamespace
   where namespace.nspname not in ('pg_catalog', 'information_schema') and namespace.nspname not like 'pg_temp%'
     and not exists (select 1 from locks_before
                      where locks_before.relation = locks_after.relation
                        and pg_temp.lock_rank(locks_before.mode) >= pg_temp.lock_rank(locks_after.mode))
   group by namespace.nspname, class.relname;
$$;

-- A later file's role rows (0173, ADT-1: the sixteen inpatient rows) are
-- taken away for this transaction, so the role table is as 0151 found it.
delete from auth.role_permissions where permission_code in ('ehr.ward.read', 'ehr.admission.read', 'ehr.bed.allocate', 'ehr.wristband.print', 'ehr.admission.decide', 'ehr.ward.manage', 'ehr.death-record.write');

-- 2. Without the QA tenant.
select pg_temp.expect('2a no QA tenant here', 'false',
  identity.sealed_qa_facility('c0a00002-0000-4000-8000-000000000001')::text);
select pg_temp.expect('2b the migration wrote nothing (no fixed id, no audit row)', '0 rows, 0 audit rows',
  pg_temp.made());
savepoint locks;
select pg_temp.record_locks('locks_before');
:run0151
select pg_temp.record_locks('locks_after');
select pg_temp.expect('2c run again: nothing written, and the locks are exactly the declared ones',
  'applied | 0 rows, 0 audit rows | ' || (select string_agg(table_name || ' ' || mode, ', ' order by table_name)
                                            from declared_locks),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made() || ' | '
  || (select string_agg(table_name || ' ' || mode, ', ' order by table_name) from pg_temp.added_locks()));
rollback to savepoint locks;

-- 3. With the QA tenant, as the 0123 and 0134 suites install it.
update platform.control_settings set enabled = true where control_key = 'outreach_organiser_signup_enabled';
select identity.sealed_qa_install() is not null as installed \gset
select pg_temp.expect('3a QA Hospital is a QA facility now', 'true',
  identity.sealed_qa_facility('c0a00002-0000-4000-8000-000000000001')::text);
-- The QA tenant's rows before 0151 (to show nothing else changes).
create function pg_temp.tenant_print() returns text language sql as $$
  select md5(coalesce((select string_agg(to_jsonb(account)::text, ',' order by account.id) from auth.accounts account
                        where account.source_system = 'hid-sealed-qa'
                          and account.id not in ('c0a00003-0000-4000-8000-000000000008',
                                                 'c0a00003-0000-4000-8000-000000000009')), '')
      || '|' || coalesce((select string_agg(to_jsonb(membership)::text, ',' order by membership.id)
                            from identity.staff_facility_memberships membership
                           where membership.source_system = 'hid-sealed-qa'
                             and membership.id not in ('c0a00005-0000-4000-8000-000000000081',
                                                       'c0a00005-0000-4000-8000-000000000091')), '')
      || '|' || coalesce((select string_agg(to_jsonb(assignment)::text, ',' order by assignment.id)
                            from auth.account_roles assignment
                           where assignment.id not in ('c0a00005-0000-4000-8000-000000000081',
                                                       'c0a00005-0000-4000-8000-000000000091')), '')
      || '|' || (select count(*) from identity.sealed_qa_members)::text
      || '|' || coalesce((select string_agg(role_code || ' ' || permission_code, ',' order by role_code, permission_code)
                            from auth.role_permissions), ''));
$$;
select pg_temp.tenant_print() as tenant_before \gset
select count(*) as qa_members_before from identity.sealed_qa_members \gset
savepoint before_0151;
select pg_temp.record_locks('locks_before');
:run0151
select pg_temp.record_locks('locks_after');
select pg_temp.expect('3b 0151 applies with the QA tenant: 10 rows, 2 audit rows', 'applied | 10 rows, 2 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
select pg_temp.expect('3c every lock it added is a declared one, at most at the declared mode', '',
  coalesce((select string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name)
              from pg_temp.added_locks() added
              left join declared_locks declared on declared.table_name = added.table_name
             where declared.table_name is null or pg_temp.lock_rank(added.mode) > pg_temp.lock_rank(declared.mode)), ''));
select pg_temp.expect('3d the two logins: QA accounts, pending_reset, no password, email verified, verified staff records',
  'frontdesk@healthidentitydirectory.com:QA Front Desk:sealed-qa:c0a00003-0000-4000-8000-000000000008:pending_reset:'
  || 'true:true:true:verified:receptionist:true '
  || 'nurse@healthidentitydirectory.com:QA Nurse:sealed-qa:c0a00003-0000-4000-8000-000000000009:pending_reset:'
  || 'true:true:true:verified:nurse:true',
  (select string_agg(concat_ws(':', account.email, account.display_name, account.subject, account.status,
            (account.password_hash is null and account.password_algorithm is null)::text,
            (account.email_verified_at is not null)::text, identity.sealed_qa_account(account.id)::text,
            staff_row.verification_status, staff_row.default_role, staff_row.active::text), ' ' order by account.id)
     from auth.accounts account join identity.staff staff_row on staff_row.account_id = account.id
    where account.id in ('c0a00003-0000-4000-8000-000000000008', 'c0a00003-0000-4000-8000-000000000009')));
select pg_temp.expect('3e exactly one membership and one role each, at QA Hospital, no platform role',
  'frontdesk@healthidentitydirectory.com:QA-HOSPITAL:receptionist:receptionist:receptionist:facility:true:true '
  || 'nurse@healthidentitydirectory.com:QA-HOSPITAL:nurse:nurse:nurse:facility:true:true',
  (select string_agg(concat_ws(':', account.email, facility.code, membership.membership_role, membership.app_role,
            assignment.role_code, assignment.scope_type, membership.is_primary::text, membership.active::text),
            ' ' order by account.id)
     from auth.accounts account
     join identity.staff_facility_memberships membership on membership.account_id = account.id
     join identity.facilities facility on facility.id = membership.facility_id
     join auth.account_roles assignment on assignment.account_id = account.id and assignment.revoked_at is null
    where account.id in ('c0a00003-0000-4000-8000-000000000008', 'c0a00003-0000-4000-8000-000000000009')));
select pg_temp.expect('3f the two audit rows: the system actor, the membership and the facility only',
  'c0a00005-0000-4000-8000-000000000081:{"decision": "Q141 (QA-2)", "roleCode": "receptionist", "migration": "0151", '
  || '"membershipId": "c0a00005-0000-4000-8000-000000000081"} '
  || 'c0a00005-0000-4000-8000-000000000091:{"decision": "Q141 (QA-2)", "roleCode": "nurse", "migration": "0151", '
  || '"membershipId": "c0a00005-0000-4000-8000-000000000091"}',
  (select string_agg(event_row.resource_id || ':' || event_row.details::text, ' ' order by event_row.resource_id)
     from audit.events event_row
    where event_row.correlation_id = '0151-sealed-qa-front-desk-nurse' and event_row.actor_type = 'system'
      and event_row.action = 'identity.sealed-qa.staff-login-add' and event_row.resource_type = 'staff-membership'
      and event_row.facility_id = 'c0a00002-0000-4000-8000-000000000001' and event_row.organization_id is null
      and event_row.actor_account_id is null and event_row.actor_membership_id is null
      and event_row.actor_subject is null and event_row.patient_id is null and event_row.provenance = 'migration'
      and event_row.details::text not like '%@%'));
select pg_temp.expect('3g nothing else of the QA tenant (or the role table) changed; two QA members more',
  :'tenant_before' || ' ' || (:qa_members_before + 2)::text,
  (select md5(coalesce((select string_agg(to_jsonb(account)::text, ',' order by account.id) from auth.accounts account
                        where account.source_system = 'hid-sealed-qa'
                          and account.id not in ('c0a00003-0000-4000-8000-000000000008',
                                                 'c0a00003-0000-4000-8000-000000000009')), '')
      || '|' || coalesce((select string_agg(to_jsonb(membership)::text, ',' order by membership.id)
                            from identity.staff_facility_memberships membership
                           where membership.source_system = 'hid-sealed-qa'
                             and membership.id not in ('c0a00005-0000-4000-8000-000000000081',
                                                       'c0a00005-0000-4000-8000-000000000091')), '')
      || '|' || coalesce((select string_agg(to_jsonb(assignment)::text, ',' order by assignment.id)
                            from auth.account_roles assignment
                           where assignment.id not in ('c0a00005-0000-4000-8000-000000000081',
                                                       'c0a00005-0000-4000-8000-000000000091')), '')
      || '|' || :qa_members_before::text
      || '|' || coalesce((select string_agg(role_code || ' ' || permission_code, ',' order by role_code, permission_code)
                            from auth.role_permissions), '')))
  || ' ' || (select count(*) from identity.sealed_qa_members)::text);

-- The owner has set both passwords (Forgot password): active. What each may
-- do, through auth.membership_has_permission (what every service checks): at
-- QA Hospital exactly its role's codes; elsewhere nothing.
savepoint activated;
update auth.accounts set status = 'active'
 where id in ('c0a00003-0000-4000-8000-000000000008', 'c0a00003-0000-4000-8000-000000000009');
create function pg_temp.codes(subject text, membership uuid, facility uuid) returns text language sql as $$
  select coalesce(string_agg(permission_row.code, ',' order by permission_row.code collate "C"), '')
    from auth.permissions permission_row
   where auth.membership_has_permission(subject, membership, facility, permission_row.code);
$$;
select pg_temp.expect('3h the front desk at QA Hospital: exactly the receptionist''s 17 codes (0136 C1)',
  'ehr.document.read-own,ehr.document.write,ehr.encounter.read,ehr.encounter.write,ehr.vital.read,'
  || 'identity.authorization.check,identity.consent.read,identity.consent.write,identity.patient.read,'
  || 'identity.registration.write,ocr.job.read-own,ocr.job.start,ocr.job.write,outreach.campaign.read,'
  || 'outreach.campaign.write,outreach.registration.read,outreach.registration.write',
  pg_temp.codes('sealed-qa:c0a00003-0000-4000-8000-000000000008', 'c0a00005-0000-4000-8000-000000000081',
    'c0a00002-0000-4000-8000-000000000001'));
select pg_temp.expect('3i the nurse at QA Hospital: exactly the nurse''s 38 codes', '38 1cf6eca65a5ea51b817db099e32a0ef2',
  (select (length(codes) - length(replace(codes, ',', '')) + 1)::text || ' ' || md5(codes)
     from pg_temp.codes('sealed-qa:c0a00003-0000-4000-8000-000000000009', 'c0a00005-0000-4000-8000-000000000091',
       'c0a00002-0000-4000-8000-000000000001') codes));
select pg_temp.expect('3j and the role table says the same (the nurse''s codes, pinned by 0151)',
  '1cf6eca65a5ea51b817db099e32a0ef2',
  (select md5(string_agg(permission_code, ',' order by permission_code collate "C")) from auth.role_permissions
    where role_code = 'nurse'));
select pg_temp.expect('3k nothing through their memberships at QA Laboratory or QA Pharmacy, nor with another''s membership',
  '||||',
  pg_temp.codes('sealed-qa:c0a00003-0000-4000-8000-000000000008', 'c0a00005-0000-4000-8000-000000000081',
    'c0a00002-0000-4000-8000-000000000002') || '|'
  || pg_temp.codes('sealed-qa:c0a00003-0000-4000-8000-000000000009', 'c0a00005-0000-4000-8000-000000000091',
    'c0a00002-0000-4000-8000-000000000003') || '|'
  || pg_temp.codes('sealed-qa:c0a00003-0000-4000-8000-000000000008', 'c0a00005-0000-4000-8000-000000000091',
    'c0a00002-0000-4000-8000-000000000001') || '|'
  || pg_temp.codes('sealed-qa:c0a00003-0000-4000-8000-000000000009', 'c0a00005-0000-4000-8000-000000000011',
    'c0a00002-0000-4000-8000-000000000001') || '|'
  || pg_temp.codes('sealed-qa:c0a00003-0000-4000-8000-000000000008', 'c0a00005-0000-4000-8000-000000000081',
    'e1510002-0000-4000-8000-000000000001'));

-- 5. The seal (with the demo tenant too, so all three sides exist).
select identity.sealed_demo_install() is not null as demo_installed \gset
insert into identity.organizations (id, name, slug) values
  ('e1510001-0000-4000-8000-000000000001', 'Real Test Organization', 'real-test-organization-0151');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1510002-0000-4000-8000-000000000001', 'e1510001-0000-4000-8000-000000000001', 'Real Test Clinic',
   'REAL-TEST-0151', 'Africa/Lagos', true, 'verified');
create function pg_temp.try(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$$;
create function pg_temp.member_at(account_n integer, organization uuid, facility uuid, role_code text) returns text
language sql as $$
  select pg_temp.try(format('insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
      facility_id, membership_role, app_role, is_primary, active)
    values (gen_random_uuid(), %L, %L, %L, %L, %L, %L, false, true)',
    'c0a00004-0000-4000-8000-00000000000' || account_n, 'c0a00003-0000-4000-8000-00000000000' || account_n,
    organization, facility, role_code, role_code));
$$;
select pg_temp.expect('5a neither login can be given a membership at a real facility',
  '42501 SEALED_QA_MEMBERSHIP_REFUSED|42501 SEALED_QA_MEMBERSHIP_REFUSED',
  pg_temp.member_at(8, 'e1510001-0000-4000-8000-000000000001', 'e1510002-0000-4000-8000-000000000001', 'receptionist')
  || '|' || pg_temp.member_at(9, 'e1510001-0000-4000-8000-000000000001', 'e1510002-0000-4000-8000-000000000001', 'nurse'));
select pg_temp.expect('5b nor at the sealed demo''s hospital',
  'refused|refused',
  (select string_agg(case when answer ~ '^42501 SEALED_(QA|DEMO)_MEMBERSHIP_REFUSED$' then 'refused' else answer end, '|'
                     order by n)
     from (values (1, pg_temp.member_at(8, '98d00001-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001',
                                         'receptionist')),
                  (2, pg_temp.member_at(9, '98d00001-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001',
                                         'nurse'))) attempt(n, answer)));
select pg_temp.expect('5c nor a platform role',
  '42501 SEALED_QA_PLATFORM_ROLE_REFUSED|42501 SEALED_QA_PLATFORM_ROLE_REFUSED',
  pg_temp.try($s$insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values (gen_random_uuid(), 'c0a00003-0000-4000-8000-000000000008', 'support', 'platform', 'Sealed QA suite probe')$s$)
  || '|' || pg_temp.try($s$insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values (gen_random_uuid(), 'c0a00003-0000-4000-8000-000000000009', 'support', 'platform', 'Sealed QA suite probe')$s$));
-- A real patient beside the QA and demo ones.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1510009-0000-4000-8000-000000000001', 'HID-E5RLQT', 'Rafa', 'Realpatient', 'Rafa Realpatient', 'male',
   '1980-02-02', 'active');
create function pg_temp.as_desk(account_n integer, membership text) returns void language sql as $$
  select set_config('app.actor_subject', 'sealed-qa:c0a00003-0000-4000-8000-00000000000' || account_n, true),
         set_config('app.facility_id', 'c0a00002-0000-4000-8000-000000000001', true),
         set_config('app.correlation_id', 'sealed-qa-0151-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', 'c0a00005-0000-4000-8000-0000000000' || membership, true),
         set_config('app.purpose_of_use', 'healthcare-operations', true),
         set_config('app.patient_id', '', true), set_config('app.session_id', '', true);
$$;
grant execute on function pg_temp.as_desk(integer, text), pg_temp.expect(text, text, text) to public;
grant usage on sequence pg_temp.qa2_passed to public;
set local role hid_identity_api_runtime;
select pg_temp.as_desk(8, '81');
select pg_temp.expect('5d the front desk at QA Hospital reads the two QA patients only, never a real or demo one',
  '2|2|0|0',
  (select count(*) from identity.patients)::text
  || '|' || (select count(*) from identity.patients where upper(hid_code) in ('HID-ZQAAAAA2', 'HID-ZQAAAAA3'))::text
  || '|' || (select count(*) from identity.patients where upper(hid_code) = 'HID-E5RLQT' or full_name ilike 'Rafa%')::text
  || '|' || (select count(*) from identity.patients where upper(hid_code) like 'HID-ZDEM%')::text);
select pg_temp.as_desk(9, '91');
select pg_temp.expect('5e the nurse the same', '2|0',
  (select count(*) from identity.patients)::text
  || '|' || (select count(*) from identity.patients where upper(hid_code) = 'HID-E5RLQT'
                                                       or upper(hid_code) like 'HID-ZDEM%')::text);
reset role;
rollback to savepoint activated;

-- 4. A second run.
select pg_temp.made() as made_once \gset
select pg_temp.tenant_print() as tenant_once \gset
:run0151
select pg_temp.expect('4 a second run: "0151: already applied", nothing changed',
  '55000 0151: already applied | ' || :'made_once' || ' | ' || :'tenant_once',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made() || ' | '
  || pg_temp.tenant_print());
rollback to savepoint before_0151;
select pg_temp.expect('4b back before 0151, with the QA tenant', '0 rows, 0 audit rows', pg_temp.made());

-- 6. An address already held; a fixed id held.
-- A real account and staff record (fictional), for the fixtures.
insert into identity.organizations (id, name, slug) values
  ('e1510001-0000-4000-8000-000000000002', 'Real Test Organization Two', 'real-test-organization-0151-two');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1510002-0000-4000-8000-000000000002', 'e1510001-0000-4000-8000-000000000002', 'Real Test Clinic Two',
   'REAL-TEST-0151-TWO', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1510003-0000-4000-8000-000000000001', 'staff:e1510003-0000-4000-8000-000000000001', 'inviter@example.invalid',
   'Test Inviter', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('e1510004-0000-4000-8000-000000000001', 'e1510003-0000-4000-8000-000000000001', 'Test Inviter',
   'inviter@example.invalid', 'verified', 'org_admin', true);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('e1510005-0000-4000-8000-000000000001', 'e1510004-0000-4000-8000-000000000001', 'e1510003-0000-4000-8000-000000000001',
   'e1510001-0000-4000-8000-000000000002', 'e1510002-0000-4000-8000-000000000002', 'org_admin', 'org_admin', true, true);
create function pg_temp.invite(address text, expires timestamptz) returns void language sql as $$
  insert into identity.staff_invitations (id, organization_id, facility_id, invited_by_account_id,
    invited_by_membership_id, invitee_name, invitee_email, role_code, licence_body, licence_number, attestation_version,
    attested_at, link_token_hmac, email_code_hmac, key_version, last_sent_at, last_send_id, expires_at, idempotency_key,
    request_sha256, correlation_id)
  values (gen_random_uuid(), 'e1510001-0000-4000-8000-000000000002', 'e1510002-0000-4000-8000-000000000002',
    'e1510003-0000-4000-8000-000000000001', 'e1510005-0000-4000-8000-000000000001', 'Invited Person', address,
    'receptionist', null, null, 'facility-staff-attestation-v1', clock_timestamp() - interval '1 hour', repeat('1', 64),
    repeat('2', 64), 'v1', clock_timestamp() - interval '1 hour', gen_random_uuid(), expires, 'qa2-suite-invite',
    repeat('c', 64), 'qa2-suite-invite');
$$;
savepoint taken;
\set taken_case 'select pg_temp.expect(:''case_name'', ''55000 0151: SEALED_QA_ADDRESS_TAKEN | 0 rows, 0 audit rows'', pg_temp.answer(:''LAST_ERROR_SQLSTATE'', :''LAST_ERROR_MESSAGE'') || '' | '' || pg_temp.made()); rollback to savepoint taken;'
\set free_case 'select pg_temp.expect(:''case_name'', ''applied | 10 rows, 2 audit rows'', pg_temp.answer(:''LAST_ERROR_SQLSTATE'', :''LAST_ERROR_MESSAGE'') || '' | '' || pg_temp.made()); rollback to savepoint taken;'

insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1510003-0000-4000-8000-000000000002', 'staff:e1510003-0000-4000-8000-000000000002',
   'FrontDesk@HealthIdentityDirectory.com', 'Someone Else', 'active');
:run0151
\set case_name '6a frontdesk@ held by another account (any case)'
:taken_case
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1510003-0000-4000-8000-000000000002', 'staff:e1510003-0000-4000-8000-000000000002',
   'nurse@healthidentitydirectory.com', 'Someone Else', 'locked');
:run0151
\set case_name '6b nurse@ held by a locked account'
:taken_case
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1510003-0000-4000-8000-000000000002', 'staff:e1510003-0000-4000-8000-000000000002',
   'other@example.invalid', 'Someone Else', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('e1510004-0000-4000-8000-000000000002', 'e1510003-0000-4000-8000-000000000002', 'Someone Else',
   'nurse@healthidentitydirectory.com', 'verified', 'nurse', true);
:run0151
\set case_name '6c nurse@ held by a staff record'
:taken_case
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status)
values ('e1510007-0000-4000-8000-000000000001', 'ehr', 'Applicant Clinic Ltd', 'hospital', 'RC1510001', 'Applicant Admin',
  'frontdesk@healthidentitydirectory.com', 'pending_verification');
:run0151
\set case_name '6d frontdesk@ the first administrator of an open organization application'
:taken_case
select pg_temp.invite('nurse@healthidentitydirectory.com', clock_timestamp() + interval '2 days');
:run0151
\set case_name '6e nurse@ invited by a pending staff invitation'
:taken_case
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1510003-0000-4000-8000-000000000002', 'staff:e1510003-0000-4000-8000-000000000002',
   'frontdesk@healthidentitydirectory.com', 'Someone Deleted', 'deleted');
:run0151
\set case_name '6f a deleted account does not hold the address'
:free_case
select pg_temp.invite('nurse@healthidentitydirectory.com', clock_timestamp() - interval '1 minute');
:run0151
\set case_name '6g an expired pending invitation does not hold it'
:free_case
insert into auth.accounts (id, subject, email, display_name, status) values
  ('c0a00003-0000-4000-8000-000000000009', 'staff:c0a00003-0000-4000-8000-000000000009', 'someone@example.invalid',
   'Not The QA Nurse', 'active');
:run0151
select pg_temp.expect('6h a fixed id held by a real account: "0151: SEALED_QA_ID_TAKEN", nothing written',
  '55000 0151: SEALED_QA_ID_TAKEN | 1 rows, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint taken;

-- 7. Preconditions.
insert into auth.role_permissions (role_code, permission_code) values ('receptionist', 'ehr.vital.write');
:run0151
select pg_temp.expect('7a the receptionist''s codes changed: refused',
  '55000 0151: the receptionist or nurse role is inactive or its codes differ from Release C and 0150; nothing applied | 0 rows, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint taken;
alter table identity.staff_facility_memberships disable trigger staff_memberships_sealed_qa;
:run0151
select pg_temp.expect('7b 0123''s membership seal disabled: refused',
  '55000 0151: these seal triggers are missing, disabled or call another function: staff_memberships_sealed_qa | 0 rows, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint taken;
create or replace function identity.sealed_qa_account(requested_account_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$ select true $$;
:run0151
select pg_temp.expect('7c 0123''s helper replaced: refused',
  '55000 0151: these functions differ from 0123''s (and 0098''s) or are missing: identity.sealed_qa_account(uuid) | 0 rows, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint taken;

do $$
declare
  wanted integer := case when exists (select 1 from pg_extension where extname = 'dblink') then 36 else 32 end;
begin
  if currval('pg_temp.qa2_passed') is distinct from wanted then
    raise exception '0151 sealed QA front desk and nurse suite failed: % cases ran, % expected',
      currval('pg_temp.qa2_passed'), wanted;
  end if;
  raise notice '0151 sealed QA front desk and nurse suite: % cases passed', wanted;
end $$;
rollback;

\if :qa2_dblink_available
\if :qa2_dblink_create
drop extension dblink;
\endif
\endif
