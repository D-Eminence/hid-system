-- Permit seamless bcrypt continuity without granting the runtime role direct
-- UPDATE access to the canonical account table.

create or replace function auth.upgrade_legacy_password(
  requested_account_id uuid,
  requested_subject text,
  expected_row_version bigint,
  new_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = auth, platform, pg_temp
as $$
declare
  affected_rows integer;
begin
  if platform.current_actor_subject() <> 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Verified authentication context is required';
  end if;
  if requested_account_id is null
     or nullif(btrim(requested_subject), '') is null
     or expected_row_version < 1 then
    raise exception using errcode = '22023', message = 'Invalid password upgrade target';
  end if;
  if length(coalesce(new_password_hash, '')) not between 64 and 512
     or new_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$' then
    raise exception using errcode = '22023', message = 'Invalid Argon2id password hash policy';
  end if;

  update auth.accounts
     set password_hash = new_password_hash,
         password_algorithm = 'argon2id',
         password_changed_at = clock_timestamp(),
         row_version = row_version + 1,
         updated_at = clock_timestamp()
   where id = requested_account_id
     and subject = requested_subject
     and row_version = expected_row_version
     and status = 'active'
     and password_algorithm = 'bcrypt_legacy';

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

revoke all on function auth.upgrade_legacy_password(uuid, text, bigint, text) from public;

comment on function auth.upgrade_legacy_password(uuid, text, bigint, text) is
  'Concurrency-safe one-way bcrypt_legacy to policy Argon2id upgrade. Callable only through the authentication system context.';
