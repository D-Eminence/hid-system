-- 0140: keep the open patient across a reload (SX-8, Akos P1-2, Release B;
-- the planned contract's "SX-8: Keep the open patient across a reload"). The
-- owner's default "Open patient remembered for 8 hours" applies. Booked as
-- 0140 on hid-system#258; numbers are given in merge order at the Release B
-- cut-off. This file requires 0001-0137 applied (it is built on 0129's
-- per-sign-in row).
--
-- Health IDs stay out of page addresses and the app stores nothing on the
-- device, so only the server can remember which patient a staff sign-in had
-- open: for one sign-in, at one facility, for at most 8 hours (the staff
-- sign-in's own longest life).
--
-- D1 auth.session_open_patient: one row per sign-in, keyed by its session
--    family as 0129's auth.session_facility_selection is (family_id, the id
--    of the family's first session: refresh rotates the session and keeps
--    the family), with account_id, facility_id, membership_id, patient_id,
--    purpose ('direct-care' or 'emergency'), set_at, expires_at (at most 8
--    hours after set_at) and row_version. Foreign keys as 0129's, all ON
--    DELETE RESTRICT, plus identity.patients. No row-level security, like
--    0129's table and auth.sessions: access is by grant only.
-- D2 The row grants nothing. Identity stores it only after the same decision
--    as POST /identity/authorization/check for read_records (its no-notice
--    precheck), and every session read that finds it checks again; every
--    chart read still carries X-Facility-ID and goes through the check.
-- D3 auth.guard_session_open_patient_change() and the trigger
--    session_open_patient_guard, BEFORE INSERT OR UPDATE: an update cannot
--    move a row to another sign-in or account (55000
--    SESSION_OPEN_PATIENT_IMMUTABLE); a row is admitted (else 23514
--    SESSION_OPEN_PATIENT_INVALID) only for the first session of a live
--    staff sign-in of an active account at its current token version, and
--    an active, unheld membership of that account at that facility with an
--    active verified staff record, active organisation and active facility
--    (0129's admission, unchanged). The patient is the access check's (D2):
--    the guard runs as the Identity runtime, which reads a patient only
--    through row-level security; the foreign key keeps it a real patient.
--    Unlike 0129's row, this one is deleted: by the user's clear, a move to
--    another facility, or an ended or expired read. Sign-out, sign-out
--    everywhere and the sign-in's end delete nothing: the row stays, unread
--    (only a live session of the sign-in reads it), until a sweep.
-- D4 The guard is SECURITY INVOKER with search_path pg_catalog, pg_temp and
--    every name qualified (the Identity runtime reads every table it reads).
-- D5 Grants: SELECT, INSERT, UPDATE and DELETE to hid_identity_runtime where
--    it exists (the runtime roles' bootstrap may come after the
--    migrations), here and in runtime-grants.sql; nothing to any other role.
-- D6 auth.session_open_patient_target_exists(patient uuid): whether a patient
--    row with that id exists, whatever its status, for the Identity runtime
--    only. Identity asks it before the access check, so that a UUID that is
--    no patient gets the same 403 and stores nothing (the check's audit row
--    names the patient, and audit.events' foreign key would refuse it). It
--    answers only true or false and is never sent to the caller. SQL,
--    STABLE, SECURITY DEFINER owned by identity.patients' owner (that table's
--    row-level security is not forced), search_path pg_catalog, pg_temp.
--
-- Locks: SHARE ROW EXCLUSIVE on auth.sessions, auth.accounts,
-- identity.facilities, identity.staff_facility_memberships and
-- identity.patients (the foreign keys of a new, empty table), held to
-- commit. That is every existing table this file locks (pg_locks before
-- commit), at the strongest mode it takes. Taken first, NOWAIT: a busy table
-- fails the attempt at once and its subtransaction releases what it took;
-- the attempt is made again every 100 ms for at most 5 seconds, then 55P03
-- (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes (the runner's
-- dry run), one attempt and no sleep: 55P03 at once, nothing applied.
-- Indexes are locked only by planning.
--
-- Old services on this schema: today's identity-api never reads or writes
-- the table. The identity-api of this branch uses it only with
-- STAFF_OPEN_PATIENT_ENABLED=true, and refuses to start with that setting
-- while the table or a grant is missing.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1. The table (D1).
-- 2. The guard and its trigger (D3, D4).
-- 3. Grants (D5).
-- 3b. The patient existence check (D6).
-- 4. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regclass('auth.session_facility_selection') is null
     or to_regprocedure('identity.qoreid_nin_record_used(character,text)') is null then
    raise exception using errcode = '55000', message = '0140: 0001-0137 must be applied first';
  end if;
  if to_regclass('auth.session_open_patient') is not null
     or to_regprocedure('auth.guard_session_open_patient_change()') is not null then
    raise exception using errcode = '55000', message = '0140: already applied';
  end if;
  select string_agg(expected.table_name || '.' || expected.column_name, ', ') into mismatch
    from (values
      ('auth.sessions', 'family_id', 'uuid'), ('auth.sessions', 'account_id', 'uuid'),
      ('auth.sessions', 'session_kind', 'text'), ('auth.sessions', 'revoked_at', 'timestamp with time zone'),
      ('auth.sessions', 'expires_at', 'timestamp with time zone'),
      ('auth.sessions', 'absolute_expires_at', 'timestamp with time zone'),
      ('auth.sessions', 'account_token_version', 'bigint'),
      ('auth.accounts', 'token_version', 'bigint'), ('auth.accounts', 'status', 'text'),
      ('auth.accounts', 'disabled_until', 'timestamp with time zone'),
      ('identity.patients', 'status', 'text')) expected(table_name, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = to_regclass(expected.table_name)
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0140: these columns are not as this file reads them: ' || mismatch;
  end if;
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'identity.staff_facility_memberships'::regclass
                    and constraint_row.contype in ('u', 'p')
                    and (select array_agg(attribute.attname::text order by attribute.attname)
                           from pg_attribute attribute
                          where attribute.attrelid = constraint_row.conrelid
                            and attribute.attnum = any (constraint_row.conkey))
                        = array['account_id', 'facility_id', 'id']) then
    raise exception using errcode = '55000', message = '0140: identity.staff_facility_memberships has no unique key on (id, facility_id, account_id)';
  end if;
end
$$;

-- 0b. Locks (see Locks), NOWAIT, at most 5 s; one attempt when this
-- transaction already holds an earlier migration's locks.
do $locks$
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
begin
  loop
    attempt := attempt + 1;
    begin
      lock table auth.sessions, auth.accounts, identity.facilities, identity.staff_facility_memberships,
        identity.patients in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0140: auth.sessions, auth.accounts, identity.facilities, the staff memberships or identity.patients is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0140: auth.sessions, auth.accounts, identity.facilities, the staff memberships or identity.patients stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The table (D1).
create table auth.session_open_patient (
  family_id uuid primary key references auth.sessions(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  membership_id uuid not null,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  purpose text not null check (purpose in ('direct-care', 'emergency')),
  set_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  row_version bigint not null default 1 check (row_version > 0),
  check (expires_at > set_at and expires_at <= set_at + interval '8 hours'),
  -- The membership is one of this account's, at this facility.
  foreign key (membership_id, facility_id, account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
);
create index session_open_patient_patient_idx on auth.session_open_patient (patient_id);
comment on table auth.session_open_patient is
  'The patient a staff sign-in (session family, keyed by its first session) had open at one facility, for at most 8 hours (0140, SX-8). Only what GET /auth/session reports, after the access check is run again; never an authorization. Written by the Identity runtime only; deleted by the user''s clear, a move to another facility and an ended or expired read. Sign-out deletes nothing: the row stays, unread, until a sweep.';

-- 2. The guard (D3, D4) and its trigger.
create function auth.guard_session_open_patient_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.family_id is distinct from old.family_id or new.account_id is distinct from old.account_id then
      raise exception using errcode = '55000', message = 'SESSION_OPEN_PATIENT_IMMUTABLE';
    end if;
  end if;
  -- One expression: its first run plans all three queries.
  if not (
    -- The sign-in: the family's first session, a staff session of this account.
    exists (
      select 1 from auth.sessions first_session
       where first_session.id = new.family_id and first_session.family_id = new.family_id
         and first_session.account_id = new.account_id and first_session.session_kind = 'staff')
    -- Live: a session of the family unrevoked and unexpired, at the account's
    -- current token version; the account active and not disabled.
    and exists (
      select 1 from auth.sessions live_session
        join auth.accounts account_row on account_row.id = live_session.account_id
       where live_session.family_id = new.family_id and live_session.account_id = new.account_id
         and live_session.session_kind = 'staff' and live_session.revoked_at is null
         and live_session.expires_at > clock_timestamp() and live_session.absolute_expires_at > clock_timestamp()
         and live_session.account_token_version = account_row.token_version
         and account_row.status = 'active'
         and (account_row.disabled_until is null or account_row.disabled_until <= clock_timestamp()))
    -- The membership: this account's at this facility, active, not held; its
    -- staff record active and verified; its organisation and facility active.
    and exists (
      select 1 from identity.staff_facility_memberships membership
        join identity.staff staff_row
          on staff_row.id = membership.staff_id and staff_row.account_id = membership.account_id
        join identity.organizations organization_row on organization_row.id = membership.organization_id
        join identity.facilities facility
          on facility.id = membership.facility_id and facility.organization_id = membership.organization_id
       where membership.id = new.membership_id and membership.account_id = new.account_id
         and membership.facility_id = new.facility_id
         and membership.active and membership.migration_hold_reason is null
         and staff_row.active and lower(btrim(staff_row.verification_status)) in ('verified', 'approved', 'active')
         and organization_row.active and facility.active)
  ) then
    raise exception using errcode = '23514', message = 'SESSION_OPEN_PATIENT_INVALID';
  end if;
  return new;
end
$$;
comment on function auth.guard_session_open_patient_change() is
  'Guard of auth.session_open_patient (0140): refuses a move to another sign-in or account (55000 SESSION_OPEN_PATIENT_IMMUTABLE); admits a row only for the first session of a live staff sign-in of an active account at its current token version, and an active, unheld membership of that account at that facility with an active verified staff record, active organisation and active facility (else 23514 SESSION_OPEN_PATIENT_INVALID). The patient is the access check''s.';
revoke all on function auth.guard_session_open_patient_change() from public;
create trigger session_open_patient_guard
  before insert or update on auth.session_open_patient
  for each row execute function auth.guard_session_open_patient_change();

-- 3. Grants (D5; here and in runtime-grants.sql).
revoke all on auth.session_open_patient from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant select, insert, update, delete on auth.session_open_patient to hid_identity_runtime;
  end if;
end
$$;

-- 3b. The patient existence check (D6).
create function auth.session_open_patient_target_exists(requested_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from identity.patients patient_row where patient_row.id = requested_patient_id)
$$;
comment on function auth.session_open_patient_target_exists(uuid) is
  'Whether a patient row with this id exists, whatever its status (0140, SX-8, D6). For the Identity runtime only: asked before POST /auth/open-patient''s access check, so that a UUID that is no patient gets the same 403 as a refused patient. Never sent to the caller.';
revoke all on function auth.session_open_patient_target_exists(uuid) from public;
do $$
declare
  patients_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'identity.patients'::regclass);
begin
  if patients_owner <> current_user then
    execute format('alter function auth.session_open_patient_target_exists(uuid) owner to %I', patients_owner);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function auth.session_open_patient_target_exists(uuid) to hid_identity_runtime;
  end if;
end
$$;

-- 4. Post-checks.
do $$
declare
  offender text;
begin
  if (select relowner from pg_class where oid = 'auth.session_open_patient'::regclass)
       <> (select oid from pg_roles where rolname = current_user)
     or (select relrowsecurity from pg_class where oid = 'auth.session_open_patient'::regclass) then
    raise exception using errcode = '55000', message = '0140: auth.session_open_patient is not as created';
  end if;
  if (select count(*) from pg_proc proc
        where proc.oid = 'auth.guard_session_open_patient_change()'::regprocedure
          and not proc.prosecdef
          and proc.proowner = (select oid from pg_roles where rolname = current_user)
          and proc.proconfig = array['search_path=pg_catalog, pg_temp']) <> 1
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'auth.session_open_patient'::regclass
                       and trigger_row.tgname = 'session_open_patient_guard'
                       and trigger_row.tgfoid = 'auth.guard_session_open_patient_change()'::regprocedure
                       and trigger_row.tgenabled = 'O') then
    raise exception using errcode = '55000', message = '0140: the guard is not as created';
  end if;
  select string_agg(grantee.rolname || ' ' || privilege.privilege_type, ', ') into offender
    from pg_class relation
    cross join lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    join pg_roles grantee on grantee.oid = privilege.grantee
   where relation.oid = 'auth.session_open_patient'::regclass and privilege.grantee <> relation.relowner
     and not (grantee.rolname = 'hid_identity_runtime'
              and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'));
  if offender is not null then
    raise exception using errcode = '55000', message = format('0140: a role holds a privilege on the table it must not: %s', offender);
  end if;
  if (select count(*) from pg_proc proc
        where proc.oid = 'auth.session_open_patient_target_exists(uuid)'::regprocedure
          and proc.prosecdef and proc.provolatile = 's' and proc.prolang = (select oid from pg_language where lanname = 'sql')
          and proc.proowner = (select relowner from pg_class where oid = 'identity.patients'::regclass)
          and proc.proconfig = array['search_path=pg_catalog, pg_temp']) <> 1 then
    raise exception using errcode = '55000', message = '0140: the patient existence check is not as created';
  end if;
  select string_agg(coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC'), ', ') into offender
    from pg_proc proc
    cross join lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
   where proc.oid = 'auth.session_open_patient_target_exists(uuid)'::regprocedure
     and acl.grantee <> proc.proowner
     and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime');
  if offender is not null then
    raise exception using errcode = '55000', message = format('0140: a role may run the patient existence check it must not: %s', offender);
  end if;
end
$$;
