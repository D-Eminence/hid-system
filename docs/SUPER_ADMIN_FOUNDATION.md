# HID Super Admin Foundation

Status: implemented and verified locally; external deployment verification remains pending.

Date: 2026-08-11

## Permanent boundaries

```text
Super Admin != clinical authority
Super Admin != break-glass
Admin UI != database console
Administrative mutation -> owning domain API
```

The browser has no PostgreSQL driver, connection string, hosted-database SDK,
or domain persistence authority. `apps/admin` calls same-origin `/api/v1/admin`
routes. Identity authenticates the human, resolves explicit platform role
assignments, enforces capabilities server-side, and owns the implemented
facility/principal/Identity administration commands. No Admin BFF was added:
the current first version needs one owning Identity API plus a narrow bounded
operations aggregator, not a second deployment or authority.

## Existing-functionality inventory

| Existing item | Classification | Disposition |
|---|---|---|
| Identity local/OIDC authentication, secure host-only cookie/bearer transport, session verification, Origin/CSRF controls | SAFE TO PRESERVE | Identity is the only human authentication authority. The legacy HTTP runtime was removed; migration recovery uses six-digit OTP. |
| `auth.account_roles`, roles, permissions, facility membership tuples, account/session versioning | SAFE TO PRESERVE | Extended with explicit platform capabilities and reasoned role history. Authentication principal, facility membership, and platform assignment stay distinct. |
| Request-scoped PostgreSQL context and forced-RLS Identity registration workflow | SAFE TO PRESERVE | Added only minimum platform read policies; no BYPASSRLS or generic override. |
| Append-only semantic audit | SAFE TO PRESERVE | Admin commands append reasoned evidence atomically; the audit center has no mutation route or privilege. |
| Facility `active` flag | NEEDS HARDENING | Extended to `pending`, `verified`, `rejected`, and `suspended`, with immutable transition history. `active` is now constrained to exactly `verified`. |
| Current staff-context resolver ignoring platform assignments | NEEDS HARDENING | It now resolves platform roles/permissions separately from facility roles/permissions. |
| Identity registration-case duplicate candidates | SAFE TO PRESERVE | Exposed read-only with masked NIN. No merge, automatic same-person conclusion, or HID issuance was added. |
| Event dispatcher health/metrics | SAFE TO PRESERVE | Aggregated through the authorized Identity admin endpoint with timeouts and safe shaping. |
| Dispatcher arbitrary retry command | MISSING | Intentionally remains future work because no governed retry command exists. The first Admin event view is read-only. |
| OCR worker status endpoint | MISSING | Displayed honestly as `not_observable`; no fake worker health is produced. |
| Retained `/eminence/*`/Supabase-era dashboard and SQL-by-email setup instructions | LEGACY / RETIRED | Reference only. It is not an active authority and must not be used to bootstrap or authorize administrators. |
| `upstream_snapshot` admin material | REFERENCE ONLY | Historical comparison only; no hosted-backend authority was restored. |
| Active platform administration API and dedicated app | MISSING | Implemented in this checkpoint. |

## Authorization model

Migration `0027_super_admin_foundation.sql` adds these active platform roles:

| Role | Capabilities |
|---|---|
| `platform_super_admin` | All platform administration capabilities in this foundation. |
| `platform_operations_admin` | Admin access and safe service/event operations reads. |
| `identity_review_admin` | Admin access and read-only Identity review evidence. |
| `facility_review_admin` | Facility read and governed lifecycle commands. |
| `security_auditor` | Immutable audit and operational reads only. |
| `support_admin` | Principal/membership lookup and authoritative session revocation only. |

Every capability begins `platform.`. Schema acceptance fails if any new
platform role receives a clinical/domain permission. Facility permissions are
still resolved independently and do not become platform permissions. An
administrator can perform a clinical action only if the principal separately
holds the normal facility/domain role and follows that domain workflow.

### Platform scope (Phase 4 Stage 1, ADR-037)

Admin controllers are `@PlatformScope()`. The guard binds no facility, ignores
`X-Facility-ID`, strips facility roles/permissions, and accepts only platform
permissions; facility routes accept only the bound membership's permissions.
`requireAdminContext` yields a `PlatformAccessContext` with no facility or
membership, the database transaction carries `app.access_scope = 'platform'`,
and audit rows are `access_scope = 'platform'` with no facility. Staff sign-in
still requires an active facility membership; platform routes never use it.

## Authentication and bootstrap

Since Phase 4 Stage 2A (ADR-038, `docs/PHASE_4_STAGE_2A_BACKEND_SECURITY.md`)
the Admin browser signs in through `/api/v1/auth/admin/login` (password), then
`/auth/admin/mfa/verify` (TOTP or a one-time recovery code) or, on first sign-in,
`/auth/admin/mfa/enroll/start` and `/enroll/activate` (an administrator who
also holds a staff membership is refused there with `409
MFA_ENROLLMENT_STAFF_SIGN_IN_REQUIRED` and enrols at staff sign-in instead,
MFA-1, 0088). That issues a separate
platform session (`hid_access_admin*` cookies) with a 15-minute idle and 8-hour
absolute lifetime; it needs no facility membership. Staff, patient and facility
sessions are refused on every `/admin` route, and a platform session is refused
everywhere else. `/admin/session` returns only the authenticated
actor's platform roles/capabilities. Missing authentication shows sign-in;
authentication without `platform.admin.access` shows denial. Browser guards
are UX only; every API method has a backend permission decorator and the
database command repeats the platform capability check.

The one-time bootstrap seeds the initial governance set: two or three Super
Admins in one run. No administrator can grant another alone: a Super Admin
grant needs the decision of a second, MFA-enrolled Super Admin who is neither
the requester nor the target (0070), and a clinician application is approved
only by a Super Admin other than the one who attested it (0098). With a single
Super Admin neither can ever happen, and no command adds a second one after the
bootstrap. So in production name two or three people at once, preferably
three (Where the accounts come from). On a new database name them by email
address (owner decision 2026-10-16, below):

```bash
DATABASE_ADMIN_URL='postgresql://...' \
PLATFORM_ADMIN_EMAILS='example-owner-1@example.org example-owner-2@example.org example-owner-3@example.org' \
PLATFORM_ADMIN_BOOTSTRAP_REASON='Approved initial platform governance owners' \
npm --prefix services/ehr-api run admin:bootstrap
```

or name existing accounts by UUID in `PLATFORM_ADMIN_ACCOUNT_IDS`
(`exact-v4-account-uuid-1,exact-v4-account-uuid-2,exact-v4-account-uuid-3`)
instead of `PLATFORM_ADMIN_EMAILS`.

In AWS it runs as the migration task with the command override
`["scripts/bootstrap-platform-admin.mjs"]` and these variables as environment
overrides (`AWS_DEPLOYMENT_RUNBOOK.md` §4); `DATABASE_ADMIN_URL` comes from the
task's secret. It takes exactly one of three inputs:

- `PLATFORM_ADMIN_EMAILS`: two or three distinct email addresses, separated by
  commas or spaces. Each is trimmed and lower-cased, as staff email is (0087),
  and must be one plain address of at most 254 characters, with no display
  name. For each address the run creates a platform-only account (subject
  `platform:<id>`, no display name, no staff or patient record, source `hid`)
  with no password, status `pending_reset` and its email not marked verified,
  and grants it `platform_super_admin`. It refuses an address that already
  belongs to any non-deleted account or staff record: name existing accounts
  in `PLATFORM_ADMIN_ACCOUNT_IDS` instead. It needs migration `0086`, whose
  platform recovery reaches an administrator still setting a password. It
  prints the new account IDs in the order of the addresses, never an address.
- `PLATFORM_ADMIN_ACCOUNT_IDS`: two or three distinct version-4 account UUIDs
  separated by commas. Each account must exist already, active, with an email
  address and a password credential: platform sign-in is by email and password
  and finds the account by its email alone, so an account without one (a
  phone-only patient account, for instance) is refused.
- `PLATFORM_ADMIN_ACCOUNT_ID` (one account) remains for development: it is
  refused together with another form, and refused alone when `NODE_ENV` is
  `production`, as the migration task runs in every AWS environment, because
  one Super Admin alone could never add a second or approve a clinician
  application.

Each administrator enrols an authenticator at the first platform sign-in
(Stage 2A: no staff/facility tuple). An input error is refused before the run
connects, naming the variable and never echoing an address.

It runs only with an explicitly injected database-administrator connection,
serializes with an advisory transaction lock, requires migration `0027`, and
refuses to run while any non-deleted account holds an unrevoked platform Super
Admin (or legacy platform admin) assignment, whatever that account's status,
so it can never add an administrator beside a set already seeded, even one
still waiting for its passwords. In one transaction it creates the accounts
(email form), one explicit assignment per account, increments each account's
version, and writes one system audit event `admin.platform-role.bootstrap`
per account whose `details.bootstrapAccounts` names the whole set; the email
form adds `details.method` `email` and `accountCreated` and records no
address. A repeated, ineligible (not active, or without an email address or
password) or fourth account grants nothing. It never resolves an existing
account from an email address, and has no developer bypass, reusable login
shortcut, or repeat-success path.

### Where the accounts come from

A new database has no account: no migration seeds one, and no service runs
while the database is provisioned, so the bootstrap is no step of the
provisioning order (`AWS_DEPLOYMENT_RUNBOOK.md` §4).

Owner decision 2026-10-16 (SUPERADMIN-ACCOUNTS, `PHASE_3_LAUNCH_DECISIONS.md`):
"By email, own password". The one-time bootstrap names the governance owners
by email address in `PLATFORM_ADMIN_EMAILS` and creates each a platform-only
account with no password, `pending_reset`, in the same audited transaction that
grants each Super Admin. Each person then sets their own password with the
admin reset and enrols an authenticator. Nobody else ever knows the password:
not the operator who runs the task, and not another Super Admin. In order
(`AWS_DEPLOYMENT_RUNBOOK.md` §4, Running the migration task):

1. Choose the people and their addresses. Prefer three people: if one address
   turns out to be wrong after the others have set their passwords, two Super
   Admins remain. Give each person an address that no HID 1.0 auth user has,
   such as a dedicated admin mailbox, and check it against the approved
   read-only HID 1.0 source before the run: a seeded account keeps its address
   (`accounts_email_ci_uq`), which blocks a later HID 1.0 promotion of the same
   address (below).
2. Run it after the services and SES are live, so the reset code can be
   delivered by email.
3. Then every listed person starts the admin reset and confirms that the
   emailed code arrived before anyone sets a password. Each opens the admin
   password reset ("Forgot your password?" on the admin sign-in page:
   `/admin/recover` on the admin site or on the main site), which starts the
   recovery with the Turnstile action `admin-reset` (the platform audience,
   0086), enters their address and tells the operator that the code arrived,
   without entering it. Starting a reset changes no account, so a mistyped
   address can still be replaced (below). The recovery start answers an
   address without an account exactly as any other, so a code that never
   arrives is the only sign of a mistyped address.
4. Once every code has arrived, each person enters the code from step 3 on the
   same page and sets their own password. Completing the recovery turns
   `pending_reset` into `active` (0086). A code lasts `OTP_EXPIRY_SECONDS`
   (300 seconds by default), and entering
   it changes no account until the password is set. Only a person whose
   code has expired starts the reset again, and not within
   `OTP_RESEND_COOLDOWN_SECONDS` (60 seconds) of their last start, which
   returns the same challenge and sends no new code. Recovery starts are
   limited per client network (`OTP_RATE_MAX_REQUESTS`, 5 by default, per
   `OTP_RATE_WINDOW_SECONDS`, 900 seconds, for one IPv4 address or IPv6 /64),
   so people on one network space their starts; `429 OTP_RATE_LIMITED` means
   waiting the `Retry-After`, not a mistyped address.
5. Each person signs in at the admin site with that password and enrols an
   authenticator app (TOTP) at the first sign-in; a platform enrolment needs no
   emailed code. An account that is also an eligible staff member would enrol
   at staff sign-in instead, but these accounts have no staff record.
6. Then one Super Admin enables the QoreID integration, sets the launch
   controls and designates facilities, as their release checklist rows require.

If an address was mistyped (its code never arrives), run the bootstrap again
at once with the corrected list and `PLATFORM_ADMIN_REPLACE_PENDING=1`.
It is accepted only while every account holding a Super Admin assignment is
one the email bootstrap created (its audit event says so) that nobody has used:
still `pending_reset`, with no password, session, authenticator, external
sign-in, staff or patient record. A started or verified reset changes no
account (it writes only recovery challenge, cooldown and rate-limit records),
so it does not count as use. In the same transaction it revokes
their assignments, marks those accounts `deleted` (audit event
`admin.platform-role.bootstrap.replaced` for each) and seeds the new list; an
address on both lists is created again, so every listed person confirms a new
code (step 3) before anyone sets a password. Once anyone has set a password it
refuses, for every address. The other Super Admins can then remove a wrong
account through the governed role and status commands
(`POST /principals/:id/platform-roles` and `/status`), but nothing adds the
right person: a Super Admin is added only by a two-person approval, and no
command creates a platform-only account. With two addresses, a wrong one found
after the other person has set a password leaves a single Super Admin, who can
never add a second or approve a clinician application, and no command repairs
it (P6 can then never pass). Until the people reset, whoever controls an
address on the list can set that Super Admin's password through the admin
reset, so check the addresses before the run, complete the resets as soon as
every code has arrived, and after the run compare each
`auth.otp.recovery.completed` event with the person who reset.

The HID 1.0 promotion (`MIGRATION_RUNBOOK.md` §7 and §8) would also create
accounts. It creates each HID 1.0 user's account with the HID 1.0 auth user
UUID as its account ID, its email and its HID 1.0 password (bcrypt, upgraded to
Argon2id at the first sign-in). The account is active only with an email
confirmed in HID 1.0; otherwise it is `pending_reset`, which the account ID
form refuses. A HID 1.0 `platform_admin` membership is held with
`privileged_role_requires_reapproval` and grants no platform role, so on a
database not yet seeded by email the bootstrap's check for an existing Super
Admin still passes, and the bootstrap is the re-approval.

An account seeded by email keeps its address. The unique index
`accounts_email_ci_uq` (0002) covers every status but `deleted`, no command
changes an account's address, and disabling the account keeps it. The
promotion inserts an account only when its ID is new (`on conflict (id)`), so
promoting a HID 1.0 user whose address a seeded account has, in any letter
case, is a `target_content_mismatch` conflict on `auth.accounts` that blocks
the whole promotion run (`MIGRATION_RUNBOOK.md` §8). Hence step 1: each person
is seeded with an address that no HID 1.0 auth user has. If a governance
owner's seeded address is nevertheless their HID 1.0 address, record it:
resolving that conflict needs an owner decision, and the promotion path still
to be designed must handle it.

A HID 1.0 administrator who already holds a Super Admin account seeded by
email under another address is not re-approved: that HID 1.0 account keeps
no platform role. Two-person approval (0070) and clinician approval (0098)
separate accounts, not people, so each person holds at most one Super Admin
account.

But the promotion has no AWS execution path yet (`AWS_DEPLOYMENT_RUNBOOK.md`
§6). RDS accepts connections only from the service tasks and the migration
security group. The migration task maps only the migration administrator's
URL, as `DATABASE_URL` and `DATABASE_ADMIN_URL`; its security group reaches
only RDS, the AWS endpoints and Amazon S3, and its image holds no HID 1.0
export. So `migration:stage` can read neither the HID 1.0 source
(`LEGACY_DATABASE_URL`) nor an export (`MIGRATION_FIXTURE_PATH`), and
`migration:promote` refuses to start without
`MIGRATION_FIELD_ENCRYPTION_KEY_B64`, `MIGRATION_LOOKUP_HMAC_KEY_B64` and
`CONTACT_LOOKUP_HMAC_KEY_B64`: secrets that no task maps and that are never
passed as RunTask overrides. The first Super Admins no longer wait for it: the
email form above is the production route. Never open RDS to another network or
pass a key as an override to get around the promotion's missing path.

Once a promotion path exists, promoted accounts may be named in
`PLATFORM_ADMIN_ACCOUNT_IDS` instead, each active with an email address and a
password. For a promoted account, take each UUID from that person's HID 1.0
auth user ID in the approved read-only HID 1.0 source (the promotion keeps it
unchanged); never guess a UUID from an email or a name.

## Implemented API surface

All routes are under `/api/v1/admin` and are Identity-authenticated.

| Method and route | Capability | Behavior |
|---|---|---|
| `GET /session` | `platform.admin.access` | Minimum current platform authority. |
| `GET /overview` | `platform.admin.access` | Truthful bounded aggregate counts. |
| `GET /facilities`, `GET /facilities/:id` | `platform.facility.read` | Paginated/filtered lifecycle and membership metadata. |
| `POST /facilities/:id/status` | `platform.facility.manage` | Versioned, reasoned, idempotent verify/reject/suspend/reactivate transition. |
| `POST /principals/search` (and the deprecated `GET /principals`) | `platform.principal.read` | Terms in the body for `POST` (ADR-059). Search-required bounded account, facility-membership, platform-role, and session status. |
| `POST /principals/:id/status` | `platform.principal.manage` | Versioned suspension/reactivation; suspension increments token version and revokes sessions. Reactivation restores the pre-suspension status, so `pending_reset`/`locked` accounts must still recover (`409 ACCOUNT_RECOVERY_REQUIRED`); self-targeted commands return `403 ADMIN_SELF_CHANGE_DENIED` (0068). |
| `POST /principals/:id/platform-roles` | `platform.role.manage` | Allowlisted, versioned, reasoned, idempotent grant/revoke with last-admin protection. Administrators cannot change their own roles (0068). Granting `platform_super_admin` is refused (`403 TWO_PERSON_APPROVAL_REQUIRED`, 0070); use the two-person request below. |
| `POST /principals/export` (and the deprecated `GET /principals/export`) | `platform.principal.export` | Stage 2A: step-up and `reason` required (in the body for `POST`; ADR-059); at most 5,000 rows of account id, email, display name, status, creation time and platform roles; RFC 4180 CSV with formula neutralization. |
| `POST /principals/:id/super-admin-requests`, `POST /principals/:id/mfa-reset-requests`, `GET /approvals`, `POST /approvals/:id/{approve,reject,cancel}` | `platform.role.manage` / `platform.mfa.reset` / any of role.manage, mfa.reset, audit.read | Stage 2A two-person approval: 24-hour requests decided once by a different MFA-enrolled Super Admin with fresh step-up. |
| `GET /mfa`, `POST /mfa/step-up`, `POST /mfa/recovery-codes/regenerate` | `platform.admin.access` | Stage 2A own-MFA status (never the secret), TOTP step-up (5 minutes), recovery-code regeneration (step-up). A wrong or replayed step-up code is `403 MFA_INVALID_CODE` and a session without MFA assurance `403 PLATFORM_SESSION_REQUIRED` (both `401` before this change, A20). |
| `GET /sessions`, `POST /sessions/:id/revoke`, `GET /principals/:id/sessions`, `POST /principals/:id/sessions/:sessionId/revoke` | `platform.admin.access` / `platform.session.revoke` | Stage 2A session visibility (no token material) and revocation, including compromised-session revocation. |
| `POST /principals/:id/sessions/revoke` | `platform.session.revoke` | Real authoritative session revocation, not frontend state. |
| `GET /identity/reviews` | `platform.identity-review.read` | Paginated review evidence with `NIN-****1234`; no raw NIN or merge action. |
| `GET /audit/events` | `platform.audit.read` | Cursor-paginated immutable evidence. Patient IDs and free-form detail payloads are omitted. |
| `GET /operations/services` | `platform.operations.read` | Concurrent, per-service, 1.5-second-bounded readiness aggregation. |
| `GET /operations/events` | `platform.operations.read` | Whitelisted dispatcher metrics and PHI-minimal terminal failures. |
| `GET /workforce/accounts/:id`, `POST /workforce/memberships`, `POST /workforce/accounts/:id/attestations`, `POST /workforce/memberships/:id/roles`, `POST /workforce/memberships/:id/end` | `platform.workforce.manage` (Super Admin only) | Launch D14 clinician provisioning (0087, ADR-049, D-Eminence/hid-system#70): attach a staff identity to a verified facility as a pending membership, record a credential attestation, grant or revoke one clinical role (needs another administrator's current attestation), end a membership. Step-up, reason and `Idempotency-Key` on every command (`INTERFACE_CONTRACT.md` §19). |

No `/admin/sql`, generic record writer, Lab result, Pharmacy dispensing, OCR
validation, Outreach reconciliation, clinical history, audit update/delete,
break-glass activation, or arbitrary event retry route exists.

## State, concurrency, and audit

Facility suspension sets authoritative `identity.facilities.active = false`.
Existing authentication/membership and downstream authorization predicates
already require an active facility, so suspended facilities lose protected
workflow access without deleting history. Reactivation is an explicit
`verified` transition. Rejected facilities remain inactive.

Sensitive commands require a trimmed reason of 8 to 500 characters,
`Idempotency-Key`, and (where the target is versioned) `If-Match`. The immutable
idempotency record is keyed by actor, operation, and key, binds a stable request
digest, and returns the first response on an exact replay. Conflicting digests
and stale versions fail. Facility lifecycle events and semantic audit evidence
are append-only. Suspending or revoking the only reachable active Super Admin,
or suspending the final verified facility through which that administrator can
authenticate, is rejected. Those account, role, and facility checks share an
advisory transaction lock so concurrent changes cannot race the invariant;
there is no permanent founder exception.

## Admin UI

The authoritative Platform Admin frontend is `apps/patient-web/src/admin` in
`D-Eminence/Health-id` (ADR-037). `apps/admin` below is legacy reference code:
it is kept, receives no new features, and calls the same API contract.

`apps/admin` uses React/Vite and the shared `@hid/api-client` transport. Its
standalone development port is `3106`; users enter through
`http://localhost:3000/admin/`. Implemented routes are:

```text
/admin/
/admin/facilities
/admin/facilities/:facilityId
/admin/users
/admin/identity
/admin/audit
/admin/operations
/admin/events
```

Navigation is capability-filtered, sensitive commands use explicit reason and
confirmation prompts, server conflicts show safe Problem Details plus
correlation references, session expiry returns to Identity sign-in, and no
empty clinical or retry controls are displayed. React escaping is preserved.

## Database and runtime boundary

Migrations `0001` through `0026` were not modified. Additive migration `0027`
uses existing `auth`/`identity` ownership and neutral `integration` delivery
evidence. It adds no generic `admin.users` store and no database login role.
The Identity runtime can select its owned bounded data and execute exact
security-definer commands, but it cannot directly insert/update/delete platform
role assignments, update/delete facilities through generic table grants, or
mutate audit history. All group roles remain NOLOGIN, non-owner,
non-superuser, and non-BYPASSRLS.

## Local acceptance evidence

- Admin frontend: strict typecheck/lint, 19 tests, production build.
- Identity: strict typecheck, 15 suites/49 tests, production build.
- Event Dispatcher: 5 suites/18 tests and production build.
- PostgreSQL: migration plan/dry-run/apply, runtime-role bootstrap and catalog
  assertions, full rollback-only schema/RLS suite, final zero-pending plan.
- Database negatives: stale versions, digest conflicts, idempotent replay,
  last-admin suspension/revocation, last-reachable-admin facility suspension,
  support-role escalation, absence of non-platform permissions, immutable
  evidence, and existing facility/RLS authorization all pass.
- Architecture verifier: gateway route ownership, Admin UI no-database rule,
  linked-client browser prebundle, backend permission decorators, no generic
  backdoor, no raw NIN/auth-secret query, cross-domain SQL ownership, and port
  uniqueness pass.
- Live gateway/headless-browser smoke and the root production build pass. Final
  `git diff --check` is clean.

## Explicitly deferred or external

No automatic patient merge, patient enumeration, emergency-access grant,
arbitrary event retry, OCR validation, clinical mutation, or Admin BFF was
added. Broader facility onboarding/review decisions and specialized domain
operations APIs are future governed slices.

Docker execution/scanning, production database LOGINs, production workload
issuer/JWKS/tokens, RDS TLS, live EventBridge/IAM, ECS/Fargate, ECR,
CloudWatch/live monitoring, AWS deployment, external NIN provider, and
representative-device Outreach testing remain external evidence.
