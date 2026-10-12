-- Recovery start (POST /auth/otp/start) answers a repeat inside the resend
-- cooldown alike whether or not the identifier has an account. Identity read
-- the cooldown only from the account's active row in auth.otp_challenges: a
-- repeat for a real account got the live challenge id back, and one for an
-- unknown identifier, which has no row, got a new random id. Two requests
-- told whether an email address or HID had an account (CODEX.md §27); patient,
-- staff and administrator recovery share this start. Identity now records
-- each start per purpose and keyed identifier, known or not, and answers a
-- repeat inside the cooldown with the id it recorded. Applied migrations 0001
-- through 0079 are immutable.
--
-- The rows cannot live in auth.otp_challenges: its unique active index on
-- (recipient_hmac, purpose) (0028) would refuse a later real challenge for the
-- same address. A row holds a keyed HMAC of the purpose and the case-folded
-- identifier, never the identifier, the challenge id last answered and when.
-- It authorizes nothing, and its challenge id may name no challenge (an
-- unknown identifier has none), so there is no foreign key. As for
-- auth.otp_challenges and auth.otp_rate_limits, there is no row-level
-- security and no retention job: the role bootstrap grants SELECT, INSERT and
-- UPDATE to the Identity runtime only, and each identifier keeps one row per
-- purpose, overwritten by its next start.

create table auth.otp_start_cooldowns (
  purpose text not null check (purpose in (
    'PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK'
  )),
  identifier_hmac char(64) not null check (identifier_hmac ~ '^[0-9a-f]{64}$'),
  challenge_id uuid not null,
  started_at timestamptz not null default clock_timestamp(),
  primary key (purpose, identifier_hmac)
);

revoke all on auth.otp_start_cooldowns from public;

comment on table auth.otp_start_cooldowns is
  'Identity-owned recovery start cooldown per purpose and keyed identifier, known or not; authorizes nothing, and challenge_id may name no challenge.';
