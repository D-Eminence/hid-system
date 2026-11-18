-- 0127: single sign-on on auth., the product side (hid-system#142, written on
-- main as 0102, ADR-070). Ported onto production as 0125 and renumbered 0127
-- after hid-system#254's 0124, #255's 0125 and #259's 0126 (booked on
-- hid-system#258). This file requires 0001-0126 applied.
--
-- Each product host (ehr., lab., pharmacy., migrate.,
-- outreach., and the patients' site for the patient portal) becomes an OpenID
-- Connect relying party of the provider on auth. and, after a sign-in there,
-- issues its own host-only session exactly as its own sign-in does today: a
-- staff session through the same product gate as a password sign-in on that
-- site (Q88, owner decision Q92 B: staff sign in with a password only, as
-- today). Nothing here is used until the Identity API is configured for it
-- (AUTH_SSO_ISSUER).
--
-- 1. auth.session_single_sign_on: where a sign-in (session family) came from
--    when a product issued it after single sign-on: the client (site key),
--    the provider's session id (sid), which back-channel logout names, and
--    when the person signed in at the provider (auth_time), from which the
--    sign-in's absolute end and a patient's recent-sign-in check count. The
--    ID token is not kept: product sign-out sends no id_token_hint, since the
--    browser would carry it. Keyed by family (auth.sessions.family_id, the id
--    of the family's first session): refresh rotates the session row but
--    keeps the family. One row per family, written with the family's first
--    session in the same transaction, never changed.
-- 2. auth.sso_spent_tokens: the single-use record of a product's sign-in
--    transactions (by a digest of their state) and of the provider's logout
--    tokens (by a digest of issuer and jti), each kept until it could no
--    longer be accepted anyway, then removed.
--
-- Differences from main's 0102: the number; this header; a precondition that
-- 0001-0126 are applied and this file is not; and the comments no longer name
-- main's auth.session_assurance (0069) or auth.session_facility_selection
-- (0089), which production does not have. The tables, index, guard, trigger
-- and checks are 0102's, unchanged.
--
-- Applied migrations 0001 through 0126 are immutable. This migration only adds
-- two tables, two indexes, a guard and its trigger, and grants the Identity
-- runtime what it uses of them: no existing row, function, policy or grant
-- changes. It reads nothing 0124, 0125 or 0126 adds or changes. Production
-- releases apply migrations only and never re-run runtime-grants.sql, so the
-- grants are made here, for each runtime role that exists, and also in
-- runtime-grants.sql (the role bootstrap of a new installation), which grants
-- exactly the same.
-- Locks: SHARE ROW EXCLUSIVE on auth.sessions and auth.accounts for the two
-- foreign keys, until commit (behind another lock the runner stops after its
-- 5 s lock_timeout with nothing applied).

-- 0. Preconditions.
do $$
begin
  if to_regclass('auth.session_single_sign_on') is not null
     or to_regclass('auth.sso_spent_tokens') is not null
     or to_regprocedure('auth.guard_session_single_sign_on_change()') is not null then
    raise exception using errcode = '55000', message = '0127: already applied';
  end if;
  if to_regclass('auth.sessions') is null
     or to_regclass('auth.accounts') is null
     or not exists (select 1 from pg_attribute attribute
                     where attribute.attrelid = 'auth.sessions'::regclass
                       and attribute.attname = 'session_kind' and not attribute.attisdropped)
     -- 0123 (the sealed QA tenant), 0124 (patient details on own work), 0125 (prescription dispensing details)
     -- and 0126 (organisation staff kinds, the last migration this file follows).
     or to_regclass('identity.sealed_qa_members') is null
     or to_regprocedure('lab.work_item_patient_cards(uuid[])') is null
     or to_regprocedure('pharmacy.work_item_prescription_details(uuid[])') is null
     or to_regprocedure('identity.organization_staff_kinds(uuid)') is null then
    raise exception using errcode = '55000', message = '0127: 0001-0126 must be applied first';
  end if;
end
$$;

create table auth.session_single_sign_on (
  family_id uuid primary key references auth.sessions(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  -- The product site keys of contract v2. Platform administration is never a
  -- client (ADR-038).
  client_id text not null check (client_id in ('ehr', 'lab', 'pharmacy', 'migrate', 'outreach', 'web')),
  provider_sid text not null check (provider_sid ~ '^[!-~]{1,255}$'),
  authenticated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index session_single_sign_on_provider_sid_idx on auth.session_single_sign_on (provider_sid);
comment on table auth.session_single_sign_on is
  'Single sign-on provenance of a staff or patient sign-in (session family) a product issued after the provider on auth. (ADR-070): client, provider sid, provider auth_time. Never an authorization.';

-- Admits a row only for the root session of a staff or patient sign-in of the
-- same account whose kind is the client's (a staff product never holds a
-- patient sign-in and the patient portal never a staff one), and refuses any
-- change or delete. Sign-out and revocation leave the row in place.
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

-- Grants (here and in runtime-grants.sql): the Identity runtime reads and
-- inserts the provenance (never UPDATE or DELETE: the guard refuses both) and
-- reads, inserts and deletes spent tokens. No other runtime role gets anything.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant select, insert on auth.session_single_sign_on to hid_identity_runtime;
    grant select, insert, delete on auth.sso_spent_tokens to hid_identity_runtime;
  end if;
end
$$;
revoke all on auth.session_single_sign_on, auth.sso_spent_tokens from public;

-- Post-check: the only runtime privileges on the two tables are the Identity runtime's.
do $$
begin
  if exists (
    select 1
      from pg_class table_row, aclexplode(coalesce(table_row.relacl, acldefault('r', table_row.relowner))) privilege
      join pg_roles grantee on grantee.oid = privilege.grantee
     where table_row.oid in ('auth.session_single_sign_on'::regclass, 'auth.sso_spent_tokens'::regclass)
       and grantee.oid <> table_row.relowner
       and not (grantee.rolname = 'hid_identity_runtime'
                and (privilege.privilege_type in ('SELECT', 'INSERT')
                     or (privilege.privilege_type = 'DELETE' and table_row.oid = 'auth.sso_spent_tokens'::regclass)))
  ) then
    raise exception using errcode = '55000', message = '0127: a role holds a privilege on a single sign-on table it must not';
  end if;
end
$$;
