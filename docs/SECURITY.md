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
