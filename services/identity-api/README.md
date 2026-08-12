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

Public URLs remain under `/api/v1/auth/*` and `/api/v1/identity/*`. Approved
service consumers use workload-authenticated internal actor/authorization
routes while separately propagating the user credential. Production accepts
only asymmetric issuer/JWKS workload evidence; local tokens are development
only.

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
