-- 0129 Keep a staff member's chosen facility across reload (port of main 0089,
-- hid-system#73; coordinator's tasks of 17 Nov 2026 on hid-system#258, number
-- booked there; the design note on #258 and the decisions on it: the setting
-- STAFF_FACILITY_SELECTION_MODE off | keep | ask, off by default; a failed
-- read answers 'unavailable'; foreign keys as #262's). The declaration is
-- signed separately. It needs 0001-0123 applied; it uses nothing 0124-0128
-- add.
--
-- The gap: a staff member with two or more facilities on one site chooses
-- one with POST /auth/facility, and the Identity API stores nothing. A reload,
-- a new tab, a restored browser or a refresh after the 15-minute access token
-- reports the primary facility again, the website adopts it without saying
-- so, and every request after that (patients, requests, lab and pharmacy
-- lists) runs there, because the website sends the facility it was given as
-- X-Facility-ID.
--
-- Staging differs from main, so this file is written on staging's tables,
-- not copied: staging has no auth.lock_account_sessions (main 0073), no staff
-- two-step sign-in (main 0088) and no one-active-membership-per-facility
-- index (main 0087). Table, keys and trigger events are main 0089's; the
-- guard also checks the account and the token version, and uses search_path
-- pg_catalog, pg_temp with every name qualified; the grants are made here.
--
-- The change:
-- D1 auth.session_facility_selection: one row per sign-in, keyed by its
--    session family (family_id, the id of the family's first session:
--    refresh rotates the session row and keeps the family, so the choice
--    survives a refresh, and another sign-in of the same account has its
--    own), with account_id, facility_id, membership_id, selected_at and
--    row_version. Four foreign keys, all ON DELETE RESTRICT: auth.sessions,
--    auth.accounts, identity.facilities, and the membership by (id,
--    facility_id, account_id) through 0002's unique key, so the membership
--    is the account's at that facility and the demo and QA seals (0098,
--    0123) hold through it. No row-level security, like auth.sessions and
--    #262's auth.session_single_sign_on: access is by grant only. Nothing
--    deletes rows: the guard refuses a delete, so a future clean-up of old
--    sign-ins must come with a migration (the table comment says so).
-- D2 The row is only the default GET /auth/session and POST /auth/refresh
--    report; it grants nothing. Every facility-scoped request still carries
--    X-Facility-ID, which the Identity guard checks against the actor's
--    active memberships; the access token has no facility claim; and the
--    Identity API compares the stored facility, by facility id with the
--    guard's first-match rule, with the actor's facilities as resolved from
--    the database for the session's own product on every read, so an ended
--    or held membership, a closed facility or a disabled account is never
--    reported (it reports 'reselect' and keeps the row).
-- D3 auth.guard_session_facility_selection_change() and the trigger
--    session_facility_selection_guard, BEFORE INSERT OR UPDATE OR DELETE for
--    each row. It refuses (55000 SESSION_FACILITY_SELECTION_IMMUTABLE) a
--    delete, and an update that moves a row to another sign-in or account.
--    It admits a row (else 23514 SESSION_FACILITY_SELECTION_INVALID) only
--    when all of these hold: family_id is the first session of a staff
--    sign-in of that account; a session of that sign-in is live (not
--    revoked, not expired, before its absolute end) at the account's current
--    token version, and the account is active and not disabled (main does
--    not check the account); the membership is the account's at that
--    facility, active and not held; its staff record is the account's,
--    active and verified (lower(btrim(verification_status)) in 'verified',
--    'approved', 'active': ACTIVE_STAFF_VERIFICATION_STATUSES in
--    services/identity-api/src/auth/auth-policy.ts, which the staff context
--    applies); its organisation and its facility, of that organisation, are
--    active. These are the staff context's own conditions
--    (CurrentStaffContextService, STAFF_MEMBERSHIPS_SQL) and TokenService's
--    session check. It is a write-time check: sign-out, rotation, account
--    changes and workforce changes are not serialised with it, so a row can
--    outlive its sign-in or membership; every read re-checks (D2). The
--    admission is one SQL expression, so the guard's first firing plans every
--    query in it (section 5 fires it once).
-- D4 SECURITY INVOKER (the Identity runtime already reads every table the
--    guard reads), search_path pg_catalog, pg_temp with every name
--    schema-qualified, revoked from PUBLIC and granted to no role (a trigger
--    needs no EXECUTE to fire). No function of 0001-0123 is replaced or
--    called, so there are no md5 pins of earlier bodies.
-- D5 Grants, here when the role exists and identically in runtime-grants.sql
--    (production never re-runs runtime-grants.sql): SELECT, INSERT, UPDATE on
--    the table to hid_identity_runtime (its API login inherits them); no
--    DELETE or TRUNCATE; nothing to PUBLIC or to any other role. The runtime
--    writes with the presented session locked FOR SHARE, which needs the
--    UPDATE on auth.sessions it already holds.
-- D6 No migration number appears inside the guard's body, so a renumber
--    changes only this file's name, header, messages and the ledgers.
-- What the Identity API does with it, behind STAFF_FACILITY_SELECTION_MODE
-- (off, the default and exactly today; keep; ask): POST /auth/facility stores
-- the choice with its auth.facility.select audit row in one transaction;
-- GET /auth/session and POST /auth/refresh add facilitySelection (selected,
-- reselect, default in 'ask' only, unavailable on a failed read); service
-- sessions, patients, account-only sessions and OIDC bearer callers read
-- nothing and get no field. With the setting on and this table or any one of
-- its three grants missing, identity-api refuses to start.
--
-- 0. Preconditions (catalog reads only; each is a presence check that raises
--    when the thing is absent, never a comparison that can be null; each
--    failure raises 55000 or 42501 and nothing is applied): 0001-0123
--    applied (0123's identity.sealed_qa_members as the marker); 0129 not
--    applied (no table, guard or trigger of that name); every column the
--    guard and the keys read, by name and type; the primary keys on id of
--    auth.sessions, auth.accounts and identity.facilities, and the unique
--    key (id, facility_id, account_id) of identity.staff_facility_memberships;
--    the applier owns, or inherits from the owner of, those four tables (to
--    lock them and reference them), and may create in schema auth.
-- 1. SHARE ROW EXCLUSIVE on those four tables, taken NOWAIT and retried
--    every 100 ms for at most 5 seconds, else 55P03 with nothing applied.
-- 2. The table and its comment.
-- 3. The guard, its comment and the trigger; the guard revoked from PUBLIC.
-- 4. Grants (D5).
-- 5. Post-checks: the columns, the primary key, the four foreign keys and
--    their actions, no row-level security; the guard's body (md5),
--    attributes, owner and ACL; the trigger, enabled, the only one; the
--    table's exact privileges, whether or not hid_identity_runtime exists (a
--    default privilege to any other role stops the file, naming the ACL);
--    then the guard is fired once with random ids
--    and must answer exactly 23514 SESSION_FACILITY_SELECTION_INVALID (plpgsql
--    plans a query only when it first runs, so this proves every column the
--    guard reads exists, and the foreign keys, checked after a BEFORE
--    trigger, are never reached).
--
-- Locks: the four foreign keys need SHARE ROW EXCLUSIVE on auth.sessions,
-- auth.accounts, identity.facilities and identity.staff_facility_memberships,
-- held to commit. Section 1 takes them first, NOWAIT, so the migration never
-- waits while holding a lock and no request queues behind a waiting lock;
-- behind an open write on any of the four (a sign-in, a refresh, a sign-out,
-- an account or workforce change) it tries again 100 ms later, and after 50
-- attempts (5 seconds) it stops the release (55P03, nothing applied; the same
-- release can run again, see the declaration's RECOVERY). Reads are never
-- blocked. Once taken, sign-ins, refreshes, sign-outs and account or
-- workforce changes wait until commit: a few milliseconds when 0129 releases
-- alone (the table is new and empty, so nothing is scanned); if it ships with
-- other pending migrations, the runner's dry run of all of them in one
-- transaction holds the locks until that dry run ends. Section 0 takes no
-- table lock.
--
-- Old services on this schema: nothing reads or writes the new table until
-- identity-api runs with STAFF_FACILITY_SELECTION_MODE keep or ask; today's
-- image and the new image with the setting off answer exactly as before. The
-- foreign keys add a check to deletes of sign-ins, accounts, facilities and
-- memberships (nothing deletes them on staging) and to a change of a
-- membership's id, facility or account (nothing changes them). Applied
-- migrations before 0129 are immutable.

-- 0. Preconditions.
do $$
declare
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
begin
  -- a. 0001-0123 applied: 0123's sealed QA members table.
  if not exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = 'identity' and relation.relname = 'sealed_qa_members'
                    and relation.relkind = 'r') then
    raise exception using errcode = '55000', message = '0129: 0001-0123 must be applied first';
  end if;
  -- b. Not applied yet.
  if exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
              where namespace.nspname = 'auth' and relation.relname = 'session_facility_selection')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'auth' and proc.proname = 'guard_session_facility_selection_change')
     or exists (select 1 from pg_trigger trigger_row where trigger_row.tgname = 'session_facility_selection_guard') then
    raise exception using errcode = '55000', message = '0129: already applied';
  end if;
  -- c. Every column the guard and the foreign keys read, by name and type.
  -- The decision is an EXISTS over the absent columns (never null); the list
  -- only names them.
  with expected(schema_name, relation_name, column_name, type_name) as (values
         ('auth', 'sessions', 'id', 'uuid'),
         ('auth', 'sessions', 'account_id', 'uuid'),
         ('auth', 'sessions', 'family_id', 'uuid'),
         ('auth', 'sessions', 'session_kind', 'text'),
         ('auth', 'sessions', 'revoked_at', 'timestamp with time zone'),
         ('auth', 'sessions', 'expires_at', 'timestamp with time zone'),
         ('auth', 'sessions', 'absolute_expires_at', 'timestamp with time zone'),
         ('auth', 'sessions', 'account_token_version', 'bigint'),
         ('auth', 'accounts', 'id', 'uuid'),
         ('auth', 'accounts', 'status', 'text'),
         ('auth', 'accounts', 'disabled_until', 'timestamp with time zone'),
         ('auth', 'accounts', 'token_version', 'bigint'),
         ('identity', 'staff_facility_memberships', 'id', 'uuid'),
         ('identity', 'staff_facility_memberships', 'account_id', 'uuid'),
         ('identity', 'staff_facility_memberships', 'facility_id', 'uuid'),
         ('identity', 'staff_facility_memberships', 'organization_id', 'uuid'),
         ('identity', 'staff_facility_memberships', 'staff_id', 'uuid'),
         ('identity', 'staff_facility_memberships', 'active', 'boolean'),
         ('identity', 'staff_facility_memberships', 'migration_hold_reason', 'text'),
         ('identity', 'staff', 'id', 'uuid'),
         ('identity', 'staff', 'account_id', 'uuid'),
         ('identity', 'staff', 'active', 'boolean'),
         ('identity', 'staff', 'verification_status', 'text'),
         ('identity', 'organizations', 'id', 'uuid'),
         ('identity', 'organizations', 'active', 'boolean'),
         ('identity', 'facilities', 'id', 'uuid'),
         ('identity', 'facilities', 'organization_id', 'uuid'),
         ('identity', 'facilities', 'active', 'boolean')),
       absent as (
         select expected.* from expected
          where not exists (
            select 1 from pg_attribute attribute_row
              join pg_class relation on relation.oid = attribute_row.attrelid
              join pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = expected.schema_name and relation.relname = expected.relation_name
               and relation.relkind = 'r' and attribute_row.attname = expected.column_name
               and attribute_row.attnum > 0 and not attribute_row.attisdropped
               and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name))
  select exists (select 1 from absent),
         (select string_agg(format('%s.%s.%s %s', absent.schema_name, absent.relation_name, absent.column_name,
                   absent.type_name), '; ') from absent)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0129: a column this migration relies on is missing or of another type: %s', missing);
  end if;
  -- d. The keys the foreign keys reference: the primary key on id of the
  -- sign-ins, accounts and facilities, and the memberships' unique
  -- (id, facility_id, account_id) (0002), each by its exact column set.
  if exists (
    select 1
      from (values
        ('auth', 'sessions', array['id'], 'p'),
        ('auth', 'accounts', array['id'], 'p'),
        ('identity', 'facilities', array['id'], 'p'),
        ('identity', 'staff_facility_memberships', array['account_id', 'facility_id', 'id'], 'u'))
           expected(schema_name, relation_name, column_names, constraint_type)
     where not exists (
       select 1 from pg_constraint constraint_row
         join pg_class relation on relation.oid = constraint_row.conrelid
         join pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = expected.schema_name and relation.relname = expected.relation_name
          and constraint_row.contype = expected.constraint_type::"char"
          and (select array_agg(attribute_row.attname::text order by attribute_row.attname::text)
                 from pg_attribute attribute_row
                where attribute_row.attrelid = relation.oid and attribute_row.attnum = any(constraint_row.conkey))
              = expected.column_names
          and cardinality(constraint_row.conkey) = cardinality(expected.column_names))) then
    raise exception using errcode = '55000',
      message = '0129: a key this migration references is missing: the primary key (id) of auth.sessions, auth.accounts '
        || 'or identity.facilities, or the unique (id, facility_id, account_id) of identity.staff_facility_memberships';
  end if;
  -- e. The applier owns, or inherits from the owner of, the four tables it
  -- locks and references, and may create in schema auth.
  with referenced as (
         select relation.oid, namespace.nspname, relation.relname, relation.relowner
           from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
          where (namespace.nspname, relation.relname) in (('auth', 'sessions'), ('auth', 'accounts'),
                  ('identity', 'facilities'), ('identity', 'staff_facility_memberships'))),
       foreign_owner as (
         select referenced.* from referenced where not pg_has_role(applier, referenced.relowner, 'USAGE'))
  select exists (select 1 from foreign_owner) or not has_schema_privilege(applier, 'auth', 'CREATE'),
         (select string_agg(format('%s.%s (owner %s)', foreign_owner.nspname, foreign_owner.relname,
                   pg_get_userbyid(foreign_owner.relowner)), ', ' order by foreign_owner.nspname, foreign_owner.relname)
            from foreign_owner)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501',
      message = format('0129: %s must own, or inherit from the owner of, auth.sessions, auth.accounts, '
        || 'identity.facilities and identity.staff_facility_memberships, and may create in schema auth; it may not act '
        || 'for: %s', current_user, coalesce(missing, 'none (but it may not create in schema auth)'));
  end if;
  raise notice '0129: preconditions checked; applier %; owners auth.sessions=%, auth.accounts=%, identity.facilities=%, identity.staff_facility_memberships=%',
    current_user,
    (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'auth.sessions'::regclass),
    (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'auth.accounts'::regclass),
    (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'identity.facilities'::regclass),
    (select pg_get_userbyid(relation.relowner) from pg_class relation
      where relation.oid = 'identity.staff_facility_memberships'::regclass);
end
$$;

-- 1. The four referenced tables, SHARE ROW EXCLUSIVE, NOWAIT, at most 5 s
-- (see Locks). A failed attempt's subtransaction releases what it took.
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table auth.sessions, auth.accounts, identity.facilities, identity.staff_facility_memberships
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0129: auth.sessions, auth.accounts, identity.facilities or identity.staff_facility_memberships '
            || 'stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

-- 2. The table (D1, D2).
create table auth.session_facility_selection (
  family_id uuid primary key references auth.sessions(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  membership_id uuid not null,
  selected_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  -- The membership is one of this account's, at this facility.
  foreign key (membership_id, facility_id, account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
);
comment on table auth.session_facility_selection is
  'The facility a staff sign-in (session family, keyed by its first session) chose with POST /auth/facility (0129, port of main 0089). Only the default GET /auth/session and POST /auth/refresh report, never an authorization: every request still carries X-Facility-ID, checked against active memberships, and every read re-checks the actor''s current facilities. Written by the Identity runtime only; its guard refuses deletes, so a clean-up of old sign-ins needs a migration.';

-- 3. The guard (D3, D4) and its trigger.
create function auth.guard_session_facility_selection_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'SESSION_FACILITY_SELECTION_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE' then
    if new.family_id is distinct from old.family_id or new.account_id is distinct from old.account_id then
      raise exception using errcode = '55000', message = 'SESSION_FACILITY_SELECTION_IMMUTABLE';
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
    -- staff record active and verified (ACTIVE_STAFF_VERIFICATION_STATUSES);
    -- its organisation and facility active.
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
    raise exception using errcode = '23514', message = 'SESSION_FACILITY_SELECTION_INVALID';
  end if;
  return new;
end
$$;
comment on function auth.guard_session_facility_selection_change() is
  'Guard of auth.session_facility_selection (0129): refuses deletes and moves to another sign-in or account (55000 SESSION_FACILITY_SELECTION_IMMUTABLE); admits a row only for the first session of a live staff sign-in of an active account at its current token version, and an active, unheld membership of that account at that facility with an active verified staff record, active organisation and active facility (else 23514 SESSION_FACILITY_SELECTION_INVALID).';
revoke all on function auth.guard_session_facility_selection_change() from public;
create trigger session_facility_selection_guard
  before insert or update or delete on auth.session_facility_selection
  for each row execute function auth.guard_session_facility_selection_change();

-- 4. Grants (D5; here and in runtime-grants.sql).
revoke all on auth.session_facility_selection from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant select, insert, update on auth.session_facility_selection to hid_identity_runtime;
  end if;
end
$$;

-- 5. Post-checks.
do $$
declare
  table_owner oid := (select relation.relowner from pg_class relation
                       where relation.oid = 'auth.session_facility_selection'::regclass);
  guard oid := 'auth.guard_session_facility_selection_change()'::regprocedure;
  runtime oid := (select role_row.oid from pg_roles role_row where role_row.rolname = 'hid_identity_runtime');
  error_state text;
  error_message text;
  refused boolean := false;
begin
  -- The columns, with their types, NOT NULLs and defaults.
  if ((select array_agg(attribute_row.attname::text || ':' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
          || ':' || attribute_row.attnotnull::text || ':'
          || coalesce(pg_get_expr(column_default.adbin, column_default.adrelid), '-') order by attribute_row.attnum)
         from pg_attribute attribute_row
         left join pg_attrdef column_default
           on column_default.adrelid = attribute_row.attrelid and column_default.adnum = attribute_row.attnum
        where attribute_row.attrelid = 'auth.session_facility_selection'::regclass and attribute_row.attnum > 0
          and not attribute_row.attisdropped)
      = array['family_id:uuid:true:-', 'account_id:uuid:true:-', 'facility_id:uuid:true:-', 'membership_id:uuid:true:-',
              'selected_at:timestamp with time zone:true:clock_timestamp()', 'row_version:bigint:true:1']) is not true then
    raise exception using errcode = '55000', message = '0129: the columns of auth.session_facility_selection are not this file''s';
  end if;
  -- The primary key, the four foreign keys (ON DELETE RESTRICT) and the CHECK, and nothing else.
  if ((select array_agg(constraint_row.contype::text || ' ' || pg_get_constraintdef(constraint_row.oid)
          order by constraint_row.contype, pg_get_constraintdef(constraint_row.oid))
         from pg_constraint constraint_row
        where constraint_row.conrelid = 'auth.session_facility_selection'::regclass)
      = array['c CHECK ((row_version > 0))',
              'f FOREIGN KEY (account_id) REFERENCES auth.accounts(id) ON DELETE RESTRICT',
              'f FOREIGN KEY (facility_id) REFERENCES identity.facilities(id) ON DELETE RESTRICT',
              'f FOREIGN KEY (family_id) REFERENCES auth.sessions(id) ON DELETE RESTRICT',
              'f FOREIGN KEY (membership_id, facility_id, account_id) REFERENCES '
                || 'identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT',
              'p PRIMARY KEY (family_id)']) is not true
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conrelid = 'auth.session_facility_selection'::regclass
                   and (not constraint_row.convalidated or constraint_row.condeferrable)) then
    raise exception using errcode = '55000', message = '0129: the keys of auth.session_facility_selection are not this file''s';
  end if;
  if (select not relation.relrowsecurity and not relation.relforcerowsecurity and relation.relkind = 'r'
        from pg_class relation where relation.oid = 'auth.session_facility_selection'::regclass) is not true then
    raise exception using errcode = '55000', message = '0129: auth.session_facility_selection must have no row-level security';
  end if;
  -- The guard: this file's body, plpgsql, SECURITY INVOKER, volatile, this
  -- search_path, returns trigger, owned with the table, executable by its
  -- owner only.
  if not exists (
    select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
     where proc.oid = guard and language_row.lanname = 'plpgsql' and not proc.prosecdef and proc.provolatile = 'v'
       and proc.prorettype = 'trigger'::regtype and proc.pronargs = 0 and proc.proowner = table_owner
       and proc.proconfig = array['search_path=pg_catalog, pg_temp']
       and md5(proc.prosrc) = 'f77032f5b5082fed66f7b01a3ee34f5a')
     or (select count(*) from pg_proc proc
          where proc.pronamespace = 'auth'::regnamespace and proc.proname = 'guard_session_facility_selection_change') <> 1
     or not exists (select 1 from pg_proc proc where proc.oid = guard and proc.proacl is not null)
     or exists (select 1 from pg_proc proc, aclexplode(proc.proacl) privilege
                 where proc.oid = guard and privilege.grantee <> proc.proowner) then
    raise exception using errcode = '55000', message = '0129: the guard is not as this file makes it';
  end if;
  -- The trigger: BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW (tgtype 31),
  -- enabled, the table's only one.
  if not exists (select 1 from pg_trigger trigger_row
                  where trigger_row.tgrelid = 'auth.session_facility_selection'::regclass
                    and trigger_row.tgname = 'session_facility_selection_guard' and trigger_row.tgfoid = guard
                    and not trigger_row.tgisinternal and trigger_row.tgenabled = 'O' and trigger_row.tgtype = 31)
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'auth.session_facility_selection'::regclass and not trigger_row.tgisinternal) <> 1 then
    raise exception using errcode = '55000', message = '0129: the guard''s trigger is not as this file makes it';
  end if;
  -- The table's privileges: its owner, and SELECT, INSERT and UPDATE (not
  -- grantable) for hid_identity_runtime when that role exists; nothing else,
  -- PUBLIC included. "is not distinct from": on a fresh install the role does
  -- not exist yet, runtime is null, and every grantee but the owner must stop
  -- the file (with "=" the comparison would be null and let a default
  -- privilege's SELECT, INSERT or UPDATE to another role through).
  if exists (select 1 from pg_class relation, aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
              where relation.oid = 'auth.session_facility_selection'::regclass
                and privilege.grantee <> relation.relowner
                and not (privilege.grantee is not distinct from runtime
                         and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE') and not privilege.is_grantable))
     or (runtime is not null
         and (select count(*) from pg_class relation, aclexplode(relation.relacl) privilege
               where relation.oid = 'auth.session_facility_selection'::regclass and privilege.grantee = runtime) <> 3) then
    raise exception using errcode = '55000',
      message = format('0129: the privileges on auth.session_facility_selection are not section 4''s: %s',
        (select coalesce(relation.relacl::text, 'null') from pg_class relation
          where relation.oid = 'auth.session_facility_selection'::regclass));
  end if;
  -- Fire the guard once, with random ids: no such sign-in, so it must refuse
  -- with exactly 23514 SESSION_FACILITY_SELECTION_INVALID. Its first run plans
  -- every query in it, so a column it reads that is missing would answer
  -- 42703 here instead; the foreign keys, checked after a BEFORE trigger, are
  -- never reached. The sub-block rolls the attempt back.
  begin
    insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
    values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid());
  exception when others then
    get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
    refused := true;
  end;
  if not refused or error_state is distinct from '23514' or error_message is distinct from 'SESSION_FACILITY_SELECTION_INVALID' then
    raise exception using errcode = '55000',
      message = format('0129: the guard must refuse a row for no sign-in with 23514 SESSION_FACILITY_SELECTION_INVALID; '
        || 'it answered %s %s', coalesce(error_state, 'no error'), coalesce(error_message, '(the row was admitted)'));
  end if;
  if exists (select 1 from auth.session_facility_selection) then
    raise exception using errcode = '55000', message = '0129: auth.session_facility_selection is not empty';
  end if;
end
$$;
