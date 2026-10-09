\set ON_ERROR_STOP on
-- The account row lock of platform MFA transactions (0076). It must take
-- FOR KEY SHARE, the weakest lock that conflicts with the FOR UPDATE of an
-- approved MFA reset (0070) and of session revocations (0073): FOR UPDATE would
-- also make MFA transactions wait for refresh rotations and staff sign-ins of
-- the account. This suite checks the catalog contract a later CREATE OR REPLACE
-- must keep; the two-connection races run in
-- services/identity-api/scripts/verify-platform-security-runtime.mjs.
-- Rollback-only.
begin;

do $$
declare
  lock_function constant regprocedure := 'auth.lock_account_for_mfa(uuid)'::regprocedure;
  definition text := regexp_replace(lower(pg_get_functiondef('auth.lock_account_for_mfa(uuid)'::regprocedure)),
    '\s+', ' ', 'g');
begin
  if not exists (
    select 1 from pg_proc function_row
    where function_row.oid = lock_function and function_row.prosecdef
      and function_row.provolatile = 'v'
      and function_row.proconfig = array['search_path=auth, pg_temp']
  ) then
    raise exception 'auth.lock_account_for_mfa must be a volatile security-definer function with a fixed search_path';
  end if;
  -- A null ACL means the default PUBLIC execute grant.
  if (select function_row.proacl from pg_proc function_row where function_row.oid = lock_function) is null
     or exists (
       select 1 from pg_proc function_row, aclexplode(function_row.proacl) privilege
       where function_row.oid = lock_function and privilege.grantee = 0
     ) then
    raise exception 'PUBLIC can execute auth.lock_account_for_mfa';
  end if;
  if position('from auth.accounts account_row where account_row.id = target_account for key share' in definition) = 0
     or definition ~ 'for (no key )?update|for share' then
    raise exception 'auth.lock_account_for_mfa must take FOR KEY SHARE on the account row, and no stronger lock';
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
