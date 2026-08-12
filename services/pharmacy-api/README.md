# HID Pharmacy API

Independent NestJS service owning Pharmacy acceptance, dispensing, reversal,
and imported medication-evidence APIs under `/api/v1/pharmacy/*`. Local
development uses port `3004`; liveness and PostgreSQL-backed readiness are
`/api/v1/health/live` and `/api/v1/health/ready`.

The service uses `PHARMACY_DATABASE_URL` through the least-privilege
`hid_pharmacy_api_runtime` aggregate role. It does not query or mutate EHR, Lab,
OCR, or Identity tables directly. Actor authentication and patient
authorization are resolved through the shared typed client over
`IDENTITY_API_URL` (port 3001 locally), with separate propagated-user and
Pharmacy workload credentials. EHR- and OCR-only commands also require
independent service identity. Production requires asymmetric JWT workload
identity in both directions, including a rotating Identity-audience token at
`IDENTITY_PHARMACY_WORKLOAD_TOKEN_FILE`, and rejects local-secret mode.

Acceptance binds one exact active, same-facility EHR prescription snapshot but
does not imply dispensing. Dispensing is a separate immutable event, and a
reversal appends evidence without erasing the original. Imported medication
evidence always has unknown activity status and is neither a prescription nor
proof of dispensing or administration. Inventory, refills, substitutions,
partial fills, and medication administration are outside this slice.

Run `npm run start:dev`, `npm test`, `npm run typecheck`, or `npm run build` in
this directory. See the authoritative repository architecture, security,
database, and interface-contract documents for deployment and ownership rules.
