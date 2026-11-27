\set ON_ERROR_STOP on
-- 0205 (SX-6): change your own password while signed in, and edit your own
-- name. Rollback-only. The calls run as the Identity API's runtime login
-- (hid_identity_api_runtime, a member of hid_identity_runtime) with the
-- account-only context identity-api sets (app.actor_subject,
-- app.correlation_id; no facility, no membership), as the API makes them.
-- Fictional values only; uuid prefix f205; .invalid addresses; the password
-- hashes are made-up strings in the argon2id policy's shape, never a hash of
-- any password.
--
--   1. structure: the two tables (columns, keys, the foreign key to
--      auth.accounts ON DELETE RESTRICT, row-level security enabled and not
--      forced, no policy, no privilege for any role but the owner, the
--      append-only triggers); the four functions (owner, SECURITY DEFINER or
--      not, search_path, EXECUTE only for the Identity runtime on the three
--      entry points and for no role on the name rule); auth.accounts' grants
--      unchanged (the Identity runtime reads it only);
--   2. the runtimes cannot touch the new tables or run the name rule: the
--      Identity API runtime, the EHR runtime and the schema test runtime get
--      42501; even the owner cannot update, delete or truncate a row (55000);
--   3. the name rule (B3) case by case, the same answers as identity-api's
--      acceptableStaffPersonName (staff-names.ts), including names whose
--      combining marks lie outside the Latin blocks (Arabic harakat,
--      Devanagari, Thai, Hebrew, Tamil) and the 80-character bound counted
--      in UTF-16 code units, as JavaScript counts it;
--   4. the password change, as the Identity API runtime: refusals first, each
--      changing nothing (bad key, wrong current hash, revoked, expired,
--      stale-version or wrong-token presented session, a patient session,
--      another account's session even at the caller's token version, a bad
--      new hash, a hash in the policy's shape under 64 characters, a bad
--      renewal, no password, a sealed QA and a sealed demo login, a disabled
--      and a deleted account); then the change: the hash, password_changed_at,
--      token version + 1, every other session of both kinds revoked with
--      password_changed, the live other sign-ins counted (not the expired or
--      stale ones), one 'revoked' event per sign-in touched, the presented
--      session rotated into a renewed session of the same family at the new
--      version (same method, absolute end, source IP), one audit row (staff,
--      'session', no facility, only otherSignInsEnded and changeId), one
--      request row, and no password material in any of them; a replay (the
--      full call and the read alone) answers the stored row and changes
--      nothing; an unknown key reads no row; then the edges: a sign-in whose
--      absolute end comes before the idle end asked for (the renewed idle end
--      is clamped to it) and that was made through single sign-on (the
--      renewed session keeps 'oidc'); a bcrypt_legacy account (argon2id
--      after the change); a second account using the first account's key
--      (its own change, not a replay, in both the read and the full call);
--   5. the name edit, as the Identity API runtime: refusals (bad key, invalid
--      name, version conflict, the current name, sealed, a session not
--      current: another account's, signed out, expired, at an older token
--      version, a patient session of the account); a change (display_name
--      and updated_at only, never identity.staff.full_name; one B1 row; one
--      audit row with the previous and new name, the version and the source
--      IP; auth.own_profile_version); a replay with the same name, and the
--      same key with another name (IDEMPOTENCY_KEY_REUSED); the fourth change
--      within 24 hours refused; a second account whose versions, keys and
--      limit are its own, and the 24-hour window's end (a change 24 hours and
--      a minute ago is not counted, one 23 hours 50 minutes ago is);
--   6. Identity's own statements (staff-profile-changes.ts), verbatim, as the
--      Identity API runtime with EXECUTE ... USING (the start-up check, the
--      account read, the change, the replay read, the lockout clear, the name
--      edit, the profile version); staff-profile-changes-sql.spec.ts holds
--      this section to their exact text;
--   7. with dblink (skipped where it is not available), the row locks and the
--      checks made under them, on a committed fictional account and its
--      sessions that the section deletes again (every call runs in a second
--      session's transaction that rolls back, so no audit row stays):
--      K1 the account row is locked FOR NO KEY UPDATE first: another
--         transaction holding it makes each function wait (lock_timeout,
--         55P03), while one holding FOR KEY SHARE on it (a refresh inserting
--         a session) does not;
--      K2 the password change then locks the account's unrevoked sessions
--         FOR UPDATE before it changes any: a transaction holding even FOR
--         KEY SHARE on another of them makes it wait;
--      K3 the account's status and disabled_until are read again under the
--         lock: a transaction that locks the account (status 'locked', or
--         disabled_until in the future) and commits while the call waits gets
--         OWN_ACCOUNT_NOT_ACTIVE from each function, although
--         auth.account_id_for_subject had found the account active.
set plpgsql.variable_conflict = error;

-- dblink (section 7) is created before the transaction and dropped again at the end, as in
-- own-password-and-name-migration.integration.sql.
select exists (select 1 from pg_available_extensions where name = 'dblink') as own_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as own_dblink_create \gset
\if :own_dblink_available
\if :own_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

-- Accounts: S staff (password, also a patient), N staff without a password, Q a sealed QA login, D a sealed demo
-- login, X disabled, Z deleted, E staff for the name edit (also a patient); C a sign-in made through single sign-on
-- whose absolute end is near, L a bcrypt_legacy password, W another account at S's token version, R a second
-- account for the name edit, V the account Identity's own statements run for (section 6).
insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm, token_version,
    disabled_until) values
  ('f2050000-0000-4000-8000-00000000000a', 'synthetic:own-0205:s', 's@own-0205.invalid', 'Ada Fictional', 'active',
   '$argon2id$v=19$m=65536,t=3,p=1$c3RvcmVkLXNhbHQ$c3RvcmVkLWZpY3Rpb25hbC1oYXNoLW9mLW5vdGhpbmc', 'argon2id', 4, null),
  ('f2050000-0000-4000-8000-00000000000b', 'synthetic:own-0205:n', 'n@own-0205.invalid', 'Bayo Fictional', 'active',
   null, null, 1, null),
  ('f2050000-0000-4000-8000-00000000000c', 'synthetic:own-0205:q', 'q@own-0205.invalid', 'Chidi Fictional', 'active',
   'qa-shared-hash', 'argon2id', 1, null),
  ('f2050000-0000-4000-8000-00000000000d', 'synthetic:own-0205:d', 'd@own-0205.invalid', 'Dayo Fictional', 'active',
   'demo-shared-hash', 'argon2id', 1, null),
  ('f2050000-0000-4000-8000-00000000000e', 'synthetic:own-0205:x', 'x@own-0205.invalid', 'Efe Fictional', 'active',
   'disabled-hash', 'argon2id', 1, now() + interval '1 day'),
  ('f2050000-0000-4000-8000-00000000000f', 'synthetic:own-0205:z', 'z@own-0205.invalid', 'Femi Fictional', 'deleted',
   null, null, 1, null),
  ('f2050000-0000-4000-8000-000000000010', 'synthetic:own-0205:e', 'e@own-0205.invalid', 'Gbenga Fictional', 'active',
   'name-edit-hash', 'argon2id', 2, null),
  ('f2050000-0000-4000-8000-000000000011', 'synthetic:own-0205:c', 'c@own-0205.invalid', 'Chiamaka Fictional', 'active',
   '$argon2id$v=19$m=65536,t=3,p=1$Y2xhbXAtc2FsdA$Y2xhbXAtZmljdGlvbmFsLWhhc2gtb2Ytbm90aGluZw', 'argon2id', 2, null),
  ('f2050000-0000-4000-8000-000000000012', 'synthetic:own-0205:l', 'l@own-0205.invalid', 'Lola Fictional', 'active',
   '$2b$12$ZmljdGlvbmFsLWxlZ2FjeS1zYWx0LWhhc2gtb2Ytbm90aGluZ3g', 'bcrypt_legacy', 1, null),
  ('f2050000-0000-4000-8000-000000000013', 'synthetic:own-0205:r', 'r@own-0205.invalid', 'Remi Fictional', 'active',
   'rename-hash', 'argon2id', 1, null),
  ('f2050000-0000-4000-8000-000000000014', 'synthetic:own-0205:w', 'w@own-0205.invalid', 'Wale Fictional', 'active',
   '$argon2id$v=19$m=65536,t=3,p=1$d2FsZS1zYWx0$d2FsZS1maWN0aW9uYWwtaGFzaC1vZi1ub3RoaW5n', 'argon2id', 4, null),
  ('f2050000-0000-4000-8000-000000000015', 'synthetic:own-0205:v', 'v@own-0205.invalid', 'Vera Fictional', 'active',
   '$argon2id$v=19$m=65536,t=3,p=1$dmVyYS1zYWx0$dmVyYS1maWN0aW9uYWwtaGFzaC1vZi1ub3RoaW5n', 'argon2id', 1, null);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('f2051000-0000-4000-8000-00000000000a', 'f2050000-0000-4000-8000-00000000000a', 'Ada N. Fictional',
   's@own-0205.invalid', 'verified', 'doctor', true),
  ('f2051000-0000-4000-8000-000000000010', 'f2050000-0000-4000-8000-000000000010', 'Gbenga Registered Fictional',
   'e@own-0205.invalid', 'verified', 'nurse', true);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status, account_id) values
  ('f2052000-0000-4000-8000-00000000000a', 'HID-QS2B3K', 'Ada', 'Fictional', 'Ada Fictional', '1990-05-01', 'active',
   'f2050000-0000-4000-8000-00000000000a'),
  ('f2052000-0000-4000-8000-000000000010', 'HID-QS2B3N', 'Gbenga', 'Fictional', 'Gbenga Fictional', '1988-02-03',
   'active', 'f2050000-0000-4000-8000-000000000010');
insert into identity.sealed_qa_members (member_kind, member_id) values ('account', 'f2050000-0000-4000-8000-00000000000c');
insert into identity.sealed_demo_members (member_kind, member_id) values ('account', 'f2050000-0000-4000-8000-00000000000d');

-- S's sessions: a1 the presented staff sign-in (family a1; a0 its earlier, rotated session); b1 another live staff
-- sign-in; p1 a live patient sign-in; e1 a staff sign-in that expired unrevoked; v1 a staff sign-in at an older token
-- version (dead since a reset); r1 one signed out already. Each other account has one live staff session; E also
-- has one signed out (10d0), one expired unrevoked (10e0), one at its older token version (10f0) and a live patient
-- session (10c0); C's live staff session was made through single sign-on and ends absolutely in 2 hours.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, revoked_at, revocation_reason, session_kind,
    patient_id, replaced_by_session_id)
select fixture.id::uuid, fixture.account::uuid, fixture.family::uuid, md5(fixture.id) || md5(fixture.id || 'refresh'),
  fixture.jti::uuid, fixture.version, fixture.method, fixture.issued, fixture.expires, fixture.absolute,
  fixture.revoked, fixture.reason, fixture.kind, fixture.patient::uuid, null
from (values
  ('f2053000-0000-4000-8000-0000000000a1', 'f2050000-0000-4000-8000-00000000000a', 'f2053000-0000-4000-8000-0000000000a0',
   'f2054000-0000-4000-8000-0000000000a1', 4, 'password', now() - interval '1 hour', now() + interval '7 hours',
   now() + interval '20 hours', null::timestamptz, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000000a0', 'f2050000-0000-4000-8000-00000000000a', 'f2053000-0000-4000-8000-0000000000a0',
   'f2054000-0000-4000-8000-0000000000a0', 4, 'password', now() - interval '4 hours', now() + interval '4 hours',
   now() + interval '20 hours', now() - interval '1 hour', 'rotated', 'staff', null),
  ('f2053000-0000-4000-8000-0000000000b1', 'f2050000-0000-4000-8000-00000000000a', 'f2053000-0000-4000-8000-0000000000b1',
   'f2054000-0000-4000-8000-0000000000b1', 4, 'password', now() - interval '2 hours', now() + interval '6 hours',
   now() + interval '22 hours', null, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000000c1', 'f2050000-0000-4000-8000-00000000000a', 'f2053000-0000-4000-8000-0000000000c1',
   'f2054000-0000-4000-8000-0000000000c1', 4, 'password', now() - interval '1 day', now() + interval '6 days',
   now() + interval '29 days', null, null, 'patient', 'f2052000-0000-4000-8000-00000000000a'),
  ('f2053000-0000-4000-8000-0000000000e1', 'f2050000-0000-4000-8000-00000000000a', 'f2053000-0000-4000-8000-0000000000e1',
   'f2054000-0000-4000-8000-0000000000e1', 4, 'password', now() - interval '10 hours', now() - interval '2 hours',
   now() + interval '14 hours', null, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000000f1', 'f2050000-0000-4000-8000-00000000000a', 'f2053000-0000-4000-8000-0000000000f1',
   'f2054000-0000-4000-8000-0000000000f1', 3, 'password', now() - interval '3 hours', now() + interval '5 hours',
   now() + interval '21 hours', null, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000000d1', 'f2050000-0000-4000-8000-00000000000a', 'f2053000-0000-4000-8000-0000000000d1',
   'f2054000-0000-4000-8000-0000000000d1', 4, 'password', now() - interval '3 hours', now() + interval '5 hours',
   now() + interval '21 hours', now() - interval '2 hours', 'logout', 'staff', null),
  ('f2053000-0000-4000-8000-0000000000b9', 'f2050000-0000-4000-8000-00000000000b', 'f2053000-0000-4000-8000-0000000000b9',
   'f2054000-0000-4000-8000-0000000000b9', 1, 'oidc', now(), now() + interval '8 hours', now() + interval '24 hours',
   null, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000000c9', 'f2050000-0000-4000-8000-00000000000c', 'f2053000-0000-4000-8000-0000000000c9',
   'f2054000-0000-4000-8000-0000000000c9', 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours',
   null, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000000d9', 'f2050000-0000-4000-8000-00000000000d', 'f2053000-0000-4000-8000-0000000000d9',
   'f2054000-0000-4000-8000-0000000000d9', 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours',
   null, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000000e9', 'f2050000-0000-4000-8000-00000000000e', 'f2053000-0000-4000-8000-0000000000e9',
   'f2054000-0000-4000-8000-0000000000e9', 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours',
   null, null, 'staff', null),
  ('f2053000-0000-4000-8000-000000000010', 'f2050000-0000-4000-8000-000000000010', 'f2053000-0000-4000-8000-000000000010',
   'f2054000-0000-4000-8000-000000000010', 2, 'password', now(), now() + interval '8 hours', now() + interval '24 hours',
   null, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000010d0', 'f2050000-0000-4000-8000-000000000010', 'f2053000-0000-4000-8000-0000000010d0',
   'f2054000-0000-4000-8000-0000000010d0', 2, 'password', now() - interval '2 hours', now() + interval '6 hours',
   now() + interval '22 hours', now() - interval '1 hour', 'logout', 'staff', null),
  ('f2053000-0000-4000-8000-0000000010e0', 'f2050000-0000-4000-8000-000000000010', 'f2053000-0000-4000-8000-0000000010e0',
   'f2054000-0000-4000-8000-0000000010e0', 2, 'password', now() - interval '10 hours', now() - interval '2 hours',
   now() + interval '14 hours', null, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000010f0', 'f2050000-0000-4000-8000-000000000010', 'f2053000-0000-4000-8000-0000000010f0',
   'f2054000-0000-4000-8000-0000000010f0', 1, 'password', now() - interval '3 hours', now() + interval '5 hours',
   now() + interval '21 hours', null, null, 'staff', null),
  ('f2053000-0000-4000-8000-0000000010c0', 'f2050000-0000-4000-8000-000000000010', 'f2053000-0000-4000-8000-0000000010c0',
   'f2054000-0000-4000-8000-0000000010c0', 2, 'password', now() - interval '1 day', now() + interval '6 days',
   now() + interval '29 days', null, null, 'patient', 'f2052000-0000-4000-8000-000000000010'),
  ('f2053000-0000-4000-8000-000000000011', 'f2050000-0000-4000-8000-000000000011', 'f2053000-0000-4000-8000-000000000011',
   'f2054000-0000-4000-8000-000000000011', 2, 'oidc', now() - interval '1 hour', now() + interval '1 hour',
   now() + interval '2 hours', null, null, 'staff', null),
  ('f2053000-0000-4000-8000-000000000012', 'f2050000-0000-4000-8000-000000000012', 'f2053000-0000-4000-8000-000000000012',
   'f2054000-0000-4000-8000-000000000012', 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours',
   null, null, 'staff', null),
  ('f2053000-0000-4000-8000-000000000013', 'f2050000-0000-4000-8000-000000000013', 'f2053000-0000-4000-8000-000000000013',
   'f2054000-0000-4000-8000-000000000013', 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours',
   null, null, 'staff', null),
  ('f2053000-0000-4000-8000-000000000014', 'f2050000-0000-4000-8000-000000000014', 'f2053000-0000-4000-8000-000000000014',
   'f2054000-0000-4000-8000-000000000014', 4, 'password', now(), now() + interval '8 hours', now() + interval '24 hours',
   null, null, 'staff', null),
  ('f2053000-0000-4000-8000-000000000015', 'f2050000-0000-4000-8000-000000000015', 'f2053000-0000-4000-8000-000000000015',
   'f2054000-0000-4000-8000-000000000015', 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours',
   null, null, 'staff', null)
) fixture(id, account, family, jti, version, method, issued, expires, absolute, revoked, reason, kind, patient);
update auth.sessions set replaced_by_session_id = 'f2053000-0000-4000-8000-0000000000a1'
 where id = 'f2053000-0000-4000-8000-0000000000a0';
-- R's earlier name changes, written as the owner would (inserts are allowed; only update, delete and truncate are
-- refused): version 2 thirty hours ago, version 3 twenty-four hours and a minute ago (just outside the 24-hour
-- window) and version 4 twenty-three hours and fifty minutes ago (inside it).
insert into auth.staff_name_changes (account_id, profile_version, changed_at, idempotency_key, request_sha256) values
  ('f2050000-0000-4000-8000-000000000013', 2, now() - interval '30 hours', 'own-0205-key-r-history2',
   md5('r2') || md5('r2 name')),
  ('f2050000-0000-4000-8000-000000000013', 3, now() - interval '24 hours 1 minute', 'own-0205-key-r-history3',
   md5('r3') || md5('r3 name')),
  ('f2050000-0000-4000-8000-000000000013', 4, now() - interval '23 hours 50 minutes', 'own-0205-key-r-history4',
   md5('r4') || md5('r4 name'));
-- V's sign-in lockout (section 6 clears it with Identity's own statement); its key is made up.
insert into auth.login_attempts (principal_hmac, pepper_version, failure_count, window_started_at, locked_until,
    last_failed_at)
values (repeat('f205', 16), 1, 5, now() - interval '5 minutes', now() + interval '10 minutes', now() - interval '1 minute');

create temporary table own_outcomes (seq serial, name text primary key, expected text not null, actual text) on commit drop;
grant select, insert on pg_temp.own_outcomes to hid_identity_api_runtime, hid_ehr_runtime, hid_schema_test_runtime;
grant usage on sequence pg_temp.own_outcomes_seq_seq to hid_identity_api_runtime, hid_ehr_runtime, hid_schema_test_runtime;
create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.own_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
-- The account-only context identity-api sets (accountOnlyContext): the subject and correlation id; no facility or
-- membership ('' reads as null).
create function pg_temp.as_account(subject text, correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', subject, true), set_config('app.correlation_id', correlation, true),
         set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
         set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
-- A new hash in 0029's policy's shape (made up, never a hash of a password).
create function pg_temp.new_hash(tag text) returns text language sql immutable as $f$
  select '$argon2id$v=19$m=65536,t=3,p=1$' || encode(convert_to('fictional-salt-' || tag, 'UTF8'), 'base64') || '$'
         || md5(tag) || md5(tag || 'second')
$f$;
-- The password change, answering its row or the error's SQLSTATE and key.
create function pg_temp.change_password(session_id uuid, access_jti uuid, expected_hash text, new_hash text,
  idempotency_key text, renewed_id uuid default 'f2055000-0000-4000-8000-0000000000a2',
  renewed_jti uuid default 'f2056000-0000-4000-8000-0000000000a2',
  renewed_sha text default repeat('ab', 32), renewed_expires timestamptz default now() + interval '8 hours')
returns text language plpgsql as $f$
declare
  answer text;
begin
  select format('changed %s/%s/%s/%s', result.token_version, result.other_sign_ins_ended, result.session_id,
                result.replayed)
    into answer
    from auth.change_own_password(session_id, access_jti, expected_hash, new_hash, idempotency_key, renewed_id,
           renewed_jti, renewed_sha, renewed_expires, '203.0.113.7'::inet, 'Fictional Browser/1.0') result;
  return coalesce(answer, 'no row');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.change_name(requested_name text, expected_version bigint, idempotency_key text,
  session_id uuid default 'f2053000-0000-4000-8000-000000000010') returns text language plpgsql as $f$
declare
  answer text;
begin
  select format('%s/%s/%s', result.profile_version, result.display_name, result.replayed) into answer
    from auth.change_own_display_name(requested_name, expected_version, idempotency_key, session_id,
           '203.0.113.8'::inet, 'Fictional Browser/2.0') result;
  return coalesce(answer, 'no row');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- Whether a statement run as the current role is refused (its SQLSTATE) or runs ('ran').
create function pg_temp.attempt(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ran';
exception when others then
  return sqlstate;
end
$f$;
-- S's state in one line: token version, hash tag, sessions by state, events, audit rows, request rows.
create function pg_temp.s_state() returns text language sql as $f$
  select format('v%s %s sessions:%s events:%s audit:%s requests:%s',
    (select token_version from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'),
    (select case when password_hash like '%c3RvcmVkLWZpY3Rpb25hbC1oYXNoLW9mLW5vdGhpbmc' then 'old-hash' else 'new-hash' end
       from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'),
    (select count(*) filter (where revoked_at is null) || '/' || count(*) from auth.sessions
      where account_id = 'f2050000-0000-4000-8000-00000000000a'),
    (select count(*) from auth.session_events where account_id = 'f2050000-0000-4000-8000-00000000000a'),
    (select count(*) from audit.events where actor_account_id = 'f2050000-0000-4000-8000-00000000000a'
                                         and action = 'auth.password.change'),
    (select count(*) from auth.password_change_requests where account_id = 'f2050000-0000-4000-8000-00000000000a'))
$f$;

-- 1. Structure.
select pg_temp.check_case('1 name changes: columns',
  'account_id uuid!,profile_version bigint!,changed_at timestamp with time zone!,idempotency_key text!,request_sha256 character(64)!',
  (select string_agg(attname || ' ' || format_type(atttypid, atttypmod) || case when attnotnull then '!' else '' end, ','
                     order by attnum)
     from pg_attribute where attrelid = 'auth.staff_name_changes'::regclass and attnum > 0 and not attisdropped));
select pg_temp.check_case('1 password changes: columns',
  'account_id uuid!,idempotency_key text!,change_id uuid!,session_id uuid!,other_sign_ins_ended integer!,password_changed_at timestamp with time zone!,created_at timestamp with time zone!',
  (select string_agg(attname || ' ' || format_type(atttypid, atttypmod) || case when attnotnull then '!' else '' end, ','
                     order by attnum)
     from pg_attribute where attrelid = 'auth.password_change_requests'::regclass and attnum > 0 and not attisdropped));
select pg_temp.check_case('1 keys and the one foreign key each (restrict)',
  'auth.password_change_requests f auth.accounts(account_id)/r|auth.password_change_requests p (account_id,idempotency_key)|auth.password_change_requests u (change_id)|auth.staff_name_changes f auth.accounts(account_id)/r|auth.staff_name_changes p (account_id,profile_version)|auth.staff_name_changes u (account_id,idempotency_key)',
  (select string_agg(format('%s %s %s', conrelid::regclass, contype,
       case when contype = 'f' then format('%s(%s)/%s', confrelid::regclass,
              (select string_agg(attname, ',' order by array_position(conkey, attnum)) from pg_attribute
                where attrelid = conrelid and attnum = any (conkey)), confdeltype)
            else '(' || (select string_agg(attname, ',' order by array_position(conkey, attnum)) from pg_attribute
                          where attrelid = conrelid and attnum = any (conkey)) || ')' end),
       '|' order by conrelid::regclass::text, contype, conname)
     from pg_constraint
    where conrelid in ('auth.staff_name_changes'::regclass, 'auth.password_change_requests'::regclass)
      and contype in ('p', 'u', 'f')));
select pg_temp.check_case('1 both tables: the migrator''s, row-level security on and not forced, no policy, no grant',
  'relb_migrator t f 0 {relb_migrator=arwdDxt/relb_migrator}|relb_migrator t f 0 {relb_migrator=arwdDxt/relb_migrator}',
  (select string_agg(format('%s %s %s %s %s', pg_get_userbyid(relowner), relrowsecurity, relforcerowsecurity,
       (select count(*) from pg_policy where polrelid = class_row.oid), relacl), '|' order by relname)
     from pg_class class_row
    where oid in ('auth.staff_name_changes'::regclass, 'auth.password_change_requests'::regclass)));
select pg_temp.check_case('1 append-only triggers',
  'password_change_requests_append_only 27 platform.reject_mutation() O|password_change_requests_no_truncate 34 platform.reject_mutation() O|staff_name_changes_append_only 27 platform.reject_mutation() O|staff_name_changes_no_truncate 34 platform.reject_mutation() O',
  (select string_agg(format('%s %s %s %s', tgname, tgtype, tgfoid::regprocedure, tgenabled), '|' order by tgname)
     from pg_trigger where not tgisinternal
      and tgrelid in ('auth.staff_name_changes'::regclass, 'auth.password_change_requests'::regclass)));
select pg_temp.check_case('1 the four functions: owner, definer, volatility, search_path and EXECUTE',
  'change_own_display_name relb_migrator t v {"search_path=pg_catalog, pg_temp"} hid_identity_runtime|change_own_password relb_migrator t v {"search_path=pg_catalog, pg_temp"} hid_identity_runtime|own_profile_version relb_migrator t s {"search_path=pg_catalog, pg_temp"} hid_identity_runtime|staff_person_name_acceptable relb_migrator f i {"search_path=pg_catalog, pg_temp"} -',
  (select string_agg(format('%s %s %s %s %s %s', proname, pg_get_userbyid(proowner), case when prosecdef then 't' else 'f' end,
       provolatile, proconfig,
       coalesce((select string_agg(case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
                                   || case when acl.privilege_type <> 'EXECUTE' then ':' || acl.privilege_type else '' end,
                                   ',' order by 1)
                   from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl where acl.grantee <> proowner), '-')),
       '|' order by proname)
     from pg_proc
    where pronamespace = 'auth'::regnamespace
      and proname in ('change_own_password', 'change_own_display_name', 'own_profile_version',
                      'staff_person_name_acceptable')));
select pg_temp.check_case('1 auth.accounts: the Identity runtime still reads it only',
  'select t insert f update f delete f',
  format('select %s insert %s update %s delete %s', has_table_privilege('hid_identity_runtime', 'auth.accounts', 'SELECT'),
    has_table_privilege('hid_identity_runtime', 'auth.accounts', 'INSERT'),
    has_any_column_privilege('hid_identity_runtime', 'auth.accounts', 'UPDATE'),
    has_table_privilege('hid_identity_runtime', 'auth.accounts', 'DELETE')));

-- 2. The runtimes cannot touch the new tables or run the name rule; even the owner cannot change a row.
set local role hid_identity_api_runtime;
select pg_temp.check_case('2 identity api: no read of the name changes', '42501',
  pg_temp.attempt('select count(*) from auth.staff_name_changes'));
select pg_temp.check_case('2 identity api: no read of the password changes', '42501',
  pg_temp.attempt('select count(*) from auth.password_change_requests'));
select pg_temp.check_case('2 identity api: no insert into the password changes', '42501',
  pg_temp.attempt($$insert into auth.password_change_requests (account_id, idempotency_key, change_id, session_id,
    other_sign_ins_ended, password_changed_at) values ('f2050000-0000-4000-8000-00000000000a', 'fictional-key-000001',
    gen_random_uuid(), gen_random_uuid(), 0, now())$$));
select pg_temp.check_case('2 identity api: the name rule is not its to run', '42501',
  pg_temp.attempt($$select auth.staff_person_name_acceptable('Ada Fictional')$$));
select pg_temp.check_case('2 identity api: no update of a display name directly', '42501',
  pg_temp.attempt($$update auth.accounts set display_name = 'Ada Direct' where id = 'f2050000-0000-4000-8000-00000000000a'$$));
reset role;
set local role hid_ehr_runtime;
select pg_temp.check_case('2 ehr runtime: no read, no call', '42501 42501 42501',
  pg_temp.attempt('select count(*) from auth.staff_name_changes') || ' '
  || pg_temp.attempt('select auth.own_profile_version()') || ' '
  || pg_temp.attempt($$select * from auth.change_own_display_name('Ada Fictional', 1, 'fictional-key-000002', null, null, null)$$));
reset role;
set local role hid_schema_test_runtime;
select pg_temp.check_case('2 schema test runtime: no read, no call', '42501 42501',
  pg_temp.attempt('select count(*) from auth.password_change_requests') || ' '
  || pg_temp.attempt($$select * from auth.change_own_password(null, null, null, null, 'fictional-key-000003', null, null, null, null, null, null)$$));
reset role;

-- 3. The name rule, as identity-api's acceptableStaffPersonName answers each (owner only).
select pg_temp.check_case('3 name rule: ' || candidate, expected::text, auth.staff_person_name_acceptable(candidate)::text)
  from (values ('Ada Fictional-Bello', true), ('Adé Ọlá', true), (E'Adé Bello', true),
               ('Chukwuemeka Ụzọ Nwankwo', true), ('Ngozi O''Neil', true), ('A B', true), ('José María', true),
               ('Аня Петрова', true), ('Ada Hidden', true), ('Ada Health Idris', true),
               ('One Two Three Four Five Six', true), ('Ade', false), ('A', false), ('Dr. Ada Bello', false),
               ('Ada  Bello', false), ('Ada Bello ', false), ('Ada Bello1', false), ('Ada--Bello', false),
               ('Ada ''Bello', false), ('One Two Three Four Five Six Seven', false), ('Ada Health ID', false),
               ('Ada HealthID', false), ('Support Bello', false), ('Ada Admin', false), ('Ada Administrator', false),
               ('Ada Ministry', false), ('Ada Hid', false), ('ada@example.invalid', false), ('Ada https://x', false),
               (repeat('a', 40) || ' ' || repeat('b', 39), true), (repeat('a', 40) || ' ' || repeat('b', 40), false),
               -- Combining marks outside the Latin blocks (Arabic harakat, Devanagari, Thai, Hebrew points, Tamil),
               -- an enclosing mark (Me) and a Mark of Unicode 16 (U+0897, Arabic pepet): \p{M} in JavaScript.
               ('مُحَمَّد علي', true), ('मोहन कुमार', true), ('สมชาย ใจดี', true), ('שָׁלוֹם כֹּהֵן', true),
               ('தமிழ் செல்வன்', true), (E'Ada\u20DD Bello', true), (E'Ada\u0897 Bello', true),
               ('Ada ٣ Bello', false), (E'Ada\u200D Bello', false),
               -- 80 characters as JavaScript counts them: U+10428 (Deseret) is two UTF-16 code units.
               (repeat(E'\U00010428', 20) || ' ' || repeat(E'\U00010428', 19), true),
               (repeat(E'\U00010428', 20) || ' ' || repeat(E'\U00010428', 20), false),
               (null, false)) cases(candidate, expected)
 where candidate is not null;
select pg_temp.check_case('3 name rule: null', 'false', auth.staff_person_name_acceptable(null)::text);

-- 4. The password change.
create temporary table s_before on commit drop as select pg_temp.s_state() as state;
grant select on pg_temp.s_before to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.as_account('synthetic:own-0205:s', 'own-0205-password-1');
select pg_temp.check_case('4 a bad key is refused first', '22023 IDEMPOTENCY_KEY_REQUIRED',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000a1', 'f2054000-0000-4000-8000-0000000000a1',
    (select password_hash from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'), pg_temp.new_hash('s1'),
    'short'));
select pg_temp.check_case('4 a hash other than the one Node verified: changed meanwhile', '40001 PASSWORD_CHANGED_MEANWHILE',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000a1', 'f2054000-0000-4000-8000-0000000000a1',
    '$argon2id$v=19$m=65536,t=3,p=1$b3RoZXI$b3RoZXItZmljdGlvbmFsLWhhc2g', pg_temp.new_hash('s1'),
    'own-0205-key-s-000001'));
select pg_temp.check_case('4 no expected hash: changed meanwhile', '40001 PASSWORD_CHANGED_MEANWHILE',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000a1', 'f2054000-0000-4000-8000-0000000000a1',
    null, pg_temp.new_hash('s1'), 'own-0205-key-s-000001'));
select pg_temp.check_case('4 ' || label || ': not the current session', '42501 OWN_SESSION_NOT_CURRENT',
  pg_temp.change_password(presented::uuid, jti::uuid,
    (select password_hash from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'), pg_temp.new_hash('s1'),
    'own-0205-key-s-000001'))
  from (values ('a signed-out session', 'f2053000-0000-4000-8000-0000000000d1', 'f2054000-0000-4000-8000-0000000000d1'),
               ('a rotated session', 'f2053000-0000-4000-8000-0000000000a0', 'f2054000-0000-4000-8000-0000000000a0'),
               ('an expired session', 'f2053000-0000-4000-8000-0000000000e1', 'f2054000-0000-4000-8000-0000000000e1'),
               ('a session at an older token version', 'f2053000-0000-4000-8000-0000000000f1',
                'f2054000-0000-4000-8000-0000000000f1'),
               ('another access token id', 'f2053000-0000-4000-8000-0000000000a1', 'f2054000-0000-4000-8000-0000000000b1'),
               ('a patient session of the account', 'f2053000-0000-4000-8000-0000000000c1',
                'f2054000-0000-4000-8000-0000000000c1'),
               ('another account''s session', 'f2053000-0000-4000-8000-000000000010',
                'f2054000-0000-4000-8000-000000000010'),
               -- W's live staff session, at the same token version as S (4) and with its own access token id: only
               -- the account check refuses it.
               ('another account''s session at the caller''s token version', 'f2053000-0000-4000-8000-000000000014',
                'f2054000-0000-4000-8000-000000000014')) presented_cases(label, presented, jti);
select pg_temp.check_case('4 a new hash outside the policy', '22023 PASSWORD_HASH_INVALID',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000a1', 'f2054000-0000-4000-8000-0000000000a1',
    (select password_hash from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'),
    '$argon2id$v=19$m=19456,t=2,p=1$' || repeat('x', 60), 'own-0205-key-s-000001'));
select pg_temp.check_case('4 a new hash in the policy''s shape but under 64 characters', '22023 PASSWORD_HASH_INVALID',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000a1', 'f2054000-0000-4000-8000-0000000000a1',
    (select password_hash from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('x', 32), 'own-0205-key-s-000001'));
select pg_temp.check_case('4 a renewal whose refresh token digest is not SHA-256 hex', '22023 OWN_SESSION_RENEWAL_INVALID',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000a1', 'f2054000-0000-4000-8000-0000000000a1',
    (select password_hash from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'), pg_temp.new_hash('s1'),
    'own-0205-key-s-000001', renewed_sha => 'not-a-digest'));
select pg_temp.check_case('4 a renewal ending now', '22023 OWN_SESSION_RENEWAL_INVALID',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000a1', 'f2054000-0000-4000-8000-0000000000a1',
    (select password_hash from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'), pg_temp.new_hash('s1'),
    'own-0205-key-s-000001', renewed_expires => now() - interval '1 second'));
reset role;
select pg_temp.check_case('4 the refusals changed nothing', (select state from pg_temp.s_before), pg_temp.s_state());

-- The change.
set local role hid_identity_api_runtime;
select pg_temp.check_case('4 the change: version 5, two other live sign-ins ended, the renewed session',
  'changed 5/2/f2055000-0000-4000-8000-0000000000a2/f',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000a1', 'f2054000-0000-4000-8000-0000000000a1',
    (select password_hash from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'), pg_temp.new_hash('s1'),
    'own-0205-key-s-000001'));
reset role;
select pg_temp.check_case('4 the account: new hash, argon2id, changed now, token version 5, row version + 1',
  'new-hash argon2id t 5 2',
  (select format('%s %s %s %s %s',
            case when password_hash = pg_temp.new_hash('s1') then 'new-hash' else 'other' end, password_algorithm,
            password_changed_at = updated_at and password_changed_at > now(), token_version, row_version)
     from auth.accounts where id = 'f2050000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 every other session: password_changed; the presented one rotated into the renewed one',
  'a0 rotated->a1|a1 rotated->a2|b1 password_changed|c1 password_changed|d1 logout|e1 password_changed|f1 password_changed|a2 live v5 password staff family a0',
  (select string_agg(right(session_row.id::text, 2) || ' ' ||
       case when session_row.revoked_at is null
            then format('live v%s %s %s family %s', session_row.account_token_version, session_row.authentication_method,
                        session_row.session_kind, right(session_row.family_id::text, 2))
            else session_row.revocation_reason
                 || coalesce('->' || right(session_row.replaced_by_session_id::text, 2), '') end,
       '|' order by session_row.id)
     from auth.sessions session_row where session_row.account_id = 'f2050000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 the renewed session: same absolute end as the sign-in, idle end within it, digest and token id as given, the source IP',
  't t t f2056000-0000-4000-8000-0000000000a2 t 203.0.113.7',
  (select format('%s %s %s %s %s %s', renewed.absolute_expires_at = presented.absolute_expires_at,
            renewed.expires_at <= renewed.absolute_expires_at and renewed.expires_at > renewed.issued_at,
            renewed.refresh_token_sha256 = repeat('ab', 32), renewed.access_jti,
            renewed.user_agent_sha256 = encode(sha256(convert_to('Fictional Browser/1.0', 'UTF8')), 'hex'),
            host(renewed.source_ip))
     from auth.sessions renewed, auth.sessions presented
    where renewed.id = 'f2055000-0000-4000-8000-0000000000a2' and presented.id = 'f2053000-0000-4000-8000-0000000000a1'));
select pg_temp.check_case('4 events: one revoked per sign-in touched (live ones marked), one rotated',
  'a1 rotated {"reason": "password_changed"}|b1 revoked {"live": true, "reason": "password_changed"}|c1 revoked {"live": true, "reason": "password_changed"}|e1 revoked {"live": false, "reason": "password_changed"}|f1 revoked {"live": false, "reason": "password_changed"}',
  (select string_agg(right(session_id::text, 2) || ' ' || event_type || ' ' || details::text, '|'
                     order by event_type desc, session_id)
     from auth.session_events where account_id = 'f2050000-0000-4000-8000-00000000000a'
      and correlation_id = 'own-0205-password-1'));
select pg_temp.check_case('4 one audit row: staff, session, no facility, the counts and change id only',
  'staff synthetic:own-0205:s auth.password.change success session f2055000-0000-4000-8000-0000000000a2 healthcare-operations - - 203.0.113.7 Fictional Browser/1.0 changeId,otherSignInsEnded 2 t',
  (select string_agg(format('%s %s %s %s %s %s %s %s %s %s %s %s %s %s', actor_type, actor_subject, action, outcome,
       resource_type, resource_id, purpose_of_use, coalesce(facility_id::text, '-'), coalesce(actor_membership_id::text, '-'),
       host(source_ip), user_agent, (select string_agg(key, ',' order by key) from jsonb_object_keys(details) key),
       details->>'otherSignInsEnded',
       (details->>'changeId')::uuid = (select change_id from auth.password_change_requests
                                        where account_id = 'f2050000-0000-4000-8000-00000000000a')), '|')
     from audit.events where correlation_id = 'own-0205-password-1'));
select pg_temp.check_case('4 one request row: the key, the renewed session, the count',
  'own-0205-key-s-000001 f2055000-0000-4000-8000-0000000000a2 2 t',
  (select string_agg(format('%s %s %s %s', idempotency_key, session_id, other_sign_ins_ended,
       password_changed_at = (select password_changed_at from auth.accounts where id = account_id)), '|')
     from auth.password_change_requests where account_id = 'f2050000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 no password material in the request row, the events or the audit row', '0',
  (select count(*)::text from (
     select to_jsonb(request_row)::text as stored from auth.password_change_requests request_row
     union all select details::text from auth.session_events where correlation_id = 'own-0205-password-1'
     union all select to_jsonb(audit_row)::text from audit.events audit_row where correlation_id = 'own-0205-password-1') stored
    where stored.stored like '%argon2id%' or stored.stored like '%' || md5('s1') || '%'
       or stored.stored like '%c3RvcmVkLWZpY3Rpb25hbC1oYXNoLW9mLW5vdGhpbmc%'));
create temporary table s_after on commit drop as select pg_temp.s_state() as state;
grant select on pg_temp.s_after to hid_identity_api_runtime;

-- A replay: the full call (from the renewed session, which is the only one left) and the read alone.
set local role hid_identity_api_runtime;
select pg_temp.as_account('synthetic:own-0205:s', 'own-0205-password-2');
select pg_temp.check_case('4 a replay of the key answers the stored row and changes nothing',
  'changed /2/f2055000-0000-4000-8000-0000000000a2/t',
  pg_temp.change_password('f2055000-0000-4000-8000-0000000000a2', 'f2056000-0000-4000-8000-0000000000a2',
    'whatever-the-replay-sends', pg_temp.new_hash('s2'), 'own-0205-key-s-000001',
    renewed_id => 'f2055000-0000-4000-8000-0000000000a3', renewed_jti => 'f2056000-0000-4000-8000-0000000000a3',
    renewed_sha => repeat('cd', 32)));
select pg_temp.check_case('4 the replay read alone (no new hash): the stored row',
  'changed /2/f2055000-0000-4000-8000-0000000000a2/t',
  pg_temp.change_password(null, null, null, null, 'own-0205-key-s-000001', null, null, null, null));
select pg_temp.check_case('4 the replay read of an unknown key: no row', 'no row',
  pg_temp.change_password(null, null, null, null, 'own-0205-key-s-000009', null, null, null, null));
reset role;
select pg_temp.check_case('4 replays changed nothing', (select state from pg_temp.s_after), pg_temp.s_state());
set local role hid_identity_api_runtime;
select pg_temp.check_case('4 a second change from the renewed session: no other sign-in is left to end',
  'changed 6/0/f2055000-0000-4000-8000-0000000000a3/f',
  pg_temp.change_password('f2055000-0000-4000-8000-0000000000a2', 'f2056000-0000-4000-8000-0000000000a2',
    pg_temp.new_hash('s1'), pg_temp.new_hash('s2'), 'own-0205-key-s-000002',
    renewed_id => 'f2055000-0000-4000-8000-0000000000a3', renewed_jti => 'f2056000-0000-4000-8000-0000000000a3',
    renewed_sha => repeat('cd', 32)));

-- Accounts that may not change.
select pg_temp.as_account('synthetic:own-0205:n', 'own-0205-password-3');
select pg_temp.check_case('4 no password (Google only)', '55000 PASSWORD_NOT_SET',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000b9', 'f2054000-0000-4000-8000-0000000000b9', null,
    pg_temp.new_hash('n1'), 'own-0205-key-n-000001'));
select pg_temp.as_account('synthetic:own-0205:q', 'own-0205-password-4');
select pg_temp.check_case('4 a sealed QA login', '42501 STAFF_PROFILE_CHANGE_NOT_ALLOWED',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000c9', 'f2054000-0000-4000-8000-0000000000c9',
    'qa-shared-hash', pg_temp.new_hash('q1'), 'own-0205-key-q-000001'));
select pg_temp.as_account('synthetic:own-0205:d', 'own-0205-password-5');
select pg_temp.check_case('4 a sealed demo login', '42501 STAFF_PROFILE_CHANGE_NOT_ALLOWED',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000d9', 'f2054000-0000-4000-8000-0000000000d9',
    'demo-shared-hash', pg_temp.new_hash('d1'), 'own-0205-key-d-000001'));
select pg_temp.as_account('synthetic:own-0205:x', 'own-0205-password-6');
select pg_temp.check_case('4 a disabled account', '42501 OWN_ACCOUNT_NOT_ACTIVE',
  pg_temp.change_password('f2053000-0000-4000-8000-0000000000e9', 'f2054000-0000-4000-8000-0000000000e9',
    'disabled-hash', pg_temp.new_hash('x1'), 'own-0205-key-x-000001'));
select pg_temp.as_account('synthetic:own-0205:z', 'own-0205-password-7');
select pg_temp.check_case('4 a deleted account', '42501 OWN_ACCOUNT_NOT_ACTIVE',
  pg_temp.change_password(null, null, null, pg_temp.new_hash('z1'), 'own-0205-key-z-000001'));
select pg_temp.as_account('', 'own-0205-password-8');
select pg_temp.check_case('4 no subject in the session', '42501 OWN_ACCOUNT_NOT_ACTIVE',
  pg_temp.change_password(null, null, null, pg_temp.new_hash('z1'), 'own-0205-key-z-000001'));
reset role;
select pg_temp.check_case('4 the refused accounts are unchanged', 'b:1 c:1 d:1 e:1',
  (select string_agg(right(id::text, 1) || ':' || token_version, ' ' order by id) from auth.accounts
    where id in ('f2050000-0000-4000-8000-00000000000b', 'f2050000-0000-4000-8000-00000000000c',
                 'f2050000-0000-4000-8000-00000000000d', 'f2050000-0000-4000-8000-00000000000e')));

-- The edges. C: a sign-in made through single sign-on whose absolute end (in 2 hours) comes before the 8-hour idle end
-- asked for.
set local role hid_identity_api_runtime;
select pg_temp.as_account('synthetic:own-0205:c', 'own-0205-password-9');
select pg_temp.check_case('4 a sign-in ending absolutely before the idle end asked for: changed (no other sign-in)',
  'changed 3/0/f2055000-0000-4000-8000-000000000011/f',
  pg_temp.change_password('f2053000-0000-4000-8000-000000000011', 'f2054000-0000-4000-8000-000000000011',
    '$argon2id$v=19$m=65536,t=3,p=1$Y2xhbXAtc2FsdA$Y2xhbXAtZmljdGlvbmFsLWhhc2gtb2Ytbm90aGluZw', pg_temp.new_hash('c1'),
    'own-0205-key-c-000001', renewed_id => 'f2055000-0000-4000-8000-000000000011',
    renewed_jti => 'f2056000-0000-4000-8000-000000000011', renewed_sha => repeat('c1', 32),
    renewed_expires => now() + interval '8 hours'));
-- L: a bcrypt_legacy password (the hash Node verified is the stored bcrypt one).
select pg_temp.as_account('synthetic:own-0205:l', 'own-0205-password-10');
select pg_temp.check_case('4 a bcrypt_legacy account: changed',
  'changed 2/0/f2055000-0000-4000-8000-000000000012/f',
  pg_temp.change_password('f2053000-0000-4000-8000-000000000012', 'f2054000-0000-4000-8000-000000000012',
    '$2b$12$ZmljdGlvbmFsLWxlZ2FjeS1zYWx0LWhhc2gtb2Ytbm90aGluZ3g', pg_temp.new_hash('l1'), 'own-0205-key-l-000001',
    renewed_id => 'f2055000-0000-4000-8000-000000000012', renewed_jti => 'f2056000-0000-4000-8000-000000000012',
    renewed_sha => repeat('e1', 32)));
-- W: the key S committed is W's to use: no replay for W, in the read or in the full call.
select pg_temp.as_account('synthetic:own-0205:w', 'own-0205-password-11');
select pg_temp.check_case('4 another account''s key, read alone: no row', 'no row',
  pg_temp.change_password(null, null, null, null, 'own-0205-key-s-000001', null, null, null, null));
select pg_temp.check_case('4 another account''s key, the full call: its own change, not a replay',
  'changed 5/0/f2055000-0000-4000-8000-000000000014/f',
  pg_temp.change_password('f2053000-0000-4000-8000-000000000014', 'f2054000-0000-4000-8000-000000000014',
    '$argon2id$v=19$m=65536,t=3,p=1$d2FsZS1zYWx0$d2FsZS1maWN0aW9uYWwtaGFzaC1vZi1ub3RoaW5n', pg_temp.new_hash('w1'),
    'own-0205-key-s-000001', renewed_id => 'f2055000-0000-4000-8000-000000000014',
    renewed_jti => 'f2056000-0000-4000-8000-000000000014', renewed_sha => repeat('f1', 32)));
reset role;
select pg_temp.check_case('4 the clamped renewal: single sign-on kept, its idle end the sign-in''s absolute end',
  'oidc t t',
  (select format('%s %s %s', renewed.authentication_method, renewed.expires_at = renewed.absolute_expires_at,
            renewed.absolute_expires_at = presented.absolute_expires_at)
     from auth.sessions renewed, auth.sessions presented
    where renewed.id = 'f2055000-0000-4000-8000-000000000011' and presented.id = 'f2053000-0000-4000-8000-000000000011'));
select pg_temp.check_case('4 the bcrypt_legacy account: argon2id now, with the new hash',
  'argon2id t 2', (select format('%s %s %s', password_algorithm, password_hash = pg_temp.new_hash('l1'), token_version)
                     from auth.accounts where id = 'f2050000-0000-4000-8000-000000000012'));
select pg_temp.check_case('4 one key, two accounts: a request row each, each its own renewed session',
  'f2050000-0000-4000-8000-00000000000a f2055000-0000-4000-8000-0000000000a2|f2050000-0000-4000-8000-000000000014 f2055000-0000-4000-8000-000000000014',
  (select string_agg(account_id || ' ' || session_id, '|' order by account_id) from auth.password_change_requests
    where idempotency_key = 'own-0205-key-s-000001'));
select pg_temp.check_case('4 S was not touched by W''s change', 'v6 requests:2',
  (select format('v%s requests:%s', token_version, (select count(*) from auth.password_change_requests request_row
                                                     where request_row.account_id = account_row.id))
     from auth.accounts account_row where account_row.id = 'f2050000-0000-4000-8000-00000000000a'));

-- 5. The name edit.
set local role hid_identity_api_runtime;
select pg_temp.as_account('synthetic:own-0205:e', 'own-0205-name-1');
select pg_temp.check_case('5 the profile version before any change', '1', auth.own_profile_version()::text);
select pg_temp.check_case('5 a bad key', '22023 IDEMPOTENCY_KEY_REQUIRED', pg_temp.change_name('Gbenga Bello', 1, 'short'));
select pg_temp.check_case('5 an invalid name', '22023 STAFF_NAME_INVALID',
  pg_temp.change_name('Dr. Gbenga', 1, 'own-0205-key-e-000001'));
select pg_temp.check_case('5 a reserved word', '22023 STAFF_NAME_INVALID',
  pg_temp.change_name('Gbenga Support', 1, 'own-0205-key-e-000001'));
select pg_temp.check_case('5 another version', '40001 VERSION_CONFLICT',
  pg_temp.change_name('Gbenga Bello', 2, 'own-0205-key-e-000001'));
select pg_temp.check_case('5 the current name', '22023 STAFF_NAME_UNCHANGED',
  pg_temp.change_name('  Gbenga Fictional ', 1, 'own-0205-key-e-000001'));
select pg_temp.check_case('5 a session that is not the account''s', '42501 OWN_SESSION_NOT_CURRENT',
  pg_temp.change_name('Gbenga Bello', 1, 'own-0205-key-e-000001', 'f2053000-0000-4000-8000-0000000000b9'));
select pg_temp.check_case('5 ' || label || ': not the current session', '42501 OWN_SESSION_NOT_CURRENT',
  pg_temp.change_name('Gbenga Bello', 1, 'own-0205-key-e-000001', presented::uuid))
  from (values ('a signed-out session', 'f2053000-0000-4000-8000-0000000010d0'),
               ('an expired session', 'f2053000-0000-4000-8000-0000000010e0'),
               ('a session at an older token version', 'f2053000-0000-4000-8000-0000000010f0'),
               ('a patient session of the account', 'f2053000-0000-4000-8000-0000000010c0')) presented_cases(label, presented);
select pg_temp.check_case('5 the change (trimmed): version 2', '2/Gbenga Bello/f',
  pg_temp.change_name(' Gbenga Bello ', 1, 'own-0205-key-e-000001'));
select pg_temp.check_case('5 the profile version after it', '2', auth.own_profile_version()::text);
select pg_temp.check_case('5 a replay with the same name: the current state', '2/Gbenga Bello/t',
  pg_temp.change_name('Gbenga Bello', 1, 'own-0205-key-e-000001'));
select pg_temp.check_case('5 the same key with another name', '23505 IDEMPOTENCY_KEY_REUSED',
  pg_temp.change_name('Gbenga Okafor', 2, 'own-0205-key-e-000001'));
select pg_temp.as_account('synthetic:own-0205:e', 'own-0205-name-2');
select pg_temp.check_case('5 a second change', '3/Gbenga Okafor/f',
  pg_temp.change_name('Gbenga Okafor', 2, 'own-0205-key-e-000002'));
select pg_temp.as_account('synthetic:own-0205:e', 'own-0205-name-3');
select pg_temp.check_case('5 a third change', '4/Gbenga Ọlá Okafor/f',
  pg_temp.change_name('Gbenga Ọlá Okafor', 3, 'own-0205-key-e-000003'));
select pg_temp.as_account('synthetic:own-0205:e', 'own-0205-name-4');
select pg_temp.check_case('5 a fourth within 24 hours', '55000 STAFF_NAME_CHANGE_LIMITED',
  pg_temp.change_name('Gbenga Adé Okafor', 4, 'own-0205-key-e-000004'));
select pg_temp.as_account('synthetic:own-0205:q', 'own-0205-name-5');
select pg_temp.check_case('5 a sealed QA login', '42501 STAFF_PROFILE_CHANGE_NOT_ALLOWED',
  pg_temp.change_name('Chidi Bello', 1, 'own-0205-key-q-000002', 'f2053000-0000-4000-8000-0000000000c9'));
select pg_temp.as_account('synthetic:own-0205:d', 'own-0205-name-6');
select pg_temp.check_case('5 a sealed demo login', '42501 STAFF_PROFILE_CHANGE_NOT_ALLOWED',
  pg_temp.change_name('Dayo Bello', 1, 'own-0205-key-d-000002', 'f2053000-0000-4000-8000-0000000000d9'));
select pg_temp.as_account('synthetic:own-0205:x', 'own-0205-name-7');
select pg_temp.check_case('5 a disabled account', '42501 OWN_ACCOUNT_NOT_ACTIVE',
  pg_temp.change_name('Efe Bello', 1, 'own-0205-key-x-000002', 'f2053000-0000-4000-8000-0000000000e9'));
select pg_temp.check_case('5 no version for a disabled account', '(null)', auth.own_profile_version()::text);
-- R: its versions, keys and limit are its own. Its history (written above): version 2 thirty hours ago, 3 twenty-four
-- hours and a minute ago, 4 twenty-three hours and fifty minutes ago.
select pg_temp.as_account('synthetic:own-0205:r', 'own-0205-name-8');
select pg_temp.check_case('5 a second account: its own profile version', '4', auth.own_profile_version()::text);
select pg_temp.check_case('5 a second account: E''s versions are not its own', '40001 VERSION_CONFLICT',
  pg_temp.change_name('Remi Bello', 2, 'own-0205-key-r-000001', 'f2053000-0000-4000-8000-000000000013'));
select pg_temp.check_case('5 a second account: E''s key is its own to use, and E''s limit is not its own',
  '5/Remi Bello/f', pg_temp.change_name('Remi Bello', 4, 'own-0205-key-e-000001', 'f2053000-0000-4000-8000-000000000013'));
select pg_temp.as_account('synthetic:own-0205:r', 'own-0205-name-9');
select pg_temp.check_case('5 the change 24 hours and a minute ago is outside the window (2 inside it before this one)',
  '6/Remi Okafor/f', pg_temp.change_name('Remi Okafor', 5, 'own-0205-key-r-000002', 'f2053000-0000-4000-8000-000000000013'));
select pg_temp.as_account('synthetic:own-0205:r', 'own-0205-name-10');
select pg_temp.check_case('5 the change 23 hours and 50 minutes ago is inside it: a fourth is refused',
  '55000 STAFF_NAME_CHANGE_LIMITED',
  pg_temp.change_name('Remi Adé Okafor', 6, 'own-0205-key-r-000003', 'f2053000-0000-4000-8000-000000000013'));
select pg_temp.check_case('5 a second account: its profile version after', '6', auth.own_profile_version()::text);
select pg_temp.as_account('synthetic:own-0205:e', 'own-0205-name-11');
select pg_temp.check_case('5 the first account''s profile version is still its own', '4', auth.own_profile_version()::text);
reset role;
select pg_temp.check_case('5 the second account''s rows: its history and its two changes, E''s key among them',
  '2 own-0205-key-r-history2|3 own-0205-key-r-history3|4 own-0205-key-r-history4|5 own-0205-key-e-000001|6 own-0205-key-r-000002',
  (select string_agg(profile_version || ' ' || idempotency_key, '|' order by profile_version)
     from auth.staff_name_changes where account_id = 'f2050000-0000-4000-8000-000000000013'));
select pg_temp.check_case('5 updated_at is the last change''s time; the source IP on the audit rows',
  't 203.0.113.8',
  (select format('%s %s', account_row.updated_at = (select max(change_row.changed_at) from auth.staff_name_changes change_row
                                                     where change_row.account_id = account_row.id),
            (select string_agg(distinct host(audit_row.source_ip), ',') from audit.events audit_row
              where audit_row.actor_account_id = account_row.id and audit_row.action = 'auth.staff-profile.update'))
     from auth.accounts account_row where account_row.id = 'f2050000-0000-4000-8000-000000000010'));
select pg_temp.check_case('5 display_name changed; the registered staff name never',
  'Gbenga Ọlá Okafor|Gbenga Registered Fictional|2',
  (select format('%s|%s|%s', account_row.display_name, staff_row.full_name, account_row.token_version)
     from auth.accounts account_row join identity.staff staff_row on staff_row.account_id = account_row.id
    where account_row.id = 'f2050000-0000-4000-8000-000000000010'));
select pg_temp.check_case('5 the name changes: versions 2-4, their keys',
  '2 own-0205-key-e-000001|3 own-0205-key-e-000002|4 own-0205-key-e-000003',
  (select string_agg(profile_version || ' ' || idempotency_key, '|' order by profile_version)
     from auth.staff_name_changes where account_id = 'f2050000-0000-4000-8000-000000000010'));
select pg_temp.check_case('5 one audit row per change: staff, session, no facility, previous and new name, version',
  'auth.staff-profile.update success session f2053000-0000-4000-8000-000000000010 - Gbenga Fictional>Gbenga Bello v2|auth.staff-profile.update success session f2053000-0000-4000-8000-000000000010 - Gbenga Bello>Gbenga Okafor v3|auth.staff-profile.update success session f2053000-0000-4000-8000-000000000010 - Gbenga Okafor>Gbenga Ọlá Okafor v4',
  (select string_agg(format('%s %s %s %s %s %s>%s v%s', action, outcome, resource_type, resource_id,
       coalesce(facility_id::text, '-'), details->>'previousName', details->>'newName', details->>'profileVersion'),
       '|' order by sequence_id)
     from audit.events where actor_account_id = 'f2050000-0000-4000-8000-000000000010'));
select pg_temp.check_case('5 the refused accounts kept their names', 'Chidi Fictional|Dayo Fictional|Efe Fictional',
  (select string_agg(display_name, '|' order by id) from auth.accounts
    where id in ('f2050000-0000-4000-8000-00000000000c', 'f2050000-0000-4000-8000-00000000000d',
                 'f2050000-0000-4000-8000-00000000000e')));
-- Even the owner cannot change or empty a history row.
select pg_temp.check_case('5 history rows are append only, even for the owner', '55000 55000 55000 55000',
  pg_temp.attempt($$update auth.staff_name_changes set changed_at = now() where account_id = 'f2050000-0000-4000-8000-000000000010'$$)
  || ' ' || pg_temp.attempt($$delete from auth.password_change_requests where account_id = 'f2050000-0000-4000-8000-00000000000a'$$)
  || ' ' || pg_temp.attempt('truncate auth.staff_name_changes')
  || ' ' || pg_temp.attempt('truncate auth.password_change_requests'));

-- 6. Identity's own statements, verbatim (staff-profile-changes.ts; staff-profile-changes-sql.spec.ts holds each to
-- its text, in this order). Each helper runs one statement with EXECUTE ... USING, so its $n are the API's
-- parameters; all run as the Identity API runtime with the account-only context.
create function pg_temp.id_startup() returns text language plpgsql as $f$
declare
  found_row record;
begin
  execute $sql$select
       has_function_privilege(to_regprocedure('auth.change_own_password(uuid,uuid,text,text,text,uuid,uuid,text,timestamp with time zone,inet,text)')::oid, 'EXECUTE') as can_change_password,
       has_function_privilege(to_regprocedure('auth.change_own_display_name(text,bigint,text,uuid,inet,text)')::oid, 'EXECUTE') as can_change_name,
       has_function_privilege(to_regprocedure('auth.own_profile_version()')::oid, 'EXECUTE') as can_read_version$sql$
    into found_row;
  return format('%s %s %s', found_row.can_change_password, found_row.can_change_name, found_row.can_read_version);
end
$f$;
create function pg_temp.id_account(account uuid, subject text) returns text language plpgsql as $f$
declare
  found_row record;
  rows_read bigint;
begin
  execute $sql$select account.email, account.display_name, account.password_hash,
       account.password_algorithm
  from auth.accounts account
 where account.id = $1::uuid
   and account.subject = $2
   and account.status = 'active'
   and (account.disabled_until is null or account.disabled_until <= clock_timestamp())$sql$
    into found_row using account, subject;
  get diagnostics rows_read = row_count;
  if rows_read = 0 then return 'none'; end if;
  return format('%s|%s|%s|%s', found_row.email, found_row.display_name, found_row.password_algorithm,
    found_row.password_hash = '$argon2id$v=19$m=65536,t=3,p=1$dmVyYS1zYWx0$dmVyYS1maWN0aW9uYWwtaGFzaC1vZi1ub3RoaW5n');
end
$f$;
create function pg_temp.id_change(session_id uuid, access_jti uuid, expected_hash text, new_hash text,
  idempotency_key text, renewed_id uuid, renewed_jti uuid, renewed_sha text, renewed_expires timestamptz,
  source_ip inet, user_agent text) returns text language plpgsql as $f$
declare
  found_row record;
begin
  execute $sql$select result.change_id::text, result.token_version::text,
       result.password_changed_at, result.other_sign_ins_ended, result.session_id::text,
       result.session_expires_at, result.replayed
  from auth.change_own_password($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9::timestamptz,
                                $10::inet, $11) result$sql$
    into found_row using session_id, access_jti, expected_hash, new_hash, idempotency_key, renewed_id, renewed_jti,
      renewed_sha, renewed_expires, source_ip, user_agent;
  return format('%s/%s/%s/%s/%s/%s', found_row.token_version, found_row.other_sign_ins_ended, found_row.session_id,
    found_row.session_expires_at = renewed_expires, found_row.replayed, found_row.change_id::uuid is not null);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.id_replay(idempotency_key text) returns text language plpgsql as $f$
declare
  found_row record;
  rows_read bigint;
begin
  execute $sql$select result.change_id::text, result.token_version::text,
       result.password_changed_at, result.other_sign_ins_ended, result.session_id::text,
       result.session_expires_at, result.replayed
  from auth.change_own_password(null, null, null, null, $1, null, null, null, null, null, null) result$sql$
    into found_row using idempotency_key;
  get diagnostics rows_read = row_count;
  if rows_read = 0 then return 'none'; end if;
  return format('%s/%s/%s/%s/%s', coalesce(found_row.token_version, '-'), found_row.other_sign_ins_ended,
    found_row.session_id, coalesce(found_row.session_expires_at::text, '-'), found_row.replayed);
end
$f$;
create function pg_temp.id_clear(principal_hmac text, pepper_version integer) returns text language plpgsql as $f$
declare
  cleared bigint;
begin
  execute $sql$delete from auth.login_attempts where principal_hmac = $1 and pepper_version = $2$sql$
    using principal_hmac, pepper_version;
  get diagnostics cleared = row_count;
  return cleared::text;
end
$f$;
create function pg_temp.id_name(requested_name text, expected_version bigint, idempotency_key text, session_id uuid,
  source_ip inet, user_agent text) returns text language plpgsql as $f$
declare
  found_row record;
begin
  execute $sql$select result.profile_version::text, result.display_name, result.replayed
  from auth.change_own_display_name($1, $2::bigint, $3, $4::uuid, $5::inet, $6) result$sql$
    into found_row using requested_name, expected_version, idempotency_key, session_id, source_ip, user_agent;
  return format('%s/%s/%s', found_row.profile_version, found_row.display_name, found_row.replayed);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.id_version() returns text language plpgsql as $f$
declare
  version text;
begin
  execute $sql$select auth.own_profile_version()::text as profile_version$sql$ into version;
  return coalesce(version, '(null)');
end
$f$;
set local role hid_identity_api_runtime;
select pg_temp.as_account('synthetic:own-0205:v', 'own-0205-identity-1');
select pg_temp.check_case('6 the start-up check''s read: the Identity runtime may execute all three', 't t t',
  pg_temp.id_startup());
select pg_temp.check_case('6 the account read: email, name, algorithm and the stored hash', 'v@own-0205.invalid|Vera Fictional|argon2id|t',
  pg_temp.id_account('f2050000-0000-4000-8000-000000000015', 'synthetic:own-0205:v'));
select pg_temp.check_case('6 the account read: not for another subject, a disabled or a deleted account', 'none none none',
  pg_temp.id_account('f2050000-0000-4000-8000-000000000015', 'synthetic:own-0205:s') || ' '
  || pg_temp.id_account('f2050000-0000-4000-8000-00000000000e', 'synthetic:own-0205:x') || ' '
  || pg_temp.id_account('f2050000-0000-4000-8000-00000000000f', 'synthetic:own-0205:z'));
select pg_temp.check_case('6 the replay read before the change: no row', 'none', pg_temp.id_replay('own-0205-key-v-000001'));
select pg_temp.check_case('6 the change: version 2, nothing else to end, the renewed session and its idle end',
  '2/0/f2055000-0000-4000-8000-000000000015/t/f/t',
  pg_temp.id_change('f2053000-0000-4000-8000-000000000015', 'f2054000-0000-4000-8000-000000000015',
    '$argon2id$v=19$m=65536,t=3,p=1$dmVyYS1zYWx0$dmVyYS1maWN0aW9uYWwtaGFzaC1vZi1ub3RoaW5n', pg_temp.new_hash('v1'),
    'own-0205-key-v-000001', 'f2055000-0000-4000-8000-000000000015', 'f2056000-0000-4000-8000-000000000015',
    repeat('d1', 32), date_trunc('second', now()) + interval '8 hours', '203.0.113.10', 'Fictional Browser/4.0'));
select pg_temp.check_case('6 the replay read after it: the stored row, no token version or idle end',
  '-/0/f2055000-0000-4000-8000-000000000015/-/t', pg_temp.id_replay('own-0205-key-v-000001'));
select pg_temp.check_case('6 the lockout cleared, once', '1 0',
  pg_temp.id_clear(repeat('f205', 16), 1) || ' ' || pg_temp.id_clear(repeat('f205', 16), 1));
select pg_temp.check_case('6 the name edit from the renewed session', '2/Vera Bello/f',
  pg_temp.id_name('Vera Bello', 1, 'own-0205-key-v-000002', 'f2055000-0000-4000-8000-000000000015', '203.0.113.10',
    'Fictional Browser/4.0'));
select pg_temp.check_case('6 the profile version', '2', pg_temp.id_version());
reset role;
select pg_temp.check_case('6 the lockout row is gone', '0',
  (select count(*)::text from auth.login_attempts where principal_hmac = repeat('f205', 16)));

-- 7. The row locks and the checks made under them (dblink). Account K and its two live staff sessions (k1, presented;
-- k2, another sign-in) are committed through a second session (own_k1), which also plays the other transaction;
-- each call runs in a third session (own_k2) as the Identity API runtime, in a transaction that rolls back.
\if :own_dblink_available
select format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port')) as own_k_connection \gset
select public.dblink_connect('own_k1', :'own_k_connection') as connected \gset
select public.dblink_connect('own_k2', :'own_k_connection') as connected \gset
select pid as own_k2_pid from public.dblink('own_k2', 'select pg_backend_pid()') as backend(pid integer) \gset
select public.dblink_exec('own_k1', $k$
  delete from auth.sessions where account_id = 'f205c000-0000-4000-8000-000000000001';
  delete from auth.accounts where id = 'f205c000-0000-4000-8000-000000000001';
  insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm, token_version)
  values ('f205c000-0000-4000-8000-000000000001', 'synthetic:own-0205:k', 'k@own-0205.invalid', 'Kay Fictional',
          'active', '$argon2id$v=19$m=65536,t=3,p=1$a2F5LXNhbHQ$a2F5LWZpY3Rpb25hbC1oYXNoLW9mLW5vdGhpbmc', 'argon2id', 1);
  insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
      authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
  select session_id::uuid, 'f205c000-0000-4000-8000-000000000001', session_id::uuid,
         md5(session_id) || md5(session_id || 'refresh'), jti::uuid, 1, 'password', now(), now() + interval '8 hours',
         now() + interval '24 hours', 'staff'
    from (values ('f205c300-0000-4000-8000-000000000001', 'f205c400-0000-4000-8000-000000000001'),
                 ('f205c300-0000-4000-8000-000000000002', 'f205c400-0000-4000-8000-000000000002')) fixture(session_id, jti)
$k$) as fixtures \gset
select public.dblink_exec('own_k2', $k$
create function pg_temp.k_password(renewed uuid) returns text language plpgsql as $f$
declare
  answer text;
begin
  select format('changed %s/%s/%s', result.token_version, result.other_sign_ins_ended, result.replayed) into answer
    from auth.change_own_password('f205c300-0000-4000-8000-000000000001', 'f205c400-0000-4000-8000-000000000001',
           '$argon2id$v=19$m=65536,t=3,p=1$a2F5LXNhbHQ$a2F5LWZpY3Rpb25hbC1oYXNoLW9mLW5vdGhpbmc',
           '$argon2id$v=19$m=65536,t=3,p=1$a2F5LW5ldy1zYWx0$' || repeat('k', 43), 'own-0205-key-k-000001', renewed,
           gen_random_uuid(), encode(sha256(convert_to(renewed::text, 'UTF8')), 'hex'), now() + interval '8 hours',
           '203.0.113.9', 'Fictional Browser/3.0') result;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.k_name() returns text language plpgsql as $f$
declare
  answer text;
begin
  select format('%s/%s/%s', result.profile_version, result.display_name, result.replayed) into answer
    from auth.change_own_display_name('Kay Bello', 1, 'own-0205-key-k-000002', 'f205c300-0000-4000-8000-000000000001',
           '203.0.113.9', 'Fictional Browser/3.0') result;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
$k$) as helpers \gset
-- own_k2: a transaction as the Identity API runtime for K, with a lock timeout; then rolled back.
create function pg_temp.k_begin(timeout text) returns void language sql as $f$
  select public.dblink_exec('own_k2', 'begin');
  select public.dblink_exec('own_k2', 'set local role hid_identity_api_runtime');
  select public.dblink_exec('own_k2', format($q$do $d$ begin
    perform set_config('app.actor_subject', 'synthetic:own-0205:k', true),
      set_config('app.correlation_id', 'own-0205-locks', true), set_config('app.facility_id', '', true),
      set_config('app.membership_id', '', true), set_config('app.purpose_of_use', 'healthcare-operations', true),
      set_config('lock_timeout', %L, true);
  end $d$$q$, timeout));
$f$;
create function pg_temp.k_call(statement text) returns text language sql as $f$
  select answer from public.dblink('own_k2', statement) as result(answer text);
$f$;
create function pg_temp.k_end() returns void language sql as $f$
  select public.dblink_exec('own_k2', 'rollback');
$f$;
-- Whether own_k2 is waiting for a lock another session holds (up to 5 seconds).
create function pg_temp.k_waiting(pid integer) returns boolean language plpgsql as $f$
begin
  for attempt in 1..200 loop
    if cardinality(pg_blocking_pids(pid)) > 0 then return true; end if;
    perform pg_sleep(0.025);
  end loop;
  return false;
end
$f$;
-- The answer of the call own_k2 was sent (dblink_send_query), once it is in.
create function pg_temp.k_result() returns text language plpgsql as $f$
declare
  answer text;
begin
  select result.answer into answer from public.dblink_get_result('own_k2') as result(answer text);
  perform 1 from public.dblink_get_result('own_k2') as result(answer text);
  return answer;
end
$f$;
create function pg_temp.k_state() returns text language sql as $f$
  select format('v%s %s %s', token_version, status, display_name) from auth.accounts
   where id = 'f205c000-0000-4000-8000-000000000001';
$f$;

-- K1: another transaction holds the account row FOR NO KEY UPDATE: both functions wait for it.
select public.dblink_exec('own_k1', 'begin') as began \gset
select public.dblink_exec('own_k1', $q$do $d$ begin
  perform 1 from auth.accounts where id = 'f205c000-0000-4000-8000-000000000001' for no key update;
end $d$$q$) as held \gset
select pg_temp.k_begin('500ms');
select pg_temp.check_case('7 K1 the password change waits for the account row', '55P03 canceling statement due to lock timeout',
  pg_temp.k_call($q$select pg_temp.k_password('f205c500-0000-4000-8000-000000000001')$q$));
select pg_temp.k_end();
select pg_temp.k_begin('500ms');
select pg_temp.check_case('7 K1 the name edit waits for the account row', '55P03 canceling statement due to lock timeout',
  pg_temp.k_call('select pg_temp.k_name()'));
select pg_temp.k_end();
select public.dblink_exec('own_k1', 'rollback') as ended \gset
-- K1: a refresh in flight inserting a session for the account (FOR KEY SHARE on its row) holds neither up.
select public.dblink_exec('own_k1', 'begin') as began \gset
select public.dblink_exec('own_k1', $q$insert into auth.sessions (id, account_id, family_id, refresh_token_sha256,
    access_jti, account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
  values ('f205c300-0000-4000-8000-000000000003', 'f205c000-0000-4000-8000-000000000001',
          'f205c300-0000-4000-8000-000000000002', repeat('9c', 32), 'f205c400-0000-4000-8000-000000000003', 1,
          'password', now(), now() + interval '8 hours', now() + interval '24 hours', 'staff')$q$) as inserted \gset
select pg_temp.k_begin('500ms');
select pg_temp.check_case('7 K1 a session insert in flight does not hold the password change up (it ends k2)',
  'changed 2/1/f', pg_temp.k_call($q$select pg_temp.k_password('f205c500-0000-4000-8000-000000000002')$q$));
select pg_temp.k_end();
select pg_temp.k_begin('500ms');
select pg_temp.check_case('7 K1 nor the name edit', '2/Kay Bello/f', pg_temp.k_call('select pg_temp.k_name()'));
select pg_temp.k_end();
select public.dblink_exec('own_k1', 'rollback') as ended \gset
-- K2: another transaction holding K's other sign-in FOR KEY SHARE (as writing a session event for it does): the
-- password change locks the account's unrevoked sessions FOR UPDATE before it changes any, so it waits (revoking the
-- session alone would not: that update does not conflict with FOR KEY SHARE).
select public.dblink_exec('own_k1', 'begin') as began \gset
select public.dblink_exec('own_k1', $q$do $d$ begin
  perform 1 from auth.sessions where id = 'f205c300-0000-4000-8000-000000000002' for key share;
end $d$$q$) as held \gset
select pg_temp.k_begin('500ms');
select pg_temp.check_case('7 K2 the password change waits for the account''s other sessions',
  '55P03 canceling statement due to lock timeout',
  pg_temp.k_call($q$select pg_temp.k_password('f205c500-0000-4000-8000-000000000003')$q$));
select pg_temp.k_end();
select public.dblink_exec('own_k1', 'rollback') as ended \gset
-- K3: the account is locked (status 'locked', or disabled_until a day ahead) by a transaction that commits while
-- the call waits for the row: auth.account_id_for_subject had found the account active, and the function refuses on
-- what it reads under the lock. The account is made active again after each.
create function pg_temp.k_race(change text, call text, pid integer) returns text language plpgsql as $f$
declare
  waited boolean;
  answer text;
begin
  perform public.dblink_exec('own_k1', 'begin');
  perform public.dblink_exec('own_k1', change);
  perform pg_temp.k_begin('5s');
  perform public.dblink_send_query('own_k2', call);
  waited := pg_temp.k_waiting(pid);
  perform public.dblink_exec('own_k1', 'commit');
  answer := pg_temp.k_result();
  perform pg_temp.k_end();
  perform public.dblink_exec('own_k1', $q$update auth.accounts set status = 'active', disabled_until = null
                                           where id = 'f205c000-0000-4000-8000-000000000001'$q$);
  return answer || case when waited then ' (after waiting)' else ' (without waiting)' end;
end
$f$;
select pg_temp.check_case('7 K3 ' || label || ': ' || call_name, '42501 OWN_ACCOUNT_NOT_ACTIVE (after waiting)',
  pg_temp.k_race(change, call, :own_k2_pid))
  from (values
    (1, 'status locked', $q$update auth.accounts set status = 'locked' where id = 'f205c000-0000-4000-8000-000000000001'$q$),
    (2, 'disabled for a day', $q$update auth.accounts set disabled_until = now() + interval '1 day'
                                  where id = 'f205c000-0000-4000-8000-000000000001'$q$)) changes(change_order, label, change),
       (values (1, 'password change', $q$select pg_temp.k_password('f205c500-0000-4000-8000-000000000004')$q$),
               (2, 'name edit', 'select pg_temp.k_name()')) calls(call_order, call_name, call)
 order by change_order, call_order;
select pg_temp.check_case('7 K kept nothing of the calls (each rolled back)', 'v1 active Kay Fictional 2 0',
  pg_temp.k_state() || ' ' || (select answer from public.dblink('own_k1', $q$select format('%s %s',
    (select count(*) from auth.sessions where account_id = 'f205c000-0000-4000-8000-000000000001'),
    (select count(*) from audit.events where actor_account_id = 'f205c000-0000-4000-8000-000000000001'))$q$)
      as result(answer text)));
select public.dblink_exec('own_k1', $k$
  delete from auth.sessions where account_id = 'f205c000-0000-4000-8000-000000000001';
  delete from auth.accounts where id = 'f205c000-0000-4000-8000-000000000001';
$k$) as removed \gset
select public.dblink_disconnect('own_k1') as disconnected \gset
select public.dblink_disconnect('own_k2') as disconnected \gset
\else
\echo '0205 own password and name: dblink is not available on this server, so 7 (the row locks) is skipped'
\endif

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.own_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0205 own password and name:\n%', mismatch;
  end if;
  raise notice '0205 own password and name: % cases passed', (select count(*) from pg_temp.own_outcomes);
end $$;

rollback;

\if :own_dblink_available
\if :own_dblink_create
drop extension dblink;
\endif
\endif
