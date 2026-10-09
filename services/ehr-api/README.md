# HID EHR API

Independent NestJS boundary for HID clinical events and documents on port
`3002`. The authoritative Identity API runs separately on port `3001`, and the
OCR API runs from `services/ocr-api` on port `3005`. EHR
does not own or create patient identity: every clinical `patient_id` is the
canonical UUID from Identity, and PostgreSQL foreign keys use `ON DELETE
RESTRICT`.

This directory is the active EHR API implementation used by the
maintained React/Vite EHR client. Dormant Auth, Identity, Consent, and audit-read
compatibility source remains for historical transition tests, but those modules
are not registered in the active EHR application and expose no routes.

## Implemented boundaries

- `authorization adapter`: resolves the actor and patient decision through the
  shared typed Identity client. Propagated user credentials remain separate
  from the EHR workload credential; facility, purpose, correlation, CSRF, and
  Origin context survive the service boundary.
- `ehr`: encounters, clinical notes with immutable revisions, vitals with immutable corrections, diagnoses, prescriptions, and lab requests.
- `documents`: presigned private uploads, S3 version/checksum verification, immutable malware-scan events, and clean-version-only downloads.
- `audit writes`: EHR mutations append semantic evidence; Identity owns the
  `/api/v1/audit/*` read boundary.
- `OCR integration`: narrow workload-authenticated routes return exact governed
  source-document evidence and accept idempotent imported clinical notes. EHR
  hosts no `/api/v1/ocr/*` controller and has no OCR persistence membership.
- Lab, Pharmacy, and Outreach backend operations are extracted to
  `services/lab-api`, `services/pharmacy-api`, and `services/outreach-api`.
  This API retains EHR-owned lab-request and
  prescription intent plus typed handoff clients; it hosts no Lab or Pharmacy
  mutation implementation and cannot write their tables. Identity remains the
  canonical authority and independently authorizes consumers.

All HTTP routes are under `/api/v1`. Clinical routes require:

```text
X-Facility-ID: <active facility UUID>
X-Purpose-Of-Use: direct-care
Idempotency-Key: <16..128 safe characters>  # every create
X-CSRF-Token: <session CSRF token>          # cookie-authenticated mutations
```

JSON request bodies are strictly parsed and capped at 512 KiB. Oversized,
malformed, and unsupported payloads fail through the RFC 7807 problem-details
boundary without echoing submitted clinical content.

Optimistic updates require `expectedRowVersion` and a non-trivial `changeReason`. Cross-facility identifiers are never sufficient to resolve a record: application predicates, RLS, membership checks, consent, and composite foreign keys all enforce the same boundary.

## Local verification

Use Node.js 22 or newer and provide a development configuration based on
`.env.example`. Root `npm run dev` loads root `.env.local` as a fallback and
then the more specific `services/ehr-api/.env.local` only for this API child;
already-exported environment variables retain highest precedence. Server
secrets are not inherited by the browser application processes. The API
application itself intentionally does not load `.env` files in production.

```bash
npm ci
npm run lint
npm test
npm run build
```

`STORAGE_MODE=disabled` is permitted only outside production. It keeps clinical development independent of object storage; document endpoints fail closed.

The OCR worker is a separate package, process, and database identity under
`services/ocr-worker`; it is not built or started by this package.

## Database deployment

The `database/` and `scripts/` directories are platform-owned migration,
runtime-grant, and schema-verification tooling, not EHR runtime ownership. They
remain co-located here temporarily to preserve the proven runner dependency
and the one immutable migration ledger during this layout-only cutover. Do not
split the ledger or infer that EHR owns other service schemas.

Run schema changes with the migrator credential, never an application credential:

```bash
npm run db:plan
npm run db:dry-run
npm run db:migrate
```

Outside production, the migration runner applies the same local env-file
precedence as root development startup. Production migration execution requires
explicitly injected process environment and never loads local env files.

The runner takes a PostgreSQL advisory lock, applies ordered migrations transactionally, and refuses a changed checksum for any applied migration. In production set `DATABASE_SSL=true` and `DATABASE_SSL_ROOT_CERT_BASE64` to the approved RDS CA bundle. The security administrator applies the reviewed role model with an explicit administrator credential:

```bash
export DATABASE_ADMIN_URL="$DATABASE_URL"
npm run db:bootstrap
npm run db:verify-roles
```

Use this assignment only when the loaded `DATABASE_URL` is the approved
migration/security-administrator credential. The bootstrap never falls back to
the runtime application URL and never loads `DATABASE_ADMIN_URL` from a local
env file. Inject the administrator URL only into the provisioning process.

Runtime role separation is mandatory:

- Identity `DATABASE_URL`: environment-specific login inheriting only
  `hid_identity_api_runtime`;
- EHR `DATABASE_URL`: environment-specific login inheriting only
  `hid_ehr_api_runtime`;
- OCR API `OCR_DATABASE_URL`: separate login inheriting only
  `hid_ocr_api_runtime`;
- `WORKLOAD_DATABASE_URL`: different login inheriting only `hid_document_scanner`;
- `OCR_WORKER_DATABASE_URL`: different login inheriting only `hid_ocr_worker`;
- extracted Lab login: only `hid_lab_api_runtime`;
- extracted Pharmacy login: only `hid_pharmacy_api_runtime`;
- migration credentials: unavailable to the running service.

`hid_identity_api_runtime` composes only Identity/authentication persistence and
append-only audit. `hid_ehr_api_runtime` composes only EHR persistence and
append-only audit, with no OCR or Identity mutation membership.
`hid_ocr_api_runtime` separately composes OCR persistence and append-only audit.
The retired
`hid_api_runtime` compatibility role is privilege-free and must not be assigned
to an active service login.

The scanner pool is deliberately separate and smaller. Production configuration also requires its trusted issuer, audience, and JWKS URL. The callback token is verified and mapped to an active database `document_scanner` role before the security-definer append command runs.

The ordered chain currently ends at `0025`. In addition to the core clinical
schema, it supplies the least-privilege password-upgrade command, preserves
legacy account suspension windows, prevents purpose-unmapped legacy consent
from authorizing access, and binds scan evidence to one exact object version and
SHA-256. Migration `0010` adds database-authorized consent commands, restricted
emergency grants, staff-owned grant closure, and facility-scoped audit reads.
Migration `0011` adds keyed encrypted NIN bindings, duplicate candidates,
append-only registration-case events, review idempotency, and the explicit
approved-new-identity/link-existing transitions. Migration `0012` narrows
break-glass to an exact, reasoned emergency `read_records` authorization and
leaves normal consent directive-aware. The last host migration ledger evidence
reports zero pending migrations through `0025`; the full rollback-only schema
and RLS suite passes locally. Migration `0025` adds the forced-RLS Identity
transactional outbox without changing UUID, HID, NIN, consent, or registration
semantics. Production application remains a separate governed action.
Applied migration files are immutable: amend the design with a new
ordered migration rather than editing a checksum-recorded file.

Migration `0009` never invents object provenance for historical scan events.
Any preexisting event without an immutable version/checksum pair is retained
under an explicit binding migration hold and is excluded from download
eligibility until a separately governed remediation is completed.

## Object-store prerequisites

Production uses a private, versioned S3 bucket and a customer-managed KMS key. Before enabling traffic, verify:

- Block Public Access is enabled and bucket policies deny non-TLS traffic;
- versioning is enabled (readiness fails otherwise);
- the API can put/head/get only the configured bucket prefix and exact KMS key;
- scanner access is isolated from normal API credentials;
- browser CORS permits only the EHR origin, `PUT`, and the exact signed headers;
- retention, legal hold, backup, lifecycle, malware quarantine, and deletion procedures are approved.

The API signs content type, SHA-256 checksum, declared-checksum metadata, and server-side encryption headers. Upload completion checks size, checksum, media type, version ID, checksum provenance, and encryption. A document becomes downloadable only when the latest immutable terminal scan event is `clean`; the original S3 version is always included in the signed download.

## Controlled identity transition

The active EHR process calls `IDENTITY_API_URL` through the shared typed client;
it does not select a local or hosted Identity provider. The Identity service
alone owns any approved legacy bridge during a bounded migration. Identifiers
remain in protected POST bodies, dependency failures deny access, and the UI
never receives bridge or workload credentials.

Promotion preserves legacy hosted identity `banned_until` as `auth.accounts.disabled_until`.
Legacy access requests and grants without an approved purpose are retained with
explicit migration holds and cannot satisfy runtime authorization. Operators
must not infer a purpose or bulk-clear those holds to accelerate cutover.

The governing data-migration procedure is [MIGRATION_RUNBOOK.md](../../docs/MIGRATION_RUNBOOK.md). It explicitly forbids destructive down migrations, inferred patient/facility attribution, same-key content overwrites, and cutover from a stale snapshot.

## Production gates

Passing unit tests is necessary but not a production authorization. Release requires representative PostgreSQL migration/RLS integration tests, S3/KMS and scanner integration tests, authentication rotation/revocation tests, audit-outage fail-closed tests, load/failover/restore evidence, and final legacy hosted identity-to-PostgreSQL reconciliation with zero unresolved conflicts.

`GET /api/v1/health/live` reports process liveness. `GET /api/v1/health/ready` checks the normal database pool, isolated scanner pool when configured, and S3 readiness. Neither endpoint exposes patient or configuration data.
