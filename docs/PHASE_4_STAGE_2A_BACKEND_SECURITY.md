# Phase 4 Stage 2A: Backend Security Hardening

Branch: `phase-4-stage-2-backend-security` (base `phase-3-patient-safety` at
`75af5bc`). Backend only. Nothing here is deployed or migrated against a live
database. ADR-038 records the decisions.

## 1. Platform sign-in and sessions

| Step | Route | Result |
|---|---|---|
| Password | `POST /api/v1/auth/admin/login` (`turnstileAction: admin-login`) | Valid password **and** `platform.admin.access` → `{ status: mfa_required \| mfa_enrollment_required }` and an httpOnly `hid_access_admin_mfa` challenge cookie (5 minutes; 10 for enrollment; 5 attempts). Anything else → the same `401` as a wrong password. |
| Second factor | `POST /auth/admin/mfa/verify` `{ code }` or `{ recoveryCode }` | Platform session. |
| First sign-in | `POST /auth/admin/mfa/enroll/start` → `{ secret, otpauthUri }` (only time the secret is returned); `POST /auth/admin/mfa/enroll/activate` `{ code }` | Activates the factor, returns 10 recovery codes once, opens the platform session. |
| Refresh | `POST /auth/admin/refresh` (refresh cookie + CSRF header) | Rotation with reuse detection; new 15-minute idle window, never past sign-in + 8 h. |
| Sign out | `POST /auth/admin/logout` | Revokes the session. |

Platform sessions (`auth.sessions.session_kind = 'platform'`):

- They need no staff record or facility membership. This closes Stage 1
  finding S1; the verifier's administrator has neither.
- They use separate cookies: `hid_access_admin` (path `/api/v1`),
  `hid_access_admin_refresh` (path `/api/v1/auth/admin`) and
  `hid_access_admin_csrf`. All are `SameSite=Strict`, and `Secure` when
  configured. A staff session in the same browser is untouched.
- Lifetimes are a 5-minute access token, a 15-minute idle window measured from
  the last refresh, and an 8-hour absolute lifetime. The database refuses longer
  values (`sessions_platform_lifetime_check`). `last_used_at` is still never
  written per request. The frontend should refresh only on user activity.
- Every request re-checks the session row, token version and account status. It
  also checks that the session family's MFA evidence references a factor that
  is still active, so an MFA reset or revocation ends the session at once.

Separation:

| Session | On `/admin/*` | Elsewhere |
|---|---|---|
| Platform | Accepted | `403 PLATFORM_SESSION_SCOPE_DENIED` |
| Staff, facility or patient | Cookie not read (`401`); presented token `403 PLATFORM_SESSION_REQUIRED` | Unchanged |

`requireAdminContext` also refuses any non-platform actor. A platform refresh
token is refused by `/auth/refresh`, and a staff token by `/auth/admin/refresh`.

## 2. MFA

- **TOTP.** RFC 6238 through Node `crypto` (no new dependency), checked against
  the RFC 6238 and RFC 4226 vectors.
  - Parameters: SHA-1, 6 digits, 30 seconds, 160-bit CSPRNG secret, ±1 step
    for drift.
  - Each verification serializes on the factor row. A step is accepted only if
    it is later than `last_used_step`, enforced in the service, in the update's
    `WHERE` clause and by a trigger. A code therefore never replays, across
    sign-in and step-up alike.
- **Secret protection.**
  - The secret is AES-256-GCM encrypted with associated data that binds it to
    its factor and account.
  - The key is derived with HKDF from `MFA_SECRET_KEY_B64`. Recovery-code
    digests use a separately derived key. `MFA_KEY_VERSION` is recorded.
  - The secret is returned once, at enrollment start, with `Cache-Control:
    no-store`. It is never logged, audited or returned again; the verifier
    searches all audit and session evidence for it.
- **Recovery codes.**
  - Ten 50-bit codes (`XXXXX-XXXXX`, Crockford alphabet), stored as
    account-bound HMAC digests.
  - Each code is used once.
  - Regeneration requires step-up and invalidates every unused code.
  - Recovery codes can sign in but cannot step up.
- **Rate limits.** These use the existing `auth.otp_rate_limits` table and the
  shared `consumeRateLimit` (OTP recovery now calls the same function).
  - The fifth failed code within 15 minutes blocks the account for 15 minutes,
    even for a correct code.
  - 20 failures from one IP block that IP.
  - Enrollment starts and regenerations are limited to five per 15 minutes.
  - Each challenge also allows only five attempts.
  - Password lockout (`auth.login_attempts`) is unchanged.
- **Mandatory for all platform roles.** No path to a platform session skips the
  second factor, and every `/admin` route requires a platform session.
- **Email OTP is not MFA.** The OTP API accepts only recovery purposes;
  assurance records only `totp` or `recovery_code`. The SQL suite checks that no
  database function outside the MFA set references `auth.mfa_factors`.

## 3. Step-up and the central high-risk policy

- `POST /admin/mfa/step-up` `{ code }` (TOTP only) records `step_up_at` on the
  session family. The assurance lasts 5 minutes (`PLATFORM_STEP_UP_TTL_SECONDS`,
  at most 300). It survives refresh rotation and is per sign-in. Client
  headers, body fields and token claims are never consulted.
- `src/admin/high-risk-policy.ts` is the single registry. `@HighRiskAction()`
  names an action on each route. The guard refuses a platform mutation without
  one (`HIGH_RISK_POLICY_MISSING`), then checks the policy's permissions,
  If-Match (`428`), Idempotency-Key (`400`), reason (`400 REASON_REQUIRED`) and
  step-up (`403 STEP_UP_REQUIRED`).
- Every service command calls `requirePlatformAssurance` with its own action in
  its own transaction. SQL approval and session-family commands check step-up
  again through `app.session_id`. Direct service calls are refused; unit tests
  call each command directly without a session and without step-up.

| Tier | Step-up | Actions |
|---|---|---|
| Critical | Yes, plus a reason; approval where marked | Platform role change (Super Admin grant: two-person), Super Admin request, approval decisions, account status, revoke all sessions, revoke another account's session, MFA reset request (two-person), platform controls/kill switches, integration enable/pause/selection/fallback/credential reference, principal export |
| High | Yes | Facility status, pricing product and price, integration configuration and connection test, organization application verify-CAC/approve/reject (provider approve/reject), recovery-code regeneration |
| Standard | No | Demo-request status, step-up itself, revoking one's own session, sign-out |

Legal-hold and session-event review endpoints do not exist yet (S7). They get
a registry entry when they are built; the registry test fails if any platform
mutation lacks one.

## 4. Two-person approval (0070)

- **Request.**
  - Routes: `POST /admin/principals/:id/super-admin-requests` or
    `/mfa-reset-requests`, with `{ reason }` and an `Idempotency-Key`.
  - The requester must hold `platform.role.manage` (or `platform.mfa.reset`),
    an active factor and a fresh step-up, and must not be the target.
  - A grant requires an active target that is not already a Super Admin; a
    reset requires a target with a factor.
  - At most one request may be pending per action and target. A request
    expires after 24 hours.
- **Decide.**
  - Route: `POST /admin/approvals/:id/approve|reject|cancel`, with `{ reason }`,
    `If-Match` and an `Idempotency-Key`.
  - The decider must be an active `platform_super_admin` with an active factor
    and a fresh step-up, and must be neither the requester nor the target.
  - Only the requester may cancel.
  - An expired request becomes `expired` and is never executed.
- **Exactly once.** The decision locks the request row, and the grant or reset
  runs in the same transaction. Two concurrent approvals give one `200` and one
  `409` (verified over HTTP); a later decision gets `409 APPROVAL_NOT_PENDING`.
- **MFA reset execution.** The reset revokes the active and pending factors,
  invalidates unused recovery codes, revokes all sessions and increments the
  token version. The administrator then enrolls a new authenticator at next
  sign-in. No email OTP, recovery flow or self-service path resets an active
  factor.
- **Refusal.** A one-step `platform_super_admin` grant is refused by
  `AdminService` and by `auth.admin_change_platform_role`
  (`403 TWO_PERSON_APPROVAL_REQUIRED`).
- **Audit.** Requests, decisions and executions are audited
  (`admin.approval.*`, `admin.platform-role.grant`, `admin.mfa.reset`).

## 5. Session management

- **Listing.** `GET /admin/sessions` (own) and
  `GET /admin/principals/:id/sessions` (`platform.session.revoke`) return safe
  metadata only: id, family, kind, sign-in, last refresh, idle and absolute
  expiry, MFA time and method, last step-up and source IP. Refresh hashes and
  JTIs are never returned.
- **Revocation.**
  - `POST /admin/sessions/:id/revoke` revokes one of your own session families.
  - `POST /admin/principals/:id/sessions/:sessionId/revoke` (critical) takes
    `{ reason, compromised }`. It records `platform_admin_compromised_session`
    and a `revoked` session event.
  - The existing revoke-all command is now critical.

## 6. Principal export

`GET /admin/principals/export?reason=…[&query&status]`:

- **Access.** Requires `platform.principal.export` (Super Admin only; Support
  Admin loses it) and a step-up.
- **Columns.** `account_id, email, display_name, status, created_at,
  platform_roles`. No subject, password, session, token, version or membership
  data.
- **Size.** At most 5,000 rows. `X-HID-Export-Row-Count`,
  `X-HID-Export-Row-Limit` and `X-HID-Export-Truncated` report the cap.
- **Format.** RFC 4180: CRLF after every record, and fields containing `"`, `,`,
  CR or LF are quoted with doubled quotes. Values starting with `=`, `+`, `-`,
  `@`, tab or CR are prefixed with `'`. This fixes the Stage 1 literal `\n`
  defect (S4).
- **Response.** `Cache-Control: no-store` and `nosniff`. The audit row includes
  the reason, row count and truncation.

## 7. Database (0069, 0070)

See `docs/DATABASE.md` (Stage 2A checkpoint). Historical migrations are
unchanged; no existing row is rewritten. The Identity runtime cannot delete MFA
data or write approval rows directly.

## 8. Tests

| Layer | Coverage |
|---|---|
| Unit | RFC 6238/4226 vectors, ±1 window, base32, otpauth URI, recovery codes; secret protector (fresh nonce, AAD binding, key version, fail-closed); RFC 4180 CSV and formula neutralization; registry completeness (every platform mutation has a registered action, permissions aligned, tiers); guard (session-kind separation, cookie/CSRF scoping, every policy control, forged client claims ignored); service bypass (every governed command without platform session or step-up, staff session, one-step Super Admin grant); export contract and 5,000 cap; token refresh separation and platform lifetimes. |
| SQL (`platform-mfa-approval.integration.sql`) | Session ceilings, event/rate-limit/assurance constraints (email OTP rejected), factor/recovery/challenge/assurance immutability, runtime privileges, step-up evidence, one-step grant refusal, two-person elevation (self, ineligible, no-MFA, no step-up, exactly once), expiry, reject, cancel, MFA reset execution, session-family revocation, membership-free reachability. Killed by nine mutants: 0068 commands, membership reachability, no factor guard, stale step-up accepted, no self-approval check, decision without step-up, any admin approves, no assurance guard, no platform lifetime check. |
| HTTP (`verify-platform-security-runtime.mjs`) | Exact runtime role, real guard/interceptor/services/database: sign-in and enrollment, session-kind separation, TOTP replay, rate limiting, step-up and policy, direct Super Admin grant refusal, two-person elevation including concurrent approvals and expiry, MFA reset, recovery codes, session list/revocation, idle/rotation/absolute limits, export, no secrets in evidence. It fails when the guard's session-kind check, both replay checks or the step-up freshness check is removed. |
| HTTP (`verify-platform-admin-runtime.mjs`) | Stage 1 boundaries re-run with platform sessions. |

The rehearsal runs the new SQL suite automatically and records
`platform_security_runtime`; container acceptance runs the SQL suite and reports
`0001-0070`.

## 9. Policy decisions and remaining work

| Item | Status |
|---|---|
| Super Admin **revocation** | One step with step-up and last-Super-Admin protection. Whether it also needs two-person approval is an open policy decision. |
| First-factor enrollment | An administrator without a factor enrolls at their next sign-in, protected only by the password (trust on first use). Alternatives: invitation-bound enrollment, or forcing a password reset with every MFA reset. Policy decision. |
| MFA reset and password | A reset does not change the password or account status. For a suspected compromise, also suspend the account or require a password reset. Policy decision. |
| Legacy `platform_admin` (S6) | Still holds `role.manage`/`principal.manage` and counts for last-Super-Admin reachability; cannot approve (approver must be `platform_super_admin`). |
| `platform_operations_admin` controls (S5) | Still holds `control.manage`, now critical with step-up. |
| Facility transition reachability | `identity.admin_transition_facility` (0027) still counts only membership-reachable Super Admins and can refuse a suspension unnecessarily. Not changed here. |
| `MFA_SECRET_KEY_B64` | Must be added to the Identity secret and ECS task definition (infra not changed in this stage). Without it, admin sign-in fails closed. Key rotation needs a re-encryption tool or re-enrollment. |
| Frontend (Stage 2B) | Health-id admin must implement admin sign-in, enrollment (QR from `otpauthUri`), recovery codes, step-up prompts on `STEP_UP_REQUIRED`, approvals, session management and the export reason. Until then it cannot use this backend. |
| S2 (`locked` recovery), S7 (legal holds, session-event review UI) | Unchanged. |
