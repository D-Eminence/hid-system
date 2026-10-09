# Phase 4 Stage 4A: Platform Admin Contract Gaps

Branch: `phase-4-stage-4a-backend-contracts` (base `main` at `01e624f`).
Backend only: Identity API and database migration `0072`. Nothing here is
deployed or migrated against a live database.

This stage closes the backend gaps listed by the Health-id Stage 3 admin
consolidation (`docs/PHASE_4_STAGE_3_ADMIN_CONSOLIDATION.md` and
`docs/OPEN-QUESTIONS.md` in Health-id) and the facility item of
`PHASE_4_STAGE_2A_BACKEND_SECURITY.md` §9. Platform sessions, MFA, step-up,
idempotency keys, `If-Match`, reasons, two-person approval, RLS, runtime grants
and audit are unchanged unless stated.

## 1. Audit filter by target

`GET /api/v1/admin/audit/events` accepts two more optional query parameters:

| Parameter | Rule |
|---|---|
| `resourceType` | Lower-case words joined by `-` or `_`, at most 80 characters, for example `facility`, `authentication-account`, `platform-control`. |
| `resourceId` | Letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit, at most 255 characters. Only together with `resourceType`. A UUID matches in any letter case; any other id matches exactly. |

Everything else is unchanged: `platform.audit.read` (route and database),
`limit` 1–200, `beforeSequenceId` keyset, newest first, the other filters, and
the response `{ items, nextBeforeSequenceId }`. Invalid values are
`400 VALIDATION_FAILED`.

Platform commands record their target in `resource_type`/`resource_id`, not in
`facility_id` (platform-scope rows carry no facility). So a facility's platform
changes are `?resourceType=facility&resourceId=<facility id>`; `?facilityId=`
never finds them. The facility status command records `admin.facility.<status>`.

Database: `audit.list_platform_events` gains `requested_resource_type` and
`requested_resource_id` (both default null). The 0067 nine-argument function is
dropped, so an older Identity build calling with nine arguments still resolves to
the new one. A UUID-shaped id uses the generated `resource_uuid` column and the
new index `audit_resource_uuid_sequence_idx (resource_type, resource_uuid,
sequence_id desc)`; other ids use the existing `audit_resource_text_idx`. The
function plans each call for its own filters (`plan_cache_mode =
force_custom_plan`), so a target lookup stays on the index after the fifth call.
Locally, 300,000 synthetic rows: an index scan, under 1 ms per call.

## 2. MFA enrolment on each principal

Each `GET /api/v1/admin/principals` item has `mfaEnrolled: boolean`: true when
the account has an active (confirmed) authenticator. No factor id, secret, time
step, recovery-code or enrolment detail is returned. A factor still being
enrolled (`pending`) is not enrolment. The MFA reset command still accepts it,
and the next enrolment start replaces it. The value is read when the list is
read, so the console must still handle `409 MFA_NOT_ENROLLED` from
`POST /admin/principals/:id/mfa-reset-requests`. The principal export is
unchanged.

## 3. Cursor pagination for approvals and demo requests

| Route | Order (unchanged) | Page size | Filters |
|---|---|---|---|
| `GET /api/v1/admin/approvals` | `requested_at` desc, then `id` | `limit` 1–100, default 50 (was a fixed 200) | `status` |
| `GET /api/v1/admin/demo-requests` | `created_at` desc, then `id` desc | `limit` 1–100, default 50 (unchanged) | `status`, `productCode` |

Both return `{ items, nextCursor }`. `nextCursor` is null on the last page;
otherwise pass it back as `cursor` with the same filters. A cursor is opaque. It
names the last row of the page, at microsecond precision, and the list and
filters it was issued for. It is a position, not a credential: every page
re-applies the permission checks (`platform.admin.access` plus one of
`platform.role.manage`, `platform.mfa.reset` or `platform.audit.read` for
approvals; `platform.demo.read` for demo requests) and the filters.

A cursor that is altered, truncated, padded, issued for another list or other
filters, or names an impossible position is `400 ADMIN_INVALID_CURSOR`. A cursor
longer than 512 characters, or a `limit` outside 1–100, is
`400 VALIDATION_FAILED`. The keys are immutable, so a row is never repeated or
skipped while paging. A row whose status changes can enter or leave a filtered
list between pages. No total is returned.

## 4. Session-end and step-up codes

Platform routes and `POST /api/v1/auth/admin/refresh` distinguish why a platform
session is no longer accepted:

| Code | Status | When |
|---|---|---|
| `PLATFORM_SESSION_EXPIRED` | 401 | The idle (15 min) or absolute (8 h) lifetime passed. |
| `PLATFORM_SESSION_REVOKED` | 401 | Signed out, revoked by the administrator or another administrator, refresh-token reuse, account suspended, credentials or platform roles changed, or the authenticator was reset. |
| `AUTHENTICATION_REQUIRED` | 401 | Everything else: no credential, an unknown, forged or malformed token, an access token that simply needs a refresh, or a session replaced by a refresh. |
| `STEP_UP_REQUIRED` | 403 | The command needs a step-up and this session has none. |
| `STEP_UP_EXPIRED` | 403 | The session's last step-up is older than five minutes. |

Enumeration:
- A session end is reported only after the credential is shown to be one the
  server issued for that session: an access token with a valid signature,
  issuer and audience, matched on session id, subject and token id, or a refresh
  token whose digest matches a stored session. Anything else gets the generic
  answer, without any session lookup.
- The detail never names the revocation reason.
- Staff and patient sessions, and platform tokens presented outside platform
  routes, keep the generic `AUTHENTICATION_REQUIRED`.
- Step-up codes concern only the caller's own verified session.

Two supporting changes make the expired code observable in a browser:

- The platform refresh and CSRF cookies now expire at the end of the sign-in
  (absolute expiry) instead of the idle window. The idle window is still
  enforced on the stored session, so a refresh after it is refused; the browser
  now presents it, and the answer is `PLATFORM_SESSION_EXPIRED`. Any refusal
  clears the cookies. The access cookie keeps the 5-minute token lifetime, and
  the response's `idleExpiresAt` is unchanged.
- `POST /auth/admin/refresh` without a refresh cookie is
  `401 AUTHENTICATION_REQUIRED` (was `403 CSRF_VALIDATION_FAILED`). A refresh
  cookie with a wrong CSRF value is still `403 CSRF_VALIDATION_FAILED`.

Several tabs may present the same idle-expired refresh token. That is reported
as `PLATFORM_SESSION_EXPIRED` and not treated as token reuse: an expired
session's family has no live session. Every other reuse handling is unchanged.

The shared web client retries a 401 once after a refresh and then surfaces the
original error, so the console should record the refresh's own code as well.
SQL commands that re-check step-up at the boundary still map to
`STEP_UP_REQUIRED`.

## 5. CORS export headers

Identity's CORS policy (`src/config/cors.ts`, used by `main.ts`) also exposes
`x-hid-export-row-count`, `x-hid-export-row-limit` and `x-hid-export-truncated`.
The export controller takes the names from the same constant. Allowed origins,
methods and credentials are unchanged. Same-origin deployments see no change.

## 6. Facility transition reachability

`identity.admin_transition_facility` (0027) refused to suspend or reject a
verified facility where a Super Admin works unless another Super Admin was a
member of a different verified facility. Platform sign-in has not depended on a
membership since 0069, so a facility change never removes a platform-session
path. 0072 keeps the same signature, checks, advisory lock, idempotency and
evidence, and replaces the count with `auth.other_reachable_super_admins` (0070):
active, not suspended, holding the role, with a password credential.

The command is now refused (`409 LAST_SUPER_ADMIN`) only while a Super Admin
works at the facility and no Super Admin at all can open a platform session.
The helper's null handling is fixed: a null excluded account now excludes
nobody instead of everyone. Every existing caller passes a non-null account.

## 7. Database, grants and deployment

- `0072_platform_admin_contract_gaps.sql` (forward-only):
  - replaces `auth.other_reachable_super_admins` and
    `identity.admin_transition_facility` (same signatures);
  - drops and recreates `audit.list_platform_events` with eleven arguments;
  - creates `audit_resource_uuid_sequence_idx`.
- `runtime-grants.sql` grants `EXECUTE` on the new signature to exactly the two
  roles that held the old one: `hid_identity_runtime` (inherited by
  `hid_identity_api_runtime`) and `hid_schema_test_runtime`.
- `runtime-roles.integration.sql` asserts:
  - the old signature is gone and the Identity runtime can execute the new one;
  - `PUBLIC` and the other API runtimes cannot;
  - the reachability helper stays internal.
- Run the role bootstrap right after the migration, as for every release: until
  then the Identity runtime cannot execute the new audit reader.
- The index build holds a share lock on `audit.events`, so audit inserts wait
  while it runs. Apply 0072 in the release window; the runner's 120 s statement
  timeout bounds it.

## 8. Tests

Each new behaviour was shown failing before the change (base `01e624f`, database
at 0071) and passing after it.

| Layer | Coverage |
|---|---|
| Unit (`admin-contracts.spec.ts`, `platform-session-end.spec.ts`, updates to `token.service.spec.ts`, `platform-scope.spec.ts`, `admin.service.spec.ts`) | Cursor codec and refusals; approvals and demo pages, binding and permission order; audit target parameters and validation; `mfaEnrolled`; CORS options; every session-end classification and the generic answers; step-up codes in the guard and the services. 33 of them fail on the base code. |
| SQL (`platform-admin-contracts.integration.sql`, as `hid_identity_api_runtime`, rollback-only) | Reachability helper with a null exclusion; facility suspension accepted with a membership-free reachable Super Admin and still refused when nobody can sign in; target filter by UUID in either case, by text id, by type, with other filters and the keyset; invalid filters; permission unchanged; one eleven-argument reader and the index. Each part fails on 0071. `schema.integration.sql` now expects the suspension to be accepted. |
| HTTP (`verify-platform-admin-runtime.mjs`) | Facility suspension over HTTP where the only Super Admin works; the facility's history by target (case-insensitive, keyset, not found by `facilityId`); validation and permission; `mfaEnrolled` per principal; demo-request cursor round trip across a sub-millisecond boundary and equal timestamps; tampered, foreign-list and other-filter cursors; permission. |
| HTTP (`verify-platform-security-runtime.mjs`) | `STEP_UP_EXPIRED` vs `STEP_UP_REQUIRED`; approvals cursor round trip (sub-millisecond boundary, equal timestamps, tampered and other-filter cursors, `limit` bound, permission); `PLATFORM_SESSION_REVOKED` after own revocation, MFA reset and refresh reuse; `PLATFORM_SESSION_EXPIRED` from the guard and refresh, twice without a reuse event; generic answers for a forged signature, a platform token on a staff route, a revoked staff session, an unknown refresh token and a missing refresh cookie; refresh and CSRF cookie lifetime; CORS exposure of the export headers. |

## 9. Not built here (product or policy decisions)

These are recorded, not built:
- organization directory;
- support cases;
- security metrics;
- legal holds and session-event review;
- billing;
- Super Admin revocation policy;
- first-factor enrolment policy.

Follow-ups:
- A refresh token whose session was revoked for a reason other than rotation
  (sign-out, revocation, MFA reset) still takes the reuse path and records a
  `reuse_detected` session event, as before this stage. No live session is
  affected, but the event overstates the cause. Narrowing it changes security
  evidence and is left for a separate review.
- The approvals and demo-request lists return no total. If the console needs
  exact waiting counts, add them to `GET /admin/overview`.
