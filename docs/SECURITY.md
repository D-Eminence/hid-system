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

Patient approval, denial, and revocation require an active patient session and
the exact patient linked to that account. The browser does not supply a
workforce facility for these commands. Approval binds the existing request's
staff membership, facility, scope, purpose, and expiry to one consent grant.
Revocation closes that grant immediately; expired or revoked grants cannot
authorize subsequent chart access. Identity records each transition in the
audit trail. The patient request projection exposes requester and organization
context without expanding the authority of a grant.

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

Detailed emergency EHR reads are limited to one completed encounter at a time.
They require fresh Identity break-glass authorization for the exact patient and
selected facility, emergency purpose, the emergency write permission, and the
individual chart section read permissions. The route returns only final signed
or amended records within that encounter. Detailed Lab records cannot be read
through break-glass authorization.

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

## 10. Clinical Integrity

Never silently overwrite clinical records.

Lab draft activation hands the exact committed active order version to Lab
with a stable idempotency key. Lab queues and detailed reads recheck patient
authorization before disclosing work. Provider result discovery and history
show only valid released versions; an unreleased correction remains private
until separately verified and released.

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

A staff member's selected facility is stored on the HID server session and
revalidated against active staff, organization, and facility membership on
every session resolution and refresh. Every clinical request still supplies an
authorized facility context. Patient sessions have no selected staff facility.

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

Identity and Pharmacy preflight responses advertise only methods and headers
used by their versioned routes. The configured origin allowlist, credentialed
cookie policy, Origin checks and CSRF validation remain mandatory for unsafe
browser requests.

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
