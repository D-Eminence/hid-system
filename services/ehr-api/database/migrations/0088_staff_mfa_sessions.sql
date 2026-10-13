-- Staff sign-in is MFA-verified (launch blocker MFA-1, decision D14). Applied
-- migrations 0001 through 0087 are immutable.
--
-- A staff session that can reach patient data is issued only after the
-- password and then a TOTP code or a one-time recovery code, as a platform
-- session is (0069). The factor, its recovery codes, the second-factor
-- challenge and the session assurance are the 0069 tables; the account has one
-- factor whichever kind of session it signs in to.
--
-- 1. auth.mfa_login_challenges gains session_kind ('platform' or 'staff'), so
--    a challenge is accepted only by the sign-in of its kind. Existing rows and
--    rows written by the Identity build of 0069 to 0087, which issues platform
--    challenges only, take the default 'platform'.
-- 2. A staff enrolment challenge carries its fresh proof: an email code sent
--    to the account's address (proof_method 'email_code'; only its keyed
--    digest is stored) or the provider activation that created the challenge
--    in the same request ('provider_activation'). The proof columns are empty
--    on every other challenge. The guard trigger refuses to consume a staff
--    enrolment challenge that records no verified proof, to change the kind,
--    or to change a proof once it is verified. The database records that the
--    proof was verified; it cannot check the emailed code, whose key only the
--    Identity service holds.
-- 3. auth.mfa_factors gains enrollment_proof and enrollment_challenge_id: the
--    staff proof the factor was enrolled with, and the staff enrolment
--    challenge that carried it. A new trigger accepts them only on a row that
--    names a live (unconsumed, not invalidated, unexpired) staff enrolment
--    challenge of the same account whose proof of that method is verified,
--    and never lets them change. A factor created by platform sign-in records
--    no proof.
-- 4. auth.guard_session_assurance_change (0069) accepts an assurance row for a
--    staff session family as well as a platform one, but a staff one only on
--    a factor that records a staff proof (STAFF_MFA_FACTOR_UNPROVEN
--    otherwise); a patient session still never has one. So a factor enrolled
--    by platform sign-in on the password alone never verifies a staff
--    session, whichever account holds it. Replaced with CREATE OR REPLACE,
--    which keeps its owner, ACL and trigger; language, search_path and every
--    other check are restated exactly as in 0069.
-- 5. The governed MFA reset (0070) already accepts any account that has an
--    active or pending factor, staff included: auth.admin_request_approval and
--    auth.admin_decide_approval check no account kind. Only the description of
--    platform.mfa.reset changes; the staff-mfa suite pins a staff reset end to
--    end. auth.complete_recovery_otp (0086) is unchanged: it revokes sessions
--    and external sign-ins and leaves auth.mfa_factors and the recovery codes
--    as they are, so recovering a password never removes the second factor;
--    the suite pins that too.
--
-- No session, account or factor row changes; only the platform.mfa.reset
-- description is rewritten. Existing staff sessions have no assurance row:
-- from the deploy of the Identity build of this change, Identity refuses each
-- of them (403 STAFF_MFA_REQUIRED on every authorized route, the delegated
-- EHR, Lab, Pharmacy, OCR and Outreach checks included) and ends it on its
-- next refresh. Every staff member signs in again, and enrols on that first
-- sign-in. Every existing factor was enrolled by platform sign-in and records
-- no staff proof: it keeps verifying platform sign-in, and an administrator
-- whose account also holds an eligible staff membership is refused staff
-- sign-in (403 STAFF_MFA_FACTOR_UNPROVEN) until a governed MFA reset, after
-- which they enrol at staff sign-in (MIGRATION_RUNBOOK.md lists them).
--
-- Locks: ACCESS EXCLUSIVE on auth.mfa_login_challenges and then on
-- auth.mfa_factors while their columns, checks and (on auth.mfa_factors) the
-- new trigger are added, each held until commit; the Identity runtime locks
-- a challenge before a factor too. The columns need no rewrite; the checks
-- scan the tables, whose rows are kept (the challenges and factors of
-- platform sign-in, the only writer before this change). Every other
-- statement changes functions, comments or one
-- permission row. Nothing else is granted: the Identity runtime's table grants
-- on auth.mfa_login_challenges, auth.mfa_factors and auth.session_assurance
-- (runtime-grants.sql) cover the new columns, and the new trigger function is
-- revoked from PUBLIC.

alter table auth.mfa_login_challenges
  add column session_kind text not null default 'platform',
  add column proof_method text,
  add column proof_verifier_hmac char(64),
  add column proof_key_version text,
  add column proof_sent_at timestamptz,
  add column proof_verified_at timestamptz;

alter table auth.mfa_login_challenges
  add constraint mfa_login_challenges_session_kind_check check (session_kind in ('platform', 'staff')),
  add constraint mfa_login_challenges_proof_check check (
    (proof_method is null and proof_verifier_hmac is null and proof_key_version is null
      and proof_sent_at is null and proof_verified_at is null)
    or (session_kind = 'staff' and purpose = 'enroll' and proof_method = 'email_code'
      and proof_verifier_hmac ~ '^[0-9a-f]{64}$'
      and proof_key_version is not null and length(proof_key_version) between 1 and 64
      and proof_sent_at is not null
      and (proof_verified_at is null or proof_verified_at >= proof_sent_at))
    or (session_kind = 'staff' and purpose = 'enroll' and proof_method = 'provider_activation'
      and proof_verifier_hmac is null and proof_key_version is null and proof_sent_at is null
      and proof_verified_at is not null)
  );

comment on column auth.mfa_login_challenges.session_kind is
  'The sign-in this challenge belongs to: platform administration or staff (0088). Accepted only by that sign-in.';
comment on column auth.mfa_login_challenges.proof_method is
  'Fresh proof of a staff enrolment challenge (0088): email_code (a code sent to the account address) or provider_activation. Null on every other challenge.';
comment on column auth.mfa_login_challenges.proof_verifier_hmac is
  'Keyed digest of the email code of a staff enrolment challenge; the code itself is never stored.';

create or replace function auth.guard_mfa_login_challenge_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.consumed_at is not null or old.invalidated_at is not null then
    raise exception using errcode = '55000', message = 'MFA_CHALLENGE_IMMUTABLE';
  end if;
  if new.id <> old.id or new.account_id <> old.account_id or new.purpose <> old.purpose
     or new.token_sha256 <> old.token_sha256 or new.account_token_version <> old.account_token_version
     or new.created_at <> old.created_at or new.expires_at <> old.expires_at
     or new.max_attempts <> old.max_attempts or new.failed_attempts < old.failed_attempts
     or new.session_kind <> old.session_kind then
    raise exception using errcode = '55000', message = 'MFA_CHALLENGE_IMMUTABLE';
  end if;
  -- A verified proof is final: neither unset nor replaced by another code.
  if old.proof_verified_at is not null and (
       new.proof_verified_at is distinct from old.proof_verified_at
       or new.proof_method is distinct from old.proof_method
       or new.proof_verifier_hmac is distinct from old.proof_verifier_hmac
       or new.proof_key_version is distinct from old.proof_key_version
       or new.proof_sent_at is distinct from old.proof_sent_at) then
    raise exception using errcode = '55000', message = 'MFA_CHALLENGE_IMMUTABLE';
  end if;
  if new.consumed_at is not null and old.expires_at <= clock_timestamp() then
    raise exception using errcode = '23514', message = 'MFA_CHALLENGE_EXPIRED';
  end if;
  -- A staff authenticator is enrolled only on a fresh proof, never on the
  -- password alone.
  if new.consumed_at is not null and new.session_kind = 'staff' and new.purpose = 'enroll'
     and new.proof_verified_at is null then
    raise exception using errcode = '23514', message = 'MFA_ENROLLMENT_PROOF_REQUIRED';
  end if;
  return new;
end
$$;

alter table auth.mfa_factors
  add column enrollment_proof text,
  add column enrollment_challenge_id uuid;

alter table auth.mfa_factors
  add constraint mfa_factors_enrollment_proof_check check (
    (enrollment_proof is null and enrollment_challenge_id is null)
    or (enrollment_proof in ('email_code', 'provider_activation') and enrollment_challenge_id is not null)
  );

comment on column auth.mfa_factors.enrollment_proof is
  'The fresh proof of the staff enrolment that created this factor (0088): email_code or provider_activation. Null for a factor created by platform sign-in, which never verifies a staff session.';
comment on column auth.mfa_factors.enrollment_challenge_id is
  'The staff enrolment challenge (auth.mfa_login_challenges) whose verified proof this factor records (0088). Never changes.';

create function auth.guard_mfa_factor_enrollment_proof()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.enrollment_proof is distinct from old.enrollment_proof
       or new.enrollment_challenge_id is distinct from old.enrollment_challenge_id then
      raise exception using errcode = '55000', message = 'MFA_FACTOR_IMMUTABLE';
    end if;
    return new;
  end if;
  -- A factor records a staff proof only from a live staff enrolment challenge
  -- of its own account whose proof of that method is verified.
  if new.enrollment_challenge_id is not null and not exists (
    select 1 from auth.mfa_login_challenges challenge
    where challenge.id = new.enrollment_challenge_id and challenge.account_id = new.account_id
      and challenge.session_kind = 'staff' and challenge.purpose = 'enroll'
      and challenge.proof_method = new.enrollment_proof and challenge.proof_verified_at is not null
      and challenge.consumed_at is null and challenge.invalidated_at is null
      and challenge.expires_at > clock_timestamp()
  ) then
    raise exception using errcode = '23514', message = 'MFA_ENROLLMENT_PROOF_REQUIRED';
  end if;
  return new;
end
$$;
revoke all on function auth.guard_mfa_factor_enrollment_proof() from public;
create trigger mfa_factors_enrollment_proof_guard
  before insert or update on auth.mfa_factors
  for each row execute function auth.guard_mfa_factor_enrollment_proof();

create or replace function auth.guard_session_assurance_change()
returns trigger
language plpgsql
set search_path = auth, pg_temp
as $$
declare
  assured_kind text;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'SESSION_ASSURANCE_IMMUTABLE';
  end if;
  if tg_op = 'INSERT' then
    select session_row.session_kind into assured_kind
      from auth.sessions session_row
     where session_row.id = new.family_id and session_row.family_id = new.family_id
       and session_row.account_id = new.account_id and session_row.session_kind in ('staff', 'platform');
    if assured_kind is null or not exists (
      select 1 from auth.mfa_factors factor
      where factor.id = new.mfa_factor_id and factor.account_id = new.account_id and factor.status = 'active'
    ) then
      raise exception using errcode = '23514', message = 'SESSION_ASSURANCE_INVALID';
    end if;
    -- A staff session is verified only by a factor enrolled with a staff
    -- proof, never by one a platform sign-in enrolled on the password alone.
    if assured_kind = 'staff' and not exists (
      select 1 from auth.mfa_factors factor
      where factor.id = new.mfa_factor_id and factor.enrollment_proof is not null
    ) then
      raise exception using errcode = '23514', message = 'STAFF_MFA_FACTOR_UNPROVEN';
    end if;
    if new.step_up_at is not null or new.step_up_count <> 0 then
      raise exception using errcode = '23514', message = 'SESSION_ASSURANCE_INVALID';
    end if;
    return new;
  end if;
  if new.family_id <> old.family_id or new.account_id <> old.account_id
     or new.mfa_factor_id <> old.mfa_factor_id or new.mfa_method <> old.mfa_method
     or new.mfa_verified_at <> old.mfa_verified_at
     or (old.step_up_at is not null and (new.step_up_at is null or new.step_up_at < old.step_up_at))
     or new.step_up_count < old.step_up_count then
    raise exception using errcode = '55000', message = 'SESSION_ASSURANCE_IMMUTABLE';
  end if;
  return new;
end
$$;

comment on table auth.mfa_factors is
  'TOTP factors of platform administrators and staff (one active factor per account, 0088). secret_ciphertext is AES-256-GCM ciphertext; the plaintext secret is never stored or returned after enrollment. Only a factor that records a staff enrolment proof verifies a staff session.';
comment on table auth.mfa_login_challenges is
  'Short-lived second-factor challenges between a verified password and a platform or staff session (0088). The browser holds the token in an httpOnly cookie; only its digest is stored.';
comment on table auth.session_assurance is
  'Server-side MFA and step-up evidence for a platform or staff session family (0088). Clients cannot assert assurance.';

update auth.permissions
   set description = 'Request a governed reset of another account''s MFA, administrator or staff (two-person approval)'
 where code = 'platform.mfa.reset';
