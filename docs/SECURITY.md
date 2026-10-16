# HID Security Architecture

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

Browser sessions use host-only `SameSite=Strict` cookies, and cookie
mutations require an approved Origin and a CSRF token (`INTERFACE_CONTRACT.md`,
"Auth session contract"). The exceptions are Identity's patient
authorization check (`POST /api/v1/identity/service/authorization/check`),
which EHR, Lab, OCR and Pharmacy call with the user's cookie, and its Outreach
authorization (`POST /api/v1/identity/outreach/authorize`), which Outreach
calls the same way: Identity skips that check there only when the caller
authenticates as an approved workload and reports the request it serves as
`GET`, `HEAD` or `OPTIONS` in `X-HID-Original-Method` (ADR-043). The Outreach
authorization accepts only the `outreach-api` workload and, after such a skip,
authorizes only a permission ending in `.read`, so an Outreach write still
needs the allowed Origin and CSRF token (ADR-045, D-Eminence/hid-system#43).
It does not authorize `outreach.campaign.write` at all, as on `main`: who may create campaigns,
change their status and add members, and so who enters a campaign's linked
registrations, is an open product decision (ADR-045). Sign-out must still work once the
short-lived access token has expired: with D-Eminence/hid-system#39, Identity
ends the sign-in by its refresh cookie and the CSRF token derived from that
refresh token. A client's declaration of which application it is (`X-HID-Client`) may
only narrow what a request acts on; it never authenticates or authorizes
(ADR-044).

A `401` means the credential was refused, and clients sign out on it. In
Identity and EHR, the launch services, a fault that leaves a service unable to
decide is a `503` with a stable code, never a `401` (ADR-059,
D-Eminence/hid-system#76); that includes EHR's own workload
credential refused by Identity, which EHR answers `503`. One fault is still
a `500`: EHR's document upload intent and completion answer an
`uploads_enabled` control they cannot read `500 INTERNAL_ERROR` (an open
follow-up, release checklist §9). Lab, Pharmacy, OCR
and Outreach still relay Identity's refusal of their workload credential, and
OCR's guard still answers a fault with no status `401`: all four are off at
launch (D17), and the mapping is a follow-up before any is enabled. Sign-in refusals carry one detail, "Invalid
credentials", so the answer never confirms a right password; the reason stays
in the audit. A disallowed `Origin` is refused `403 ORIGIN_DENIED` by every
service's CORS layer. No platform grant exempts a staff or patient session
from maintenance mode or the portal switches; only a platform administration
session is exempt in Identity. The same holds on the authenticated platform
MFA routes: a wrong step-up code is `403 MFA_INVALID_CODE` and a session that
lost its MFA assurance during the request `403 PLATFORM_SESSION_REQUIRED`,
never `401` (A20, this change); only the unauthenticated sign-in challenge
steps answer a wrong code `401`.

A rate-limit answer says when to retry only where that discloses nothing
(A21, this change). A `429` from Identity states, in `Retry-After`, the
limit's full configured window, an upper bound whichever bucket refused;
never the time left in a bucket keyed by an identifier the caller named (an
email, a phone number, an HID), which would tell another person's activity on
it. A refusal answered like a wrong code (a spent recovery or enrollment
contact code budget, D-Eminence/hid-system#55 and #61, and the sign-in
lockout's `401`) carries none, and every `429` of the enrollment contact step
carries one value, so a spent budget stays indistinguishable from that
step's request limits. The one value that is not a full window, on
`429 OTP_RESEND_COOLDOWN`, is the time left on the caller's own enrollment
code, which its enrollment cookie proves (at the contact step and, from 0093,
the holder step). The holder step's `429 NIN_HOLDER_ROUTE_LIMITED` carries
none: its budgets are kept per phone and per NIN, so a time left would tell
of other people's attempts on that NIN, and the answer sends the patient to a
participating facility rather than to wait.

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

The QoreID self-verification route is intentionally different: its adapter is
server-only, takes the 11-digit NIN from the browser and derives required name
and DOB provider claims from the existing patient session. It validates the
returned registry NIN and demographics against that canonical patient and
requires the submitted NIN's keyed lookup HMAC to match the same patient's
prior verified, unrevoked NIN identifier before recording a verified result.
It persists no NIN, raw response, OAuth
token, demographic result, image, or address. Its append-only evidence and
atomic audit record only the existing subject reference, provider, normalized
outcome, timestamp, bounded failure category, correlation, and optional safe
provider transaction reference. CAC verification has the same minimization
rule and is bound to an existing organization selected from an authorized
facility membership. Neither flow may create, merge, link, transfer, or relink
identity records. See [QoreID verification contract](QOREID_VERIFICATION_CONTRACT.md).

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
* Migrate operations
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

A refusal or failure row records the status and code answered
(`details.status`, `details.code`) and never the error's message: Identity's
`SecurityGuard` and request audit since this change (A17), EHR's guard and
request audit since D-Eminence/hid-system#74. Codes are fixed constants of
the services, never a request value, and the same code is already in the
answer. A patient session's request rows record purpose `patient-self`,
whatever purpose the client sends, so a patient's own action cannot be
labelled direct care or emergency in the audit trail; a staff request's
purpose is still the one it declares and its route checks.

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

## 14. API Security

Apply:Read `CODEX.md`, `docs/TASK.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/SECURITY.md`, and `docs/DATABASE.md`.

Continue the remaining Phase 0 database-role verification.

## New host-terminal evidence

From repository root:

```text
db:plan:
0 pending migration(s)
```

Therefore migrations `0001` through `0011` are now applied according to the migration ledger.

PostgreSQL role inspection returned:

```text
rolname | rolcanlogin | rolbypassrls | rolsuper
--------+-------------+--------------+---------
(0 rows)
```

No `hid_*` database roles currently exist.

Repository search found the intended provisioning file:

```text
ehr/server/database/runtime-grants.sql
```

It contains creation of:

```text
hid_ehr_runtime
```

with:

```text
NOLOGIN
NOSUPERUSER
NOCREATEDB
NOCREATEROLE
NOINHERIT
NOBYPASSRLS
```

The schema integration test expects:

```text
hid_ehr_runtime
hid_audit_writer
```

and attempts to grant those roles to its test runtime role.

## Critical architecture issue discovered

Do NOT ask me to execute `runtime-grants.sql` yet.

The current runtime grants include direct EHR runtime access to Identity-owned persistence, including:

```sql
grant select, insert
on identity.patients, identity.patient_identifiers
to hid_ehr_runtime;
```

and:

```sql
grant select, insert, update
on identity.registration_cases
to hid_ehr_runtime;
```

with additional direct Identity grants.

This must be reviewed against the new authoritative architecture.

The new architecture requires:

```text
EHR -> Identity API -> Identity persistence
```

and prohibits:

```text
EHR -> direct writes to Identity-owned tables
```

Shared physical PostgreSQL infrastructure does not permit cross-service persistence ownership.

## Objective

Inspect the complete database role and grants model before provisioning any runtime roles.

Review:

```text
ehr/server/database/runtime-grants.sql
ehr/server/database/tests/schema.integration.sql
ehr/server/database/migrations/
```

and all code that directly accesses:

```text
identity.patients
identity.patient_identifiers
identity.registration_cases
identity.registration_case_candidates
identity.registration_case_events
identity.access_requests
identity.consent_grants
```

Determine for each direct Identity access whether it is:

1. required only by the current transitional implementation
2. already replaced by an Identity API
3. required for read-only authorization/context resolution
4. an architecture violation requiring removal
5. test-only behavior
6. obsolete

Do not mechanically remove grants before identifying their consumers.

## Target database-role model

Design the role model so domain ownership remains explicit.

At minimum distinguish:

```text
Identity runtime role
EHR runtime role
Audit writer role
Migration/admin role
Schema-test role
```

Additional Lab, Pharmacy, Outreach, and OCR roles may be introduced later when those services are extracted.

### EHR runtime

`hid_ehr_runtime` must not receive direct mutation privileges over Identity-owned tables in the final service boundary.

EHR should use Identity APIs for governed Identity mutations.

If temporary read access remains necessary during incremental migration, document it explicitly as transitional technical debt and minimize it.

Prefer removing Identity mutation privileges now if current working functionality can use the existing Identity boundary safely.

### Identity runtime

If Identity-owned persistence needs a runtime role and none exists, design/provision the appropriate Identity runtime role rather than allowing `hid_ehr_runtime` to own Identity mutations.

### Audit writer

Inspect `hid_audit_writer`.

It must have the minimum append privileges required for semantic audit.

It must not receive unnecessary update/delete rights over immutable audit evidence.

## Important

Do not weaken tests to make them pass.

Do not merely create `hid_ehr_runtime` with the existing grants without reviewing ownership.

Do not rewrite applied migrations `0001` through `0011`.

Database-role provisioning may live outside migrations if that is the intended architecture, but it must be:

* deterministic
* repeatable
* least privilege
* documented
* usable locally
* usable in CI
* compatible with future AWS RDS deployment
* free of embedded production passwords

## Inspect runtime implementation

Search application code for direct Identity persistence access from the EHR backend.

Search for:

```text
identity.patients
identity.patient_identifiers
identity.registration_cases
identity.registration_case_candidates
identity.registration_case_events
identity.access_requests
identity.consent_grants
```

Also inspect repositories, SQL queries, database services, registration code, consent code, and Identity integration modules.

For each access classify it as:

```text
KEEP TEMPORARILY
REPLACE WITH IDENTITY API
MOVE TO IDENTITY SERVICE
READ-ONLY TRANSITIONAL
REMOVE
```

## Implement the smallest architecture-correct fix

After inspection:

1. correct `runtime-grants.sql`
2. introduce missing runtime roles if required
3. preserve current working behavior
4. route Identity mutations through the proper Identity ownership boundary
5. keep transitional exceptions only where removing them now would break verified functionality
6. document every transitional exception

If application code must change, add/update tests.

## Provisioning safety

Once the role model is corrected, provide the exact host-terminal command to provision roles.

Prefer a repository-supported command such as:

```text
npm run db:bootstrap
```

or equivalent if one already exists.

If no safe command exists, add a clearly named script rather than relying on developers to remember raw `psql` commands.

The provisioning operation should be idempotent.

Running it twice must not corrupt privileges or fail merely because roles already exist.

## Schema integration test

After role provisioning, the expected host-terminal sequence should ultimately be reproducible from repository root.

Provide the exact commands.

Then verify:

* `hid_ehr_runtime` exists
* `hid_ehr_runtime` is not SUPERUSER
* `hid_ehr_runtime` does not BYPASSRLS
* runtime role does not own protected tables
* runtime role does not have inappropriate Identity write privileges
* audit writer privileges are append-oriented and minimal
* grants match service ownership
* schema integration test passes
* RLS assertions pass
* facility isolation assertions pass
* migration ledger remains at zero pending

## Update documentation

Update as required:

```text
docs/DATABASE.md
docs/SECURITY.md
docs/ARCHITECTURE.md
docs/TASK.md
```

If a temporary cross-schema read is retained, document why and the exact extraction/removal milestone.

Do not create an ADR merely for an implementation detail unless it changes an architectural decision.

## TASK.md

Record:

* migrations 0001-0011 applied
* zero pending migrations verified
* missing runtime roles discovered
* `runtime-grants.sql` discovered
* cross-service Identity write-grant issue
* final role design
* files changed
* tests run
* host command required for provisioning
* remaining database verification
* exact next task

Do not mark Phase 0 complete until the corrected role provisioning and schema integration tests have passed.

Implement the correction now rather than only reporting it.


* input validation
* request-size limits
* secure headers
* CORS controls
* CSRF protection where cookie authentication requires it
* rate limits
* idempotency
* secure errors
* correlation IDs

### Edge controls at launch (ADR-055)

* **Browser headers.** Every Cloudflare frontend Worker response carries
  `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains` until
  every subdomain is confirmed HTTPS-only). The Health-id hosts (www, the
  staging web host, admin.*) send a Content-Security-Policy that allows script
  only from the page's origin and `https://challenges.cloudflare.com`
  (Turnstile), with `default-src 'none'`, no inline script or `eval`, no
  plugins or workers, and `frame-ancestors 'none'`; API and edge answers send
  `default-src 'none'; frame-ancestors 'none'`. The Health-id artefact
  verifier keeps the build to its Vite shell with no inline script. Its
  `connect-src` allows only the page's origin and Turnstile, so switching
  document uploads on (off at launch) must add the documents bucket's S3
  origin in the same release: Health-id uploads straight to the presigned URL.
  The undeployed legacy product hosts get no page policy and need their own
  before they are deployed. www grants no camera, microphone or location.
* **WAF.** The origin secret first; the AWS Core Rule Set with every rule
  blocking except the 8 KB body rule, which is lifted only for `POST`/`PATCH`
  on the encounter-scoped clinical write routes (raw-path match); known bad
  inputs; a rate limit per client network (`X-HID-Client-Network` from the
  Worker: the IPv4 address or the IPv6 /64, so address rotation inside a /64
  keeps one count) and a high backstop per connecting address, which, once
  tripped by traffic spread over many networks, blocks every user behind that
  Cloudflare egress address for the rest of the window. Bodies stay bounded by
  the gateway (512 KiB, `413 PAYLOAD_TOO_LARGE`) and by each service.
* **Gateway.** Service-to-service routes, including the document scanner's
  callback, answer `404` at the public gateway. Upstream error answers pass
  through with their codes. The access log records the path without its query
  string and never the request line, cookies or credentials. The error log
  takes only critical messages, since nginx writes the request line (query
  included) into every error or warning about a request; a critical message
  about a request still carries it. The Worker's origin secret and the WAF's
  client-network key are not forwarded to any backend.

## 15. Secrets

Secrets must not be committed.

Use environment configuration locally.

AWS target:

Secrets Manager and KMS.

## 16. Least Privilege

AWS IAM, database users, application accounts, and service permissions must follow least privilege.

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
