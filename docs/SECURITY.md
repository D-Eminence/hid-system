# HID Security Architecture

## Current edge, authentication, and messaging controls

- Every production and staging frontend has its own Cloudflare Worker and
  host-only cookie; `.healthidentitydirectory.com` cookies are prohibited.
- Workers accept only their exact environment-paired hostname and `/api/v1/*`,
  use one fixed allowlisted AWS origin, preserve bounded correlation/origin evidence, and set API
  `private, no-store` controls. Request bodies, cookies, authorization, OTP,
  NIN, and PHI are never edge logs.
- Staging Workers can only reach `api.staging.healthidentitydirectory.com` and
  production Workers can only reach `api.healthidentitydirectory.com`; an
  origin header, Host header, path, or query value cannot override that pair.
  Each environment requires an independently stored `ORIGIN_AUTH_TOKEN` and
  fails closed when it is absent or malformed.
- Turnstile requires both the client widget token and Identity server
  Siteverify. Production requires an exact approved hostname/action and a
  server-only secret and fails closed on absence, timeout, rejection, mismatch,
  expiration, or duplicate use.
- Authentication OTPs are exactly six digits from cryptographic randomness,
  purpose-bound, HMAC-protected at rest, single-use, attempt-bounded, expiring,
  cooldown/rate-limited, absent from URLs/logs/audit/telemetry, and delivered
  directly without Novu retention.
- Ordinary notifications contain no unnecessary PHI. Provider credentials,
  FCM device tokens, presigned URLs, NIN, Turnstile tokens, and clinical values
  are covered by the shared Sentry/PostHog redaction boundary. Replay,
  autocapture, and session recording remain disabled; telemetry fails open.
- Supabase-hosted source access exists only in controlled migration tooling.
  No deployable service proxies source passwords, sessions, database, storage,
  realtime, or Edge Functions.

## 1. Security Principle

Security is a platform requirement.

No service may weaken authentication, authorization, audit, facility isolation, identity protection, or clinical integrity for convenience.

## 2. Authentication

Protected APIs require verified authentication.

Do not trust:

* client-selected roles
* client-selected facilities without server verification
* frontend state as authorization
* unsigned identity claims

Authentication implementation must support future evolution without rewriting domain controllers.

## 3. Authorization

Use RBAC and domain permissions.

Authorization must consider:

* authenticated actor
* active facility
* organization membership
* role
* permission
* patient access
* consent
* purpose of use
* emergency access state where applicable

## 4. Facility Isolation

Clinical and operational access must be scoped to the active facility unless an explicitly authorized cross-facility workflow exists.

A valid account alone is not enough.

## 5. Identity Security

Identity is the single source of patient identity.

No service may create an alternative patient authority.

Patient lookup must expose the minimum information required.

## 6. NIN Security

NIN is sensitive identity data.

Requirements:

* never use as patient primary key
* protect at rest
* avoid plaintext logs
* avoid unnecessary API response exposure
* audit access
* enforce uniqueness for verified NIN
* never attach unverified NIN as verified identity
* use provider abstraction
* avoid query-string exposure when possible

For governed registration, the raw NIN is accepted only in a protected POST
body. The server derives a keyed lookup HMAC and never stores an unkeyed digest
of the raw value. Encrypted identifier rows carry the exact registration-case
binding. A verified unmatched NIN creates a reviewable case only; it cannot
create a patient without the explicit `approved_new_identity` transition.
Review and link commands require permission, facility scope, `Idempotency-Key`,
and optimistic `expectedVersion` checks. Concurrent duplicate requests resolve
to one case or fail with a non-disclosing conflict.

## 7. Consent

Patient access must respect the consent model defined by Identity.

Consent decisions must be facility-aware where appropriate.

## 8. Break-Glass

Emergency access must:

* require explicit reason
* be exceptional
* be time-bounded where appropriate
* be auditable
* identify actor
* identify facility
* identify patient
* identify purpose
* be distinguishable from normal access

The current database authorization permits break-glass only for
`read_records` with the governed `emergency` purpose and an exact active,
unheld, reasoned, time-bounded grant matching patient, actor membership, and
facility. It does not authorize clinical writes, permission administration, or
arbitrary actions. Normal consent remains subject to applicable deny
directives.

## 9. Audit

Audit sensitive:

* authentication
* authorization
* denied access
* patient lookup
* NIN lookup
* consent
* break-glass
* clinical reads
* clinical writes
* document access
* OCR operations
* offline synchronization
* administrative operations

Audit records should contain:

* correlation ID
* actor
* facility
* action
* resource
* outcome
* timestamp
* purpose where relevant
* safe request context

Never place secrets or unnecessary PHI in audit details.

## 10. Clinical Integrity

Never silently overwrite clinical records.

Use as appropriate:

* revision history
* corrections
* optimistic concurrency
* version checks
* immutable signed records
* explicit supersession

## 11. File Security

Healthcare files must not be publicly accessible.

Use:

* private S3 objects
* authorized upload
* signed URLs
* short expiration
* content validation
* restricted MIME types
* secure download authorization
* malware scanning integration when available
* hashes where required

## 12. OCR Security

OCR is untrusted extraction until validated.

OCR must not:

* auto-link ambiguous patients
* automatically create official clinical records
* directly modify another service's database
* expose uploaded files publicly

Durable OCR jobs and evidence use forced facility RLS plus server-side patient
reauthorization. A job is accepted only for the exact immutable object version
and SHA-256 covered by the latest clean scanner evidence. `hid_ocr_api_runtime`
composes `hid_ocr_runtime` and append-only audit only; `hid_ocr_worker` has no direct table
access and can invoke only constrained lease/token-bound claim, renewal,
result, and failure commands. The standalone worker retrieves the exact S3
version and verifies byte count plus SHA-256 before any provider request;
expired ownership is recovered under lock and stale workers cannot complete.
Production fails closed unless the real Textract adapter and database TLS are
configured. Provider
errors are stored as bounded machine codes and safe summaries, never raw
provider responses. Original extraction and human validation evidence are
append-only.

Publication requires non-emergency write authorization, the latest canonical
patient confirmation, an immutable validation version, target permission, and
database idempotency. Break-glass read access never authorizes validation,
confirmation, or publication. OCR roles retain no Identity or clinical-table
mutation privilege. The EHR runtime alone writes imported clinical notes and
their minimum-necessary OCR provenance through the EHR domain service.

The OCR HTTP API runs separately on port 3005 and has no EHR, Identity, Lab,
Pharmacy, or Outreach SQL privilege. It authenticates the human through
Identity and calls EHR, Lab, and Pharmacy with typed clients. Each internal
call requires both propagated human evidence and a separate exact `ocr-api`
workload identity. Local process-generated secrets are development-only;
production requires HTTPS issuer/JWKS validation, the target-service audience,
signature/expiry checks, exact OCR subject, and rotating mounted token files.
The EHR source boundary returns minimum document/object evidence only. The EHR
publication boundary reauthorizes the user and accepts only publication-bound
idempotency and validated provenance.

### 12.1 Lab imported-evidence security

Lab-owned imported external evidence uses canonical patient authorization,
forced facility RLS, immutable observations, exact source references,
idempotency, atomic semantic audit, and a minimum-necessary outbox. The
`hid_lab_runtime` role is NOLOGIN, non-superuser, and non-BYPASSRLS; it cannot
create Identity patients or mutate EHR/OCR persistence. Break-glass remains
read-only and cannot create an import. OCR can request the Lab command only
through the Lab service boundary after exact validation and patient
confirmation; it has no direct Lab table write privilege.

### 12.2 Lab accession and specimen security

Only the Lab runtime mutates Lab accessions/specimens; EHR and OCR roles have no
direct mutation grants. Forced RLS binds rows to the canonical patient and
active facility. Commands require Lab permissions, reject break-glass writes,
use expected versions, legal-transition triggers, append-only events, semantic
audit, and transactional outbox evidence. Server-generated labels contain no
HID, NIN, patient name, or clinical content.

## 13. Offline Security

Offline mode must not bypass security.

Requirements include:

* encrypted local storage where sensitive data is cached
* minimum required local PHI
* session expiration handling
* secure re-authentication
* remote logout considerations
* secure cache invalidation
* device data cleanup strategy
* audit of offline actions

Browser applications must not persist facility setup, patient/staff profiles,
contact details, or OTP contact context as local/session storage state. Opaque
workflow handles may be retained only for the minimum handoff lifetime and
must not be treated as authorization.

Current browser policy:

* all seven applications expose honest connectivity state and path-scoped
  static-shell service workers;
* service workers never cache `/api/` responses and therefore are not a PHI
  response store;
* only Outreach persists an offline mutation queue in this checkpoint, using
  encrypted IndexedDB, a browser-held non-extractable AES-GCM key, stable
  idempotency, explicit retry/conflict state, and acknowledged-PHI cleanup;
* Pharmacy dispensing/reversal, OCR execution/validation/publication, Lab
  verification/release, and Admin mutations require live server acceptance;
* reconnect always re-authenticates/re-authorizes and a queued command does not
  inherit indefinite authority from a formerly valid browser session; and
* plaintext PHI is prohibited from localStorage, sessionStorage, Cache Storage,
  URLs, and telemetry persistence.

### 13.1 Frontend telemetry security

`packages/telemetry` is the only supported Sentry/PostHog initialization path.
Sentry receives sanitized technical failures, safe error codes/correlation IDs,
app, environment, and release context. Its pre-send policy removes user and
free-form contexts, request URLs/headers/bodies, response bodies, input/console/
XHR/fetch breadcrumbs, and replaces exception values with redacted text.
`sendDefaultPii` is false.

PostHog accepts only enumerated event names and primitive allowlisted properties.
Patient/HID/NIN/name/contact data, clinical notes/diagnoses, Lab values,
medication/prescription details, OCR text/document contents, URLs, tokens,
cookies, CSRF, payloads, and secrets are prohibited from both systems. Sentry
Replay/Feedback and PostHog session recording, autocapture, automatic pageviews,
and durable analytics persistence are disabled for every application, including
Admin. Telemetry failure is swallowed and cannot block product behavior.

Static policy tests validate redaction and allowlists, source scans reject
direct SDK initialization, and production bundles are scanned for secrets and
internal service ports. Live external Sentry/PostHog delivery observation is
still environment acceptance, not local proof.

## 14. API Security

Apply:

* input validation
* request-size limits
* secure headers
* CORS controls
* CSRF protection where cookie authentication requires it
* rate limits
* idempotency
* secure errors
* correlation IDs

## 15. Secrets

Secrets must not be committed.

Use environment configuration locally.

AWS target:

Secrets Manager and KMS.

## 16. Least Privilege

AWS IAM, database users, application accounts, and service permissions must follow least privilege.

The extracted PostgreSQL role boundary is explicit. `hid_identity_api_runtime`
composes only Identity/authentication persistence and append-only audit.
`hid_ehr_api_runtime` composes EHR and append-only audit but has no OCR or
Identity mutation membership. `hid_ocr_api_runtime` composes OCR and
append-only audit but has no EHR or Identity mutation membership. The retired
`hid_api_runtime` aggregate is privilege-free.
No application role owns protected schemas, can log in directly, or has
`BYPASSRLS`; environment-specific service LOGINs are deployment-owned.

`hid_document_scanner`, `hid_migration_admin`, and
`hid_schema_test_runtime` are separate non-login boundaries. Scanner access is
limited to the security-definer append command; migration administration is
never inherited by application logins; and the schema-test role exists only for
rollback-only database acceptance tests. Runtime roles are non-superuser,
non-login, non-`CREATEROLE`, non-`CREATEDB`, and do not bypass RLS.

`hid_event_dispatcher` is a command-only non-login group role: it can execute
four lease/status functions and has no direct domain or `integration` table
privilege. `hid_event_delivery_commands` is the never-inherited technical
function owner; explicit RLS policies let it read only the five active domain
outboxes, and grants let it mutate only delivery/inbox state. It cannot mutate
domain data. EventBridge production uses workload IAM limited to one exact bus;
static keys are rejected. Event payload/provider bodies are never logged, and
minimum-necessary payload policy is revalidated recursively before transport.

### Extracted Identity workload boundary

Identity authenticates the propagated user and the calling workload
independently. EHR, Lab, Pharmacy, Outreach, and OCR cannot turn caller headers
into authorization assertions. Identity revalidates user session, membership,
facility, permission, purpose, patient, consent, and break-glass state.

Production permits only HTTPS issuer/JWKS workload validation with an explicit
Identity audience, signature/expiry checks, and exact per-service subjects.
Callers read rotating mounted tokens per request. Development-only secrets are
separate per caller and are rejected in production. User tokens, workload
tokens, raw NIN, passwords, full profiles, and clinical payloads are never
logged.

Inbound workload JWT text is rejected above 16,384 characters before JOSE
parsing. Mounted workload credentials must be regular files within the bounded
size limit and normalize to exactly one non-empty Bearer credential; oversized,
whitespace-bearing, malformed, or non-regular inputs fail closed.

Consent remains co-located in Identity for this extraction because it is part
of the current patient-access decision. Break-glass remains emergency read-only
and cannot authorize patient creation, HID issuance, identifier/NIN mutation,
registration approval, merge, consent mutation, or other administrative writes.

## 17. Healthcare Compliance Direction

Architecture must remain compatible with applicable Nigerian data protection obligations and healthcare security requirements.

Design should also use appropriate HIPAA-inspired safeguards and remain ready for HL7 FHIR interoperability.

Compliance claims must not be made solely because a technical feature exists.

## 18. Security Verification

Security-sensitive changes require tests for:

* unauthorized access
* wrong facility access
* expired authorization
* missing consent
* break-glass
* invalid tokens
* invalid NIN resolution
* duplicate NIN
* cross-service access
* document authorization
* offline synchronization conflicts

### Lab execution and governed-result security

Forced RLS, Lab-only permissions, canonical-patient authorization, facility
integrity, non-break-glass mutation, idempotency, and optimistic versions cover
execution/results. EHR/OCR roles cannot mutate them. Immutable manual revisions
preserve history; audit/outbox omit result values. Verification and release
require separate permissions and exact-version, reasoned, idempotent commands;
release cannot occur without verification of that version. Normal released
result readers cannot observe an entirely unreleased result. Post-release
correction requires the dedicated revise-released permission, appends a new
unverified version, and never overwrites released history. Break-glass cannot
authorize any of these mutations.

### Extracted Lab boundary

`hid_api_runtime` no longer inherits `hid_lab_runtime`. The extracted service login must inherit only `hid_lab_api_runtime`, which composes Lab persistence and append-only audit privileges and has no EHR or Identity mutation authority. Lab authenticates the actor through Identity, independently evaluates facility/permission and patient authorization, and rejects break-glass mutation through its unchanged domain policy. Internal EHR/OCR commands require a separate caller identity in addition to actor delegation. The ephemeral shared-token adapter is local-development-only and configuration rejects it in production.

Production Lab caller authentication uses asymmetric workload JWT verification with configured HTTPS issuer and JWKS, the `hid-lab-api` audience (environment configurable), expiry/signature enforcement, and separate exact subjects for EHR and OCR. Callers read rotating mounted tokens for each request; tokens, user bearer credentials, and clinical payloads are not logged. Live issuer and platform token delivery remain deployment evidence, not repository evidence.

### Extracted Pharmacy boundary

`hid_api_runtime` does not inherit `hid_pharmacy_runtime`. A Pharmacy service
login inherits only `hid_pharmacy_api_runtime`, which composes Pharmacy table
access with append-only audit and has no Identity patient insertion or EHR,
Lab, and OCR mutation capability. EHR and OCR roles have no Pharmacy table
write privilege. Forced RLS requires exact facility transaction context and an
active canonical-patient authorization decision; wrong/missing facility,
patient, membership, or purpose fails closed.

The Pharmacy guard authenticates propagated bearer or Identity session-cookie
user evidence with Identity,
resolves the facility-scoped permissions, and calls Identity again for patient
read/write authorization. Break-glass may support governed emergency reads but
is rejected for prescription acceptance, dispensing, reversal, and import.
Cookie-authenticated unsafe requests use Identity's POST service-session path
and preserve Cookie, exact Origin, and CSRF evidence across the boundary.
Internal EHR and OCR routes additionally authenticate an independent service
identity. Production verifies an HTTPS issuer/JWKS, Pharmacy audience,
signature/expiry and exact EHR/OCR subjects, rejects local secrets, and reads
rotating tokens from bounded mounted files. User and workload credentials are
never interchangeable or logged.

Acceptance, dispensing, reversal and medication import write semantic audit
and minimum-necessary outbox records atomically with Pharmacy evidence. Audit
and events contain identifiers and state transitions, not the full
prescription or imported document text. Immutable operational tables reject
updates/deletes; reversal is append-only. OCR can call only the medication
evidence import and has no route or database permission capable of dispensing.

### Extracted Outreach boundary

`hid_api_runtime` does not inherit `hid_outreach_runtime`. The standalone
service login inherits only `hid_outreach_api_runtime`, composing Outreach
tables with append-only audit. It cannot insert Identity patients or identifiers,
mint HIDs, or mutate EHR, Lab, Pharmacy, or OCR persistence. Forced RLS binds
every row to the transaction actor, exact active membership, facility,
`direct-care` purpose, and Outreach permission; emergency/break-glass context
cannot mutate this workflow.

The Outreach guard propagates the user session but independently authenticates
the `outreach-api` workload on each Identity authorization call. Production
requires asymmetric issuer/JWKS/audience verification in Identity and a rotating
mounted JWT read by Outreach per call; it rejects the development shared secret.
Cookie access requires an allowed exact origin and CSRF evidence. Identity
failure, missing workload identity, inactive/wrong facility, permission denial,
and patient-authorization denial all fail closed.

Offline PHI is limited to encrypted IndexedDB commands under a non-extractable
AES-GCM key. `localStorage`, service-worker API caching, patient-derived
temporary IDs, raw NIN, and fake canonical success are forbidden. Server
registration, immutable history, idempotency, minimum outbox, and semantic
audit share one transaction. Audit/outbox payloads omit demographic/contact
content.

## 19. Platform administration security

Platform administration is explicit capability authorization in
`auth.account_roles`; it is never inferred from email, environment variables,
facility ownership, frontend state, or a developer identity. Identity resolves
platform roles/permissions separately from selected facility roles/permissions.
Every Admin API has a server permission requirement, and every sensitive
database command repeats the capability check under the request actor context.

`platform_super_admin` has broad platform capabilities but no clinical
permission, no break-glass activation, no RLS bypass, no SQL endpoint, and no
audit mutation. The other platform roles are narrower. Schema acceptance
rejects any non-`platform.*` permission mapped to these roles. Ordinary
facility admins cannot grant platform roles; Support cannot grant roles;
Security Auditor is read-only.

Reasons, actor/target, correlation, timestamp, action, outcome, and safe state
metadata are retained for meaningful mutations. Commands use immutable
actor/operation/key request digests and expected versions. Exact replay does
not duplicate semantic audit. The last active Super Admin cannot be suspended
or stripped of their last Super Admin assignment.

Facility suspension is authoritative: `active=false` is constrained to the
`suspended`/non-verified lifecycle, so existing staff-context and downstream
authorization checks fail without deleting clinical or audit history. Account
suspension increments token version and revokes active sessions. Raw NIN,
password hashes, refresh tokens, event payloads, patient audit identifiers, and
free-form audit details are not Admin DTO fields.

The one-time bootstrap needs an explicit administrator database connection,
exact eligible account UUID, and reason. It locks, fails when an active Super
Admin already exists, and appends audit. It is not ongoing authorization.

## 20. AWS and Cloudflare deployment security foundation

The CDK foundation in `infra/aws` encodes the deployment boundary without
claiming a live account. ECS tasks have separate execution and business task
roles. Execution roles pull images, write logs, and resolve only referenced
Secrets Manager values; task roles receive only actual AWS business calls.
Identity, Lab, Pharmacy, OCR API, Outreach, and Gateway have no business AWS
API permissions. EHR has exact document S3/KMS use, OCR Worker has exact
version read/decrypt plus the three implemented Textract operations,
Dispatcher has exact-bus `PutEvents`, Notification Worker consumes only its
exact encrypted queue, and Notification API has regional `ses:SendEmail`.
Region-conditioned Textract and SES calls are the only reviewed
`Resource: "*"` cases because those provider calls do not expose a deployable
document/message resource ARN. Synth rejects any other inline resource
wildcard and all action wildcards.

RDS is private, encrypted, forced-TLS, non-world-addressable, Multi-AZ in
staging/production, deletion-protected in production, and accessed through
the nine unique non-owner LOGIN secret interfaces. The generated master secret is
never injected into an application. The migration administrator and one-shot
task are separate. S3 is TLS-only, private-blocked, KMS-encrypted, versioned,
and bucket-owner enforced. Object keys must be opaque and PHI-free; lifecycle
must not override legal hold/retention governance.

All long-running tasks use private subnets and no public IP. Cloudflare Workers
hold an independent origin secret and attach it only to fixed-origin API
requests. Regional AWS WAF rejects requests without the exact secret and adds
Common/Known Bad Inputs plus a conservative rate rule before the public ALB.
Database ingress and internal task routes use source security groups. There is
no CloudFront distribution or static frontend in AWS. WAF and the origin secret
are edge controls, never browser authentication or clinical authorization.

True server secrets are Secrets Manager references, never CloudFormation
literal values. Workload JWT issuer/JWKS/subjects are external inputs and token
bytes must arrive through rotating read-only mounted files. The synthesized
empty task volume is not a delivery implementation; desired counts default to
zero and must stay there until staging proves delivery/rotation. NIN provider
mode remains unavailable until a real provider and keys are authorized.

Only Identity receives auth signing/login-pepper, NIN, OTP-HMAC, and Turnstile
material. Notification provider fields are injected only into Notification
API/Worker as required. Gateway receives no application secrets.

CloudWatch logs, alarms and metric dimensions must be PHI-free. CloudTrail,
central security logs, GuardDuty/Security Hub, WAF log redaction, alert routing,
backup restores, live IAM allow/deny, and workload identity observation remain
account/deployment controls. Full details are in `AWS_IAM_MATRIX.md` and
`AWS_DEPLOYMENT_ARCHITECTURE.md`.
