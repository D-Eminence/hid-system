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
`apps/pharmacy`, `apps/ocr`, `apps/outreach`, and `apps/admin`. Its local
one-origin developer gateway uses `/`, `/ehr/`, `/lab/`, `/pharmacy/`,
`/migrate/`, `/outreach/`, and `/admin/`; production serves the `apps/ocr`
Migrate application at the root of `migrate.healthidentitydirectory.com`.
ADR-030's temporary decision not to create Pharmacy is superseded:
the existing Pharmacy API now supports a real authenticated acceptance,
dispensing/reversal, medication-evidence, patient lookup, and activity workspace.
Migrate receives a separate operations workspace without displacing contextual
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
  SES/Termii/Meta primary with Brevo fallback; never Novu or durable plaintext;
- ordinary events: owner outbox -> Event Dispatcher -> EventBridge -> encrypted
  SQS/DLQ -> Notification Worker -> Novu, with FCM as the server-side push
  boundary.

Create additive migration `0028` because OTP state, progressive assurance,
complete legacy identity-link evidence, encrypted device registration, and
delivery reconciliation do not exist in `0001`–`0027`. Preserve all earlier
migrations unchanged. Supabase is a read-only migration source and Vercel is
retired; Brevo is the optional Notification API fallback.

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

# ADR-034: Cost-Safe Staging Modes with Scale-Preserving Production Guardrails

Status: Accepted

Date: 2026-08-14

Decision:

Keep the production reliability/security topology unchanged while making
staging an explicit `sleep`, `economy`, or `fidelity` profile. Sleep removes
ephemeral runtime/ingress fixed costs and stops staging RDS through a separately
confirmed operation, but retains protected data, backups, keys, secrets,
artifacts, logs and event state. Economy is the ordinary bounded staging mode;
fidelity restores release/failover/load parity. No mode is inferred.

Each service owns a typed scaling and database-pool contract. Normal and
reviewed-emergency task ceilings are separate, and synthesis rejects their
aggregate database connection demand when it exceeds the corresponding budget.
Production never scales to zero and no million-user capacity claim exists
without representative load evidence.

Clinical S3 versions never receive generic expiration. OCR duplicate billing is
controlled by exact immutable-source/processing-contract reuse and deterministic
async Textract idempotency, without a price-based clinical quality rejection.
Cost reporting separates gross consumption, credits applied, and cash exposure.
Optional AWS Budgets and Cost Anomaly Detection notify humans only; they cannot
stop production.

Consequences:

- staging runtime spend can be deliberately reduced without weakening
  production or deleting protected clinical evidence;
- sleep remains non-zero cost and stopped RDS requires bounded re-stop handling;
- emergency scaling requires external approval and database/cost evidence;
- deterministic IaC quantity inventories replace fabricated price claims; and
- AWS/Cloudflare/provider deployment remains a separately authorized action.

Supersedes or extends:

ADR-033 for AWS staging operating modes; ADR-033 remains authoritative for the
Cloudflare edge, notification boundary, and legacy migration convergence.

# ADR-035: TUF Release Admission with Isolated Trust and Atomic Edge Repositories

Status: Accepted for source implementation; live provisioning remains gated

Date: 2026-08-31

Context:

HID releases consist of twelve independently governed OCI identities and seven
independently deployed frontend trees. ECR digest pinning authenticates OCI
bytes, but the platform has no executable authority binding the approved digest
set, frontend bytes, migration ledger, and security evidence to one release.
The current document-bucket `release-evidence/` prefix is not a valid trust
boundary because application roles can access that bucket. There is no end-user
binary updater; the release operator/deployer is the artifact consumer.

Decision:

Use TUF at release admission. The primary target binds the exact Git SHA,
twelve ECR repository/digest records, seven deterministic frontend archives,
edge-worker source, migration ledger, and bounded evidence summaries. OCI blobs
remain in ECR. Browsers, clinical downloads, services, and databases do not
become TUF clients. The release verifier emits the only accepted ECS and
Cloudflare deployment plan.

Give staging and production unrelated roots, signing keys, metadata sequences,
durable client state, archives, publisher credentials, and hostnames. Serve
each complete consistent-snapshot repository as one Cloudflare Worker Static
Assets version at `updates.staging.healthidentitydirectory.com` or
`updates.healthidentitydirectory.com`. Upload and verify a versioned preview,
then deploy exactly that version to 100% traffic. Do not use split TUF traffic,
a write endpoint, R2 mutable state, the PHI bucket, Hostinger, Vercel, or
CloudFront for this repository.

Archive every generation and publication journal before promotion in a
dedicated private, versioned, KMS-encrypted, object-locked S3 bucket with S3
data-event audit. ECS receives no access. Retain all root versions permanently;
retain production targets for at least ten accepted releases and 180 days, and
staging targets for at least five releases and 90 days. ECR deletion must obey
the same reference rule.

Production root and targets use separate 2-of-3 offline hardware-backed
custodians. Snapshot and timestamp each authorize two independent non-exportable
AWS KMS keys at threshold 1. The pinned online algorithm is P-256 ECDSA with
SHA-256 unless a separately approved and interoperability-tested policy changes
it. Root, targets, snapshot, and timestamp expire within 365, 90, 7, and 1 day
respectively. Production hardware/provider/custodian selection and every live
key ceremony remain explicit approval gates.

Build, offline signing, online freshness signing, publication, deployment, and
independent canary capabilities are separate. CI uses protected GitHub
environments and OIDC for exact AWS roles; it never stores private signing keys.
GitHub-assumable roles also never receive direct `kms:Sign`: protected workflow
code is still caller-controlled code and must not be able to bypass metadata
policy by invoking KMS itself. A fixed AWS-side broker alone receives one exact
candidate key permission. It obtains environment, repository, key ARN/SPKI,
bootstrap root, current root chain, current published versions/hashes, pending
decisions, and durable online-role high-water marks from deployment
configuration and broker state rather than from the signing request. Before
signing, it authenticates the candidate against that state, enforces the exact
successor of the selected role's durable high-water and narrow wall-clock
bounds, and records enough context for timestamp signing to select only a
broker-authorized snapshot.
GitHub may submit a bounded immutable request and retrieve its result, but may
not mutate broker trust state or call KMS directly.
The repository-owned go-tuf v2.4.2 client requires an out-of-band root hash,
isolated durable state, exact origins and environment/release identity, bounded
downloads, verified target references, safe archive extraction, and atomic
outputs. Trust-on-first-use and silent state reset are forbidden.

Implementation clarification (2026-09-04): an exact retry replays its committed
bytes even after publication or supersession. A different request may replace
a pending online role only after authenticated metadata falls below its hard
publication-freshness floor; the replacement consumes the next high-water
version and never reuses the exposed one. Snapshot replacement clears a
dependent timestamp while preserving its consumed timestamp high-water. Root
and targets remain sequential and cannot skip an unpublished next version.
New output is committed only with a 30-minute operational publication margin.
The ordinary plan/materializer remains strict `+1`; recovered gaps require a
separate durable-checkpoint authorization before upload and deploy, which is
still an open staging gate.

Implementation clarification (2026-09-05): the read-only publication operator
now authenticates the exact current/pending tuples before upload and again
before deployment, and materializes recovered online gaps through the same
policy with final reauthorization before atomic commit. The ordinary operator
remains strict `+1`. A separately protected predecessor repository hash, taken
from retained publication evidence, protects the full immutable history;
checkpoint role hashes do not alone prove that history. Upload/deployment
receipts are schema `2.0.0` and bind the fixed operator/configuration pins,
checkpoint revision, predecessor/candidate hashes and role identities. These
fresh five-minute decisions are neither bearer credentials nor distributed
locks. An isolated protected runner and per-environment serialization through
public canary/checkpoint advancement remain required; failed or ambiguous
external operations require reconciliation before another publisher proceeds.
Source implementation and local tests do not close that live gate.

The local coordination policy is separate from signing state. It conditionally
claims one environment, records ordered effect intent and verified receipts,
retains the confirmed predecessor hash, and closes only on fresh read-only
published-state confirmation. Unresolved attempts have no automatic expiry or
takeover. The policy has concurrency/crash tests but only an in-memory test
store; durable history-preserving storage, receipt-verifying orchestration and
independently governed reconciliation remain implementation/live gates. No
publisher write to the signing checkpoint is introduced by this decision.

Production promotion reuses the exact staging artifact-set hash and bytes after
the staging application, migration-copy, backup restore, rollback, and
monitoring gates pass. Rollback publishes a new higher-version release selecting
retained old targets. It never restores stale metadata or an old Worker version.

Consequences:

- a compromised repository/publisher cannot forge an approved release without
  role thresholds, while durable state and expiry expose rollback/freeze;
- private signing keys never enter Git, GitHub secrets, Cloudflare, environment
  files, logs, or application runtimes;
- compromised or changed protected-workflow code cannot turn an assigned KMS
  key into an arbitrary or caller-rooted signing oracle;
- public repository targets must be PHI-free, secret-scanned, and explicitly
  allowlisted because TUF provides authenticity, not confidentiality;
- Object Lock, production key creation, account identifiers, DNS, provider
  credentials, staging, and production remain external gated actions; and
- exact layouts, role operations, expiry response, recovery, and gate evidence
  are maintained in `TUF-PRODUCTION-IMPLEMENTATION.md`.

Related ADRs: ADR-025, ADR-026, ADR-032, ADR-033, ADR-034.

# ADR-036: Patient Login Deletion Is Not Clinical Erasure; Verified Emergency Contacts

Status: Accepted for source implementation; production emergency-contact
delivery, legal-hold authority, and any erasure policy remain gated

Date: 2026-10-08

Decision:

Patient account deletion closes the authentication login bound to a canonical
patient. It revokes sessions (with session evidence), clears the password
credential, revokes federated links and the patient access PIN, revokes access
the patient granted (patient-approved and PIN-derived grants), expires pending
requests addressed to the patient, revokes notification registrations, and sets
the account to a terminal `deleted` state that a database trigger prevents from
being reactivated or re-credentialed. The canonical patient, HID, NIN binding,
demographics, clinical records, consent evidence, audit evidence, and
break-glass rules are unchanged. Consistent with ADR guidance that a patient may
exist without a login, the retained patient remains `active` for clinical
continuity.

This is not erasure under `DATABASE.md` sections 3.5 and 15. The record-class
retention model admits only the `retain` disposition with no automatic purge,
and an active legal hold blocks completion. Any erasure, de-identification,
NIN de-binding, purge disposition, or statutory period requires a separately
approved governance decision and migration.

Deletion requires a patient session issued within ten minutes, a single-use
256-bit confirmation token stored only as SHA-256, and typed confirmation. A
configurable cancellation window (product default 14 days, not a legal period)
precedes completion; the login is unusable from the scheduled time and an
Identity sweeper performs completion. A login that also carries a workforce
identity or platform role is not closed from the patient portal.

Emergency contacts are patient-owned, encrypted with the existing application
AES-256-GCM pattern under a distinct associated-data label, and become
emergency recipients only after code verification and while the patient's
notification preference is enabled. The existing `EmergencyAccessActivated`
outbox row creates idempotent intents; intent failure is audited and never
fails break-glass. Delivery is provider-neutral through notification-api with a
fixed minimum-necessary message (first name, facility, time, guidance).

Consequences:

- patient login deletion is reversible only during the cancellation window and
  never destroys regulated evidence;
- re-enrolling a new login for a patient whose login was deleted is a separate
  product decision;
- legal-hold placement authority and procedure are a governance decision; no
  runtime role can place or release a hold;
- production emergency-contact delivery is refused by configuration in both
  Identity and notification-api; the EventBridge production exclusion of
  `EmergencyAccessActivated.v1` is unchanged; and
- staging enablement, SMS sender/template approval, and provider configuration
  are external, separately authorized steps.

Related ADRs: ADR-028, ADR-029, ADR-033.

# ADR-037: Platform Administration Is Platform-Scoped; Admin Status Changes Cannot Bypass Recovery

Status: Accepted for source implementation (Phase 4 Stage 1)

Date: 2026-10-08

Decision:

Platform administration routes carry an explicit platform scope. They bind no
facility, ignore `X-Facility-ID`, check only platform permissions, and run
their database transaction with `app.access_scope = 'platform'` and no
facility or membership. Administrators never borrow a facility membership for
platform work, and no facility is assigned to them for it. Facility-scoped
routes still require a facility and check only that membership's permissions;
platform permissions do not apply to them.

Audit records platform scope explicitly. `audit.events.access_scope =
'platform'` is the only exception to the facility rules for staff rows. A
platform row has a staff account and no facility or membership, and a
successful row requires an active `platform.admin.access` grant. The database
enforces both. Audit writes remain fail-closed and append-only.

The generic admin status command accepts `active` only for a disabled account
and restores the status recorded when it was disabled (`pending_reset` when
none was recorded). It never activates a `pending_reset` or `locked` account
and never lifts a timed suspension. An administrator cannot change their own
account status or platform roles.

The authoritative Platform Admin frontend is `apps/patient-web/src/admin` in
`D-Eminence/Health-id`; `apps/admin` here is legacy reference code.

Consequences:

- every successful Platform Admin request is evidenced as platform scope
  instead of failing (503) or being attributed to an unrelated facility;
- staff sign-in still requires an active facility membership; platform-only
  sign-in is a separate authentication decision;
- legacy `locked` accounts need a governed recovery flow before they can
  return to use; and
- MFA, step-up, and two-person approval remain future Phase 4 work.

Related ADRs: ADR-033, ADR-036. Details: `PHASE_4_STAGE_1_ADMIN_FOUNDATION.md`.

# ADR-038: Platform Administration Requires MFA Sessions, Step-Up and Two-Person Elevation

Status: Accepted for source implementation (Phase 4 Stage 2A, backend only)

Date: 2026-10-08

Decision:

Platform administration uses its own session kind. `/auth/admin/login` checks
the password and the `platform.admin.access` grant and returns only a
short-lived, httpOnly challenge. A platform session is issued only after a TOTP
code (RFC 6238: SHA-1, 6 digits, 30 seconds, ±1 step, each step accepted once)
or a one-time recovery code. Email OTP is never an administrator factor. An
administrator without a factor enrolls one at first sign-in. The session needs
no facility membership, refreshes through `/auth/admin/refresh` only, expires 15
minutes after its last refresh and 8 hours after sign-in, and uses separate
cookies. Platform routes accept only platform sessions; platform sessions are
refused everywhere else.

High-risk platform commands follow one central policy
(`services/identity-api/src/admin/high-risk-policy.ts`). Every platform
mutation declares a registered action. The guard checks its permission,
If-Match, Idempotency-Key, reason and a TOTP step-up from the last five minutes,
read from server-side session assurance. Each service command repeats the
session and step-up check in its own transaction, so a direct service call
cannot bypass it. Critical and high tiers require step-up; the standard tier
does not.

`platform_super_admin` is granted only through two-person approval. An
administrator with `platform.role.manage` and a fresh step-up requests it; a
different active, MFA-enrolled Super Admin with a fresh step-up approves it
within 24 hours. The grant executes once, inside the approval transaction. A
lost authenticator is reset through the same flow (`platform.mfa.reset`). The
one-step role command refuses Super Admin grants in the service and in SQL.

A Super Admin counts as reachable for the last-Super-Admin rule when the
account is active and holds the role with a password credential. Facility
membership no longer matters.

The principal export requires `platform.principal.export` (Super Admin only), a
step-up and a reason. It returns at most 5,000 rows without credential,
session, subject or membership data, as RFC 4180 CSV with formula-injection
neutralization.

Consequences:

- Stage 1 findings S1 (platform-only sign-in), S3 (MFA, step-up, two-person
  approval) and S4 (export defects) are closed in the backend;
- the existing Health-id Platform Admin frontend cannot sign in to this backend
  until Stage 2B implements admin sign-in, enrollment, step-up and approvals;
- `MFA_SECRET_KEY_B64` must be provisioned to the Identity service before admin
  sign-in works in a deployed environment; without it admin sign-in fails
  closed (503) and nothing else is affected; and
- Super Admin revocation remains one step (with step-up); whether it also needs
  two-person approval is an open policy decision.


# ADR-039: OCR Evidence Reads Are Patient-Linked; Worker Metrics Use a Technical Owner

Status: Accepted for source implementation (Phase 4 Stage 6)

Date: 2026-10-09

Decision:

Every OCR API read that returns job-linked evidence writes a semantic audit
event in the read transaction, after authorization and before the response:
the job lookup by document (`ocr.job.find`), the job (`ocr.job.read`), its
extractions (`ocr.extraction.list`), validations (`ocr.validation.list`) and
publications (`ocr.publication.list`). A failed audit write fails the read.
Every OCR API job event names the patient of the source document, which
authorization resolves, not the job's own `patient_id`, which stays null for a
job created without one. Event details carry identifiers and counts only. A
lookup that finds no job discloses nothing and is recorded only by the request
audit.

`hid_ocr_worker` keeps no table privileges. It reads queue depth and the oldest
queued age only through `ocr.worker_queue_metrics()` (0075), which returns two
aggregates. The function's owner is `hid_ocr_queue_metrics`, a non-login,
non-inherited, non-bypass technical role that reads only `ocr.jobs.status` and
`queued_at` through one exact policy, as `hid_event_delivery_commands` does for
outboxes. The function therefore works whether or not the schema owner
bypasses `FORCE ROW LEVEL SECURITY`.

The OCR API appends outbox events for its own facility under an explicit insert
policy; `FORCE ROW LEVEL SECURITY` had refused every such insert.

Consequences:

- OCR job, validation, publication and extraction reads can be traced to the
  patient in `audit.events`, including for jobs created without a patient;
- the queue-age signal is emitted with each claim. A worker that claims nothing
  emits no metrics, so `OcrQueueAgeAlarm` cannot detect a stopped or stalled
  worker, and `OcrDrainRateAlarm` cannot breach. Fixing this needs a worker
  change to log a separate, periodic queue-metrics event, and matching metric
  filters in `infra/aws` (a follow-up);
- the OCR worker's own database audit events (`ocr.worker.*`) still carry
  `ocr.jobs.patient_id` and stay unlinked for a job created without a patient;
- the existing OCR worker commands and the OCR job triggers, like the document
  scanner command and an Outreach registration trigger, still read `FORCE ROW
  LEVEL SECURITY` tables as their owner, and `ocr.claim_worker_job` sets a
  superuser-only parameter. They work only while that owner is a superuser that
  bypasses row-level security (release checklist P8); moving them to technical
  owners is a follow-up; and
- the replay paths of idempotent OCR writes return the stored result without a
  new read event; the original write event remains.

# ADR-040: Platform MFA Transactions Lock the Account First; OCR Guards Fail Closed

Status: Accepted for source implementation (Phase 4 Stage 7)

Date: 2026-10-09

Decision:

Every platform MFA transaction of the Identity API locks the account row
through `auth.lock_account_for_mfa(uuid)` (0076) before any other row lock or
write. That covers the password step that issues a challenge, sign-in with a
TOTP code or a recovery code, the start and the activation of enrolment,
step-up and recovery-code regeneration. The order is then:
1. the account;
2. the challenge (sign-in, enrolment) or the session assurance (step-up);
3. the factor and the recovery codes;
4. the session and event rows.

That is the order of an approved MFA reset (0070), which locks the target
account and then revokes its factors, recovery codes and sessions, and of
every session revocation (0073). A challenge is first found without a lock,
only to learn its account; after the account lock it is read again, locked,
for that account only. Platform session issue resolves the administrator on
the same transaction, so the lock holder never needs a second pool
connection.

The helper takes `FOR NO KEY UPDATE`, the lock a non-key `UPDATE` of the row
takes. It conflicts with the `FOR UPDATE` of the reset and the revocations,
and with itself, so MFA transactions of one account run one at a time. It does
not conflict with the `FOR KEY SHARE` that refresh rotations and staff sign-ins
of the account take when they insert a session or a session event. It is
granted to the Identity runtime only. Two other modes were tried and
rejected, each after a local reproduction:
- `FOR UPDATE`, through the revocation helper `auth.lock_account_sessions`
  (0073), also serialized every MFA transaction with refresh rotations and
  staff sign-ins of the account. A step-up that raced a refresh of its sign-in
  then found its session rotated and was refused, ending the console session.
  The password step deadlocked with a staff sign-in of the same administrator
  through the principal's login-attempt row.
- `FOR KEY SHARE` does not conflict with itself, so MFA transactions of one
  account ran together. Each read the second-factor failure counters before
  any of them committed a failure: six parallel step-ups with a wrong code were
  all tested, where the limit allows five failures and then refuses. Two
  parallel password steps each left their challenge open. `main` before Stage 7
  had no account lock and the same two gaps.

A database guard that compares a new row with values it reads or with the
session refuses the write when a compared value is missing, and compares with
`IS DISTINCT FROM`. A comparison with `<>` is NULL when either side is NULL,
and `IF` does not raise on NULL. 0076 applies this to the OCR
patient-confirmation and validation guards. The confirmation guard also binds
the confirming account and membership to the session, as the validation guard
already did for the reviewer.

Consequences:

- An MFA transaction and an approved MFA reset of the same account no longer
  deadlock: whichever locks the account second waits for the first. Locally,
  each of six races (TOTP and recovery-code sign-in, step-up, recovery-code
  regeneration, enrolment activation and restart) deadlocked on the earlier
  code, and PostgreSQL cancelled the MFA request (`500`). With the account
  locked first, each request is refused cleanly once the reset commits;
- an MFA transaction holds `FOR NO KEY UPDATE` on the account row until it
  commits, usually milliseconds. An approved reset, a session revocation, a
  sign-out, an expiry or another MFA transaction of that account waits for it.
  A refresh or a staff sign-in of that account does not wait for it at the
  account row. A staff sign-in and a platform password step of the same
  principal still wait for each other at the principal's login-attempt row,
  which both delete, without a deadlock. A staff sign-in that upgrades a legacy
  password hash updates the account row first, so it waits for the MFA
  transaction, or the MFA transaction for it, without a deadlock;
- parallel second-factor attempts of one account are checked one at a time
  against the failure limit, and a password step supersedes the open
  challenge of the one before it, so an account has at most one open
  challenge;
- the Stage 7 Identity needs 0076 and the role bootstrap before it starts;
- pre-existing lock-order hazards that do not involve the MFA authenticator
  are unchanged: two administrators acting on each other's accounts at the same
  moment (status, platform role, approval request or decision, session
  revocation), a request and a decision on the same approval as it expires,
  and an OTP password-recovery resend racing the completion of the same
  recovery. Each can deadlock, and PostgreSQL cancels one command, which can be
  retried; nothing is half applied (release checklist §9);
- under a schema owner that cannot read the source document (release checklist
  P8), every patient confirmation is now refused, where before one for any
  patient was accepted. Validations, which read only facility-scoped OCR tables,
  are unaffected;
- `ocr.validate_job_write` compares the latest scan of the source document in
  the same way, so a missing scan does not refuse a job. The OCR API refuses a
  source that is not clean before it inserts a job. Hardening the trigger
  needs a check of existing jobs and scans first, because it also runs on every
  job update (a follow-up; closed for binding writes by 0077, see the Stage 8
  addendum).

## ADR-040 addendum: Stage 8 (0077)

Date: 2026-10-09

The fail-closed rule now covers every guard that compared a row with the
session's account or membership: the Lab (5), Pharmacy (5) and Outreach (3)
guards, the OCR worker commands `ocr.complete_worker_job` and
`ocr.fail_worker_job`, and the OCR job and publication triggers. Each reads the
session values once, refuses a missing value wherever it compares it, and
compares with `IS DISTINCT FROM`. A guard does not gain a comparison it did not
make: the rewrite changes how a missing value is treated, not what is
compared, except where Stage 8 closes a named gap:
- an OCR publication must name the session's own account and membership as
  its requester (the gap 0076 closed for confirmations);
- an OCR job needs an exact clean scan of its source when the write binds it
  to that source or starts processing it. Other updates keep the 0016 rule,
  because a stricter check on every update refuses cancelling a historical job
  without a scan event and makes the lease recovery in `ocr.claim_worker_job`
  fail for the whole provider when such a job holds an expired lease (both
  reproduced locally);
- an OCR worker command needs the caller's own claim token, and failing a job
  needs an unexpired lease, as completing and renewing already did.

0077 also makes OCR lease renewal work: the job state machine had no
`processing` to `processing` transition, so every renewal was refused. The new
transition allows an active lease to move later, at most an hour ahead as
`renew_worker_claim` allows, with the next version only; the trigger compares
the rest of the row as a whole, and the job-event trigger records nothing for
it. And taking a job out of play (failed, cancelled, back to the queue) no
longer re-reads its source evidence: a guard must never stop a job from
failing, or lease recovery from running, because the evidence it would refuse
to start from has since changed. Before, one document withdrawn during OCR
stopped every claim of its provider.

Consequences:

- a session that bypasses row-level security (a superuser, or an owner without
  `FORCE ROW LEVEL SECURITY`) can no longer write Lab, Pharmacy or Outreach rows
  attributed to another member without a request context. Maintenance writes
  to these tables need a real staff context;
- refusals that row-level security made before now come from the guard, with
  the guard's code; no API maps them differently;
- under an owner that does not bypass row-level security (P8),
  `lab.validate_imported_evidence` refuses another facility's OCR evidence
  instead of accepting it;
- the Outreach runtime gains `EXECUTE` on `auth.account_id_for_subject(text)`,
  which its policies always needed, as the Identity and EHR runtimes have. It
  can resolve a subject to its account identifier; making
  `platform.current_account_id()` a definer function would avoid that but
  changes every runtime and was not done;
- the lock-order hazards listed under ADR-040's consequences were reproduced
  locally as real deadlocks (release checklist §9). They stay for a dedicated
  lock-order change with two-connection race tests: each is fail-safe, and
  the fix rewrites the two-person approval and last-Super-Admin commands.

# ADR-041: Dedicated Technical Owners for OCR, Document-Scanner and Outreach Definer Functions

Status: Proposed (Phase 4 Stage 7C). Design only: no ownership, grant or
policy has been changed.

Date: 2026-10-09

Context:

A `SECURITY DEFINER` function runs as its owner. Every one in the `ocr`, `ehr`
and `outreach` schemas, except `ocr.worker_queue_metrics()`, is owned by the
migration administrator. Their tables use `FORCE ROW LEVEL SECURITY`, so they
work only while that owner is a superuser or bypasses row-level security
(release checklist P8). Under a non-bypass owner the worker and scanner
sessions, which name no facility or consent, see nothing:
- the worker commands claim nothing, or refuse their own lease;
- `ehr.append_document_scan_event` cannot lock the document;
- `ocr.record_job_event` cannot insert into `ocr.job_events`, which has no
  insert policy;
- `outreach.validate_registration_campaign_write` cannot lock campaign members,
  which have no update policy.

`ocr.claim_worker_job` also carries 0015's
`SET plpgsql.variable_conflict = 'use_column'`, a superuser-only parameter. A
definer applies it as its owner at every call, so a non-superuser owner gets
`permission denied to set parameter`.

Amazon RDS for PostgreSQL 16, the production target, has no superuser.

Decision (proposed):

1. **Roles.** Five non-login technical roles, created like
   `hid_ocr_queue_metrics`: `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
   NOINHERIT NOBYPASSRLS`, never granted to a runtime role, with exact column
   grants and exact `TO <role>` policies.

   | Role | Owns | Reads and writes |
   | --- | --- | --- |
   | `hid_ocr_worker_commands` | `ocr.claim_worker_job`, `ocr.renew_worker_claim`, `ocr.complete_worker_job`, `ocr.fail_worker_job`, and the test-only wrappers `ocr.claim_next_job`, `ocr.record_extraction` and `ocr.fail_job` that call them | `ocr.jobs`: select, plus update of every column the commands change (status, claim, lease, attempt, error, timing, correlation and row version). `ocr.extractions`: select, insert. `ehr.documents`: select of the columns the claim checks and returns (including the storage bucket, key, size and media type). `ehr.document_scan_events`: select of the scan columns. `audit.events`: insert |
   | `hid_ocr_job_guard` | `ocr.validate_job_write`, `ocr.validate_extraction_insert`, `ocr.validate_validation_insert`, `ocr.validate_patient_confirmation`, `ocr.validate_publication_write` | Select on every column of `ocr.jobs`, `ocr.validations` and `ocr.patient_confirmations`: four of these guards read whole rows (`select *` into `%rowtype` variables). The alternative is a migration that rewrites those reads to column lists. Select of the compared columns of `ocr.extractions`, `ehr.documents` and `ehr.document_scan_events`. `UPDATE` on one column of `ocr.jobs` only, because `SELECT … FOR UPDATE` requires it |
   | `hid_ocr_job_events` | `ocr.record_job_event` | `ocr.job_events` and `ocr.outbox_events`: insert only |
   | `hid_document_scan_commands` | `ehr.append_document_scan_event` | `ehr.documents`: select, and `UPDATE` on one column for its row lock (its `select *` becomes an explicit column list). `ehr.document_scan_events`: select, insert. `audit.events`: insert |
   | `hid_outreach_campaign_guard` | `outreach.validate_registration_campaign_write` | `outreach.campaigns` and `outreach.campaign_members`: select, and `UPDATE` on one column each for `FOR SHARE` |

   Each role also needs `USAGE` on the schemas it names, and `EXECUTE` on the
   helpers it calls: `platform.current_*`, `auth.account_id_for_subject`, and
   for the worker and scanner `auth.account_has_active_role`. The runtime
   callers keep exactly their current `EXECUTE` grants. The trigger functions
   need none: PostgreSQL checks `EXECUTE` on a trigger function only when the
   trigger is created.

   **Scope.** These are the functions P8 found failing, the lease renewal, the
   test wrappers, the guards 0076 changed and `ocr.validate_publication_write`,
   the remaining OCR insert guard. They are not all of them: of the 175 definer
   functions the migration administrator owns, 65 name a table with `FORCE ROW
   LEVEL SECURITY` and 101 name any table with row-level security. The other
   36 name only identity tables without `FORCE`, whose policies do not apply to
   their owner but would apply to a technical owner. Most of the 101 are
   outside these schemas; examples are `lab.validate_imported_evidence`,
   `platform.control_enabled`, `outreach.registration_campaign_member` and
   `ehr.capture_record_version`. Under a non-bypass owner, the 65 work only
   where the calling session's own policies admit the rows they read, and so
   would the other 36 under an owner that does not own their tables. Before the superuser requirement is
   dropped, each must be checked, by running `schema.integration.sql` and every
   runtime verifier under the non-superuser owner. Any that fail need a
   technical owner too.
2. **Policies.**
   - Each role gets `FOR SELECT` (and, where it inserts, `FOR INSERT`) policies
     `TO <role> USING (true)` / `WITH CHECK (true)`, which are cross-facility.
     The worker and the scanner act for every facility, and the job triggers
     also fire inside worker transactions, which name no facility. Today's
     superuser owner sees every row.
   - Where a function locks rows, its role gets a `FOR UPDATE` policy
     `USING (true)`: `SELECT … FOR UPDATE` and `FOR SHARE` apply the update
     policies' `USING`.
   - A lock-only role must still not change rows. Permissive policies are
     combined with `OR`, so a permissive `WITH CHECK (false)` would not stop an
     update that a `PUBLIC` update policy admits; `ocr.jobs`, `ehr.documents`
     and `outreach.campaigns` have one. The proposal is a `RESTRICTIVE`
     `FOR UPDATE TO <role> USING (true) WITH CHECK (false)` policy, to be
     verified in the implementation, besides function bodies that issue no
     `UPDATE`.
   - Column grants keep each role to the columns its functions use. No role
     owns a relation.
3. **`plpgsql.variable_conflict`.** A new migration replaces
   `ocr.claim_worker_job` (`CREATE OR REPLACE`, same signature, body, checks
   and grants). It puts `#variable_conflict use_column` on the first line of
   the body and keeps only its `search_path` setting. The per-function
   compiler option has the semantics of 0015's setting and needs no
   privilege; 0064 to 0066 already use it. `CREATE OR REPLACE` replaces the
   function's settings, so 0015's entry goes without any `SET` privilege.
   `ALTER FUNCTION … RESET plpgsql.variable_conflict` fails for a
   non-superuser. 0015 stays unchanged.

   This fixes calls, not 0015 itself. `ALTER FUNCTION … SET
   plpgsql.variable_conflict` is refused to a non-superuser even when it owns
   the function (verified). A database migrated from 0001 by a non-superuser
   administrator, as every RDS environment would be, therefore stops at 0015,
   unless that administrator holds `SET` on the parameter.
   `GRANT SET ON PARAMETER plpgsql.variable_conflict` (PostgreSQL 15 and later)
   gives it. A superuser must grant it, or the RDS master user if RDS permits
   that, which is unverified. The grant cannot be revoked after the migration
   run: `ocr.claim_worker_job`, the only function with 0015's setting, applies
   it as its owner on every call, so every OCR claim needs it for as long as
   that owner owns the function with the setting (verified locally: after the
   revoke, a call fails with `permission denied to set parameter`). It is
   cluster-wide and lets the grantee set the parameter in any session; the
   in-body replacement above removes the need. 0015 is immutable and
   checksum-pinned, so any other route needs its own decision.
4. **No superuser schema owner.** These PostgreSQL 16 behaviours, verified
   locally on 16.15 with a `NOSUPERUSER CREATEROLE` administrator, decide the
   bootstrap:
   - the role bootstrap re-asserts `NOSUPERUSER … NOBYPASSRLS` with
     `ALTER ROLE` on every run. Only a superuser may do that, even when nothing
     changes ("Only roles with the SUPERUSER attribute may change the SUPERUSER
     attribute"). A non-superuser bootstrap must create roles with their
     attributes and then verify them from `pg_roles`, refusing to continue on
     a mismatch, instead of altering them. This applies to every `hid_*` role,
     not only the new ones;
   - creating a role gives its non-superuser creator an implicit membership
     with `ADMIN OPTION` but neither `SET` nor `INHERIT`;
   - transferring a function to a technical role requires the administrator to
     be able to `SET ROLE` to it, and the role to have `CREATE` on the
     function's schema. The bootstrap grants that `CREATE`, transfers the
     function and revokes it, in one transaction;
   - a later migration that replaces a technical-owned function needs the
     owner's privileges. With `SET` but not `INHERIT` it fails with "must be
     owner". Two ways work (both verified):
     - `INHERIT TRUE` membership. It is rejected: every `TO <technical role>`
       policy would then also apply to the migration administrator, to its
       sessions, and to every definer function it still owns. That widens
       their row visibility on those tables, the masking this ADR rejects
       `BYPASSRLS` for.
     - `SET` only. The migration switches to the technical role (`SET ROLE`)
       for the replacement, with `CREATE` on the schema granted to the role
       for that statement. This one is proposed.

     `runtime-roles.integration.sql`, which today forbids any membership of a
     technical role, would allow exactly these `SET`-only memberships of the
     migration administrator, and no other.

   For the functions this ADR moves, this removes the run-time dependency on
   a superuser owner. It does not remove the one-time need to apply 0015
   (item 3), or the check of the other definer functions (item 1).
5. **Migration, rollback and compatibility.**
   - **Order.** First the new migration: the `ocr.claim_worker_job` body
     change, explicit columns for the scanner and, if chosen, for the guards. It behaves the same under
     today's owner. Then the bootstrap: roles, revoke-all blocks, policies,
     grants, ownership transfers and memberships.
   - **No service change.** Signatures, results, error codes and runtime
     grants are unchanged.
   - **Rollback.** Return the ownership of each listed function to the
     migration owner (`ALTER FUNCTION … OWNER TO`) and drop the policies to the
     technical roles. The migration stays, because it is behaviour-neutral.
   - **Acceptance.** The rehearsal's non-superuser owner check also runs
     `schema.integration.sql`, which it skips today and which covers every
     path above. It also asserts the owner of each listed function. It is run
     once with a `NOSUPERUSER CREATEROLE` bootstrap administrator.
     `runtime-roles.integration.sql` asserts exact column ACLs, policies,
     owners and memberships, with one mutant per policy. Staging S1 repeats it
     on RDS.

Consequences:

- for the moved functions, P8's run-time dependency on a superuser owner
  becomes an automated check. Applying 0015 still needs `SET` on its
  parameter once (item 3), and the other definer functions need the check of
  item 1;
- five new non-login roles each see their tables across facilities, limited to
  the columns their functions use. As for today's superuser owner, that
  visibility is reachable only through those functions, none of which builds
  SQL dynamically. The migration administrator can also reach it through
  `SET ROLE`; as the owner of the tables it could already read them;
- the role bootstrap must be changed to run without a superuser before any
  managed-service release, whether or not this proposal is adopted; and
- every function this ADR moves must keep its owner across later migrations.
  A `CREATE OR REPLACE` keeps it; a `DROP` and `CREATE` does not, so it needs
  the bootstrap to run again.

Alternatives considered:

- **Keep a superuser owner** (today's P8). Not available on RDS.
- **Give the schema owner `BYPASSRLS`.** It hides from every definer function
  the row-level-security mistakes the owner check exists to find, and RDS
  support is unverified.
- **Facility- or consent-scoped policies for the technical roles.** The worker
  and scanner sessions name no facility or consent, so this needs new context
  plumbing for no gain over exact, column-limited policies.
- **One technical role for every function.** It would merge the writers'
  privileges with the guards'. It is simpler, but it is not least privilege.

Related: ADR-028, ADR-039, ADR-040; release checklist P8 and §4.1.
