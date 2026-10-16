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

Status: Accepted. Amended for launch by ADR-052 (2026-10-13): only www,
staging and admin.* are deployed, and they serve the staged Health-id
`apps/patient-web` build; the other application hosts are not deployed.

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

## ADR-033 addendum: the edge carries the client address; the gateway routes only enabled modules

Date: 2026-10-13

Change: D-Eminence/hid-system#65 (register IP-1, GW-DNS, DEP-4-KEY
part d, and the gateway part of MOD-1).

Context: the Worker discarded every client-address header and the Gateway
forwarded `$remote_addr`, so every API saw a public ALB node as the client:
per-network limits became a few platform-wide buckets, and audit source
addresses named the load balancer. The Gateway resolved its Cloud Map upstreams
once at start-up, proxied every module, and proxied the service-to-service
routes from the public edge.

Decision:

- The Worker is the only source of the client address. It deletes any
  caller-supplied `X-Real-IP` and sets it from `CF-Connecting-IP` when that is
  one valid address. The Gateway trusts the header only from the VPC (realip,
  `VPC_CIDR`), forwards the result as `X-Forwarded-For`, and in staging and
  production refuses an API request without it
  (`403 CLIENT_ADDRESS_REQUIRED`). The APIs keep trusting only the VPC.
  `X-Real-IP` is used because Workers built before this decision delete it:
  behind a stale or rolled-back Worker the Gateway sees no address and fails
  closed. A new header (an earlier draft used `X-HID-Client-IP`) would pass
  through such a Worker with whatever value the caller chose.
- Identity's public IP-keyed limits key on the client network (IPv4 address or
  IPv6 /64) and, in production, refuse an address inside `TRUST_PROXY_CIDRS`
  with their `503` rather than share a bucket. Guess budgets stay per account
  or recipient (D6).
- The Gateway resolves upstream names per request through the VPC resolver
  (variable `proxy_pass`, `valid=10s`), so it follows redeploys and starts
  when a module has no task.
- The Gateway proxies only the modules in `HID_ENABLED_API_ROUTES` (deny by
  default; CDK passes `identity,ehr`; staging may opt modules in; production
  refuses more until a recorded decision). Other modules answer
  `404 API_ROUTE_NOT_FOUND`.
- Service-to-service routes are never reachable from the public edge: the
  Gateway answers `404` for them in any letter case, because Express routing
  ignores case. Every proxied location refuses a request target with a
  backslash before the query or a `#` (`400 INVALID_REQUEST_TARGET`), because
  Express reads a target holding `#` through `url.parse`, which turns those
  backslashes into slashes, so it could reach a route the deny expression did
  not match. A gateway marker header that internal routes refuse was
  considered; it needs a change in every service and is left as defense in
  depth for later.

Consequences:

- deployment order is every API-proxying Worker, then Gateway with the
  regional stack, then Identity; rollback reverses it (release checklist §6
  and §9), and a Worker that is not redeployed makes the Gateway refuse its
  API requests rather than trust its caller;
- disabling a module keeps its Identity caller subject and EHR's token files,
  which production configuration requires; its tasks may run or not;
- the WAF rate rule still keys on Cloudflare egress addresses, and the
  accountless QoreID cost ceiling for public enrollment is separate work; and
- the configuration is checked against a model of nginx
  (`scripts/lib/nginx-config-model.mjs`), and was also loaded and exercised
  locally by an nginx 1.29.8 binary (not the gateway image); the image in
  ECS is staging acceptance evidence (release checklist S4k).

Related: ADR-032; ADR-034; `AWS_DEPLOYMENT_ARCHITECTURE.md` ("Client address
and gateway routing"); `INTERFACE_CONTRACT.md` (first section).

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

## ADR-034 addendum: production starts at zero tasks; a module that is off cannot run

Date: 2026-10-13

Change: D-Eminence/hid-system#66 (register INFRA-COUNT; ADR-053).

"Production never scales to zero" applies once a service is rolled out. Until
then every production `*DesiredCount` defaults to 0, as ADR-032 required: the
autoscaling minimum follows the desired count, and the reviewed I6 parameter
file raises each enabled service to at least its live minimum. A module
outside the enabled set (D17) is pinned at 0 tasks in every environment. The
details are in ADR-053.

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
`D-Eminence/Health-id`; `apps/admin` here is legacy reference code and is not
deployed: admin.* serves the staged Health-id build (ADR-052).

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

## ADR-041 addendum: the non-superuser chain on RDS (launch, 0083)

Status: Accepted (D-Eminence/hid-system#63). Items 3 and 4 are
implemented for what launch needs; the five technical owners of items 1 and 2
stay proposed.

Date: 2026-10-13

Decision:

- **Item 3.** Migration 0083 replaces `ocr.claim_worker_job` as item 3
  proposed. A fresh chain on RDS still needs
  `SET ON PARAMETER plpgsql.variable_conflict` for 0015; the operator holds it
  only for the migration run and revokes it after 0083
  (`MIGRATION_RUNBOOK.md` §6.1). If RDS refuses the grant, the fallback is a
  reviewed ledger exception that rewrites 0015's statement, which no staging
  or production database has applied; not a superuser-like role and not
  `BYPASSRLS`.
- **Item 4, the bootstrap.** The role bootstrap creates the roles and checks
  their attributes; it refuses a HID group role with `SUPERUSER`,
  `BYPASSRLS` or `REPLICATION` and a runner without `ADMIN OPTION` on them.
  Its function transfers hold `CREATE` on the schema only around each
  transfer, as proposed. Its grants and revokes on the transferred functions
  also need the owner's privileges, which a `SET`-only membership does not
  give (`REVOKE ALL` on a rerun fails with `permission denied for function`).
  The bootstrap therefore holds `INHERIT` and `SET` membership in the
  technical owners for its own transaction only, and revokes it before
  committing. That transaction reads no table, so the technical policies
  widen no visibility; this differs from the persistent `INHERIT` membership
  item 4 rejected. No persistent membership is granted, so
  `runtime-roles.integration.sql` allows only the `ADMIN OPTION`-only row
  that PostgreSQL 16 records for a non-superuser creator, and only when that
  creator is the `CREATEROLE` role running the check; an `ADMIN OPTION`-only
  grant to any other role fails it. The platform control policy is created
  before any other table lock of the bootstrap and only when it is missing
  or differs, so its `ACCESS EXCLUSIVE` lock is taken in the same order as a
  break-glass activation's (control read, then `identity.outbox_events`) and
  not at all on a rerun.
- **A sixth technical owner.** `platform.control_enabled(text)` gets
  `hid_platform_control_reader`, on the `hid_ocr_queue_metrics` pattern:
  `SELECT (control_key, enabled)` on `platform.control_settings` and one
  `FOR SELECT TO hid_platform_control_reader USING (true)` policy, since the
  six controls are platform-wide non-PHI flags. It also needs `USAGE` on
  `auth`, without any privilege on an `auth` object: the table's PUBLIC read
  policy applies to it, and PostgreSQL inlines that policy's SQL function
  `platform.current_account_id()`, whose body names `auth`, while planning as
  the reading role. Without this every patient and provider request answered
  `503 PLATFORM_CONTROL_UNAVAILABLE` under an owner without `BYPASSRLS`.
- **Runtime credentials.** `db:verify-logins` checks each runtime LOGIN over
  its own connection, and every database-connected service refuses to start
  in production over a superuser, `BYPASSRLS` or owner connection.

Consequences:

- the chain, the bootstrap and the platform controls need no superuser and no
  `BYPASSRLS`; the rehearsal checks this on its own cluster
  (`scripts/verify-non-superuser-database.mjs`);
- the OCR, document-scanner and Outreach paths of P8 still need an owner that
  bypasses row-level security or the technical owners of item 1. Launch
  decision I3 does not rely on owner `BYPASSRLS`, so they stay out of the
  release until they pass under a non-bypass owner;
- a later migration that replaces a function owned by a technical role needs
  that owner's privileges, as item 4 describes for a `CREATE OR REPLACE`.

# ADR-042: Services Lock Only Rows Their Runtime Role May Update; SERIALIZABLE Transactions Retry

Status: Accepted (Phase 4 Stage 9).

Date: 2026-10-10

Context:

`SELECT ... FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` and `FOR KEY SHARE`
need `UPDATE` privilege on every locked table, checked when the statement
starts, and under row-level security the table's `UPDATE` policies also
filter the locked rows. The Pharmacy, Lab, OCR and Outreach APIs locked rows
their runtime roles may only insert (work items, dispensings, reversals,
imported evidence, accessions, OCR validations and confirmations, Outreach
campaign memberships), and Identity locked the nullable side of an outer join,
which PostgreSQL refuses for every role. Each of those commands failed with a
`5xx` since the baseline (release checklist §4.2). Granting `UPDATE` would make
append-only evidence updatable by the runtimes; a column grant without an
`UPDATE` policy makes the lock silently match no row, which turns a replay
into a duplicate insert and a dispense into `404`.

Most of those locks protected nothing. A row lock cannot lock a row that a
concurrent request has inserted but not committed, so it never serialized two
first requests, and an insert-only row cannot change once visible. The unique
constraints on target and idempotency key, and `SERIALIZABLE`, already decide
those races, but the loser received `40001` or `23505` as a `500`.

Decision:

1. **Lock only rows the runtime role may update, and only mutable rows.** A
   service locks a row only when another transaction may change it under the
   command (a job's status, a registration case's resolution, a campaign's
   status), and only on a table whose runtime role has `UPDATE` and an
   `UPDATE` policy. Insert-only rows are not locked; their unique constraints
   and the transaction isolation decide concurrent writes. Locks name the
   mutable table with `FOR ... OF` when a statement joins others, and never
   lock the nullable side of an outer join: lock the row alone, then read the
   projection in a second statement.
2. **One serialization point per aggregate, taken first.** OCR commands of a
   job lock the job row first. A transaction that will insert a row referencing
   the job (its outbox event), while holding another row of that job, takes
   the job's `FOR KEY SHARE` before that row, so every OCR transaction reaches
   the job before the publication. A request that waited for the job keeps
   its older snapshot when the transaction it waited for changed no job row,
   so a decision read without a lock is enforced again where the write
   happens: the publication claim refuses a terminal failure.
3. **`SERIALIZABLE` transactions retry.** The Pharmacy, Lab, OCR and Outreach
   `DatabaseService` run a `SERIALIZABLE` transaction again from the start,
   up to twelve attempts in all, when PostgreSQL cancels it with `40001` or
   `40P01` (which the PostgreSQL manual recommends retrying) or with `23505`
   (which it says may be worth retrying but can be persistent), after a
   random pause within a window that
   doubles from 20 ms up to 1 s; a unique violation only once, because it
   means the conflicting row has committed and the next attempt sees it. The
   retried transaction sees the winner and answers its replay, `409` or `412`.
   A service maps a remaining conflict to `409` outside the transaction, after
   the retries, except two real conflicts that no retry resolves, mapped
   inside it: the OCR confirmation outbox key (an identical-key race meets the
   confirmation's own unique keys first, which are retried) and an existing
   Outreach campaign member. Other isolation levels and other errors
   run once. `SERIALIZABLE` tracks reads by index page, so on small tables
   requests for different rows also cancel each other and only one of an
   overlapping group commits; a short fixed retry (three attempts 5–15 ms
   apart) still failed eight concurrent dispenses, and the budget was sized by
   measurement. Work inside a retried transaction must be safe to repeat:
   today it is reads, the database writes of the same transaction, and
   Identity or EHR calls that change no clinical data but are audited once per
   attempt: Identity records each authorization check, Lab records its own
   authorization audit outside the transaction, and each OCR attempt reads the
   source document from the EHR, which records a patient-linked
   `ehr.document.ocr-source.read` event and its own Identity check. Moving
   those calls before the transaction is the follow-up.
4. **Checked in CI** (the workspace gates job of `tuf-local-gates.yml`, through
   `release/scripts/run-workspace-gates.mjs`: `npm run verify`, `npm test` and
   the synthetic rehearsal). `scripts/verify-runtime-locking-privileges.mjs`
   compares every lock clause in the service source with the runtime role's
   privileges and policies replayed from the migrations and grants, and
   refuses lock text it cannot place in a statement;
   `runtime-command-privileges.integration.sql` plans (`EXPLAIN`) every command
   each runtime role holds a privilege for, as that role, and runs one
   representative lock statement per role whose locks Stage 9 kept or changed;
   the
   runtime verifiers run the affected commands over HTTP as their roles and
   fail on any deadlock.

Consequences:

- No `UPDATE` privilege or policy was added. The Outreach campaign lock applies
  the campaign `UPDATE` policy, so campaign-linked registration requires
  `outreach.campaign.write` as well as `outreach.registration.write`; the
  runtime command suite checks that every role with the first holds the
  second.
- A conflict that a retry cannot resolve (a row hidden by row-level security
  in another facility, two members verifying one Lab result version) still
  answers `500`, after one retry; mapping those constraints to `409` is a
  follow-up. Since D-Eminence/hid-system#56 Lab's EHR-order acceptance
  maps its own (`409 LAB_ORDER_ALREADY_ACCEPTED` for a work-item key left
  after the retry); every other Lab command still answers `500`, which OCR
  stores for its Lab import as retryable.
- Removing a lock made reachable code that had always failed before it. 0078
  fixed two defects behind the locks: it drops the self-NIN identifier insert
  policy, whose sub-select the Identity runtime cannot read and which no
  legitimate writer uses (repairing its privileges would have let the Identity
  runtime insert self-NIN identifiers without `bind_my_verified_nin`), and it
  repairs the Lab work-item child guard. One lock-order cycle between OCR
  publication requests and publication completion was fixed by decision 2.

## ADR-042 addendum: a definer guard share-locks another domain's source row (0080)

Date: 2026-10-12

Change: D-Eminence/hid-system#48.

Pharmacy acceptance and dispensing depend on a mutable row of another domain,
the EHR prescription, which the EHR may cancel, hold, complete or edit at any
time. Decision 1 still holds for the runtime roles: `hid_pharmacy_runtime` has
no privilege on `ehr` and takes no lock there. The database guards
`pharmacy.validate_work_item` and `pharmacy.validate_dispensing`, which run as
their owner (`SECURITY DEFINER`), read the prescription with
`SELECT ... FOR SHARE`. The owner holds the `UPDATE` privilege the lock needs;
no grant or policy is added.

- The share lock, not a plain read, is what makes the check hold: in the
  `SERIALIZABLE` Pharmacy transaction a cancel committed after the snapshot
  fails the lock with `40001`, which decision 3 retries, and the retry reads
  the cancel. A plain read would check the stale active version. `FOR KEY
  SHARE` would see this cancel only because the EHR locks the row `FOR
  UPDATE` before its update; `FOR SHARE` conflicts with any update of the row.
  A committed lock-only mark, such as the EHR handoff's `FOR UPDATE` or
  another request's share lock on the same prescription, does not raise
  `40001`, so acceptances right after the EHR's eligibility check and
  concurrent identical requests do not fail.
- An EHR update waits for a Pharmacy command that has taken the lock, for the
  milliseconds until it commits, and then applies after it. The EHR takes the
  prescription and then its own rows and never a Pharmacy row, so there is no
  lock cycle. The EHR must not call Pharmacy while it holds the prescription
  lock: its eligibility check commits before the HTTP call.
- Pharmacy can now delay an EHR write, which it could not before: a Pharmacy
  transaction that stalls after the guard keeps the share lock, and a
  prescriber's cancel or hold waits until the EHR's 15 s `statement_timeout`
  and fails with `500`. Pharmacy's 15 s `statement_timeout` bounds a slow
  statement but not an idle transaction; no
  `idle_in_transaction_session_timeout` is set (a possible mitigation).
- Under an owner subject to row-level security (release checklist P8) the
  lock applies the EHR select and update policies with the pharmacist's
  session; a prescription the owner cannot lock reads as missing and is
  refused. A dedicated technical owner for these guards (ADR-041) would need
  `USAGE` on `ehr`, `EXECUTE` on `ehr.context_allows` (the prescription
  policies call it), column `SELECT` on `id` and the compared columns, an
  `UPDATE` privilege for the lock and the matching policies.
- The acceptance guard compares every snapshot field except the prescription
  time and the start and end dates: migrations run before the EHR API is
  deployed and the EHR may be rolled back, and earlier EHR builds send the
  time at the millisecond and the dates as local-midnight `Date` values, a
  day early in a process east of UTC. Comparing the exact time and dates is a
  follow-up for a later release, once the EHR rollback floor sends their
  exact texts.
- The guards require the accepted version, not only an active status: the
  fail-closed default while the lifecycle of accepted work after an EHR
  change is undecided (`DATABASE.md`, "Pharmacy source prescription guards
  (0080)").

# ADR-043: Identity Trusts a Workload-Reported Method for Delegated Cookie Reads

Status: Accepted for source implementation (D-Eminence/hid-system#38). Not
deployed.

Date: 2026-10-11

Context:

EHR, Lab, OCR and Pharmacy authorize each patient-scoped request with
`POST /api/v1/identity/service/authorization/check`, forwarding the user's
cookie and authenticating separately as approved workloads (ADR-025).
Identity's `SecurityGuard` requires an allowed `Origin` and a valid
`X-CSRF-Token` on every cookie request with an unsafe method, and the decision
call is always a `POST`. A same-origin browser `GET` carries neither, so before
this change every delegated patient-scoped read from a same-origin cookie
session was refused `403 ORIGIN_DENIED` at the decision call. This was reproduced locally
over HTTP for a doctor's cookie-only read of encounters through EHR.

Decision:

- The calling services report the method of the request they are serving in
  `X-HID-Original-Method`. The typed Identity client sends it upper-cased, and
  only when it is 1–16 letters. Only the patient authorization call sends it.
- `@DelegatedBrowserRequest()` marks the routes where Identity may use that
  report. Only `POST /api/v1/identity/service/authorization/check` is marked.
- On a marked route, Identity skips the cookie Origin and CSRF check only when
  the reported method is exactly `GET`, `HEAD` or `OPTIONS` and the same
  request authenticates through `WorkloadAuthService.authenticateService` as an
  approved caller (`ehr-api`, `lab-api`, `pharmacy-api`, `ocr-api`,
  `outreach-api`). Any other value, and any workload authentication failure,
  keeps the check.
- The header carries no authority by itself. Session verification, runtime
  controls, facility, permission, the handler's own workload authentication
  and the patient decision are unchanged, as are bearer requests and every
  other route, including `POST /api/v1/auth/service-session`.

Consequences:

- same-origin cookie reads through EHR, Lab, OCR and Pharmacy are authorized
  once both the service and Identity include the change; either side alone
  behaves as before. OCR's cookie reads also need EHR with the change: OCR
  reads each job's source document through EHR
  (`GET /ehr/internal/ocr/documents/:id/source`), which authorizes it with the
  forwarded cookie;
- Identity cannot verify the reported method. It relies on any approved
  workload with valid credentials to report it truthfully, so such a workload
  can have the Origin and CSRF check skipped on the patient decision. A browser
  write is still checked first: EHR, Lab, OCR and Pharmacy revalidate the
  session through `POST /api/v1/auth/service-session`, and Outreach checks
  writes in its own guard and through
  `POST /api/v1/identity/outreach/authorize`;
- for a service hop that forwards the user's cookie, the reported method is
  that hop's, not the browser's. For example, EHR reports `GET` for OCR's
  source-document read during job creation, after OCR has revalidated the
  browser's `POST`;
- Outreach reports no method, and its own Identity routes are not marked. Its
  guard still requires Origin and CSRF on every cookie request, so same-origin
  cookie reads from Outreach are likely refused (from reading the code, not
  reproduced; a follow-up; superseded for Outreach by ADR-045); and
- the HTTP evidence is local and synthetic and covers EHR only; Lab, OCR and
  Pharmacy have unit coverage only (release checklist §8).

Related: ADR-025; `INTERFACE_CONTRACT.md` (Extracted Identity boundary);
release checklist §2, §3 and §9.

# ADR-044: Sign-Out Authenticates Itself; Browser Apps Name Their Kind of Sign-In

Status: Accepted for source implementation (D-Eminence/hid-system#39). Not
deployed.

Date: 2026-10-11

Context:

Staff and patient browser sessions use the same three host-only cookies
(`hid_access`, `hid_access_refresh`, `hid_access_csrf`). By default the access
cookie lasts 15 minutes and the refresh cookie 8 hours. `POST /auth/logout`
sat behind the guard and needed a live access token, so a browser left idle
for more than 15 minutes could not sign out: the guard answered `401`, the
cookies stayed, and the sign-in stayed refreshable until its refresh window
ended. Health-id works around that `401` in the browser: its patient portal
refreshes once and signs out again only if the refreshed sign-in is the same
patient's, and its provider portal restores the session and retries.
Health-id serves its staff and patient portals from one application on one
origin, so both portals see the same cookies, and a stale tab of one portal
could refresh (rotate) or end a sign-in of the other kind.

Decision:

- `POST /auth/logout` is public at the guard and authenticates the request
  itself. A live access token decides: a bearer token, or the access cookie
  with an allowed Origin and its CSRF token. Without one, the refresh cookie
  ends its sign-in when the request carries the CSRF token derived from that
  refresh token. It reads the sign-in under the account lock, after any
  sign-out or revocation that got there first, and ends whatever is left of
  it, whatever its expiry or the account's state: a sign-in refresh cannot
  renew now may become renewable again when a timed suspension lapses. A
  cookie sign-out from a missing or unapproved Origin changes nothing; every
  other outcome except a client mismatch clears the cookies. A sign-out ends
  only sessions that are still unrevoked, under the account lock, and records
  and audits only when it ended one, so two tabs signing out at once record
  one sign-out.
- A browser application may name itself in `X-HID-Client` (`staff-web` or
  `patient-web`) on a cookie refresh or sign-out. A sign-in of the other kind
  that refresh could renew now is then refused with
  `403 SESSION_CLIENT_MISMATCH` after the Origin and CSRF checks; nothing is
  rotated or ended and the cookies are kept. Any other sign-in is handled as
  for an unnamed application (below). An absent or other value keeps the
  earlier behaviour, and a bearer sign-out ignores the header.
- The header is the calling application's own declaration. It keeps one
  application's tab from acting on the other's sign-in; it is not
  authentication and grants nothing. Origin, CSRF and the session checks
  remain the security boundary.
- The kind is answered only for a sign-in refresh could renew now: account
  live, absolute end not passed, the token's session live or rotated within
  the last 60 seconds into one that is, so a refresh or sign-out that raced
  the other application's tab is answered with the kind, and its actor
  resolvable as refresh resolves it (addendum below). An older
  rotated token is reuse: refresh rotates nothing and ends the whole sign-in,
  and a sign-out ends the sign-in whichever application asks, without naming
  its kind. So an old rotated token tells nobody whether, or as which
  application, its sign-in is still live.

Consequences:

- An idle browser can end its sign-in, and the sign-in no longer outlives a
  successful sign-out by its refresh cookie.
- Platform maintenance and a disabled portal no longer block sign-out.
- A CSRF refusal on sign-out clears the browser's cookies without ending the
  sign-in, which stays live on the server until it is signed out with valid
  evidence or lapses.
- The kind check protects nothing until a frontend sends the header. Health-id
  `main` does not (all its hid-system clients use cookie mode, which omits
  it), and `packages/identity-browser-client` does not. Until then, a cookie
  sign-out without a live access cookie ends whichever sign-in the refresh
  cookie holds, including the other portal's or another account's, without
  the refresh that Health-id's patient portal uses to check that the sign-in
  is the same patient's.
- No migration or grant changes. The lookups read tables the Identity runtime
  already reads, and sign-out by refresh cookie reuses the 0073 account lock
  and family revocation.

Related: ADR-038 (platform sessions keep their own cookies and routes);
`INTERFACE_CONTRACT.md`, "Auth session contract"; release checklist §2.

## ADR-044 addendum: renewable means refresh could resolve the actor

Date: 2026-10-12

The lookup behind "refresh could renew now" checked the account and the
session but not what refresh checks next: it resolves the staff actor (an
active facility membership without a migration hold, an active staff record
with an accepted verification status, an active organization and facility)
or the patient (still the account's active patient, through
`identity.current_patient_account`). A staff sign-in whose membership lapsed
was therefore refused `403 SESSION_CLIENT_MISMATCH` with its cookies kept
when the patient application refreshed or signed it out, although refresh
would only have answered `401`. The lookup now includes that condition, built
from the same join chain as staff resolution (`eligibleStaffMembershipJoins`),
so such a sign-in gets refresh's `401` with the cookies cleared, and a
sign-out that names the other application ends it. It is refused, not ended,
by refresh, so it is renewable again once its membership or patient is
active. The Origin and CSRF checks still come first, and nothing is granted:
the change only stops naming the kind of a sign-in that refresh would refuse
(D-Eminence/hid-system#50).

Health-id `main` names its portal in `X-HID-Client` on cookie refresh and
sign-out since `22e8664` (D-Eminence/Health-id#40), so the kind check, and
this change, apply as soon as Identity is deployed with it. ADR-044's
consequence that the check protects nothing until a frontend sends the header
holds only for earlier Health-id builds and `packages/identity-browser-client`.

# ADR-045: Outreach Cookie Reads Are Delegated; a Reported Read Authorizes Only a Read Permission

Status: Proposed for source implementation (D-Eminence/hid-system#43).
Not merged or deployed.

Date: 2026-10-12

Context:

Outreach authorizes every request with
`POST /api/v1/identity/outreach/authorize`, forwarding the user's cookie and
authenticating separately as the `outreach-api` workload. ADR-043 left
Outreach out. Reproduced locally over HTTP in the migration rehearsal on
`main` (`522fb2e`), with Outreach as `hid_outreach_api_runtime` and Identity as
`hid_identity_api_runtime`, every same-origin cookie read from Outreach was
refused, at three layers in turn:

- Outreach's guard required an allowed `Origin` and an `X-CSRF-Token` on every
  cookie request, `GET` included, so every cookie read
  (`GET /api/v1/outreach/registration-cases`, `/:caseId`, `/campaigns` and
  `/campaigns/:campaignId/members`) was refused
  `403 CSRF_VALIDATION_FAILED`;
- with only that fixed, Identity refused the forwarded cookie on the authorize
  call with `403 ORIGIN_DENIED`: the route was not marked
  `@DelegatedBrowserRequest()`, and Outreach reported no method;
- with both fixed, every campaign route answered `400 VALIDATION_FAILED`,
  because `AuthorizeOutreachDto` accepted only `outreach.registration.read`
  and `outreach.registration.write`, not the campaign permissions of
  migration 0038.

Decision:

- Outreach treats `GET` and `HEAD` as reads. A cookie read needs no `Origin`
  or CSRF token; one that names a disallowed `Origin` is refused
  `403 ORIGIN_DENIED` (in production Outreach's CORS layer refuses a
  disallowed Origin even earlier). A cookie write keeps the presence check: an
  allowed `Origin` and an `X-CSRF-Token`, else `403 CSRF_VALIDATION_FAILED`. A
  read route mapped to a permission that is not a `.read` fails closed with
  `500 OUTREACH_POLICY_INVALID`.
- Outreach reports the method of the request it is authorizing in
  `X-HID-Original-Method` on its authorize call, through the typed Identity
  client as in ADR-043.
- Identity marks `POST /api/v1/identity/outreach/authorize` with
  `@DelegatedBrowserRequest()`, under ADR-043's conditions. When
  `SecurityGuard` skips the cookie-write Origin and CSRF check for a read
  reported by an authenticated workload, it records the reported method in
  `request.delegatedBrowserMethod`. `authorizeOutreach` still requires the
  `outreach-api` workload (`authenticateOutreach`), and after such a skip
  authorizes only a permission ending in `.read`; a write permission is
  refused `403 CSRF_VALIDATION_FAILED`.
  `POST /api/v1/identity/outreach/patient-authorization` is not marked.
- `AuthorizeOutreachDto` accepts exactly `OUTREACH_PERMISSIONS`, three of the
  four Outreach permissions that migrations 0024 and 0038 define:
  `outreach.registration.read`, `outreach.registration.write` and
  `outreach.campaign.read`. It does not accept `outreach.campaign.write`:
  Identity's validation refuses it `400 VALIDATION_FAILED`, as on `main`, and
  Outreach relays that status and code. Campaign reads
  (`GET .../campaigns` and `GET .../campaigns/:campaignId/members`) are
  authorized; the three campaign writes (create, status change, member add)
  answer `400 VALIDATION_FAILED` and change nothing, as on `main`. An earlier
  version of this branch also accepted `outreach.campaign.write`; that is
  withdrawn (next section).

Campaign writes (not decided here):

A security review of that earlier version found that the campaign write routes
have no campaign-level governance:

- `OutreachService.addCampaignMember`
  (`services/outreach-api/src/outreach/outreach.service.ts:226-234`) checks
  only that the campaign belongs to the facility, then inserts the
  caller-supplied `membershipId` and `role`, `admin` included. The RLS insert
  policy `outreach_campaign_members_create`
  (`0038_outreach_campaign_workspaces.sql:99-104`) requires only
  `outreach.campaign.write` at the facility and `added_by` equal to the
  current account and membership;
- `updateCampaignStatus` (`outreach.service.ts:195`) closes or activates any
  campaign of the facility, with no member or role check; and
- the restrictive policies of `0045_outreach_campaign_registration_binding.sql`
  (55-64) gate a campaign-linked registration case only on a
  `campaign_members` row existing.

So, with `outreach.campaign.write` authorized, any holder of it at the
facility could add themselves to any campaign as `admin` and then read its
campaign-linked registration cases (name, phone, sex, age, notes), and could
close or activate any campaign. On `main` these routes were unreachable (`400`).

A second, independent review found that this is how 0038 is designed, not a
defect in it: 0038 describes `outreach.campaign.write` as "Create and govern
facility-scoped Outreach campaigns and workspace membership"
(`0038_outreach_campaign_workspaces.sql:6`); the schema suite has a removed
member add itself back as `admin` and expects success
(`services/ehr-api/database/tests/schema.integration.sql:2096-2130`); 0045
lets "an authorized campaign manager" change status, with no creator check
(`0045_outreach_campaign_registration_binding.sql:116-118`); and the DTO's
two-permission limit predates the campaign routes (added in `a8b3889`), so it
was an oversight, not a gate. Since D-Eminence/hid-system#34 a campaign
member can record a campaign-linked registration, but no campaign can be
created through the API while `outreach.campaign.write` stays refused, so no
linked case exists unless a campaign is created outside the API.

Who may create campaigns, change their status and add members is a
governance and product decision. The campaign-linked registration compartment
(0045) is only as strong as who may add campaign members. The options:

- A: authorize `outreach.campaign.write` as 0038 designs it, for
  facility-level campaign managers. Every role that reads registrations
  (doctor, clinician, nurse, receptionist, admin and org_admin) could create
  campaigns, change their status and add any facility member, themselves
  included, which also admits them to the campaign's linked registrations.
  This is a one-line change to `OUTREACH_PERMISSIONS`; its tests were written
  once on this branch.
- B: per-campaign governance first, for example only the campaign's own
  `admin` members (`createCampaign` seeds the creator as one) manage it,
  enforced in `OutreachService` and in an RLS `WITH CHECK`/`USING` clause by
  a new migration, with failing-first SQL and HTTP tests in which a
  non-member holding `outreach.campaign.write` is refused.

This branch does not decide it. Until the product owner chooses, it keeps
`outreach.campaign.write` refused exactly as on `main` and authorizes only
campaign reads, so no write behaviour changes and the choice stays open.

Consequences:

- same-origin cookie reads of Outreach registration cases and campaigns are
  authorized once both Outreach and Identity include the change; either alone
  behaves as before, and the reads are refused;
- Identity cannot verify the reported method, as in ADR-043. Outreach has no
  separate session revalidation: Identity checks an Outreach browser write's
  Origin and CSRF token only on the authorize call. Limiting a reported read to
  read permissions keeps that check for every write, so a misreported method
  can authorize a read but never a write;
- no migration or grant change. Bearer requests are checked as before, and
  campaign reads become authorizable for bearer and cookie requests alike.
  Campaign writes are not: no campaign can be created through the API until
  the decision above, so release checklist step S4c's campaign create cannot
  pass. Health-id needs no change for the reads: it already sends cookies with
  credentials and `X-CSRF-Token` only on writes. Its Outreach page can list
  campaigns and members, but its campaign create, status and member actions
  get `400 VALIDATION_FAILED`, as on `main`; Health-id should hide or handle
  them;
- campaign-linked registration works as the runtime role since
  D-Eminence/hid-system#34 (`FOR SHARE OF campaign`, release checklist §4.2),
  for a campaign that already exists; and
- the evidence is local and synthetic: the Outreach guard and Identity specs,
  and `services/outreach-api/scripts/verify-outreach-cookie-read-runtime.mjs`,
  which the migration rehearsal runs as `outreach_cookie_read_runtime`
  (release checklist §8). The verifier now seeds its campaign with SQL and
  checks that each campaign write is refused; it passed in the rehearsal on
  the tree merged with `main` after #34 to #36 (`f64aa01`, release checklist
  §8). Nothing has been run on staging or
  production.

Related: ADR-025; ADR-043; `INTERFACE_CONTRACT.md` (Extracted Identity
boundary; Outreach registration boundary); release checklist §2, §3, §7, §8
and §9.

# ADR-046: A Staff Sign-In Keeps Its Selected Facility; X-Facility-ID Still Authorizes

Status: Accepted for source implementation (D-Eminence/hid-system#47, ported
as D-Eminence/hid-system#73, migration 0089). Not deployed.

Date: 2026-10-12; amended 2026-10-13 for the port onto the launch stack
(below).

Context:

A staff member who works at more than one facility chooses one with
`POST /auth/facility`. Identity checked the membership, audited
`auth.facility.select` and answered with the actor at that facility, but
stored nothing. `GET /auth/session` and `POST /auth/refresh` resolve the
actor afresh and bind the primary facility (else the first by name), so a
page reload silently moved the user back to the primary facility, where the
next clinical action would have been taken.

Decision:

- Identity keeps the choice per sign-in in `auth.session_facility_selection`
  (0089), keyed by the session family as `auth.session_assurance` is (0069):
  refresh rotates the session row but keeps the family, so the choice survives
  rotation, and another sign-in of the same account has its own. A new choice
  replaces the old one (`row_version` increments).
- `POST /auth/facility` stores the choice after the existing membership check,
  for the presented session while it is a live staff session of the account,
  under the account row lock that sign-out and revocation take (0073), and
  writes the existing `auth.facility.select` audit on the same transaction.
  A refusal writes no selection row and no successful `auth.facility.select`
  audit; the global `AuditInterceptor` records it as a failed
  `auth.facility.select` session event with no facility
  (D-Eminence/hid-system#42). A
  presented session that another tab's refresh rotated after the request was
  authorized is no longer live, so that selection is `401` and the client
  refreshes and retries.
- Staff responses carry `facilitySelection`: `selected` (the stored facility,
  still one of the actor's active facilities, is reported), `default` (none
  stored; every new sign-in), `reselect` (the stored facility is no longer
  one of the actor's active facilities: the default is reported and the client
  asks the user to choose again rather than working elsewhere silently), or,
  on a refresh only, `unavailable` (below). A new staff sign-in is the session
  issued after the second factor (`POST /auth/mfa/verify` or
  `POST /auth/mfa/enroll/activate`, ADR-054); the password step issues no
  session and reports nothing.
  Patient and platform sessions, and `/auth/service-session`, are unchanged
  and carry no field. Facilities are compared by id, so a membership replaced
  by another active one at the same facility keeps the choice `selected`, with
  the new membership's roles.
- A stored choice that cannot be read is never reported as a choice:
  `GET /auth/session` answers `503 DEPENDENCY_UNAVAILABLE` with the cookies
  untouched. A refresh, whose rotation still commits (addendum below), answers `200`
  with the rotated session's cookies and CSRF token, the actor as resolved
  (the default facility) and `facilitySelection: 'unavailable'`, which the
  client must not take as a choice; it asks where the user is working, and
  the stored choice is reported again on the next read.
- The stored choice is only the default the session reports. It authorizes
  nothing: every facility-scoped request still carries `X-Facility-ID`, which
  the guard checks against the actor's active memberships, and the stored
  facility is re-checked against those memberships whenever it is read. A
  valid `X-Facility-ID` on `GET /auth/session` itself still binds the
  facility it names. `verify()` and the per-request guard are unchanged, so
  protected routes make no extra query.
- The 0089 guard admits a row only for the root session of a staff sign-in of
  the same account that still has a live session, and an active membership of
  that account at that facility. Its membership, migration-hold, staff,
  organization and facility conditions mirror `CurrentStaffContextService`;
  the account's status and `disabled_until` are not repeated, because
  `TokenService.verify()` refuses an inactive or disabled account before the
  API writes. The verified staff statuses are hard-coded in SQL, duplicating
  `ACTIVE_STAFF_VERIFICATION_STATUSES` (`auth-policy.ts`) as
  `identity.has_active_membership` already does; a comment at each place names
  the others. It refuses moving a row to another sign-in or account, and
  refuses DELETE. The Identity runtime gets select, insert and update; no
  other service gets any privilege.

Consequences:

- A reload or refresh keeps the user at the facility they chose.
- The choice belongs to the sign-in, not the tab: every tab holding the same
  cookies reads the same choice, and the last choice made in any tab wins. A
  client keeps the facility it is working at in memory across a refresh while
  it is still in `actor.facilities`, because the refresh response reports the
  sign-in's last choice, which may come from another tab.
- Sign-out and revocation leave the row, as with `auth.session_assurance`; a
  signed-out or revoked sign-in never reads it again (reads go through a live
  session of the family) and can never change it (the guard requires a live
  session). Rows are not deleted; they are one small row per staff sign-in
  that made a choice, with no retention job yet.
- `reselect` does not clear the stored choice. If the membership becomes
  active again before the user chooses, the choice is reported as `selected`
  again.
- Deployment order: apply 0089 and the role bootstrap before this Identity API
  serves traffic. Without the table, every staff `GET /auth/session` answers
  `503`, every staff refresh answers `unavailable` and `POST /auth/facility`
  fails, so a reload cannot keep a facility. The previous Identity API ignores
  the table, so rolling the API back needs no schema change.
- Numbering: written as 0080 in D-Eminence/hid-system#47; main has its own
  0080 (Pharmacy source prescription guards), so it is ported as 0089, after
  the launch migrations 0085-0088, and `release/config/components.json` lists
  it last.
- Creating the table's four foreign keys briefly takes `SHARE ROW EXCLUSIVE`
  on `auth.sessions`, `auth.accounts`, `identity.facilities` and
  `identity.staff_facility_memberships` (`MIGRATION_RUNBOOK.md`).
- An actor without an Identity sign-in (`AUTH_MODE=oidc` bearer tokens, no
  session id) has nowhere to keep a choice. Since staff MFA (0088) such a
  token carries no MFA assurance and the guard refuses it before the
  controller (`403 STAFF_MFA_REQUIRED`); the controller still answers one as
  before, without storing or reporting anything, should it ever reach it.

Port onto the launch stack (2026-10-13, D-Eminence/hid-system#73):

D-Eminence/hid-system#47 was written on `main` before 0080-0088. Ported after
staff MFA (0088), it keeps the decisions above with three changes, each
because the stack changed what #47 assumed:

- Number: main has its own 0080, so the migration is 0089, after 0088. Its
  table, guard and grants are unchanged. The guard does not check MFA
  assurance: the selection authorizes nothing, and Identity reaches it only
  through a session `SecurityGuard` has already found MFA-verified.
- Where `default` is reported: #47 reported it on `POST /auth/login`, which
  since 0088 issues no session. It is reported on the two routes that issue
  the staff session, `POST /auth/mfa/verify` and
  `POST /auth/mfa/enroll/activate`. Provider activation issues no session
  either since 0088 and continues with those routes.
- Refresh when the choice cannot be read: #47 answered `503` with the rotated
  cookies. The gateway before D-Eminence/hid-system#72 replaced every upstream
  `502`, `503` and `504` with its own `503` and dropped `Set-Cookie`
  (`proxy_intercept_errors`, launch item A8; ADR-055 turned that interception
  off), so behind such an edge the browser would keep the spent refresh token
  and its next refresh would be taken as token reuse, ending the whole sign-in and
  recording a false reuse event. A refresh carrying cookies should not depend
  on the edge passing a `5xx` through, so it answers `200` with `unavailable` (deny by default: the
  default facility is reported but not as a choice, and the user is asked; the
  cost is one extra question while the table cannot be read). The rest of
  refresh, the cookie clearing on a refused or failed rotation included, is as
  on the base; the clearing rule and the audit inside the rotation are a
  separate change (A6).

The facility comparison (by id), the per-family key, the account lock, the
guard's conditions and the 503 on `GET /auth/session` are unchanged. 0087's
one active membership per facility (ADR-049) makes the comparison by id
unambiguous; `FACILITY_MEMBERSHIP_AMBIGUOUS` still refuses a staff actor
that holds two.

Related: ADR-038 (session assurance per family), ADR-044 (sign-out under the
account lock), ADR-049 (one active membership per facility), ADR-054 (staff
sign-in is password then TOTP); `INTERFACE_CONTRACT.md`, "Working facility per sign-in";
`DATABASE.md`, "Session facility selection (0089)".

## ADR-046 addendum: refresh reads the choice in its rotation and audits where it reports

Date: 2026-10-14

D-Eminence/hid-system#76 (ADR-059, launch item A6) moved the refresh's
`auth.refresh` audit row into the rotation's transaction, with the actor the
rotation resolved, at the default facility; the choice was still read after
the commit, on another connection, for the response. A staff sign-in that had
chosen another facility was therefore answered `selected` at that facility but
audited at its primary facility, membership and organization, and a
facility's audit list (`GET /audit/events`) showed the refresh at the wrong
facility. D-Eminence/hid-system#73 had audited the reported actor, after the
commit.

Decision (this change, the A6 residual):

- The refresh reads the choice in the rotation's transaction, which already
  holds the rotated session of the family, and writes the `auth.refresh` row
  with the actor it reports. The response reports that same read; nothing is
  read after the commit.
- The read is a plain `SELECT` (no row lock) under a savepoint. A read that
  fails is rolled back to the savepoint only: the rotation commits with its
  row at the default facility and the answer is still `200` with
  `facilitySelection: 'unavailable'`. A transaction the savepoint cannot
  restore fails the audit write, so the refresh is a `5xx` with nothing
  rotated and the cookies kept (ADR-059).
- `unavailable` stays although a failed rotation no longer spends the refresh
  token: a `5xx` would leave every staff sign-in unrenewable for as long as
  the choice cannot be read, while `unavailable` only asks the user where they
  are working.

No request, response, schema or grant change. The rotation's transaction holds
the presented session's row lock for one more statement, bounded by the
statement timeout.

# ADR-047: One Environment-Bound Workload Issuer for Staging and Production

Status: Accepted (2026-10-13). The owner instructed that the technical
decisions be taken now with the owner defaults (deny by default, least
privilege, no production bypass); D1, D2 and D3 below are those defaults.
Acceptance authorizes no deployment: staging needs its own deployment
authorization and the live proof I5 (`AWS_DEPLOYMENT_RUNBOOK.md` §7), and
production needs the production unlock, a production change approval and its
own deployment authorization (I6, §12). Nothing has been deployed.

Date: 2026-10-12 (proposed); 2026-10-13 (accepted, with D1-D3 and the
DEP-4-KEY, DEP-4-DOS and DEP-4-RES changes implemented on
D-Eminence/hid-system#54).

Supersedes for production ADR-032's external HTTPS workload issuer/JWKS/subjects
and rotating mounted token delivery, and records the workload issuer as an
implemented workflow under ADR-032's rule that no Lambda or API Gateway exists
without one. Development is unchanged.

Context:

- Each token-bearing task (Identity, EHR, Lab, Pharmacy, OCR API, Outreach)
  mounts a task-local `workload-tokens` volume read-only. Only a container of
  the same task can write it, and before this change only staging added one,
  the `workload-token-agent` sidecar. The production and development templates
  had no writer and no input through which an external mechanism could
  deliver tokens, so production could not obtain a token from any issuer.
  Every service-to-service call then fails closed: Identity cannot send an OTP
  (`503 OTP_DELIVERY_UNAVAILABLE`), the EHR cannot authenticate any request
  through Identity (`503 SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE`), and Lab,
  Pharmacy, OCR and Outreach calls fail the same way. Production correctly
  forces `jwt` workload mode and refuses local secrets.
- Production `*DesiredCount` parameters default to 2. ADR-032's rule that
  counts stay zero until staging proves an approved issuer and delivery
  mechanism is not enforced by the template. (Later: ADR-053 makes every
  production count default to 0.)
- The issuer Lambda (`infra/aws/runtime/workload-issuer/issuer.mjs`) and the
  agent (`services/workload-token-agent/src/agent.mjs`) accepted only
  `HID_DEPLOYMENT_ENV=staging`, the `/staging` stage and `hid:staging:`
  subjects, so reusing the staging construct in CDK alone fails at run time.
- The staging issuer (P-256 KMS key, Lambda, regional REST API with an
  IAM-authenticated `POST /token` and a public JWKS) was added without an ADR.
  This ADR records it.
- The draft of this ADR left four findings open: the signing key had the CDK
  default key policy and receivers checked no token age (DEP-4-KEY); the public
  JWKS shared one stage throttle with `POST /token` and the agent fetched it
  for every renewal (DEP-4-DOS); and an essential agent took a whole task down
  during an issuer outage longer than a token's lifetime, Identity sign-in
  included (DEP-4-RES).
- Staging is not deployed (`STAGING_AWS_CHECKPOINT.md`), so the mechanism has
  never minted a token live. Production is locked
  (`TUF-STAGING-EXECUTION.md`).

Question:

Is the production workload issuer the in-account, CDK-managed KMS, Lambda and
API Gateway issuer (the staging mechanism with production names), or an
external issuer, for example in a separate security account? How does it
behave during an issuer outage (D2), and how is its public endpoint protected
(D3)? Secondary: does development get an issuer too, or stay non-functional
for service-to-service calls?

Decision:

D1, the issuer and key custody. Production uses the staging mechanism with an
independent production key, API, stage and `hid:production:<service>`
subjects:

- `WorkloadIdentity` (`infra/aws/src/workload-identity.ts`, renamed from
  `staging-workload-identity.ts`) is bound to one environment, `staging` or
  `production`. Each has its own retained P-256 `SIGN_VERIFY` key
  (`alias/hid-<env>-workload-signing`), log group `/hid/<env>/workload-issuer`
  (staging 14 days, production the production retention of one year), function
  `hid-<env>-workload-issuer`, REST API `hid-<env>-workload-identity` with stage
  `<env>`, issuer `https://<api>.execute-api.<region>.<suffix>/<env>` and
  subjects `hid:<env>:<service>`.
- Staging keeps construct ID `StagingWorkloadIdentity`, so its retained key
  keeps logical ID `StagingWorkloadIdentitySigningKey53DFD52F`.
- Both environments keep the six caller task roles and eleven caller/audience
  bindings, `execute-api:Invoke` on the exact `/<env>/POST/token` ARN, IAM-only
  `POST /token`, an unauthenticated `GET /.well-known/jwks.json`, no test
  invoke, and data trace and logging off.
- The key policy keeps the account root statement, so key administration stays
  with the account and the key cannot be locked out, and adds three Deny
  statements for `kms:Sign` (DEP-4-KEY): for every principal whose
  `aws:PrincipalArn` is not the issuer Lambda role, for any
  `kms:SigningAlgorithm` other than `ECDSA_SHA_256`, and for any
  `kms:MessageType` other than `RAW` (the issuer signs `RAW`; the TUF broker's
  `DIGEST` rule is not copied). Staging and production alike.
- A warm issuer re-reads the public key at least every five minutes and never
  caches a failed read, so a disabled key stops being published and stops
  minting within five minutes.
- The issuer and the agent accept only `staging` and `production` and derive
  one stage from it. The issuer URL path, every subject prefix, the API
  Gateway `requestContext.stage` (issuer) and the signed `/<stage>/token` path
  (agent) must all name that stage. A token of one environment fails the
  other's issuer, subject and stage checks.
- Receivers (Identity's service and document-scanner paths, Notification, Lab,
  Pharmacy and the EHR's OCR caller guard) accept only the token the issuer
  mints: ES256, `exp` and `iat` required, at most 300 seconds old, not issued
  in the future (5 seconds of clock tolerance, the agent's own allowance), and
  `token_use: workload`. They keep one remote JWKS set per process.
- Production token tasks get the `workload-token-agent` sidecar from the
  admitted Identity API image, exactly as staging, and receivers take the
  in-stack issuer, JWKS and exact caller subjects. Production loses the eight
  `WorkloadIssuerUrl`, `WorkloadJwksUrl` and `*WorkloadSubject` parameters.
  Synthesis fails for staging or production if a token task lacks exactly one
  rw `workload-token-agent` mount next to a read-only application mount.
- No local-secret fallback; production configuration already refuses one.

D2, behaviour during an issuer outage. An issuer outage stops a task's
service-to-service calls, not the task:

- The agent is `essential: false` with an ECS container restart policy
  (restart attempt period 60 seconds), and the application keeps its `HEALTHY`
  start dependency on it, so a task starts only with valid tokens.
- ECS restarts the agent only if it exits after running for at least the
  60-second restart attempt period. An agent that exits sooner (within a
  minute of the task's start or of its last restart) is not restarted: the
  task keeps running with no token writer until it is replaced, and the token
  files the agent last wrote stay after they expire, because only the agent
  removes them and the application mount is read-only. Once those tokens
  expire, calls fail closed, but a caller other than Identity's Notification
  client sends the expired token and its receiver answers `401` rather than
  the caller's missing-token `503`. The task shows the agent container
  `STOPPED`; no alarm routes that (D4). Remedy: stop the task so its service
  starts a new one (`AWS_DEPLOYMENT_RUNBOOK.md` §7).
- Once running, an unhealthy agent no longer makes ECS replace the task.
  Without tokens, service-to-service calls fail closed (`503`); Identity
  password sign-in and session reads keep working. Consequence: during an
  issuer outage, EHR record access, OTP delivery, Lab, Pharmacy, OCR and
  Outreach calls are unavailable while sign-in works.
- In JWT mode, Identity's Notification client sends nothing when its token file
  is missing or unusable or its token's `exp` has passed, logs
  `notification_workload_token_unavailable` with a reason (`missing`,
  `invalid` or `expired`) and a running count, without recipient, code or
  token, and counts it.
  An OTP is reported as not delivered, as before; an emergency-contact alert is
  reported as `unknown`, so its dispatcher retries it.

D3, edge protection for the issuer. Deny by default:

- `POST /token` and the JWKS `GET` each have their own method throttle (30
  requests per second, burst 60; at production normal maximum the six token
  services renew 74 caller/audience pairs every 90 seconds, 148 at the
  reviewed emergency maximum). There is no shared stage-wide `/*/*` setting.
- Every agent and receiver reaches the issuer through the VPC's NAT gateways
  (there is no `execute-api` interface endpoint). Wherever NAT gateways exist
  (staging economy and fidelity, production), a REGIONAL web ACL associated
  with the issuer stage blocks by default and allows only an IP set of the
  VPC's NAT gateway Elastic IPs, matched on the connection source, never a
  forwarded header. CDK's NAT gateway provider allocates one `AWS::EC2::EIP`
  per gateway in the stack, so the allowlist is built deterministically from
  them, and synthesis fails if a gateway uses any other address. Staging sleep
  has no NAT gateway and no running task, and no web ACL.
- The agent keeps the keys that verified its tokens by `kid` and fetches the
  JWKS only at start, for an unknown `kid` and after a cached key stops
  verifying, at most once every 30 seconds once a token has verified, so a
  JWKS outage, throttle or block does not stop renewal under a known `kid`.
  Until its first token verifies, the agent may fetch the JWKS on each
  10-second renewal retry, never faster: its health check (start period 30
  seconds, interval 10 seconds, three retries) turns it `UNHEALTHY` about 60
  seconds after start, and the application starts only on `HEALTHY`, so a
  JWKS failure at task start leaves about six attempts (at about 0, 10, 20,
  30, 40 and 50 seconds) rather than two.
- A PRIVATE API behind an `execute-api` interface endpoint was not chosen: its
  private DNS changes every `execute-api` name in the VPC. A per-IP rate rule
  was not chosen as the control: it does not stop a distributed flood, and all
  legitimate callers share the NAT addresses.

Alternative:

An external issuer that implements the same SigV4 `POST /token` contract (the
IAM caller names only an audience; the issuer returns an ES256 JWT) and
publishes a JWKS. The stack keeps `WorkloadIssuerUrl` and `WorkloadJwksUrl`,
runs the same agent pointed at it, and exports the six task-role ARNs for the
issuer's caller policy. It needs cross-account `execute-api:Invoke` and issuer
IaC that this repository does not have. It keeps signing-key custody out of
the workload account. Because Identity verifies the document scanner's token
against the same issuer and JWKS, such an issuer could also mint a scanner
subject, which the in-stack issuer cannot (Risks). Not chosen for launch.

Risks accepted:

- Same-account key custody. The key policy stops any principal other than the
  issuer role from signing, even one granted `kms:Sign` by IAM, but an account
  administrator can still change the key policy (`kms:PutKeyPolicy` through the
  root statement) or the issuer function (`lambda:UpdateFunctionCode`). Either
  change is recorded by CloudTrail. Containing administrators needs an SCP or a
  separate custody account, which is the account owner's decision. A minted
  token also passes Identity's Origin and CSRF exemption for delegated cookie
  reads (ADR-043, ADR-045).
- Kill switch latency. Receivers cache the JWKS for up to 10 minutes, so after
  the key is disabled and the JWKS withdrawn they still accept a token at most
  300 seconds old for that time. Someone with brief signing access could
  pre-sign tokens with future `iat` values; each becomes valid when its `iat`
  arrives, while receivers still trust the key. Only a new key (new `kid`)
  ends that (runbook §12, key disable).
- Single point of failure. All six token-bearing services depend on one
  issuer. Under D2 an outage longer than a token's lifetime stops their
  service-to-service calls, not the tasks; registration, recovery and EHR
  record access are unavailable for its length.
- The edge allowlist holds only while every caller leaves through the NAT
  gateways. A NAT gateway replaced by CDK gets a new Elastic IP in the same
  deployment, which updates the IP set. Any future caller outside the VPC,
  such as a document scanner (D5), must leave through the NAT gateways or be
  added to the allowlist by a reviewed change. In staging sleep the issuer has
  no web ACL; only its method throttles apply, and no task runs.
- No document-scanner token. Identity authorizes the malware-scan callback
  (`POST /ehr/documents/scan-events`, through
  `service/workloads/document-scanner/authorize`) with a JWT from the same
  issuer and JWKS whose subject must belong to an active `document_scanner`
  account. The in-stack issuer mints only the six service subjects. Production
  also loses `WorkloadIssuerUrl` and `WorkloadJwksUrl`. So, as in staging, no
  scan callback can authenticate: no document becomes `available` and
  `clean`, every download is refused and OCR cannot claim a job (DEP-4-SCAN,
  DOC-3, D5). (Later: ADR-055 closes the callback at the public gateway; the
  scanner calls ehr-api on its private service name.)
- Never run live: staging is not deployed, so no token has been minted against
  real IAM, KMS, WAF or API Gateway.
- The issuer code is a CDK file asset, not a TUF-admitted image digest
  (ADR-035); deployment evidence must bind its asset hash to the approved Git
  SHA.
- The regional alarms have no actions, so an issuer alarm would reach nobody;
  ADR-032 forbids an SNS topic without a workflow (D4). This change adds no
  alarm; the agent's `Workload token renewal unavailable` line and Identity's
  `notification_workload_token_unavailable` line are visible in logs only.
  (Later: ADR-053 adds the issuer and renewal alarms and routes every alarm
  to the environment's operational topic; Identity's line is still not
  alarmed.)

Preconditions for deployment (not for this decision):

1. A staging deployment authorization, staging redeployed with this change's
   issuer Lambda and Identity API image, and the live proof of
   `AWS_DEPLOYMENT_RUNBOOK.md` §7 recorded (I5): minting, renewal, expiry,
   removal before expiry, refusal of the wrong audience, subject and signature,
   no direct KMS signing by a caller or an IAM-granted administrator role, the
   web ACL's refusal of other sources, a JWKS and token flood of at least 30
   minutes with no renewal failure, and the issuer-outage (invoke-deny) test.
2. The production unlock approval (`TUF-STAGING-EXECUTION.md`), a production
   change approval and a production deployment authorization (I6, §12).

Follow-ups, not implemented by this change:

- D5 / DEP-4-SCAN (DOC-3), scanner callbacks: which malware scanner runs at
  launch and how it authenticates is the documents owner's decision. With this
  issuer, it needs a seventh caller rule (`hid:<env>:document-scanner` for the
  scanner's own IAM role), a change to the issuer's six-rule cap and to
  `bindCallers`, and a provisioned `auth.accounts` row holding
  `document_scanner`; or a separate scanner issuer. No service subject is
  reused.
- D4, alert routing for issuer errors, the agent's renewal failures and
  Identity's missing-token line.
- Key custody beyond the key policy (SCP or separate custody account), by the
  account owner.
- Internal Identity, EHR, Lab and Pharmacy routes stay reachable through the
  public gateway (DEP-4-KEY item d); that belongs to the gateway change.

Consequences:

- The production template grows from 414 to 438 resources and from 524,141 to
  574,128 bytes and falls from 62 to 54 parameters (`AWS_DEPLOYMENT_RUNBOOK.md`
  §1). It gains a fourth KMS key and a second web ACL (cost inventory
  `kmsKeys: 4`, `wafs: 2`). Eight task definitions get new revisions: the six
  token tasks (the agent added) and the Notification API and OCR worker
  (issuer, JWKS and subject values from the stack). Five task roles get a new
  default policy and the EHR's existing one gains the `execute-api:Invoke`
  statement.
- The staging templates change in the issuer Lambda asset, the key policy,
  the method settings and the agent's essential flag and restart policy, and
  economy and fidelity gain the issuer web ACL; staging must be redeployed and
  re-accepted.
- The agent ships in the Identity API image, so a new image digest must be
  admitted and run in staging and production. The receivers' token contract
  changes in the Identity, Notification, Lab, Pharmacy and EHR images; a
  development external issuer must mint the same token shape.
- Development stays unchanged and non-functional for service-to-service calls
  until it gets an issuer and a writer.
- The production execution plan is `AWS_DEPLOYMENT_RUNBOOK.md` §12, not
  approved.

Migration Impact: none.

Security Impact: only the issuer role can sign with the key, whatever IAM
grants, and only ES256 over `RAW` messages; receivers refuse any token the
issuer would not mint; the issuer stage refuses every source but the VPC's NAT
addresses. No task role gains more than `execute-api:Invoke` on its own
environment's `POST /token`. Residual risks are listed above.

Compatibility Impact: an agent or issuer from before this change refuses
`production` and still accepts the unchanged staging configuration, so a
production task with an older Identity API image never starts its
application. Receivers from this change refuse RS256 tokens, tokens without
`exp` or `iat`, tokens older than 300 seconds and tokens without
`token_use: workload`; the in-stack issuer mints none of those.

Related ADRs: ADR-025, ADR-032, ADR-033, ADR-034, ADR-035, ADR-043, ADR-045.


# ADR-048: Public Enrollment Checks Its Gate First, Bounds the HID Re-display and the Contact Proof, and Caps QoreID Lookups

Status: Proposed for source implementation
(D-Eminence/hid-system#68, migration 0085). Not merged or
deployed. The number may need renumbering when the parallel launch branches
merge.

Date: 2026-10-13

Context:

- Public enrollment start read whether a NIN was bound or pending, and
  answered `409 NIN_ALREADY_REGISTERED`, before it asked whether QoreID and
  NIN-only enrollment were enabled or QoreID was paused; those checks sat
  inside the provider's `verifyNin`. A bound or pending NIN therefore got
  `409` and every other NIN `503`, whatever the gate's state (ENR-4). A unit
  test pinned that order.
- The enrollment cookie let `GET /current` and an activation replay show the
  HID until it expired, 24 hours after start, on the enrolling device,
  including a shared one (ENR-3 Part B). A verified contact could wait up to
  24 hours before the password step (ENR-3b).
- QoreID NIN lookups are paid. The account-scoped 0049 quota cannot charge an
  enrollee with no account, and nothing else bounded them (IP-1).
- Production accepted `QOREID_NIN_ONLY_ENROLLMENT_ENABLED` whenever QoreID was
  on, although decision N1 requires proof that the caller holds the NIN's
  registry phone before a NIN is bound, and that step is not built (CFG-PROD).

Decision (owner defaults: deny by default, least exposure; decisions N1 and
N2 in `PHASE_3_LAUNCH_DECISIONS.md`):

- Start asks the gate (`PublicPatientIdentityProvider.assertAvailable`: both
  flags, then the runtime pause of `qoreid`/`patient_nin`) after the Origin,
  Turnstile, signed-in-session and input checks and before any rate bucket or
  registration read. The gate reads no NIN, so while it is closed every NIN,
  and a same-key resume, gets the same `503`. `verifyNin` keeps the checks.
  Telling only a proven holder that a NIN is registered is step 2 of ENR-4,
  with N1.
- The HID is re-displayed for 15 minutes after activation (N2(b)). Every
  successful activation response expires the enrollment cookie; Identity
  treats an active enrollment activated more than 15 minutes ago (or with no
  activation time) as unknown (`404 ENROLLMENT_NOT_FOUND`) on every
  enrollment route, and the activation command refuses such a replay
  (`P0002 PATIENT_ENROLLMENT_REPLAY_EXPIRED`).
- A contact proof is valid for 30 minutes (N2(c)). With an older one,
  activation clears the proof and the contact by the database clock, returns
  the enrollment to `verify_contact` and answers
  `409 ENROLLMENT_CONTACT_REVERIFY_REQUIRED`; the activation command refuses
  it too (`23514 PATIENT_CONTACT_REVERIFY_REQUIRED`), and Identity resets and
  answers the same way.
- Each QoreID NIN lookup of public enrollment is charged, after the gate and
  immediately before the request, by `platform.consume_public_patient_nin_quota`,
  an accountless `SECURITY DEFINER` command modelled on 0063: a keyed digest
  of the client network (IPv4 address or IPv6 /64) per hour and per day, and
  a platform-wide daily cap. The limits are environment values
  (`PATIENT_ENROLLMENT_QOREID_*`, defaults 5, 15 and 200) bounded by the
  command; the owner sets the cap from the QoreID contract. A refusal is
  committed with its audit event and answered `429
  VERIFICATION_QUOTA_EXCEEDED`; any fault is `503`. A resume, a duplicate and
  any earlier refusal cost nothing.
- Identity refuses to start with `QOREID_NIN_ONLY_ENROLLMENT_ENABLED=true`
  in production (`HID_DEPLOYMENT_ENV=production`, or `NODE_ENV=production`
  outside the staging profile) until the N1 holder step ships; that change
  lifts the refusal.

Consequences:

- While the gate is closed the NIN oracle is closed. While it is open, a
  bound or pending NIN is still revealed to anyone who knows it, and each
  probe of an unbound NIN costs a QoreID lookup, bounded by the quota; this is
  why NIN-only enrollment stays refused in production until N1.
- A patient whose activation response is lost and who returns after 15
  minutes cannot see the HID through the enrollment again. Until HID delivery
  (N2(a)) ships, the HID is shown only in the activation response, and
  Health-id must keep it on screen.
- A patient who waits more than 30 minutes at the password step proves the
  contact again. Health-id must route
  `409 ENROLLMENT_CONTACT_REVERIFY_REQUIRED` to the contact step; a reload
  already lands there, because `GET /current` answers `verify_contact`.
- Until the edge delivers the real client address (IP-1), every client behind
  one load balancer node shares one network budget, so the per-network limits
  can deny real enrollments; the platform cap bounds cost either way. A
  carrier-grade NAT address is one network too.
- The platform cap bounds cost, not availability. Every lookup counts toward
  it, whatever QoreID answers, so with the defaults 14 networks (IPv4
  addresses or IPv6 /64s) passing Turnstile can spend the day's 200 lookups
  with unregistered NINs, and 40 networks can do it within one calendar hour.
  Every enrollment start that needs a lookup then answers
  `429 VERIFICATION_QUOTA_EXCEEDED` until the next day bucket; resumes and
  the later enrollment steps are unaffected. The owner sizes the cap with that
  in mind, and operations alert on audit events
  `identity.public-patient-enrollment.nin-lookup-quota` with outcome `denied`
  and `exhaustedLimit` `platform_day` (release checklist §10).
- The Identity build needs 0085 and the role bootstrap first: without the
  command and its grant every start that reaches QoreID answers `503`. An
  earlier Identity running with 0085 (between the migration and the Identity
  rollout, or after an Identity rollback) cannot handle the stale-proof
  refusal: it answers `409 ENROLLMENT_STAGE_INVALID` and has no way back to
  the contact step, so that patient cannot activate until the enrollment
  expires, 24 hours after its start. Identity is deployed right after 0085
  and the bootstrap to keep that window short.
- Evidence is local and synthetic: unit specs, the two new SQL suites,
  `runtime-roles.integration.sql` and `verify-patient-enrollment-runtime.mjs`
  (release checklist §8). Nothing has been run on staging or production.

Related: ADR-008; ADR-023; `INTERFACE_CONTRACT.md`;
`QOREID_VERIFICATION_CONTRACT.md`; `DATABASE.md` ("Public enrollment
windows and NIN lookup quota (0085)"); release checklist §2, §3, §5, §6, §8
and §9.

# ADR-049: Clinicians Are Provisioned Only by Platform Governance; One Active Membership per Facility

Status: Accepted for launch with the owner's default policy (launch decision
D14, workforce part, and N5), in D-Eminence/hid-system#70,
migration 0087. Not merged or deployed. The number may move when the launch
branches merge.

Date: 2026-10-13

Context:

- The only code that created staff, memberships and facility roles was the
  organization onboarding (0046, 0048, 0061), and each created one
  `org_admin`. `org_admin` holds `organization.manage`, `workforce.manage`,
  `audit.read`, registration and Outreach permissions, and no
  `identity.patient.read`, `identity.consent.write` or `ehr.*`. No route
  granted a clinical role, and `workforce.manage` was used nowhere. A facility
  onboarded through the product therefore had no clinician, and the only ways
  to create one were the legacy promotion (for hid-1.0 clinicians, under an
  operator's cutover authorization) or SQL, which is a production bypass
  (launch register WF-1).
- The facility administrator is provisioned self-service on a CAC lookup and
  an administrator email only. Letting that administrator grant clinical roles
  would let it invite a second address it controls and make it a doctor.
- `staff_memberships_scoped_uq` (0002) allowed one active membership per role
  at a facility, so one account could hold two active memberships there (for
  example `org_admin` and `doctor`). The staff context listed both, ordered
  them with no tie-break, and every guard bound the first match, so the bound
  membership, its permissions and its consent grants could change from one
  request to the next (N5). Every disagreement failed closed, but a clinician
  in that state could not work reliably. Only the legacy promotion or SQL can
  create such rows; whether any exist (operator plan I4) is unknown.

Decision:

- Clinical facility roles are granted only by platform-governed commands
  (0087), run by a platform administrator holding the new permission
  `platform.workforce.manage`. Like the other high-risk platform permissions
  added since 0069 (`platform.principal.export`, `platform.mfa.reset`), it is
  granted to `platform_super_admin` only. `org_admin` stays non-clinical, keeps
  no route that grants a role, and a membership holding `org_admin` or `admin`
  cannot also receive a clinical role (`WORKFORCE_ROLE_CONFLICT`). Facility
  self-service workforce management is deferred; the facility-scoped
  `workforce.manage` still authorizes nothing.
- Every command needs an MFA-verified platform session, a TOTP step-up from
  the last five minutes, a reason and an `Idempotency-Key`; those that change
  an existing staff record or membership need `If-Match`. Each is a SECURITY
  DEFINER function that repeats the permission, MFA and step-up checks, so the
  Identity runtime cannot skip them, and each new command is audited with
  platform scope.
- Attach: an existing staff identity, or a new one created by email and name,
  is attached to a verified facility. The membership is created inactive
  (`pending`) and grants nothing. A new account is `pending_reset` with no
  password and a new staff record is `pending`: nobody but the clinician ever
  knows the password, which they set through the staff account recovery flow.
- Attest: a platform reviewer records a professional-credential attestation
  for a staff identity: the clinical roles the reviewed licence supports (of
  `doctor`, `clinician`, `nurse`), the licence reference, the issuing
  authority, the method, the evidence reference, the reviewer and a lapse date
  at most three years ahead. The only method at launch is `manual_review`, a
  documented manual review of the practitioner's licence. A `pending` staff
  record becomes `verified`. Attestations are append-only.
- Grant: exactly one clinical role on exactly one membership, named with its
  facility. It needs a current attestation for that role by a reviewer who is
  not the target, has no active membership at that facility (so not its
  `org_admin`) and is not the granting administrator. A clinical role
  therefore always takes two platform administrators, the two-person
  pattern of 0070 (ADR-038) without a separate request table: the
  attestation is the first person's act and the grant the second's. The
  grant is refused for the
  caller's own membership, by a caller who works at that facility, and for a
  membership at another facility than the one named. The first grant activates
  a pending membership. Granting is limited to `doctor`, `clinician` and
  `nurse`; `lab` and `pharmacist` stay withheld with their modules at launch
  (D17) and can still be revoked.
- A role granted on an attestation is effective only while the attestation is
  current: when it lapses the staff context and
  `auth.membership_has_permission` stop counting the role
  (`auth.facility_role_is_effective`). Roles granted by onboarding or the
  legacy promotion are unaffected.
- Renewal: a role rests on the one attestation it was granted on, and a later
  attestation does not extend it by itself. To keep a clinician effective, a
  reviewer records a new attestation and a second administrator grants the
  role again. That grant renews the role when its attestation has lapsed, or
  before the lapse when the new attestation lasts longer: the old assignment
  is revoked with the grant's reason and a new one rests on the new
  attestation (`renewed: true`), with the same two-person and facility rules.
  Otherwise a grant of a held role is still `WORKFORCE_ROLE_ALREADY_ACTIVE`; a
  role granted by onboarding or the legacy promotion never lapses and is never
  renewed. This rejects letting any later attestation keep a role effective,
  which would let the granting administrator, or an administrator who works at
  the facility, extend a role by attesting alone.
- The staff actor's facility roles (`actor.facilities[].roles`, the token's
  `roles` claim, the Health-id staff badges) are the codes of the
  membership's live, effective role assignments, the same rows its
  permissions come from. A revoked or lapsed role disappears from both. The
  stored `membership_role` and `app_role` labels are no longer read for the
  actor; they keep the role the membership was activated with and still show
  in the principals list.
- End: a membership is deactivated for good. Its facility roles are revoked,
  its pending access requests expire, every active consent grant bound to it
  is revoked (requests before grants, so an approval that commits while the
  end waits on its request has its new grant revoked too), and, when it was
  active, every staff session of the account is revoked (a staff session is
  not bound to a facility in the schema). An ended membership can never be
  changed again, so a grant still bound to it can never become usable; to give
  the person access again, attach them again. An access request created and
  committed concurrently, after the end has read the pending requests, stays
  pending on the ended membership and authorizes nothing, and neither does a
  grant approved from it.
- Lock order: every command locks the target's and the actor's account rows
  FOR UPDATE in id order (0073), then the membership or staff row it changes
  FOR NO KEY UPDATE. Those updates change no key column, and a foreign-key
  insert that references the row (an approval's consent grant, an access
  request) takes FOR KEY SHARE, which FOR NO KEY UPDATE does not block. A
  FOR UPDATE membership lock deadlocked with an approval waiting on its
  request and with a staff transaction that went on to reference its own
  account (found in review; both races now run in the platform admin
  verifier).
- N5: one active, unheld membership per account and facility, enforced by a
  unique partial index. Several roles at one facility are several role rows
  on that one membership. If a database already holds duplicates the
  migration stops, changes nothing and names operator plan I4: the migration
  administrator lists them, the facility confirms which to keep, and the
  extras are deactivated by a reviewed change, never deleted and never by
  moving their consent grants (that would change whom a patient's consent
  covers). This rejects "pick the oldest". The staff context also fails
  closed with `409 FACILITY_MEMBERSHIP_AMBIGUOUS` if two memberships of one
  facility are ever read, and orders by membership id last. The legacy
  promotion refuses duplicates before it writes anything, whether the other
  binding is another staged row or an active, unheld membership the target
  already holds.

Consequences:

- A new facility has only its `org_admin` until two platform administrators
  provision its clinicians. Launch therefore needs at least two MFA-enrolled
  Super Admins (as 0070 already does for Super Admin elevation).
- Granting a clinical role does not give PHI by itself: the clinician still
  needs a patient's consent (request and approval, or the patient's PIN) for
  each patient.
- Staff MFA is not part of this decision; a separate change adds it. Until it
  ships, a clinician's sign-in is single-factor (launch register MFA-1).
- External dependencies: product and legal owners decide which verification
  source counts (the regulator's registry or documented manual review) and who
  may act as reviewer; adding a registry method needs a later migration. If
  launch relies on migrated hid-1.0 clinicians, an operator authorization for
  the legacy cutover is still needed, and I4 must be run before 0087 on any
  database the promotion has written.
- Patients whose consent grants sit on a membership deactivated under I4 must
  consent again.
- A clinician whose attestation lapses loses the role's permissions until an
  administrator renews it; administrators should renew before the lapse date
  that the workforce profile shows.
- The evidence is local and synthetic: `workforce-provisioning.integration.sql`
  (with mutation checks), `runtime-roles.integration.sql`, the Identity specs,
  `membership-duplicates.test.mjs`, `verify-membership-duplicates-runtime.mjs`
  and the workforce path of `verify-platform-admin-runtime.mjs`, including the
  two-connection lock races (release checklist §8). Nothing has been run on
  staging or production.

Related: ADR-037 (platform administration scope); ADR-038 (platform MFA,
step-up and two-person elevation); `INTERFACE_CONTRACT.md` §19 (Workforce
provisioning) and the auth session contract (Staff facility binding);
`DATABASE.md` (Governed workforce provisioning (0087)); release checklist §2,
§5, §8 and §9; `PHASE_3_LAUNCH_DECISIONS.md` D14 and N5.
Extended by ADR-066 (clinician self sign-up with two-admin approval;
reserved attestations; grants pinned to the step-1 attestation).
# ADR-052: Health-id Is the Single Launch Frontend; Only Its Hosts Are Deployed

Status: Accepted (2026-10-13) with the owner's defaults (deny by default, least
privilege, verified identity for sensitive operations, auditable actions, no
production bypass). Acceptance authorizes no deployment: Cloudflare and AWS
changes need their own authorization, and nothing has been deployed.

Date: 2026-10-13. Change: D-Eminence/hid-system#67 (launch register
FE-HOST, including MOD-EDGE).

Amends: ADR-033 (seven Cloudflare frontend Workers, each serving a hid-system
application). Extends ADR-037's note that Health-id is the authoritative admin
frontend to what is deployed.

Context:

- `hid-web` served hid-system's legacy `apps/web` on www and staging, and
  `hid-admin` served the legacy `apps/admin` on admin.*. `apps/web` still calls
  about 30 retired `/api/v1/functions/*` routes, which the gateway answers with
  `404`, and `apps/admin`'s staff sign-in is refused by the platform-scoped
  admin endpoints (ADR-037). Only Health-id implements the governed
  access-request loop and the platform console the backend now serves.
- Health-id `apps/patient-web` is one Vite portal: patient routes at `/`, the
  provider workspace at `/provider/*` and the platform console at `/admin/*`.
  Its cookie mode is same-origin: it needs `/api/v1` on its own host, with
  `VITE_HID_API_BASE_URL` and `VITE_HID_APP_ORIGIN` both that host's origin.
  Identity's Turnstile allowlist accepts the full browser action set only on
  www and staging, and `admin-login` and `admin-reset` on admin.*.
- Health-id had no deployment definition, and `verify-config.mjs` required a
  `manifest.webmanifest` and `service-worker.js`, which Health-id deliberately
  lacks: it registers no service worker and keeps no clinical data in browser
  storage.
- Every frontend Worker proxies all of `/api/v1`, so not deploying a host does
  not close its API.

Decision:

1. Health-id `apps/patient-web` is the single launch frontend for www
   (production), staging (staging) and admin.* (both). hid-system's legacy
   `apps/web` and `apps/admin` stay in this repository, built and tested, but
   are not deployed.
2. Each host gets its own build: `VITE_HID_ENVIRONMENT` names the environment;
   `VITE_HID_API_BASE_URL` and `VITE_HID_APP_ORIGIN` are both exactly
   `https://<host>`; `VITE_HID_TURNSTILE_SITE_KEY` is the environment widget's
   site key; `VITE_HID_GOOGLE_CLIENT_ID` is unset (Google sign-in is off,
   REC-GOOGLE) and so is `VITE_HID_SENTRY_DSN` (no error-reporting processor
   is approved).
3. A build reaches a Worker only through
   `infra/cloudflare/scripts/stage-health-id-build.mjs`. It refuses a build
   that breaks rule 2, or that holds anything but `index.html` and
   content-hashed files under `assets/`, a source map or `sourceMappingURL`, a
   service worker or web app manifest, a Google sign-in reference (the Google
   Identity Services loader or calls, or a Google OAuth client id: Health-id
   inlines `VITE_HID_GOOGLE_CLIENT_ID` as a bare value where it is used, so
   these markers are the check), or a credential-shaped value. Its
   `index.html` must be exactly the shell Vite writes, checked against an
   allow-list of elements and attributes: one module entry script, and
   scripts and links that name only `.js` and `.css` files of the build's own
   `/assets/`; anything else, including `base`, `style`, inline handlers,
   `meta http-equiv` and markup it cannot parse exactly, is refused. It writes
   the build to the Worker's git-ignored `staged/<environment>/site` with
   `provenance.json` beside it, never inside the served directory: the
   Health-id source commit, every file's SHA-256, a tree hash and the inlined
   public environment record (the five keys of `src/publicEnvironment.ts`).
   On a refusal it writes nothing, and it replaces an existing destination
   only when that is an earlier artefact of the same Worker and environment.
   `npm --prefix infra/cloudflare run verify:launch:<environment>`
   re-verifies every staged artefact against its provenance and the same
   rules before a deployment, and the Wrangler dry-run runs it first. It
   checks every Worker configuration but needs no legacy `apps/<app>/dist`
   build of a Worker the launch does not deploy.
4. Launch subset, deny by default (`infra/cloudflare/launch-deployment.json`):
   staging and production deploy `hid-web` and `hid-admin`, and production
   also the originless apex redirect. `hid-ehr` (the legacy `apps/ehr`;
   clinicians use `/provider/clinical` on www or staging), `hid-lab`,
   `hid-pharmacy`, `hid-ocr`, `hid-ocr-redirect` and `hid-outreach` are not
   deployed. The TUF repository Workers stay with their protected publication
   (ADR-035). `verify-config.mjs` holds the same decided subset and requires
   every configured Worker to be classified once, so widening the launch
   changes two reviewed files and needs its own decision.
5. API closure for deferred modules stays with the gateway route switch
   `HID_ENABLED_API_ROUTES` (ADR-033 addendum, D-Eminence/hid-system#65); the
   manifest records it and a test keeps it equal to `launchApiRoutes`.
6. `frontend-worker.mjs` is unchanged: host and environment binding,
   `X-Real-IP`, security headers and `/api/v1` proxying. No Content Security
   Policy is added: the Worker sets none for any frontend today, and Health-id
   needs none to work (it loads its own `/assets/` and the Turnstile script
   from `challenges.cloudflare.com`). Until an edge CSP is added, the staging
   step's `index.html` allow-list (rule 3) is what keeps the shell to the
   build's own files. An edge CSP is later hardening, with its own tests.

Consequences:

- Once staged and deployed, www, staging and admin.* serve Health-id; the
  legacy builds and their retired routes are no longer served. The Health-id
  team supplies the four builds (or the commit an operator builds); no
  Health-id code change is needed.
- www serves the portal, not Health-id's Next.js public site
  (`apps/public-web`: public pricing and demo requests), which is not deployed
  at launch. The portal's `index.html` is `noindex, nofollow`, so www is not
  indexed. Deploying the public site needs its own decision, host and
  artefact rules.
- Frontend rollback restages the previous accepted commit's build for that
  host, re-verifies it and redeploys that Worker; no API image or schema
  changes.
- The signed release-bundle frontend contract (`release/config/components.json`
  `frontends`, and `frontend_archive.required_files` with a manifest and a
  service worker) still describes the seven legacy builds and cannot carry the
  Health-id artefact. Until it is extended, a frontend deployment's release
  record is the verified staged artefact and its provenance.
- On www, legacy `GET /migrate*` and `/ocr*` paths still answer `308` to the
  Migrate host, which is not deployed; Health-id has no such routes.
- The regional stack's `browserSubdomains` (Identity `CORS_ORIGINS`) and
  Identity's Turnstile allowlist still name all seven hosts. Same-origin
  cookie sessions use no CORS, and no Worker serves the other hosts; narrowing
  both is separate work.

Migration Impact: none. No database, grant or API contract change.

Security Impact: deny by default at the edge (five product hosts and the legacy
redirect not deployed, and the legacy EHR host withheld); the APIs of deferred
modules stay closed at the gateway. Only a build that is bound to its own host
and environment, has no Google client, no source maps, no service worker and
no unexpected files, and is recorded with its source commit and hashes, can be
served.

Compatibility Impact: a deployment that still points at `apps/web/dist` or
`apps/admin/dist` fails `verify-config.mjs`. Bookmarks to the legacy
applications' routes on www or admin.* land in Health-id's single-page
application.

Related ADRs: ADR-033, ADR-035, ADR-037. Launch module set: D17
(`PHASE_3_LAUNCH_DECISIONS.md`).

# ADR-053: Production Alarms Reach a Person; Production Starts at Zero Tasks; Launch OTP Is Email and SMS Only

Status: Accepted (owner policy defaults for launch decision D4 and the
launch module set D17); not deployed

Date: 2026-10-13

Change: D-Eminence/hid-system#66 (register INFRA-COUNT, D4, the code
part of NOTIF-PROD, CFG-PROD, and the preflight parts of I1 and REC-GOOGLE).

Context:

- None of the regional stack's 47 alarms had an action and the CDK defines no
  dashboard, so an alarm reached nobody. The workload issuer had no alarm, the
  token agent reports a failed renewal only as a plain-text stderr line, and
  notification-api logged no OTP outcome. D4's proposed default, "dashboards
  only", was not even implemented, and would leave issuer, renewal and OTP
  failures unseen. ADR-032 forbids an SNS topic without a workflow; release
  trust (ADR-035) already routes its alarms to a pre-existing environment
  topic validated by exact ARN.
- Every production `*DesiredCount` defaulted to 2, with the autoscaling
  minimum equal to it, contradicting ADR-032 (counts default to zero until the
  prerequisites pass) and the I6 rollout, in which the reviewed parameter file
  raises counts.
- In production, notification-api required SES plus the Termii, Meta and
  Brevo fields (the `full` profile) and the CDK injected eleven provider
  fields, although launch (D17) sends OTP only by email and SMS.

Decision:

1. **Alarms reach a person (D4).** Each environment's alarms notify one
   operator-created SNS topic, `hid-<env>-operational-alerts`, encrypted with
   a customer-managed KMS key whose policy lets `cloudwatch.amazonaws.com`
   use it (CloudWatch cannot publish through the AWS-managed `alias/aws/sns`
   key) and subscribed by the on-call recipients the operations owner names.
   The CDK does not create the topic. The synth input
   `HID_OPERATIONAL_ALARM_TOPIC_ARN` names it by exact ARN
   (`arn:<partition>:sns:<region>:<account>:hid-<env>-operational-alerts` and
   nothing else). Production refuses to synthesize without it; elsewhere it is
   optional, and without it alarms have no action. A stack bound to an account
   and region (`HID_AWS_ACCOUNT`, `HID_AWS_REGION`) refuses a topic in
   another, and the action is built from the deploying account, region and
   partition, so an alarm can only notify its own environment's topic. Every
   alarm in the regional stack, the workload issuer's included, notifies the
   topic on ALARM and on OK, and the stack outputs the topic ARN.
   New alarms: the issuer Lambda's `Errors` and `Throttles` (at least 1 in
   5 minutes); the issuer stage's `5XXError` (at least 1) and `4XXError` (at
   least 20; REST API Gateway publishes no separate 429 metric, so throttled
   requests are counted there); `TokenRenewalUnavailable` (at least 3 in
   5 minutes), counted by a literal-text metric filter for the agent's exact
   line `Workload token renewal unavailable` on each enabled token task's log
   group; and `OtpDefinitiveFailures` (at least 3 in 5 minutes), counted from
   notification-api's `notification.otp.outcome` lines whose `outcome` is
   `definitive_failure`. "Dashboards only" is rejected.
   The running-task alarms of the enabled services treat missing data as
   breaching with a threshold of at least 1. During the zero-task rollout
   (decision 2) the five production ones (`GatewayRunningTaskAlarm`,
   `IdentityApiRunningTaskAlarm`, `EhrApiRunningTaskAlarm`,
   `NotificationApiRunningTaskAlarm` and `EventDispatcherRunningTaskAlarm`)
   therefore enter ALARM and notify the topic on the first deploy, and
   notify again on OK once each service runs its live minimum. That is
   accepted and announced to the recipients beforehand: the alarm is true
   (the service serves nothing), and an alarm that followed the desired
   count would stay silent if a reviewed parameter file left an enabled
   service at 0 by mistake.
2. **Production starts at zero tasks (INFRA-COUNT, D17).** Every production
   `*DesiredCount` defaults to 0 and keeps its live minimum and recommended
   count in its description. The autoscaling minimum follows it, so nothing
   runs until the reviewed I6 parameter file raises each enabled service to
   at least its live minimum; ADR-034's "never scales to zero" applies from
   then on. A module outside the enabled set is pinned at 0 tasks in every
   environment: Lab, Pharmacy, OCR (API and worker) and Outreach unless the
   synth input `HID_ENABLED_API_ROUTES` names them, and the notification
   worker unless `HID_NOTIFICATION_WORKER_ENABLED` (default true outside
   production; production fixes it to false until a Novu account and region
   are approved, and a disabled worker reads no `novuApiKey`). Its desired
   count and scaling ceiling allow only 0, its scaling target has no policy,
   and it has no running-task, log-volume, request, OCR or queue alarm, which
   would otherwise sit in ALARM or watch nothing. Staging and development keep
   their profile defaults for enabled modules; a staging acceptance run opts a
   module in with `HID_ENABLED_API_ROUTES`, as before.
3. **Launch OTP is email and SMS only (NOTIF-PROD).** notification-api's
   `otp-email-sms` profile sends email OTP through SES and SMS OTP through
   Termii: it requires `SES_FROM_ADDRESS` and the three Termii fields,
   refuses any WhatsApp configuration and any WhatsApp send, and treats Brevo
   as an optional fallback. Production requires that profile and refuses
   `full`, `email-only` and a local service token. The CDK gives production
   (and development) that profile and injects only `sesFromAddress`,
   `termiiBaseUrl`, `termiiApiKey` and `termiiSenderId`; staging keeps
   `email-only`. Every OTP send writes exactly one PHI-free JSON line,
   `notification.otp.outcome`: channel, purpose, outcome (`accepted`,
   `retryable_failure` or `definitive_failure`), the provider that answered
   last (`none` for a refused send), whether the fallback ran, the response
   `requestId` as correlation id and an allowlisted safe code, and, when the
   fallback ran, the primary provider and its allowlisted safe code
   (`primaryProvider`, `primarySafeCode`); never the recipient, the code,
   the message or provider text. A send the service refuses or cannot route
   counts as a definitive failure. Migration 0047 seeds Brevo as an enabled
   email and SMS fallback, and Identity plans an enabled fallback; with no
   Brevo field injected it answers `not_configured`. Before ingress a
   platform administrator pauses Brevo through the audited
   `POST /admin/integrations/brevo/pause` (release checklist P21), so that
   Identity plans no fallback and a definitive SES or Termii failure is
   reported as the primary's.
4. **Configuration cannot re-enable a bypass (CFG-PROD).** In production EHR
   refuses static S3 keys and the AWS SDK's environment keys
   (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, which
   its S3 client's default credential chain reads before the task role), and
   the OCR worker refuses static AWS keys, as Notification, the notification
   worker and the event dispatcher already did. Every service that calls AWS
   therefore refuses static keys from its environment in production, and
   the task definitions give each service only its ECS task role. The synth
   input `HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED` (default false, refused
   unless `HID_QOREID_ENABLED=true`) sets Identity's
   `QOREID_NIN_ONLY_ENROLLMENT_ENABLED`, and a production synth refuses
   `true` (the regional stack too, however its configuration was built):
   NIN-only enrollment proves that a NIN exists, not that the caller holds
   it. The change that ships N1's registry-phone holder step lifts this
   refusal together with Identity's own production refusal, which belongs to
   the enrollment change; until both ship, production cannot enable the flag
   whatever the merge order.
5. **A production preflight (I1, REC-GOOGLE).**
   `scripts/production-external-preflight.py` is the production counterpart of
   the staging-only preflight: read-only, value-free checks of the auth,
   Identity sensitive and notification provider secrets, the five Identity
   keys, `googleOidcClientIds` present and empty (Google sign-in off), SES
   production access and DKIM, and the alarm topic, whose key it resolves
   with `kms describe-key` (customer managed, enabled, in the topic's account
   and region; any spelling of the AWS-managed `alias/aws/sns` key fails) and
   whose default key policy must allow `cloudwatch.amazonaws.com`
   `kms:Decrypt` and `kms:GenerateDataKey`. The repository fixes no
   production account, so the approved `HID_AWS_ACCOUNT` and `HID_AWS_REGION`
   are required inputs; the staging account is refused.

Consequences:

- Production cannot be synthesized without the topic's ARN. Before any
  production deploy an operator creates the key, the topic and the
  subscriptions, and the operations owner names the on-call recipients
  (external dependency; release checklist P15 and P16).
- The production template has 31 alarms (47 before; the alarms of the modules
  that are off are gone, the issuer, renewal and OTP alarms are new) and 16
  metric filters, every alarm with an action. It changes in its parameter
  defaults and ranges and in the notification-api and identity-api task
  definitions; record a new production template baseline
  (`AWS_DEPLOYMENT_RUNBOOK.md` §1).
- Production deploys with every service at 0 tasks; the first scale-up is an
  I6 parameter-file change. A parameter file that raises a module that is off
  fails CloudFormation validation. Until each enabled service is scaled, its
  running-task alarm is in ALARM and has notified the on-call recipients
  (decision 1).
- Staging and development: the modules that are off now default to 0 tasks
  and cannot be raised without opting them in; development notification-api
  runs the `otp-email-sms` profile.
- No WhatsApp OTP, no Brevo fallback (paused, P21, and given no key), no
  NIN-only enrollment and no Novu-based patient notifications in production
  at launch.
- Residual risks: a token agent that stops, rather than failing renewals,
  writes no renewal line, so nothing alarms until callers fail; Identity's
  `notification_workload_token_unavailable` line (an OTP that never reached
  notification-api) is not alarmed; no alarm has fired against a real topic.

Migration Impact: none.

Security Impact: deny by default. A module that is off cannot run;
production refuses static AWS keys, a local service token, WhatsApp, every
OTP profile but `otp-email-sms` and NIN-only enrollment; an alarm can reach
only its own environment's topic. The outcome line and the preflight receipt carry no secret, recipient,
code or message.

Compatibility Impact: a production synth needs the new input and refuses
`HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED=true`; a production notification-api
started with `NOTIFICATION_DELIVERY_PROFILE=full`, Meta or WhatsApp
configuration, or a local service token, and a production EHR started with
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or `AWS_SESSION_TOKEN`, now
refuse to start. The outcome line gains `primaryProvider` and
`primarySafeCode` when the fallback ran; its other fields are unchanged.

Related ADRs: ADR-032, ADR-033, ADR-034, ADR-035, ADR-047.

# ADR-054: Every Staff Session Is MFA-Verified; a First Enrolment Needs a Fresh Proof

Status: Proposed for source implementation (D-Eminence/hid-system#71,
migration 0088). Not merged or deployed.

Date: 2026-10-13

Context:

Launch decision D14 (`PHASE_3_LAUNCH_DECISIONS.md`) asked whether staff MFA is
a launch gate (MFA-1). Before this change a staff session was issued on the
password alone (`POST /auth/login`, provider enrollment activation, and a
staff Google exchange), and every EHR, Lab, Pharmacy, OCR and Outreach check
accepted it. Platform administration already required TOTP (ADR-038,
0069/0070). The owner defaults decide it: verified identity for sensitive
operations, deny by default, no production bypass.

Decision:

- Every staff session is MFA-verified, with no permission or role allowlist.
  The password step answers only a challenge cookie; the session and its
  `auth.session_assurance` row are issued after a TOTP code or one unused
  recovery code, through `TokenService.issueStaffSession`, the only path to a
  staff session. `TokenService.issue` issues patient sessions only.
- An account has one factor, recovery codes and assurance table for platform
  and staff sign-in alike (0069 tables). A challenge carries its kind
  (`session_kind`, 0088) and is accepted only by its own sign-in.
- A first enrolment needs a fresh proof, never the password alone: a code
  emailed to the account address (keyed digest bound to the challenge), or the
  provider enrollment activation that opened the challenge in the same request
  (its email was verified by that enrollment). The email code goes to
  `auth.accounts.email` without requiring `email_verified_at`: no flow marks a
  staff address verified (provisioning and onboarding set the work address,
  and staff password recovery already sends to it), so the code proves
  control of that address. Requiring a verified address would refuse every
  staff enrolment that provider activation does not open.
- The proof belongs to the factor: staff enrolment records it on the new
  factor (`enrollment_proof`, `enrollment_challenge_id`), and only a factor
  that records one verifies a staff sign-in. The database refuses to consume
  a staff enrolment challenge that records no verified proof, to record a
  proof on a factor without such a challenge of its account, and to give a
  staff session assurance on a factor without one
  (`STAFF_MFA_FACTOR_UNPROVEN`). It cannot check the emailed code; Identity
  does.
- Platform first enrolment stays trust on first use (ADR-038) for an
  administrator without a staff membership, and its factor verifies platform
  sign-in only. A platform first enrolment of an account with an eligible
  staff membership is refused (`409 MFA_ENROLLMENT_STAFF_SIGN_IN_REQUIRED`):
  it enrols at staff sign-in with the proof and uses that factor for both. A
  factor enrolled at platform sign-in before 0088, or before the account held
  a staff membership, is refused at staff sign-in (`403
  STAFF_MFA_FACTOR_UNPROVEN`) until a two-person MFA reset.
- Staff second-factor failures count, per source address, in a budget of
  their own: the 100th failed staff code from one address in 15 minutes
  blocks staff codes from it, apart from platform sign-in's 20. The
  per-account budget (the fifth failure) is unchanged and shared.
- A staff session without live assurance is authorized for nothing:
  `SecurityGuard` answers `403 STAFF_MFA_REQUIRED` and refresh ends the
  sign-in. Every staff session issued before the deploy is therefore
  invalidated at deploy, with no data migration. Sign-out still works.
- Google sign-in is for patients only: `/auth/oidc/exchange` refuses any staff
  action (`403 GOOGLE_STAFF_SIGN_IN_DISABLED`). With `AUTH_MODE=oidc`, staff
  tokens carry no assurance and are refused.
- OTP password recovery keeps the factor (0086 `auth.complete_recovery_otp`,
  pinned). A lost authenticator is reset only by the two-person MFA reset
  (0070), which already reaches staff accounts.
- Enrolment, recovery-code use and an MFA reset are audited, and offered after
  commit to an owner notice sink (`MFA_NOTICE_SINK`); delivery waits on the
  notification route.

Alternatives not taken:

- A permission allowlist (MFA only for some clinical permissions): every staff
  session reaches patient data through some route, and an allowlist drifts.
- Trust on first use for staff enrolment, as platform enrolment still is: a
  stolen password would then become a staff session on any unenrolled account.
  For the same reason a platform-enrolled factor never verifies a staff
  sign-in.
- Accepting the email code at staff sign-in to upgrade a platform-enrolled
  factor: one more sign-in state in the staff portal for a few administrators,
  when the two-person reset already covers them.
- Refusing the email-code proof after a mailbox password recovery of an
  account without a factor: accounts provisioned without a password
  (organization onboarding, 0046; governed workforce provisioning, 0087) set
  their first password by that recovery, and no other enrolment channel
  exists, so every newly provisioned clinician would be locked out.
- The platform per-address budget (20) for staff sign-in: the clinicians of a
  facility often share one address, so a few accounts' failures would refuse
  every correct code from that facility for 15 minutes.
- Letting existing sessions finish their lifetime: they would keep reaching
  patient data for up to 24 hours without MFA.

Consequences:

- Every staff member signs in again after the deploy and enrols on first
  sign-in; the Health-id staff portal must implement the challenge, the email
  code, enrolment (QR from `otpauthUri`, recovery codes once) and the
  `STAFF_MFA_REQUIRED` re-sign-in before the Identity build is deployed
  (release checklist §3). The in-repo `apps/ehr`, `apps/admin` and `apps/web`
  clients still expect a session from `/auth/login` and are not launch
  frontends.
- `MFA_SECRET_KEY_B64` is now required for staff sign-in as well
  (`503 MFA_UNAVAILABLE` without it); operator plan I1 must run first.
- Residual risk: for an account without a factor, the mailbox alone is
  enough. Staff password recovery (`staff-reset`) and the enrolment code use
  the same address, so whoever controls the mailbox can set a password and
  enrol; accounts provisioned without a password set their first one that
  way. Once an account has a factor, a mailbox alone never yields a staff
  session. Notices to that mailbox cannot warn of its compromise. Until a
  second enrolment channel exists (an open decision under D14, for example
  an out-of-band code issued by the provisioning administrator), existing
  clinical accounts enrol before clinical roles are enabled and operators
  review enrolments that followed a recovery (release checklist P22).
- Self-signed-up clinicians (ADR-066) enrol before review, and step 1 of
  their review confirms the authenticator outside the mailbox: the applicant
  reads a live code to the reviewing Super Admin during the identity call.
- Evidence is local and synthetic: unit specs, `staff-mfa.integration.sql`,
  `verify-staff-mfa-runtime.mjs` and every runtime verifier that signs staff
  in (release checklist §8). Nothing has been run on staging or production.

Related: ADR-038; ADR-040; ADR-044; `INTERFACE_CONTRACT.md` (Auth session
contract); `PHASE_4_STAGE_2A_BACKEND_SECURITY.md` §10; `DATABASE.md` (0088);
release checklist §2, §3, §5, §8 and §9.

# ADR-057: Closed Registration Says So, and a Public Read Tells Clients Before They Ask for a NIN

Status: Proposed for source implementation
(D-Eminence/hid-system#68, FE-4, no migration). Not merged or
deployed. It builds on ADR-048 (the enrollment gate). The number may need
renumbering when the parallel launch branches merge (ADR-054 to ADR-056 and
ADR-058 are taken on other launch branches).

Date: 2026-10-13

Context:

- Under N1 Identity refuses `QOREID_NIN_ONLY_ENROLLMENT_ENABLED=true` in
  production, and infrastructure leaves QoreID off by default, so every
  production enrollment start answers `503 QOREID_NIN_ONLY_DISABLED` or
  `503 QOREID_DISABLED`. Facility-assisted registration is off at launch
  (D17), so no new patient can get a Health ID; legacy-migrated patients
  sign in.
- Health-id 82b474e links to `/enroll` from sign-in and learns this only
  after the patient types a NIN and spends a Turnstile token. It shows a
  problem's `detail` as sent, but the authored "temporarily unavailable"
  text never reached it: Identity's problem filter replaced every 5xx
  detail with "The service could not complete the request.", and the
  gateway then replaced every upstream 502/503/504 with
  `503 UPSTREAM_UNAVAILABLE` "A required platform service is temporarily
  unavailable.", which is what the patient saw until ADR-055
  (D-Eminence/hid-system#72) made the gateway pass upstream errors
  through. Either text is wrong for this case: the closure is a decision,
  not an outage.

Decision (owner defaults: deny by default, least exposure, no production
bypass):

- `503 QOREID_DISABLED` and `503 QOREID_NIN_ONLY_DISABLED` keep their status
  and codes and carry "New Health ID registration is not open yet. If you
  already have a Health ID, sign in." They are raised as
  `PublicDetailProblem`, the only 5xx whose detail the filter keeps; every
  other 5xx detail is still replaced.
- `GET /api/v1/identity/patient-enrollments/availability` answers
  `{ "open": boolean }` from the checks start makes before it reads a NIN
  (enrollment keys, both flags, the runtime pause), through the same
  provider method, so the two cannot disagree. A fault reading the runtime
  state is a `503`, not `false`; a client treats anything but
  `200 { "open": true }` as not open.
- It is public and takes no input. Every caller that reaches it gets the
  same answer and it carries no PHI, so it writes no audit row (as
  `GET /commercial/pricing`): a row per anonymous read would let anyone
  grow the audit log without bound and records nothing about a person.
  For the same reason Identity keeps no per-network counter for it; the WAF
  rate rule covers it as every API request. It may be cached for 30 seconds (`public, max-age=30`); the
  Cloudflare Worker still makes every API response `no-store` at the edge,
  which this change does not relax. Identity's CORS policy is unchanged and
  applies first, as on every route: a request with no `Origin` or one in
  `CORS_ORIGINS` is answered, and a foreign `Origin` is refused by the CORS
  middleware (`500`, no CORS permission; `403 ORIGIN_DENIED` since
  D-Eminence/hid-system#76, ADR-059) before the route.
- `PublicDetailProblem` is the one exception to Identity's 5xx detail
  masking. It takes only a fixed sentence written for the person using the
  client, never a message built from an error or from request data; any
  new use needs its own decision.
  ADR-066 adds `503 CLINICIAN_SIGNUP_CLOSED` ("Clinician sign-up is not open
  yet. If you already have a Health ID provider account, sign in.").

Consequences:

- Enrollment stays closed in production; this changes what the patient is
  told, not who may enroll. Opening it needs N1's holder step (ENR-4 step 2)
  or an owner decision to the contrary.
- Until Health-id reads availability, each production start attempt is a
  target 5xx on the gateway's load balancer target group (the gateway
  reaches Identity by its Cloud Map name), counted by the gateway's
  `TargetErrorAlarm` (at least 5 in 5 minutes, two periods), which routes to
  a person under ADR-053 (infra on main). Health-id should read availability
  before it shows the NIN step and the "Get your Health ID" link.
- When this was decided the gateway replaced every upstream 502/503/504
  with `503 UPSTREAM_UNAVAILABLE`. Since ADR-055 (D-Eminence/hid-system#72,
  merged) it passes upstream errors through, so the new detail reaches the
  browser.
  The availability read is a `200` and works either way.
- Health-id follow-up (ENR-2): on completion, ask the patient to save the
  Health ID, because the activation response expires the enrollment cookie
  and `GET .../current` re-displays the HID for 15 minutes only.
- Evidence is local and synthetic: unit specs and step 19 of
  `verify-patient-enrollment-runtime.mjs` (release checklist §8); the gateway
  route was checked against main's gateway model in a scratch copy.

Related: ADR-048; ADR-053; ADR-055; `INTERFACE_CONTRACT.md` (section 6;
section 8, "Public patient enrollment"); `QOREID_VERIFICATION_CONTRACT.md`;
`PHASE_3_LAUNCH_DECISIONS.md` (N1); release checklist §2, §3 and §8.

# ADR-055: Edge and Gateway Hardening for Launch: Scoped WAF Body Rule, Per-Client WAF Rate Limit, Upstream Errors Passed Through, Portal CSP and HSTS, Query-Free Access Log, Scanner Callback Closed

Status: Accepted (owner policy defaults: deny by default, least privilege,
auditable actions, no production bypasses); not deployed

Date: 2026-10-13

Change: D-Eminence/hid-system#72 (register WAF-CRS-BODY, the
non-Identity part of A7, A8, D6, D7, SCAN-EDGE/EDGE-DOCS; IP-THRESHOLDS
documented), including its review follow-up (error log, per-network WAF key,
CI runtime check, upload CSP dependency). ADR-054 is taken by the unmerged
launch/staff-mfa branch.

Context:

- **WAF-CRS-BODY.** The public API web ACL ran `AWSManagedRulesCommonRuleSet`
  with its defaults. Its `SizeRestrictions_BODY` rule blocks every body over
  8 KB, but ehr-api accepts clinical note content up to 100,000 characters
  (512 KiB JSON) and Health-id's note editor allows 100,000. A clinician
  saving a long note got a WAF `403` with a non-JSON body and the note was
  not saved.
- **A7 (WAF part).** The rate rule aggregated by the connecting address. Every
  connection to the ALB comes from the Cloudflare Worker, so all users behind
  one Cloudflare egress address shared 2,000 requests per 5 minutes: one
  script through the Worker could block sign-in, EHR and OTP for everyone on
  that address. The application path was fixed by #65 (`X-Real-IP`).
- **A8.** With `proxy_intercept_errors on`, the gateway's `error_page 502 503
  504` replaced every backend 502/503/504 with `503 UPSTREAM_UNAVAILABLE`,
  dropping the code, `Set-Cookie`, `Retry-After` and `X-Correlation-ID`, so
  Health-id could not tell maintenance, MFA, Turnstile, enrollment or
  delivery outages apart.
- **D6.** The portal hosts sent no Content-Security-Policy and no HSTS.
- **D7.** The gateway inherited the image's `main` access-log format, which
  logs `$request`: the whole request line, so administrator search terms
  (names, emails, HIDs) in query strings reached CloudWatch for a year.
- **SCAN-EDGE/EDGE-DOCS.** `POST /api/v1/ehr/documents/scan-events`, the
  document scanner's workload-authenticated callback, was public through the
  gateway while uploads and the scanner are off; each anonymous call cost an
  EHR-to-Identity call and audit rows.

Decision:

1. **Scoped WAF body rule (WAF-CRS-BODY).** `SizeRestrictions_BODY` counts
   (and labels) instead of blocking. A rule right after the group,
   `AwsCommonRulesBodySize`, blocks a labelled request unless it is a `POST`
   or `PATCH` whose raw path (no transformation) is an encounter-scoped
   clinical write: `/api/v1/ehr/patients/<uuid>/encounters`, `/<uuid>`, and
   its `clinical-notes` (with `/<uuid>/revisions`), `diagnoses`,
   `prescriptions` and `lab-requests` (with `/<uuid>`), lowercase UUIDs only.
   These carry 100,000-character notes or 4,000-character fields that exceed
   8 KB in multi-byte text; vitals carry no free text and keep the limit.
   Every other Core Rule Set rule keeps blocking. The bound for the exempt
   routes is the gateway's `client_max_body_size 512k` with a Problem Details
   `413 PAYLOAD_TOO_LARGE` (the ehr-api JSON limit; identity-api refuses more
   than 256 KiB itself).
2. **Per-client WAF rate limit (A7).** The Worker sends
   `X-HID-Client-Network`, derived from `CF-Connecting-IP` and always
   replacing a caller's value: the IPv4 address, or the canonical network
   address of the IPv6 /64 (`2001:db8:4:5::`), with IPv4-mapped IPv6 counted
   as IPv4, as Identity's own limits count a client network. `X-Real-IP` keeps
   the full address. `ApiOriginRateLimit` aggregates on `X-HID-Client-Network`
   (`FORWARDED_IP`, fallback `MATCH`): rule 0 has already refused anything
   without the Worker's origin secret. Keyed on the full IPv6 address, one
   client could rotate addresses inside its /64 and never reach the limit.
   The limit stays 2,000 per 5 minutes, now per client network.
   `ApiOriginEdgeRateLimit` (50,000 per 5 minutes per connecting address) is
   the backstop for a leaked secret or a request without the header. The
   gateway forwards neither the origin secret nor the client network to any
   backend. Identity's MFA bucket (the other part of A7) is a separate
   change.
3. **Upstream answers pass through (A8).** `proxy_intercept_errors` is removed.
   `error_page 502 503 504 = @upstream_unavailable` still answers bounded
   `503 UPSTREAM_UNAVAILABLE` when nginx itself gets no answer (refused,
   reset, timed out, unresolved, closed without a response).
4. **Portal CSP and HSTS (D6).** Every frontend Worker response carries
   `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains` or
   preload until every subdomain is confirmed HTTPS-only). `hid-web` and
   `hid-admin` (the Health-id build) send `default-src 'none'; script-src
   'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self'
   data:; font-src 'self'; connect-src 'self'
   https://challenges.cloudflare.com; frame-src
   https://challenges.cloudflare.com; worker-src 'none'; object-src 'none';
   base-uri 'none'; form-action 'self'; frame-ancestors 'none';
   upgrade-insecure-requests`, derived from the 82b474e build output and
   Turnstile's `api.js`. API and edge answers send `default-src 'none';
   frame-ancestors 'none'`. The policy is enforced, not report-only: the
   build was run through the Worker in headless Chromium with no violation.
   The undeployed legacy product hosts get no page policy until they have
   their own. `hid-web` grants no camera or microphone.
5. **Query-free logs (D7).** The gateway logs its own JSON format
   (`hid_api`, `escape=json`) to the image's access-log path: time, client
   address, method, path (`$uri`), status, bytes, request and upstream timing,
   upstream status, `request_id` and `X-Correlation-ID`. It never records the
   request line, arguments, referrer, cookies or credentials. The server's
   error log takes only critical messages (`error_log
   /var/log/nginx/error.log crit`): nginx appends the request line and the
   upstream URL, query string included, to every error or warning about a
   request (a refused, reset, timed-out or unresolved upstream, a body over
   512 KiB, a body buffered to a temporary file, which every clinical write
   over 16 KiB is), and the image's notice-level error log is the container's
   stderr, in the same CloudWatch log group.
6. **Scanner callback closed (SCAN-EDGE).** The gateway answers
   `/api/v1/ehr/documents/scan-events` with `404 API_ROUTE_NOT_FOUND` in every
   spelling, like the other service-to-service routes. The scanner (D5, I7)
   calls ehr-api on its private service name when uploads ship.
7. **IP-THRESHOLDS** stays a documented decision: the Identity per-network
   limits (5 per 15 minutes) and the WAF per-client-network limit are
   unchanged at launch. They are raised if the `ip`-scope 429 rate or the
   `hid-<env>-origin-rate` metric shows NAT collisions: the Identity limits by
   their configuration, the WAF limits only by a reviewed CDK change to
   `API_ORIGIN_CLIENT_RATE_LIMIT` (and `API_ORIGIN_EDGE_RATE_LIMIT`), which are
   code constants.
8. **Gateway runtime check in CI.** `scripts/verify-gateway-runtime.mjs
   --built-image` builds `gateway/Dockerfile` (no push) and runs the shipped
   configuration under the nginx of that image, which is the base the
   Dockerfile pins by digest plus its own layers (RF-008); it is the `gateway-runtime` step of
   `release/scripts/run-workspace-gates.mjs`, which the required workspace
   job of `tuf-local-gates.yml` runs, so the pass-through, body bound, header
   strips and both logs are checked against real nginx on every change, not
   only against the nginx model.

Consequences:

- Clinicians can save notes up to the service limit through the edge; a body
  over 512 KiB answers `413 PAYLOAD_TOO_LARGE` Problem Details. The other CRS
  body rules inspect only the first 8 KB of a long note (an ALB limit).
- One client network (an IPv4 address or an IPv6 /64) over the rate limit is
  blocked alone; a busy facility or carrier NAT address counts as one client.
  Traffic spread across many networks (a botnet, or a client holding many
  IPv4 addresses or /64s) is limited per network only; if it passes 50,000
  requests per 5 minutes through one Cloudflare egress address, the backstop
  blocks every user behind that egress address for the rest of the window.
  That is the shared throttle A7 removed, now only for traffic 25 times the
  old limit.
- Browsers now see a service's own 5xx code and any `502`. A refresh that
  fails with a 5xx now reaches the browser with its cookie-clearing
  `Set-Cookie`; before, a `503` dropped it, the browser kept a possibly spent
  refresh token, and the next refresh could revoke the sign-in as reuse. A
  refresh `500` already passed through. Keeping cookies on a 5xx is A6
  (Identity), still open; this change adds no new sign-out path.
- A Health-id release that loads a new script, frame or connection origin
  (Sentry, Google sign-in, analytics) must change the policy in the same
  release, or the browser blocks it.
- Gateway logs can no longer answer "which query did this request carry";
  audit rows remain the record of administrative reads. They no longer say
  why nginx got no upstream answer (refused, timed out, unresolved): the
  access log's status, `upstream_status` and `upstream_time` remain. A
  critical nginx message about a request (it cannot write a temporary file,
  or cannot open an upstream connection for a reason other than refusal or an
  unreachable network, such as exhausted local ports) still carries the
  request line; those mean a broken or overloaded task and are rare.
- Document uploads (off at launch, D17) need a CSP change when they are
  switched on: Health-id 82b474e `PUT`s the file straight to the presigned
  S3 URL from the upload intent (`packages/http/src/upload.ts:60`, called from
  `apps/patient-web/src/staff/api.ts:1089`), which `connect-src 'self'
  https://challenges.cloudflare.com` blocks. The release that enables uploads
  (D5, P11) adds the documents bucket's exact S3 origin to `connect-src` for
  `hid-web` and `hid-admin` in the same reviewed change. Downloads open the
  presigned URL with `window.open` (`Clinical.tsx:890`), which `connect-src`
  does not govern.

Migration Impact: none.

Security Impact: deny by default. The body exemption is limited to the
clinical write routes by method and raw path; the rate limit no longer lets
one client network, IPv6 address rotation included, exhaust an egress
address (traffic over the 50,000 backstop from many networks still can); a
portal XSS has no script, frame or connection origin beyond the site and
Turnstile; administrator search terms leave the access and error logs except
in a critical nginx message about the request; the origin secret and the
client-network key stay at the edge; one more service route is closed at the
edge. Authentication, authorization, CSRF and Origin checks,
RLS and audit are unchanged.

Compatibility Impact: Health-id 82b474e needs no change: it loads only its
own assets and Turnstile, calls only its own origin except the presigned
document upload (uploads are off at launch; see Consequences), never calls
`scan-events`, and already branches on specific codes and treats other 5xx
generically. Operators keep Cloudflare Pseudo IPv4 off or in "add header"
mode. Staging confirms the WAF behaviour (a 20,000-character note answers
`201`; 2,100 requests from one client block only that client) and a browser
sign-in with the real Turnstile widget and no CSP violation.

Related ADRs: ADR-033, ADR-047, ADR-052, ADR-053.

# ADR-056: Retracting an Encounter Needs the Records' Write Permissions; Closed Orders Are Final; Allergies Are Not Recorded at Launch

Status: Accepted (owner policy defaults for register items ENC-RETRACT-1,
ENC-RETRACT-2 and ALLERGY-1); not deployed

Date: 2026-10-13

Change: D-Eminence/hid-system#74, migration 0090 (register ENC-RETRACT-1, ENC-RETRACT-2,
RX-FINAL, ORDER-CLOSED-EDIT, A9-EHR, A17-EHR-AUDIT and ALLERGY-1).

Context:

- Since 0084, cancelling an encounter cancels its open orders and marking it
  entered in error retracts its notes, diagnoses and orders. Both ran for
  anyone holding `ehr.encounter.write`: per-record write permissions were
  checked only on each record's own routes, and row-level security checks the
  patient's consent, not the role. A nurse (no diagnosis or prescription
  write) could retract a doctor's confirmed diagnosis and active prescription,
  and a legacy receptionist (encounter write only) could retract notes they
  cannot read. Retraction is irreversible and hides notes from the patient.
- A vital had no status and a completed order no retraction, so a
  wrong-patient encounter left its vitals and medication history as valid
  chart data; a completed, cancelled or entered-in-error prescription still
  accepted new instructions, frequency and end date, and the database let a
  cancelled one become active again.
- The EHR records no allergies, while `DATABASE.md` described an allergy table
  as current.

Decision:

1. **Who may retract (ENC-RETRACT-1).** Cancelling or retracting an encounter
   needs the write permission of every kind of record the close changes:
   `ehr.note.write`, `ehr.diagnosis.write`, `ehr.vital.write`,
   `ehr.prescription.write`, `ehr.lab-request.write`, `ehr.document.write`.
   This is the least-privilege reading of the owner defaults: the cascade may
   do only what the actor could do record by record. No new permission is
   introduced. The EHR API refuses with `403 ENCOUNTER_RETRACTION_NOT_PERMITTED`
   before writing anything and audits the refusal with the missing permission
   codes. The response carries a fixed detail and does not name them: only a
   kind of record the encounter holds is checked, so the names would tell a
   caller (a receptionist reads none of these records) which kinds of record
   the encounter holds. The database refuses the same close (`42501`) through
   `auth.membership_has_permission`, which the EHR runtime may now execute.
   An encounter holding none of these records may be cancelled or retracted
   with `ehr.encounter.write` alone. The proposal of a new
   `ehr.encounter.retract` permission (doctor and clinician only) was not
   taken: it would let a doctor retract through the encounter what no route
   lets them write, and it would need its own grant governance.
2. **What a retraction covers (ENC-RETRACT-2).** Marking an encounter entered
   in error also marks its final vitals, its completed prescriptions and lab
   requests, and its linked documents entered in error, in the same
   transaction. A vital can be entered in error on its own
   (`POST .../vitals/:vitalId/entered-in-error`, `ehr.vital.write`, with a
   version, a reason and an audit event), and a completed prescription or lab
   request may move to `entered_in_error`. Nothing is deleted. A vital entered
   in error takes no further change, not even a new correction row, and is
   left out of the emergency summary; a document entered in error takes no
   further change, so it is never available or served again; the patient
   summary releases neither vitals nor orders. The database enforces both
   (`ehr.require_final_vital`, which reads the vital `FOR SHARE` so a
   correction cannot commit beside a retraction it did not see, and
   `ehr.keep_retracted_document`).
3. **Closed records are final (RX-FINAL, ORDER-CLOSED-EDIT).** A completed,
   cancelled or entered-in-error prescription or lab request takes no change
   except completed to `entered_in_error`; status changes follow the order
   transitions; a cancelled or entered-in-error encounter takes no change.
   The services answer `409`, and 0090's triggers refuse the same writes.
4. **Refusals are audited (A9-EHR, A17-EHR-AUDIT).** A clinical command refused
   inside its transaction is audited after the rollback with its status and
   code, never clinical content; refusal rows carry the status and code
   answered; a staff session on the patient's own records route is refused in
   the guard and audited instead of answering `503`.
5. **Allergies (ALLERGY-1).** Structured allergy capture is not in scope for
   launch. No allergy table is added. A clinician records an allergy as a
   diagnosis (ICD-10 `Z88.x`) or in a note; no prescription is checked against
   it. `DATABASE.md` §7 lists only implemented tables, and a documentation test
   keeps it so.

Consequences:

- Marking entered in error: a nurse or receptionist who opened an encounter
  on the wrong patient asks a doctor or clinician to retract it once it holds
  a diagnosis or an open or completed prescription; a nurse may still retract
  one holding only notes, vitals and documents, and a receptionist only one
  holding none of the records a retraction changes. Cancelling: anyone with
  `ehr.encounter.write` may cancel an encounter whatever notes, vitals,
  diagnoses and documents it holds, unless it holds an open prescription
  (then doctors and clinicians only) or an open lab request. Records already
  entered in error and cancelled orders block nothing. Health-id `82b474e`
  still offers the actions to every `ehr.encounter.write` holder and shows
  the refusal's detail, now a fixed sentence (frontend follow-up: offer them
  by permission, and correct `ORDERS_NOT_CANCELLED`).
- No role holds `ehr.lab-request.write` (0084), so an encounter that still
  holds a lab request cannot be cancelled or retracted until Lab ordering is
  enabled again by its own migration; none can be created at launch.
- The rule follows record kinds, not authorship: a nurse may retract a
  doctor's signed note through the encounter, as on the note route. Narrowing
  that is a clinical owner decision.
- Prescribers get no structured allergy check at launch.
- One new runtime privilege: `EXECUTE` on `auth.membership_has_permission` for
  `hid_ehr_runtime`; the role bootstrap must run right after 0090.

Related ADRs: ADR-047, ADR-053.

# ADR-058: Modules That Are Off Hold No Permissions; the Launch Database Starts in the Launch State; Patients See Who Gets Access and When Their PIN Is Used

Status: Proposed for source implementation
(D-Eminence/hid-system#75, migration 0091). Not merged or
deployed.

Date: 2026-10-13

Context:

Decision D17 turns Lab, Pharmacy, OCR and Outreach off at launch, D9 keeps
break-glass off, and document uploads are off (no scanner). The gateway
refuses the off modules' routes, but 0084 withdrew only the Lab and Pharmacy
writes: every clinical role kept the modules' reads, OCR and Outreach
permissions, `identity.break-glass.write` and `ehr.document.write`, so
Health-id offered workspaces, actions, emergency access and an upload card that
fail (MOD-PERM-OCR-OUTREACH, FE-17, FE-15). The controls `uploads_enabled`,
`outreach_portal_enabled` and `break_glass_enabled` were seeded on and turned
off only by an operator (P11, UPLOADS-DEFAULT-ON). The patient-self
row-level security trusted transaction settings without a relational check
(PSELF-RLS). Patients approved and reviewed access seeing only a facility,
though a grant goes to one clinician (CONSENT-GRANTEE), and were not told when
a clinician used their access PIN, because the only consumer of that event,
the notification worker, is off (NOTIF-PIN-NOTICE). Owner defaults: deny by
default, least privilege, explicit and informed patient consent, auditable
actions, no production bypass.

Decision:

- No role holds a permission of a module that is off: 0091 deletes every
  `lab.*`, `pharmacy.*`, `ocr.*` and `outreach.*` permission,
  `identity.break-glass.write` and `ehr.document.write` from every role,
  `ocr_worker` included, reversing 0084's choice to keep reads. The EHR's
  own permissions stay. The bootstrap role assertions require it.
  Re-enabling a module, on staging too, is a reviewed migration that grants
  its permissions again (with its decision and fixes) and changes the
  assertions with it; break-glass also needs the `emergency` purpose and its
  control (D9). There is no staging-only re-grant: the bootstrap runs the
  assertions on every run and refuses a role holding a withdrawn permission,
  so a permission granted by hand on staging stops every later staging
  bootstrap; and a ledger migration applies in every environment, so the
  re-enabling migration is a production decision too. Production then stays
  closed for Lab, Pharmacy, OCR and Outreach by the gateway route switches
  (`HID_ENABLED_API_ROUTES`, `identity,ehr` in production) and desired counts
  of 0 (ADR-053), and for Outreach also by `outreach_portal_enabled`; uploads
  and break-glass live in modules that are on, so there only their controls
  (and, for break-glass, the absent `emergency` purpose) keep them closed. A
  module's staging acceptance (release checklist S4b, S4c, S4g) therefore runs
  after its re-enabling migration; until then the runtime verifiers exercise
  it by granting the permissions inside their disposable copies.
- Document uploads are off by the permission, not only by the control:
  upload intent and completion answer `403` for every role, and completion
  now also checks `uploads_enabled` (`409`), so an upload in flight when the
  control is turned off does not complete.
- The launch database starts with the three launch controls off: 0091 sets
  each off only while it is exactly as 0039 seeded it, so an administrator's
  own setting is never overwritten. Mechanism chosen over the alternatives:
  a column default would not change the seeded rows; a control event needs an
  acting account, which a migration does not have, and inventing a system
  account would put a fabricated actor in the audit trail. As for 0041, the
  row records the change (version, reason naming 0091, no updating account)
  and the migration ledger records when it ran; an administrator turns a
  control on again through the audited `POST /admin/controls`. Because the
  table forces row-level security, the migration lifts forced security for
  its own transaction; otherwise a non-superuser administrator (RDS) would
  silently update nothing.
- The patient-self context is bound in the database: `ehr.patient_self_context`
  becomes a security-definer check that the named patient, account, subject
  and live session match `identity.patient_self_session`, under the same
  owner check (P8) as the other definer commands.
- Consent names the grantee: the patient's request list and access history
  carry the requesting clinician's display name and membership role (staff
  identities, not PHI); the history reports `truncated`. The staff list,
  which withholds the patient id until a grant is active, is unchanged.
- The patient is told in the app when their PIN is used: an inbox item per
  new PIN grant, written in the PIN transaction, without the notification
  worker. SMS and email notices wait for an approved notification channel.
  (Amended by ADR-064: email through Novu is approved, behind
  `NOVU_SUBSCRIBER_SYNC`, off by default and refused in production; the
  inbox item is unchanged.)
- Pending access requests do not yet lapse (ACCESS-REQ-STALE): deferred.
  A lapse needs request creation (0086), which reuses a pending request, the
  approval command and both lists to change together, beyond this change's
  scope. Risk until then: a patient can approve an old request and grant the
  clinician current access. Mitigations: the request now names the clinician,
  approval needs a recent sign-in (0086), a membership that ends expires its
  pending requests (0087), and the patient can revoke the grant.

Alternatives not taken:

- Health-id build flags hiding modules (FE-17 option B): a frontend-only
  switch leaves the permissions usable by any other client and needs a
  Health-id change; the permission withdrawal works with Health-id 82b474e as
  it is. A capability signal for break-glass (FE-15 option B) remains a later
  frontend option.
- Keeping `ocr.job.process` on `ocr_worker`: nothing checks it, and keeping it
  would make the launch assertion carry an exception for a workload that is
  off.
- Only the operator step P11 for the controls: the launch would depend on a
  manual action by a platform administrator holding an MFA session; P11 now
  checks the state instead. The check reads the controls through
  `platform.control_enabled`, as every guard does, because the table's forced
  row-level security hides its rows from the migration administrator on RDS.
- An environment-scoped exception in the bootstrap's role assertion (staging
  may hold a withdrawn permission): a switch that lets a database hold the
  permissions of an off module is a production bypass carried by
  configuration, against the owner default.

Consequences:

- Doctors, clinicians and nurses no longer see Laboratory, Pharmacy, Document
  OCR, Outreach, released Lab results, Extract with OCR or the upload card,
  and the Emergency method is disabled with a permission explanation
  (Health-id 82b474e, unchanged). Lab and Pharmacy data are unreadable through
  Health-id until re-granted; a launch database holds none.
- Staff session permission lists shrink at once: Identity resolves a staff
  session's roles and permissions from the database on every request, so a
  session issued before 0091 loses them on its next request.
- The patient's access-request list is unavailable (`403`) between 0091 and
  the role bootstrap that follows it. An Identity build of this change needs
  0091's request-list columns: it must not start before 0091 and the
  bootstrap, and a restore of a pre-0091 backup takes Identity back to the
  previous build (otherwise the list answers `500`).
- With 0090 (ADR-056, D-Eminence/hid-system#74), whose
  retraction guard requires `ehr.document.write` to mark an encounter entered
  in error while it holds an initiated or uploaded document, no role can do
  that until uploads are re-enabled (`403 ENCOUNTER_RETRACTION_NOT_PERMITTED`);
  cancelling such an encounter is unaffected. A database on which no upload
  was ever started, as the launch production database is expected to be,
  holds no such document; a staging database might. 0090's
  `encounter-retraction.integration.sql` grants the nurse role
  `ehr.document.write` in its rollback-only transaction once both changes are
  on one branch (release checklist §2).
- Staff display names become visible to patients for requests and grants
  about them.
- Evidence is local and synthetic: SQL suites, unit specs and the runtime
  verifiers on a PostgreSQL 16 cluster built from empty to 0091 (release
  checklist §8). Nothing has been run on staging or production.

Related: ADR-041 (P8 owners); ADR-045 (Outreach campaign governance);
`PHASE_3_LAUNCH_DECISIONS.md` (D9, D17); `INTERFACE_CONTRACT.md` (launch
module set, patient self-service, document upload completion);
`DATABASE.md` (0091); release checklist §1, §2, §3, P10, P11, §5, §8, §9.

## ADR-058 addendum: break-glass permitted at launch with limits (0097); on only after the P11 operator step

Status: Decided by the owner on 2026-10-14 (D9, "turn on with limits").
Source implementation proposed (migration 0097, branch
`claude/break-glass-launch`, D-Eminence/hid-system#83); not merged or
deployed. Written as 0092, then 0093, then 0095, it is numbered 0097, after
0093 and 0094 of D-Eminence/hid-system#84 and #85 (ADR-062, ADR-063) and
0095 and 0096 of D-Eminence/hid-system#90 and #91 (ADR-064, ADR-065), which
change neither the break-glass permission, the purpose-of-use vocabulary nor
the platform controls. The platform control is
production configuration and is not changed here: it is an operator step.

Date: 2026-10-14

Context:

ADR-058 kept break-glass off at launch: 0091 withdrew
`identity.break-glass.write` from every role and started `break_glass_enabled`
off, and no `emergency` purpose of use existed (0082 seeded only
`direct-care`). It also set how a module comes back: a reviewed migration that
grants its permissions again and changes the role assertions with it, applying
to every environment; for break-glass, also the `emergency` purpose and the
control. The owner has now decided D9 for launch: break-glass is on, with
limits. One reviewed migration grants the permission again and seeds the
purpose; an operator turns the control on after staff MFA ships. Direct care
is unaffected.

Decision:

- 0097 grants `identity.break-glass.write` to exactly the roles that held it
  before 0091: doctor, clinician and nurse (0010; no other migration granted
  it to another role). It seeds `emergency` ("Emergency treatment", active,
  source `hid`) with `ON CONFLICT (code) DO NOTHING`, as 0082 seeded
  `direct-care`, so an operator's row, active or not, is kept. Nothing else
  0084 or 0091 withdrew is granted, and `healthcare-operations` stays unseeded
  (N3). The rest of the activation and summary path was never withdrawn:
  `identity.consent.write`, `identity.patient.read` and the EHR reads.
- The role assertions change with it: exactly those three roles hold
  `identity.break-glass.write`. Any other holder, a missing one, or any other
  permission 0084 or 0091 withdrew still stops the bootstrap.
- The control stays the operator's. 0097 leaves `break_glass_enabled` as 0091
  left it (off where still seeded; a migration has no actor for a control
  event), and refuses to run while it is on (`55000 BREAK_GLASS_CONTROL_ON`,
  nothing changed): 0091 kept a value an administrator had set, and granting
  the permission with the control on would make break-glass live at 0097's
  commit, before staff MFA. The administrator sets it off with
  `POST /admin/controls` and `migrate` runs again. Before the first role
  bootstrap the migration administrator cannot read the control (forced
  row-level security, `PLATFORM_CONTROL_UNAVAILABLE`); no runtime role exists
  then, so the control is as 0091 left it, and 0097 goes on. A platform
  administrator turns it on with the audited
  `POST /admin/controls` (MFA platform session, TOTP step-up, reason,
  `If-Match`) once staff MFA has shipped: Identity runs with 0088 in that
  environment and Health-id signs staff in with an authenticator (FE-2), so
  every session that can activate break-glass is MFA-verified (ADR-054), and
  P22 is done. Until then activation answers `423 BREAK_GLASS_DISABLED` and
  writes no grant and no `identity.break-glass.*` audit row, only the
  request's own `api.identity.break-glass.command` failure row (release
  checklist P11).
- Limits, unchanged here and accepted for launch:
  - the emergency summary covers the activating facility only, and the chart
    routes stay closed to the emergency purpose: break-glass cannot open the
    full chart, and an emergency room that never treated the patient sees an
    empty summary (Health-id hand-off B1);
  - the document list and download are not chart routes and take the
    emergency purpose as before, so a break-glass grant reads the activating
    facility's document metadata and files, as the release checklist has
    recorded since D-Eminence/hid-system#52. Whether it should is N3's open
    question (Health-id hand-off B1(c)); this addendum does not decide it.
    Uploads are off at launch and no import writes EHR documents, so a
    launch database holds none; the reviewed migration that grants
    `ehr.document.write` again must decide it first;
  - the summary's vitals are as first recorded; corrections are not applied
    (D8; hand-off A11(a));
  - the clinician's access-request list leaves break-glass grants out (0074),
    so after a reload a grant is found again only by activating again, which
    replays the same grant without extending it (hand-off B11);
  - as since 0010, 0012 and 0031: a reason of 8 to 500 characters, 5 to 240
    minutes, read only, at most ten new activations per account per rolling
    hour, the audit row and the patient notification intent in the activation
    transaction, an in-app inbox item for the patient, and no revocation by
    the patient (the clinician closes the grant).

Alternatives not taken:

- Turning the control on in the migration: a control event needs an acting
  account (ADR-058), and the owner keeps production configuration an
  operator's action.
- Granting the permission or seeding the purpose alone: activation needs both,
  so either alone changes nothing a user sees, and the other half would need
  a second reviewed migration.
- Granting break-glass to further roles (lab, pharmacist, receptionist,
  admin, org admin): none held it before 0091; widening it is a new decision.
- A database check of the control inside `identity.activate_break_glass`:
  Identity checks it in the activation transaction, and only the Identity
  runtime may execute the command. It would be defence in depth for a later
  change, not part of this decision.
- Refusing the emergency purpose on the document routes now: it would decide
  N3's document question, which the owner has not decided, and N3's proposed
  default keeps today's reads; no document exists at launch.
- Checking the control only in the release checklist before 0097: 0097's own
  precondition also covers a database the checklist does not reach (a
  long-lived development or pre-launch copy).

Consequences:

- From 0097's commit, doctors', clinicians' and nurses' sessions list
  `identity.break-glass.write` on their next request (Identity reads
  permissions per request), and Health-id `077b85c` enables its Emergency
  method for them. While the control is off the activation answers
  `423 BREAK_GLASS_DISABLED` ("Emergency access is currently disabled by the
  platform administrator"), which Health-id shows as the error; every other
  role still gets `403 PERMISSION_DENIED`.
- After the operator step, activation is live: grant, audit, emergency-contact
  alert intent (delivered only where emergency-contact delivery is enabled)
  and inbox item, and the summary as above.
- An earlier release's bootstrap refuses a database that holds 0097 (its
  assertion forbids the permission). Break-glass is turned off again with the
  control (or by deactivating `emergency`); taking the permission away again
  is a new reviewed migration, never a hand-made delete, which would stop the
  next bootstrap.
- The control must follow staff MFA in rollbacks too: before Identity is
  rolled back past the staff MFA build (0088's Identity) or Health-id past
  its staff authenticator sign-in (FE-2), a platform administrator sets
  `break_glass_enabled` off with `POST /admin/controls` and confirms it with
  P11, and turns it on again only once the MFA builds are back (release
  checklist §9).
- Evidence is local and synthetic: the rollback-only suite
  `break-glass-launch.integration.sql` (which sets the control itself through
  the administrator command, so it does not depend on the environment's
  control), the role assertions, 0097's precondition run again by
  `verify-non-superuser-database.mjs`, and the patient-safety runtime verifier
  over HTTP with the control off, on and off again (release checklist §8).
  Nothing has been run on staging or production.

Related: ADR-054 (staff MFA); ADR-058; `PHASE_3_LAUNCH_DECISIONS.md` (D9, N3);
`INTERFACE_CONTRACT.md` (break-glass, launch module set); `DATABASE.md`
("Break-glass at launch, with limits (0097)"); release checklist §1, §2, §3,
P10, P11, §5, S4y, §8, §9, §10.

## ADR-058 addendum: completion while uploads are off answers 423 UPLOADS_DISABLED

Date: 2026-10-14

Change: this change (launch review item A15, register
BE-EHR-DOCUMENTS-CONTRACT).

ADR-058 had completion answer `409` while `uploads_enabled` is off: the
generic `409 CONFLICT` that the upload intent also answered. Under ADR-059
("refusals carry their own codes") both now answer `423 UPLOADS_DISABLED`,
with the same detail ("Document uploads are temporarily disabled"), as
`423 PLATFORM_PORTAL_DISABLED` and `423 BREAK_GLASS_DISABLED` do for their
controls. The check itself is unchanged: on completion it still runs first,
before Identity, the storage read or any write; on the intent it follows the
`Idempotency-Key` check. A control that cannot be read still answers `500`.
The other document refusals took their own codes in the same change
(`INTERFACE_CONTRACT.md` §16, "Document route answers"). The request audit
records the refusal with `details.code` `UPLOADS_DISABLED` and outcome
`denied`, as it recorded the `409`. At launch no role holds
`ehr.document.write`, so both routes answer `403 PERMISSION_DENIED` first; the
`423` is reached only once a reviewed migration grants the permission again
while the control is still off.

# ADR-059: A Fault Is Never a Sign-Out; Refusals Carry Their Own Codes

Status: Proposed for source implementation
(D-Eminence/hid-system#76, no migration). Not merged or
deployed.

Date: 2026-10-13

Context:

The launch review found that Identity and the services behind it answered
faults as if the user's credential had been refused, and refusals as faults.
Health-id signs a user out on any `401` and retries a `5xx`, so:

- a database or pool fault in Identity's `SecurityGuard`, a runtime-control
  read that timed out, or an unreachable OIDC key set answered `401`, and a
  partial outage signed every patient and provider out (A4);
- Identity refused a service's own workload credential (a JWKS outage, an
  expired workload token, a wrong caller) with `401`, which EHR relayed to the
  browser as the user's own `401` (A5);
- `POST /auth/refresh` cleared the session cookies on any failure, a `500`
  included, so a transient fault during rotation ended the sign-in; and the
  rotation's `auth.refresh` audit row was written after the commit, so a
  rotation could commit without it (A6);
- a staff session on a patient-only Identity route reached the handler, whose
  refusal of a staff actor with no facility failed its own audit (0067) and
  answered `503` with nothing recorded (A9);
- a staff account whose password was right but which had no active facility
  membership got the wrong-password `401` and counted toward the lockout
  (A10), while other sign-in refusals put their internal reason ("Patient
  account is unavailable") in the detail, which confirmed a right password
  (LOGIN-DETAIL-ORACLE);
- a request from an `Origin` not in `CORS_ORIGINS` answered `500` in all six
  services (A19);
- the patient authorization check answered `write_records` for a request the
  guard admitted as a reported browser read (A18);
- any actor whose account held `platform.admin.access` was exempt from
  maintenance mode and the portal switches, in Identity, EHR and Outreach, so
  an administrator's clinical session kept reading and writing records during
  maintenance (A16);
- the admin principal search and export put names, emails and the export
  reason in `GET` query strings (A24).

The owner policy defaults decide these: deny by default, least privilege,
verified identity, auditable actions, no production bypasses.

Decision:

- `401` means the credential was refused and nothing else. A fault that
  leaves Identity unable to decide is `503` with a stable code:
  `AUTHENTICATION_UNAVAILABLE` (session verification, actor resolution, the
  platform assurance read, the OIDC key set), `PLATFORM_CONTROL_UNAVAILABLE`
  (any runtime-control read fault other than SQLSTATE `55000`
  `PLATFORM_CONTROL_DISABLED`). The guard still audits the denial first. A
  `DomainProblem` keeps its status and code.
- Workload refusals have their own codes: `503 WORKLOAD_IDENTITY_UNAVAILABLE`
  (the key set cannot be fetched or used, or workload authentication is not
  configured), `401 WORKLOAD_AUTHENTICATION_FAILED`, `403
  WORKLOAD_CALLER_DENIED`; a refused document scanner token is `401
  DOCUMENT_SCANNER_AUTHENTICATION_FAILED`, which EHR relays because it is the
  browser caller's own credential. A calling service answers Identity's
  refusal of its own workload credential as `503`: EHR answers `503
  IDENTITY_SERVICE_AUTH_UNAVAILABLE` (`isWorkloadRefusal` in
  `@hid/api-client`) and refuses to send an expired Identity workload token
  (`503 IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE`, logged as
  `identity_workload_token_expired` and counted). A refusal of the user's own
  session keeps its status and code.
- Refresh clears the session cookies only for a `4xx` refusal of the refresh
  token, on `/auth/refresh` and `/auth/admin/refresh`. A `5xx` keeps them. The
  `auth.refresh` audit row is written inside the rotation's transaction, so
  the rotation commits with it or not at all.
- Patient-only routes are marked `@PatientOnly()` and the guard refuses any
  other session with `403 PATIENT_SESSION_REQUIRED`, before the handler, as
  an audited `auth.authorization.denied`. Any other staff failure without a
  facility, outside session events and platform administration, is audited as
  an `auth.*` event on `authentication` instead of failing its audit.
- A staff account with the right password, a staff record or a facility
  membership, and no eligible membership is refused at the password step with
  `403 NO_ACTIVE_FACILITY_MEMBERSHIP` (launch decision NO-MEMBERSHIP-SIGN-IN,
  owner default (a)): no MFA challenge, no session, a denied `login_failed`
  session event, not counted toward the lockout. An account with neither keeps
  the uniform `401`. A live session whose membership ended stays `401`: its
  credential no longer resolves, and Health-id returns the user to sign-in,
  where the `403` explains.
- Every other refused sign-in credential, patient or staff, answers `401` with
  the one detail "Invalid credentials"; a refused Google sign-in answers `401
  GOOGLE_SIGN_IN_DENIED`. The internal reason stays in the audit and session
  events.
- A disallowed `Origin` is refused by the CORS layer with `403 ORIGIN_DENIED`
  and no CORS headers, in Identity, EHR, Lab, OCR, Outreach and Pharmacy.
- After a delegated read skip, the patient authorization check decides only
  `read_records`; any other scope is `403 CSRF_VALIDATION_FAILED`.
- Only a platform administration session is exempt from runtime controls in
  Identity. EHR and Outreach exempt no session. A grant never makes clinical
  access exempt.
- `POST /admin/principals/search` and `POST /admin/principals/export` take
  their terms and reason in the body. The `GET` forms stay for one release
  because the Health-id `82b474e` console uses them, and are then removed.

Alternatives not taken:

- Answering faults `401` and relying on clients to retry: a client cannot
  tell a refused credential from a fault, and Health-id signs out on `401`.
- A session that authorizes nothing for a staff account without a membership
  (option (b)): it issues a token to an account with no workforce authority,
  needs every facility-optional staff route audited, and the Health-id "No
  facility assignment" screen has no sign-out.
- Keeping the uniform `401` for that account: the password was right, the
  user cannot tell what to do, and the refusal counted toward the lockout.
- Mapping workload refusals to `503` in Lab, Pharmacy, OCR and Outreach now:
  they are off at launch (D17), and the shared helper makes it a small
  follow-up.
- Rewriting the OCR guard `catch` (any fault with no status to `503`) now:
  OCR is off at launch (D17). EHR's guard answers such a fault
  `503 AUTHENTICATION_UNAVAILABLE`, once this change contained the EHR
  retraction branch that also edits that guard.
- An audited maintenance exemption for clinical sessions of administrators:
  no decision asks for one; it would need its own control and review.
- Removing the `GET` admin routes now: the Health-id `82b474e` console would
  fail. The gateway's access log omits query strings since
  D-Eminence/hid-system#72 (ADR-055).

Consequences:

- A partial outage (database, key set, runtime controls, audit write during
  refresh) no longer signs users out; Health-id shows its existing temporary
  error and retries. Monitoring must watch `503` rates, the
  `identity_workload_token_expired` log of EHR and the codes above
  (`AWS_DEPLOYMENT_RUNBOOK.md`); no alarm is defined for that log yet.
- Health-id `82b474e` needs no change. Staff and patient sign-in show the
  `403` detail and the uniform "Invalid credentials"
  (`apps/patient-web/src/staff/routes/SignIn.tsx:71`,
  `apps/patient-web/src/routes/SignIn.tsx:32`); the session clients sign out
  only on `401` and treat a `5xx` as temporary
  (`apps/patient-web/src/session.tsx:91`, `:146-152`;
  `apps/patient-web/src/staff/api.ts:712-725`); the admin console keeps the
  `GET` search and export (`apps/patient-web/src/admin/api.ts:354-357`,
  `:374-376`) and should move to the `POST` forms before they are removed.
- Administrators' clinical sessions are now refused during maintenance and
  with the provider portal off, like every other clinician's.
- Evidence is local and synthetic: unit specs, and the runtime verifiers
  `verify-patient-runtime.mjs`, `verify-session-sign-out-runtime.mjs`,
  `verify-staff-mfa-runtime.mjs`, `verify-platform-admin-runtime.mjs`,
  `verify-platform-security-runtime.mjs` and
  `verify-outreach-cookie-read-runtime.mjs` with injected database faults
  (release checklist §8). Nothing has been run on staging or production.

Related: ADR-038; ADR-043; ADR-045; ADR-047; ADR-054; ADR-055;
`INTERFACE_CONTRACT.md` (Auth session contract, "Refusals and faults";
Extracted Identity boundary; §19); `PHASE_3_LAUNCH_DECISIONS.md`
(NO-MEMBERSHIP-SIGN-IN); release checklist §2, §3 and §8.

# ADR-060: Patient Web Push Is Payload-Free Standard Web Push on the Existing Device Store

Status: Proposed; not approved, not implemented. Design only
(`WEB_PUSH_PROPOSAL.md`). Nothing is built, configured or deployed, and
nothing changes at launch.

Date: 2026-10-14

Context:

Patients are told about access requests, emergency access and each use of
their access PIN only in the in-app inbox (0037, 0091, NOTIF-PIN-NOTICE).
Browser push does not exist. Migration 0028 prepared
`notification.device_registrations` (encrypted token, keyed-HMAC lookup,
revocation) and `delivery_attempts` allows a `push` channel, but no service
reads or writes a device, the FCM adapter in the notification worker is never
constructed and has no credential, and that worker is off in production
(D17). Health-id registers no service worker, and the edge forbids one
(ADR-052: CSP `worker-src 'none'`, the artefact verifier, release check
S4l (2)). No decision approves a push channel.

Decision (proposed):

- When web push is approved, it uses standard Web Push with VAPID, not FCM
  web tokens: no new data processor, no npm dependency in either repository,
  one new secret (the VAPID private key), and the browser's own push service.
- Every push is empty. The service worker shows fixed generic text ("You have
  a new update in HID. Sign in securely to view it.") and opens the signed-in
  inbox. No name, facility, code, count or clinical information leaves the
  server, so no payload encryption is needed.
- Subscriptions use the existing `notification.device_registrations` table,
  extended by one migration (a transport column, a partial unique lookup on
  active rows, a delivery queue fed by the inbox trigger, and session-bound
  security-definer commands for Identity). No second notification system is
  built.
- Identity owns subscriptions and dispatch (patient-only routes under
  `/api/v1/identity/me/web-push`); the Notification API owns the transport
  (`POST /notifications/web-push`, workload-authenticated), with a push-host
  allowlist in code as its SSRF control.
- Both services ship it switched off, and production refuses to switch it on
  until this ADR is accepted.

Consequences:

- Accepting it also amends ADR-052 for one push-only service worker: the
  portal CSP gains `worker-src 'self'`, the artefact verifier allows one
  fixed-name file, and S4l (2) changes with them.
- iOS delivers web push only to Home-Screen web apps, which need a manifest
  that ADR-052 also forbids; this is a separate choice.
- The FCM adapter stays for a future native app.
- The Novu subscriber sync of draft D-Eminence/hid-system#8 is ported as
  ADR-064 (migration 0095, D-Eminence/hid-system#90); it does not touch devices or
  push.

Open for the owner: approve web push as a patient channel; the ADR-052
amendment; iOS; DPO review of subscription data (an endpoint identifies a
browser).

Related: ADR-052; ADR-053; ADR-058; `WEB_PUSH_PROPOSAL.md`;
`PHASE_3_LAUNCH_DECISIONS.md` (NOTIF-PIN-NOTICE, D17).

# ADR-061: A NIN record without a date of birth or gender: the patient enters them at activation

Status: Accepted in source (D-Eminence/hid-system#82, migration 0092).
Merged to main, not deployed. Production NIN-only enrollment stays refused
by configuration (decision N1) until ADR-062 replaces that rule.

Date: 2026-10-14

Context:

- On 2026-10-14 the product owner described patient self-enrollment: the
  patient enters their NIN and QoreID verifies it; they enter a phone number
  or email of their choice; they confirm the code sent to it; they set a
  password. QoreID returns only the name, the NIN and its reference. Where a
  field is needed and the NIN record did not provide it, the patient enters
  it.
- Later the same day the owner instructed that possession of a NIN alone is
  never proof of ownership: online sign-up proves control of the phone linked
  to the NIN with a one-time code, or the patient registers in person at a
  participating facility (decision N1). That ownership step is a separate
  change; this ADR covers only the missing fields, which both routes need.
- Until this change a verified NIN record without a date of birth or gender
  could not enroll at all. The adapter required `nin.birthdate` and
  `nin.gender` and answered `502 QOREID_PROVIDER_RESPONSE_INVALID`; the
  service required both; and the activation command (0085) required both in
  the profile, whose JSON must hash to the enrollment's `profile_sha256`, so
  the Identity API could not add them.

Decision:

- Only the NIN (equal to the one submitted), first name and last name are
  required from QoreID. A date of birth or gender that is absent, null or
  empty is left out of the stored profile. One that is present but does not
  parse still fails closed.
- Progress answers after the holder proof (ADR-062) and before activation
  name the missing fields in `requiredProfileFields` (`dateOfBirth`,
  `gender`, in that order; `[]` for a complete record). Identity computes it
  from the stored profile and never returns a profile value.
- The patient enters the missing fields with the password
  (`POST .../activate` with `dateOfBirth` as `YYYY-MM-DD` and `gender` from
  the existing list). Identity checks them after the stage, contact-age and
  budget checks and before hashing the password: a missing field is
  `400 ENROLLMENT_PROFILE_REQUIRED`; a field the record gives is
  `400 ENROLLMENT_PROFILE_FIELD_VERIFIED`; a date that is not a real date
  from 1900-01-01 to today is `400 DATE_OF_BIRTH_INVALID`. A replay of an
  active enrollment ignores them.
- The activation command (0092) takes the two values as new arguments and
  checks the same rules again. A value the NIN record provided can never be
  overridden, by Identity or by a direct call.
- The values are self-reported. Their provenance is kept two ways: the
  authoritative profile (`identity.patient_authoritative_profiles`) stays
  exactly what QoreID returned, so a value in `identity.patients` that it
  lacks was entered by the patient; and the activation audit event records
  `selfReportedFields`, the names of the fields taken from the request,
  never their values.
- Nothing else changes: the contact is still the patient's own phone or
  email, proved by a code (no code is sent to the registry phone); Turnstile,
  rate limits, the QoreID lookup quota, RLS, the audit and the production
  refusal of `QOREID_NIN_ONLY_ENROLLMENT_ENABLED` are unchanged.

Consequences:

- A patient whose NIN record lacks a date of birth or gender can enroll
  wherever NIN-only enrollment is enabled (staging). In production it stays
  off until the owner lifts the refusal (N1).
- A self-reported date of birth is not verified. It is marked as such by the
  provenance above; a later reader that needs a verified date must check the
  authoritative profile.
- Health-id must ask for the missing fields on the password step; until it
  does, such a record gets `400 ENROLLMENT_PROFILE_REQUIRED` and cannot
  activate. A complete record keeps working unchanged.
- Open follow-up: the signed-in progressive NIN binding (Portal "Verify
  NIN", `QoreIdNinBinding`) still compares the patient's date of birth with
  the registry's and refuses when QoreID returns none.

Related: ADR-048; ADR-057; `PHASE_3_LAUNCH_DECISIONS.md` N1;
`QOREID_VERIFICATION_CONTRACT.md`; `INTERFACE_CONTRACT.md`; `DATABASE.md`,
"Self-reported enrollment profile (0092)".

# ADR-062: A Health ID needs proof that the person holds the NIN

Status: Accepted in source (D-Eminence/hid-system#84, migration 0093).
Merged to main, not deployed. Every new flag is off. ADR-063
(D-Eminence/hid-system#85, 0094) builds the facility route and replaces the
production refusal of the online route below.

Date: 2026-10-15

Context:

- On 2026-10-14 the product owner instructed that possession of a NIN alone
  is never proof of ownership. Online, the patient proves control of the
  phone linked to the NIN with a one-time code, and the Health ID comes only
  after. A patient who cannot (lost SIM, changed number, no linked phone)
  registers at a participating facility. After the proof, a NIN that has a
  Health ID is directed to account recovery, never given a duplicate.
- QoreID offers HID no OTP, consent, phone-ownership, SIM-swap or face-match
  product. The body-free NIN lookup returns the record; the sandbox record
  carried `nin.phone`. Whether production records carry a usable phone is
  not confirmed (DEP-1). HID generates the code; Termii carries the SMS.
- Before this change a QoreID lookup and a contact of the patient's choice
  were enough to create a Health ID. Anyone who knew a NIN could create one.
  Start also answered `409 NIN_ALREADY_REGISTERED` to anyone, which told a
  caller whether a NIN had a Health ID.

Decision:

- A new state `verify_holder` comes between the NIN lookup and the contact
  step. A public enrollment reaches the contact step only through
  `identity.record_public_patient_holder_proof`, the only writer of the
  holder columns. The activation command requires a valid holder proof for a
  first activation. The Identity runtime cannot write the holder columns.
- Online route (this change): a six-digit code from a secure random source,
  sent by SMS to the record's phone, normalized to `+234` and 10 digits. Only
  a verifier HMAC is stored. Five attempts, single use, a resend cooldown,
  three codes per enrollment. The SMS says why it came and names no NIN,
  person, Health ID or link. The route is closed for a record without a
  usable phone and for a record whose date of birth shows an age under 18.
  A record without a date of birth is treated as an adult, and its patient
  may enter any date at activation (ADR-061), an age under 18 included.
  Whether to refuse that is an owner decision, as minors at a facility are.
- Facility route: ADR-063 (0094). With 0093 alone `facility.available` was
  `false` and the proof command refused `facility_in_person`.
- Deliberate departure from the owner's step order: the existing-Health-ID
  check runs after the holder proof, not before. Start never says whether a
  NIN is bound or pending. Only a correct code answers
  `409 NIN_ALREADY_REGISTERED` ("This NIN already has a Health ID. Use
  account recovery to sign in."), and that enrollment is deleted. The cost:
  an existing holder spends a lookup and an SMS before being sent to
  recovery.
- Each start is a new enrollment. A proof removes the NIN's other unfinished
  enrollments, unproven or proven by an earlier code; an unexpired in-person
  proof is displaced only by another in-person proof. One proven enrollment
  per NIN is enforced by a unique index.
- Budgets in `identity.public_patient_holder_events`, counted under advisory
  locks by `SECURITY DEFINER` commands: five sends per phone a day; ten and
  thirty wrong codes per NIN a day and a month; five different NINs proven
  per phone a year. Send and failure budgets are checked at send. A code is
  sent only while the NIN's wrong codes plus the attempts left on all its
  open holder codes, the new one included, stay within the daily and the
  monthly budget, so nobody can have more wrong codes in reach than those
  budgets, across any number of enrollments. A code already sent keeps its
  attempts. Spent budgets answer `429 NIN_HOLDER_ROUTE_LIMITED` ("Use a
  participating facility to register.").
- Lock order: the NIN advisory lock (0092's key) before the enrollment row
  lock, in Identity (every holder step and activation), the proof command
  and the activation command. The send and failure commands lock the row
  and then the holder budget locks; they rely on Identity to hold the NIN
  lock. The prune at every start locks expired enrollments, skipping any
  another transaction holds, before it deletes their codes, as the proof
  does, so the two never deadlock.
- Audit: `holder-verified` {method, ninDigest}; `existing-identity` {method,
  ninDigest, existingBinding}; `superseded` or `contested` {count, methods,
  ninDigest}; `holder-route-closed` {ninDigest, window}. The registry phone's
  digest is kept only in the holder events, pruned after 31 or 366 days,
  never in the append-only audit log.
- Configuration, every flag off by default: `NIN_HOLDER_SMS_ENABLED`,
  `ASSISTED_REGISTRATION_ENABLED` (defined here, used by ADR-063) and
  `QOREID_PATIENT_SELF_NIN_BINDING_ENABLED`. NIN-only enrollment needs a
  holder route. Production refuses the online route until the facility route
  ships (ADR-063), in Identity and in infrastructure:
  `ASSISTED_REGISTRATION_ENABLED` has no effect before then, so it cannot
  stand in for that route. ADR-063 (D-Eminence/hid-system#85)
  replaces this refusal: production needs `ASSISTED_REGISTRATION_ENABLED`
  with the online flag, and Identity opens the online route in production
  only while at least one facility takes part. Production also refuses the
  signed-in NIN binding.
  These rules replace the earlier blanket production refusal of NIN-only
  enrollment, because activation now requires the proof in the database.
  Enabling a flag is an operator step.
- The signed-in "Verify NIN" (`POST /identity/me/verification/nin`) binds a
  NIN to a legacy patient on a name and date-of-birth match, with no holder
  proof. It answers `503 QOREID_PATIENT_NIN_BINDING_DISABLED` while its flag
  is off, before any lookup or charge. Whether N1 covers it is the owner's
  decision.
- The 0093 backfill sends every unfinished enrollment back to
  `verify_holder` and marks active ones `none_before_0093`. The release
  preflight requires zero active public enrollments in production first.

Consequences:

- No path creates a Health ID from a NIN alone. A direct call to the
  activation command without a proof is refused by the database.
- A patient whose record has no usable phone, or whose record shows an age
  under 18, cannot register online. They register at a participating
  facility (ADR-063).
- With 0093 alone no deployed environment could open public patient
  enrollment. Staging refuses the online route (it sends email only),
  production refused it until ADR-063, and the facility route was not yet
  built. Every start on staging and production then answered
  `503 PATIENT_REGISTRATION_NOT_OPEN` before the QoreID gate. The staging
  acceptance rows that need a working start could not run on staging until
  ADR-063 (now release checklist S4v); the synthetic runtime verifier
  covers them.
- Health-id 55a50b0 cannot register a patient on 0093: it does not know the
  holder step and fails closed. Sign-in is unchanged (release checklist §3,
  "Health-id alignment").

Residual risks:

- The registry phone may not be the person's: a SIM swap, a recycled
  number, or a family member's phone. Whoever holds that phone can pass the
  online step. The SMS warns the holder, and the in-person route is the
  stronger proof.
- Someone who knows a NIN can spend its failure budget and close the online
  route for its holder for a day or a month. The send budget closes it too:
  five sends to the registry phone in a day (two starts) close it for 24
  hours without a single wrong code. The facility route is the remedy, so
  production runs the online route only while that route is open (ADR-063).
- Before any proof, a caller who passes Turnstile and the QoreID gate learns
  one fact about the registry record: whether the online route is available
  (start, `GET /current` and the holder send), that is whether the record has
  a usable phone and does not show an age under 18. No registry value is
  returned. The owner may choose to answer the minor case only at send, with
  the same text.
- The checks in the database stop a compromised Identity runtime from
  writing the holder columns or activating without a proof record. They do
  not stop a compromised runtime from sending itself a code it can read,
  since it generates the code.
- Account recovery is unchanged. A holder sent to recovery whose contact is
  lost has no self-service path yet; facility-assisted recovery is an owner
  decision. A phone-only patient who keeps the phone but loses the HID cannot
  sign in or start recovery either, since both take an email or an HID
  (`PHASE_3_LAUNCH_DECISIONS.md` §2, ENR-2-LAUNCH).
- A holder whose NIN someone else already bound (with the holder's SIM, or
  before 0093) is told to use account recovery, which cannot work for them.
  The error table sends them to Health ID support with the reference. A
  governed contested-identity review (`MANUAL_REVIEW`, a second approver for
  any re-binding) is an owner decision and is not built.
- Requirement 5 ("never a duplicate") holds for NIN-keyed bindings only. The
  bound check reads NIN identifiers and the legacy crosswalk, so a legacy
  patient without a recorded NIN can get a second Health ID by the online
  route. Closing that is an open owner decision.
- Production QoreID responses are unconfirmed (DEP-1): what `nin.phone`
  means, when it was captured, whether a SIM change is flagged, and whether
  HID may text it.

Related: ADR-048; ADR-061; ADR-063;
`PHASE_3_LAUNCH_DECISIONS.md` N1; `QOREID_VERIFICATION_CONTRACT.md`;
`INTERFACE_CONTRACT.md`; `DATABASE.md`, "NIN holder proof (0093)".

# ADR-063: Facility-assisted registration

Status: Accepted in source (D-Eminence/hid-system#85, migration 0094).
Merged to main, not deployed. Every flag is off and no facility is
designated.

Date: 2026-10-15

Context:

- ADR-062 requires a proof that the person holds the NIN before any Health
  ID. Its online route needs a usable registry phone of an adult. A patient
  without one (lost SIM, changed number, no linked phone) has no route.
- Anyone who knows a NIN can spend its online budgets and close the online
  route for its holder. The in-person route is the remedy, so ADR-062 kept
  the online route off in production until this route exists.
- QoreID offers HID no document, face-match or in-person product. The
  in-person check is done by a person at a facility, with an original photo
  ID, and recorded by HID.

Decision:

- Participating facilities. The platform designates a facility
  (`identity.facility_assisted_registration`, append-only events, FORCE row
  level security). Only `identity.admin_set_facility_assisted_registration`
  writes it: `platform.facility.manage`, a fresh step-up, a reason, the
  expected version (0 creates) and an idempotency key, through
  `POST /admin/facilities/:id/assisted-registration`. A facility takes part
  while its designation is active, the facility is verified and active, and
  its organization is active. Only an active facility can be made active.
- Public list. `GET /identity/patient-enrollments/participating-facilities`
  lists facilities by name and location only (no ids), with three fixed
  "what to bring" lines. Public, unaudited, cacheable for five minutes.
  Empty while `ASSISTED_REGISTRATION_ENABLED` is false.
- The patient starts on their own device, as online. At the desk the device
  shows a desk code (`POST .../facility-code`): 10 Crockford base32
  characters, 50 bits. The database keeps only its keyed digest
  (`patient-enrollment-desk-code`), a random salt and an issue count. The
  code is derived from the cookie token and the salt, so only the cookie
  holder can be shown it again. A new code replaces the last one; five per
  enrollment; it expires with the enrollment.
- Who may check. The permission `identity.patient.assisted_registration` on
  doctor, clinician and nurse; not org_admin, admin or receptionist. The
  staff member also needs a role grant at that facility backed by a current
  credential attestation (0087; legacy and onboarding roles never qualify),
  a staff session with MFA assurance (checked in SQL by
  `auth.staff_session_is_mfa` as well as by the guard), and a participating
  facility.
- The approved procedure (pending owner and legal sign-off): one method,
  `government_photo_id_in_person`; one original photo ID of four types
  (national ID card, international passport, driver's licence, voter's
  card; no NIN slip); five attestations, each true (patient present,
  original seen, photo matches the person, code shown on the patient's own
  device, patient consents).
- The staff check, `POST /identity/assisted-verifications`, in this order:
  the guard (staff session with MFA, Origin and CSRF, facility, permission),
  the route switch (503 before the body is read), the body (400), a read of
  the enrollment the code names and a blind compare in system context, the
  staff command, then the holder proof in system context.
- Blind compare. Names are normalized (NFKD, combining marks dropped, upper
  case, only A-Z and single spaces). Hyphens and apostrophes are removed but
  a space is kept, so "Synthetic-Okafor" and "Synthetic Okafor" do not
  match. First and last name match the record's in either order. The date
  of birth is compared only when the record has one. The answer per field is `match`, `no_match` or `not_in_record`. Staff
  never see the NIN, a registry value, the contact, the Health ID or the
  missing profile fields. The typed values are never stored.
- `identity.record_assisted_verification` (staff context) records every
  check, matched, not matched or code not found, in
  `identity.assisted_registration_verifications`: digests and per-field
  outcomes only. It charges two sliding 24-hour budgets, every outcome
  counted: 20 checks per staff member across facilities, 100 per facility
  (`ASSISTED_VERIFICATION_STAFF_DAILY_MAX`,
  `ASSISTED_VERIFICATION_FACILITY_DAILY_MAX`). It writes a staff audit row
  {method, documentType, outcome, ninDigest}. The same idempotency key
  replays the stored outcome.
- The holder proof accepts `facility_in_person` for a matched check of the
  same enrollment and its current desk code, under 10 minutes old, not used
  by another enrollment, by a staff member still authorized at a
  participating facility. It clears the desk code and closes any open
  registry-phone code. It writes the proof outcome on the check once.
  Activation re-checks the check, the designation and the staff member, and
  records the NIN as verified at the time of the check.
- A NIN that already has a Health ID is answered to staff only after a
  match: `409 NIN_ALREADY_REGISTERED` with a staff text and the check's
  reference, never the Health ID or the person.
- One verifying staff member at launch. A second approver and a notice to
  the registry phone after activation are owner decisions, not built.
- In production the online route runs only while the facility route is
  open. The Identity environment, `infra/aws` and `verify-synth` refuse
  `NIN_HOLDER_SMS_ENABLED` without `ASSISTED_REGISTRATION_ENABLED`. Identity
  also closes the online route in production (availability, start,
  progress, the code send and the code check) while no facility takes part,
  so suspending the last designation closes both routes. Staging and
  development keep the flag alone. This replaces ADR-062's refusal.
- The patient may start, or start again, at the facility: a registration
  lasts 24 hours.
- Operators review checks per staff member and per facility from the
  verification rows (`DATABASE.md`, "Facility-assisted registration
  (0094)").

Consequences:

- A patient without a usable registry phone can register, at a
  participating facility, after one in-person check.
- With every flag off and no designation the facility route stays closed:
  availability answers `facility: false`, the list is empty, a desk code is
  `409 ASSISTED_REGISTRATION_UNAVAILABLE` and the staff check
  `503 ASSISTED_REGISTRATION_DISABLED`.
- Health-id 55a50b0 has none of the new screens (facility list, desk code,
  staff check, designation); it cannot use the route (release checklist §3,
  "Health-id alignment"; P31, P33).
- The facility route needs the staff MFA sign-in (FE-2) and attested
  clinical grants (FE-3 or a written procedure) before it can be switched
  on.

Residual risks:

- One staff member can approve an impostor with a forged or borrowed photo
  ID. The attestations, the audit row, the budgets and the review query
  bound and expose this; they do not prevent it.
- HID checks only what staff type against the record. No document data is
  captured, and the photo-ID check is the staff member's own attestation.
  With a record that has no date of birth (the shape the owner reported for
  production QoreID: name, NIN and reference only), the system checks the
  two names only. One staff member who knows a NIN holder's name can then
  create that holder's Health ID with no document, starting the
  registration on their own phone.
- The per-field `422` results let a staff member who holds a live desk code,
  including one they issued on their own phone, test guesses of the
  record's names and date of birth within the budgets (20 checks a day per
  staff member, 100 per facility). Each guess is a check with an audit row
  and appears in the review query.
- Identity reads the enrollment and runs the blind compare before the staff
  command authorizes the actor in SQL. An actor the command refuses always
  gets `403` with no field results, but the time to answer can differ.
- These rest on the existing mitigations: the budgets, the staff audit row,
  the weekly review query (release checklist §10) and the sign-off of the
  procedure (P29). A second approver stays an owner decision.
- Minors at a facility are not refused (owner decision).
- A NIN-keyed duplicate is refused; a legacy patient without a recorded NIN
  can still get a second Health ID (ADR-062, open owner decision).
- Facility-assisted account recovery and a contested-identity review are
  owner decisions and are not built.
- A registry-phone proof recorded before the in-person check removes the
  desk code's enrollment: the staff check then answers `404` or `409
  ASSISTED_VERIFICATION_STALE` and the patient continues on the proven
  enrollment. An in-person proof displaces a phone proof (contested).

Related: ADR-062; ADR-054 (staff MFA); ADR-049 (workforce provisioning);
`PHASE_3_LAUNCH_DECISIONS.md` N2(d) and D17; `INTERFACE_CONTRACT.md`,
"Facility-assisted registration"; `DATABASE.md`, "Facility-assisted
registration (0094)".

# ADR-064: Novu receives the patient's verified login email, behind a flag; the in-app notice never depends on it

Status: Merged (D-Eminence/hid-system#90, migration 0095), not deployed.
`NOVU_SUBSCRIBER_SYNC` is off by default and refused in production. Its
numbers 0095, ADR-064, P35 and S4w are final.

Date: 2026-10-16

Context:

- Main's notification worker triggers Novu by `subscriberId` (the canonical
  patient UUID) with a generic sign-in message and gives Novu no contact.
  An email reaches a patient only if someone maps the subscriber's email by
  hand (`STAGING_PROVIDER_ACCOUNTS.md`).
- Owner decision 2 of 2026-10-16: Novu may receive the patient's verified
  email.
- The draft D-Eminence/hid-system#8 did this on an old base. It sent names,
  read `identity.patients` and `auth.accounts` from the worker's pool, made
  every phone-only patient's event terminal, and suppressed every event,
  safety notices included, for an opted-out patient. None of that is ported.
- Main's worker login holds no Identity or Auth table privilege, and is no
  member of the event-delivery technical owner (`runtime-roles.integration.sql`).
- A review of the first design found two failure modes this ADR closes: a
  failed subscriber call could make in-app safety notices terminal, and an
  opt-out did not hold once an email had been synced.
- A review of the second design found three more, also closed below: the
  lookup emailed suspended logins and logins whose deletion was due; a
  retried event's clear could be answered from Novu's idempotency replay
  cache without being applied; and an upsert could reach Novu after a later
  event's clear when the login was deleted or disabled in between.

Decision:

- Flag. The worker setting `NOVU_SUBSCRIBER_SYNC=disabled|email`, default
  `disabled`. With `disabled` the worker is main's exactly: no lookup, no
  subscriber call, main's trigger body and idempotency key, no new output.
  `email` is refused for a production deployment (`HID_DEPLOYMENT_ENV`,
  new in the worker and defaulting to `production`, or `NODE_ENV=production`
  without `HID_DEPLOYMENT_ENV=staging`), as notification-api refuses
  `EMERGENCY_CONTACT_DELIVERY_ENABLED`. It needs the live orchestrator, and
  under `NODE_ENV=production` an approved Novu region origin
  (`https://api.novu.co` or `https://eu.api.novu.co`). The synth input
  `HID_NOVU_SUBSCRIBER_SYNC_ENABLED` (default `false`) may be `true` only in
  staging, with the worker enabled.
- Data. Novu receives the `subscriberId` it already receives and, for an
  eligible patient, the verified login email (`auth.accounts.email`). No
  name, phone, NIN, clinical value or reason. The trigger payload is
  unchanged.
- Lookup (0095). `integration.notification_recipient_for_claim(event,
  claim token, patient)` checks the inbox consumer as main's inbox commands
  do (`integration.assert_inbox_consumer_authorized`), requires the
  consumer row bound to `hid_notification_worker`, the worker's live claim
  (55000 otherwise) and an outbox envelope that matches the claim
  (producer, type, version, correlation, a workflow event type and the
  patient). It belongs to `hid_event_delivery_commands`, moved in main's
  CREATE window, and only the worker executes it. It reads the patient and
  login through the private helper `integration.notification_recipient_state`,
  owned by the migration administrator (the owner of the three tables it
  reads, `identity.patients`, `auth.accounts` and
  `identity.patient_account_deletion_requests`, which needs no BYPASSRLS
  because none of them forces row-level security) and executable only by
  the technical owner. The answer is
  `('email', address)` or `('withhold', null)`; no row when the claim binds
  no envelope.
- Eligible for email: an active patient with notifications on, whose login
  is usable as main's `identity.current_patient_account` defines it (0064:
  status active, no suspension ahead in `disabled_until`, no confirmed
  deletion whose `scheduled_for` has passed) and has a verified, non-blank
  email. Everyone else is withheld: a phone-only login, an unverified or
  blank email, no login, a login that is pending_reset, locked, disabled,
  deleted, suspended or due for deletion, a patient who is not active,
  notifications off. A deletion confirmed but not yet due keeps the email,
  as the login itself stays usable until then.
- Keys. Novu answers a seen idempotency key from its cache for 24 hours,
  success or error, without processing the request again. So both
  subscriber keys include the attempt's inbox claim token (unique per
  attempt, hashed, never sent): a retried event clears or sets the email
  again instead of receiving the first attempt's cached answer. Setting or
  clearing an email is idempotent, so nothing is lost. Main's trigger key
  (the event id) and the email-withheld trigger key stay per event: they
  dedupe the in-app notice.
- Eligible: `POST /v2/subscribers` (Novu upserts) with exactly
  `{subscriberId, email}` and the idempotency key
  sha256("hid-novu-subscriber-email-v1", event id, claim token,
  sha256(email)). Then the worker asks the lookup again under the same
  claim. If it answers the same address, main's trigger follows, whatever
  the sync answered. Otherwise (withheld, another address or a failed
  lookup) the event is handled as withheld below, so an upsert that reached
  Novu after a concurrent event's clear (the login deleted, disabled,
  locked or reset in between) is cleared again before this trigger. A claim
  lost at the second lookup clears the email and stops.
- Withheld: `PATCH /v2/subscribers/{subscriberId}` with `{"email": null}`
  (the field is nullable; 404 means Novu has no such subscriber, so no
  email) and the key sha256("hid-novu-subscriber-email-clear-v1", event id,
  claim token), then main's trigger once the clear is confirmed. When it is not
  confirmed (timeout, 408, 409, 429, 5xx or a refusal), the worker sends
  instead the trigger that clears the email itself: main's workflow and
  message to `{subscriberId, email: null}` under its own key
  (`hid-novu-trigger-email-withheld-v1`). Novu's trigger creates or
  updates the subscriber it names (the `to` fields are nullable), so the
  email is cleared by the same request that sends the in-app notice; S4w
  confirms on staging that the update comes before the Email step.
- The in-app notice never depends on a subscriber call. No subscriber
  answer decides whether a trigger is sent, delays it or fails the event:
  the inbox outcome is the trigger's own outcome, handled as main handles
  it (accepted completes; unknown retries; a definitive failure is
  terminal). Safety notices (`EmergencyAccessActivated`,
  `PatientAccessPinVerified`) go in-app for every patient.
- A recipient lookup that fails is handled as withheld (clear, then the
  trigger), so it neither retries the event nor emails. A claim lost to
  another worker (55000) stops without failing or acknowledging the message.
- Startup: with the flag on, the worker refuses to start unless the lookup
  exists and its login may execute it, after main's runtime-role guard.
- Records: each subscriber call writes one PHI-free row per attempt in
  `notification.delivery_attempts` (`novu-subscriber-email-v1` or
  `novu-subscriber-email-clear-v1`, channel `email`, outcome and fixed safe
  code, no address and nothing derived from it); a row that cannot be
  written never holds back the trigger. Each flag-on event attempt writes one
  `notification.worker.outcome` stdout line with the event type, the
  correlation id (only in the outbox's own shape, otherwise `invalid`) and
  fixed codes only.

Proposed defaults (owner questions answered with the safest choice):

- Safety notices to an opted-out patient: in-app only, no email. Emailing
  them would need a per-workflow rule that the shared `patient-update-v1`
  workflow cannot express.
- Deleted logins and patients who are not active keep main's in-app
  trigger: no new suppression. Their Novu email is cleared before it.
  Suppressing the trigger itself stays the F4 decision
  (`PHASE_3_PATIENT_SAFETY.md`).
- The Novu subscriber is not deleted when a login is deleted. That needs an
  event from the account deletion and a Novu delete call; it is a follow-up,
  not built, and it is required before the production refusal is lifted
  (staging uses synthetic patients only, S4w). Until then, while
  `NOVU_SUBSCRIBER_SYNC=email` stays on, the next event for a deleted login
  clears its email at Novu, and a request to erase it is handled in the
  Novu dashboard.
- Suspended logins and logins whose deletion is due are withheld as main
  withholds them from sign-in; no new state is added for them.
- A claim lost after a sync: the worker clears the email it may have set and
  stops. The worker that now holds the event decides for itself, so an
  eligible patient misses at most this attempt's email.
- Turning the flag off or rolling the worker back is a reviewed operation:
  every subscriber with a `novu-subscriber-email-v1` disclosure row has its
  email cleared or the subscriber deleted at Novu first (release checklist
  §9).
- A failed sync skips the email for that event only. Novu then emails at
  most the address an earlier sync of the same account stored: no route on
  main changes a login's email, so that is the same verified address.
- Phone-only patients get main's in-app trigger and one clear call per
  event, which keeps the opt-out true even after a manual staging mapping.
- The disclosure rows are kept (an auditable record that an address was
  given to Novu for an event), with the log line.
- The helper stays with the migration administrator and only the technical
  owner executes it; a dedicated NOLOGIN reader is the fallback if
  `identity.patients` ever forces row-level security (the owner pass of the
  new suite would fail first).
- Production refuses the flag unconditionally. Lifting it is a reviewed
  change after P35 and the subscriber deletion follow-up, not a setting.

Consequences:

- With the flag off the worker runs main's code path: no lookup, no
  subscriber call, main's trigger. 0095 only adds two functions and their
  grants. That is main's behaviour only if the flag was never on: emails it
  synced stay on the Novu subscribers, and main's trigger can then email
  them, opted-out and deleted patients included. Release checklist §9 clears
  them before the flag is turned off.
- With the flag on in staging, a verified-email patient's notice can arrive
  by email as well as in-app, once the staging workflow has an Email step
  (S4w); phone-only patients see no change.
- Every flag-on event makes one extra Novu call (sync or clear), two when a
  second lookup after a sync withdraws it (sync, then clear), and one extra
  lookup after every sync.
- Health-id needs no API change. Before the flag is set where Health-id
  serves real patients, its privacy notice must name the processor and the
  data, and the account deletion screen must say that email updates stop and
  that the provider may keep the address until it is removed on request.

Residual risks:

- Novu semantics are taken from its API reference, not from a call: the
  upsert, the nullable email on PATCH and on the trigger's `to`, and the
  order of the trigger's subscriber update before the Email step. S4w
  confirms them on staging before the flag is set anywhere.
- Concurrency. Main routes change eligibility while events are in flight:
  account deletion (0064, at `scheduled_for` and at finalization), and the
  administrator's disable, lock and reset (0068), besides an imported
  `notifications_enabled`. The second lookup after a sync closes the window
  for every upsert Novu applies before answering. It stays open for an
  upsert whose answer never arrives (timeout) and that Novu applies only
  after this worker's second lookup and a later event's clear: the address
  then stays at Novu, unused by HID triggers while the flag stays on (every
  later event for that patient clears first), until the deletion follow-up
  or a manual deletion.
- Retries reuse nothing at Novu for subscriber calls (per-attempt keys).
  Main's trigger key is the event id, as on main: a retried trigger whose
  first attempt Novu processed is answered from the cache and sends no
  second notice.
- Flag off after on: see Consequences; the §9 step is manual.
- The key protects personal data now: Novu's API key has full
  administrative access to the subscribers.
- The region (US or EU), the data processing agreement and the NDPA
  transfer basis are not decided; P35 needs them before any non-local use.

Related: ADR-053 and D17 (the worker is off in production); ADR-058
(NOTIF-PIN-NOTICE); ADR-060; `PHASE_3_LAUNCH_DECISIONS.md` NOTIF-PIN-NOTICE;
`INTERFACE_CONTRACT.md`, "Notification worker to Novu"; `DATABASE.md`,
"Notification verified recipient (0095)"; release checklist P35 and S4w.

# ADR-065: Patient record release

Status: Accepted in source (migration 0096). Not merged, not deployed. Every
release flag is off, and the production profile refuses each of them.

Date: 2026-10-16

Context:

- Since 0084 a patient sees only their completed encounters and the signed or
  amended notes of those encounters; the summary names vitals, diagnoses,
  prescriptions, lab requests and documents as withheld. D7 proposed the
  rules for releasing more and left the categories to the owner.
- On 2026-10-16 the owner approved (decision 4) that patients see their
  diagnoses, prescriptions, Lab results, vitals and documents as well.
- The PR #8 branch released these through new patient-self policies on each
  table and a patient-self route in lab-api. On main the patient-self context
  is bound to the patient's live session (0091, PSELF-RLS) and only the EHR
  runtime may evaluate it; Lab is off at launch (launch module set D17) and
  lab-api never receives patient credentials or patient-self context. Lab's
  released results live in Lab's tables, which the EHR runtime cannot read.

Decision:

- One release set in EHR. `PatientRecordRelease`
  (`services/ehr-api/src/ehr/patient-records/patient-release.ts`) is the
  single service function that decides and reads what a patient sees: the
  always released encounters and notes, plus each approved category whose
  flag is on. Later features that show a patient their records (imported
  records, record chat) use it and do not define their own.
- One flag per category, all off by default: `EHR_PATIENT_RELEASE_VITALS`,
  `EHR_PATIENT_RELEASE_DIAGNOSES`, `EHR_PATIENT_RELEASE_PRESCRIPTIONS`,
  `EHR_PATIENT_RELEASE_LAB_RESULTS` and `EHR_PATIENT_RELEASE_DOCUMENTS`
  (synth inputs `HID_EHR_PATIENT_RELEASE_*`). With every flag off the
  summary is byte-for-byte what it was. The EHR production profile refuses
  every one of them, as `HID_NOTIFICATION_WORKER_ENABLED` is fixed false in
  production: Lab results while Lab is off at launch (D17), and the other
  four until the clinical owner signs off each category and its wording
  (release checklist P36), since no clinician-review gate or sensitivity
  classification is built. `infra/aws` (`environmentConfig` and the regional
  stack) and `verify-synth` refuse every input outside staging; the AWS
  development stack runs ehr-api in the production profile
  (`HID_DEPLOYMENT_ENV=production`), so it opts in to nothing. Staging and a
  local run with `HID_DEPLOYMENT_ENV=development` may opt in. A reviewed
  change that records a category's P36 sign-off lifts that category's
  refusal. EHR also refuses documents without S3 storage.
- D7's rules, as adopted by the owner: only items of a completed encounter;
  never a draft, an unconfirmed or refuted diagnosis or anything entered in
  error; documents only once a patient download route exists; the categories
  are the owner's (diagnoses, prescriptions, Lab results, vitals and
  documents). Every further rule this change builds is a proposed default
  (below), not part of D7.
- D8 interim: a corrected vital is withheld from the patient (shown to
  clinicians as today) until D8 decides what a correction means.
- The database follows the flags. 0096 adds five PUBLIC patient-release
  policies (vitals, diagnoses, prescriptions, documents and their scan
  events) and the Lab view below, each gated by
  `ehr.patient_self_context(patient_id)` and by its category in the
  transaction-local `app.patient_release`. Only `PatientRecordRelease.bind`
  sets it, to the categories whose flag is on, inside main's patient-self
  transaction (session-bound context, `@PatientOnly` route, Identity's fresh
  patient-self authorization through the EHR workload, delegated cookie reads
  unchanged, the audit event `ehr.patient.self.records.read` with counts
  only); `DatabaseService.withPatientTransaction` starts it empty. So the two
  layers of main's model hold per category: with a flag off, neither the
  service nor the database releases that category, and an EHR build that
  never sets it (every earlier build, including one from before
  D-Eminence/hid-system#52) reads nothing new.
- Rows, not columns. Row-level security cannot restrict columns, as for
  encounters and notes since 0030: within a released category the database
  admits whole rows, and the service's `SELECT` lists are what withhold the
  diagnosis `notes`, a document's storage location and staff columns and a
  scan event's staff columns (the download needs the storage location to sign
  its URL). This is accepted: it is main's model for every patient-self read,
  and a column-restricting view per table would duplicate
  `ehr.documents_effective`. The Lab view restricts columns as well.
- Lab results without Lab. The EHR patient transaction reads
  `ehr.patient_released_lab_results`, a `security_barrier` view over Lab's
  release tables owned by the technical role `hid_lab_release_reader`
  (NOLOGIN, no member, no schema `USAGE`, column `SELECT` only on what the
  view reads, one `for select ... using (true)` policy on each table it
  reads, no privilege on the view itself). Functions in a view run as its
  caller: the view's patient-self condition and the encounters' policies are
  evaluated by the EHR runtime under the patient's binding, and the owner can
  evaluate neither. That patient-self condition is what keeps a consented
  staff context from reading released Lab values outside lab-api's checks
  and audit. Only the EHR runtime and the test role may select the view.
  Options considered:
  - lab-api reads with patient-self context (the PR #8 route): rejected; it
    would grant `ehr.patient_self_context` (or a Lab twin) to a Lab role and
    send patient credentials to lab-api, which D17 and PSELF-RLS exclude, and
    it needs Lab running.
  - A workload-asserted Lab route (EHR names the patient to lab-api):
    rejected; nothing in Lab's transaction binds the patient to a live
    patient session, so lab-api would trust EHR's word for the patient.
  - Copy released results into an EHR table: rejected; a second copy to keep
    in step with corrections and invalidations, and a writer for it.
  - Two security definers (an EHR function calling a Lab-owned one): rejected;
    it needs cross-owner `EXECUTE` and a definer that trusts its caller's
    patient argument.
  - The caller-evaluated view owned by a technical role: chosen. It needs no
    new `EXECUTE` and no Lab runtime privilege, and works on RDS, where the
    owner of the Lab tables does not bypass `FORCE ROW LEVEL SECURITY`.
- Each section reads through an index in its own order (vitals, diagnoses,
  prescriptions; Lab results through the view's), so it stops after the rows
  it shows; a statement timeout of any released section, which the documents
  section can still reach for a patient with thousands of documents, answers
  `503 PATIENT_RECORDS_UNAVAILABLE`.
- Patient document download. `GET /api/v1/ehr/me/documents/:documentId/download`
  (`@PatientOnly`, facility-optional) re-checks the release conditions in the
  patient transaction, audits `ehr.patient.self.document.download` (media
  type and size only) before anything is signed, reads back the exact
  version's size, SHA-256 and encryption, and signs a 60 s attachment URL with
  `Cache-Control: private, no-store`. Every refusal is the same `404
  DOCUMENT_NOT_AVAILABLE`. The staff download route is unchanged.
- No caregiver, guardian or other delegated access (ADR-018 requires an
  explicit delegated-access model, which does not exist).

Proposed defaults (open owner questions; the safest default is built):

- Every release flag stays off in production, and the production profile
  refuses it, until the clinical owner signs off that category and its
  wording (release checklist P36). No delay or clinician-review gate and no
  sensitivity classification is built. Lab results are refused in production
  until Lab is re-enabled as well.
- Corrected vitals are withheld while D8 is open.
- Cancelled prescriptions are not shown; only active, on hold and completed.
- Clinician free text stays withheld (diagnosis `notes`, Lab correction and
  release reasons), and so do staff identities.
- An item entered in error, refuted, invalidated or retracted after release
  disappears without a "withdrawn" marker or inbox notice.
- Restricted and internal documents, and documents attached to no
  encounter, are never released.
- A Lab result needs its source encounter completed as well as its release.
- A released Lab result is shown only while its source EHR order is active,
  on hold or completed: once the order is cancelled or entered in error the
  patient no longer sees it. This departs from D10, where Lab refuses work on
  a cancelled order but its released results stay in Lab's released history
  for staff; for the patient a cancelled order's result is withheld until the
  owner decides otherwise.
- Lab requests are never released.
- No caregiver, guardian or proxy access.
- Each new category returns at most 100 rows, newest first, with
  `truncated`; the audit records counts only.
- The migration, ADR and checklist numbers are assigned at merge.
- The EHR task role's `s3:GetObject`, `s3:GetObjectVersion` and `kms:Decrypt`
  via S3 cover `HeadObject` with checksum mode on SSE-KMS objects; staging
  check S4x confirms it before documents are released.

Consequences:

- With every flag off nothing changes for patients, staff or Health-id, and
  the database refuses the new categories to the patient as before 0096.
- A deployment can release each category on its own, once its P36 sign-off
  lifts its production refusal. The database admits at most the rows the
  0096 rules allow for the categories the transaction names; a wrong
  `SELECT` list in EHR could still return a column of a released row that
  the service means to withhold (rows, not columns).
- The role bootstrap must run after 0096: until it does, a configured Lab
  results section answers `503 PATIENT_RECORDS_UNAVAILABLE` and discloses
  nothing.
- Rolling the EHR API back to any earlier build on a database with 0096
  releases nothing new: no earlier build sets `app.patient_release`.
- Health-id renders none of the new sections or the download; the flags stay
  off until it does (P36).

Residual risks:

- A released abnormal result or a sensitive diagnosis reaches the patient
  without a clinician's explanation (no review gate; P36 sign-off).
- A withdrawn item vanishes silently; a patient who saw it is not told why.
- A staging database built from the PR #8 branch may hold its permissive
  patient-self policies, which would widen the release whatever
  `app.patient_release` says; the SQL suite's exact policy inventory fails on
  them (P36 preflight).
- The view's owner reads Lab's release tables unfiltered; it is safe only
  while it has no login, no member and no other privilege, which
  `runtime-roles.integration.sql` asserts.
- `app.patient_release` is set by the EHR runtime itself, like the rest of
  the patient-self binding, so it guards against a wrong flag check or query
  in EHR and against older builds, not against code running as the EHR
  runtime.

Related: ADR-018; ADR-058 (PSELF-RLS); `PHASE_3_LAUNCH_DECISIONS.md` D7, D8
and D17; `INTERFACE_CONTRACT.md`, "Record summaries" and "Patient document
download"; `DATABASE.md`, "Patient record release (0096)".

# ADR-066: Doctors and Nurses Apply by Themselves; They Set Up an Authenticator Before Review, and Two Platform Administrators Still Verify and Grant Every Clinical Role

Status: Proposed; needs owner approval (owner decision 2 of 2026-10-14,
"self sign-up + admin approval"; launch decision CLIN-SIGNUP; migration
0098, numbered after main's 0093 to 0096 and break-glass's 0097; built as
0094, then merged as 0096 under ADR-064 until main took 0095, 0096, ADR-064
and ADR-065). Not merged or deployed. It extends ADR-049. It does not supersede
ADR-049 and does not change ADR-054, ADR-059 or NO-MEMBERSHIP-SIGN-IN. Three
points are implemented with the design default and stay open for the owner
(release checklist P37):
the step-1 identity-assurance standard and the reviewer list; the service
level stated to applicants (the default is a 30-day expiry with no promise);
and the licence register check's source (the default is a manual check of
the regulator's public register, recorded by reference).

Date: 2026-10-15

Context:

- ADR-049 (0087) grants clinical facility roles only through
  platform-governed commands, under a two-person rule: one reviewer attests
  the credential and another administrator grants. It deferred facility
  self-service; a clinician got access only by being provisioned by two
  Super Admins. The self-service `org_admin` (CAC and email only) is
  untrusted for clinical authority.
- The owner decided on 2026-10-14 that clinicians sign up themselves and
  land in a verification queue, and that two platform administrators approve.
- Constraints: NO-MEMBERSHIP-SIGN-IN (ADR-059: no MFA challenge and no
  session on the password of an account without an eligible membership);
  ADR-054 and P22 (a clinical account holds a staff-proven authenticator
  before its clinical role is enabled, each enrolment confirmed outside the
  mailbox); an account is not a patient identity; N5 and
  `WORKFORCE_ROLE_CONFLICT`; anti-enumeration; ADR-057 (a new
  `PublicDetailProblem` needs a decision); ADR-058 (off starts off in the
  database).
- With 0097, doctor, clinician and nurse hold `identity.break-glass.write`
  again: once `break_glass_enabled` is on, any approved clinician can make
  emergency reads at their facility.
- With 0094 (ADR-063), doctor, clinician and nurse hold
  `identity.patient.assisted_registration`, and the in-person check accepts
  any facility role whose grant rests on a current 0087 attestation. Step 2
  writes exactly such a grant, so once the facility is designated (P30) and
  `ASSISTED_REGISTRATION_ENABLED` is on, an approved clinician can run
  in-person checks there with a staff MFA session and no further step, and so
  vouch for another person's Health ID.

Decision:

- Who may apply at launch: doctors registered with MDCN and nurses or
  midwives registered with NMCN, one verified facility per application. A
  table CHECK, the commands and the API enforce the pair. The prescribing
  `clinician` role and other regulators are not offered; the 0087 governed
  path still grants `clinician`.
- Self sign-up files an application and grants nothing. The applicant proves
  an email address with a six-digit code (the code is sent whether or not
  the address is in use; only its holder learns that it is), sets a password
  and gives their name, licence number and licence expiry. This creates an
  active account with a pending staff record and an application; no
  membership and no role. The applicant then sets up an authenticator app
  through the unchanged 0088 staff enrolment (a second email code bound to
  the factor's challenge). The application is not reviewable until then
  (`awaiting_authenticator` → `submitted`). Staff sign-in still answers
  `403 NO_ACTIVE_FACILITY_MEMBERSHIP` until approval.
- The applicant reads and changes an application through an application
  capability: an HttpOnly, SameSite=Strict, host-only cookie scoped to the
  application routes and bound to a server-side row (60 minutes for a draft,
  30 for an account capability). It is opened by the submission itself, or
  later by a code emailed to an account that holds a clinician application
  followed by its authenticator; never by a password. It is not a session and
  reaches no patient data. The 0088 challenge it drives is opened by the
  server on a token derived from the capability and the challenge id, which
  never reaches the browser, so no value the browser holds works at
  `/auth/mfa/*`; it never yields a session. Staff-session issuance re-checks
  eligibility (`403 NO_ACTIVE_FACILITY_MEMBERSHIP`). NO-MEMBERSHIP-SIGN-IN
  is therefore unchanged. A capability is checked against its account at
  every step (review fix): `enrolment_required` ends once the account holds
  an authenticator, and a disabled or inactive account's capability serves
  nothing (`403 CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE`). An account that
  holds an approved clinician application, or an active or pending staff
  membership, sets an authenticator up again (after a two-person MFA reset)
  only through staff sign-in, the password then the emailed enrolment code
  that P22's query (3) reviews; the status page refuses it after a correct
  code (`403 CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED`), so the mailbox
  alone never enrols a clinician's factor.
- Intake starts closed. The platform control `clinician_signup_enabled` is
  seeded off; an administrator opens it with the audited
  `POST /admin/controls` after release gate P37. Intake also closes while
  `provider_portal_enabled` is off or `maintenance_mode` is on. While the
  control or the provider portal is off, the intake routes (the sign-up
  start and its verify, facility search, submit and apply-again) answer
  `503 CLINICIAN_SIGNUP_CLOSED` with the fixed public sentence "Clinician
  sign-up is not open yet. If you already have a Health ID provider account,
  sign in." This is the decision ADR-057 requires for a new
  `PublicDetailProblem`. In maintenance with both on, every route but
  availability and session end answers `503 PLATFORM_MAINTENANCE` (the
  generic maintenance answer, not the sentence). Availability answers
  `{ open: false }` in all three cases. The status page and the admin queue work
  whatever the control's state (maintenance aside). 0098 replaces
  `platform.control_enabled` while preserving its technical owner
  (`hid_platform_control_reader`) by taking that role's membership only for
  its own transaction, and fails closed when it cannot.
- Two people, through the 0087 commands. Every step needs
  `platform.workforce.manage` (Super Admin only), an MFA platform session, a
  step-up from the last five minutes, a reason, If-Match and an
  Idempotency-Key; no Super Admin who works at the facility may take a step.
  Step 1: a Super Admin who is not the applicant checks the regulator's
  register; confirms identity by a live video call or in person with a
  government photo ID, during which the applicant reads a current code from
  their authenticator, which Identity verifies against the applicant's own
  factor (before that code is checked, step 1 refuses whatever it would
  refuse anyway: the request's own fields, the application's version, state,
  identity refusal and facility, an insider's or the applicant's own call,
  the end of the licence, a reused inner key, and an applicant account or
  staff record 0087's attestation refuses; so no such call counts against
  the applicant's failure budget, and a concurrent duplicate is answered
  from the first one's result; only the staff-proven factor itself is found
  after the code, and a missing one is never counted); confirms employment
  through a channel
  independent of the facility
  administrator's account (the facility's phone number from a public record,
  or an in-person visit); and records the 0087 credential attestation for
  exactly the requested role, valid no later than the end of the licence's
  expiry date (Africa/Lagos) and at most three years. Step 2: a different
  Super Admin attaches the account by id and grants the role in one
  transaction, pinned to the step-1 attestation; 0087's independent-reviewer
  rule still applies; the approval is refused if the authenticator confirmed
  at step 1 is no longer the account's active factor; a table CHECK refuses
  an approver who was the attester. When the role becomes effective the
  account already holds a staff-proven authenticator a platform administrator
  confirmed outside the mailbox: P22 as written.
- Reserved attestations: until its application is approved, a step-1
  attestation supports only that application's own pinned step 2 (a grant
  to that application's account at that application's facility; review
  fix: the predicate itself binds the pin, not only its single caller),
  while the application is under review and not overdue, computed at read
  time (no sweeper is waited for). No role rests on it before approval; rejecting,
  withdrawing or expiring an application revokes nothing anywhere. After
  approval it behaves as any 0087 attestation.
  `identity.admin_change_workforce_role` keeps its signature and delegates to
  an internal `identity.workforce_change_role` whose body is 0087's with only
  the reservation and the pin added (a node test holds the copy to 0087);
  `auth.facility_role_is_effective` is not changed.
- Endings: any eligible Super Admin may reject an open application with one
  of nine fixed reasons shown to the applicant plus an internal reason. After
  `identity_not_confirmed` the account can file no new application, its
  other open applications cannot pass step 1, and one that already passed
  step 1 cannot be approved (a conservative addition to the design: the
  person behind the account could not be confirmed). The applicant may
  withdraw. An application not decided within 30 days expires.
- Abuse limits: Turnstile on both email starts (main site only);
  per-network and platform quotas on codes, search and submissions;
  per-address cooldowns; at most 3 open applications per account, 10 in 30
  days, and 30 open per facility. Submit and apply-again check the
  capability before they charge the submit quota, and the platform's daily
  submit cap counts created applications, not attempts, refusals or
  replays (review fix: a forged cookie could otherwise use up the cap with
  no email or account). Both caps hold under concurrency: the platform's is
  checked and counted in one statement under its counter's row lock where
  the application is created, and a facility's open applications are
  counted under a per-facility lock (review fix: concurrent submissions
  could pass either). Submit hashes the password (argon2id) only for a
  submission the database may create: its cheap refusals are answered
  first, a replay is not hashed, and a draft has at most five hashed
  submissions (review fix: one draft could otherwise make the service hash
  without bound from many networks). Applicants' wrong authenticator codes count against
  the account's 0088 budget and a per-address bucket of the applicants' own,
  never staff sign-in's per-address bucket (review fix: throwaway
  applicants could otherwise block staff sign-in from a shared address).
- Facility self-service workforce management stays deferred; the
  `org_admin` gets no route and is never the employment confirmation.
- Every step is audited: public steps inside their commands, admin steps
  platform-scoped in the same transaction with the reason. No email, name,
  licence number, password or code appears in audit details, logs or URLs.

Alternatives not taken:

- The `org_admin` approves or confirms employment by itself: ADR-049's
  threat.
- A password-opened status page: the token NO-MEMBERSHIP-SIGN-IN refused.
- Enrolment at first sign-in after approval: it would activate a clinical
  membership with no factor, against P22.
- A new 0088 proof method so the sign-up code doubles as the enrolment
  proof: it widens a 0088 CHECK; a second code is the price.
- Withdrawing attestations when an application ends: it would revoke
  legitimate roles resting on them and depend on a sweeper.
- Redefining `auth.facility_role_is_effective`: not needed once attestations
  are reserved.
- A regulator registry lookup as step 1: the source is undecided (D14).
- `clinician` or free-text regulators at launch: prescriber permissions with
  no mapped regulator.
- A probation for self-signed-up clinicians, with no break-glass and no
  in-person checks until it ends: the approval assurance here exceeds a 0087
  grant, and a 0087-provisioned clinician already holds both; a daily review
  of break-glass use and of in-person checks by recent approvals is required
  instead (P37). Excluding application-approved grants from the in-person
  check's authorization for a period stays open to the owner (P32, P37).
- An environment flag instead of a control: switching it off would need a
  redeploy.

Consequences:

- Every approval needs two MFA-enrolled Super Admins who do not work at the
  facility, a video call and an independent call to the facility; the queue's
  speed depends on them, and applications expire after 30 days.
- The applicant receives two email codes (address proof, then authenticator
  proof).
- Identity confirmation rests on the reviewer's call and photo-ID check;
  that checklist and the employment channels need product and legal
  approval before the control opens (P37). Uploads are off, so evidence stays
  outside the platform and is named by reference.
- Approved clinicians can use break-glass once it is on, and run in-person
  checks (ADR-063) at their facility once it is designated and
  `ASSISTED_REGISTRATION_ENABLED` is on. An account approved on a forged
  identity could then read another person's emergency summary or create
  another person's Health ID, within ADR-063's budgets (20 checks a day per
  staff member, 100 per facility). P37 requires the break-glass decision and
  a daily review of break-glass use and of in-person checks by accounts
  approved through an application in the last 90 days
  (`MIGRATION_RUNBOOK.md` §6). Its fraud runbook entry lists the in-person
  checks such an account recorded; no route undoes a Health ID one of them
  proved, which waits for the contested-identity review (an ADR-063 owner
  decision, not built).
- Rejected, withdrawn and expired applicants keep an active account with no
  membership, plus their application rows; a retention period is a legal
  follow-up.
- A wrong step-1 code counts against the applicant's authenticator budget;
  a step-1 call that would be refused anyway does not (the pre-check takes
  the request's fields for that).
- A refusal at the platform's daily cap inside the creating transaction
  rolls back with it and is not audited; the early check's refusals are.
- An approved clinician whose authenticator was reset, and whose membership
  has since ended, cannot set one up through the status page and needs HID
  support (the conservative side of the staff-sign-in-only rule).
- No notice sink is bound: applicants learn decisions from the status page
  and facilities are not notified.
- Merged with main's 0093 to 0096 (D-Eminence/hid-system#84, #85, #90 and
  #91), break-glass's 0097 (#83) and the launch alignment fixes (#80), the
  migration is 0098 and holds to #80's A17, A21 and A23: every refusal's
  audit row records its status and code; a rate-limit `429` that means "try
  again later" carries `Retry-After` (86400 for the quotas, 900 for the
  authenticator budgets), while a capability's spent search budget, which
  never comes back, answers its own `429 CLINICIAN_APPLICATION_SEARCH_LIMITED`
  with none (it was `429 CLINICIAN_APPLICATION_RATE_LIMITED` with
  `Retry-After: 3600`); and a refused `declarations` or `checklist` field is
  named by its dotted path. `503 CLINICIAN_SIGNUP_CLOSED` is listed with the
  other `PublicDetailProblem` answers.
- Evidence is local and synthetic: `clinician-applications.integration.sql`,
  `workforce-role-change-body.test.mjs`, the Identity specs,
  `verify-clinician-application-runtime.mjs`, the non-superuser upgrade
  stage (with a quoted administrator name) and the rehearsal (release
  checklist §8). Nothing has run on staging or production.

Related: ADR-049, ADR-054, ADR-057, ADR-058, ADR-059, ADR-063;
`PHASE_3_LAUNCH_DECISIONS.md` (D14, NO-MEMBERSHIP-SIGN-IN, CLIN-SIGNUP);
`INTERFACE_CONTRACT.md` (Turnstile verification; Clinician self sign-up;
§19 Clinician applications); `DATABASE.md` (Clinician self sign-up
applications (0098)); release checklist §1-§3, §5, §8, P11, P22, P32, P37,
S4z.

# ADR-067: Imported legacy medical history

Status: Accepted in source (migration 0099). Not merged, not deployed. Every
switch is off, and the production profile refuses each of them. Nothing has
been imported anywhere: the import command runs only when an operator runs
it, and only after the sign-off below.

Date: 2026-10-16

Context:

- On 2026-10-16 the owner approved decision 3: "patients and staff see
  imported legacy records". That this covers every version of each record
  and the metadata of the files attached to them, and nothing else, is this
  change's reading of the decision, not part of it.
- The PR #8 branch imported it with its own 0061/0062: any consent at any
  facility disclosed the patient's whole imported history, and the schema
  owner had a bypass policy. Main's security model (forced row-level
  security, the 0091 patient-self binding, ClinicalRepository's fresh
  Identity authorization and audit, NOLOGIN technical owners for every
  definer, flags off by default) is the one this port follows.
- The legacy history has no facility or encounter of main's model: a legacy
  record names the patient and its author, not where it was written. A
  facility-bound consent cannot narrow it.
- The branch documents say that real September customer data (123 reconciled
  patients, 16 patient-authored and 1 provider-authored medical record,
  files, notifications and configuration) is on staging or was authorized
  for import there. It is real patient data under staging controls.

Decision:

- Three append-only tables, `ehr.imported_medical_records`, their versions
  and their files, keep the legacy row as staged (its sealed checksum, its
  author's account, whether the patient or a clinician wrote it, and its
  sealed staging run). Nothing is turned into encounters, notes, signatures
  or allergies; imported history is never a section of either record
  summary.
- The patient reads their own imported history through main's patient-self
  path (`GET /api/v1/ehr/me/imported-history`): Identity's patient-self
  authorization and `PatientRecordRelease`, whose release set gains the
  category `importedHistory` behind its own flag
  `EHR_PATIENT_RELEASE_IMPORTED_HISTORY`. The database admits an imported row
  to the patient only in a transaction whose release set names it. The
  patient needs no sharing choice to see their own history.
- Staff read it (`GET /api/v1/ehr/patients/:patientId/imported-history`,
  switch `EHR_STAFF_IMPORTED_HISTORY_ENABLED`) only when all of these hold:
  the purpose is direct care, Identity authorizes an active standard consent
  at the selected facility (ClinicalRepository, with its audit and refusal
  record), the membership holds the new permission
  `ehr.imported-history.read` (doctor, clinician, nurse), and the patient has
  chosen to share their imported history (`identity.imported_history_sharing`,
  off until they turn it on). The database repeats every condition in
  `ehr.imported_history_staff_read_allowed`. The staff policies ask it once
  per statement, for the one patient the staff transaction names
  (`ehr.imported_history_staff_patient()`, a sub-SELECT PostgreSQL evaluates
  once rather than per row): the name is only the request, and a staff
  transaction reads no other patient's rows. When all hold the whole
  imported history is disclosed as one unit ("portability"): it has no
  facility a consent could narrow it to.
- Break-glass never discloses imported history. The staff route takes only
  `direct-care` (break-glass grants count only for `emergency`, D9), the
  database decision requires `direct-care`, ClinicalRepository refuses a
  break-glass authorization for this read (`403 BREAK_GLASS_EXCLUDED`), and
  the emergency summary is unchanged.
- The patient's sharing choice is two session-bound commands in Identity
  (`GET` and `POST /api/v1/identity/me/imported-history-sharing`, switch
  `IMPORTED_HISTORY_SHARING_ENABLED`). Each change is recorded with its
  session and correlation id in an append-only change log; each read and
  each change request is audited. Turning sharing on needs the switch, a
  recent sign-in and no recent account recovery, as an Access PIN does.
  Turning it off is always allowed, also while the switch is off: the stored
  choice is what the database's staff decision reads, whatever the switches
  say, so a patient must always be able to withdraw it.
- Import only from main's sealed staging pipeline. The parent run is main's
  legacy identity run, staged, promoted and reconciled to `verified`
  (`stage-legacy-identity.mjs`, `promote-legacy-identity.mjs`,
  `reconcile-legacy-identity.mjs`). `stage-legacy-identity.mjs
  --scope=imported-history` seals the history of the same source snapshot in
  its own run of source system `legacy_imported_history`, which main's
  promoter refuses and main's crosswalk gate does not count: a staged
  `legacy_identity` run closes public patient enrollment (0057), and a history
  run stays staged. Two 0099 triggers give these runs the seal 0033 gives
  `legacy_identity` runs. `import-legacy-history.mjs` checks both runs and
  every row against its seal and the parent's identity rows and calls
  `ehr.import_legacy_medical_history`, which repeats every check of the runs
  and of each row's content and bindings (not the stager's checksums, which
  the importer recomputes; the command takes only rows equal to the sealed
  rows), takes only ISO 8601 timestamps with an offset, inserts once, refuses
  a stored row that differs and records a receipt run. Its time grows
  linearly with the rows (50,000 synthetic rows in 11.7 s on a local
  cluster). Both CLIs refuse production and run only on staging or an owned
  rehearsal; that refusal is the operator-declared `HID_DEPLOYMENT_ENV`, not
  something the database enforces. Tests and rehearsals use synthetic
  fixtures only.
- Portability on RDS. Each definer is owned by a NOLOGIN technical owner
  (`hid_imported_history_commands`, `hid_imported_history_importer`) holding
  exactly what its body reads and writes, so nothing relies on an owner
  bypassing row-level security; every suite but `schema.integration.sql`
  (as on main) passes with every other object owned by a `NOSUPERUSER
  NOBYPASSRLS` role, and the import passes as a `NOSUPERUSER NOBYPASSRLS
  CREATEROLE` administrator. No technical owner keeps an EXECUTE entry on
  its own function, so a first role bootstrap and a rerun leave the same
  ACL. The import runs as `hid_migration_admin` through a SET-only
  membership taken and given up in its own transaction.
- 0099 refuses a database that still holds the branch's 0061/0062 objects,
  and changes nothing in it. What happens to such a staging database is a
  proposed default below.

Real customer data on staging (recorded, not resolved): the September
customer data is said to be on staging. Nothing in this change imports,
reads or moves it, and no tooling here touches staging. Importing any real
legacy data, on staging or in production, needs the DPO's and the owner's
written sign-off of its provenance, lawful basis, scope and retention first
(release checklist P38); whether staging may keep the data it already holds
is the DPO's decision.

Proposed defaults (open owner questions; the safest default is built):

- Staff see a patient's imported history only after the patient shares it,
  on top of a standard consent at the selected facility. The alternatives
  (any consent discloses it, as on the branch; or a per-facility share) are
  not built; changing this is a reviewed migration of the staff decision,
  not a setting.
- Imported history is disclosed for direct care only, never under
  break-glass or for healthcare operations.
- Every switch is off and refused in production until the DPO and the owner
  sign off the legacy data and Health-id renders the history (P38). Staging
  sets a switch only after P38 (1), the written sign-off for staging, is
  attached, and with synthetic data only.
- The switches go on in order and off in reverse: the patient's read, then
  the sharing choice, then the staff read (the synth refuses sharing without
  the patient's read, and the staff read without sharing). Stored sharing
  choices persist when the switches are off; a patient can always withdraw.
- The import is refused in production and needs the P38 sign-off on staging
  before any real legacy data is imported.
- A staging database that ran the PR #8 branch's 0061/0062 (0099 refuses it)
  is rebuilt from main only after a snapshot and a read-only inventory of
  what it holds, only after the DPO decides what staging may keep, and only
  with the owner's and the DPO's written approval of the rebuild (P38).
- The import runs as one all-or-nothing statement. The branch documents name
  17 legacy records; the command was measured linear to 50,000 synthetic rows
  (11.7 s), so the CLI's 300 s statement timeout is reached at roughly 1.2
  million rows. If the dry run of a real history counts more than 250,000
  rows, it is not applied: batching by record range is designed and reviewed
  first.
- Files show their metadata only, with `accessStatus:
  pending-safety-verification`: no attachment, scan evidence or download is
  built (PR 4 of the integration plan), and no health profile
  (`healthProfile: null`).
- Legacy content is shown as the legacy system held it, labelled
  `patient-provided` or `provider-authored` with `provenance:
  legacy-import`; Health-id must render it as text. Legacy free text that
  mentions an allergy is not a structured allergy record (ALLERGY-1).
- A deleted login's imported history is never shown to staff.
- Turning sharing on needs a recent sign-in and no account recovery in the
  last 24 hours; turning it off is always allowed and takes effect at the
  next staff request.
- Pages of 50 records, each with its 20 newest versions and first 20 files,
  with `truncated`, `versionsTruncated`, `filesTruncated` and an opaque
  cursor; audits record counts and the sharing choice only.
- No notification to the patient when staff read the imported history (the
  read is audited); no caregiver or proxy access (ADR-018).
- The migration, ADR and checklist numbers are assigned at merge.

Not built, because the owner did not approve it (2026-10-16): the imported
customer configuration archive and any administrator read of it; a staff
historical inbox; legacy PIN secrets; imported records in break-glass or
emergency summaries.

Not built, deferred to later changes of the integration plan: the
patient-only imported inbox (PR 5, which needs the owner's confirmation for
free-text legacy messages); imported attachments, scan evidence, downloads
and health profiles (PR 4).

Consequences:

- With every switch off nothing changes for patients, staff or Health-id,
  and no route answers with imported history. Stored sharing choices and
  imported rows persist: the database's staff policy still admits a sharing
  patient's rows in a direct-care staff transaction that names them, which
  no build with the staff switch off makes.
- Staging and importing a history leave public patient enrollment open.
- Staff see no imported history until each patient opts in, even with a
  consent; the owner may read decision 3 as "any consent discloses". That is
  recorded as the first proposed default above.
- A staging database built from the branch cannot run 0099 until it is
  rebuilt from main, under the proposed default above.
- Rolling the EHR API back to an earlier build releases nothing: no earlier
  build names `importedHistory` in the release set, and the staff policies
  need the staff decision.

Residual risks:

- Legacy free text may contain markup or sensitive content; the API returns
  it as data and never logs or audits it, and Health-id must render it as
  text.
- The patient's choice is per patient, not per facility: once shared, every
  facility the patient consents to for direct care sees the whole imported
  history.
- `app.patient_release` and the patient-self binding are set by the EHR
  runtime itself; they guard against a wrong flag check, a wrong query and
  older builds, not against code running as the EHR runtime.
- Real customer PHI may already be on staging under staging controls until
  the DPO decides.

Related: ADR-018; ADR-058 (PSELF-RLS); ADR-065 (one release set); ADR-056
(ALLERGY-1); `PHASE_3_LAUNCH_DECISIONS.md` IMPORT-HISTORY, D9 and D17;
`INTERFACE_CONTRACT.md`, "Imported legacy medical history";
`DATABASE.md`, "Imported legacy medical history (0099)"; release checklist
P38 and S4aa.

# ADR-065: Patient record chat through the Claude API

Status: Accepted in source (migration 0096). Not merged, not deployed. Off:
the EHR flag `RECORD_CHAT_PATIENT_ENABLED` defaults to false, the platform
control `record_chat_enabled` is seeded false, and every deployed ehr-api
refuses the flag without the operator's attestation of a processing approval.
This ADR records the design and its proposed defaults; it is not that
approval, which a later ADR (or an accepted amendment of this one) records
("The production gate").

Date: 2026-10-16

Context:

- On 2026-10-16 the owner approved (decision 1) record chat through the
  Claude API, for patients and for staff. This change builds the patient part
  (PR 7 of the PR #8 design): a signed-in patient asks a question about their
  own records and reads the answer. Staff chat is a later change.
- The PR #8 design retrieved records through Bedrock embeddings, pgvector and
  Textract OCR. The owner did not approve any of them (decision of
  2026-10-16), and none is built.
- On 2026-10-16 the owner also approved (decision 3) that patients and staff
  see imported legacy records. Imported legacy medical history (0099,
  ADR-067) is on this change's base: `PatientRecordRelease` reads it only
  through `readImportedHistory`, on its own patient route, behind its own
  switches and P38's sign-off. It is not chat evidence (Proposed defaults).
- On main the patient sees their records only through `PatientRecordRelease`
  (ADR-064), inside the patient-self transaction bound to their own live
  session (0091, PSELF-RLS). Main's security model (runtime roles, grants,
  row-level security, audit, platform kill switches, rate limits) applies
  unchanged.

Decision:

- **Evidence: the release set only.** Each question reads the patient's
  records with `PatientRecordRelease.read` in that patient-self transaction:
  encounters and completed encounters' notes always, and each other category
  only while its release flag is on (ADR-064). Lab requests, other
  patients' and staff-only data are never read, and neither is the imported
  legacy history (0099, ADR-067): `PatientRecordRelease.read` has no
  imported section, so chat never reads, extracts or sends it, even while
  `EHR_PATIENT_RELEASE_IMPORTED_HISTORY` is on and the patient-self binding
  names the category (Proposed defaults). There is no
  embedding, vector store, chunking, OCR or semantic retrieval: a
  deterministic selection takes up to 40 released records, those sharing
  terms with the question first and then the newest, within a character
  budget (`RECORD_CHAT_MAX_EVIDENCE_CHARS`, default 40,000; at most 8,000
  characters of one record).
- **What leaves the system.** One Messages API request per question, with
  only:
  - the frozen system prompt (no patient data; the one block marked for
    prompt caching);
  - the extract: per record a `ref` number, its `kind` and its encounter's
    `ref`, and only these fields:
    - encounter: `facility` (an ordinal, `F1`, `F2`; never a name or id),
      `type`, `status`, `startedOn`, `endedOn`;
    - note: `noteType`, `title`, `signedOn`, `text` (the current revision,
      cut to the budget with `excerpt: true` when it is cut);
    - diagnosis: `code`, `display`, `clinicalStatus`, `verificationStatus`,
      `onsetOn`, `abatementOn`;
    - prescription: `medication`, `medicationCode`, `dose`, `doseUnit`,
      `route`, `frequency`, `instructions`, `startsOn`, `endsOn`, `status`;
    - Lab result: `test`, `testCode`, `resultType`, `value`, `text`, `unit`,
      `referenceRange`, `flag`, `revisionKind`, `releasedOn`;
    - vital: `recordedOn` and the recorded `measurements`;
    - document: `classification`, `mediaType`, `createdOn` (never the file
      name, content or storage location);
  - the coverage (the released and withheld category names, whether the
    extract was cut, counts) and exact differences between numeric Lab
    results of the same test (computed in EHR);
  - as context, never as evidence, the newest four earlier exchanges of
    this conversation (question and answer) whose every cited record is
    still released with the content it was answered from (the same kind, id
    and content hash): an exchange about a record since retracted (for
    example a note entered in error), amended or corrected, or of a category
    whose release flag was turned off, is never sent again; a fixed reply
    cites nothing and stays; and the question;
  - the request settings: the configured model id, `max_tokens`,
    `inference_geo`, the answer's JSON schema and the configured effort.
  Every timestamp is cut to a calendar date (UTC). Every string value (titles,
  note text, displays, instructions, codes, units, routes, test names and
  texts, statuses, prior turns and the question) passes through an
  identifier filter that replaces Health IDs, UUIDs, email addresses, URLs
  and runs of ten or more digits (NINs, phone numbers) with `[redacted]`.
  Never sent as a field: the patient's name, Health ID, NIN, date of birth,
  sex, contact details or address; any account, patient, session, record,
  facility or staff id; facility and staff names; diagnosis notes; file
  names and storage locations; audit data; no `metadata.user_id`. Free text
  (note text, titles, instructions, the patient's own question) can still
  name the patient, a relative or a clinician, and can hold an identifier in
  a form the filter does not match (for example a legacy MRN of fewer than
  ten digits): the filter is pattern based and names are not removed. That
  this may reach the processor is an open owner and DPO question (Proposed
  defaults), not settled by the patient's own access to the note. The SDK adds its own request headers (API key,
  API version, and the SDK, runtime and platform names and versions).
- **The processor.** Anthropic's Claude API through the official TypeScript
  SDK (`@anthropic-ai/sdk`, pinned exactly), at the first-party origin
  `https://api.anthropic.com`. One module (`claude-record-chat.client.ts`)
  imports the SDK and sets every client option explicitly: the API key from
  the secret store (`RECORD_CHAT_ANTHROPIC_API_KEY`), no auth token, no
  webhook key, the base URL, the deadline as timeout, no retries
  (`RECORD_CHAT_MAX_RETRIES` accepts only 0 in every environment, as
  `QOREID_MAX_RETRIES`: a retry would send the same PHI again under the one
  disclosure audit row), SDK logging off with a silent logger. The SDK's ambient chain (`ANTHROPIC_*`
  variables, profiles, workload identity) is never consulted, and while chat
  is on ehr-api refuses to start beside any `ANTHROPIC_*` variable. The model
  id comes only from `RECORD_CHAT_MODEL_ID`: no code, configuration default,
  test or document names a model. Before the first request (and hourly) the
  Models API confirms that the configured model exists and supports
  structured outputs (and the configured effort), sending no PHI. The
  request is streamed and read whole (`finalMessage`), the stop reason is
  checked before any content, thinking blocks are ignored, and a reply over
  16,000 characters is aborted. No tools, no thinking parameter, no
  sampling parameters, no fallback model.
- **Record text is data.** The system prompt states that everything in the
  user turn (records, earlier turns, the question) is data and never
  instructions, that facts must come from the extract with their `ref`
  numbers, that the model must not diagnose or advise treatment changes,
  must add a safety block for urgent symptoms, must not claim completeness
  when categories are withheld, and must write no markup or identifiers.
- **Nothing from the model is kept unless it validates.** The answer must
  parse as the JSON schema (status `answered` or `no_evidence`, one to eight
  blocks of kind `record`, `explanation` or `safety`; the schema carries no
  length or count keywords, which the Messages API refuses; EHR checks
  them). Each `record` block must cite at least one supplied `ref` and no
  other block may cite any; an answered reply needs a record block and a
  no-evidence reply has none; no bracketed markers, markup, links,
  identifiers, NUL or other control characters (tab and line breaks
  excepted) or lone surrogates; at most 2,000 characters a block and 4,000
  in all. A question holding such a character is refused before anything is
  read (`400 INVALID_QUESTION`), so neither side can make the save fail. A refusal
  (`stop_reason` `refusal`) stores the fixed declined text, any other
  failure to validate (including `max_tokens`) the fixed unverified text.
- **Authorization each request.** `@PatientOnly`; Identity's patient-self
  authorization of the request's own session before the read, and again
  after the call. Nothing is stored when the second one fails: a session
  that ended during the call (sign-out, revocation, expiry) answers
  Identity's `401 AUTHENTICATION_REQUIRED`, an answer for another session,
  patient or account `403 PATIENT_ACCESS_DENIED`, and Identity unreachable
  `503`; the lease, which only that binding can settle, expires (60 s) and
  is charged its reserved tokens. The cited records are read again before the
  answer is stored and must be unchanged (`409 CHAT_SOURCES_CHANGED`); a
  history the patient cleared during the call stores nothing (`409
  CHAT_CONVERSATION_CHANGED`). A replay with the same key answers the
  stored reply only while every record it cites is still released with the
  same content hash (`409 CHAT_SOURCES_CHANGED` otherwise). Any other
  failure of the save transaction settles the lease as failed with the known
  usage and writes the answer audit row (`save_failed`) in a short fallback
  transaction, and answers `503 RECORD_CHAT_UNAVAILABLE`. Cookie writes keep
  main's Origin and CSRF checks.
- **Audit names the processor, never PHI.** The disclosure row
  (`ehr.record-chat.disclosure`) is written in the same transaction as the
  lease and before the request: processor, model, inference geography,
  audience, counts per kind, prior exchanges, withheld categories, notice
  version, token reservation and an HMAC-SHA256 disclosure digest
  (`RECORD_CHAT_AUDIT_DIGEST_KEY_B64`) over the message id, model,
  geography, each sent record's kind, id and content hash, the question's
  SHA-256 and the prior message ids: with the stored records it proves what
  was sent without holding the text. If that row cannot be written, nothing
  is sent. `priorExchangeCount` and the digest's prior message ids name only
  the earlier exchanges actually sent. The answer row
  (`ehr.record-chat.answer`) holds the status, the reason code, citation
  validity, token usage, the served geography and a refusal category when
  the processor names a known one (`other` for any other value, so no
  processor string of unbounded length reaches an audit row) and the
  processor's message id. Each detail key is allowlisted; no question,
  answer or record text reaches an audit row or a log.
- **Limits.** Two admin-owned `SECURITY DEFINER` commands, as 0049's quota:
  `ehr.reserve_record_chat` (patient-self proof; one 60 s lease in flight
  per account, `429 RECORD_CHAT_BUSY`; 10 questions an hour and 30 a day,
  `429 RECORD_CHAT_RATE_LIMITED` with `Retry-After`; the configured daily
  token budget `RECORD_CHAT_DAILY_TOKEN_BUDGET`, required, under a hard
  ceiling of 20,000,000 a day, `503 RECORD_CHAT_BUDGET_EXHAUSTED`) and
  `ehr.settle_record_chat` (the processor's usage, or the input estimate for
  a timeout, an aborted oversized reply or a processor error). The
  reservation reads the kill switch again, selects an expired lease `FOR
  UPDATE SKIP LOCKED` and moves the budget only for a lease it settled, so a
  late settlement racing the next reservation counts the lease once; leases
  older than two days, settled or abandoned, are pruned. Four calls in
  flight per EHR process; a deadline of
  `RECORD_CHAT_DEADLINE_MS` (default and maximum 25,000, under the gateway's
  30 s proxy timeout); `max_tokens` from `RECORD_CHAT_MAX_OUTPUT_TOKENS`
  (default 4,096).
- **Flags and kill switch.** Off by default (`RECORD_CHAT_PATIENT_ENABLED`,
  synth input `HID_RECORD_CHAT_PATIENT_ENABLED`); with it off ehr-api answers
  `503 RECORD_CHAT_DISABLED` before anything is read and no task holds the
  key. The platform control `record_chat_enabled` (seeded false, the step-up
  administrator's `POST /admin/controls`) pauses chat at once (`503
  RECORD_CHAT_PAUSED`) without a deploy: EHR reads it before anything else,
  and `ehr.reserve_record_chat` reads it again in the transaction that
  commits the lease and the disclosure audit row, so a question in flight
  when it is turned off is not sent. The history stays readable and
  deletable while chat is off.
- **The production gate.** With chat on, every deployed ehr-api
  (`NODE_ENV=production`, staging included) refuses to start without
  `RECORD_CHAT_PROCESSING_APPROVAL` in the form `ADR-NNN@YYYY-MM-DD` (a real
  date, not in the future) and with any base URL but the first-party origin.
  `infra/aws` refuses the same at synthesis, and refuses the sleep profile,
  which has no NAT egress. The value is an operator's attestation, checked
  for form only: it must name a later ADR (or an accepted amendment of this
  one) that records the processing agreement with its NDPA cross-border
  transfer mechanism and the processor's retention terms, the inference
  geography, the retention of the chat history and the quotas, and that
  ADR's acceptance date. This ADR records none of these as decided, so
  `ADR-065@2026-10-16` does not satisfy release checklist P36 (1). The value
  is not bound to the model id: P36 (5) requires the evaluation sign-off
  again before every change of `RECORD_CHAT_MODEL_ID`.
- **The history.** One conversation per patient, its exchanges (question,
  validated reply, the cited records' bindings), at most 50; `GET
  /ehr/me/chat/history` leaves out an exchange whose cited records are no
  longer released or no longer have the content they were answered from,
  and `DELETE` removes the whole history in one statement, unless an active
  legal hold (`platform.legal_holds`, 0064) names the patient or the
  patient's account: then nothing is deleted (`409 CHAT_HISTORY_ON_HOLD`,
  audited), and the delete policies keep the rows in the database
  (`ehr.record_chat_history_on_hold`). Patient-self row-level security only:
  no staff, consent or break-glass path reads it.
- **Database ownership.** The design gave the limit commands a new
  technical role (`hid_record_chat_commands`) and widened
  `ehr.patient_self_context` and `identity.patient_self_session` to it. This
  change keeps them, and the legal hold check, owned by the migration
  administrator, as 0049's quota and 0087's workforce commands are (the
  administrator also owns `platform.legal_holds`), so the patient-self
  functions keep
  exactly their 0091 grants and the bootstrap gains no role.
- **No permission.** `ehr.record-chat.use` is not seeded: patient sessions
  need none, and modules that are off hold no permission (ADR-058). The
  staff change seeds what staff chat needs.

Proposed defaults (open owner questions; the safest default is built; none
is an owner decision until the owner, and where named the DPO, signs it off
under release checklist P36 (4) to (6)):

- Retention of the chat history: no expiry, no automatic purge and no
  retention class; the patient deletes it, and at most 50 exchanges are kept
  (a full history answers `409 CHAT_HISTORY_FULL`). The owner decides the
  retention period.
- The chat history is a patient-owned, non-authoritative copy of questions
  and answers, not a clinical record, outside 0064's record-class model.
  The patient deletes it without a governed case (`DATABASE.md` §3.5 governs
  erasure of governed records); legal holds still apply, so an active hold
  on the patient or the account keeps it. Owner and DPO sign-off (P36 (4)).
- Account deletion (0064) does not touch the chat history: it stays with the
  patient record, as clinical records do, and no live patient session can
  then read or delete it, so it has no retention end. Clearing it in the
  account-deletion flow is an open owner question and would be a later
  change with its own test (P36 (4)).
- The processing approval is required in every deployed environment,
  staging with synthetic data included; it is an operator's attestation
  naming an ADR other than this one ("The production gate"), recorded before
  any flag is set (P36 (1)).
- No flag is set until the processing agreement names its NDPA cross-border
  transfer mechanism (neither `us` nor `global` keeps processing in Nigeria)
  and the processor's retention terms (zero data retention or the standard
  period), recorded in the approval ADR (P36 (1)). Prompt caching of the
  PHI-free system prompt only stays the default; no record text is cached
  on purpose.
- The inference geography has no default: the owner chooses `us` or
  `global` with the approval.
- A dedicated Anthropic workspace holds the record chat API key, with its
  allowed inference geographies pinned to the configured value, its data
  retention set per the processing agreement, and a monthly spend limit as a
  backstop to the daily token budget (P36 (6)).
- A named clinical safety owner signs off an answer-quality and safety
  evaluation of the configured model on synthetic records before the first
  enablement and again before every change of `RECORD_CHAT_MODEL_ID` (P36
  (5)); who owns the evaluation set is the owner's decision.
- Quotas: 10 questions an hour and 30 a day per patient account, one at a
  time; four calls in flight per EHR process; the daily token budget is
  required and capped at 20,000,000.
- The patient acknowledges the notice version `RECORD_CHAT_NOTICE_VERSION`
  with every question (`428 CHAT_NOTICE_REQUIRED` otherwise); the notice's
  wording is the owner's and Health-id's. The acknowledgement stands in for
  consent pending the DPO's ruling on whether explicit opt-in consent is
  required (P36 (4)).
- No retries (enforced: the setting accepts only 0), a 25 s deadline, a
  4,096-token output cap, no effort setting unless configured, no thinking
  parameter, no fallback model, and prompt caching of the system prompt
  only.
- A refusal or an answer that fails validation shows a fixed text; no part
  of it is shown or stored.
- Names, and identifiers in forms the pattern filter does not match, inside
  free text (note text, titles, instructions, prior turns, the question) are
  not removed. Whether that is acceptable for disclosure to the processor
  is an open owner and DPO question (P36 (4)); the patient's own access to
  the note does not answer it, since the processor is a third party.
- Facilities are sent as ordinals only.
- The imported legacy medical history (owner decision 3; 0099, ADR-067) is
  never chat evidence and never reaches the processor, with every imported
  history switch on or off: chat reads only `PatientRecordRelease.read`,
  never `readImportedHistory`, its extract has no imported source kind, and
  no chat statement names an imported table or the category
  (`patient-record-chat.service.spec.ts` and `evidence-extract.spec.ts`).
  Sending it would be a later change behind its own flag, with the owner's
  and the DPO's sign-off for legacy data reaching the processor (P38 covers
  its display only), reading it only through the imported-history read the
  patient already sees.
- Staff chat, its audience and its permission are a later change.

Deviation from the design:

- The design's gateway `limit_req` zone for the chat `POST` routes (6 a
  minute per client address, burst 3) is not built. The gateway has no
  `limit_req` zone for any route; the API origin's per-client WAF rate rule
  covers these routes as every other, and the per-account database lease,
  hourly and daily quotas and daily token budget bound every question
  before any processor call. A per-address limit in the gateway would also
  throttle unrelated patients sharing one carrier-grade NAT address. The
  database checks run after Identity's authorization and the release read,
  so that work, not a processor call, is what an over-limit patient can
  still cause.

Options considered:

- Bedrock embeddings, pgvector and Textract OCR (the PR #8 design):
  rejected; not approved by the owner.
- Sending the whole patient summary or profile: rejected; minimisation.
- Tool use, letting the model ask for more records: rejected; the model
  receives one fixed extract and can request nothing.
- Storing the model's raw output: rejected; only a validated reply or a
  fixed text is stored.
- Retries and a fallback model: rejected; each would send PHI again, or to
  a model nobody configured.
- A technical owner role for the commands (the design): rejected above.

Consequences:

- With the flag off nothing changes for patients, staff or Health-id; the
  migration adds tables, three commands (the two limit commands and the
  legal hold check) and a control that is off.
- Turning chat on needs, in order: the owner's processing approval and its
  ADR (not this one), the sign-offs of the proposed defaults, the model
  evaluation and the workspace settings, the secret (`RecordChatSecretArn`:
  `anthropicApiKey`, `auditDigestKeyB64`), the synth inputs, the Health-id
  screens and notice, and then the platform control (release checklist P36,
  S4x).
- The eighth platform control means any later migration that names the
  control keys starts from eight; this one starts from the seven of 0039 and
  clinician self sign-up (0098), keeps each of them and its value, and
  refuses to run beside an unexpected key.

Residual risks:

- The processor receives the extract's clinical content (minimised, but
  health data) under the owner's approval; its handling is governed by the
  processing agreement, not by this code.
- The identifier filter is pattern based: an identifier written in an
  unusual form inside a note, or a name, can reach the processor.
- An answer can be wrong while still citing real records; the validator
  checks form and citations, not clinical correctness.
- A process crash after the request, a failed fallback save, or a session
  that ended during the call leaves the lease to expire (60 s) and charges
  its reserved tokens; the patient's next question within those 60 s answers
  `429 RECORD_CHAT_BUSY`.
- An exchange saved by a question in flight while the patient clears the
  history is deleted with the conversation but not counted in
  `deletedCount` (the count is of the exchanges the clearing statement
  itself deleted).
- The chat history of a deleted account stays with the patient record and
  is unreachable through the product until the owner decides (Proposed
  defaults).

Related: ADR-018; ADR-058 (PSELF-RLS); ADR-064 (patient record release);
`INTERFACE_CONTRACT.md` §11, "Patient record chat"; `DATABASE.md`, "Patient
record chat"; release checklist P36 and S4x.
