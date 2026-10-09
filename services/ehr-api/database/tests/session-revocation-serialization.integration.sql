\set ON_ERROR_STOP on
-- Session revocation serialization (0073). Every family or account session
-- revocation that keeps the account's token version takes the account row lock
-- before its UPDATE, so it waits for a refresh rotation in flight and then
-- revokes the session that rotation created. This suite checks the catalog
-- contract a later CREATE OR REPLACE must keep; the two-connection race itself
-- runs in scripts/verify-platform-security-runtime.mjs. Rollback-only.
begin;

do $$
declare
  lock_function constant regprocedure := 'auth.lock_account_sessions(uuid)'::regprocedure;
  command regprocedure;
  definition text;
  lock_at integer;
  update_at integer;
begin
  if not exists (
    select 1 from pg_proc function_row
    where function_row.oid = lock_function and function_row.prosecdef
      and function_row.provolatile = 'v'
      and function_row.proconfig @> array['search_path=auth, pg_temp']
  ) then
    raise exception 'auth.lock_account_sessions must be a volatile security-definer function with a fixed search_path';
  end if;
  -- A null ACL means the default PUBLIC execute grant.
  if (select function_row.proacl from pg_proc function_row where function_row.oid = lock_function) is null
     or exists (
       select 1 from pg_proc function_row, aclexplode(function_row.proacl) privilege
       where function_row.oid = lock_function and privilege.grantee = 0
     ) then
    raise exception 'PUBLIC can execute auth.lock_account_sessions';
  end if;
  if position('for update' in lower(pg_get_functiondef(lock_function))) = 0 then
    raise exception 'auth.lock_account_sessions must take FOR UPDATE on the account row';
  end if;

  foreach command in array array[
    'auth.admin_revoke_account_sessions(uuid,text,text,character)'::regprocedure,
    'auth.admin_revoke_session_family(uuid,uuid,boolean,text,text,character)'::regprocedure
  ] loop
    definition := lower(pg_get_functiondef(command));
    lock_at := position('perform auth.lock_account_sessions(requested_account_id)' in definition);
    update_at := position('update auth.sessions' in definition);
    if lock_at = 0 or update_at = 0 or lock_at > update_at then
      raise exception '% must lock the account before revoking its sessions', command;
    end if;
    if (select function_row.proowner from pg_proc function_row where function_row.oid = command)
       <> (select function_row.proowner from pg_proc function_row where function_row.oid = lock_function) then
      raise exception '% and auth.lock_account_sessions must have the same owner', command;
    end if;
  end loop;
end $$;

-- Locking an account that does not exist is a no-op, not an error.
select auth.lock_account_sessions('00000000-0000-4000-8000-0000000000a1');

rollback;
