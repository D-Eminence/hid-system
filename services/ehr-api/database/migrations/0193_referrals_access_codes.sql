-- 0193 REF-1 Referrals between facilities: who uses them (Release D, the
-- department sprint the owner approved on 25 November 2026;
-- docs/EHR_PLANNED_CONTRACT.md REF-1, "Roles and access codes"). Written on
-- staging-novu-ci-20261005 at 0cfddcc9 (0001-0153 applied) after 0191 and 0192.
-- The number is provisional, given at merge in release order. It pins no role's
-- whole code list: it keeps every code and role row another lane added (APPT-1,
-- BILL-1, ED-1, ADT-1, NUR-1 and the other wave 3 departments), requires only
-- that no referral code exists yet, and checks that every other row of the role
-- table is the same after it as before. The declaration in
-- config/production-schema-compatibility.json stays unsigned until the owner
-- signs this file. It is its own file so Rahman can review who gets referrals
-- apart from the tables (as 0169), and it can be signed after 0191 and 0192 if
-- the role table changes.
--
-- Owner decisions it is built on (25 November 2026): Q155 A (no new role and no
-- Medical Director), Q264 A (no approval step: the design's Medical Director
-- "approve" grant is dropped). The front desk marks arrivals only, as the
-- department survey has it; nurses get no referral code (an open question for
-- the owner).
--
-- What it changes (nothing else):
-- F1 auth.permissions          four codes: ehr.referral.read (the referring
--                              facility's lists and a referral's card),
--                              ehr.referral.send (send, withdraw, print the
--                              letter, the directory), ehr.referral.receive
--                              (incoming, accept, decline, the package while
--                              allowed, complete), ehr.referral.arrive
--                              (expected arrivals and "Patient arrived", with
--                              0135's pair).
-- F2 auth.role_permissions     nine rows:
--                                doctor        read, send, receive, arrive
--                                clinician     read, send, receive, arrive
--                                receptionist  arrive
--                              Sending also needs ehr.encounter.write, and
--                              arrival 0135's pair ehr.encounter.read and
--                              ehr.encounter.write, which all three roles
--                              already hold.
-- F3 audit.events              one row per role row added, as the system actor
--                              (no account, membership, facility or patient):
--                              auth.role-permission.add, resource
--                              role-permission "<role>/<code>", reason "REF-1
--                              Referrals between facilities (Release D, owner
--                              decisions Q261-Q266 A)".
-- No function, policy, grant or table changes, so runtime-grants.sql is
-- unchanged by this file. Permissions are read from these tables on every
-- request (auth.membership_has_permission and the Identity staff context), so
-- the change applies from each signed-in member's next request; nobody is
-- signed out. The service flag REFERRALS_ENABLED and the control
-- cross_facility_referrals_enabled (0191, seeded off) still keep referrals
-- closed in production until the owner's go-live.
-- The closing NOTICE prints how many active memberships at real (not sealed)
-- facilities gain each code.
--
-- Locks, taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.role_permissions for
-- the transaction (other writers wait; every reader, each staff request's
-- permission check included, goes on), so the role table cannot change between
-- the preconditions and the post-checks; ROW EXCLUSIVE on auth.permissions and
-- audit.events (the new rows); ROW SHARE on auth.roles (the role rows' foreign
-- key checks) and on auth.accounts, identity.staff_facility_memberships,
-- identity.organizations, identity.facilities and identity.patients (the
-- foreign key checks of the audit rows open every table they reference, even
-- for a null key); ACCESS SHARE on auth.account_roles,
-- identity.sealed_demo_members and identity.sealed_qa_members (the closing
-- count, which calls the sealed tenant functions). The attempt is made 50
-- times, 100 ms apart (about 5 seconds), then 55P03 (nothing applied); one
-- attempt and no sleep when this transaction already holds an earlier
-- migration's locks that stop other sessions. Both refusals begin "0193: " and
-- end "run the release again at a quieter time".
--
-- Undo (not in the ledger; a migration only if the owner signs it): take the
-- nine rows out of auth.role_permissions (or mark the four codes inactive).
--
-- The whole file is one statement (do $ref0193$):
-- 0. The locks.
-- 1. Preconditions (55000, nothing applied): 0191 and 0192 applied; "0193:
--    already applied" when exactly the four codes and the nine rows are there;
--    "0193: the role table is not in the reviewed state" when any referral code
--    or row is there otherwise; the three roles exist and are active and hold
--    ehr.encounter.read and ehr.encounter.write (whatever other codes other
--    lanes gave them); auth.membership_has_permission as 0001-0153 leave it
--    (md5 pinned, so it still reads the role's rows on every request).
-- 2. F1-F3.
-- 3. Post-checks: the referral rows are exactly the nine; every other row of
--    the role table and every other code are unchanged; exactly nine audit rows
--    of this file.

do $ref0193$
declare
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_missing text;
  v_reason constant text := 'REF-1 Referrals between facilities (Release D, owner decisions Q261-Q266 A)';
  v_correlation constant text := '0193-referrals-ref1';
  -- The nine rows, in byte order (role, then code), joined by ','.
  v_rows_expected constant text := 'clinician ehr.referral.arrive,clinician ehr.referral.read,'
    || 'clinician ehr.referral.receive,clinician ehr.referral.send,doctor ehr.referral.arrive,'
    || 'doctor ehr.referral.read,doctor ehr.referral.receive,doctor ehr.referral.send,receptionist ehr.referral.arrive';
  -- auth.membership_has_permission(text,uuid,uuid,text) as 0001-0153 leave it.
  v_permission_check_md5 constant text := '65e3eaff93fe729fd5c5b986b80c9dd6';
  v_rows_before text;
  v_codes_before text;
  v_audited integer;
  v_read_gain integer;
  v_send_gain integer;
  v_receive_gain integer;
  v_arrive_gain integer;
begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table auth.role_permissions in share row exclusive mode nowait;
  lock table auth.permissions, audit.events in row exclusive mode nowait;
  lock table auth.roles, auth.accounts, identity.staff_facility_memberships, identity.organizations,
             identity.facilities, identity.patients
    in row share mode nowait;
  lock table auth.account_roles, identity.sealed_demo_members, identity.sealed_qa_members
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0193: auth.role_permissions, auth.permissions, audit.events or a table 0193''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) is busy, and this transaction already holds an earlier migration''s locks, so '
          || 'it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0193: auth.role_permissions, auth.permissions, audit.events or a table 0193''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) stayed busy for 5 seconds; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regclass('ehr.referrals') is null or to_regclass('ehr.referral_events') is null
     or to_regprocedure('ehr.referral_send(uuid, uuid, text, uuid, text, text, text, text, text, text, text, uuid[], '
          || 'uuid[], uuid[], uuid[], uuid[], text, boolean, text, text)') is null
     or to_regprocedure('ehr.referral_read(uuid)') is null
     or to_regprocedure('ehr.referral_arrive(uuid, bigint, text, uuid, text, text)') is null then
    raise exception using errcode = '55000', message = '0193: 0191 and 0192 must be applied first';
  end if;

  if (select count(*) from auth.permissions
       where code in ('ehr.referral.read', 'ehr.referral.send', 'ehr.referral.receive', 'ehr.referral.arrive')
         and active) = 4
     and (select count(*) from auth.permissions where code like 'ehr.referral.%') = 4
     and (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                            order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
            from auth.role_permissions grant_row where grant_row.permission_code like 'ehr.referral.%')
         is not distinct from v_rows_expected then
    raise exception using errcode = '55000', message = '0193: already applied';
  end if;
  if exists (select 1 from auth.permissions where code like 'ehr.referral.%')
     or exists (select 1 from auth.role_permissions where permission_code like 'ehr.referral.%') then
    raise exception using errcode = '55000',
      message = '0193: the role table is not in the reviewed state (a referral code or row is there, but not exactly '
        || 'what 0193 leaves); nothing applied';
  end if;

  select string_agg(code, ', ' order by code) into v_missing
    from (values ('doctor'), ('clinician'), ('receptionist')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0193: role missing or inactive: ' || v_missing;
  end if;
  select string_agg(wanted.role_code || ' ' || wanted.permission_code, ', '
                    order by wanted.role_code, wanted.permission_code) into v_missing
    from (values ('doctor'), ('clinician'), ('receptionist')) role_list(role_code)
    cross join lateral (values (role_list.role_code, 'ehr.encounter.read'), (role_list.role_code, 'ehr.encounter.write'))
      wanted(role_code, permission_code)
   where not exists (select 1 from auth.role_permissions grant_row
                      join auth.permissions permission_row on permission_row.code = grant_row.permission_code
                     where grant_row.role_code = wanted.role_code and grant_row.permission_code = wanted.permission_code
                       and permission_row.active);
  if v_missing is not null then
    raise exception using errcode = '55000',
      message = '0193: these roles do not hold 0135''s pair (sending and arrival need it): ' || v_missing;
  end if;
  if to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)'))
        is distinct from v_permission_check_md5 then
    raise exception using errcode = '55000',
      message = '0193: auth.membership_has_permission is not as 0001-0153 leave it; nothing applied';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into v_rows_before from auth.role_permissions grant_row;
  select string_agg(to_jsonb(permission_row)::text, ',' order by permission_row.code collate "C")
    into v_codes_before from auth.permissions permission_row;

  -- 2. F1. The four codes.
  insert into auth.permissions (code, description) values
    ('ehr.referral.read', 'See this facility''s sent referrals and a referral''s card (REF-1, 0193)'),
    ('ehr.referral.send', 'Send, withdraw and print referrals to other facilities, and search the directory (REF-1, 0193)'),
    ('ehr.referral.receive', 'Answer referrals sent to this facility, read their frozen package while allowed and record the outcome (REF-1, 0193)'),
    ('ehr.referral.arrive', 'See expected referred patients and mark them arrived on the waiting list (REF-1, 0193)');

  -- F2. The nine rows.
  insert into auth.role_permissions (role_code, permission_code) values
    ('doctor', 'ehr.referral.read'), ('doctor', 'ehr.referral.send'), ('doctor', 'ehr.referral.receive'),
    ('doctor', 'ehr.referral.arrive'),
    ('clinician', 'ehr.referral.read'), ('clinician', 'ehr.referral.send'), ('clinician', 'ehr.referral.receive'),
    ('clinician', 'ehr.referral.arrive'),
    ('receptionist', 'ehr.referral.arrive');

  -- F3. One audit row per role row, as the system actor.
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  )
  select v_correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', v_reason, 'migration',
         'hid-0193',
         jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0193', 'decision', 'Q155 A, Q261-Q266 A (owner decisions, 25 November 2026)')
    from auth.role_permissions grant_row
   where grant_row.permission_code like 'ehr.referral.%'
   order by grant_row.role_code collate "C", grant_row.permission_code collate "C";

  -- 3. Post-checks.
  select count(*) into v_audited from audit.events event_row where event_row.correlation_id = v_correlation;
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                        order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.permission_code like 'ehr.referral.%')
     is distinct from v_rows_expected
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where grant_row.permission_code not like 'ehr.referral.%')
        is distinct from v_rows_before
     or (select string_agg(to_jsonb(permission_row)::text, ',' order by permission_row.code collate "C")
           from auth.permissions permission_row where permission_row.code not like 'ehr.referral.%')
        is distinct from v_codes_before
     or (select count(*) from auth.permissions where code like 'ehr.referral.%' and active) <> 4
     or v_audited <> 9 then
    raise exception using errcode = '55000', message = '0193: post-check failed';
  end if;

  -- What the rows give, at real (not sealed) facilities: the active memberships that gain each code.
  select count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.referral.read'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.referral.send'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.referral.receive'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.referral.arrive')
    into v_read_gain, v_send_gain, v_receive_gain, v_arrive_gain
    from identity.staff_facility_memberships membership
    join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    join auth.role_permissions grant_row on grant_row.role_code = assignment.role_code
   where membership.active and membership.facility_id is not null
     and grant_row.permission_code like 'ehr.referral.%'
     and not identity.sealed_demo_facility(membership.facility_id)
     and not identity.sealed_qa_facility(membership.facility_id);
  raise notice '0193: the referral codes are given: at real facilities ehr.referral.read is now held by % active staff memberships, ehr.referral.send by %, ehr.referral.receive by %, ehr.referral.arrive by %; nine role rows, nine audit rows.',
    v_read_gain, v_send_gain, v_receive_gain, v_arrive_gain;
end
$ref0193$;
