# HID Identity API

The authoritative HID Identity backend runs independently on port `3001`.
It owns authentication sessions, workforce/facility context, canonical patient
UUIDs, HID issuance, patient identifiers, governed NIN registration cases,
consent/access commands, authorization decisions, and Identity audit evidence.

Identity does not own EHR, Lab, Pharmacy, OCR, or Outreach operational data.
Authentication subjects, HIDs, NINs, email addresses, phone numbers, and
external identifiers never replace the canonical patient UUID.

Identity also owns `/api/v1/admin/*` for explicit platform administration of
its accounts, sessions, platform-role assignments, facilities, registration
review evidence, and immutable audit, plus bounded read-only service status
aggregation. These routes require separate `platform.*` capabilities and do
not grant clinical, break-glass, arbitrary SQL, audit mutation, or foreign-
domain persistence authority. See `../../docs/SUPER_ADMIN_FOUNDATION.md`.

Public authentication and identity URLs remain under `/api/v1/auth/*` and
`/api/v1/identity/*`. Commercial demo intake and pricing reads use
`/api/v1/commercial/*` in the same Identity service. Approved
service consumers use workload-authenticated internal actor/authorization
routes while separately propagating the user credential. Production accepts
only asymmetric issuer/JWKS workload evidence; local tokens are development
only. A cookie-authenticated request with an unsafe method needs Origin and
CSRF evidence, with one exception for delegated reads: on the two routes
marked `@DelegatedBrowserRequest()`,
`POST /api/v1/identity/service/authorization/check` and
`POST /api/v1/identity/outreach/authorize`, `SecurityGuard` skips that check
when the request authenticates as an approved workload and reports the method
of the request that workload is serving as `GET`, `HEAD` or `OPTIONS` in
`X-HID-Original-Method`. After such a skip the Outreach route authorizes only
a permission ending in `.read` (ADR-045). See the Extracted
Identity boundary in `../../docs/INTERFACE_CONTRACT.md`.

Staff and patient browser sessions use host-only cookies with Origin and CSRF
checks. Their cookie names and paths, the refresh and sign-out outcomes, and
the `X-HID-Client` header that keeps a cookie refresh or sign-out from acting
on the other application's sign-in while refresh could renew it
(D-Eminence/hid-system#39) are specified in `../../docs/INTERFACE_CONTRACT.md` ("Auth session
contract"). `scripts/verify-session-sign-out-runtime.mjs` exercises them
through the controller as `hid_identity_api_runtime`. It runs only inside the
synthetic migration rehearsal (`scripts/tuf-staging-migration-rehearsal.mjs`
at the repository root, also run by `release/scripts/run-workspace-gates.mjs`),
never against a deployed environment.

The service uses `DATABASE_URL` through a login that inherits
`hid_identity_api_runtime` (Identity/authentication persistence plus
append-only audit), never an EHR, Lab, Pharmacy, OCR, or Outreach role.

Run independently:

```bash
npm run typecheck
npm test
npm run build
npm start
```

Readiness at `/api/v1/health/ready` checks PostgreSQL. Migration ownership
remains with the single platform ledger and runner temporarily co-located at
`services/ehr-api` until a separately approved ledger transition; this service
does not fork migration history. Container execution and production issuer,
token-mount, PostgreSQL TLS, and non-owner LOGIN evidence remain external.
