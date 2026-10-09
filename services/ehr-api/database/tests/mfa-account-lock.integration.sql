\set ON_ERROR_STOP on
-- The account row lock of platform MFA transactions (0076). It must take
-- FOR NO KEY UPDATE on the account row: that conflicts with the FOR UPDATE of
-- an approved MFA reset (0070) and of session revocations (0073), and with
-- itself, so MFA transactions of one account run one at a time, but not with
-- the FOR KEY SHARE that refresh rotations and staff sign-ins of the account
-- take. FOR UPDATE would also make MFA transactions wait for those; FOR KEY
-- SHARE would let MFA transactions of one account run together; SKIP LOCKED
-- or a condition would sometimes take no lock, and NOWAIT would fail the MFA
-- request instead of waiting (55P03). This suite pins the catalog contract
-- and the exact body that a later CREATE OR REPLACE must keep; the
-- two-connection races run in
-- services/identity-api/scripts/verify-platform-security-runtime.mjs.
-- Rollback-only.
begin;

do $$
declare
  lock_function constant regprocedure := 'auth.lock_account_for_mfa(uuid)'::regprocedure;
  body text;
begin
  if not exists (
    select 1 from pg_proc function_row
    join pg_language language_row on language_row.oid = function_row.prolang
    where function_row.oid = lock_function and function_row.prosecdef
      and function_row.provolatile = 'v'
      and function_row.prorettype = 'void'::regtype
      and language_row.lanname = 'plpgsql'
      and function_row.proconfig = array['search_path=auth, pg_temp']
  ) then
    raise exception 'auth.lock_account_for_mfa must be a volatile plpgsql security-definer function returning void with a fixed search_path';
  end if;
  -- A null ACL means the default PUBLIC execute grant.
  if (select function_row.proacl from pg_proc function_row where function_row.oid = lock_function) is null
     or exists (
       select 1 from pg_proc function_row, aclexplode(function_row.proacl) privilege
       where function_row.oid = lock_function and privilege.grantee = 0
     ) then
    raise exception 'PUBLIC can execute auth.lock_account_for_mfa';
  end if;
  -- The exact body, whitespace and case aside.
  select btrim(regexp_replace(lower(function_row.prosrc), '\s+', ' ', 'g')) into body
    from pg_proc function_row where function_row.oid = lock_function;
  if body is distinct from
     'begin perform 1 from auth.accounts account_row where account_row.id = target_account for no key update; end' then
    raise exception 'auth.lock_account_for_mfa must only take FOR NO KEY UPDATE on the account row, unconditionally: %', body;
  end if;
  if (select function_row.proowner from pg_proc function_row where function_row.oid = lock_function)
     <> (select function_row.proowner from pg_proc function_row
          where function_row.oid = 'auth.lock_account_sessions(uuid)'::regprocedure) then
    raise exception 'auth.lock_account_for_mfa and auth.lock_account_sessions must have the same owner';
  end if;
end $$;

-- Locking an account that does not exist is a no-op, not an error.
select auth.lock_account_for_mfa('00000000-0000-4000-8000-0000000000a2');

rollback;
