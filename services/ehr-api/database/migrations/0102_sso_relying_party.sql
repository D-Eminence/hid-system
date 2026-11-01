-- Single sign-on on auth.: the product side (ADR-070, proposed; the provider
-- side is the coordinator's). Each product host (ehr, lab, pharmacy, migrate,
-- outreach, and the patient portal web) becomes an OpenID Connect relying
-- party of the provider on auth. and, after a sign-in there, issues its own
-- host-only session exactly as its own sign-in does today. Nothing here is
-- used until the Identity API is configured for it (AUTH_SSO_ISSUER).
--
-- 1. auth.session_single_sign_on: where a sign-in (session family) came from
--    when a product issued it after single sign-on: the client (site key),
--    the provider's session id (sid), which back-channel logout names, the ID
--    token, kept server-side for id_token_hint at sign-out and never sent to
--    the browser otherwise, and when the person signed in at the provider
--    (auth_time), from which the sign-in's absolute end and a patient's
--    recent-sign-in check count. Keyed by family, as auth.session_assurance
--    (0069) and auth.session_facility_selection (0089) are: refresh rotates
--    the session row but keeps the family. One row per family, written with
--    the family's first session in the same transaction, never changed.
-- 2. auth.sso_spent_tokens: the single-use record of a product's sign-in
--    transactions (by a digest of their state) and of the provider's logout
--    tokens (by a digest of issuer and jti), each kept until it could no
--    longer be accepted anyway, then removed.
--
-- Applied migrations 0001 through 0101 are immutable. This migration only adds
-- two tables, an index, a guard and its trigger: no existing row, function,
-- policy or grant changes. The role bootstrap (runtime-grants.sql) grants the
-- Identity runtime what it uses.

create table auth.session_single_sign_on (
  family_id uuid primary key references auth.sessions(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  -- The product site keys of contract v2. Platform administration is never a
  -- client (ADR-038).
  client_id text not null check (client_id in ('ehr', 'lab', 'pharmacy', 'migrate', 'outreach', 'web')),
  provider_sid text not null check (provider_sid ~ '^[!-~]{1,255}$'),
  id_token text not null check (length(id_token) between 16 and 16384),
  authenticated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index session_single_sign_on_provider_sid_idx on auth.session_single_sign_on (provider_sid);
comment on table auth.session_single_sign_on is
  'Single sign-on provenance of a staff or patient sign-in (session family) a product issued after the provider on auth. (ADR-070): client, provider sid, ID token for id_token_hint, provider auth_time. Never an authorization.';

-- Admits a row only for the root session of a staff or patient sign-in of the
-- same account whose kind is the client's (a staff product never holds a
-- patient sign-in and the patient portal never a staff one), and refuses any
-- change or delete. Sign-out and revocation leave the row in place, as they
-- leave auth.session_assurance.
create function auth.guard_session_single_sign_on_change()
returns trigger
language plpgsql
set search_path = auth, pg_temp
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'SESSION_SINGLE_SIGN_ON_IMMUTABLE';
  end if;
  if not exists (
    select 1 from auth.sessions session_row
     where session_row.id = new.family_id and session_row.family_id = new.family_id
       and session_row.account_id = new.account_id
       and session_row.session_kind = case when new.client_id = 'web' then 'patient' else 'staff' end
  ) then
    raise exception using errcode = '23514', message = 'SESSION_SINGLE_SIGN_ON_INVALID';
  end if;
  return new;
end
$$;
revoke all on function auth.guard_session_single_sign_on_change() from public;
create trigger session_single_sign_on_guard
  before insert or update or delete on auth.session_single_sign_on
  for each row execute function auth.guard_session_single_sign_on_change();

create table auth.sso_spent_tokens (
  purpose text not null check (purpose in ('transaction', 'logout_token')),
  token_sha256 char(64) not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  spent_at timestamptz not null default clock_timestamp(),
  primary key (purpose, token_sha256)
);
create index sso_spent_tokens_expires_idx on auth.sso_spent_tokens (expires_at);
comment on table auth.sso_spent_tokens is
  'Single-use record of single sign-on transactions and back-channel logout tokens (ADR-070), by digest only, kept until each could no longer be accepted.';
