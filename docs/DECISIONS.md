# HID Architecture Decision Records

This document records major architecture decisions.

Do not silently reverse an accepted decision.

When a decision changes:

1. create a new ADR
2. reference the previous ADR
3. explain why the change is required
4. update architecture documentation

---

# ADR-001: Identity Is the Single Source of Truth

Status: Accepted

Decision:

The Identity service is the sole canonical authority for patient identity.

EHR, Lab, Pharmacy, Outreach, and OCR must reference Identity patient IDs.

No service may maintain a competing canonical patient system.

Consequences:

* patient duplication risk is reduced
* identity resolution is centralized
* services must communicate with Identity through approved interfaces
* cross-service patient references use canonical IDs

---

# ADR-002: Modular Independently Deployable Services

Status: Accepted

Decision:

HID is composed of independently deployable service domains:

* identity
* ehr
* lab
* pharmacy
* outreach
* ocr

Each owns its domain responsibilities.

Services communicate using APIs or approved asynchronous events.

---

# ADR-003: Hybrid Frontend Architecture

Status: Accepted

Decision:

Use Next.js for public and SEO-sensitive experiences.

Use React + Vite for authenticated operational applications.

Next.js responsibilities include:

* landing
* marketing
* blog
* documentation
* public pages
* authentication
* appointment booking
* SEO content

React + Vite responsibilities include:

* EHR
* Lab
* Pharmacy
* Outreach
* Admin
* internal dashboards
* authenticated patient dashboard

Reason:

Different workloads have different rendering and SEO requirements.

---

# ADR-004: Offline-First Platform

Status: Accepted

Decision:

HID must support healthcare operations under unreliable connectivity.

Offline support is a first-class architecture requirement.

Operational applications must use queued synchronization rather than assuming continuous internet connectivity.

Detailed requirements are defined in `OFFLINE.md`.

---

# ADR-005: API Gateway / BFF Entry Point

Status: Accepted

Decision:

Public clients must access platform services through an API Gateway or approved BFF layer.

Gateway responsibilities include:

* authentication integration
* authorization integration
* routing
* rate limiting
* request validation
* API versioning
* correlation IDs
* request logging

Internal service endpoints should not become uncontrolled public integration points.

---

# ADR-006: Versioned APIs

Status: Accepted

Decision:

Current public API version:

`/api/v1`

Future API versions must coexist without unnecessarily breaking existing clients.

Backward compatibility must be considered before changing public contracts.

---

# ADR-007: Service Data Ownership

Status: Accepted

Decision:

Each service owns its own domain persistence boundary.

Examples:

Identity owns identity data.

EHR owns EHR clinical data.

Lab owns laboratory domain data.

Pharmacy owns pharmacy domain data.

EHR specifically owns prescription intent. Pharmacy owns acceptance of an
exact eligible prescription version and explicit dispensing/reversal evidence.
Imported historical medication evidence is a separate Pharmacy record class:
it is not an active prescription or dispensing. Dispensing is not medication
administration.

OCR owns OCR job and processing state when persistence is required.

Outreach owns outreach domain data.

No service may directly write another service's tables.

Important clarification:

OCR may persist OCR job metadata and processing state inside its own domain.

OCR must not directly write extracted clinical information into EHR, Lab, Pharmacy, or Identity databases.

Clinical persistence occurs through the owning service after human validation.

---

# ADR-008: NIN Is a Secondary Verified Identifier

Status: Accepted

Decision:

NIN is used for verified identity resolution and KYC.

NIN is not the primary key.

HID remains the healthcare identifier presented by the platform.

NIN verification must be provider-independent through an abstraction.

Sensitive NIN data must be protected and audited.

---

# ADR-009: Human Validation Before OCR Clinical Save

Status: Accepted

Decision:

OCR output cannot automatically become an official clinical record.

Workflow:

upload
-> OCR
-> structured extraction
-> human validation
-> patient confirmation
-> owning clinical service save

No silent patient linking.

No silent clinical write.

---

# ADR-010: AWS Target Platform

Status: Accepted

Decision:

HID is designed for eventual deployment on AWS.

Preferred compatible services include:

* ECS/Fargate
* ECR
* API Gateway
* Application Load Balancer
* RDS PostgreSQL
* S3
* CloudFront
* EventBridge
* SQS
* SNS
* Textract
* Bedrock
* CloudWatch
* IAM
* KMS
* Secrets Manager

Infrastructure abstractions should avoid unnecessary lock-in where practical.

---

# ADR-011: Event-Driven Communication Where Appropriate

Status: Accepted

Decision:

Synchronous HTTP APIs should not be used for every cross-service workflow.

Long-running or decoupled workflows may use asynchronous domain events.

Examples:

* OCRCompleted
* EncounterCreated
* LabResultAvailable
* PrescriptionIssued
* ConsentUpdated
* OutreachCompleted

Exact event contracts belong in `INTERFACE_CONTRACT.md`.

---

# ADR-012: Shared Code Without Shared Domain Ownership

Status: Accepted

Decision:

Reusable technical primitives may be extracted into packages or shared modules.

Examples:

* UI components
* SDK
* API client
* configuration helpers
* common types
* logging utilities
* validation primitives

Business ownership must remain inside the responsible service.

Do not create a shared package that becomes an uncontrolled collection of cross-domain business logic.

---

# ADR-013: Local Development Ports

Status: Accepted

Target local ports:

* Local gateway: 3000
* Identity API: 3001
* EHR API: 3002
* Lab API: 3003
* Pharmacy API: 3004
* OCR API: 3005
* Outreach API: 3006
* Web direct UI: 3100
* EHR direct UI: 3101
* Lab direct UI: 3102
* Pharmacy direct UI: 3103
* Outreach direct UI: 3104

Each independently running frontend must also receive an explicit non-conflicting port when multiple UI applications run simultaneously.

Port assignments are centralized in `scripts/ports.mjs`. Environment overrides
are allowed only when the resolved registry remains valid and conflict-free.

---

# ADR-014: Shared UI Library

Status: Accepted

Decision:

Reusable design system components should be extracted into `packages/ui`.

This package may contain:

* buttons
* forms
* tables
* modals
* layouts
* theme
* icons
* design tokens

Next.js and React/Vite applications should consume the same approved design system where practical.

---

# ADR-015: API and Mobile Readiness

Status: Accepted

Decision:

Public APIs must not assume a browser-only client.

Design interfaces so future mobile clients, including React Native applications, can consume them.

---

# ADR-016: AI Provider Abstraction

Status: Accepted

Decision:

Application business logic must not be tightly coupled to a specific AI provider.

Provider abstractions should permit supported implementations such as:

* Amazon Bedrock
* OpenAI
* Google
* other approved providers

Provider-specific logic belongs behind adapters.

---

# ADR-017: Preserve Existing Canonical Patient UUID During Migration

Status: Accepted

Decision:

Preserve the existing HID Identity patient UUID as the canonical internal patient reference during migration.

Existing HID codes remain governed patient-facing and lookup identifiers.

Do not regenerate patient identities simply because HID is being restructured or moved to AWS.

The following must never become the canonical patient primary key:

- NIN
- email
- phone number
- authentication subject
- MRN
- partner identifier
- external identifier

All patient-scoped services continue referencing the canonical Identity patient UUID.

Changing this mapping is a breaking identity decision and requires a separately approved migration.

Reason:

This preserves existing patient relationships and reduces the risk of wrong-patient attribution during migration.

# ADR-018: Authentication Identity Is Separate From Patient Identity

Status: Accepted

Decision:

Authentication accounts and patient identities are separate concepts.

Conceptual model:

OIDC issuer + subject
    ->
authenticated principal
    ->
patient, practitioner, guardian, caregiver, or other governed relationship

An authentication subject must never automatically become a patient HID.

A patient may exist without a login.

A healthcare practitioner may exist without a HID patient account.

Guardians and caregivers authenticate as themselves and receive explicit delegated access.

Reason:

Authentication credentials change over time, while the patient's healthcare identity must remain stable.

# ADR-019: Immutable Clinical and Identity History

Status: Accepted

Decision:

HID must never silently overwrite important healthcare or identity history.

Changes to governed records must use immutable versions or append-only events where appropriate.

This includes:

- patient identity corrections
- demographic corrections
- identity merges and splits
- clinical notes
- diagnoses
- encounters
- laboratory results
- prescriptions
- consent
- access grants
- break-glass events
- audit evidence

Mutations should use optimistic concurrency through expected versions or ETags where appropriate.

A stale client must not silently overwrite a newer record.

Reason:

Healthcare systems must preserve what was recorded, when it was recorded, who recorded it, and how it later changed.

# ADR-020: Atomic Domain Change, Audit, and Outbox

Status: Accepted

Decision:

When an authoritative healthcare operation requires:

- a domain state change
- semantic audit
- an integration event

those records should commit atomically whenever they share the same transactional boundary.

Preferred pattern:

Domain mutation
    ->
immutable version/event
    ->
audit event
    ->
transactional outbox event
    ->
commit

A successful clinical mutation must not silently exist without its required audit evidence.

Asynchronous integrations use transactional outbox and idempotent consumers.

Delivery is assumed to be at least once.

Reason:

This prevents failures where clinical data is committed but audit or integration evidence disappears.

# ADR-021: Controlled Single-Writer Production Migration

Status: Accepted

Decision:

The existing production HID system remains authoritative until an explicitly approved production cutover.

Uncontrolled dual-write between the current production system and the new AWS architecture is prohibited.

Production migration must account for more than PostgreSQL.

Required migration planes include:

- database
- authentication
- object/file storage
- audit
- asynchronous jobs
- uploads
- provider callbacks
- external integrations

Conceptual authority transition:

CURRENT_PRIMARY
    ->
WRITE_FREEZE OR CONTROLLED CDC
    ->
FINAL DELTA
    ->
RECONCILIATION
    ->
AWS_PRIMARY
    ->
LEGACY READ-ONLY
    ->
DECOMMISSIONED

The AWS environment does not become production authority simply because local builds, tests, or database migrations succeed.

Reason:

Running two uncontrolled authoritative systems creates unacceptable risk of divergent patient identity and medical records.

# ADR-022: FHIR Is an Interoperability Boundary, Not the Internal Database Model

Status: Accepted

Decision:

HID will support HL7 FHIR through an interoperability layer when required.

FHIR resources are external interoperability representations.

FHIR is not the primary internal persistence model for HID.

Identity, EHR, Lab, Pharmacy, Outreach, and other services may maintain strongly typed internal domain models and expose approved FHIR representations through an integration layer.

FHIR must never create a second patient identity authority.

Reason:

This allows HID to integrate with healthcare systems using standards without forcing every internal workflow and database table into a generic FHIR representation.

# ADR-023: Governed NIN Registration Cases

Status: Accepted

Decision:

Verified NIN resolution is an Identity workflow, not a generic patient insert.
The API accepts the raw NIN only in a protected request body, derives a keyed
lookup HMAC for deterministic search and idempotency, and stores the verified
value encrypted. A verified NIN already bound to an active patient produces a
non-mutating resolved case. An unmatched verified NIN creates an idempotent
registration case and may produce duplicate candidates, but never creates a
patient during resolution.

Only an explicit, permission-protected `approved_new_identity` transition may
issue a new canonical patient UUID and HID. Existing candidates may be linked
only through the explicit reviewed `linked_existing` transition. Identifier
rows are bound to the exact registration case, and review commands require
optimistic version checks plus idempotency replay protection. Domain state,
registration history, and semantic audit evidence commit in the same database
transaction.

Consequences:

* unmatched verified NINs remain pending until a steward decision;
* duplicate creation risk is reduced under retries and concurrent requests;
* NIN ciphertext and lookup metadata remain inside the Identity boundary;
* provider outages fail closed; and
* a real NIN provider and PostgreSQL migration execution are still required
  before production use.

Related ADRs: ADR-001, ADR-008, ADR-017, ADR-019, ADR-020.

# ADR-024: Outreach Temporary Registration Is Not Canonical Identity

Status: Accepted

Date: 2026-08-10

Context:

The active Outreach UI described campaigns, encounters, and synchronization but
had no active server authority or durable offline implementation. Restoring its
historical hosted tables would create an ungoverned second patient/workforce
boundary.

Decision:

The first extracted Outreach slice owns only facility-authorized temporary
field-registration cases. A browser generates a random `tmp_<uuid-v4>` plus a
stable command/idempotency key and stores the pending payload encrypted in
IndexedDB. The standalone port-3006 service records unresolved cases,
append-only evidence, semantic audit, and outbox state. It may link an exact
existing canonical patient only after Identity authorizes the user, facility,
purpose, patient, and separate Outreach workload identity. It never creates a
patient or HID. EHR no longer hosts an Outreach mutation module.

Consequences:

* offline saved state is not server synchronization or canonical registration;
* unresolved/ambiguous cases remain pending;
* the original temporary reference survives reconciliation;
* campaigns, visits, screenings/EHR ingestion, documents/OCR, NIN, and
  new-person registration require separate approved contracts; and
* production JWT delivery, non-owner login, device testing, Docker, and
  deployment remain external acceptance evidence.

Related ADRs: ADR-001, ADR-008, ADR-019, ADR-020, ADR-021, ADR-023.


# ADR-025: Identity Is a Standalone Canonical Backend

Status: Accepted

Date: 2026-08-10

Context:

Canonical patient, HID, identifier, governed NIN registration, authentication,
consent, and authorization code was embedded in the EHR NestJS deployment.
Lab, Pharmacy, and Outreach already depended on its HTTP behavior, while EHR
and OCR still imported implementation classes and the EHR aggregate retained a
combined runtime role.

Decision:

The existing implementation is extracted without semantic rewrite to
`services/identity-api` on port 3001. It is the sole active canonical patient
writer and HID issuer and hosts current authentication and consent/access
decisions. EHR, Lab, Pharmacy, Outreach, and OCR consume typed contracts from
`packages/api-client`, propagate user context, and authenticate separately as
approved workloads. Public Auth/Identity/Audit URLs remain stable through the
gateway. EHR no longer registers the old modules.

`hid_identity_api_runtime` composes Identity/authentication persistence plus
append-only audit; following OCR extraction, `hid_ehr_api_runtime` has EHR plus
audit and no Identity
mutation. The former combined role is privilege-free. Migration `0025` adds the
minimum transactional Identity outbox without changing patient UUIDs, HIDs, or
registration governance.

Consequences:

* authentication principal, canonical patient UUID, HID, secondary identifier,
  and Outreach temporary reference remain distinct concepts;
* consent stays co-located for now and may be extracted only by a later ADR;
* existing UUID/HID continuity and NIN protections are unchanged;
* no active EHR route or consumer role can create a patient or identifier;
* production issuer/JWKS, rotating tokens, non-owner LOGINs, external NIN
  provider, container execution, and deployment remain external acceptance.

Related ADRs: ADR-001, ADR-002, ADR-008, ADR-019, ADR-020, ADR-021, ADR-023, ADR-024.

# ADR Template

Use this template for future decisions:

## ADR-XXX: Title

Status: Proposed | Accepted | Superseded | Rejected

Date:

Context:

Decision:

Consequences:

Alternatives Considered:

Migration Impact:

Security Impact:

Compatibility Impact:

Related ADRs:
# Lab physical extraction checkpoint

The accepted logical Lab boundary is now physically deployed as `services/lab-api` while retaining the shared PostgreSQL cluster and historical migration ledger. This finalizes the planned incremental extraction; it does not change Lab clinical semantics or authorize a migration-ledger fork. Production service authentication remains gated on workload identity; the local ephemeral credential cannot be enabled in production.

# ADR-026: OCR API Is Physically Independent from EHR

Status: Accepted

Date: 2026-08-11

Context:

OCR job, validation, confirmation, and publication code was logically isolated
but still registered in the EHR API process and depended on EHR database access
and in-process clinical-note publication. Port 3005 and a separate service
boundary were reserved but not active. The extraction worker was already
independent and command-only.

Decision:

Move the existing OCR HTTP application boundary without product redesign to
`services/ocr-api` on port 3005. Preserve `/api/v1/ocr/*`, the existing schema
and migration ledger, lifecycle, idempotency, retries, audit, outbox, immutable
extractions, validation, patient confirmation, and publication semantics. Use
typed, workload-authenticated HTTP calls for Identity, exact EHR document
evidence, EHR clinical-note import, Lab evidence, and Pharmacy evidence. OCR
receives no direct foreign-domain SQL privileges.

Keep the OCR worker as a distinct process. Its physical location is superseded
by ADR-027. The API does not import
or supervise the worker, and health readiness excludes Textract and worker
availability. The gateway routes OCR before the EHR fallback, and EHR no
longer owns the former public OCR paths.

`hid_ocr_api_runtime` composes OCR persistence plus append-only audit.
`hid_ehr_api_runtime` loses OCR membership. `hid_ocr_worker` remains limited to
lease/token-bound security-definer commands.

Consequences:

* there is one active OCR API writer and one separately runnable worker;
* the EHR frontend remains the OCR review UI without owning OCR backend code;
* no migration is added because the existing persistence contract is sound;
* environment-specific login provisioning, live workload issuer/JWKS/token
  mounts, Docker execution, AWS/IAM/KMS/Textract, and deployed routing remain
  external acceptance evidence.

Related ADRs: ADR-001, ADR-003, ADR-006, ADR-009, ADR-010, ADR-013, ADR-025.

# ADR-027: Backend Runtime Layout Converges Under Services

Status: Accepted

Date: 2026-08-11

Context:

The independently runnable Identity, Lab, Pharmacy, OCR, and Outreach APIs
were physically located under `services/`, while the EHR API remained under
the frontend-owned `ehr/server` path. The already independent OCR worker was
nested inside that EHR package. This obscured deployment ownership, allowed
duplicate package scripts, and made root orchestration depend on a transitional
frontend/backend split.

Decision:

Move the unchanged EHR HTTP runtime to `services/ehr-api` and the unchanged
non-HTTP worker to `services/ocr-worker`. Preserve ports, public routes,
runtime roles, workload subjects, lease/claim semantics, and the one ordered
`0001`-`0025` migration history. EHR and worker packages build, test, and start
independently; neither imports the other's implementation.

The platform migration runner, runtime-grant SQL, and schema/RLS tests remain
temporarily co-located under `services/ehr-api/database` and
`services/ehr-api/scripts`. This is platform-owned tooling, not EHR ownership.
Moving it to a neutral package is deferred because combining that dependency
and credential change with runtime relocation would add migration risk. The
ledger must never be split by service.

Consequences:

* all active backend runtimes have one physical home under `services/`;
* `ehr/` is frontend/reference only and `ehr/server` is retired;
* there is exactly one OCR worker package and production command;
* package, launcher, graph, documentation, and container paths use the new
  owners without compatibility shims; and
* external image/runtime, workload issuer, non-owner LOGIN, PostgreSQL TLS,
  and AWS acceptance remain separate deployment evidence.

Related ADRs: ADR-003, ADR-006, ADR-009, ADR-010, ADR-013, ADR-025, ADR-026.

# ADR-028: Neutral At-Least-Once Event Delivery and Durable Consumer Inbox

Status: Accepted

Date: 2026-08-11

Context:

Identity, OCR, Lab, Pharmacy, and Outreach already committed domain-owned
transactional outbox rows, but no shared dispatcher or active asynchronous
consumer existed. EHR had no outbox producer. Updating each domain outbox from
a shared runtime would couple transport state to domain ownership, and treating
transport acceptance as exactly-once processing would leave unavoidable crash
windows undefined.

Decision:

Add neutral `integration` delivery state and an independently runnable
`services/event-dispatcher`. Domain outbox rows remain immutable; a normalized
security-invoker view exposes registered envelope-v1 fields. Lease-bound
security-definer commands use `FOR UPDATE SKIP LOCKED`, unique claim tokens,
bounded attempts, safe error evidence, and separate attempt history. The
production transport is EventBridge, with one SDK attempt and per-entry result
handling; a deterministic adapter is explicit and non-production only.

Delivery is at least once. A successful transport call followed by failure to
mark delivered causes the same stable event ID to be redelivered after lease
expiry. “Delivered” means transport accepted, not consumer processed.

Add a reusable inbox keyed by `(consumer_name,event_id)`. Administrator-owned
consumer/database-role bindings prevent namespace spoofing. A future consumer
must apply its business effect and complete its inbox marker in one database
transaction. No consumer or product effect is invented by this decision.

Consequences:

* additive migration `0026` creates neutral delivery/inbox persistence and
  corrects the obsolete Lab outbox aggregate foreign key without rewriting
  migrations `0001`-`0025`;
* the dispatcher runtime has command-only database and exact-bus IAM access,
  no domain mutation authority, and no owning-service imports;
* event contract/payload violations and exhausted retries become terminal
  evidence rather than silent drops;
* duplicate delivery is expected, ordering across producers is not promised,
  and consumer idempotency is mandatory; and
* EventBridge, container, non-owner LOGIN, PostgreSQL TLS, and real-consumer
  execution remain deployment/product acceptance evidence.

Related ADRs: ADR-002, ADR-007, ADR-010, ADR-011, ADR-019, ADR-020, ADR-027.

# ADR-029: Identity-Owned Capability Administration Without an Admin BFF

Status: Accepted

Date: 2026-08-11

Context:

HID needed a dedicated platform-administration application for facilities,
principals, explicit platform roles, Identity review, immutable audit, and
safe operations visibility. The retained Supabase-era dashboard was not an
active authority. Creating either a browser database client, an unrestricted
platform database role, or a new service with cross-domain SQL would duplicate
Identity authority and weaken service ownership. The first operations view
requires bounded aggregation but no independent persistence or deployment.

Decision:

Host the browser at `apps/admin` and route `/api/v1/admin/*` to the existing
Identity API. Identity remains the human authentication, principal, facility,
membership, session, platform-role, and audit authority. Platform roles map to
separate `platform.*` capabilities and never imply clinical or break-glass
permissions. Sensitive commands are domain-specific, reasoned, audited,
idempotent, versioned where applicable, and repeated as security-definer
database capability checks.

Do not create an Admin BFF for this foundation. Identity contains a narrow
read-only operations aggregator that concurrently calls configured service
status endpoints with a bounded timeout and purpose-specific safe response
shaping. The Admin browser never calls internal hosts. Domain-specific future
operations or mutations remain owned by their services and may justify a BFF
only when real multi-service orchestration exists.

Consequences:

* `apps/admin` has no database credentials, driver, or hosted-backend SDK;
* Super Admin is neither clinical authority nor break-glass and receives no
  validation, result, dispensing, Outreach, or clinical-record bypass;
* no new runtime database login or BYPASSRLS role exists;
* additive migration `0027` extends existing `auth` and `identity` ownership,
  preserves append-only audit, and adds PHI-minimal dispatcher failure reads;
* the one-time first-admin bootstrap is explicit, serialized, audited, and
  refuses repetition; and
* a future Admin BFF remains an architecture decision, not a default proxy.

Related ADRs: ADR-001, ADR-002, ADR-003, ADR-007, ADR-010, ADR-025, ADR-027,
ADR-028.

# ADR-030: Canonical Browser Application Placement and Scoped Offline Ownership

Status: Accepted

Date: 2026-08-11

Decision:

Use `apps/web`, `apps/ehr`, `apps/lab`, `apps/outreach`, and `apps/admin` as
the active browser application locations. Keep `apps/web` as the local
one-origin gateway. Extract the real Lab workflow to `apps/lab`; extract the
real encrypted field-registration workflow to `apps/outreach`; do not create
`apps/pharmacy` until an operational, authorised dispensing workflow exists.

Web, Lab, and Outreach use the same Identity-owned browser cookie/CSRF session
client. Outreach's encrypted IndexedDB store retains its existing origin,
database name, key record, idempotency model, and explicit destructive
sign-out. Outreach receives a more-specific `/outreach/` service-worker scope
which never caches API responses.

Consequences:

* browser applications remain API-only and do not gain database or internal
  service credentials;
* EHR opens Lab at `/lab/` instead of presenting a second operational Lab
  route;
* Pharmacy remains visibly gated rather than falsely appearing deployable; and
* external authenticated route verification is a deployment/environment gate,
  not a reason to weaken local source and build checks.

Related ADRs: ADR-003, ADR-006, ADR-010, ADR-019, ADR-020, ADR-029.

# ADR-031: Seven Browser Applications with Governed Offline and Telemetry Boundaries

Status: Accepted

Date: 2026-08-11

Decision:

The canonical browser platform consists of `apps/web`, `apps/ehr`, `apps/lab`,
`apps/pharmacy`, `apps/ocr`, `apps/outreach`, and `apps/admin`, routed through
one origin at `/`, `/ehr/`, `/lab/`, `/pharmacy/`, `/ocr/`, `/outreach/`, and
`/admin/`. ADR-030's temporary decision not to create Pharmacy is superseded:
the existing Pharmacy API now supports a real authenticated acceptance,
dispensing/reversal, medication-evidence, patient lookup, and activity workspace.
OCR receives a separate operations workspace without displacing contextual
clinical OCR review in EHR.

Every app consumes `packages/offline` and `packages/telemetry`. Offline awareness
does not confer offline mutation authority. Workers cache only scoped static
shell/assets and exclude `/api/`. Outreach retains the only governed persisted
offline command outbox in this checkpoint; Pharmacy, OCR, Lab, and Admin fail
safely rather than inventing offline completion semantics.

Sentry is the technical error/performance channel and PostHog is allowlisted
product analytics. Both are initialized by one shared policy. Clinical,
identity, OCR, Lab, medication, document, token/cookie/header/body, and URL data
are prohibited. Session replay, automatic capture, pageview capture, and durable
analytics persistence are disabled across all seven applications. Telemetry
failure cannot block a healthcare workflow.

Consequences:

* `prescribed`, `accepted`, `dispensed`, and `administered` remain distinct;
* Pharmacy and OCR browser commands require their owning APIs and authoritative
  server acknowledgement;
* all apps are installable/scoped PWAs where supported, but no worker is a PHI
  API cache;
* temporary offline ownership cannot silently expand through a shared package;
* EHR exact-reference mode carries a dedicated bundled platform runtime for
  connectivity, scoped PWA registration, and shared telemetry; and
* authenticated deployment, live telemetry destination observation,
  representative-device, Docker, and AWS evidence remain separate acceptance.

Related ADRs: ADR-003, ADR-004, ADR-005, ADR-007, ADR-019, ADR-020, ADR-024,
ADR-029, ADR-030.

# ADR-032: CDK Foundation with One Gateway Origin and Separate Edge Stack

Status: Superseded by ADR-033

Date: 2026-08-11

Context:

All active runtimes and the seven-app production Gateway had locally accepted
packaging and host/database behavior, but the repository had no active IaC,
release digest contract, AWS network, runtime roles, data resources, edge
policy, or controlled ECS migration job. Adding API Gateway in front of
CloudFront, ALB, and the existing HID Gateway would duplicate routing and
request handling without an implemented partner/mobile protocol requirement.
AWS account, region, domain, certificates, workload issuer, image digests, and
Secrets Manager resources are externally governed inputs and cannot be guessed.

Decision:

Use AWS CDK v2 with strict TypeScript under `infra/aws`. Synthesize one regional
stack for VPC/ECR/ECS/RDS/S3/KMS/EventBridge/CloudWatch and a separate
`us-east-1` edge stack for CloudFront/WAF/Route 53. CloudFront has one origin:
a prefix-list-restricted public ALB whose only target is the existing Gateway.
Gateway remains the static owner of all seven browser roots and the browser API
router. A private HTTPS ALB provides trusted server-to-server hostnames; tasks
remain private and use no public IP.

Keep Identity, EHR, Lab, Pharmacy, OCR API, OCR Worker, Outreach, Dispatcher,
and Gateway as nine separate ECS services with separate task/execution roles,
logs, health contracts, scaling and digest inputs. Use the EHR Dockerfile's
separate migration target as a tenth one-shot task definition, never a service.
All service desired-count parameters default to zero so data/network/task
definitions can be established and migrations plus external prerequisites can
pass before runtime rollout.

Use one private encrypted RDS PostgreSQL 16 major family, eight unique non-owner
runtime LOGIN secret interfaces, a separate migration administrator, and the
unchanged `0001`-`0027` ledger. Use one private versioned document bucket and
customer-managed document key. Only EHR and OCR Worker receive exact document
permissions; only Worker receives the three implemented Textract actions; only
Dispatcher receives exact-bus `PutEvents`. Create no EventBridge rule, consumer,
queue, SNS topic, Lambda, API Gateway, Bedrock resource, or NIN provider without
an implemented workflow.

Require release-manifest digest-qualified images, SBOM/scan evidence, external
HTTPS workload issuer/JWKS/subjects, rotating mounted token delivery, ACM/DNS,
RDS CA, and Secrets Manager values. IaC describes these interfaces but never
embeds fake values or calls an AWS account during local synth.

Consequences:

* architecture, IAM, release, cost and deployment policies are executable and
  covered by 35 CDK assertions plus an offline template security verifier;
* API Gateway remains a future decision if a real consumer requires its
  distinct capability; it is not a default extra proxy;
* interface endpoints and a second internal ALB add fixed cost in exchange for
  private AWS access and production-compatible HTTPS service clients;
* task-local token volumes are not a delivery implementation, so desired counts
  must remain zero until staging proves an approved issuer/delivery mechanism;
* no Docker image, ECR digest, AWS resource, live IAM allow/deny, database,
  certificate, domain, provider, or deployment success is claimed locally; and
* Docker-host release evidence and authorized AWS/account setup remain the next
  external gates.

Related ADRs: ADR-002, ADR-005, ADR-007, ADR-010, ADR-021, ADR-025, ADR-026,
ADR-027, ADR-028, ADR-029, ADR-031.

# ADR-033: Cloudflare Frontend Edge, Notification Boundary, and Legacy Migration Convergence

Status: Accepted

Date: 2026-08-12

Supersedes: ADR-032's CloudFront edge, single static Gateway publication, and
no-notification-consumer assumptions. ADR-032 remains historical evidence for
the regional AWS foundation it introduced.

Context:

The approved production model assigns Cloudflare DNS/TLS and independently
deployable frontend hosting to all seven browser apps while AWS remains the
durable backend. HID 1.0 is live and its hosted/Supabase implementation must be
migrated without becoming a permanent runtime dependency. Authentication codes
are credentials and must not enter ordinary third-party notification history.

Decision:

Use seven Cloudflare Workers Static Assets deployments with exact custom
hostnames and one originless apex redirect. Each app serves its own root-scoped
artifact and proxies only relative `/api/v1/*` to the fixed
`api.healthidentitydirectory.com` origin. Use host-only cookies and shared
client/server Turnstile. CloudFront and AWS static frontend hosting are removed;
Gateway remains API-only behind a regional WAF/ALB protected by a Cloudflare-
held origin secret.

Identity remains the only human authentication and patient authority. Allow
local imported password hashes with proven bcrypt compatibility and atomic
Argon2id upgrade, or OIDC. Remove direct legacy HTTP password/identity proxies.
Repository evidence is insufficient to validate the real HID 1.0 session trust
model, so seamless session exchange is rejected until separately proven. Use a
purpose-bound six-digit contact OTP fallback mapped to the existing patient.

Split notifications deliberately:

- authentication OTP: Identity -> workload-authenticated Notification API ->
  SES/Termii/Meta primary with Infobip fallback; never Novu or durable plaintext;
- ordinary events: owner outbox -> Event Dispatcher -> EventBridge -> encrypted
  SQS/DLQ -> Notification Worker -> Novu, with FCM as the server-side push
  boundary.

Create additive migration `0028` because OTP state, progressive assurance,
complete legacy identity-link evidence, encrypted device registration, and
delivery reconciliation do not exist in `0001`–`0027`. Preserve all earlier
migrations unchanged. Supabase is a read-only migration source; Vercel and
Brevo are retired.

Consequences:

- frontend releases, hostnames, service-worker scopes, and permissions remain
  independently testable;
- Cloudflare/AWS/provider/DNS credentials and live behavior remain external
  acceptance, never inferred from local tests;
- unknown OTP provider outcomes cannot trigger blind fallback duplicates;
- progressive KYC cannot hide migrated records or create duplicate patients;
- migration uses a controlled single-writer cutover with offline fixtures,
  source/destination IDs, checksums, conflict evidence, and reconciliation; and
- AWS now contains eleven service images, twelve digest inputs including the
  migration task, the encrypted ordinary-notification queue/DLQ and rule, and
  no CloudFront resource.

Related ADRs: ADR-001, ADR-002, ADR-003, ADR-005, ADR-007, ADR-021, ADR-025,
ADR-026, ADR-029, ADR-031, ADR-032.
