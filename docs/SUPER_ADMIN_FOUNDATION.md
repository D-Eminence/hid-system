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

## Authentication and bootstrap

The Admin browser uses Identity `/auth/login`, `/auth/logout`, and the existing
session cookie/bearer contract. `/admin/session` returns only the authenticated
actor's platform roles/capabilities. Missing authentication shows sign-in;
authentication without `platform.admin.access` shows denial. Browser guards
are UX only; every API method has a backend permission decorator and the
database command repeats the platform capability check.

The one-time bootstrap command is:

```bash
DATABASE_ADMIN_URL='postgresql://...' \
PLATFORM_ADMIN_ACCOUNT_ID='exact-v4-account-uuid' \
PLATFORM_ADMIN_BOOTSTRAP_REASON='Approved initial platform governance owner' \
npm --prefix services/ehr-api run admin:bootstrap
```

It runs only with an explicitly injected database-administrator connection,
serializes with an advisory transaction lock, requires migration `0027`,
requires one exact active account with an active verified staff/facility tuple,
refuses to run if any active legacy or current Super Admin exists, creates one
explicit assignment, increments the account version, and writes a system audit
event. It has no email inference, developer bypass, reusable login shortcut, or
repeat-success path.

## Implemented API surface

All routes are under `/api/v1/admin` and are Identity-authenticated.

| Method and route | Capability | Behavior |
|---|---|---|
| `GET /session` | `platform.admin.access` | Minimum current platform authority. |
| `GET /overview` | `platform.admin.access` | Truthful bounded aggregate counts. |
| `GET /facilities`, `GET /facilities/:id` | `platform.facility.read` | Paginated/filtered lifecycle and membership metadata. |
| `POST /facilities/:id/status` | `platform.facility.manage` | Versioned, reasoned, idempotent verify/reject/suspend/reactivate transition. |
| `GET /principals` | `platform.principal.read` | Search-required bounded account, facility-membership, platform-role, and session status. |
| `POST /principals/:id/status` | `platform.principal.manage` | Versioned suspension/reactivation; suspension increments token version and revokes sessions. |
| `POST /principals/:id/platform-roles` | `platform.role.manage` | Allowlisted, versioned, reasoned, idempotent grant/revoke with last-admin protection. |
| `POST /principals/:id/sessions/revoke` | `platform.session.revoke` | Real authoritative session revocation, not frontend state. |
| `GET /identity/reviews` | `platform.identity-review.read` | Paginated review evidence with `NIN-****1234`; no raw NIN or merge action. |
| `GET /audit/events` | `platform.audit.read` | Cursor-paginated immutable evidence. Patient IDs and free-form detail payloads are omitted. |
| `GET /operations/services` | `platform.operations.read` | Concurrent, per-service, 1.5-second-bounded readiness aggregation. |
| `GET /operations/events` | `platform.operations.read` | Whitelisted dispatcher metrics and PHI-minimal terminal failures. |

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
