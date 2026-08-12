# HID Platform Architecture

## Current production-convergence boundary

The target edge/runtime split is:

```text
Browser
  -> app-specific Cloudflare Worker Static Assets hostname
       -> static artifact, or fixed same-origin /api/v1/* proxy
          -> environment-paired API origin
             -> regional AWS WAF + ALB
                -> API-only Gateway
                   -> private ECS owner service
```

Hostinger is registrar. Cloudflare owns future DNS/TLS, seven independent
frontend Workers, Turnstile, and edge security. AWS owns durable data and audit,
API/runtime services, documents/OCR, events, and notifications. There is no
CloudFront distribution in the approved target. Novu orchestrates ordinary
notifications only; authentication OTP bypasses Novu and is delivered through
the workload-authenticated Notification API.

Production Workers use the approved production hostnames and fixed
`https://api.healthidentitydirectory.com`; staging Workers use the corresponding
`.staging` hostnames and fixed `https://api.staging.healthidentitydirectory.com`.
The Worker deployment environment, application name, hostname, and API origin
are an allowlisted tuple, never request-controlled values. Each environment has
an independently managed Cloudflare-to-AWS origin authorization secret.

Identity remains the sole patient and human-session authority. Canonical
runtime authentication is local imported credentials or OIDC. The retired
hosted/Supabase implementation is read-only migration evidence, never a target
runtime. Vercel and Brevo are retired target dependencies.

## 1. Purpose

This document defines the target architecture for HID, Health Identity Directory.

HID is being developed as modular healthcare infrastructure rather than a single monolithic hospital application.

The platform consists of multiple independently deployable applications and services that share a canonical patient identity while preserving clear domain ownership.

Current executable topology and local acceptance evidence are recorded in
`PLATFORM_INTEGRATION_ACCEPTANCE.md`. Identity (3001), EHR (3002), Lab (3003),
Pharmacy (3004), OCR (3005), and Outreach (3006) are independently runnable.
The browser-facing OCR review workspace remains inside the EHR frontend, while
the OCR HTTP controllers, orchestration, persistence access, audit, and outbox
ownership are physically isolated in `services/ocr-api`.
The EHR API is physically isolated in `services/ehr-api`, and the non-HTTP OCR
worker is independently packaged in `services/ocr-worker`.

The active browser applications are `apps/web`, `apps/ehr`, `apps/lab`,
`apps/pharmacy`, `apps/ocr`, `apps/outreach`, and `apps/admin`. The repository
local development process may present a consolidated localhost gateway, but
production assigns one hostname and Cloudflare Worker to each app. Pharmacy and OCR are real API-backed
operational workspaces; contextual clinical OCR review remains in EHR. The
evidence-based placement inventory is `FRONTEND_LAYOUT_CONVERGENCE.md`.

The architecture must support:

* scalability
* high availability
* security by default
* offline-first operation
* API-first integration
* event-driven integration where appropriate
* backward compatibility
* observability
* healthcare interoperability
* developer experience
* AWS deployment
* future multi-country operation

## 2. Core Architecture Principle

Identity is the single source of truth for patient identity.

No other service may create or maintain a competing canonical patient identity.

All patient-related domain records reference the canonical patient ID issued or resolved by Identity.

## 3. Target Repository Structure

```text
hid-system/
|
|-- CODEX.md
|
|-- docs/
|   |-- ARCHITECTURE.md
|   |-- DECISIONS.md
|   |-- INTERFACE_CONTRACT.md
|   |-- PRODUCT.md
|   |-- OFFLINE.md
|   |-- SECURITY.md
|   |-- CODING_STANDARDS.md
|   |-- ROADMAP.md
|   |-- TASK.md
|   `-- README.md
|
|-- apps/
|   |-- web/
|   |-- ehr/
|   |-- lab/
|   |-- pharmacy/
|   |-- ocr/
|   |-- outreach/
|   `-- admin/
|
|-- services/
|   |-- identity-api/
|   |-- ehr-api/
|   |-- lab-api/
|   |-- pharmacy-api/
|   |-- ocr-api/
|   |-- ocr-worker/
|   |-- outreach-api/
|   `-- event-dispatcher/
|
|-- packages/
|   |-- ui/
|   |-- api-client/
|   |-- identity-browser-client/
|   |-- offline/
|   |-- telemetry/
|   `-- config/
|
|-- shared/
|   |-- auth/
|   |-- audit/
|   |-- database/
|   |-- storage/
|   |-- logging/
|   |-- middleware/
|   |-- validation/
|   |-- security/
|   |-- types/
|   `-- utils/
|
|-- docker/
`-- scripts/
```

Existing directories must not be moved merely to match this tree if doing so would break working functionality.

Migration toward this structure must be incremental.

## 4. Application Layer

### 4.1 `apps/web`

Technology:

React + Vite

Responsibilities:

* landing pages
* marketing site
* features
* pricing
* blog
* documentation
* knowledge base
* public hospital pages
* public patient pages
* authentication experiences
* appointment booking
* SEO-sensitive pages
* static content
* same-origin development gateway
* shared Identity session entry

The current application is not Next.js and must not be rewritten merely to
match an earlier target diagram. SEO-sensitive server rendering remains a
future product decision.

### 4.2 `apps/ehr`

Technology:

React + Vite

Responsibilities:

* authenticated EHR workflows
* encounters
* clinical operations
* patient selection
* clinical notes
* vitals
* diagnoses
* prescription workflows
* laboratory integration
* document workflows

### 4.3 `apps/lab`

Technology:

React + Vite

Responsibilities:

* laboratory operations
* test request queues
* specimen workflows
* results entry
* validation
* result publication
* laboratory administration

It must work independently and integrate with EHR through the Lab API.

### 4.4 `apps/pharmacy`

Technology:

React + Vite

Responsibilities:

* pharmacy operations
* prescription queues
* dispensing
* medication workflows
* inventory integration when introduced

It must work independently and integrate with EHR through the Pharmacy API.

### 4.5 `apps/ocr`

Technology:

React + Vite

Responsibilities:

* OCR job and document operations
* job creation and governed retry
* extraction metadata and lifecycle state
* validation/publication operational state
* safe handoff to contextual clinical review in EHR

It does not grant OCR operators clinical authority or expose raw extraction
payloads to general analytics.

### 4.6 `apps/outreach`

Technology:

React + Vite

Responsibilities:

* outreach operations
* field healthcare workflows
* patient identification
* offline data capture
* synchronization

### 4.7 `apps/admin`

Technology:

React + Vite

Responsibilities:

* capability-scoped platform administration
* governed facility and principal operations
* audit, service, and event-delivery visibility
* live-only sensitive mutations

### 4.8 Authenticated Patient Dashboard

The authenticated patient dashboard may remain a React/Vite application where it behaves as an application rather than a public content surface.

Public patient routes and SEO-sensitive experiences belong in Next.js.

## 5. Shared UI

Reusable interface primitives belong in:

`packages/ui`

Potential components:

* buttons
* forms
* tables
* modals
* layouts
* icons
* themes
* design tokens

Both Next.js and React/Vite applications should consume the approved shared design system.

Do not copy the same UI primitives between applications without justification.

## 6. Service Layer

### 6.1 Identity API

Responsibilities:

* canonical patient identity
* HID generation
* identity resolution
* verified patient identifiers
* NIN integration
* KYC
* patient lookup
* access authorization
* consent
* break-glass authorization
* facility-aware identity access

Identity must not become a generic clinical database.

### 6.2 EHR API

Responsibilities:

* encounters
* clinical notes
* note revisions
* vitals
* corrections
* diagnoses
* prescriptions
* EHR document references
* EHR workflow state

Every clinical record must include as appropriate:

* canonical `patient_id`
* `facility_id`
* verified actor / `created_by`
* timestamps
* version or revision metadata
* audit linkage

EHR must not own patient identity.

### 6.3 Lab API

Responsibilities:

* laboratory requests
* tests
* laboratory workflow
* result lifecycle
* result validation
* result publication

EHR creates Lab work through the Lab API.

Lab does not write directly into the EHR database.

### 6.4 Pharmacy API

Responsibilities:

* acceptance of one exact eligible EHR prescription version
* immutable accepted-prescription snapshots and Pharmacy work queues
* explicit dispensing and append-only dispensing reversal evidence
* imported historical medication evidence with exact provenance
* Pharmacy audit and transactional outbox records

EHR owns the prescribing decision and integrates through Pharmacy APIs or
approved events. Pharmacy acceptance is not dispensing, dispensing is not
medication administration, and imported medication evidence is neither an
active prescription nor proof of HID dispensing.

### 6.5 Outreach API

Responsibilities:

* facility-authorized temporary field-registration cases
* opaque `tmp_<uuid-v4>` local references
* append-only temporary-to-canonical resolution provenance
* idempotent synchronization endpoints, semantic audit, and domain outbox

The physically extracted `services/outreach-api` runs on port 3006. It asks
Identity to authorize the user, facility, permission, purpose, and any existing
canonical patient link. It has no Identity or EHR mutation privilege and never
mints patient UUIDs or HIDs. `identity_resolution_pending` is not a canonical
registration. Campaigns, visits, screenings, documents/OCR, NIN, and clinical
publication are outside the implemented boundary until separately governed.

### 6.6 OCR API

Responsibilities:

* document registration
* OCR jobs
* extraction
* structured field generation
* confidence data
* validation workflow state
* provider orchestration

OCR must not directly create official EHR, Lab, Pharmacy, or Identity records.

OCR may own OCR job metadata in its own persistence boundary.

Clinical save occurs through the owning domain service after validation.

The extracted API runs from `services/ocr-api` on port 3005 and owns
`/api/v1/ocr/*`. It authenticates users and authorizes patients through
Identity. Exact source-document evidence and clinical-note publication cross
an authenticated typed EHR boundary; Lab and Pharmacy publications cross their
respective typed boundaries. It has no direct foreign-domain SQL. The
provider/object-read worker remains a separately runnable process under
`services/ocr-worker` with command-only database authority.

## 7. API Gateway / BFF

All public clients should communicate through an approved API Gateway or BFF.

Logical flow:

```text
Next.js
   |
React/Vite Apps
   |
Future Mobile Apps
   |
   v
API Gateway / BFF
   |
   |-- Identity Service
   |-- EHR Service
   |-- Lab Service
   |-- Pharmacy Service
   |-- Outreach Service
   `-- OCR Service
```

Gateway responsibilities include:

* routing
* authentication integration
* authorization integration
* request validation
* rate limiting
* API versioning
* correlation IDs
* request logging
* public interface protection

Internal services must not become uncontrolled public endpoints.

## 8. API-First Rule

Frontends never access databases directly.

Forbidden:

```text
UI -> Database
```

Allowed:

```text
UI -> API Gateway/BFF -> Owning Service
```

## 9. Service Boundary Rule

### Extracted Lab runtime

The Lab API is physically runnable from `services/lab-api` on local port 3003. The gateway preserves `/api/v1/lab/*`. EHR retains laboratory-order intent but accepts exact order versions through the typed Lab HTTP client; OCR publishes validated Lab candidates through the same boundary. The EHR runtime no longer registers Lab controllers or providers. Lab continues using the shared PostgreSQL cluster with logical schema ownership, its own connection configuration, `hid_lab_api_runtime`, semantic audit, and transactional outbox.

Service identity is separate from propagated user identity. Local orchestration injects an ephemeral development credential into EHR and Lab. Production callers obtain rotating audience-bound JWTs from the deployment platform; Lab verifies issuer, JWKS signature, audience, expiry, and exact EHR/OCR subjects before independently resolving the user actor and patient authorization through Identity.

### Extracted Pharmacy runtime

The Pharmacy API is physically runnable from `services/pharmacy-api` on local
port 3004. The gateway routes `/api/v1/pharmacy/*` to it, while EHR retains only
prescription intent and calls Pharmacy through `packages/api-client`. OCR uses
the same boundary only for governed imported medication evidence. The former
empty Pharmacy module is no longer registered by EHR, so there is no second
Pharmacy writer.

Pharmacy persists only in the forced-RLS `pharmacy` schema using
`hid_pharmacy_api_runtime`, which composes Pharmacy persistence with append-only
audit and has no EHR, Lab, OCR, or Identity mutation rights. The service
authenticates propagated bearer or Identity session-cookie user evidence
through Identity and independently authorizes patient, facility, permission,
purpose, and non-break-glass writes. For cookie-authenticated mutations it
forwards Cookie, Origin, and CSRF and uses Identity's POST service-session
validation path.
Internal EHR/OCR commands additionally require a separate Pharmacy-audience
workload identity. Local orchestration injects a distinct ephemeral Pharmacy
secret; production requires rotating JWT files and exact issuer, JWKS,
audience, and caller-subject verification.

### Extracted OCR runtime

The OCR API is physically runnable from `services/ocr-api` on local port 3005.
The gateway routes `/api/v1/ocr/*` to that process before the EHR fallback.
EHR no longer registers OCR controllers or providers, so there is one OCR API
writer. `hid_ocr_api_runtime` composes `hid_ocr_runtime` with append-only audit
and has no EHR, Identity, Lab, Pharmacy, or Outreach persistence membership.
`hid_ehr_api_runtime` no longer inherits OCR persistence.

The OCR API can start without the worker; readiness requires only validated
configuration and PostgreSQL. The existing worker can start without OCR or EHR
HTTP processes and retains `SKIP LOCKED` lease/token commands, bounded retries,
exact object-version/SHA verification, provider execution, and immutable
extraction writes. Textract is deliberately not an API readiness dependency.

All OCR-to-service calls preserve the propagated human credential and carry a
separate `ocr-api` workload identity. Local orchestration uses independent
ephemeral secrets. Production requires per-audience rotating JWT files and
exact issuer, JWKS, audience, expiry/signature, and subject verification.

A service cannot directly write another service's persistence.

Forbidden:

```text
Lab -> Identity Database
Pharmacy -> Identity Database
OCR -> EHR Database
EHR -> Lab Database
UI -> Any Database
```

Allowed:

```text
EHR -> Identity API
Lab -> Identity API
Pharmacy -> Identity API
Outreach -> Identity API
EHR -> Lab API
EHR -> Pharmacy API
OCR -> Identity API
OCR -> EHR API after validation
OCR -> Pharmacy API after governed medication-evidence validation
Service -> Event Bus
```

### 9.1 Extracted Identity/EHR database role boundary

Identity and EHR are independently runnable NestJS processes with independent
PostgreSQL pools. `services/identity-api` owns canonical patient,
authentication, consent/access, and Identity audit routes on port 3001.
`services/ehr-api` owns EHR and document routes on port 3002 and calls Identity
through the typed shared client. `services/ocr-api` owns OCR routes on port
3005. The browser-facing `/api/v1/auth`, `/api/v1/identity`, and
`/api/v1/audit` namespaces are gateway-routed to Identity without changing
public URLs.

The `hid_identity_api_runtime` aggregate contains only Identity/authentication
persistence plus append-only audit. `hid_ehr_api_runtime` contains EHR plus
append-only audit; `hid_ocr_api_runtime` contains OCR plus append-only audit.
Neither inherits the other's persistence or any Identity mutation membership. The former
`hid_api_runtime` modular-monolith aggregate is privilege-free and retained
only for compatibility. Existing EHR forced-RLS predicates may execute the
constrained consent decision as defense-in-depth, but active EHR application
code performs patient authorization over Identity HTTP and never queries or
mutates Identity tables.

Authentication principals remain separate from canonical patients. HID is a
governed identifier, not the UUID primary key; secondary identifiers and
Outreach temporary IDs never become canonical patient identity.

## 10. Data Ownership

Identity owns:

* patients
* HID
* patient identifiers
* identity verification
* NIN association
* identity access
* consent identity relationships

EHR owns:

* encounters
* clinical notes
* vitals
* diagnoses
* EHR clinical records

Lab owns:

* laboratory requests
* laboratory workflows
* laboratory results

Pharmacy owns:

* dispensing
* pharmacy workflow
* pharmacy domain records

OCR owns:

* OCR jobs
* extraction attempts
* structured OCR output prior to clinical acceptance
* OCR confidence and processing metadata

The extracted OCR API persists these in the isolated `ocr` schema. Jobs are
facility-scoped and idempotent, reference one exact clean document object
version/checksum, and may retain a null canonical patient association while
identity resolution is pending. Worker claims use an atomic PostgreSQL
`SKIP LOCKED` command. Extractions, human validations, lifecycle evidence, and
minimum-necessary outbox events are append-only. Validation does not publish a
clinical record; publication remains a separate owning-service command.

Outreach owns:

* outreach operational records

Each service may use a separate database or logically isolated schema depending on deployment phase.

Ownership boundaries must remain enforceable regardless of physical database topology.

## 11. NIN Identity Architecture

### 11.1 Patient Identifier Model

Identity should support a patient identifier registry.

Conceptual model:

```text
patient_identifiers
- id
- patient_id
- type
- value/protected_value
- verified
- registration_case_id for governed NIN issuance
- created_at
```

Supported identifier types initially:

* HID
* NIN

Rules:

* NIN must be unique when verified.
* NIN must not become the primary patient key.
* one verified NIN must not link to multiple patients.
* sensitive NIN values must be protected.
* NIN must not appear unnecessarily in responses.
* NIN must not appear in plaintext logs.
* NIN operations are audited.

### 11.2 Resolution

Identity resolution should support:

* HID
* verified NIN

Fallback patient matching may consider:

* name
* phone
* date of birth

Fallback matching is not automatic identity proof.

Ambiguous matches require human confirmation.

The active Identity API uses a protected POST body for NIN resolution:

```text
POST /api/v1/identity/nin/resolve
GET  /api/v1/identity/registration-cases/:caseId
POST /api/v1/identity/registration-cases/:caseId/approve-new
POST /api/v1/identity/registration-cases/:caseId/link-existing
```

Every retryable command uses `Idempotency-Key`. Registration cases are scoped
to the actor facility, carry an immutable request digest, and use optimistic
`expectedVersion` checks for review transitions. A verified NIN that is already
bound to an active patient returns a non-mutating `resolved_existing_identity`
case. A verified but unmatched NIN creates either a `review_required` or
`pending_new_identity_approval` case; it never creates a patient during
resolution.

### 11.3 NIN Verification

Use an abstraction:

```text
NinService.verify()
```

Do not embed a specific NIN provider throughout domain logic.

The adapter may change without changing core identity behavior.

### 11.4 Patient Creation

If a verified NIN does not resolve to an existing patient, Identity first
creates a registration case and searches deterministic demographic candidates.
Only an explicit `approved_new_identity` review transition may then, in one
transaction, create a canonical patient UUID, reserve a new HID, bind the
encrypted NIN to that exact registration case, append the registration event,
and write semantic audit evidence. A `review_required` case can instead use an
explicit `link_existing` transition after a reviewer selects one of its stored
candidates. The existing patient UUID is never replaced.

Never create a patient from unverified NIN data.
Never auto-create a patient solely because a verified NIN is unmatched.

## 12. OCR Architecture

### 12.1 Discovery

Before implementing new OCR functionality, search:

* current repository
* `upstream_snapshot`
* upload code
* document parsing
* scanning
* extraction logic
* legacy OCR implementations

Reuse and refactor sound functionality where appropriate.

### 12.2 Workflow

Required workflow:

```text
Paper Folder
    |
    v
Scan / Upload
    |
    v
Secure S3 Storage
    |
    v
OCR and AI Extraction
    |
    v
Human Validation
    |
    v
Identity Resolution
    |
    v
Confirmed Patient Match
    |
    v
Owning Clinical Service
    |
    v
Digital Patient Record
```

### 12.3 Document Registration

Conceptual fields:

* id
* storage reference
* uploaded_by
* facility_id
* status
* created_at

Initial lifecycle:

* uploaded
* processed
* validated

The model may evolve with additional safe lifecycle states.

### 12.4 Processing

Primary processing endpoint:

`POST /ocr/process`

Accept:

* approved uploaded file reference
* approved S3 object reference

Do not accept arbitrary untrusted remote URLs without security controls.

OCR abstraction should support:

* Amazon Textract
* Amazon Bedrock

Provider adapters must remain replaceable.

Return:

* extracted text
* structured fields
* confidence scores

### 12.5 Human Validation

OCR output is provisional.

Users must be able to review and edit extracted structured information.

Human confirmation is required before clinical save.

### 12.6 Patient Matching

Priority:

1. HID
2. NIN
3. name
4. phone
5. DOB

HID and verified NIN are stronger identity signals.

Fallback demographics must not trigger automatic patient linking.

### 12.7 Clinical Save

After validation and patient confirmation, map approved information to the appropriate service.

Potential targets:

* EHR encounter
* prescription
* Lab result

Clinical records must include:

* patient_id
* facility_id
* created_by

OCR does not write directly into the owning service's database.

The implemented asynchronous boundary runs as `hid-ocr-worker`, independently
of the HTTP API. It claims through command-only PostgreSQL functions with
`SKIP LOCKED`, an expiring lease, and a per-attempt token; reads the exact
versioned S3 object; verifies immutable size/SHA-256 evidence; then calls the
provider-neutral adapter. Amazon Textract uses bounded synchronous image calls
or bounded asynchronous PDF polling. Completion, retry, terminal failure,
audit, job history, and outbox evidence are atomic database transitions. OCR
output remains provisional and cannot mutate Identity or clinical tables.

Human validation, patient confirmation, and publication are distinct governed
commands. Validation preserves accepted, rejected, and corrected fields beside
the immutable extraction. Confirmation binds to the canonical source-document
patient and cannot create a patient. Publication is version-bound, idempotent,
lease-protected, and retry-bounded. Document-only publication avoids forced
structuring; EHR clinical-note publication crosses the EHR service boundary
and records immutable provenance. Lab publication creates imported external Lab
evidence through Lab. Pharmacy publication creates imported historical
medication evidence through Pharmacy and can never create an active
prescription, dispensing, refill, stock mutation, or administration record.

### 12.8 OCR Audit Events

Audit:

* upload
* OCR processing
* validation
* identity lookup
* patient confirmation
* save request
* save result
* processing failure

## 13. Lab Extraction

The Lab boundary is physically extracted to `services/lab-api`. It owns the
`/api/v1/lab/*` contract and Lab persistence; OCR and EHR call it through the
typed client and have no direct Lab mutation grants. Imported external evidence
remains categorically different from native HID Lab execution.

The Lab UI belongs under `apps/lab`.

EHR uses API calls rather than direct Lab domain execution.

Example:

```text
Doctor
  |
  v
EHR
  |
POST laboratory request
  |
  v
Lab API
  |
  v
Lab workflow
  |
LabResultAvailable
  |
  v
EHR
```

## 14. Pharmacy Extraction

The inventory found real EHR prescription intent but no Pharmacy persistence,
dispensing authority, inventory, or operational backend to move unchanged. The
smallest correct domain foundation is now extracted to
`services/pharmacy-api`: exact active EHR prescription acceptance, immutable
accepted snapshot, one explicit full dispensing in this slice, append-only
reversal, and separate imported medication evidence. EHR and OCR use typed HTTP
clients and cannot write Pharmacy tables.

The Pharmacy UI belongs under `apps/pharmacy`.

The current unavailable Pharmacy presentation remains transitional; a dedicated
UI is later work. Inventory/stock, refills, partial fills, substitution,
payment/claims, controlled-drug operations, and medication administration are
not implied by the extracted foundation.

## 15. EHR Integration

EHR communicates with:

* Identity for patient resolution and authorization
* Lab for laboratory workflows
* Pharmacy for pharmacy workflows
* OCR for document digitization

No direct UI database access is permitted.

## 16. Storage Architecture

Use a storage abstraction.

Primary target:

Amazon S3.

Requirements:

* private objects
* no permanent public medical document URLs
* short-lived authorized access
* signed upload/download mechanisms where appropriate
* object authorization
* facility and patient access controls
* content validation
* auditability

OCR consumes approved storage references.

## 17. Offline-First Architecture

Offline architecture is defined in detail in `OFFLINE.md`.

All operational applications must assume unreliable connectivity.

The architecture must support:

* PWA installation
* IndexedDB where appropriate
* encrypted sensitive local data
* queued commands
* retry
* resumable uploads
* synchronization
* conflict detection
* conflict resolution
* idempotency
* audit continuity

## 18. Event-Driven Architecture

Use asynchronous communication where synchronous coupling is unnecessary.

The implemented dispatcher normalizes the existing Identity, OCR, Lab,
Pharmacy, and Outreach transactional outboxes. EHR currently has no outbox
producer, and no product consumer is active. The exact inventory, envelope,
lease/retry lifecycle, crash semantics, and inbox transaction rule are in
`EVENT_DELIVERY_ARCHITECTURE.md`.

Long-running processes should not hold HTTP requests open unnecessarily.

The current production adapter is EventBridge. The transport interface remains
neutral, but adding SQS, SNS, or another adapter requires its own reviewed
delivery and IAM contract.

Event contracts must be versioned.

Consumers must be idempotent.

Delivery is at least once. Transport acceptance is not consumer completion;
consumers use durable `(consumer_name,event_id)` inbox deduplication and commit
the business effect with the processed marker in one transaction.

## 19. API Versioning

All public APIs use versioning.

Initial version:

```text
/api/v1
```

Future versions must be able to coexist.

Do not silently introduce breaking changes to v1.

## 20. Healthcare Interoperability

The architecture should remain compatible with future healthcare interoperability requirements.

Design for future HL7 FHIR integration without forcing every internal table to become a FHIR resource today.

Interoperability adapters should sit at clear service boundaries.

## 21. Healthcare Security and Compliance Direction

Architecture must support:

* Nigerian data protection requirements
* audit trail requirements
* consent management
* break-glass emergency access
* least privilege
* secure handling of health information
* HIPAA-inspired security practices where useful
* future HL7 FHIR interoperability

Detailed controls are defined in `SECURITY.md`.

## 22. Production Infrastructure Target

Every service remains locally testable and deployable without redesigning
business logic. Cloudflare owns public DNS/TLS/WAF, the apex redirect, and seven
independent Workers Static Assets frontends. AWS owns one regional backend
stack. The current backend uses ECS/Fargate, ECR, regional WAF and ALBs, private
RDS PostgreSQL 16, S3/KMS, EventBridge/SQS, Textract, CloudWatch, IAM, and
Secrets Manager.

There is no CloudFront distribution, API Gateway, Lambda, SNS, Bedrock, Redis,
or AWS static frontend host in the approved checkpoint. Such services require
a new evidenced product need and architecture decision; they are not assumed
future defaults.

### 22.1 Implemented IaC foundation

`infra/aws/` contains strict CDK v2 with typed `development`, `staging`, and
`production` profiles. It performs no account lookup and embeds no account,
region, domain, digest, credential, issuer, certificate, or provider value.
`infra/cloudflare/` contains seven exact-host frontend Workers and one
originless apex redirect. See `AWS_DEPLOYMENT_ARCHITECTURE.md`,
`AWS_IAM_MATRIX.md`, `AWS_COST_MODEL.md`, `AWS_DEPLOYMENT_RUNBOOK.md`, and
`RELEASE_ARTIFACT_GATE.md` for executable gates.

```text
app-specific Cloudflare Worker
  -> fixed /api/v1/* proxy
  -> regional WAF (Cloudflare-held origin secret)
  -> public HTTPS ALB
  -> API-only Gateway
  -> private owner API
```

Server-to-server clients use the private HTTPS ALB and exact internal names.
Fargate tasks have no public IPs; RDS is isolated. Eleven long-running services
remain separate. A twelfth digest input is the controlled one-shot migration
task. Desired counts default to zero until release evidence, migration/runtime
roles, RDS CA, secrets, provider setup, and workload issuer/JWKS/rotating token
delivery pass.

The regional data plane contains one encrypted RDS instance, one private
versioned KMS document bucket, one EventBridge bus, and one KMS-encrypted
ordinary-notification SQS/DLQ target. Authentication OTP bypasses that event
path and calls Notification API directly.

The local gate has 34 infrastructure assertions plus offline template policy
inspection. It does not constitute image, ECR, live IAM, RDS,
S3/KMS/Textract, EventBridge/SQS, Cloudflare, DNS/ACM, provider, workload
identity, telemetry, migration, or deployment evidence.

## 23. Observability

Every service must provide:

* structured logs
* correlation IDs
* liveness endpoints
* readiness endpoints
* error reporting
* metrics-ready instrumentation
* distributed tracing readiness
* audit integration

Example:

```text
GET /api/v1/health/live
GET /api/v1/health/ready
```

## 24. Standardized Development Ports

Target API ports:

```text
Local gateway     3000
Identity API      3001
EHR API           3002
Lab API           3003
Pharmacy API      3004
OCR API           3005
Outreach API      3006
Event dispatcher status 3010
Web direct UI     3100
EHR direct UI     3101
Lab direct UI     3102
Pharmacy direct UI 3103
Outreach direct UI 3104
OCR direct UI     3105
Admin direct UI   3106
```

When multiple Vite applications are run simultaneously, each frontend must receive its own explicit non-conflicting port.

Port configuration is centralized in `scripts/ports.mjs`. The existing
one-origin development gateway remains on `localhost:3000`; direct frontend
ports are loopback implementation details and must not conflict with APIs.

Update:

* `.env.development`
* Docker Compose
* service configuration
* development scripts
* documentation

## 25. NestJS Compatibility

Existing deprecated wildcard route configuration causing warnings such as:

```text
Unsupported route path: "/api/v1/*"
```

must be identified and migrated to the appropriate named wildcard syntax supported by the installed NestJS and `path-to-regexp` versions.

Do not suppress the warning.

Fix the responsible route.

Verify health endpoints after the change.

## 26. Shared Technical Packages

Potential shared packages:

### `packages/ui`

Shared UI design system.

### `packages/sdk`

Typed platform SDK.

### `packages/api-client`

Reusable HTTP clients and API contract integration.

### `packages/config`

Shared build and development configuration where appropriate.

### `packages/identity-browser-client`

Identity-owned cookie, CSRF, session, actor, and sign-out browser transport.

### `packages/offline`

Domain-neutral connectivity, encrypted-payload helpers, durable command
contracts, idempotency, retry/conflict classification, sync status vocabulary,
and scoped service-worker registration. Domain mutation rules remain in apps.

### `packages/telemetry`

Shared Sentry and PostHog initialization, app identity, release/environment,
PHI redaction, safe event/property allowlists, replay disablement, and a safe
React error boundary. Telemetry is non-critical and is never a clinical store.

### `shared/*`

Low-level reusable technical primitives.

Avoid turning `shared/` into a dumping ground for cross-domain business logic.

Current repository implementation:

`packages/api-client/` owns
transport concerns (base URL normalization, timeout/abort handling, no-store
requests, and JSON decoding). It is consumed by the EHR frontend for API and
presigned-document transport and by Identity for shared timeout/abort handling
in REST, admin, upload, and migration-capture paths. Auth/session state, CSRF,
legacy endpoint semantics, and domain response parsing remain in the owning
application. Its bounded Lab and Pharmacy clients additionally propagate bearer
or Identity session-cookie user evidence, facility, purpose, correlation and
idempotency context while keeping internal workload authorization separate.
Cookie mutations preserve Origin and CSRF evidence. The clients use a
10-second timeout, retry an idempotent network/502/503/504 failure at most once,
and obtain a fresh rotating workload credential for each attempt.

`packages/offline` and `packages/telemetry` are consumed by every active
browser application. Only Outreach currently persists an offline mutation
outbox. Every application has a scoped static-shell service worker that excludes
`/api/`; Sentry/PostHog replay and automatic capture are disabled and all
product-event properties pass a strict non-PHI allowlist.

## 27. AI Architecture

All AI functionality must sit behind provider abstractions.

Business logic must not directly depend on provider-specific SDK calls throughout the codebase.

Adapters may support:

* Amazon Bedrock
* OpenAI
* Google
* other approved providers

Provider selection must not change domain contracts.

Clinical safety remains more important than model convenience.

## 28. Mobile Readiness

Every public API should remain consumable by future mobile clients.

Do not assume:

* browser cookies are always available
* every client is a desktop browser
* every request has continuous connectivity

Design authentication and API contracts with future mobile applications in mind.

## 29. Testing Architecture

Every new feature should include appropriate:

* unit tests
* integration tests
* API contract tests

Critical workflows require end-to-end coverage.

Critical workflows include:

* login
* facility authorization
* patient resolution
* NIN resolution
* consent
* break-glass
* encounter creation
* clinical writes
* Lab requests
* Pharmacy workflows
* OCR validation
* offline synchronization

## Implemented Lab accession boundary

The transitional boundary preserves `EHR order intent -> Lab work item -> Lab
accession -> specimen requirement -> physical specimen` as separate identities.
Lab generates non-patient identifiers. Collection, receipt, and rejection are
explicit commands with immutable history. Accession is not collection; receipt
is not testing; testing is not a verified result.

## 30. CI/CD Readiness

Every independently deployable service must support independent execution of:

* lint
* type checking
* tests
* build
* Docker build

A service should not require rebuilding unrelated services for every change.

## 31. Code Cleanup

During architectural migration:

Remove verified:

* dead code
* duplicate code
* duplicate DTOs
* duplicate models
* duplicate repositories
* duplicate utilities
* duplicate services
* duplicate interfaces
* unused imports
* unused files
* unreachable code
* obsolete configuration

Never delete historical migrations blindly.

Migrations already applied to persistent environments are part of system history.

Use follow-up migrations when required.

## 32. Future Modules

Architecture must permit future services without major redesign.

Examples:

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

Future modules should integrate through established Identity, API, event, security, and audit boundaries.

## 33. Target Architecture Goal

The HID platform should evolve toward infrastructure capable of serving:

* millions of patients
* thousands of healthcare facilities
* multiple healthcare domains
* multiple African countries

The implementation must remain understandable to new engineers.

Scalability must not come at the cost of:

* correctness
* patient safety
* security
* auditability
* maintainability

## Implemented Lab execution boundary

The Lab-owned chain is `received specimen -> exact requested test -> execution
-> manual unverified result -> independent exact-version verification ->
separate exact-version release`. Start, completion, verification, and release
are explicit events. A correction always appends a new unverified revision;
released history is immutable and remains distinct from the current head. No
analyzer, instrument, reagent, calibration, QC, or attestation is inferred.

## 34. Governed Platform Administration

The active administrative composition is:

```text
apps/admin :3106
        |
        v
one-origin gateway :3000
        |
        +--> /api/v1/admin/* --> Identity API :3001
                                  |-- auth/identity/facility commands
                                  |-- immutable audit reads
                                  `-- bounded operations aggregation
                                         |--> APIs :3001-:3006
                                         `--> Dispatcher :3010
```

No Admin BFF exists. Identity is the correct owner for human authentication,
accounts, sessions, facilities, workforce membership, platform-role
assignments, registration review, and audit. Its operations aggregator is
read-only, concurrent, bounded, and response-minimizing; it does not acquire
foreign-domain SQL. The Admin browser never calls internal service hosts.

Platform authority uses explicit `auth.account_roles` assignments and
`platform.*` permissions. Facility roles and platform roles are resolved into
separate context fields. Platform permissions never satisfy a clinical
permission string, never activate break-glass, and never bypass a domain
workflow. Sensitive commands repeat permission checks in the database, bind
reason/idempotency/expected version, and append semantic evidence.

Migration `0027` adds only Identity/security lifecycle and administration
needs plus a PHI-minimal neutral dispatcher-failure read. All runtime roles
remain NOLOGIN, non-owner, and non-BYPASSRLS. See
`SUPER_ADMIN_FOUNDATION.md` and ADR-029.
