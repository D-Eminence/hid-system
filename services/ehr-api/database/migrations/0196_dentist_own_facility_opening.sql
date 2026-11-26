-- 0196 DEN-1 (Release D): the dentist opens this facility's own patients
-- (owner decision Q156 A). Written on claude/sprint-dental-backend at a8126e33
-- (staging-novu-ci-20261005 at 0cfddcc9: 0001-0153 applied) after 0194 and
-- 0195. The number is provisional (given at merge).
--
-- HELD: built but switched off. This is an identity and consent change: it is
-- reviewed with 0194 and 0195, and signed only after Rahman and the DPO agree.
-- Until then a dentist opens a chart with the patient's Access PIN or the
-- patient's approval, as any member without 0131's code does. The numbering
-- keeps its place; it can ship in a later release than 0194-0195. The
-- declaration in config/production-schema-compatibility.json stays unsigned.
--
-- WHAT IT DOES (nothing else)
-- O1 auth.role_permissions: one row, (dentist, identity.patient.open-own-facility),
--    so a dentist opens this facility's own patients for 24 hours as nurses do
--    (0131's identity.open_own_facility_patient decides by the code; 0139's
--    role removal already ends the member's own-facility grants by the code).
-- O2 audit.events, as the system actor, correlation
--    0196-dentist-own-facility-opening, source hid-0196: one
--    auth.role-permission.add row (reason "DEN-1 dentist own-facility opening
--    (Q156 A)"). Details hold the codes, the migration and the decision.
-- A NOTICE counts the active memberships at real (not sealed) facilities that
-- gain the code (numbers only; there is no stop: dentists are added only while
-- DENTAL_ENABLED is on, and a real facility has none before the go-live).
--
-- Locks (as 0169), taken first, NOWAIT, in one attempt made up to 50 times 100
-- ms apart (one attempt, no sleep, when this transaction already holds an
-- earlier migration's blocking locks); then 55P03 "0196: ... run the release
-- again at a quieter time": SHARE ROW EXCLUSIVE on auth.role_permissions; ROW
-- EXCLUSIVE on audit.events; ROW SHARE on auth.roles, auth.permissions,
-- auth.accounts, identity.staff_facility_memberships, identity.organizations,
-- identity.facilities and identity.patients (the row's and the audit row's
-- foreign keys); ACCESS SHARE on auth.account_roles,
-- identity.sealed_demo_members and identity.sealed_qa_members (the count).
--
-- Old images on this schema: identity-api's own-facility opening already
-- decides by the code; nothing else reads it.
--
-- Undo (by hand, only if the owner signs it): delete the one row; the
-- dentists' own-facility grants then end as 0139's role removal ends them.
--
-- The whole file is one statement (do $den0196$):
-- 0. The locks.
-- 1. Preconditions (55000, nothing applied): markers of 0131 (its code,
--    active, and identity.own_facility_basis) and of 0194 (the dentist role,
--    active, with ehr.dental.write); "0196: already applied" when the row and
--    its audit row are there (the only change); "0196: the role table is not
--    in the reviewed state" for a half state; doctor, clinician and nurse
--    still hold the code.
-- 2. O1, O2.
-- 3. Post-checks: the code's holders are 0131's three roles plus dentist,
--    plus any role another Release D lane's own file adds (subset rule); no
--    other role row changed; one audit row.

do $den0196$
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
  v_reason constant text := 'DEN-1 dentist own-facility opening (Q156 A)';
  v_correlation constant text := '0196-dentist-own-facility-opening';
  v_code constant text := 'identity.patient.open-own-facility';
  v_rows_before text;
  v_gain integer;
begin
  -- 0. The locks, NOWAIT.
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table auth.role_permissions in share row exclusive mode nowait;
  lock table audit.events in row exclusive mode nowait;
  lock table auth.roles, auth.permissions, auth.accounts, identity.staff_facility_memberships,
             identity.organizations, identity.facilities, identity.patients
    in row share mode nowait;
  lock table auth.account_roles, identity.sealed_demo_members, identity.sealed_qa_members
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0196: auth.role_permissions, audit.events or a table 0196''s row checks or counts (the roles, '
          || 'codes, accounts, staff memberships, organizations, facilities, patients, role assignments and sealed '
          || 'member lists) is busy, and this transaction already holds an earlier migration''s locks, so it does '
          || 'not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0196: auth.role_permissions, audit.events or a table 0196''s row checks or counts (the roles, '
          || 'codes, accounts, staff memberships, organizations, facilities, patients, role assignments and sealed '
          || 'member lists) stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if not exists (select 1 from auth.permissions where code = v_code and active)
     or to_regprocedure('identity.own_facility_basis(uuid,uuid)') is null then
    raise exception using errcode = '55000', message = '0196: 0131 must be applied first';
  end if;
  if not exists (select 1 from auth.roles where code = 'dentist' and active)
     or not exists (select 1 from auth.role_permissions where role_code = 'dentist' and permission_code = 'ehr.dental.write') then
    raise exception using errcode = '55000', message = '0196: 0194 must be applied first';
  end if;
  if exists (select 1 from auth.role_permissions where role_code = 'dentist' and permission_code = v_code) then
    if (select count(*) from audit.events event_row where event_row.correlation_id = v_correlation) = 1 then
      raise exception using errcode = '55000', message = '0196: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0196: the role table is not in the reviewed state (the dentist holds the code without 0196''s '
        || 'audit row); nothing applied';
  end if;
  if exists (select 1 from audit.events event_row where event_row.correlation_id = v_correlation) then
    raise exception using errcode = '55000',
      message = '0196: the role table is not in the reviewed state (0196''s audit row without its row); nothing applied';
  end if;
  -- 0131's holders are still there (others' additions accepted).
  if (select count(*) from auth.role_permissions grant_row
       where grant_row.permission_code = v_code and grant_row.role_code in ('doctor', 'clinician', 'nurse')) <> 3 then
    raise exception using errcode = '55000',
      message = '0196: doctor, clinician and nurse no longer all hold the own-facility opening; nothing applied';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into v_rows_before from auth.role_permissions grant_row;

  -- 2. O1 the row.
  insert into auth.role_permissions (role_code, permission_code) values ('dentist', 'identity.patient.open-own-facility');

  -- O2 the audit row.
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  values (v_correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission', 'dentist/' || v_code,
          'healthcare-operations', v_reason, 'migration', 'hid-0196',
          jsonb_build_object('roleCode', 'dentist', 'permissionCode', v_code, 'migration', '0196',
            'decision', 'Q156 A (owner, 25 November 2026)'));

  -- 3. Post-checks.
  if (select count(*) from auth.role_permissions grant_row
       where grant_row.permission_code = v_code and grant_row.role_code in ('doctor', 'clinician', 'nurse', 'dentist')) <> 4
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row
          where not (grant_row.role_code = 'dentist' and grant_row.permission_code = v_code))
        is distinct from v_rows_before
     or (select count(*) from audit.events event_row
          where event_row.correlation_id = v_correlation and event_row.actor_type = 'system'
            and event_row.actor_account_id is null and event_row.facility_id is null
            and event_row.patient_id is null) <> 1 then
    raise exception using errcode = '55000', message = '0196: post-check failed';
  end if;

  select count(distinct membership.id) into v_gain
    from identity.staff_facility_memberships membership
    join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
     and assignment.role_code = 'dentist'
   where membership.active and membership.facility_id is not null
     and not identity.sealed_demo_facility(membership.facility_id)
     and not identity.sealed_qa_facility(membership.facility_id);
  raise notice '0196: dentists open this facility''s own patients (Q156 A): % active staff memberships at real facilities gain identity.patient.open-own-facility; one role row, one audit row.',
    v_gain;
end
$den0196$;
