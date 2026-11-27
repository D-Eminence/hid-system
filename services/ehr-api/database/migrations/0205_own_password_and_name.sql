-- 0205 SX-6: change your own password while signed in, and edit your own name
-- (Akos P1-8, edit part; the planned contract's "SX-6: Change password while
-- signed in, and edit own profile"). Written on staging at 0cfddcc9
-- (0001-0153, live). The number is provisional: numbers are given at
-- integration, in release order (#258). This file uses only objects of 0001,
-- 0002, 0003, 0008, 0096, 0098 and 0123 (step 1 below names each), and
-- nothing 0154-0204 create or change, so it applies on 0001-0153 and after
-- any of them alike. The declaration in config/production-schema-compatibility.json
-- stays unsigned until the owner signs this file.
--
-- Decisions taken at Rahman's recommended defaults (design note on
-- hid-system#258), not yet answered by the owner; each is one place below:
--   - A name edit changes auth.accounts.display_name only. identity.staff
--     .full_name, the registered name a licence was vouched under, is never
--     changed here (order routes, the patient's access log, share search and
--     the outreach team keep reading it).
--   - Sealed QA and sealed demo logins (accounts listed in
--     identity.sealed_qa_members or identity.sealed_demo_members, read through
--     0123's identity.sealed_qa_account and 0098's
--     identity.sealed_demo_account) are refused both changes:
--     STAFF_PROFILE_CHANGE_NOT_ALLOWED. They are shared by testers.
--   - The previous and the new name are written in the audit row
--     (auth.staff-profile.update), as the contract says.
--   - No row is kept that is derived from any password: a replay of a
--     password change is recognised by its Idempotency-Key alone.
--
-- What it changes (nothing else):
-- B1 auth.staff_name_changes      one row per name change: the account, the
--                                 profile version it made (2, 3, ...), when,
--                                 the Idempotency-Key (unique per account) and
--                                 the SHA-256 of the new name (so a replay
--                                 with another name is told apart). An
--                                 account's profile version is the largest
--                                 version here, else 1. It is also the store
--                                 of the 3-per-24-hours limit. Append only.
-- B2 auth.password_change_requests one row per password change: the account,
--                                 the Idempotency-Key (the primary key with
--                                 the account), the change id (the
--                                 password-updated email's key), the renewed
--                                 session, how many other sign-ins it ended
--                                 and when. Append only. Nothing derived from
--                                 a password.
--    Both: foreign key to auth.accounts ON DELETE RESTRICT; row-level security
--    enabled and not forced, with no policy, and no privilege for any role but
--    the owner (only the functions below, as their owner, read and write
--    them; the same explicit exception as 0153's table: forcing it would only
--    make every definer need an owner policy); a row trigger refuses update
--    and delete and a statement trigger refuses truncate, even for the owner,
--    through 0001's platform.reject_mutation (md5-pinned below).
-- B3 auth.staff_person_name_acceptable(text)   IMMUTABLE SQL, no role may
--    execute it: identity-api's acceptableStaffPersonName (staff-names.ts) in
--    SQL, accepting the same names: 2 to 6 words of letters and combining
--    marks joined by a single space, apostrophe or hyphen; 2 to 80
--    characters as JavaScript counts them (UTF-16 code units: a character
--    past U+FFFF counts twice); none of the words healthid, hid, support,
--    admin, administrator, ministry or "health id". Letters are ICU's
--    (collation "und-x-icu": [[:alpha:]] is then Unicode's general category
--    L, as \p{L}, whatever the database's own collation). The combining
--    marks are every code point of general category M (Mn, Mc and Me),
--    written out as ranges: JavaScript's \p{M} in Unicode 17.0 (Node 22),
--    so Arabic harakat, Devanagari and Thai vowel signs and Yoruba, Igbo and
--    Hausa tone and dot marks all pass (staff-profile-changes-sql.spec.ts
--    holds the ranges to \p{M}). The one difference left is the Unicode
--    version of letters: a letter newer than the server's ICU (74, Unicode
--    15.1, on PostgreSQL 16 here) is no letter in the database, so such a
--    name passes identity-api and is refused here (STAFF_NAME_INVALID).
--    identity-api checks the JavaScript rule first; this is the database's
--    own backstop (no other check holds auth.accounts.display_name today).
-- B4 auth.change_own_password(...)  SECURITY DEFINER. Node has verified the
--    current password (argon2 is not in the database) and hashed the new one;
--    this function, in the request's one transaction:
--      1. takes the account from the session's subject
--         (platform.current_actor_subject, auth.account_id_for_subject);
--         without a new hash it is only the replay read: the stored answer
--         for (account, Idempotency-Key), or no row;
--      2. locks the account row FOR NO KEY UPDATE (a concurrent session
--         insert's FOR KEY SHARE does not conflict with it, so a refresh in
--         flight never deadlocks with it), answers a replay of the key with
--         the stored row (replayed true, nothing else), then locks the
--         account's unrevoked sessions FOR UPDATE in id order;
--      3. refuses: an account not active or disabled
--         (OWN_ACCOUNT_NOT_ACTIVE), a sealed login
--         (STAFF_PROFILE_CHANGE_NOT_ALLOWED), no password
--         (PASSWORD_NOT_SET), a stored hash that is not the one Node verified
--         (PASSWORD_CHANGED_MEANWHILE: a compare-and-swap), and a presented
--         session that is not a live staff session of the account at its
--         token version with the presented access token id
--         (OWN_SESSION_NOT_CURRENT);
--      4. refuses a new hash that is not 0029's policy (argon2id, m=65536,
--         t=3, p=1, 64-512 characters: complete_recovery_otp's own test,
--         copied);
--      5. sets the hash, password_algorithm argon2id, password_changed_at,
--         token_version + 1, row_version + 1 and updated_at;
--      6. revokes every other unrevoked session of the account, staff and
--         patient kinds alike, with reason password_changed, and writes one
--         'revoked' session event per sign-in (family) it touched; counts the
--         other sign-ins that were live (unexpired, at the account's token
--         version), not ones that had expired unrevoked;
--      7. renews the presented session in its own family: revokes it with
--         reason rotated and replaced_by_session_id, inserts the renewed
--         session with Node's new session id, access token id and refresh
--         token SHA-256 (the database never sees a secret), at the new token
--         version, with the same kind, authentication method and absolute end,
--         its idle end never past that; one 'rotated' session event. The
--         family keeps its 0129 facility choice, 0140 open patient and 0127
--         single sign-on provenance;
--      8. writes one audit row auth.password.change, staff actor, resource
--         'session' (the renewed session), no facility (audit_actor_facility_ck
--         admits a staff 'auth.' row on 'session' without one), details
--         otherSignInsEnded and changeId only;
--      9. stores the B2 row and answers the change id, the new token version,
--         password_changed_at, the count and the renewed session.
-- B5 auth.change_own_display_name(...)  SECURITY DEFINER, the same form: the
--    account locked FOR NO KEY UPDATE; refused when not active, sealed, or the
--    presented session is not a live staff session of the account; the name
--    (trimmed) must pass B3 (STAFF_NAME_INVALID); a replay of the key with
--    the same name answers the current state (replayed true), with another
--    name IDEMPOTENCY_KEY_REUSED; the expected version must be the current
--    profile version (VERSION_CONFLICT); the account's current name is
--    refused (STAFF_NAME_UNCHANGED); a fourth change within 24 hours is
--    refused (STAFF_NAME_CHANGE_LIMITED). Then display_name and updated_at,
--    one B1 row, and one audit row auth.staff-profile.update (resource
--    'session', no facility) with previousName, newName and profileVersion.
-- B6 auth.own_profile_version()  STABLE SQL, SECURITY DEFINER: the profile
--    version of the session's own account (B1), for SX-5's read; null with no
--    active account in the session.
--    B4-B6 are owned by auth.accounts' owner (the migrator on production),
--    search_path pg_catalog, pg_temp with every name qualified, EXECUTE
--    revoked from PUBLIC and granted to hid_identity_runtime only (where it
--    exists; here and in runtime-grants.sql, as 0139 and 0140). B3 is the
--    same owner's, executed by no role. Errors carry stable message keys
--    (SQLSTATE 22023, 23505, 40001, 42501 or 55000) that identity-api maps.
--
-- Locks (measured with pg_locks before commit and compared by the suite),
-- taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.accounts (the foreign keys
-- of the two new, empty tables), never ACCESS EXCLUSIVE: every request's
-- session check and every sign-in read it and go on; only writers of
-- auth.accounts (a sign-in's legacy-hash upgrade, a reset, an administrator's
-- change) wait, for the milliseconds this file takes. That is every existing
-- table this file locks. The functions write auth.sessions,
-- auth.session_events, audit.events and the two new tables only when called;
-- plpgsql does not open a table at CREATE (no %ROWTYPE is declared), and the
-- one SQL function body (B6) names only B1, which this file creates; so none
-- of them is locked here. The preconditions and post-checks read the catalog
-- only. A busy table fails the attempt at once, and its subtransaction
-- releases what it took. The attempt is made 50 times, 100 ms apart (about 5
-- seconds), so no request queues behind a wait; then 55P03 (nothing applied).
-- When this transaction already holds an earlier migration's locks that stop
-- other sessions' reads or writes (the runner's dry run applies every pending
-- file in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied. Both refusals begin "0205: " and end "run the release again at a
-- quieter time", so the runner's dry run rolls back and tries again (#306).
--
-- Old images on this schema: nothing calls the new functions, and no
-- existing object changes. identity-api of this branch calls them only with
-- STAFF_PASSWORD_CHANGE_ENABLED or STAFF_NAME_CHANGE_ENABLED set to true, and
-- refuses to start with either setting on while a function or its EXECUTE is
-- missing.
--
-- Role bootstrap: this file grants its own EXECUTE. A role bootstrap run after
-- it must use the runtime-grants.sql that carries this file's block, or
-- Identity loses EXECUTE on B4-B6.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop B4,
-- B5, B6 and B3, and the two tables (their rows are history only; the audit
-- rows stay). Names already changed stay as they are.
--
-- The whole file is one statement (do $sx6own0205$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The lock (one attempt, made up to 50 times while the table is busy).
-- 1. Preconditions (55000, nothing applied): the objects this file uses
--    (0002's auth.accounts, auth.sessions and auth.session_events columns by
--    name and type; 0003's audit.events columns; 0096's accounts_deleted
--    terminal trigger on auth.accounts, which fires on the updated table; the
--    ICU collation); the bodies the functions call md5-pinned (0001's
--    platform.current_actor_subject, platform.current_correlation_id and
--    platform.reject_mutation; 0008's auth.account_id_for_subject; 0096's
--    auth.protect_deleted_account; 0098's identity.sealed_demo_account; 0123's
--    identity.sealed_qa_account); "0205: already applied" when every object of
--    this file is there with its reviewed body; "0205: the schema is not in
--    the reviewed state" for any other state with one of them.
-- 2. B1-B6, owners and grants.
-- 3. Post-checks (0148's and 0152's form): auth.accounts' owner, privileges
--    and triggers exactly as before (the Identity runtime still holds no
--    privilege on it but SELECT); the two tables the owner's, row-level
--    security enabled and not forced, no policy, no privilege for another
--    role, their triggers by tgtype, tgqual, tgattr, tgnargs, tgfoid and
--    tgenabled; the four functions the owner's, B4-B6 SECURITY DEFINER and B3
--    not, each with the fixed search_path, its exact EXECUTE list and its
--    reviewed body.

do $sx6own0205$
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
  v_accounts_before text;
  v_runtime_exists boolean := exists (select 1 from pg_roles where rolname = 'hid_identity_runtime');
  -- The reviewed bodies (md5 of pg_proc.prosrc) of this file's four functions.
  c_name_rule_md5 constant text := 'ba5a81d7fa008f20070c9eff84bebde2';
  c_password_md5 constant text := '2ec777b3dbb1c34db5d769b6fac64f90';
  c_display_name_md5 constant text := '909ae1a9f3b0e738b9267e036fcf418f';
  c_profile_version_md5 constant text := '4aa0e33297c2830e8fe8d00299c4c75b';
begin
  -- 0. The lock, NOWAIT.
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table auth.accounts in share row exclusive mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0205: auth.accounts is busy, and this transaction already holds an earlier migration''s locks, '
          || 'so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0205: auth.accounts stayed busy for 5 seconds; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- The objects this file uses, by name and type.
  select string_agg(expected.table_name || '.' || expected.column_name, ', ' order by expected.table_name,
                    expected.column_name) into v_mismatch
    from (values
      ('auth.accounts', 'id', 'uuid'), ('auth.accounts', 'subject', 'text'), ('auth.accounts', 'email', 'text'),
      ('auth.accounts', 'display_name', 'text'), ('auth.accounts', 'status', 'text'),
      ('auth.accounts', 'password_hash', 'text'), ('auth.accounts', 'password_algorithm', 'text'),
      ('auth.accounts', 'password_changed_at', 'timestamp with time zone'),
      ('auth.accounts', 'token_version', 'bigint'), ('auth.accounts', 'row_version', 'bigint'),
      ('auth.accounts', 'updated_at', 'timestamp with time zone'),
      ('auth.accounts', 'disabled_until', 'timestamp with time zone'),
      ('auth.sessions', 'id', 'uuid'), ('auth.sessions', 'account_id', 'uuid'), ('auth.sessions', 'family_id', 'uuid'),
      ('auth.sessions', 'refresh_token_sha256', 'character(64)'), ('auth.sessions', 'access_jti', 'uuid'),
      ('auth.sessions', 'account_token_version', 'bigint'), ('auth.sessions', 'authentication_method', 'text'),
      ('auth.sessions', 'issued_at', 'timestamp with time zone'),
      ('auth.sessions', 'expires_at', 'timestamp with time zone'),
      ('auth.sessions', 'absolute_expires_at', 'timestamp with time zone'),
      ('auth.sessions', 'revoked_at', 'timestamp with time zone'), ('auth.sessions', 'revocation_reason', 'text'),
      ('auth.sessions', 'replaced_by_session_id', 'uuid'), ('auth.sessions', 'source_ip', 'inet'),
      ('auth.sessions', 'user_agent_sha256', 'character(64)'), ('auth.sessions', 'row_version', 'bigint'),
      ('auth.sessions', 'session_kind', 'text'), ('auth.sessions', 'patient_id', 'uuid'),
      ('auth.session_events', 'session_id', 'uuid'), ('auth.session_events', 'account_id', 'uuid'),
      ('auth.session_events', 'event_type', 'text'), ('auth.session_events', 'outcome', 'text'),
      ('auth.session_events', 'correlation_id', 'text'), ('auth.session_events', 'source_ip', 'inet'),
      ('auth.session_events', 'user_agent_sha256', 'character(64)'), ('auth.session_events', 'details', 'jsonb'),
      ('audit.events', 'correlation_id', 'text'), ('audit.events', 'actor_type', 'text'),
      ('audit.events', 'actor_subject', 'text'), ('audit.events', 'actor_account_id', 'uuid'),
      ('audit.events', 'action', 'text'), ('audit.events', 'outcome', 'text'),
      ('audit.events', 'resource_type', 'text'), ('audit.events', 'resource_id', 'text'),
      ('audit.events', 'purpose_of_use', 'text'), ('audit.events', 'source_ip', 'inet'),
      ('audit.events', 'user_agent', 'text'), ('audit.events', 'provenance', 'text'),
      ('audit.events', 'source_system', 'text'), ('audit.events', 'details', 'jsonb')
    ) expected(table_name, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = to_regclass(expected.table_name)
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if v_mismatch is not null or to_regclass('migration.schema_migrations') is null
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'auth.accounts'::regclass
                       and trigger_row.tgname = 'accounts_deleted_terminal'
                       and trigger_row.tgfoid = to_regprocedure('auth.protect_deleted_account()')
                       and trigger_row.tgenabled = 'O')
     or not exists (select 1 from pg_collation collation_row
                     where collation_row.collname = 'und-x-icu' and collation_row.collprovider = 'i'
                       and collation_row.collnamespace = 'pg_catalog'::regnamespace) then
    raise exception using errcode = '55000',
      message = '0205: the objects it uses are not there (0002''s accounts and sessions, 0003''s audit, 0096''s '
        || 'deleted-account trigger, the ICU collation und-x-icu)' || coalesce(': ' || v_mismatch, '');
  end if;

  -- Already applied, or a half state.
  select count(*) into v_present
    from (values (to_regclass('auth.staff_name_changes')::oid), (to_regclass('auth.password_change_requests')::oid),
                 (to_regprocedure('auth.staff_person_name_acceptable(text)')::oid),
                 (to_regprocedure('auth.change_own_password(uuid, uuid, text, text, text, uuid, uuid, text, '
                                  || 'timestamp with time zone, inet, text)')::oid),
                 (to_regprocedure('auth.change_own_display_name(text, bigint, text, uuid, inet, text)')::oid),
                 (to_regprocedure('auth.own_profile_version()')::oid)) present(object_id)
   where present.object_id is not null;
  if v_present = 6
     and (select string_agg(md5(proc.prosrc), ',' order by proc.proname collate "C") from pg_proc proc
           where proc.oid in (to_regprocedure('auth.staff_person_name_acceptable(text)'),
                              to_regprocedure('auth.change_own_password(uuid, uuid, text, text, text, uuid, uuid, '
                                              || 'text, timestamp with time zone, inet, text)'),
                              to_regprocedure('auth.change_own_display_name(text, bigint, text, uuid, inet, text)'),
                              to_regprocedure('auth.own_profile_version()')))
         = c_display_name_md5 || ',' || c_password_md5 || ',' || c_profile_version_md5 || ',' || c_name_rule_md5 then
    raise exception using errcode = '55000', message = '0205: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_proc proc
                 where proc.pronamespace = 'auth'::regnamespace
                   and proc.proname in ('staff_person_name_acceptable', 'change_own_password',
                                        'change_own_display_name', 'own_profile_version')) then
    raise exception using errcode = '55000',
      message = '0205: the schema is not in the reviewed state (part of 0205 is there); nothing applied';
  end if;

  -- The bodies the functions call, as 0001-0153 leave them.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('auth.protect_deleted_account()', '230114cc840d87d5b23cac8b6337f822'),
      ('identity.sealed_demo_account(uuid)', '16eae1d6c33b3bef793796cf66f1cdf6'),
      ('identity.sealed_qa_account(uuid)', '2c19c76bff02b394097724f99e09fc9d')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0205: these bodies are not as 0001-0153 left them: ' || v_mismatch;
  end if;

  -- auth.accounts as found: owner, privileges and triggers (the post-check compares).
  v_owner := (select pg_get_userbyid(relowner) from pg_class where oid = 'auth.accounts'::regclass);
  select format('%s|%s|%s', pg_get_userbyid(class_row.relowner), class_row.relacl::text,
           (select string_agg(format('%s %s %s %s %s', trigger_row.tgname, trigger_row.tgtype,
                                     trigger_row.tgfoid::regprocedure, trigger_row.tgenabled,
                                     pg_get_triggerdef(trigger_row.oid)), ';' order by trigger_row.tgname)
              from pg_trigger trigger_row where trigger_row.tgrelid = class_row.oid and not trigger_row.tgisinternal))
    into v_accounts_before
    from pg_class class_row where class_row.oid = 'auth.accounts'::regclass;

  -- 2. B1. The name changes.
  create table auth.staff_name_changes (
    account_id uuid not null references auth.accounts(id) on delete restrict,
    profile_version bigint not null check (profile_version > 1),
    changed_at timestamptz not null default clock_timestamp(),
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    primary key (account_id, profile_version),
    unique (account_id, idempotency_key)
  );
  alter table auth.staff_name_changes enable row level security;
  revoke all on auth.staff_name_changes from public;
  comment on table auth.staff_name_changes is
    '0205 (SX-6): one row per change of an account''s own name (auth.accounts.display_name): the profile version it made, when, its Idempotency-Key and the SHA-256 of the new name. An account''s profile version is its largest here, else 1. Append only. Only auth.change_own_display_name and auth.own_profile_version, as the owner, use it.';
  create trigger staff_name_changes_append_only
    before update or delete on auth.staff_name_changes
    for each row execute function platform.reject_mutation();
  create trigger staff_name_changes_no_truncate
    before truncate on auth.staff_name_changes
    for each statement execute function platform.reject_mutation();

  -- B2. The password changes.
  create table auth.password_change_requests (
    account_id uuid not null references auth.accounts(id) on delete restrict,
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    change_id uuid not null unique,
    session_id uuid not null,
    other_sign_ins_ended integer not null check (other_sign_ins_ended >= 0),
    password_changed_at timestamptz not null,
    created_at timestamptz not null default clock_timestamp(),
    primary key (account_id, idempotency_key)
  );
  alter table auth.password_change_requests enable row level security;
  revoke all on auth.password_change_requests from public;
  comment on table auth.password_change_requests is
    '0205 (SX-6): one row per change of an account''s own password while signed in: its Idempotency-Key, the change id (the password-updated email''s key), the renewed session, how many other sign-ins it ended, and when. Nothing derived from any password. Append only. Only auth.change_own_password, as the owner, uses it.';
  create trigger password_change_requests_append_only
    before update or delete on auth.password_change_requests
    for each row execute function platform.reject_mutation();
  create trigger password_change_requests_no_truncate
    before truncate on auth.password_change_requests
    for each statement execute function platform.reject_mutation();

  -- B3. The name rule.
  create function auth.staff_person_name_acceptable(candidate text)
  returns boolean
  language sql
  immutable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select coalesce(
      -- 2 to 80 UTF-16 code units, as JavaScript's length counts them (a character past U+FFFF counts twice).
      length(candidate) + length(regexp_replace(candidate, E'[^\U00010000-\U0010FFFF]', '', 'g')) between 2 and 80
      and (candidate collate "und-x-icu")
          ~ ('^[[:alpha:]' || marks.ranges || ']+([ ''-][[:alpha:]' || marks.ranges || ']+){1,5}$')
      and not exists (
        select 1
          from (select regexp_split_to_array(lower(candidate collate "und-x-icu"), '[ ''-]+') as list) words,
               generate_subscripts(words.list, 1) as position
         where words.list[position] in ('healthid', 'hid', 'support', 'admin', 'administrator', 'ministry')
            or (words.list[position] = 'health' and words.list[position + 1] = 'id')),
      false)
      from (select
          -- Every combining mark (general categories Mn, Mc and Me): JavaScript's \p{M} in Unicode 17.0.
             E'\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7\u0610-\u061A'
          || E'\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7-\u06E8\u06EA-\u06ED\u0711\u0730-\u074A'
          || E'\u07A6-\u07B0\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B'
          || E'\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962-\u0963'
          || E'\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7-\u09C8\u09CB-\u09CD\u09D7\u09E2-\u09E3\u09FE\u0A01-\u0A03\u0A3C'
          || E'\u0A3E-\u0A42\u0A47-\u0A48\u0A4B-\u0A4D\u0A51\u0A70-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5'
          || E'\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2-\u0AE3\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47-\u0B48'
          || E'\u0B4B-\u0B4D\u0B55-\u0B57\u0B62-\u0B63\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7'
          || E'\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55-\u0C56\u0C62-\u0C63\u0C81-\u0C83'
          || E'\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5-\u0CD6\u0CE2-\u0CE3\u0CF3\u0D00-\u0D03'
          || E'\u0D3B-\u0D3C\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62-\u0D63\u0D81-\u0D83\u0DCA'
          || E'\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DF2-\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EBC'
          || E'\u0EC8-\u0ECE\u0F18-\u0F19\u0F35\u0F37\u0F39\u0F3E-\u0F3F\u0F71-\u0F84\u0F86-\u0F87\u0F8D-\u0F97'
          || E'\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074'
          || E'\u1082-\u108D\u108F\u109A-\u109D\u135D-\u135F\u1712-\u1715\u1732-\u1734\u1752-\u1753\u1772-\u1773'
          || E'\u17B4-\u17D3\u17DD\u180B-\u180D\u180F\u1885-\u1886\u18A9\u1920-\u192B\u1930-\u193B\u1A17-\u1A1B'
          || E'\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F\u1AB0-\u1ADD\u1AE0-\u1AEB\u1B00-\u1B04\u1B34-\u1B44\u1B6B-\u1B73'
          || E'\u1B80-\u1B82\u1BA1-\u1BAD\u1BE6-\u1BF3\u1C24-\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4'
          || E'\u1CF7-\u1CF9\u1DC0-\u1DFF\u20D0-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099-\u309A'
          || E'\uA66F-\uA672\uA674-\uA67D\uA69E-\uA69F\uA6F0-\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA82C\uA880-\uA881'
          || E'\uA8B4-\uA8C5\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9E5'
          || E'\uAA29-\uAA36\uAA43\uAA4C-\uAA4D\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7-\uAAB8\uAABE-\uAABF\uAAC1'
          || E'\uAAEB-\uAAEF\uAAF5-\uAAF6\uABE3-\uABEA\uABEC-\uABED\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\U000101FD'
          || E'\U000102E0\U00010376-\U0001037A\U00010A01-\U00010A03\U00010A05-\U00010A06\U00010A0C-\U00010A0F'
          || E'\U00010A38-\U00010A3A\U00010A3F\U00010AE5-\U00010AE6\U00010D24-\U00010D27\U00010D69-\U00010D6D'
          || E'\U00010EAB-\U00010EAC\U00010EFA-\U00010EFF\U00010F46-\U00010F50\U00010F82-\U00010F85'
          || E'\U00011000-\U00011002\U00011038-\U00011046\U00011070\U00011073-\U00011074\U0001107F-\U00011082'
          || E'\U000110B0-\U000110BA\U000110C2\U00011100-\U00011102\U00011127-\U00011134\U00011145-\U00011146'
          || E'\U00011173\U00011180-\U00011182\U000111B3-\U000111C0\U000111C9-\U000111CC\U000111CE-\U000111CF'
          || E'\U0001122C-\U00011237\U0001123E\U00011241\U000112DF-\U000112EA\U00011300-\U00011303'
          || E'\U0001133B-\U0001133C\U0001133E-\U00011344\U00011347-\U00011348\U0001134B-\U0001134D\U00011357'
          || E'\U00011362-\U00011363\U00011366-\U0001136C\U00011370-\U00011374\U000113B8-\U000113C0\U000113C2'
          || E'\U000113C5\U000113C7-\U000113CA\U000113CC-\U000113D0\U000113D2\U000113E1-\U000113E2'
          || E'\U00011435-\U00011446\U0001145E\U000114B0-\U000114C3\U000115AF-\U000115B5\U000115B8-\U000115C0'
          || E'\U000115DC-\U000115DD\U00011630-\U00011640\U000116AB-\U000116B7\U0001171D-\U0001172B'
          || E'\U0001182C-\U0001183A\U00011930-\U00011935\U00011937-\U00011938\U0001193B-\U0001193E\U00011940'
          || E'\U00011942-\U00011943\U000119D1-\U000119D7\U000119DA-\U000119E0\U000119E4\U00011A01-\U00011A0A'
          || E'\U00011A33-\U00011A39\U00011A3B-\U00011A3E\U00011A47\U00011A51-\U00011A5B\U00011A8A-\U00011A99'
          || E'\U00011B60-\U00011B67\U00011C2F-\U00011C36\U00011C38-\U00011C3F\U00011C92-\U00011CA7'
          || E'\U00011CA9-\U00011CB6\U00011D31-\U00011D36\U00011D3A\U00011D3C-\U00011D3D\U00011D3F-\U00011D45'
          || E'\U00011D47\U00011D8A-\U00011D8E\U00011D90-\U00011D91\U00011D93-\U00011D97\U00011EF3-\U00011EF6'
          || E'\U00011F00-\U00011F01\U00011F03\U00011F34-\U00011F3A\U00011F3E-\U00011F42\U00011F5A\U00013440'
          || E'\U00013447-\U00013455\U0001611E-\U0001612F\U00016AF0-\U00016AF4\U00016B30-\U00016B36\U00016F4F'
          || E'\U00016F51-\U00016F87\U00016F8F-\U00016F92\U00016FE4\U00016FF0-\U00016FF1\U0001BC9D-\U0001BC9E'
          || E'\U0001CF00-\U0001CF2D\U0001CF30-\U0001CF46\U0001D165-\U0001D169\U0001D16D-\U0001D172'
          || E'\U0001D17B-\U0001D182\U0001D185-\U0001D18B\U0001D1AA-\U0001D1AD\U0001D242-\U0001D244'
          || E'\U0001DA00-\U0001DA36\U0001DA3B-\U0001DA6C\U0001DA75\U0001DA84\U0001DA9B-\U0001DA9F'
          || E'\U0001DAA1-\U0001DAAF\U0001E000-\U0001E006\U0001E008-\U0001E018\U0001E01B-\U0001E021'
          || E'\U0001E023-\U0001E024\U0001E026-\U0001E02A\U0001E08F\U0001E130-\U0001E136\U0001E2AE'
          || E'\U0001E2EC-\U0001E2EF\U0001E4EC-\U0001E4EF\U0001E5EE-\U0001E5EF\U0001E6E3\U0001E6E6'
          || E'\U0001E6EE-\U0001E6EF\U0001E6F5\U0001E8D0-\U0001E8D6\U0001E944-\U0001E94A\U000E0100-\U000E01EF' as ranges) marks
  $fn$;
  revoke all on function auth.staff_person_name_acceptable(text) from public;
  comment on function auth.staff_person_name_acceptable(text) is
    '0205 (SX-6): identity-api''s acceptableStaffPersonName in SQL, the same names (2-6 words of letters and combining marks joined by one space, apostrophe or hyphen; 2-80 UTF-16 code units; no reserved word). Run only by auth.change_own_display_name, as its owner.';

  -- B4. Change the password while signed in.
  create function auth.change_own_password(
    requested_session_id uuid,
    requested_access_jti uuid,
    expected_password_hash text,
    new_password_hash text,
    requested_idempotency_key text,
    renewed_session_id uuid,
    renewed_access_jti uuid,
    renewed_refresh_token_sha256 text,
    renewed_expires_at timestamptz,
    requested_source_ip inet,
    requested_user_agent text
  ) returns table (change_id uuid, token_version bigint, password_changed_at timestamptz,
    other_sign_ins_ended integer, session_id uuid, session_expires_at timestamptz, replayed boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    v_subject text := platform.current_actor_subject();
    v_correlation text := platform.current_correlation_id();
    v_account_id uuid;
    v_account record;
    v_prior record;
    v_presented record;
    v_now timestamptz;
    v_change_id uuid := gen_random_uuid();
    v_new_version bigint;
    v_ended integer;
    v_expires timestamptz;
    v_user_agent text := nullif(left(coalesce(requested_user_agent, ''), 512), '');
    v_user_agent_sha256 text := case when coalesce(requested_user_agent, '') = '' then null
      else encode(sha256(convert_to(requested_user_agent, 'UTF8')), 'hex') end;
  begin
    if requested_idempotency_key is null
       or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
    end if;
    v_account_id := auth.account_id_for_subject(v_subject);
    if v_subject is null or v_account_id is null or v_correlation is null then
      raise exception using errcode = '42501', message = 'OWN_ACCOUNT_NOT_ACTIVE';
    end if;

    -- 1. Without a new hash, the replay read only: the stored answer, or no row.
    if new_password_hash is null then
      return query
        select request_row.change_id, null::bigint, request_row.password_changed_at,
               request_row.other_sign_ins_ended, request_row.session_id, null::timestamptz, true
          from auth.password_change_requests request_row
         where request_row.account_id = v_account_id
           and request_row.idempotency_key = requested_idempotency_key;
      return;
    end if;

    -- 2. The account, then a replay of the key, then the account's sessions.
    select account_row.id, account_row.status, account_row.disabled_until, account_row.password_hash,
           account_row.token_version
      into v_account
      from auth.accounts account_row
     where account_row.id = v_account_id
       for no key update;
    select request_row.change_id, request_row.password_changed_at, request_row.other_sign_ins_ended,
           request_row.session_id
      into v_prior
      from auth.password_change_requests request_row
     where request_row.account_id = v_account_id
       and request_row.idempotency_key = requested_idempotency_key;
    if found then
      return query select v_prior.change_id, null::bigint, v_prior.password_changed_at,
        v_prior.other_sign_ins_ended, v_prior.session_id, null::timestamptz, true;
      return;
    end if;
    perform 1 from auth.sessions session_row
     where session_row.account_id = v_account_id and session_row.revoked_at is null
     order by session_row.id
       for update;
    v_now := clock_timestamp();

    -- 3. Refusals.
    if v_account.status <> 'active'
       or (v_account.disabled_until is not null and v_account.disabled_until > v_now) then
      raise exception using errcode = '42501', message = 'OWN_ACCOUNT_NOT_ACTIVE';
    end if;
    if identity.sealed_qa_account(v_account_id) or identity.sealed_demo_account(v_account_id) then
      raise exception using errcode = '42501', message = 'STAFF_PROFILE_CHANGE_NOT_ALLOWED';
    end if;
    if v_account.password_hash is null then
      raise exception using errcode = '55000', message = 'PASSWORD_NOT_SET';
    end if;
    if expected_password_hash is null or v_account.password_hash is distinct from expected_password_hash then
      raise exception using errcode = '40001', message = 'PASSWORD_CHANGED_MEANWHILE';
    end if;
    select session_row.id, session_row.family_id, session_row.authentication_method,
           session_row.absolute_expires_at
      into v_presented
      from auth.sessions session_row
     where session_row.id = requested_session_id
       and session_row.account_id = v_account_id
       and session_row.session_kind = 'staff'
       and session_row.revoked_at is null
       and session_row.expires_at > v_now
       and session_row.absolute_expires_at > v_now
       and session_row.account_token_version = v_account.token_version
       and session_row.access_jti = requested_access_jti;
    if not found then
      raise exception using errcode = '42501', message = 'OWN_SESSION_NOT_CURRENT';
    end if;

    -- 4. The new hash: 0029's policy (auth.complete_recovery_otp's own test).
    if length(coalesce(new_password_hash, '')) not between 64 and 512
       or new_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$' then
      raise exception using errcode = '22023', message = 'PASSWORD_HASH_INVALID';
    end if;
    v_expires := least(renewed_expires_at, v_presented.absolute_expires_at);
    if renewed_session_id is null or renewed_access_jti is null or renewed_expires_at is null
       or renewed_refresh_token_sha256 is null or renewed_refresh_token_sha256 !~ '^[0-9a-f]{64}$'
       or v_expires <= v_now then
      raise exception using errcode = '22023', message = 'OWN_SESSION_RENEWAL_INVALID';
    end if;

    -- 5. The account.
    update auth.accounts account_row
       set password_hash = new_password_hash, password_algorithm = 'argon2id', password_changed_at = v_now,
           token_version = account_row.token_version + 1, row_version = account_row.row_version + 1,
           updated_at = v_now
     where account_row.id = v_account_id
    returning account_row.token_version into v_new_version;

    -- 6. Every other sign-in ends: one 'revoked' event per sign-in touched; the live ones are counted.
    with ended as (
      update auth.sessions session_row
         set revoked_at = v_now, revocation_reason = 'password_changed', row_version = session_row.row_version + 1
       where session_row.account_id = v_account_id
         and session_row.revoked_at is null
         and session_row.id <> v_presented.id
      returning session_row.id, session_row.family_id, session_row.issued_at,
        (session_row.expires_at > v_now and session_row.absolute_expires_at > v_now
         and session_row.account_token_version = v_account.token_version) as live
    ), families as (
      select ended.family_id, (array_agg(ended.id order by ended.issued_at desc, ended.id desc))[1] as last_session_id,
             bool_or(ended.live) as live
        from ended
       group by ended.family_id
    ), events as (
      insert into auth.session_events (session_id, account_id, event_type, outcome, correlation_id, source_ip,
        user_agent_sha256, details)
      select families.last_session_id, v_account_id, 'revoked', 'success', v_correlation, requested_source_ip,
             v_user_agent_sha256, jsonb_build_object('reason', 'password_changed', 'live', families.live)
        from families
      returning 1
    )
    select count(*) filter (where families.live and families.family_id <> v_presented.family_id)::integer
      into v_ended
      from families;

    -- 7. The presented sign-in, renewed in its own family.
    insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
      authentication_method, issued_at, expires_at, absolute_expires_at, source_ip, user_agent_sha256,
      session_kind, patient_id)
    values (renewed_session_id, v_account_id, v_presented.family_id, renewed_refresh_token_sha256, renewed_access_jti,
      v_new_version, v_presented.authentication_method, v_now, v_expires, v_presented.absolute_expires_at,
      requested_source_ip, v_user_agent_sha256, 'staff', null);
    update auth.sessions session_row
       set revoked_at = v_now, revocation_reason = 'rotated', replaced_by_session_id = renewed_session_id,
           row_version = session_row.row_version + 1
     where session_row.id = v_presented.id;
    insert into auth.session_events (session_id, account_id, event_type, outcome, correlation_id, source_ip,
      user_agent_sha256, details)
    values (v_presented.id, v_account_id, 'rotated', 'success', v_correlation, requested_source_ip,
      v_user_agent_sha256, jsonb_build_object('reason', 'password_changed'));

    -- 8. The audit row.
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
      resource_type, resource_id, purpose_of_use, source_ip, user_agent, provenance, source_system, details)
    values (v_correlation, 'staff', v_subject, v_account_id, 'auth.password.change', 'success', 'session',
      renewed_session_id::text, 'healthcare-operations', requested_source_ip, v_user_agent, 'application',
      'identity-api', jsonb_build_object('otherSignInsEnded', v_ended, 'changeId', v_change_id));

    -- 9. The request, and the answer.
    insert into auth.password_change_requests (account_id, idempotency_key, change_id, session_id,
      other_sign_ins_ended, password_changed_at)
    values (v_account_id, requested_idempotency_key, v_change_id, renewed_session_id, v_ended, v_now);
    return query select v_change_id, v_new_version, v_now, v_ended, renewed_session_id, v_expires, false;
  end
  $fn$;
  comment on function auth.change_own_password(uuid, uuid, text, text, text, uuid, uuid, text, timestamptz, inet, text) is
    '0205 (SX-6): the signed-in staff member changes their own password (Node verified the current one and hashed the new one): compare-and-swap on the hash, token version + 1, every other sign-in ended, the presented sign-in renewed in its family, one audit row. Without a new hash, only the replay read of the Idempotency-Key.';

  -- B5. Edit the own name.
  create function auth.change_own_display_name(
    requested_name text,
    expected_version bigint,
    requested_idempotency_key text,
    requested_session_id uuid,
    requested_source_ip inet,
    requested_user_agent text
  ) returns table (profile_version bigint, display_name text, replayed boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    v_subject text := platform.current_actor_subject();
    v_correlation text := platform.current_correlation_id();
    v_account_id uuid;
    v_account record;
    v_prior record;
    v_now timestamptz;
    v_name text := btrim(requested_name);
    v_name_sha256 text;
    v_version bigint;
    v_user_agent text := nullif(left(coalesce(requested_user_agent, ''), 512), '');
  begin
    if requested_idempotency_key is null
       or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
    end if;
    v_account_id := auth.account_id_for_subject(v_subject);
    if v_subject is null or v_account_id is null or v_correlation is null then
      raise exception using errcode = '42501', message = 'OWN_ACCOUNT_NOT_ACTIVE';
    end if;
    select account_row.id, account_row.status, account_row.disabled_until, account_row.display_name
      into v_account
      from auth.accounts account_row
     where account_row.id = v_account_id
       for no key update;
    v_now := clock_timestamp();
    if v_account.status <> 'active'
       or (v_account.disabled_until is not null and v_account.disabled_until > v_now) then
      raise exception using errcode = '42501', message = 'OWN_ACCOUNT_NOT_ACTIVE';
    end if;
    if identity.sealed_qa_account(v_account_id) or identity.sealed_demo_account(v_account_id) then
      raise exception using errcode = '42501', message = 'STAFF_PROFILE_CHANGE_NOT_ALLOWED';
    end if;
    if not exists (
      select 1 from auth.sessions session_row join auth.accounts account_row on account_row.id = session_row.account_id
       where session_row.id = requested_session_id
         and session_row.account_id = v_account_id
         and session_row.session_kind = 'staff'
         and session_row.revoked_at is null
         and session_row.expires_at > v_now
         and session_row.absolute_expires_at > v_now
         and session_row.account_token_version = account_row.token_version) then
      raise exception using errcode = '42501', message = 'OWN_SESSION_NOT_CURRENT';
    end if;
    if not auth.staff_person_name_acceptable(v_name) then
      raise exception using errcode = '22023', message = 'STAFF_NAME_INVALID';
    end if;
    v_name_sha256 := encode(sha256(convert_to(v_name, 'UTF8')), 'hex');
    select coalesce(max(change_row.profile_version), 1) into v_version
      from auth.staff_name_changes change_row where change_row.account_id = v_account_id;

    -- A replay of the key: the same name answers the current state; another name is refused.
    select change_row.request_sha256 into v_prior
      from auth.staff_name_changes change_row
     where change_row.account_id = v_account_id and change_row.idempotency_key = requested_idempotency_key;
    if found then
      if v_prior.request_sha256 = v_name_sha256 then
        return query select v_version, v_account.display_name, true;
        return;
      end if;
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;

    if expected_version is null or expected_version <> v_version then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT';
    end if;
    if v_name = v_account.display_name then
      raise exception using errcode = '22023', message = 'STAFF_NAME_UNCHANGED';
    end if;
    if (select count(*) from auth.staff_name_changes change_row
         where change_row.account_id = v_account_id
           and change_row.changed_at > v_now - interval '24 hours') >= 3 then
      raise exception using errcode = '55000', message = 'STAFF_NAME_CHANGE_LIMITED';
    end if;

    update auth.accounts account_row
       set display_name = v_name, updated_at = v_now
     where account_row.id = v_account_id;
    insert into auth.staff_name_changes (account_id, profile_version, changed_at, idempotency_key, request_sha256)
    values (v_account_id, v_version + 1, v_now, requested_idempotency_key, v_name_sha256);
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
      resource_type, resource_id, purpose_of_use, source_ip, user_agent, provenance, source_system, details)
    values (v_correlation, 'staff', v_subject, v_account_id, 'auth.staff-profile.update', 'success', 'session',
      requested_session_id::text, 'healthcare-operations', requested_source_ip, v_user_agent, 'application',
      'identity-api', jsonb_build_object('previousName', v_account.display_name, 'newName', v_name,
        'profileVersion', v_version + 1));
    return query select v_version + 1, v_name, false;
  end
  $fn$;
  comment on function auth.change_own_display_name(text, bigint, text, uuid, inet, text) is
    '0205 (SX-6): the signed-in staff member changes their own name (auth.accounts.display_name only; identity.staff.full_name is never changed): the name rule, the expected profile version, at most 3 changes in 24 hours, one audit row with the previous and the new name.';

  -- B6. The own profile version, for SX-5.
  create function auth.own_profile_version()
  returns bigint
  language sql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select case when own.account_id is null then null
                else coalesce((select max(change_row.profile_version) from auth.staff_name_changes change_row
                                where change_row.account_id = own.account_id), 1) end
      from (select auth.account_id_for_subject(platform.current_actor_subject()) as account_id) own
  $fn$;
  comment on function auth.own_profile_version() is
    '0205 (SX-6): the profile version of the session''s own account (its largest name change, else 1), for GET /identity/me/staff-profile; null with no active account in the session.';

  -- Owners and EXECUTE (here and in runtime-grants.sql).
  if v_owner <> current_user then
    execute format('alter table auth.staff_name_changes owner to %I', v_owner);
    execute format('alter table auth.password_change_requests owner to %I', v_owner);
    execute format('alter function auth.staff_person_name_acceptable(text) owner to %I', v_owner);
    execute format('alter function auth.change_own_password(uuid, uuid, text, text, text, uuid, uuid, text, '
                   || 'timestamptz, inet, text) owner to %I', v_owner);
    execute format('alter function auth.change_own_display_name(text, bigint, text, uuid, inet, text) owner to %I',
                   v_owner);
    execute format('alter function auth.own_profile_version() owner to %I', v_owner);
  end if;
  revoke all on function auth.change_own_password(uuid, uuid, text, text, text, uuid, uuid, text, timestamptz, inet, text),
    auth.change_own_display_name(text, bigint, text, uuid, inet, text), auth.own_profile_version() from public;
  if v_runtime_exists then
    grant execute on function
      auth.change_own_password(uuid, uuid, text, text, text, uuid, uuid, text, timestamptz, inet, text),
      auth.change_own_display_name(text, bigint, text, uuid, inet, text),
      auth.own_profile_version()
      to hid_identity_runtime;
  end if;

  -- 3. Post-checks.
  -- auth.accounts: owner, privileges and triggers exactly as found; the Identity runtime still only reads it.
  if (select format('%s|%s|%s', pg_get_userbyid(class_row.relowner), class_row.relacl::text,
            (select string_agg(format('%s %s %s %s %s', trigger_row.tgname, trigger_row.tgtype,
                                      trigger_row.tgfoid::regprocedure, trigger_row.tgenabled,
                                      pg_get_triggerdef(trigger_row.oid)), ';' order by trigger_row.tgname)
               from pg_trigger trigger_row where trigger_row.tgrelid = class_row.oid and not trigger_row.tgisinternal))
        from pg_class class_row where class_row.oid = 'auth.accounts'::regclass) is distinct from v_accounts_before
     or (v_runtime_exists
         and (has_table_privilege('hid_identity_runtime', 'auth.accounts', 'INSERT')
              or has_any_column_privilege('hid_identity_runtime', 'auth.accounts', 'UPDATE')
              or has_table_privilege('hid_identity_runtime', 'auth.accounts', 'DELETE')
              or has_table_privilege('hid_identity_runtime', 'auth.accounts', 'TRUNCATE'))) then
    raise exception using errcode = '55000', message = '0205: post-check failed (auth.accounts is not as found)';
  end if;
  -- The two tables: plain tables of the owner, row-level security enabled and not forced, no policy, no privilege
  -- for any role but the owner.
  if (select count(*) from pg_class class_row
       where class_row.oid in ('auth.staff_name_changes'::regclass, 'auth.password_change_requests'::regclass)
         and class_row.relkind = 'r' and class_row.relrowsecurity and not class_row.relforcerowsecurity
         and class_row.relowner = (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner)) <> 2
     or exists (select 1 from pg_class class_row,
                       lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
                 where class_row.oid in ('auth.staff_name_changes'::regclass, 'auth.password_change_requests'::regclass)
                   and acl.grantee <> class_row.relowner)
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid in ('auth.staff_name_changes'::regclass,
                                               'auth.password_change_requests'::regclass)) then
    raise exception using errcode = '55000',
      message = '0205: post-check failed (a new table is granted to a role, is not the owner''s, or its row-level security is not enabled and unforced without a policy)';
  end if;
  -- Their triggers (pg_trigger.tgtype: 1 for each row, 2 before, 8 delete, 16 update, 32 truncate): 27 before update
  -- or delete for each row, 34 before truncate; no WHEN, no column list, no argument; enabled in origin mode; 0001's
  -- platform.reject_mutation. No other trigger on either table.
  if (select count(*) from pg_trigger trigger_row
       where not trigger_row.tgisinternal
         and trigger_row.tgrelid in ('auth.staff_name_changes'::regclass, 'auth.password_change_requests'::regclass))
       <> 4
     or (select count(*) from pg_trigger trigger_row
          where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
            and trigger_row.tgrelid in ('auth.staff_name_changes'::regclass, 'auth.password_change_requests'::regclass)
            and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure
            and trigger_row.tgqual is null and trigger_row.tgattr = ''::int2vector and trigger_row.tgnargs = 0
            and ((trigger_row.tgname like '%\_append\_only' and trigger_row.tgtype = 27)
                 or (trigger_row.tgname like '%\_no\_truncate' and trigger_row.tgtype = 34))) <> 4 then
    raise exception using errcode = '55000', message = '0205: post-check failed (the new tables'' triggers)';
  end if;
  -- The four functions: the owner's; B4-B6 SECURITY DEFINER, B3 not; the fixed search_path; the reviewed bodies;
  -- EXECUTE only for hid_identity_runtime on B4-B6 and for no role on B3.
  if (select count(*) from pg_proc proc
       where proc.oid in (to_regprocedure('auth.change_own_password(uuid, uuid, text, text, text, uuid, uuid, text, '
                                          || 'timestamp with time zone, inet, text)'),
                          to_regprocedure('auth.change_own_display_name(text, bigint, text, uuid, inet, text)'),
                          to_regprocedure('auth.own_profile_version()'))
         and proc.prosecdef
         and proc.proconfig = array['search_path=pg_catalog, pg_temp']
         and proc.proowner = (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner)) <> 3
     or (select count(*) from pg_proc proc
          where proc.oid = to_regprocedure('auth.staff_person_name_acceptable(text)')
            and not proc.prosecdef and proc.provolatile = 'i'
            and proc.proconfig = array['search_path=pg_catalog, pg_temp']
            and proc.proowner = (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner)) <> 1
     or (select string_agg(md5(proc.prosrc), ',' order by proc.proname collate "C") from pg_proc proc
          where proc.pronamespace = 'auth'::regnamespace
            and proc.proname in ('staff_person_name_acceptable', 'change_own_password', 'change_own_display_name',
                                 'own_profile_version'))
        is distinct from c_display_name_md5 || ',' || c_password_md5 || ',' || c_profile_version_md5 || ','
          || c_name_rule_md5
     or exists (select 1 from pg_proc proc,
                       lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.pronamespace = 'auth'::regnamespace
                   and proc.proname in ('staff_person_name_acceptable', 'change_own_password',
                                        'change_own_display_name', 'own_profile_version')
                   and acl.grantee <> proc.proowner
                   and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime'
                        or acl.privilege_type <> 'EXECUTE' or proc.proname = 'staff_person_name_acceptable'))
     or (v_runtime_exists
         and (select count(*) from pg_proc proc
               where proc.pronamespace = 'auth'::regnamespace
                 and proc.proname in ('change_own_password', 'change_own_display_name', 'own_profile_version')
                 and has_function_privilege('hid_identity_runtime', proc.oid, 'EXECUTE')) <> 3) then
    raise exception using errcode = '55000', message = '0205: post-check failed (the functions'' security, owner, body or grants)';
  end if;

  raise notice '0205: own password change and own name edit installed (two tables, four functions); nothing is changed for any account until Identity calls them.';
end
$sx6own0205$;
