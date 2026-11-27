-- 0206 Staff preferences (language) and up to 12 Home shortcuts per
-- membership (SX-7 of the Akos EHR plan: P1-8 and the Home shortcuts raised
-- after the review). The planned contract's section "SX-7: Preferences and
-- up to 12 home shortcuts", as corrected by the design note on
-- hid-system#258 (comment 7192268473) with its recommended owner answers
-- taken as defaults. Written on staging at 0cfddcc9 (0001-0153 applied:
-- Release E, live). The number is provisional, given in merge order; no
-- migration number appears inside a function body. This file uses objects
-- of 0001, 0002 and 0074 only, so it does not need 0154-0205 and can be
-- released on its own. The declaration in
-- config/production-schema-compatibility.json is signed separately.
--
-- THE GAP. A staff member's language and Home shortcuts live only in the
-- browser tab today and are lost on reload; SX-5's "My profile" answers
-- canChange.preferences false.
--
-- WHAT IT DOES
-- P1 identity.staff_preferences: one row per account (the person, at every
--    facility): the language (two lower-case letters; identity-api accepts
--    only 'en' until P2-2), a version (1 at the first save, +1 at each), and
--    the last save's Idempotency-Key and request SHA-256. No patient column.
--    The notice choices of the planned contract are NOT stored: no consumer
--    exists (ORD-11, 0159, is not built and reads no preference), so the
--    read answers notices.served false with the defaults and a save that
--    sends notices is refused by identity-api. They come with ORD-11.
-- P2 identity.staff_shortcuts: one row per membership (so per facility):
--    0 to 12 module keys, in the order saved, no NULL, no repeats, each two
--    to forty letters starting lower-case (^[a-z][A-Za-z]{1,39}$), so no
--    UUID, Health ID or match reference can be stored; a version; the last
--    save's key and SHA-256. The keys are SX-1's (identity-api's
--    FACILITY_MODULE_RULES), which grow with each department, so they are
--    NOT listed here: identity-api refuses an unknown key or one the
--    member's roles do not show (SHORTCUT_UNKNOWN, SHORTCUT_NOT_ALLOWED)
--    before it calls the save. The membership is referenced by
--    (id, facility_id, account_id), as 0129 and 0140 do, ON DELETE
--    RESTRICT. No patient column.
--    Both tables: row-level security on, no policy, no privilege for any
--    runtime role: only the three functions below, as the tables' owner,
--    read or write them.
-- P3 Two IMMUTABLE helpers for the shortcut CHECKs (a CHECK cannot hold a
--    subquery): identity.staff_shortcut_keys_valid(text[]) (every element
--    matches the format; no NULL) and identity.staff_shortcut_keys_distinct
--    (text[]) (no element twice). No role may execute them; the CHECKs and
--    the save run them as the owner.
-- P4 identity.read_my_staff_preferences() (SECURITY DEFINER): the caller's
--    language and version ('en' and 0 when never saved) and, when the
--    request names a membership and facility (app.membership_id,
--    app.facility_id) that is the caller's, active and not held for
--    migration, at that facility, that membership's shortcuts (none and
--    version 0 when never saved). It writes no audit row: identity-api
--    writes each read's row (auth.staff-preferences.read on 'session', as
--    SX-5 does from Node).
-- P5 identity.save_my_staff_preferences(language, expected version,
--    Idempotency-Key, request SHA-256) (SECURITY DEFINER): replaces the
--    caller's preferences.
-- P6 identity.save_my_staff_shortcuts(modules, expected version,
--    Idempotency-Key, request SHA-256) (SECURITY DEFINER): replaces the
--    shortcuts of the request's membership at its facility (the caller's,
--    active, not held).
-- P7 Grants: EXECUTE on P4-P6 to hid_identity_runtime only (here and in
--    runtime-grants.sql), as 0139 and 0140 grant Identity's functions;
--    nothing to PUBLIC or any other role.
--
-- The saves (P5, P6)
--   The caller is platform.current_account_id() (an active account that is
--   not disabled), with app.correlation_id set; otherwise 42501
--   STAFF_PREFERENCES_NOT_ALLOWED. P6 also needs the membership as P4 does;
--   otherwise 42501 STAFF_SHORTCUTS_NOT_ALLOWED. Then, 22023 with a stable
--   message: IDEMPOTENCY_KEY_REQUIRED (the key is not 16-128 URL-safe
--   characters or the SHA-256 not 64 lower-case hex), LANGUAGE_NOT_AVAILABLE
--   (not two lower-case letters), SHORTCUTS_TOO_MANY (more than 12),
--   SHORTCUT_INVALID (a NULL, a nested array or a string not of the key
--   format), SHORTCUT_DUPLICATE, STAFF_PREFERENCES_INVALID (no expected
--   version, or one below 0).
--   Each save first takes a transaction advisory lock on its row's key (the
--   account for P5, the membership for P6), so two saves of one row run one
--   after the other, the second reading the first's committed row. Then:
--   the same Idempotency-Key as the row's last save, with the same SHA-256:
--   a replay, answered with the row as it is now and replayed true (and an
--   audit row with replayed true); with another SHA-256: 23505
--   IDEMPOTENCY_KEY_REUSED. Otherwise the expected version must be the
--   row's (0 when there is no row), else 40001 VERSION_CONFLICT; so the
--   second of two first saves racing with different keys answers
--   VERSION_CONFLICT, never a key reuse or a unique violation. Only the
--   last key of a row is kept: an older key sent again is a new save (and
--   its stale version answers VERSION_CONFLICT). The save then writes the
--   row (version + 1) and one audit row in the same transaction:
--     P5 auth.staff-preferences.update, staff actor (subject and account),
--        no membership, organization or facility, resource 'session' with
--        the account id (audit_actor_facility_ck and events_check4 admit
--        exactly this staff row with no facility: an 'auth.' action on
--        'session'), details {language, version};
--     P6 identity.staff-shortcuts.update, staff actor with the account,
--        membership, organization and facility, resource 'staff-membership'
--        with the membership id, details {modules, version}.
--   Refusals raise, so nothing of them is kept; identity-api records them.
--
-- Locks (measured with pg_locks before commit and compared by the suite),
-- taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.accounts and
-- identity.staff_facility_memberships, which CREATE TABLE ... REFERENCES
-- takes on the tables the two new foreign keys reference. The functions are
-- plpgsql with no %rowtype (their bodies are not analysed at CREATE) and the
-- helpers name no table, so nothing else is locked: not audit.events, not
-- any clinical table. Account and membership writes wait for the
-- transaction (milliseconds); every read goes on. A busy table fails the
-- attempt at once, and its subtransaction releases what it took. The
-- attempt is made 50 times, 100 ms apart (about 5 seconds), so the file
-- never waits for one of its locks while holding the other; then 55P03
-- (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes (the
-- runner's dry run applies every pending file in one transaction), one
-- attempt and no sleep: 55P03 at once, nothing applied. Both refusals
-- begin "0206: " and end "run the release again at a quieter time", so the
-- runner's dry run rolls back and tries again (hid-system#306).
--
-- Old images on this schema: nothing calls the new functions. The
-- identity-api of this change keeps its three routes answering 404 while
-- STAFF_PREFERENCES_ENABLED is false (the default), and with it true
-- refuses to start until this file's functions and grants are there.
--
-- Role bootstrap: this file grants its own EXECUTE. A role bootstrap run
-- after it must use a runtime-grants.sql that carries this file's block.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop
-- the three functions, the two tables, then the two helpers. The audit rows
-- stay.
--
-- The whole file is one statement (do $sx7$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): "0206: already applied" when
--    both tables and the five functions are there with the bodies this file
--    makes, and no other identity function of their names; "0206: the
--    schema is not in the reviewed state; nothing applied" for any other
--    state with part of it (or any identity function named like
--    staff_preferences or staff_shortcut); the columns and keys this file
--    uses (0002's auth.accounts and identity.staff_facility_memberships,
--    0001's audit.events), the staff 'auth.'/'session' exemption of the two
--    audit CHECKs (read tolerantly: other values may be there), and the
--    bodies the functions call, md5-pinned.
-- 2. P1-P7.
-- 3. Post-checks (0148's and 0152's form): owners; the tables' columns,
--    CHECK definitions and foreign keys (RESTRICT); row-level security
--    enabled and not forced, no policy, no trigger, no privilege but the
--    owner's; the functions' security, search_path, volatility, body md5
--    and EXECUTE (the owner, and hid_identity_runtime for P4-P6 only).

do $sx7$
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
  v_mismatch text;
  v_present integer;
  v_owner name;
  -- The bodies this file makes (md5 of pg_proc.prosrc).
  v_keys_valid_md5 constant text := '4c6edb9bc0c0bc56bc0418338d38fda1';
  v_keys_distinct_md5 constant text := 'b745006fc65f3e06295608040a3b23ef';
  v_read_md5 constant text := '1591ecd0364fc1dfefcd7b32a033c575';
  v_save_preferences_md5 constant text := 'c9c56010234ab7709b6450b0c7c9120e';
  v_save_shortcuts_md5 constant text := 'cff6f9bd787fde0b23d63a72903ca007';
begin
  -- 0. The locks, NOWAIT.
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table auth.accounts, identity.staff_facility_memberships in share row exclusive mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0206: auth.accounts or identity.staff_facility_memberships (the tables the new foreign keys '
          || 'reference) is busy, and this transaction already holds an earlier migration''s locks, so it does '
          || 'not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0206: auth.accounts or identity.staff_facility_memberships (the tables the new foreign keys '
          || 'reference) stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  select count(*) into v_present
    from (values (to_regclass('identity.staff_preferences')::oid), (to_regclass('identity.staff_shortcuts')::oid),
                 (to_regprocedure('identity.staff_shortcut_keys_valid(text[])')::oid),
                 (to_regprocedure('identity.staff_shortcut_keys_distinct(text[])')::oid),
                 (to_regprocedure('identity.read_my_staff_preferences()')::oid),
                 (to_regprocedure('identity.save_my_staff_preferences(text,bigint,text,text)')::oid),
                 (to_regprocedure('identity.save_my_staff_shortcuts(text[],bigint,text,text)')::oid)) present(object_id)
   where present.object_id is not null;
  if v_present = 7
     and (select count(*) from pg_proc proc
           where (proc.oid, md5(proc.prosrc)) in (
             (to_regprocedure('identity.staff_shortcut_keys_valid(text[])')::oid, v_keys_valid_md5),
             (to_regprocedure('identity.staff_shortcut_keys_distinct(text[])')::oid, v_keys_distinct_md5),
             (to_regprocedure('identity.read_my_staff_preferences()')::oid, v_read_md5),
             (to_regprocedure('identity.save_my_staff_preferences(text,bigint,text,text)')::oid, v_save_preferences_md5),
             (to_regprocedure('identity.save_my_staff_shortcuts(text[],bigint,text,text)')::oid, v_save_shortcuts_md5))) = 5
     and (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname = 'identity'
             and (proc.proname like '%staff\_preferences%' or proc.proname like '%staff\_shortcut%')) = 5 then
    raise exception using errcode = '55000', message = '0206: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity'
                   and (proc.proname like '%staff\_preferences%' or proc.proname like '%staff\_shortcut%')) then
    raise exception using errcode = '55000', message = '0206: the schema is not in the reviewed state; nothing applied';
  end if;

  -- The columns this file uses, by name and type (0002, 0001).
  select string_agg(wanted.relation_name || '.' || wanted.column_name, ', ' order by wanted.relation_name, wanted.column_name)
    into v_mismatch
    from (values
      ('auth.accounts', 'id', 'uuid'), ('auth.accounts', 'subject', 'text'),
      ('identity.staff_facility_memberships', 'id', 'uuid'),
      ('identity.staff_facility_memberships', 'account_id', 'uuid'),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid'),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid'),
      ('identity.staff_facility_memberships', 'active', 'boolean'),
      ('identity.staff_facility_memberships', 'migration_hold_reason', 'text'),
      ('audit.events', 'correlation_id', 'text'), ('audit.events', 'actor_type', 'text'),
      ('audit.events', 'actor_subject', 'text'), ('audit.events', 'actor_account_id', 'uuid'),
      ('audit.events', 'actor_membership_id', 'uuid'), ('audit.events', 'organization_id', 'uuid'),
      ('audit.events', 'facility_id', 'uuid'), ('audit.events', 'action', 'text'), ('audit.events', 'outcome', 'text'),
      ('audit.events', 'resource_type', 'text'), ('audit.events', 'resource_id', 'text'),
      ('audit.events', 'provenance', 'text'), ('audit.events', 'source_system', 'text'),
      ('audit.events', 'details', 'jsonb')
    ) wanted(relation_name, column_name, type_name)
   where to_regclass(wanted.relation_name) is null
      or not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = to_regclass(wanted.relation_name)
                        and attribute.attname = wanted.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000',
      message = '0206: 0001 and 0002 must be applied first (missing or of another type: ' || v_mismatch || ')';
  end if;
  -- The keys the foreign keys reference: auth.accounts' primary key (id), and
  -- the memberships' unique key on exactly (id, facility_id, account_id).
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'auth.accounts'::regclass and constraint_row.contype = 'p'
                    and constraint_row.conkey = array[(select attribute.attnum from pg_attribute attribute
                                                        where attribute.attrelid = 'auth.accounts'::regclass
                                                          and attribute.attname = 'id')]::int2[])
     or not exists (select 1 from pg_constraint constraint_row
                     where constraint_row.conrelid = 'identity.staff_facility_memberships'::regclass
                       and constraint_row.contype in ('p', 'u')
                       and constraint_row.conkey = (select array_agg(attribute.attnum order by wanted.position)::int2[]
                                                      from unnest(array['id', 'facility_id', 'account_id'])
                                                           with ordinality wanted(column_name, position)
                                                      join pg_attribute attribute
                                                        on attribute.attrelid = 'identity.staff_facility_memberships'::regclass
                                                       and attribute.attname = wanted.column_name)) then
    raise exception using errcode = '55000',
      message = '0206: auth.accounts'' primary key or the memberships'' unique key (id, facility_id, account_id) '
        || 'is not as 0002 left it; nothing applied';
  end if;
  -- The audit CHECKs admit a staff 'auth.' row on 'session' with no facility
  -- (the preferences' audit row). Read tolerantly: other values may be there.
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'audit.events'::regclass and constraint_row.contype = 'c'
                    and constraint_row.conname = 'audit_actor_facility_ck'
                    and pg_get_constraintdef(constraint_row.oid)
                        like '%((actor_type = ''staff''::text) AND (action ~~ ''auth.%''::text) AND (resource_type = ANY (ARRAY[%''session''::text%])))%')
     or not exists (select 1 from pg_constraint constraint_row
                     where constraint_row.conrelid = 'audit.events'::regclass and constraint_row.contype = 'c'
                       and constraint_row.conname = 'events_check4'
                       and pg_get_constraintdef(constraint_row.oid)
                           like 'CHECK (((actor_type <> ''staff''::text) OR (action ~~ ''auth.%''::text) OR %') then
    raise exception using errcode = '55000',
      message = '0206: the audit CHECKs no longer admit a staff ''auth.'' row on ''session'' with no facility; '
        || 'nothing applied';
  end if;
  -- The bodies the functions call, as 0001, 0002 and 0074 leave them.
  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000',
      message = '0206: these bodies are not as 0001, 0002 and 0074 left them: ' || v_mismatch || '; nothing applied';
  end if;

  -- P1. The preferences.
  create table identity.staff_preferences (
    account_id uuid not null,
    language text not null default 'en',
    version bigint not null,
    last_idempotency_key text not null,
    last_request_sha256 text not null,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    constraint staff_preferences_pkey primary key (account_id),
    constraint staff_preferences_account_fkey foreign key (account_id)
      references auth.accounts(id) on delete restrict,
    constraint staff_preferences_language_check check (language ~ '^[a-z]{2}$'),
    constraint staff_preferences_version_check check (version > 0),
    constraint staff_preferences_key_check check (last_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    constraint staff_preferences_sha256_check check (last_request_sha256 ~ '^[0-9a-f]{64}$')
  );
  alter table identity.staff_preferences enable row level security;
  revoke all on identity.staff_preferences from public;
  comment on table identity.staff_preferences is
    '0206 (SX-7): one row per account: the staff member''s language (two lower-case letters; identity-api accepts en only until P2-2), a version and the last save''s Idempotency-Key and SHA-256. No patient data. Row-level security on, no policy, no grant: read and written only by identity.read_my_staff_preferences and identity.save_my_staff_preferences, as its owner.';

  -- P3. The helpers of the shortcut CHECKs (made before the table that uses them).
  create function identity.staff_shortcut_keys_valid(requested_keys text[])
  returns boolean
  language sql
  immutable
  parallel safe
  set search_path = pg_catalog, pg_temp
  as $fn$
    select coalesce(bool_and(key_value is not null and key_value ~ '^[a-z][A-Za-z]{1,39}$'), true)
      from pg_catalog.unnest(requested_keys) as key_value
  $fn$;
  comment on function identity.staff_shortcut_keys_valid(text[]) is
    '0206 (SX-7): true when every element is a module key''s shape (^[a-z][A-Za-z]{1,39}$: letters only, so no UUID, Health ID or match reference) and none is NULL; true for an empty array. For the identity.staff_shortcuts CHECK and identity.save_my_staff_shortcuts only.';
  revoke all on function identity.staff_shortcut_keys_valid(text[]) from public;

  create function identity.staff_shortcut_keys_distinct(requested_keys text[])
  returns boolean
  language sql
  immutable
  parallel safe
  set search_path = pg_catalog, pg_temp
  as $fn$
    select count(*) = count(distinct key_value collate "C")
      from pg_catalog.unnest(requested_keys) as key_value
  $fn$;
  comment on function identity.staff_shortcut_keys_distinct(text[]) is
    '0206 (SX-7): true when no element appears twice (and none is NULL). For the identity.staff_shortcuts CHECK and identity.save_my_staff_shortcuts only.';
  revoke all on function identity.staff_shortcut_keys_distinct(text[]) from public;

  -- P2. The shortcuts.
  create table identity.staff_shortcuts (
    membership_id uuid not null,
    facility_id uuid not null,
    account_id uuid not null,
    modules text[] not null,
    version bigint not null,
    last_idempotency_key text not null,
    last_request_sha256 text not null,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    constraint staff_shortcuts_pkey primary key (membership_id),
    -- The membership is this account's, at this facility.
    constraint staff_shortcuts_membership_fkey foreign key (membership_id, facility_id, account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint staff_shortcuts_count_check check (cardinality(modules) <= 12),
    constraint staff_shortcuts_shape_check check (array_ndims(modules) is null
      or (array_ndims(modules) = 1 and array_lower(modules, 1) = 1)),
    constraint staff_shortcuts_no_null_check check (array_position(modules, null) is null),
    constraint staff_shortcuts_keys_check check (identity.staff_shortcut_keys_valid(modules)),
    constraint staff_shortcuts_distinct_check check (identity.staff_shortcut_keys_distinct(modules)),
    constraint staff_shortcuts_version_check check (version > 0),
    constraint staff_shortcuts_key_check check (last_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    constraint staff_shortcuts_sha256_check check (last_request_sha256 ~ '^[0-9a-f]{64}$')
  );
  alter table identity.staff_shortcuts enable row level security;
  revoke all on identity.staff_shortcuts from public;
  comment on table identity.staff_shortcuts is
    '0206 (SX-7): one row per staff membership: 0 to 12 Home shortcut module keys (SX-1''s keys, checked by identity-api; here only their shape, no NULL and no repeats), in the order saved, a version and the last save''s Idempotency-Key and SHA-256. No patient data. Row-level security on, no policy, no grant: read and written only by identity.read_my_staff_preferences and identity.save_my_staff_shortcuts, as its owner.';

  -- P4. The read.
  create function identity.read_my_staff_preferences()
  returns table (preferences_language text, preferences_version bigint, shortcuts_facility_id uuid,
    shortcuts_modules text[], shortcuts_version bigint)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    v_account uuid := platform.current_account_id();
    v_membership uuid := platform.current_membership_id();
    v_facility uuid := platform.current_facility_id();
  begin
    if v_account is null then
      raise exception using errcode = '42501', message = 'STAFF_PREFERENCES_NOT_ALLOWED';
    end if;
    select preference.language, preference.version into preferences_language, preferences_version
      from identity.staff_preferences preference
     where preference.account_id = v_account;
    if not found then
      preferences_language := 'en';
      preferences_version := 0;
    end if;
    if v_membership is not null or v_facility is not null then
      if v_membership is null or v_facility is null
         or not exists (select 1 from identity.staff_facility_memberships membership
                         where membership.id = v_membership and membership.account_id = v_account
                           and membership.facility_id = v_facility and membership.active
                           and membership.migration_hold_reason is null) then
        raise exception using errcode = '42501', message = 'STAFF_SHORTCUTS_NOT_ALLOWED';
      end if;
      shortcuts_facility_id := v_facility;
      select shortcut.modules, shortcut.version into shortcuts_modules, shortcuts_version
        from identity.staff_shortcuts shortcut
       where shortcut.membership_id = v_membership and shortcut.facility_id = v_facility
         and shortcut.account_id = v_account;
      if not found then
        shortcuts_modules := array[]::text[];
        shortcuts_version := 0;
      end if;
    end if;
    return next;
  end
  $fn$;
  comment on function identity.read_my_staff_preferences() is
    '0206 (SX-7): the caller''s language and version (en and 0 when never saved) and, when app.membership_id and app.facility_id name the caller''s active, unheld membership at that facility, its shortcuts (none and version 0 when never saved; nulls when no membership is named). 42501 STAFF_PREFERENCES_NOT_ALLOWED with no active account; 42501 STAFF_SHORTCUTS_NOT_ALLOWED for a membership that is not the caller''s, active, unheld, at that facility. Writes no audit row (identity-api records each read).';
  revoke all on function identity.read_my_staff_preferences() from public;

  -- P5. The preferences save.
  create function identity.save_my_staff_preferences(requested_language text, expected_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (preferences_language text, preferences_version bigint, replayed boolean)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    v_account uuid := platform.current_account_id();
    v_subject text := platform.current_actor_subject();
    v_correlation text := platform.current_correlation_id();
    v_found boolean;
    v_language text;
    v_version bigint;
    v_key text;
    v_sha text;
    v_replayed boolean := false;
  begin
    if v_account is null or v_correlation is null then
      raise exception using errcode = '42501', message = 'STAFF_PREFERENCES_NOT_ALLOWED';
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
    end if;
    if requested_language is null or requested_language !~ '^[a-z]{2}$' then
      raise exception using errcode = '22023', message = 'LANGUAGE_NOT_AVAILABLE';
    end if;
    if expected_version is null or expected_version < 0 then
      raise exception using errcode = '22023', message = 'STAFF_PREFERENCES_INVALID';
    end if;
    -- One save of an account at a time: the second reads the first's committed row.
    perform pg_advisory_xact_lock(hashtextextended('identity.staff-preferences:' || v_account::text, 0));
    select preference.language, preference.version, preference.last_idempotency_key, preference.last_request_sha256
      into v_language, v_version, v_key, v_sha
      from identity.staff_preferences preference
     where preference.account_id = v_account
       for update;
    v_found := found;
    if v_found and v_key = requested_idempotency_key then
      if v_sha is distinct from requested_request_sha256 then
        raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      v_replayed := true;
    elsif coalesce(v_version, 0) <> expected_version then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT';
    elsif v_found then
      update identity.staff_preferences preference
         set language = requested_language, version = preference.version + 1,
             last_idempotency_key = requested_idempotency_key, last_request_sha256 = requested_request_sha256,
             updated_at = clock_timestamp()
       where preference.account_id = v_account
      returning preference.language, preference.version into v_language, v_version;
    else
      insert into identity.staff_preferences (account_id, language, version, last_idempotency_key, last_request_sha256)
      values (v_account, requested_language, 1, requested_idempotency_key, requested_request_sha256)
      returning language, version into v_language, v_version;
    end if;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, action, outcome, resource_type, resource_id,
      provenance, source_system, details
    ) values (
      v_correlation, 'staff', v_subject, v_account, 'auth.staff-preferences.update', 'success', 'session',
      v_account::text, 'application', 'identity-api',
      jsonb_build_object('language', v_language, 'version', v_version)
        || case when v_replayed then jsonb_build_object('replayed', true) else '{}'::jsonb end
    );
    return query select v_language, v_version, v_replayed;
  end
  $fn$;
  comment on function identity.save_my_staff_preferences(text, bigint, text, text) is
    '0206 (SX-7): replaces the caller''s preferences (language: two lower-case letters) with the version read (0 when never saved), under an Idempotency-Key and the request''s SHA-256. The same key and SHA-256 as the last save: the row as it is, replayed true; another SHA-256: 23505 IDEMPOTENCY_KEY_REUSED; another version: 40001 VERSION_CONFLICT. One audit row auth.staff-preferences.update on session, no facility, details language and version (and replayed).';
  revoke all on function identity.save_my_staff_preferences(text, bigint, text, text) from public;

  -- P6. The shortcuts save.
  create function identity.save_my_staff_shortcuts(requested_modules text[], expected_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (shortcuts_facility_id uuid, shortcuts_modules text[], shortcuts_version bigint, replayed boolean)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    v_account uuid := platform.current_account_id();
    v_subject text := platform.current_actor_subject();
    v_correlation text := platform.current_correlation_id();
    v_membership uuid := platform.current_membership_id();
    v_facility uuid := platform.current_facility_id();
    v_organization uuid;
    v_wanted text[];
    v_found boolean;
    v_modules text[];
    v_version bigint;
    v_key text;
    v_sha text;
    v_replayed boolean := false;
  begin
    if v_account is null or v_correlation is null then
      raise exception using errcode = '42501', message = 'STAFF_PREFERENCES_NOT_ALLOWED';
    end if;
    if v_membership is not null and v_facility is not null then
      select membership.organization_id into v_organization
        from identity.staff_facility_memberships membership
       where membership.id = v_membership and membership.account_id = v_account
         and membership.facility_id = v_facility and membership.active
         and membership.migration_hold_reason is null;
    end if;
    if v_organization is null then
      raise exception using errcode = '42501', message = 'STAFF_SHORTCUTS_NOT_ALLOWED';
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
    end if;
    if requested_modules is null or coalesce(array_ndims(requested_modules), 1) <> 1 then
      raise exception using errcode = '22023', message = 'SHORTCUT_INVALID';
    end if;
    if cardinality(requested_modules) > 12 then
      raise exception using errcode = '22023', message = 'SHORTCUTS_TOO_MANY';
    end if;
    if not identity.staff_shortcut_keys_valid(requested_modules) then
      raise exception using errcode = '22023', message = 'SHORTCUT_INVALID';
    end if;
    if not identity.staff_shortcut_keys_distinct(requested_modules) then
      raise exception using errcode = '22023', message = 'SHORTCUT_DUPLICATE';
    end if;
    if expected_version is null or expected_version < 0 then
      raise exception using errcode = '22023', message = 'STAFF_PREFERENCES_INVALID';
    end if;
    -- Stored from subscript 1, in the order sent.
    v_wanted := array(select item.key_value from unnest(requested_modules) with ordinality item(key_value, position)
                       order by item.position);
    -- One save of a membership at a time: the second reads the first's committed row.
    perform pg_advisory_xact_lock(hashtextextended('identity.staff-shortcuts:' || v_membership::text, 0));
    select shortcut.modules, shortcut.version, shortcut.last_idempotency_key, shortcut.last_request_sha256
      into v_modules, v_version, v_key, v_sha
      from identity.staff_shortcuts shortcut
     where shortcut.membership_id = v_membership
       for update;
    v_found := found;
    if v_found and v_key = requested_idempotency_key then
      if v_sha is distinct from requested_request_sha256 then
        raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      v_replayed := true;
    elsif coalesce(v_version, 0) <> expected_version then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT';
    elsif v_found then
      update identity.staff_shortcuts shortcut
         set modules = v_wanted, version = shortcut.version + 1,
             last_idempotency_key = requested_idempotency_key, last_request_sha256 = requested_request_sha256,
             updated_at = clock_timestamp()
       where shortcut.membership_id = v_membership
      returning shortcut.modules, shortcut.version into v_modules, v_version;
    else
      insert into identity.staff_shortcuts (membership_id, facility_id, account_id, modules, version,
        last_idempotency_key, last_request_sha256)
      values (v_membership, v_facility, v_account, v_wanted, 1, requested_idempotency_key, requested_request_sha256)
      returning modules, version into v_modules, v_version;
    end if;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id, organization_id, facility_id,
      action, outcome, resource_type, resource_id, provenance, source_system, details
    ) values (
      v_correlation, 'staff', v_subject, v_account, v_membership, v_organization, v_facility,
      'identity.staff-shortcuts.update', 'success', 'staff-membership', v_membership::text, 'application',
      'identity-api',
      jsonb_build_object('modules', to_jsonb(v_modules), 'version', v_version)
        || case when v_replayed then jsonb_build_object('replayed', true) else '{}'::jsonb end
    );
    return query select v_facility, v_modules, v_version, v_replayed;
  end
  $fn$;
  comment on function identity.save_my_staff_shortcuts(text[], bigint, text, text) is
    '0206 (SX-7): replaces the shortcuts of the request''s membership (the caller''s, active, unheld, at the request''s facility; else 42501 STAFF_SHORTCUTS_NOT_ALLOWED): 0 to 12 module keys in order, no repeats (22023 SHORTCUTS_TOO_MANY, SHORTCUT_INVALID, SHORTCUT_DUPLICATE), with the version read (0 when never saved), under an Idempotency-Key and the request''s SHA-256 (replay, 23505 IDEMPOTENCY_KEY_REUSED and 40001 VERSION_CONFLICT as identity.save_my_staff_preferences). Which keys exist and which the member may use is identity-api''s check. One audit row identity.staff-shortcuts.update on staff-membership, details modules and version (and replayed).';
  revoke all on function identity.save_my_staff_shortcuts(text[], bigint, text, text) from public;

  -- Owners (the owner of identity.staff_facility_memberships, 0002's; the
  -- migrator on production) and P7, EXECUTE.
  v_owner := (select pg_get_userbyid(relation.relowner) from pg_class relation
               where relation.oid = 'identity.staff_facility_memberships'::regclass);
  if v_owner <> current_user then
    execute format('alter table identity.staff_preferences owner to %I', v_owner);
    execute format('alter table identity.staff_shortcuts owner to %I', v_owner);
    execute format('alter function identity.staff_shortcut_keys_valid(text[]) owner to %I', v_owner);
    execute format('alter function identity.staff_shortcut_keys_distinct(text[]) owner to %I', v_owner);
    execute format('alter function identity.read_my_staff_preferences() owner to %I', v_owner);
    execute format('alter function identity.save_my_staff_preferences(text, bigint, text, text) owner to %I', v_owner);
    execute format('alter function identity.save_my_staff_shortcuts(text[], bigint, text, text) owner to %I', v_owner);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.read_my_staff_preferences(),
      identity.save_my_staff_preferences(text, bigint, text, text),
      identity.save_my_staff_shortcuts(text[], bigint, text, text) to hid_identity_runtime;
  end if;

  -- 3. Post-checks.
  if (select count(*) from pg_class relation
       where relation.oid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass)
         and relation.relkind = 'r' and relation.relrowsecurity and not relation.relforcerowsecurity
         and relation.relowner = (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner)) <> 2
     or exists (select 1 from pg_class relation,
                       lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass)
                   and acl.grantee <> relation.relowner)
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass))
     or exists (select 1 from pg_trigger trigger_row
                 where not trigger_row.tgisinternal
                   and trigger_row.tgrelid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass)) then
    raise exception using errcode = '55000',
      message = '0206: post-check failed (a table is not the owner''s, is granted to a role, has a policy or a trigger, '
        || 'or its row-level security is not enabled and unforced)';
  end if;
  if (select string_agg(attribute.attname || ' ' || format_type(attribute.atttypid, attribute.atttypmod)
                        || case when attribute.attnotnull then ' not null' else '' end, ', ' order by attribute.attnum)
        from pg_attribute attribute
       where attribute.attrelid = 'identity.staff_preferences'::regclass and attribute.attnum > 0
         and not attribute.attisdropped)
     is distinct from 'account_id uuid not null, language text not null, version bigint not null, '
       || 'last_idempotency_key text not null, last_request_sha256 text not null, '
       || 'created_at timestamp with time zone not null, updated_at timestamp with time zone not null'
     or (select string_agg(attribute.attname || ' ' || format_type(attribute.atttypid, attribute.atttypmod)
                           || case when attribute.attnotnull then ' not null' else '' end, ', ' order by attribute.attnum)
           from pg_attribute attribute
          where attribute.attrelid = 'identity.staff_shortcuts'::regclass and attribute.attnum > 0
            and not attribute.attisdropped)
        is distinct from 'membership_id uuid not null, facility_id uuid not null, account_id uuid not null, '
          || 'modules text[] not null, version bigint not null, last_idempotency_key text not null, '
          || 'last_request_sha256 text not null, created_at timestamp with time zone not null, '
          || 'updated_at timestamp with time zone not null' then
    raise exception using errcode = '55000', message = '0206: post-check failed (the tables'' columns)';
  end if;
  if (select string_agg(constraint_row.conname || ': ' || pg_get_constraintdef(constraint_row.oid), ' | '
                        order by constraint_row.conname collate "C")
        from pg_constraint constraint_row
       where constraint_row.conrelid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass))
     is distinct from
       'staff_preferences_account_fkey: FOREIGN KEY (account_id) REFERENCES auth.accounts(id) ON DELETE RESTRICT'
       || ' | staff_preferences_key_check: CHECK ((last_idempotency_key ~ ''^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$''::text))'
       || ' | staff_preferences_language_check: CHECK ((language ~ ''^[a-z]{2}$''::text))'
       || ' | staff_preferences_pkey: PRIMARY KEY (account_id)'
       || ' | staff_preferences_sha256_check: CHECK ((last_request_sha256 ~ ''^[0-9a-f]{64}$''::text))'
       || ' | staff_preferences_version_check: CHECK ((version > 0))'
       || ' | staff_shortcuts_count_check: CHECK ((cardinality(modules) <= 12))'
       || ' | staff_shortcuts_distinct_check: CHECK (identity.staff_shortcut_keys_distinct(modules))'
       || ' | staff_shortcuts_key_check: CHECK ((last_idempotency_key ~ ''^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$''::text))'
       || ' | staff_shortcuts_keys_check: CHECK (identity.staff_shortcut_keys_valid(modules))'
       || ' | staff_shortcuts_membership_fkey: FOREIGN KEY (membership_id, facility_id, account_id) REFERENCES '
       || 'identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT'
       || ' | staff_shortcuts_no_null_check: CHECK ((array_position(modules, NULL::text) IS NULL))'
       || ' | staff_shortcuts_pkey: PRIMARY KEY (membership_id)'
       || ' | staff_shortcuts_sha256_check: CHECK ((last_request_sha256 ~ ''^[0-9a-f]{64}$''::text))'
       || ' | staff_shortcuts_shape_check: CHECK (((array_ndims(modules) IS NULL) OR ((array_ndims(modules) = 1) '
       || 'AND (array_lower(modules, 1) = 1))))'
       || ' | staff_shortcuts_version_check: CHECK ((version > 0))'
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conrelid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass)
                   and (not constraint_row.convalidated
                        or (constraint_row.contype = 'f' and (constraint_row.confdeltype <> 'r'
                                                               or constraint_row.confupdtype <> 'a')))) then
    raise exception using errcode = '55000', message = '0206: post-check failed (the tables'' constraints)';
  end if;
  if (select count(*) from pg_proc proc
       where proc.proowner = (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner)
         and proc.proconfig = array['search_path=pg_catalog, pg_temp']
         and ((proc.oid, md5(proc.prosrc), proc.prosecdef, proc.provolatile) in (
               ('identity.staff_shortcut_keys_valid(text[])'::regprocedure, v_keys_valid_md5, false, 'i'),
               ('identity.staff_shortcut_keys_distinct(text[])'::regprocedure, v_keys_distinct_md5, false, 'i'),
               ('identity.read_my_staff_preferences()'::regprocedure, v_read_md5, true, 's'),
               ('identity.save_my_staff_preferences(text,bigint,text,text)'::regprocedure, v_save_preferences_md5, true, 'v'),
               ('identity.save_my_staff_shortcuts(text[],bigint,text,text)'::regprocedure, v_save_shortcuts_md5, true, 'v')))) <> 5
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'identity'
            and (proc.proname like '%staff\_preferences%' or proc.proname like '%staff\_shortcut%')) <> 5
     or exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid in ('identity.staff_shortcut_keys_valid(text[])'::regprocedure,
                                    'identity.staff_shortcut_keys_distinct(text[])'::regprocedure,
                                    'identity.read_my_staff_preferences()'::regprocedure,
                                    'identity.save_my_staff_preferences(text,bigint,text,text)'::regprocedure,
                                    'identity.save_my_staff_shortcuts(text[],bigint,text,text)'::regprocedure)
                   and acl.grantee <> proc.proowner
                   and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime'
                        or acl.privilege_type <> 'EXECUTE' or acl.is_grantable
                        or proc.proname like 'staff\_shortcut\_keys\_%'))
     or (exists (select 1 from pg_roles where rolname = 'hid_identity_runtime')
         and (select count(*) from pg_proc proc, lateral aclexplode(proc.proacl) acl
               where proc.oid in ('identity.read_my_staff_preferences()'::regprocedure,
                                  'identity.save_my_staff_preferences(text,bigint,text,text)'::regprocedure,
                                  'identity.save_my_staff_shortcuts(text[],bigint,text,text)'::regprocedure)
                 and acl.grantee = (select role_row.oid from pg_roles role_row where role_row.rolname = 'hid_identity_runtime')
                 and acl.privilege_type = 'EXECUTE') <> 3) then
    raise exception using errcode = '55000', message = '0206: post-check failed (the functions'' security, owner, body or grants)';
  end if;

  raise notice '0206: staff preferences and Home shortcuts installed (two tables, three functions for the Identity runtime, two CHECK helpers); nothing else changed.';
end
$sx7$;
