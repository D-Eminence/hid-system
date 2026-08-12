# HID Technical Roadmap

## Current Cloudflare/notification/migration convergence milestone

The repository now contains seven independent Cloudflare Workers Static Assets
definitions, the fixed same-origin AWS API proxy, client/server Turnstile,
host-only session enforcement, Notification API/Worker boundaries, direct
six-digit OTP delivery, ordinary Novu/FCM orchestration, additive migration
state, offline migration fixtures, and regional AWS notification IaC.
CloudFront, active Vercel targeting, Brevo, magic authentication links, and
canonical Supabase runtime paths have been removed. Local verification is the
current gate; live Cloudflare/AWS/provider/NIN configuration, rehearsed HID 1.0
migration, representative-device acceptance, and production cutover remain the
next externally governed milestone.

## Current frontend convergence milestone

The intended seven-application browser platform is implemented under `apps/*`:
Web, EHR, Lab, Pharmacy, OCR Operations, Outreach, and Admin. Pharmacy and OCR
are real API-backed workspaces, all apps consume shared offline/telemetry policy,
and the one-origin gateway, direct refresh, production builds, desktop browser
rendering, and scoped offline shells pass locally. Outreach remains the only
persisted offline mutation workflow. The exact next platform stage is full
container acceptance; authenticated deployment, live telemetry destinations,
and representative-device offline evidence remain external tracks.

## Phase 0: Foundation and Architecture Stabilization

Goals:

* preserve working production behavior
* inspect current repository
* inspect upstream snapshot
* standardize architecture documentation
* remove verified dead code
* remove verified duplication
* establish service ownership
* fix conflicting development ports
* fix framework warnings
* establish Docker development environment

Repository checkpoint:

The active boundary scan is complete for the current checkpoint. Local ports
and the NestJS wildcard are stabilized, browser PHI/facility persistence has
been reduced, and `packages/api-client/` is consumed by the EHR and Identity
clients for transport-only HTTP behavior. Docker infrastructure and production
deployment remain externally gated. Lab, Pharmacy, and the minimum Outreach
registration API are independently runnable bounded services. The authoritative
Identity backend is now physically extracted to `services/identity-api` on
port 3001, and EHR and OCR consume it through typed workload-authenticated
boundary. Production deployment evidence remains external.

## Phase 1: OCR Foundation

Search repository for existing:

* OCR
* scanning
* uploads
* parsing
* extraction

Build/refactor OCR service.

Implement:

* document registration
* secure storage
* Textract adapter
* Bedrock adapter
* provider abstraction
* structured extraction
* confidence scores
* human validation
* audit
* identity matching integration

Repository checkpoint:

The provider-neutral contract, Textract worker, and durable PostgreSQL
foundation are implemented and locally accepted. Migrations `0013` through
`0016` provide idempotent,
facility-scoped jobs, concurrency-safe worker claims, bounded retry, immutable
extraction and human-validation evidence, audit integration, and a
transactional outbox, exact-object leases, human validation, canonical patient
confirmation, and durable publication. Document-only and EHR imported-note
publication are implemented. Bedrock, queue delivery, worker deployment, and
broader identity-match candidates
remain later Phase 1 slices.

The governed EHR review UI is now implemented in the encounter workspace. It
keeps source extraction immutable, records explicit field dispositions and
corrections, requires canonical-patient confirmation, and separates validation
from publication. Governed Lab and historical-medication publication now cross
their owning services; neither creates native execution/dispensing truth.

The OCR HTTP boundary is now physically extracted to `services/ocr-api` on
port 3005. Gateway ownership, typed Identity/EHR/Lab/Pharmacy calls, an
OCR-plus-audit aggregate role, EHR route retirement, static Docker image, and
independent health/readiness are implemented without changing OCR behavior.
The worker remains separately runnable and is not an API readiness dependency.

## Phase 2: NIN Identity Integration

Implement:

* patient identifier registry
* NIN provider abstraction
* verified NIN uniqueness
* HID/NIN resolution
* protected NIN storage
* audited NIN use
* idempotent registration cases and duplicate candidates
* explicit reviewed linking to an existing canonical patient
* explicit approved-new-identity issuance for a confirmed new person

Repository checkpoint:

The provider abstraction, fail-closed unavailable adapter, test-only
deterministic adapter, protected identifier handling, migrations `0011` and
`0012`, and registration-case API are implemented and locally unit/build
verified. The extracted Identity process, PostgreSQL migration/RLS execution,
runtime roles, integration tests, typed consumers, and gateway cutover pass
locally. Phase 2 production acceptance still requires a real NIN provider,
production workload issuer/token mounts, non-owner LOGINs, deployment, and
operational assurance.

## Phase 3: Laboratory Separation

Repository checkpoint: the Lab backend is physically extracted to `services/lab-api`, runs independently on port 3003, owns Lab controllers/services/tests and its database runtime boundary, and is reached by EHR/OCR through the shared typed client. Gateway routing preserves `/api/v1/lab/*`; EHR no longer hosts Lab mutation controllers. The Lab frontend remains transitional inside the EHR application. Production workload identity and environment-specific Lab login provisioning remain deployment prerequisites.

Repository checkpoint: the first Lab-owned persistence and API slice is
implemented for imported external evidence, including facility RLS,
idempotency, immutable observations, exact OCR provenance, semantic audit,
outbox evidence, and a dedicated runtime role. Governed OCR LAB publication
now routes through the Lab service boundary. Native order acceptance,
accessioning, specimen, execution, QC, verification, amendments, critical
results, and physical service/UI extraction remain Phase 3 work.

Extract Lab domain logic from EHR.

Create:

* Lab API
* Lab application boundary
* EHR-to-Lab interface
* Lab result events

Maintain EHR integration.

## Phase 4: Pharmacy Separation

Repository checkpoint: the Pharmacy backend is physically extracted to
`services/pharmacy-api`, runs independently on port 3004, owns forced-RLS
acceptance/dispensing/reversal/import persistence, and is reached by EHR/OCR
through the shared typed client. EHR retains prescription intent and no longer
registers a Pharmacy backend module. The gateway preserves
`/api/v1/pharmacy/*`. Migration `0023`, least-privilege roles, schema/RLS tests,
service tests/build, and live/readiness checks pass locally. Production
workload issuer/JWKS/token delivery, environment-specific non-owner Pharmacy
login, Docker build, and deployment remain external prerequisites.

The implemented slice deliberately excludes partial fills, refills,
substitution, inventory/stock, controlled-drug handling, payment/claims, and
medication administration. OCR creates only imported medication evidence with
unknown activity, never Pharmacy work or dispensing.

Extract Pharmacy domain logic from EHR.

Create:

* Pharmacy API
* Pharmacy application boundary
* EHR-to-Pharmacy interface

Maintain EHR integration.

The next boundary stage must not expand Outreach from historical UI labels.
Campaigns, visits, screenings, documents/OCR, and EHR ingestion remain separate
product/governance decisions.

## Phase 5: EHR Integration

Repository checkpoint: platform integration is accepted locally across the
one-origin gateway and the independently runnable Identity, EHR, Lab, Pharmacy,
OCR, and Outreach APIs. Route ownership, database mutation ownership, runtime-role
separation, user/workload credential separation, cookie CSRF/Origin
propagation, bounded retry, health/readiness, failure injection, typecheck,
tests, and production builds pass. The detailed evidence and external gaps are
in `PLATFORM_INTEGRATION_ACCEPTANCE.md`.

Repository layout convergence places the EHR API at `services/ehr-api` and the
independent non-HTTP worker at `services/ocr-worker`; root orchestration and
verification no longer depend on `ehr/server`.

Repository checkpoint: the neutral transactional event delivery foundation is
implemented in `services/event-dispatcher` and migration `0026`. It inventories
five active producer outboxes (EHR has none), preserves immutable stable IDs,
uses exclusive expiring leases and bounded attempts, validates a PHI-minimal
envelope v1, supports deterministic non-production and EventBridge transports,
and provides a role-bound durable inbox keyed per consumer/event. No product
consumer or business effect was invented.

Repository-side dispatcher deployment acceptance now covers its static image
contract, representative non-owner LOGIN, verified PostgreSQL TLS behavior,
host health/metrics/SIGTERM, and two-instance claims. Docker/image scanning and
live EventBridge/IAM/RDS/ECS/ECR/CloudWatch evidence remain external. Real
consumer integration starts only after an approved consumer/effect exists. The
governed HID Super Admin foundation is now implemented in `apps/admin/` with
Identity-owned backend APIs and no direct database access. Explicit platform
capabilities, one-time bootstrap, facility/principal/session/role commands,
masked Identity review, immutable audit, and bounded service/event operations
are locally verified without clinical or break-glass authority. Additive
migration `0027`, runtime-role/RLS assertions, frontend/backend tests, and
production builds pass. Frontend layout convergence is the next local
application milestone.
Production workload issuer/JWKS and rotating tokens, AWS OCR/storage, a real
NIN provider, and representative-device Outreach evidence remain independent
external acceptance tracks.

Ensure EHR uses:

* Identity API
* Lab API
* Pharmacy API
* OCR API

Remove direct frontend database access.

Remove embedded duplicate domain logic.

## Phase 6: Offline-First Platform

Repository checkpoint: the first real offline slice is implemented for Outreach
temporary registration. Encrypted IndexedDB commands survive reload with stable
temporary and idempotency IDs, sync independently, distinguish retryable from
terminal failure, delete acknowledged PHI payloads, and never claim canonical
registration. Migration `0024`, the standalone port-3006 API, Identity workload
authorization, least-privilege roles/RLS, typed client, and gateway cutover pass
locally. Real-device/browser lifecycle, production workload token delivery,
non-owner login, Docker build, and deployment remain external evidence.

Implement:

* PWA
* secure IndexedDB
* command queue
* background sync
* retry
* idempotency
* conflict handling
* resumable upload
* audit synchronization

Prioritize:

* EHR
* Outreach
* Lab
* Pharmacy

## Phase 7: AWS Infrastructure

Prepare deployment with:

* ECR
* ECS/Fargate
* load balancing
* RDS PostgreSQL
* S3
* EventBridge
* SQS
* Textract
* CloudWatch
* IAM
* KMS
* Secrets Manager
* Cloudflare Workers Static Assets, DNS, TLS, WAF, and apex redirect

Current checkpoint (2026-08-12): the CDK v2 regional foundation, Cloudflare
frontend definitions, twelve-component immutable release-manifest contract,
offline synth policy verification, deployment architecture, IAM matrix, cost
model, and runbook are implemented. The design has eleven ECS services, one
controlled migration task, an API-only Gateway, private RDS/S3/EventBridge, an
encrypted ordinary-notification SQS/DLQ, and no CloudFront. No AWS, Cloudflare,
DNS, provider, or production resource was configured or mutated. Release
image/digest/SBOM/scan evidence, account bootstrap, DNS/ACM, deployment,
production LOGIN/RDS TLS, workload JWT delivery, migration, provider and
representative-device acceptance remain externally pending.

## Phase 8: Interoperability

Introduce formal interoperability adapters.

Prepare for:

* HL7 FHIR
* external healthcare systems
* approved government integrations
* third-party integrations

## Future Modules

Architecture must allow:

* Billing
* Claims
* Radiology
* Immunization
* Telemedicine
* Inventory
* Scheduling
* Notifications
* Analytics
* Public Health Reporting

## Current Lab checkpoint

Exact order acceptance, one-work-item accessioning, specimen requirements,
server-issued specimen identifiers, collection/receipt/rejection custody,
execution start/completion, and immutable manual result revisions are
implemented through migrations `0019` and `0020`. Independent verification,
separate release, immutable released history, and post-release unverified
revisions are implemented through migrations `0021` and `0022`. Broader Lab
scope such as analyzers, QC, critical-result communication, richer catalog
mapping, recollection, and dedicated UI deployment remains separate.
