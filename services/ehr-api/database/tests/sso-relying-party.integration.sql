\set ON_ERROR_STOP on
-- Single sign-on on auth., the product side (0102, ADR-070). A product that
-- issues its own sign-in after the provider on auth. records where it came
-- from in auth.session_single_sign_on (client, provider sid, the provider's
-- auth_time; never the ID token), one row per sign-in family, only for the root
-- session of a staff or patient sign-in of the client's kind, never changed.
-- Spent sign-in transactions and logout tokens are kept in
-- auth.sso_spent_tokens by digest. This suite also runs, as the Identity
-- runtime, the statements the API sends: the back-channel logout revocation
-- by sid and the patient recent-sign-in check. Rollback-only; synthetic data.
begin;

insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm) values
  ('d1020000-0000-4000-8000-00000000000a', 'synthetic:sso:staff-a', 'a@sso.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('d1020000-0000-4000-8000-00000000000b', 'synthetic:sso:staff-b', 'b@sso.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('d1020000-0000-4000-8000-0000000000e0', 'synthetic:sso:patient-p', 'p@sso.invalid', 'active', 'synthetic-hash', 'argon2id');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('d1030000-0000-4000-8000-0000000000e0', 'd1020000-0000-4000-8000-0000000000e0', 'HID-SSNPPPPP', 'Pat', 'Sso',
   'Pat Sso', 'active');

-- Sign-ins: SA1 and SA2 are staff sign-ins of A (SA2 since rotated into SA3,
-- which is not its family's root), SB1 a staff sign-in of B, PP1 and PP2
-- patient sign-ins of P (PP2 from 30 minutes ago at the provider).
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, revoked_at, revocation_reason,
    session_kind, patient_id)
select session_id::uuid, account_id::uuid, family_id::uuid, md5(session_id) || md5(session_id || 'refresh'),
  gen_random_uuid(), 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours', revoked_at,
  case when revoked_at is not null then 'rotated' end, kind, patient_id::uuid
from (values
  ('d1040000-0000-4000-8000-0000000000a1', 'd1020000-0000-4000-8000-00000000000a', 'd1040000-0000-4000-8000-0000000000a1', null::timestamptz, 'staff', null),
  ('d1040000-0000-4000-8000-0000000000a2', 'd1020000-0000-4000-8000-00000000000a', 'd1040000-0000-4000-8000-0000000000a2', now(), 'staff', null),
  ('d1040000-0000-4000-8000-0000000000a3', 'd1020000-0000-4000-8000-00000000000a', 'd1040000-0000-4000-8000-0000000000a2', null, 'staff', null),
  ('d1040000-0000-4000-8000-0000000000b1', 'd1020000-0000-4000-8000-00000000000b', 'd1040000-0000-4000-8000-0000000000b1', null, 'staff', null),
  ('d1040000-0000-4000-8000-0000000000e1', 'd1020000-0000-4000-8000-0000000000e0', 'd1040000-0000-4000-8000-0000000000e1', null, 'patient', 'd1030000-0000-4000-8000-0000000000e0'),
  ('d1040000-0000-4000-8000-0000000000e2', 'd1020000-0000-4000-8000-0000000000e0', 'd1040000-0000-4000-8000-0000000000e2', null, 'patient', 'd1030000-0000-4000-8000-0000000000e0')
) as fixture(session_id, account_id, family_id, revoked_at, kind, patient_id);

-- 1. Catalog contract: keys, the guard (an invoker function with a fixed
-- search_path and no PUBLIC execute, before every row insert, update and
-- delete), and the spent-token table's key.
do $$
declare
  guard constant regprocedure := 'auth.guard_session_single_sign_on_change()'::regprocedure;
begin
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'auth.session_single_sign_on'::regclass and constraint_row.contype = 'p')
     <> 'PRIMARY KEY (family_id)' then
    raise exception 'auth.session_single_sign_on must be keyed by the sign-in family';
  end if;
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'auth.sso_spent_tokens'::regclass and constraint_row.contype = 'p')
     <> 'PRIMARY KEY (purpose, token_sha256)' then
    raise exception 'auth.sso_spent_tokens must be keyed by purpose and digest';
  end if;
  if not exists (
    select 1 from pg_proc function_row
     where function_row.oid = guard and not function_row.prosecdef
       and function_row.proconfig @> array['search_path=auth, pg_temp']
  ) then
    raise exception 'the single sign-on guard must be an invoker function with a fixed search_path';
  end if;
  if exists (select 1 from pg_proc function_row, aclexplode(function_row.proacl) privilege
              where function_row.oid = guard and privilege.grantee = 0)
     or (select function_row.proacl from pg_proc function_row where function_row.oid = guard) is null then
    raise exception 'PUBLIC can execute the single sign-on guard';
  end if;
  if not exists (
    select 1 from pg_trigger trigger_row
     where trigger_row.tgrelid = 'auth.session_single_sign_on'::regclass and trigger_row.tgfoid = guard
       and not trigger_row.tgisinternal and trigger_row.tgenabled = 'O' and trigger_row.tgtype = 31
  ) then
    raise exception 'the single sign-on guard must fire before every row insert, update and delete';
  end if;
end $$;

-- 2. Runtime privileges: the Identity runtime reads and inserts the
-- provenance and never changes or deletes it; it reads, inserts and deletes
-- spent tokens; no other runtime has any access.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['hid_identity_runtime', 'hid_identity_api_runtime'] loop
    if not has_table_privilege(role_name, 'auth.session_single_sign_on', 'SELECT')
       or not has_table_privilege(role_name, 'auth.session_single_sign_on', 'INSERT')
       or has_table_privilege(role_name, 'auth.session_single_sign_on', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception '% must hold exactly SELECT and INSERT on auth.session_single_sign_on', role_name;
    end if;
    if not has_table_privilege(role_name, 'auth.sso_spent_tokens', 'SELECT')
       or not has_table_privilege(role_name, 'auth.sso_spent_tokens', 'INSERT')
       or not has_table_privilege(role_name, 'auth.sso_spent_tokens', 'DELETE')
       or has_table_privilege(role_name, 'auth.sso_spent_tokens', 'UPDATE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception '% must hold exactly SELECT, INSERT and DELETE on auth.sso_spent_tokens', role_name;
    end if;
  end loop;
  for role_name in
    select rolname from pg_roles where rolname like 'hid\_%' and rolname not in
      ('hid_identity_runtime', 'hid_identity_api_runtime')
      and pg_has_role(rolname, (select relowner from pg_class where oid = 'auth.sessions'::regclass), 'USAGE') is false
  loop
    if has_table_privilege(role_name, 'auth.session_single_sign_on', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege(role_name, 'auth.sso_spent_tokens', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception '% has a privilege on a single sign-on table', role_name;
    end if;
  end loop;
end $$;

-- 3. As the Identity API runtime.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
       set_config('app.correlation_id', 'sso-relying-party-suite-0001', true);

do $$
declare
  rejected record;
begin
  -- The API's insert (TokenService.recordSingleSignOn), for each kind.
  insert into auth.session_single_sign_on (family_id, account_id, client_id, provider_sid, authenticated_at)
  values ('d1040000-0000-4000-8000-0000000000a1', 'd1020000-0000-4000-8000-00000000000a', 'lab', 'provider-session-1',
          now() - interval '1 minute'),
         ('d1040000-0000-4000-8000-0000000000a2', 'd1020000-0000-4000-8000-00000000000a', 'ehr', 'provider-session-1',
          now() - interval '1 minute'),
         ('d1040000-0000-4000-8000-0000000000b1', 'd1020000-0000-4000-8000-00000000000b', 'lab', 'provider-session-2',
          now() - interval '1 minute'),
         ('d1040000-0000-4000-8000-0000000000e2', 'd1020000-0000-4000-8000-0000000000e0', 'web', 'provider-session-3',
          now() - interval '30 minutes');

  for rejected in select * from (values
    ('a staff product on a patient sign-in', 'd1040000-0000-4000-8000-0000000000e1', 'd1020000-0000-4000-8000-0000000000e0', 'ehr'),
    ('the patient portal on a staff sign-in', 'd1040000-0000-4000-8000-0000000000b1', 'd1020000-0000-4000-8000-00000000000b', 'web'),
    ('another account''s sign-in', 'd1040000-0000-4000-8000-0000000000b1', 'd1020000-0000-4000-8000-00000000000a', 'lab'),
    ('a session that is not its family''s root', 'd1040000-0000-4000-8000-0000000000a3', 'd1020000-0000-4000-8000-00000000000a', 'lab')
  ) as candidate(label, family_id, account_id, client_id) loop
    begin
      insert into auth.session_single_sign_on (family_id, account_id, client_id, provider_sid, authenticated_at)
      values (rejected.family_id::uuid, rejected.account_id::uuid, rejected.client_id, 'provider-session-9', now());
      raise exception 'the guard accepted %', rejected.label;
    exception when check_violation or unique_violation then
      if sqlerrm <> 'SESSION_SINGLE_SIGN_ON_INVALID' and sqlstate <> '23505' then raise; end if;
    end;
  end loop;
  begin
    insert into auth.session_single_sign_on (family_id, account_id, client_id, provider_sid, authenticated_at)
    values ('d1040000-0000-4000-8000-0000000000e1', 'd1020000-0000-4000-8000-0000000000e0', 'admin', 'provider-session-9',
            now());
    raise exception 'administration was accepted as a single sign-on client';
  exception when check_violation then
    -- Refused by the guard or by the client_id check, whichever runs first.
    null;
  end;
  begin
    update auth.session_single_sign_on set provider_sid = 'moved' where family_id = 'd1040000-0000-4000-8000-0000000000a1';
    raise exception 'a single sign-on row was changed';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The back-channel logout revocation by sid (SsoService.backchannelLogout),
-- as the runtime: every sign-in of provider session 1 ends, whichever product
-- it opened, the rotated session of A2 included; B's and P's do not.
select auth.lock_account_sessions('d1020000-0000-4000-8000-00000000000a');
do $$
declare
  ended text[];
begin
  with revoked as (
    update auth.sessions session
       set revoked_at = clock_timestamp(), revocation_reason = 'sso_logout', row_version = session.row_version + 1
      from auth.session_single_sign_on single_sign_on
     where single_sign_on.family_id = session.family_id
       and single_sign_on.provider_sid = 'provider-session-1'
       and (null::uuid is null or single_sign_on.account_id = null::uuid)
       and session.revoked_at is null
    returning session.id::text
  ) select array_agg(id order by id) into ended from revoked;
  if ended is distinct from array['d1040000-0000-4000-8000-0000000000a1', 'd1040000-0000-4000-8000-0000000000a3'] then
    raise exception 'back-channel logout by sid ended %', ended;
  end if;
  if exists (select 1 from auth.sessions where id in ('d1040000-0000-4000-8000-0000000000b1',
       'd1040000-0000-4000-8000-0000000000e1', 'd1040000-0000-4000-8000-0000000000e2') and revoked_at is not null) then
    raise exception 'back-channel logout ended a sign-in of another provider session';
  end if;
end $$;

-- Spent tokens: once only, by digest; expired rows removed.
do $$
declare
  inserted integer;
begin
  delete from auth.sso_spent_tokens where expires_at < clock_timestamp();
  insert into auth.sso_spent_tokens (purpose, token_sha256, expires_at)
  values ('logout_token', repeat('a', 64), now() + interval '5 minutes') on conflict (purpose, token_sha256) do nothing;
  get diagnostics inserted = row_count;
  if inserted <> 1 then raise exception 'a fresh logout token was not recorded'; end if;
  insert into auth.sso_spent_tokens (purpose, token_sha256, expires_at)
  values ('logout_token', repeat('a', 64), now() + interval '5 minutes') on conflict (purpose, token_sha256) do nothing;
  get diagnostics inserted = row_count;
  if inserted <> 0 then raise exception 'a logout token was spent twice'; end if;
  begin
    insert into auth.sso_spent_tokens (purpose, token_sha256, expires_at) values ('access', repeat('b', 64), now());
    raise exception 'an unknown purpose was accepted';
  exception when check_violation then null;
  end;
end $$;

-- The patient recent-sign-in check (requireRecentPatientAuthentication): a
-- sign-in issued now is recent, but one a product issued now after a sign-in
-- at the provider 30 minutes ago is not.
do $$
declare
  recent boolean;
begin
  foreach recent in array array[true, false] loop
    if (select coalesce(least(min(family.issued_at), max(single_sign_on.authenticated_at))
              >= clock_timestamp() - interval '10 minutes', false)
          from auth.sessions current_session
          join auth.sessions family on family.family_id = current_session.family_id
          left join auth.session_single_sign_on single_sign_on on single_sign_on.family_id = current_session.family_id
         where current_session.id = case when recent then 'd1040000-0000-4000-8000-0000000000e1'::uuid
                                         else 'd1040000-0000-4000-8000-0000000000e2'::uuid end
           and current_session.account_id = 'd1020000-0000-4000-8000-0000000000e0'
           and current_session.patient_id = 'd1030000-0000-4000-8000-0000000000e0'
           and current_session.session_kind = 'patient'
           and current_session.revoked_at is null) is distinct from recent then
      raise exception 'the recent-sign-in check answered % for a sign-in that should be %', not recent, recent;
    end if;
  end loop;
end $$;

reset role;
do $$
begin
  delete from auth.session_single_sign_on where family_id = 'd1040000-0000-4000-8000-0000000000a1';
  raise exception 'a single sign-on row was deleted';
exception when object_not_in_prerequisite_state then
  if sqlerrm <> 'SESSION_SINGLE_SIGN_ON_IMMUTABLE' then raise; end if;
end $$;

rollback;
