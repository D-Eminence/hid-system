# HID Outreach API

Independent NestJS service for facility-authorized temporary field registration
under `/api/v1/outreach/registration-cases`. It runs on port `3006`; liveness
and PostgreSQL-backed readiness are `/api/v1/health/live` and
`/api/v1/health/ready`.

Outreach assigns only opaque `tmp_<uuid-v4>` identifiers. They are not HIDs,
patient UUIDs, or canonical identity. A registration begins in
`identity_resolution_pending`; a separate command may append an authorized link
to an existing Identity patient. Ambiguous and unresolved cases remain pending.
The service never creates canonical patients and owns no clinical encounter,
campaign, vaccination, specimen, document, OCR, EHR, or public onboarding API.

Use the least-privilege `hid_outreach_api_runtime` database aggregate role.
User/facility authorization and patient authorization are resolved through the
Identity API on port 3001 using the shared typed client and an independent
Outreach workload credential. Development may
use an ephemeral local secret. Production rejects shared-secret mode and reads a
rotating workload JWT from `OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE`.

The browser stores pending registration commands in IndexedDB encrypted with a
non-extractable Web Crypto key. Idempotency and temporary IDs survive reloads;
the encrypted command is deleted once the server acknowledges it. The service
worker does not cache API responses.

Run `npm run start:dev`, `npm test`, `npm run typecheck`, or `npm run build` in
this directory. See the repository architecture, security, offline, database,
and interface-contract documents for authoritative platform rules.
