# HID Database Architecture

| Field | Value |
|---|---|
| Status | **Current database architecture and migration state; the future target architecture is governed by `docs/ARCHITECTURE.md`** |
| Target | Private Amazon RDS for PostgreSQL 16 major family; environment-specific minor version remains an AWS deployment input |
| Canonical patient key | Existing Identity patient UUID in the implemented migration; production governance approval pending |
| Governing sources | [Platform architecture](ARCHITECTURE.md) and [architecture decisions](DECISIONS.md); use the [migration runbook](MIGRATION_RUNBOOK.md) for controlled deployment procedures |

This document is the implementation-facing database overview for HID Identity,
EHR, Laboratory, Pharmacy, OCR/AI, and Outreach. It translates familiar
product nouns into the governed relational model. It does not replace the target
platform architecture. Broader target contexts still require their approval gates;
the implemented migration subset is governed by the
[migration runbook](MIGRATION_RUNBOOK.md).

### Executable Phase 0/1 subset

`services/ehr-api/database/migrations/0001` through `0028` implement the current
controlled-extraction schemas: `platform`, `auth`, `identity`, `audit`, `ehr`,
and `migration`. They preserve source patient UUIDs and HID codes, enforce EHR
foreign keys to `identity.patients.id`, use `ON DELETE RESTRICT`, and do not
create an EHR-owned patient table.

Migration `0028_identity_notification_migration_state.sql` is the first
pending additive migration after the immutable applied `0001`–`0027` ledger.
It adds only genuinely new durable requirements: Identity-owned OTP verifier
and rate-limit evidence, progressive patient assurance, a complete restricted
legacy identity mapping ledger, encrypted/revocable notification devices, and
PHI-free ordinary-delivery reconciliation metadata. It does not store plaintext
OTP/device tokens, create a competing patient key, or restore a hosted legacy
runtime.

The subset also includes membership/facility/consent RLS, append-only audit and
clinical history controls, concurrency-safe credential upgrade, source account
suspension preservation, fail-closed holds for legacy consent without a governed
purpose, scanner evidence bound to one exact object version and SHA-256,
database-authorized consent state transitions, and facility-scoped audit reads.
Migration `0011_governed_nin_registration.sql` adds protected, keyed NIN
bindings and the Identity-owned registration-case workflow. It binds each new
NIN identifier to its exact case, records duplicate candidates and immutable
case events, and requires explicit approval before a new patient UUID/HID is
issued. A verified unmatched NIN never creates a patient during resolution.
Migration `0012_narrow_break_glass_authorization.sql` makes emergency access a
read-only exception for an exact active, reasoned, time-bounded, unheld
break-glass grant; normal consent remains subject to deny directives.
Migration `0034_qoreid_verification_evidence.sql` adds only append-only minimal
evidence for a separately disabled-by-default QoreID integration. It has no
raw NIN/CAC, provider payload, OAuth token, photo, address, or demographic
columns. Patient and organization evidence is inserted only by narrowly scoped
commands that recheck the existing session or exact active organization
membership and atomically append semantic audit evidence; the migration does
not create, merge, relink, or transfer canonical records.
Migration `0047_provider_integration_controls.sql` adds the Identity-owned,
secret-free provider/capability catalog, current routing, runtime read functions,
versioned admin commands, and append-only change events. Migration
`0048_cac_legal_entity_binding.sql` introduced the CAC number/legal-name
approval guard and prevents a status-only result from activating a provider
organization. Migration `0056` extends this guard to a verified submitted
identifier and a complete profile with per-field provenance. Neither migration
stores a provider key, raw NIN, or raw QoreID response.
Migration `0049_qoreid_request_quotas.sql` adds cross-instance, atomic request
limits for new NIN/CAC verifications, safe connection tests, and public provider
applications. Counters contain canonical UUIDs or a keyed network digest, with
no raw NIN, CAC, IP address, or provider payload. The Identity runtime prunes
expired counters and test-key reservations after 48 hours.
Migration `0063_provider_self_service_cac_quota.sql` covers the accountless
provider self-enrollment CAC lookup, which has no account to charge. Its
command accepts only the system enrollment context and a self-service
application still awaiting CAC verification. It charges a keyed digest of the
server-observed client network (IPv4 address or IPv6 /64; 5 an hour, 15 a day)
and the application's existing daily `application_cac` target limit (3, shared
with the reviewer path). A refusal changes no counter; every decision is
audited. Reviewer `application_cac` quotas are unchanged.
Migration `0085_public_enrollment_windows_and_nin_lookup_quota.sql` does the
same for the accountless QoreID NIN lookup of public patient enrollment
(`platform.consume_public_patient_nin_quota`; "Public enrollment windows and
NIN lookup quota (0085)" below).
Migration `0050_patient_nin_evidence_binding.sql` removes the unbound
five-argument patient evidence command. A verified result now requires the
submitted NIN's keyed lookup HMAC to match an existing verified, unrevoked NIN
identifier on the exact session-bound patient. The HMAC is not persisted in
QoreID evidence or audit.
Migration `0051_public_patient_enrollment.sql` creates a separate public NIN
enrollment path. It keeps provider identity evidence encrypted in a pending,
unique-NIN record; a single selected contact OTP must be consumed before a
password-backed account, canonical patient, NIN binding, and HIDCode can be
created atomically. Its rate counters and OTPs are scoped to the enrollment.
Wrong contact codes also count against one failure budget per recipient,
across its challenges and enrollments, in `auth.otp_rate_limits` (scope
`recipient`, a keyed HMAC of the recipient HMAC; no schema change;
D-Eminence/hid-system#61, release checklist §2). Unlike the
enrollment counters, which `identity.prune_expired_public_patient_enrollments`
deletes once their window started more than 48 hours ago, these rows are never
deleted: a contact that ever got a wrong enrollment code keeps one, even if it
never enrolls. Follow-up for the next migration that changes
`auth.otp_rate_limits`: prune stale `recipient` rows (window started more than
48 hours ago, `blocked_until` passed) through a `SECURITY DEFINER` function,
with no runtime `DELETE` grant; that also covers OTP recovery's `recipient`
buckets.
The private synthetic rehearsal runs
`services/identity-api/scripts/verify-patient-enrollment-runtime.mjs`, which
exercises this path over HTTP under the exact Identity runtime role on a
disposable copy of the rehearsal database: start, contact OTP and activation,
then sign-in for both new patients (by email and by HIDCode, one phone-only),
and refresh, recovery and sign-out for the first. QoreID (behind
the real adapter), Siteverify and OTP delivery are local stubs; see the
[QoreID verification contract](QOREID_VERIFICATION_CONTRACT.md). This is not
staging acceptance.
Migration `0052_authoritative_cac_identity.sql` makes the registration
identifier the public organization lookup key and introduced a complete-QoreID-
profile guard for review and legal-entity binding. Migration `0056` revises
that guard so a verified sparse lookup can be followed by applicant completion
of provider-omitted fields. Neither migration adds provider secrets.
Migration `0053_remove_unwired_piersflow_catalog.sql` removes the disabled,
non-operational PiersFlow placeholder from the provider catalog. It aborts if
provider events or capability rows exist, preserving unexpected history for
review rather than discarding it.
Migration `0054_complete_existing_cac_evidence_binding.sql` requires the
existing-organization CAC evidence route to match all required persisted
legal-entity fields against its governed application and unique CAC binding. Historical
name-only bindings cannot produce new verified evidence until reconciled.
Migration `0055_verified_incomplete_cac_result.sql` records a QoreID-verified
CAC lookup with a numeric provider reference even when legal-entity fields are
missing. It leaves the application pending and those fields null under the
former `verified_incomplete` representation.
Migration `0056_cac_applicant_profile_completion.sql` separates successful CAC
provider verification from organization profile completeness. Exact verified
QoreID status fields and a numeric provider `id` confirm the submitted
`RC`/`BN`/`IT` identifier; a returned `cac.rcNumber` must match, but an omitted
number does not prevent verification or canonical registration binding. The
application stores populated provider fields separately from the merged review
profile and records `qoreid` or `user_provided` sources for required name, entity
type, registration date, address, and active registry status. The applicant may
complete provider-omitted fields only after bounded email OTP; provider values
cannot be overwritten. A populated non-active QoreID registry status remains
provider-sourced but blocks review. The migration adds restricted completion
challenges and session hashes, expected-version profile updates, sourced CAC
binding columns, and approval constraints. A verified lookup with missing
fields or a non-active provider status remains `profile_state=incomplete` until
its sourced profile is complete and active, then becomes `ready_for_review`;
platform RBAC, audit, unique binding, and approval remain
required. Historical `verified_incomplete` records become verified lookups with
incomplete profiles; their omitted/partial provider fields were not retained by
`0055` and cannot be reconstructed.
Migration `0013_durable_ocr_persistence.sql` adds the isolated `ocr` schema,
facility-scoped idempotent jobs, immutable extraction/validation/lifecycle
evidence, bounded retry state, atomic `SKIP LOCKED` worker claims, constrained
worker result/failure commands, and a minimum-necessary transactional outbox.
Jobs bind to the exact clean EHR document object version and checksum; optional
`patient_id` values can only match the canonical patient already associated
with the source document.
Migrations `0014` and `0015` add token-bound worker leases and an additive
PostgreSQL name-resolution correction. Migration `0016` adds reviewer
disposition and canonical candidate metadata, append-only patient confirmation,
durable version-bound publication commands, and EHR-owned immutable import
provenance. OCR retains no clinical or Identity mutation rights.
These files are additive migration assets; their presence does not mean they
have run against a live source or production RDS instance.

### Phase 0 database-role evidence and ownership boundary

Host-terminal evidence for the current development database reports zero
pending migrations through `0025`. Migration `0025` was applied
against the actual local PostgreSQL 16.14 `hid` database, the corrected
`hid_*` roles were provisioned and verified, and both the runtime-role catalog
assertions and full rollback-only schema/RLS integration suite passed. This is
local acceptance evidence only; production migration remains a separate
governed action and is not inferred from API readiness.

Separate transactional-delivery acceptance applied the complete `0001`-`0026`
chain to a clean isolated PostgreSQL 16 database, provisioned and asserted the
current roles, and completed the full rollback-only schema/RLS suite. This does
not claim that `0026` has been applied to production or another existing host.

The reviewed role model is:

| Role | Boundary | Direct Identity table writes | Notes |
|---|---|---:|---|
| `hid_identity_runtime` | Identity and authentication persistence | Required Identity-owned writes only | Future Identity service login also inherits `hid_audit_writer`. |
| `hid_ehr_runtime` | EHR clinical persistence | None | It may execute only the constrained Identity consent decision needed by the current transaction boundary. |
| `hid_identity_api_runtime` | Extracted Identity API aggregate | Required Identity-owned writes only | Composes Identity/authentication persistence plus append-only audit. |
| `hid_ehr_api_runtime` | Extracted EHR API aggregate | None | Composes EHR persistence plus append-only audit; no OCR or Identity mutation. |
| `hid_ocr_api_runtime` | Extracted OCR API aggregate | None | Composes OCR persistence plus append-only audit; no EHR, Identity, Lab, Pharmacy, or Outreach mutation. |
| `hid_api_runtime` | Retired modular-monolith compatibility role | None | Privilege-free and no longer inherited by active service logins. |
| `hid_audit_writer` | Semantic audit append | `INSERT` on `audit.events` only | No audit `SELECT`, `UPDATE`, or `DELETE`. |
| `hid_document_scanner` | Scanner callback command | None | Executes only the security-definer scan append function. |
| `hid_ocr_runtime` | OCR persistence | None | OCR-owned jobs, evidence, publications, and outbox only; inherited by the OCR API aggregate. |
| `hid_ocr_worker` | OCR asynchronous commands | None | No direct table access; lease/token-bound claim, renewal, extraction-result, and safe-failure functions, plus the aggregate-only queue metrics function (0075). |
| `hid_lab_runtime` | Lab-owned persistence | None | No Identity, EHR, OCR, or Pharmacy mutation privilege. |
| `hid_lab_api_runtime` | Extracted Lab API aggregate | None | Composes Lab persistence and append-only audit only. |
| `hid_pharmacy_runtime` | Pharmacy work, dispense, reversal, import, and outbox persistence | None | No Identity, EHR, Lab, or OCR mutation privilege. |
| `hid_pharmacy_api_runtime` | Extracted Pharmacy API aggregate | None | Composes Pharmacy persistence and append-only audit only. |
| `hid_outreach_runtime` | Temporary registration, mapping, immutable history, idempotency, and outbox | None | No Identity, EHR, Lab, Pharmacy, or OCR mutation privilege. |
| `hid_outreach_api_runtime` | Extracted Outreach API aggregate | None | Composes Outreach persistence and append-only audit only. |
| `hid_event_dispatcher` | Event transport command surface | None | No direct table access; executes only lease-bound claim/result/status functions. |
| `hid_event_delivery_commands` | Technical security-definer owner | None | Never inherited; reads five domain outboxes through exact RLS policies and mutates only `integration` delivery/inbox state. |
| `hid_ocr_queue_metrics` | Technical security-definer owner | None | Never inherited; owns `ocr.worker_queue_metrics()` and reads only `ocr.jobs.status` and `queued_at` through one exact RLS policy (0075). |
| `hid_platform_control_reader` | Technical security-definer owner | None | Never inherited; owns `platform.control_enabled(text)` and reads only `platform.control_settings.control_key` and `enabled` through one exact RLS policy (launch; role bootstrap only). |
| `hid_migration_admin` | Migration and provisioning administration | Environment-specific | Never inherited by an application runtime login. |
| `hid_schema_test_runtime` | Rollback-only schema/RLS acceptance | Test-only explicit grants | NOLOGIN and never used by application processes. |

Identity, EHR, and OCR now use separate service processes and pools. The retired
aggregate has no domain memberships. Domain and API aggregate roles preserve
the ownership rule: only Identity can mutate canonical patient/identifier
tables; EHR, Lab, Pharmacy, Outreach, and OCR cannot. Environment-specific
LOGIN creation remains deployment-owned and is not committed to source.
The EHR and OCR API login roles must inherit only `hid_ehr_api_runtime` and
`hid_ocr_api_runtime`, respectively. The OCR worker login remains separate and
inherits only `hid_ocr_worker`. Runtime provisioning is maintained outside the
applied migration ledger in idempotent `database/runtime-grants.sql`; migrations
`0001` through `0025` remain immutable, and event delivery is the additive
`0026` migration rather than a rewrite of that history.

Direct Identity persistence access was classified as follows:

| Consumer | Classification | Boundary decision |
|---|---|---|
| `services/identity-api/src/identity/postgres-identity.provider.ts` | IDENTITY OWNED | Reads canonical patients and consent evidence only inside Identity. |
| `services/identity-api/src/identity/nin-registration.service.ts` | IDENTITY OWNED | Governed NIN cases, issuance, identifier binding, audit, and transactional outbox. |
| `services/identity-api/src/auth/current-staff-context.service.ts` | AUTHENTICATION OWNED | Workforce/facility context is returned through the workload-authenticated typed API. |
| `services/ehr-api/src/ehr/shared/clinical.repository.ts` | IDENTITY CLIENT | Active code uses Identity HTTP; only RLS retains the constrained DB function as defense-in-depth. |
| `services/ehr-api/scripts/promote-legacy-identity.mjs` and `services/ehr-api/scripts/reconcile-legacy-identity.mjs` | MIGRATION/ADMIN-ONLY | They use the migration administrator boundary and are not runtime consumers. |
| `services/ehr-api/database/tests/schema.integration.sql` | TEST-ONLY | Direct Identity inserts deliberately exercise constraints and RLS through `hid_schema_test_runtime`; the test no longer creates roles inside its data transaction. |

The former grants that assigned Identity table mutation privileges to
`hid_ehr_runtime` are revoked by `database/runtime-grants.sql`. The SQL is
idempotent and is verified by
`database/tests/runtime-roles.integration.sql` before any host provisioning is
accepted.

Migration `0025_identity_transactional_outbox.sql` adds the forced-RLS Identity
outbox without altering patient UUIDs, HIDs, identifiers, or registration state
machines. Governed approval/link/resolution persists minimum
`PatientRegistered`, `PatientIdentifierAdded`, and `PatientIdentityResolved`
events atomically with domain state and semantic audit. Outbox payload checks
forbid raw NIN/identifier/HID fields.

## 1. Requested names versus governed target names

The requested names below are logical concepts. They are not authorization to
create generic public tables with those names.

| Requested logical name | Governed target | Source of truth and boundary |
|---|---|---|
| `patients` | `identity.patient`, `identity.patient_lifecycle_version`, and private profile/identifier aggregates in `identity_private` | HID Identity is the only patient identity issuer. `identity.patient.hid` is the sole patient key. |
| `facilities` | Stable `org.tenant`, `org.organization`, and `org.facility` headers with immutable versions, governed facility identifiers, and versioned `org.location` | Organization owns custody hierarchy and facility scope without in-place history loss. |
| `staff` | `iam.principal`, `org.practitioner`, optional versioned `org.principal_practitioner_link`, workforce membership, roles, privileges, and credentials | Authentication account, practitioner identity, employment, and authorization are separate facts. |
| `encounters` | `ehr.clinical_resource`, its assignment/version registry, and typed `ehr.encounter` plus `ehr.encounter_version` | EHR owns encounter truth; encounter history is immutable. |
| `labs` | EHR-owned `ehr.service_request`, then `lab.order`, accession, specimen, custody, execution, QC, result, and report aggregates | EHR owns order intent; Laboratory owns execution and verified results. There is no generic `labs` record. |
| `prescriptions` | Versioned EHR `medication_request` for prescribing intent, plus Pharmacy-owned exact-version acceptance and explicit dispense evidence | `ehr.prescriptions` remains prescribing truth. `pharmacy.work_items`, `pharmacy.dispensings`, and `pharmacy.dispensing_reversals` own post-acceptance operations. Inventory, controlled-drug, recall, refills, partial fills, and administration remain separate future work. |
| `audit_logs` | `audit.event_id_registry`, partitioned `audit.audit_event`, `audit.event_type_registry`, archive `audit.export_manifest`, and separate versioned evidence-export jobs | Audit is append-only semantic evidence, not a mutable application log table. |

These names must also remain distinct in APIs and code. An ORM model named
`Patient` must map to the Identity aggregate, not create an application-local
patient row. A Lab or EHR module may cache presentation data only through an
explicitly approved, non-authoritative projection keyed by HID.

## 2. Database topology and ownership

The initial platform uses one encrypted, private RDS PostgreSQL deployment per
environment. A shared database is an intentional modular-monolith tradeoff:

- database foreign keys can enforce one HID across clinical contexts;
- domain, audit, and outbox writes can commit atomically;
- each schema still has a no-login owner, controlled migration role, and
  least-privilege runtime role; and
- one context cannot write another context's schema.

The principal schemas are:

| Schema | Owns |
|---|---|
| `org` | Tenants, organizations, facilities, locations, practitioners, workforce membership, clinical privileges, and credentials |
| `identity` | HID registry, lifecycle, registration/matching, merge/split cases, account-to-patient links, and identifier governance |
| `identity_private` | Encrypted and versioned demographics, names, contacts, addresses, and identifier bindings/lookups |
| `iam` | Application principals, external issuer/subject mappings, and versioned role/permission vocabulary |
| `authz` | Scoped assignments, care relationships, grants, break-glass, policies, workflow-selection handles, and per-request patient-access contexts |
| `consent` | Versioned consent directives, provisions, revocations, and evaluation evidence |
| `ehr` | Typed clinical resource headers, immutable versions, provenance, and relationships |
| `lab` | Orders, accessions, specimens, custody, methods, instruments, QC, results, and reports |
| `document` | Validated S3 object metadata, patient attribution, retention, and legal hold |
| `ocr` | Quarantine, jobs, model releases, extraction versions, review, and publication evidence |
| `outreach` | Campaigns, templates, enrollments, communication requests, attempts, and callbacks |
| `terminology` | Versioned code systems, releases, concepts, value sets, and mappings |
| `integration` | Idempotency, outbox/inbox, partner checkpoints, and opaque FHIR mappings |
| `audit` | Semantic audit events, global event deduplication, and archive manifests |
| `migration` | Source checkpoints, crosswalks, batches, cutover markers, exceptions, and reconciliation evidence |

Binary content is not stored in PostgreSQL. S3 holds versioned objects;
PostgreSQL holds the immutable object locator, S3 version, SHA-256, detected
media type, size, trust class, classification, retention, legal hold, and
provenance. Expiring presigned URLs are never persisted.

### 2.1 Core relationships

```text
iam.external_identity --N:1--> iam.principal
iam.principal ---------1:N--> identity.principal_patient_link_version
                                      |
                                      v
                              identity.patient(hid)
                                      |
             +------------------------+-------------------------+
             |                        |                         |
             v                        v                         v
  ehr.clinical_resource       lab.order/specimen/result   document.asset
             |                        |                         |
             +------------ patient_hid ------------------------+
                                      |
                                      v
                           outreach.communication_request

org.tenant --> org.organization --> org.facility --> org.location
                                          |
org.practitioner --> org.workforce_membership
        ^
        |
iam.principal --> org.principal_practitioner_link

ehr.service_request --> lab.order --> lab.accession --> lab.specimen
                                               |
                                               v
                                      lab.test_execution
                                               |
                                               v
                              lab.result/report versions

ehr.medication_request --> future pharmacy.dispense
                                      |
                                      v
                         future immutable stock movements
```

Every patient-scoped arrow uses the same `identity.patient.hid` type. Resource
IDs remain separate because one patient has many encounters, orders, results,
documents, and communications. Audit events reference resource and evidence
versions; they do not own or duplicate clinical payloads.

## 3. Global relational invariants

### 3.1 One patient key

`identity.patient.hid` is the sole patient key. Under the implemented migration
mapping and still-required production identity approval:

- it is a UUID, opaque to business meaning, immutable, and never reused;
- every patient-scoped aggregate root carries `patient_hid` of the exact same
  type and references `identity.patient`;
- legacy MRNs, NINs, visible HID codes, partner IDs, emails, and phone numbers
  are identifiers or contacts, never alternate patient primary keys;
- encounter, accession, result, document, and message IDs remain their own
  resource IDs; and
- no patient or clinical foreign key uses `ON DELETE CASCADE`.

Existing retired hosted identity backend patient UUIDs are preserved as registry records. Reconciliation
determines whether each remains active or becomes a merged alias pointing to one
active survivor. Preservation does not declare every source row a distinct
person.

### 3.2 Time, quantities, codes, and JSON

- Instants use `timestamptz` and are recorded in UTC.
- Civil dates, including date of birth, use `date`; incomplete dates retain
  precision and source instead of inventing a day.
- Authoritative quantities use bounded `numeric`, never binary floating point.
- Clinical codes reference governed terminology releases and retain the display
  snapshot used at recording time.
- JSONB is limited to bounded extensions, immutable inbound envelopes, validated
  model output, and minimal event metadata.
- Searchable and authorization-relevant clinical facts use typed columns or
  typed children.

### 3.3 Versioned aggregates

Every mutable authoritative aggregate uses a stable header and immutable
versions:

1. The header has an immutable ID, `current_version_no`, and `row_version`.
2. Versions are unique by `(header_id, version_no)`.
3. A composite foreign key forces the current head to reference a version of the
   same aggregate.
4. A version records effective time, server-recorded time, author, source,
   reason, superseded version, and canonical content hash.
5. Runtime roles cannot update or delete versions.
6. A compare-and-swap transaction checks the caller's expected version, appends
   the version and children, advances the head, and writes provenance, audit,
   and outbox records atomically.
7. Every mutable-looking field is classified as immutable header identity,
   immutable version content, append-only evidence, or a rebuildable guarded
   projection. Authoritative names, hierarchy, custody, residency, policy,
   attribution, and status are not updated in place.

Corrections append corrected, amended, revoked, or entered-in-error states.
Physical deletion is not a correction. Materialized status fields are guarded
projections, not an alternate mutable source of truth.

### 3.4 Patient attribution

Each patient-scoped resource header has a current HID and immutable assignment
history. Ordinary clinical commands cannot reassign a record.

A wrong-patient, split, or unmerge correction must:

- reference an Identity correction case and affected-resource decision;
- record original and corrected HIDs, evidence, reason, reviewers, effective
  time, and any reversal;
- append the owning domain's assignment version;
- advance the current assignment with compare-and-swap; and
- commit audit and outbox evidence in the same transaction.

The original assignment remains in provenance. A correction-pending resource is
excluded from a combined patient timeline rather than guessed.

### 3.5 Retention and deletion

- Patient, identity, clinical, Lab, consent, audit, provenance, assignment, and
  document-evidence foreign keys use `ON DELETE RESTRICT`.
- Cascade is allowed only for non-authoritative ephemeral children whose parent
  is itself legally deletable.
- Erasure requests create a governed case and record-class decision.
- Legal hold overrides lifecycle deletion.
- An S3 deletion is driven by an approved durable database transition; the
  workflow must not leave database metadata and object state silently divergent.

## 4. Patient and HID Identity data

### 4.1 Registry and lifecycle

`identity.patient` is the stable registry row:

- `hid` is its primary key;
- the current lifecycle head points to an immutable
  `identity.patient_lifecycle_version`;
- active, inactive, merged, and entered-in-error transitions retain reason,
  evidence, case, reviewers, and effective/recorded time; and
- merge constraints reject self-reference, cycles, and chains that do not
  resolve to exactly one active HID.

New writes against a retired HID are rejected. Historical resources keep their
recorded HID. Each connected patient graph has a stable component ID and guarded
revision. Merge/split transitions lock all affected components deterministically,
re-read them, append graph/lifecycle evidence, and advance the revision
atomically. A deferred cycle check is the final invariant-not the sole
concurrency control. Serialization failures receive bounded, observable retry.
Authorized timeline reads record the exact component revision and origin
lifecycle versions, evaluating each origin HID separately.

### 4.2 Demographics and contacts

Sensitive attributes are owned by `identity_private`:

- `patient_demographic` is the single designated demographic header per HID;
- `patient_name`, `contact_point`, and `address` are separate stable headers;
- every header has immutable versions; and
- other contexts receive minimum-necessary data through Identity APIs, not
  cross-schema reads.

There is no second demographic head on `identity.patient`.

### 4.3 External identifier uniqueness

The identifier model separates:

- stable `identity.identifier_system` and `identity.identifier_issuer` headers
  with immutable effective-dated versions for namespace, normalization,
  exclusivity, and lifecycle policy;
- `identity_private.patient_identifier_binding`, a stable binding header;
- immutable binding lifecycle versions containing HID, encrypted original
  value, status, validity, and provenance; and
- immutable lookup rows containing keyed HMAC blind indexes.

All lifecycle versions behind one binding represent the same immutable
identifier value. Encryption-key rotation may append a new encrypted rendition
only after a guarded transition proves that every accepted normalized value is
unchanged. Correcting the value itself retires the old binding and creates a
linked replacement; a different value never appears behind the old binding ID.

For person-exclusive identifiers, each lookup row denormalizes system, issuer,
normalization version, lookup-key version, HMAC, and an immutable exclusivity
flag. PostgreSQL can therefore enforce a local partial unique index without
joining to mutable state.

Every exclusive binding must have the complete accepted normalization-version ×
lookup-key-version matrix. Issuance freezes during normalization or blind-index
rotation until existing bindings are backfilled and reconciled. Exclusive
reservations are never deleted or reused. Shared or reassignable identifier
systems use separately approved effective-dated policies.

Exact lookup joins the binding's current lifecycle version. An active binding
may return its currently adjudicated HID. A retired or value-replaced binding
returns only a non-disclosing reserved/retired adjudication outcome and never a
patient, while its lookup rows remain uniqueness tombstones. A governed
wrong-patient correction may move the same immutable value to the corrected HID
through a new attribution version without erasing the old association.

Phone numbers and email addresses are contacts. Even when verified, they do not
prove identity uniqueness and cannot trigger an automatic merge.

### 4.4 Registration, matching, merge, and split

There is no public insert into `identity.patient`.

- Registration creates an idempotent `identity.registration_case`.
- NIN-backed registration cases retain encrypted NIN material, a keyed lookup
  HMAC, provider/reference evidence, an immutable request digest, and a
  facility-scoped creator. Identifier bindings reference the exact case.
- Deterministic identifiers are searched before issuance.
- Fuzzy matching produces candidates only.
- Ambiguous cases require a steward decision.
- Only the guarded `approved-new-identity` transition may issue an HID.
- A verified NIN already bound to an active patient records a non-mutating
  `resolved_existing_identity` case; it does not create a second binding.
- Review commands require optimistic version checks and idempotency replay
  protection. Concurrent resolution attempts cannot create two active cases for
  one verified NIN lookup HMAC.
- Merge and split retain decisions, evidence, affected resources, and reversal
  relationships.

Authentication is separate: `(issuer, subject)` maps to `iam.principal`, and a
versioned `identity.principal_patient_link` represents self, guardian, caregiver,
or proxy relationships.

## 5. Facilities, tenancy, and custody

The custody hierarchy is:

```text
org.tenant -> org.organization -> org.facility -> org.location
```

Tenant, organization, facility, and location records use stable headers plus
immutable versions for legal/display names, parent hierarchy, controller and
custodian policy, lifecycle status, residency, timezone, and address. A
parent-change command serializes within the tenant, checks the resulting graph,
advances the tenant's hierarchy revision, and appends audit/outbox evidence.
Concurrent inverse parent changes cannot both commit.

Required relational constraints include:

- `UNIQUE(tenant_id, organization_id)`;
- `UNIQUE(tenant_id, facility_id)`;
- `UNIQUE(tenant_id, organization_id, facility_id)`;
- a composite facility-to-organization foreign key; and
- composite tenant/facility foreign keys from custodial domain roots.

Facility codes are governed identifier bindings rather than mutable columns.
Versioned facility identifier-system and issuer definitions establish the
normalization and tenant/organization scope. A value is unique within its
declared tenant and issuer and remains reserved after retirement;
correction retires the binding and creates a linked replacement.

Every custodial aggregate root has `tenant_id`. Ordinary clinical roots also
have `facility_id`; only an allowlisted network-level type may omit it.
Contained children derive scope through their parent or repeat it only with a
matching composite foreign key.

Actor membership scope and resource-custodian scope are different facts.
Changing a resource's tenant is never a sharing mechanism. A mismatch requires
an explicit active, versioned `authz.cross_tenant_access_grant`.

## 6. Staff and workforce

The logical `staff` concept is decomposed to prevent account claims from becoming
clinical authority:

- `iam.principal` is the platform actor, with immutable lifecycle versions.
- `iam.external_identity` maps a unique external `(issuer, subject)` to the
  principal and retains append-only verification/revocation events.
- `org.practitioner` is a clinical person record and can exist without a login.
- A versioned, optional `org.principal_practitioner_link` connects the two.
- A guarded current-only active-link reservation references the exact link
  version and enforces non-overlapping active principal/practitioner links;
  immutable historical versions are not subjected to a false “current” partial
  uniqueness predicate.
- `org.workforce_membership` records employment or engagement in a tenant,
  organization, and facility.
- Versioned role assignments and clinical privileges define what the
  practitioner may do.
- Versioned credentials and append-only verification/restriction events support
  licensure and credential checks.

`authz.scope_assignment` binds the principal, practitioner account link,
membership, actor tenant/facility, and role. Composite constraints prove these
facts belong to the same practitioner, while request-time authorization rechecks
that their current versions remain active.

Passwords, MFA seeds, provider keys, and raw identity tokens do not belong in
these tables.

## 7. Encounters and typed EHR records

### 7.1 Implemented EHR records

The EHR does not use a generic JSON medical-record table. Migrations 0004
onward create these EHR tables. Each has forced row-level security on the
patient's consent at the facility (`ehr.context_allows`, 0005); every insert
and update of a clinical row records a version in `ehr.record_versions`
(`ehr.capture_record_version`, 0004); and no clinical row is deleted.

| Table | Holds |
|---|---|
| `ehr.encounters` | Encounter type, status, service period and chief complaint. A cancelled or entered-in-error encounter takes no further change (0090). |
| `ehr.clinical_notes` | Note header: type, title, status, signature and current revision. |
| `ehr.clinical_note_revisions` | Each note revision, append-only. |
| `ehr.vitals` | Up to eight measurements as recorded, the current correction number, and `status` (`final` or `entered_in_error`, 0090). |
| `ehr.vital_corrections` | Vital corrections, append-only (D8). |
| `ehr.diagnoses` | Coded condition with clinical and verification status. |
| `ehr.prescriptions` | Medication orders; records only at launch (D17). A completed, cancelled or entered-in-error one is final (0090). |
| `ehr.lab_requests` | Test orders; records only at launch (D17). Final as prescriptions are (0090). |
| `ehr.documents` | Uploaded document metadata and object binding; `ehr.documents_effective` adds the latest scan result (0009). |
| `ehr.document_scan_events` | Scanner results, append-only. |
| `ehr.ocr_import_provenance` | Provenance of notes imported from OCR. |
| `ehr.idempotency_keys` | Idempotency of clinical creates. |
| `ehr.record_versions` | The version history of every clinical row. |

**Allergies are not recorded.** No migration creates an allergy or
intolerance table, no EHR route records one, and no prescribing path checks
one. At launch a clinician records an allergy as a diagnosis (for example
ICD-10 `Z88.0` to `Z88.9`, allergy status to drugs) or in a clinical note,
neither of which a prescription is checked against
(`PHASE_3_LAUNCH_DECISIONS.md`, "Allergies at launch").

### 7.2 Target model (not implemented)

None of the following exists in the schema; it is the governed target for a
later, approved change (§15).

`ehr.clinical_resource` provides common resource identity, immutable type,
current patient assignment, custody scope, current version, and FHIR mapping.
`ehr.resource_version_registry` provides common recorded/effective time,
provenance, security labels, status, attestation, and content hash.

Each clinical type has its own header and immutable version table, including:

- `encounter`;
- `condition`;
- `allergy_intolerance`;
- `observation`;
- `procedure`;
- `service_request`;
- `medication_request`;
- `care_plan`;
- `clinical_note`;
- `document_reference`; and
- `composition`.

A typed version has the same `(resource_id, version_no)` as its registry row. A
deferred constraint requires exactly one typed detail matching the immutable
resource type and prevents supersession across resources.

`ehr.encounter` and its versions own encounter class/type, status, service
period, participants, locations, and reason/diagnosis references. Related
clinical resources reference the encounter version appropriate to their
provenance; they do not copy patient identity.

## 8. Laboratory

Laboratory workflow begins from EHR-owned clinical intent:

The executable first Lab slice is migration `0017_lab_imported_evidence.sql`.
It adds `lab.imported_evidence`, immutable `lab.imported_observations`, and
`lab.outbox_events`. These records are explicitly `IMPORTED_EXTERNAL` and do
not claim native HID accession, specimen custody, instrument execution, QC, or
Lab verification. OCR provenance is stored as stable document, job,
extraction, validation/version, and publication references rather than copied
source payloads. Forced RLS combines facility context with the current
canonical-patient consent decision.

```text
ehr.service_request/version
  -> lab.order/version
  -> lab.order_item
  -> lab.accession
  -> lab.specimen and custody events
  -> execution, QC, result/version
  -> lab.diagnostic_report/version
```

The Lab schema owns:

- facility-scoped accession numbers;
- governed facility/issuer-scoped specimen and container identifiers;
- collection, label, receive, aliquot-lineage, transfer, reject, and disposal
  evidence;
- immutable analyzer messages and parser provenance;
- versioned test catalogs, methods, instruments, and analyzer mappings;
- stable test-execution headers and immutable execution versions tied to the
  exact order item, specimen, method, operator, instrument, and run;
- reagent lots, expiry, and recall state;
- calibration and maintenance events;
- QC plans, rule sets, runs, measurements, and evaluations;
- nonconformance investigation and disposition;
- immutable result history and attestation; and
- stable critical-result notifications with append-only attempt, reach,
  acknowledgement, read-back, escalation, and closure events.

A finalized result must reference the exact test-execution version and immutable
QC, reagent-use, method, instrument-run, calibration, maintenance, and operator
evidence, or an authorized nonconformance disposition. Aliquot commands reject
lineage cycles and impossible quantities under deterministic locking.
The release transaction evaluates the approved critical rule; a critical result
cannot commit unless the unique stable notification thread, initial event,
semantic audit, and outbox record commit with it.
Preliminary, final, corrected, and amended values remain in history. Lab-owned
measurements are not copied into EHR observations; EHR holds a
relationship/reference and the interoperability facade maps the Lab resource.

Specimen and container labels use versioned laboratory identifier-system/issuer
definitions. One immutable normalized value belongs to each binding and is
permanently unique within its facility/issuer scope; correction retires the
binding and creates a linked replacement.

## 9. Prescriptions and Pharmacy

The logical `prescriptions` requirement is implemented by `ehr.prescriptions`
(0004; §7.1): medication-order intent, dose and instructions, frequency, the
prescribing actor and membership, status, and a version for every change. The
versioned medication-request aggregate of the target model (§1, §7.2) is not
implemented.

It does not prove that medication was dispensed.

Migration `0023_pharmacy_domain_foundation.sql` deploys the deliberately narrow
`pharmacy` schema. `pharmacy.work_items` stores one immutable same-facility
acceptance and minimum clinically required snapshot of the exact active EHR
prescription ID/version. It never becomes the prescribing source of truth and
its `accepted` status cannot imply dispensing.

`pharmacy.dispensings` stores one explicit full dispensing per accepted work
item in this slice, with the exact medication reference, quantity/unit, actor,
reason, timestamp, idempotency digest and immutable version. A separate
`pharmacy.dispensing_reversals` row preserves the original dispense and records
the exact-version correction relationship. Dispensed does not mean
administered. Partial fills, refill authorization, substitutions, POS/payment,
claims, inventory lots/stock movement, recall, controlled drugs and medication
administration are absent rather than guessed.

`pharmacy.imported_medication_evidence` stores exact document/OCR extraction,
validation/version and publication provenance. Its type is always
`IMPORTED_MEDICATION_EVIDENCE` and activity is always `unknown`; it cannot be a
work item or dispensing. `pharmacy.outbox_events` records only identifiers and
state transitions for work creation, dispensing, reversal and medication
evidence import.

All Pharmacy tables use canonical Identity patient UUIDs, composite actor/
facility membership constraints and forced RLS via `pharmacy.context_allows`.
Application writes independently call Identity and reject break-glass. Domain
evidence is append-only. `hid_pharmacy_runtime` can select/insert Pharmacy
records and execute only the required context/authorization functions;
`hid_pharmacy_api_runtime` adds append-only audit. EHR/OCR cannot mutate any
Pharmacy table, and Pharmacy cannot create Identity patients or mutate EHR,
Lab, or OCR persistence.

Since 0080 the database binds Pharmacy work to the EHR prescription: the
work-item guard accepts only the exact active prescription version, and the
dispensing guard dispenses only while that version is still active. Both read
the prescription as their owner with a share lock ("Pharmacy source
prescription guards (0080)").

## 10. Audit data

The logical `audit_logs` requirement maps to a controlled audit subsystem.

### 10.1 Global identity and partitioning

`audit.event_id_registry` is unpartitioned and owns the globally unique event
ID, server-derived recorded month and sequence, canonical event hash, and
creation time.

`audit.audit_event` is time-partitioned. Its relational key includes
`(recorded_month, event_id)`, while its event ID references the global registry.
The guarded append operation inserts both rows atomically and verifies month,
sequence, and hash:

- same ID and same hash returns the existing event;
- same ID and different hash is rejected; and
- retries across partition boundaries cannot duplicate semantic evidence.

### 10.2 Event content

Audit records actor and delegation, session assurance, service/version, actor
membership scope, resource custody scope, action, purpose, resource and version,
HID when necessary, workflow/access-context IDs, patient-graph component
revision and origin lifecycle versions, grant/policy/consent versions, outcome,
request/correlation IDs, and changed field names.

Audit metadata does not contain clinical payloads, tokens, cookies, complete
search terms, or request/response bodies.

### 10.3 Append and archive

- Runtime roles have no direct audit-table privilege.
- They may call only a narrowly granted `audit.append_event`.
- Server-derived context cannot be replaced by caller-supplied actor or time.
- Sealed partitions reject writes; late events enter the current partition with
  original occurrence and late-source linkage.
- Continuous immutable archive batches and signed partition manifests are
  reconciled to cross-account S3 Object Lock storage.

Domain writes, semantic audit, and outbox events commit together. PHI reads use
the same database transaction/snapshot for authorization, selection, and audit
append; the transaction commits before PHI is serialized.

Phase 0 has one documented exception while the existing audit service still
uses parameterized `INSERT`: the separate `hid_audit_writer` receives only
`INSERT` on `audit.events` plus its sequence, with no read, update, or delete.
Domain roles receive that capability only through the transitional aggregate.
Replacing direct append with the target `audit.append_event` command requires
an additive migration and service change; it is not hidden inside role
provisioning or an edit to applied migrations.

### 10.4 Requested evidence exports

`audit.export_manifest` proves continuous archive and sealed-partition
integrity; it is not an analyst-facing job table.

An evidence request uses a separate stable `audit.evidence_export_job` with
immutable workflow versions plus append-only approval and delivery events. It
records requester, actor scope, purpose, exact query-snapshot reference/hash,
source checkpoint, approval state, output object/version, checksum, expiry, and
download evidence. The canonical bounded query and field/data-class allowlist
live in an immutable, envelope-encrypted snapshot accessible only to the narrow
worker after approval of that exact job version/hash. Query PHI is not
duplicated into job metadata, responses, logs, or ordinary audit metadata.

Outputs are separately classified, encrypted, short-retention objects.
Creation and every one-object delivery require current authorization; a
policy-required approver is independent of the requester and approves the exact
snapshot. No database row stores a long-lived public URL.

## 11. Authorization context and RLS

RLS is defense in depth, not the sole authorization engine.

An external `patientContextId` names only a short-lived,
`authz.patient_workflow_context`. It is an opaque patient-selection handle
bound to the principal, session, purpose, selected patient, actor scope, and
custodian scope. It is not an authorization decision and cannot satisfy RLS.

Before every patient-scoped operation, the server revalidates that optional
workflow handle and current membership, grants, consent/restrictions, policy,
organization hierarchy, and patient graph. It then creates a new immutable
`authz.patient_access_context`, bound to:

- a unique request ID, verified principal, and session;
- actor membership tenant/facility;
- requested purpose;
- resource-custodian tenant/facility;
- policy and evidence versions;
- organization hierarchy and patient graph component revisions;
- exact lifecycle version for every origin HID;
- exact cross-tenant or break-glass grants; and
- one allow/deny decision per origin HID.

Expiry makes the context unusable for later access; its immutable decision,
origin-HID, and grant evidence is retained or archived under the approved
authorization/audit retention policy.

Merge aliases do not automatically union consent, delegation, grants, or
restrictions. Safety-held, stale, correction-pending, or unevaluated origin HIDs
deny.

For each request transaction:

- the application installs only the fresh, server-private access-context ID
  with `SET LOCAL`;
- the protected row supplies resource-custodian scope;
- patient/custodial tables use `ENABLE` and `FORCE ROW LEVEL SECURITY`;
- runtime roles are not owners and do not have `BYPASSRLS`;
- missing, expired, or mismatched context denies; and
- connection-pool tests prove context cannot survive transaction completion.

RLS policies must be negatively tested for cross-tenant IDs, inactive
memberships, stale grants, missing purpose, stale merge graphs, unapproved
aliases, portal-self access, and break-glass limits.

Data-access and cross-tenant grants are stable headers with immutable
effective-dated versions. Create, suspend, revoke, and replace are guarded
transitions requiring expected version, reason/evidence, applicable approval,
and atomic audit/outbox evidence. Revocation cannot rewrite an issued version,
and every request evaluates the current head plus its effective period.

## 12. Integration and transaction rules

`integration.idempotency_record` uses a non-null
`(scope_kind, scope_id, requester_kind, requester_id, operation, key)` scope
with a canonical request hash and terminal result. Tenant operations use their
tenant UUID and global Identity uses a governed platform namespace.
Authenticated requester IDs are verified principal/client IDs; pre-auth uses a
non-null high-entropy server-issued flow ID bound to browser/session, CSRF,
channel, and expiry. Caller PII/IP and nullable uniqueness fields are
prohibited. Reusing a key with a different request is a conflict.

`integration.outbox_event` is written in the same transaction as the owning
domain version and audit evidence. Consumers use
`integration.inbox_message` uniqueness on `(consumer, event_id)`. Delivery is at
least once; processing is idempotent.

The executable schema retains five domain-owned immutable outbox tables and
normalizes them through `integration.outbox_envelopes`. Mutable claims and
attempts are separate in `integration.outbox_delivery_state` and
`integration.outbox_delivery_attempts`; legacy domain delivery columns are not
the dispatcher authority. The generic inbox uses
`integration.inbox_messages` primary key `(consumer_name,event_id)` plus an
administrator-owned consumer/database-role binding. Exact command and failure
semantics are in `EVENT_DELIVERY_ARCHITECTURE.md`.

Events carry identifiers, classification, and minimal payloads, not complete
clinical records. Consumers retrieve necessary detail through authorized APIs.

FHIR patient logical IDs use stable, audience-scoped
`integration.fhir_patient_mapping` headers with immutable lifecycle versions.
Logical IDs are unique within the audience; a guarded current-only primary
reservation enforces at most one current primary mapping for a canonical HID.
Merges retain old IDs with governed
`Patient.link` replacement semantics. Split/unmerge uses reviewed versions and
partner events; an ID is never reassigned to an unrelated person. These IDs
never become domain patient keys.

Mapping create/read/transition revalidates its stored patient graph
component/revision. A graph change either updates affected mapping
versions/reservations in the guarded transaction or atomically places a
reconciliation hold and invalidates the primary reservation. The FHIR facade
fails closed until a locked, reviewed reconciliation clears any mismatch.

## 13. Indexing and physical-design rules

Exact indexes and partition sizes require measured, privacy-safe production
volumes. Logical access paths that the reviewed DDL must support include:

| Access path or invariant | Required index contract |
|---|---|
| Canonical patient lookup | Primary key on `identity.patient(hid)`; no second patient-key index |
| Canonical alias traversal | Partial reverse edge on `(canonical_hid, hid)` for merged patient heads, plus component/revision lookup; this is not another patient key |
| External login subject | Unique `(issuer, subject)` on `iam.external_identity` |
| Exclusive identifier lookup | Local partial unique index on system, issuer, normalization version, lookup-key version, and HMAC for immutable exclusive rows |
| Primary demographics | Unique patient HID on the designated demographic header |
| Tenant/facility integrity | Unique composite parent keys and matching child FK indexes for tenant, organization, and facility |
| Active workforce evaluation | Membership/account-link/assignment indexes beginning with practitioner or principal plus tenant/facility and effective-state fields |
| Patient clinical timeline | Tenant, facility, patient HID, clinical effective time descending, resource type, and stable resource ID |
| Encounter work | Tenant, facility, patient HID, workflow status, service start descending |
| Laboratory accession | Unique issuer/facility-scoped accession identifier; no accidental global uniqueness |
| Laboratory worklist | Tenant, facility, workflow status, priority, due/received time, and stable order/accession ID |
| Specimen identity | Governed facility/issuer-scoped label or barcode uniqueness plus custody-time access |
| Specimen lineage | Parent and child specimen/container indexes supporting cycle checks and bounded ancestry traversal |
| Lab execution/release | Order item/specimen/status worklist plus exact execution-version, QC, reagent, instrument-run, and result FK indexes |
| Medication-request work | Tenant, facility, patient HID, request status, authored time, and request ID |
| Outbox/inbox/jobs | Pending state plus next-attempt/created time; unique consumer/event inbox key |
| Audit investigation | Per-partition patient, actor, actor-scope, custodian-scope, cross-tenant grant, request, and recorded-time indexes; BRIN for broad time scans |
| Evidence export | Requester/status/created-time work queue and unique output object/version/checksum reference |

The exact column order, included columns, predicates, and partition strategy are
chosen from production-sized query plans. Indexes used to enforce foreign keys,
current heads, idempotency, and exclusivity are correctness controls and cannot
be removed solely for write throughput.

Additional rules:

- time/status indexes for outbox, inbox, jobs, attempts, grants, consent, and
  active assignments;
- tenant/facility/patient/time indexes for authorized timelines;
- active partial indexes only where lifecycle semantics are immutable and
  tested;
- BRIN for large append-only time scans when selectivity supports it;
- GIN only for approved bounded JSON/search requirements; and
- no unrestricted fuzzy PII index outside the Identity private boundary.

Partition keys may not weaken primary, unique, foreign-key, patient-attribution,
or audit-deduplication integrity. Every index change is tested for write
amplification, vacuum behavior, lock duration, query-plan regression, and
tenant/patient selectivity before production promotion.

## 14. Prohibited database designs

Do not:

- create patient rows in EHR, Lab, OCR, Outreach, or Pharmacy;
- use email, phone, MRN, visible HID code, Auth subject, or FHIR logical ID as a
  patient foreign key;
- expose domain tables directly to browsers;
- grant runtime schema ownership or `BYPASSRLS`;
- update or delete immutable clinical, identity, consent, assignment, audit, or
  provenance versions;
- use tenant relabelling as cross-tenant sharing;
- duplicate Lab results into mutable EHR observations;
- publish OCR output directly as clinical truth;
- store binary documents or persisted presigned URLs in PostgreSQL;
- treat accepted Pharmacy work, imported medication evidence, or a presentation flag as dispensing; or
- treat infrastructure/application debug logs as the semantic audit record.

## 15. Approval gates before DDL

Common and Identity migrations remain blocked until decision owners approve:

1. canonical UUID HID versus visible code semantics;
2. global registry versus federated identity jurisdiction;
3. tenant, facility, custodian, and cross-tenant sharing semantics;
4. workforce credential and privilege authorities;
5. consent, legal basis, and break-glass governance needed by Identity;
6. record-class retention, legal hold, identity correction, and erasure;
7. Identity/audit RTO/RPO, volume, partition sizing, PostgreSQL version, and
   extensions;
8. authentication/session provider; and
9. verified live Identity/Auth source inventory, approved mapping/crosswalk
   specification, and signed reconciliation acceptance criteria. Executed
   reconciliation evidence gates data promotion/cutover, not DDL authoring.

Later contexts do not block approved Identity foundation work. Before its own
DDL, each context must approve applicable value sets, state machines, custody,
authorization, retention, service objectives, source mappings, and safety
controls-especially EHR clinical states; Lab execution/QC/release; OCR
provider/review; Outreach consent/provider; and Pharmacy
dispensing/inventory/controlled-drug governance.

After the applicable approvals, DDL, ORM mappings, generated API types, RLS
policies, and constraint/negative tests must be derived from the governing
relational contract-not independently invented from this overview.

## Implemented Lab accession/specimen persistence

Migrations `0017`, `0018`, and `0019` respectively own imported evidence, exact
EHR work acceptance, and accession/specimen custody. `0019` permits one immutable
accession per work item, immutable requirements, and versioned specimen heads
with only `required -> collected -> received` or `required -> collected ->
rejected`. Labels use non-patient Lab sequences (`LAB-YYYYMMDD-NNNNNNNNNN` and
`SPC-YYYYMMDD-NNNNNNNNNN`). No execution, QC, analyzer, reagent, or result table
is introduced.

## Implemented Lab execution/result persistence

Migration `0020` ties stable execution heads to the exact accession, received
specimen, and requested-test row. Lifecycle is `in_progress -> completed`;
completion is not verification. Result heads point to immutable typed numeric
or text revisions whose source is `manual` and status is `unverified`.
Corrections increment expected versions without overwriting history. No QC,
analyzer, reagent, calibration, verification, or release table exists.
# Lab service ownership checkpoint

Applied migrations `0001`–`0022` remain in the single historical migration ledger; extraction created no schema migration. Future Lab DDL remains temporarily executed by the central migration runner until an approved ledger-ownership transition is recorded. `hid_lab_api_runtime` inherits only `hid_lab_runtime` and `hid_audit_writer`; the EHR aggregate no longer inherits Lab privileges. Lab and EHR may share the PostgreSQL cluster, but use distinct environment-injected login roles.

# Outreach registration persistence checkpoint

Migration `0024_outreach_registration_foundation.sql` creates the forced-RLS
`outreach` schema. `registration_cases` begin unresolved and can transition once,
with an expected row version, to an exact existing Identity patient. The
`temporary_patient_id` format is `tmp_<uuid-v4>` and remains immutable.
`patient_mappings`, `registration_case_events`, and `command_idempotency` are
append-only; `outbox_events` carries minimum identifiers/state only. Deferred
constraints require every resolved head and mapping to agree exactly.

The schema has no campaign, visit, screening, vaccination, referral, specimen,
document/OCR, NIN, clinical encounter, or canonical patient table. Identity
foreign keys preserve reference integrity but the Outreach role has no Identity
table read/write grant. Existing-patient authorization occurs over the Identity
API before the Outreach transaction. The applied checksum is
`65d30c48853c39188694ce95ed0c5cb489b37ec4b5d131eb955af0b43513d5f9`.

# Governed platform administration persistence checkpoint

Additive migration `0027_super_admin_foundation.sql` preserves the single
ledger and existing `auth`/`identity` ownership. It adds explicit platform
role/permission vocabulary, reasoned/versioned platform assignments, immutable
admin command idempotency, facility lifecycle metadata and immutable status
events, last-admin-safe security-definer commands, minimum platform RLS reads,
immutable audit pagination, and a PHI-minimal terminal-delivery read.

`identity.facilities.lifecycle_status` is `pending`, `verified`, `rejected`, or
`suspended`; its `active` flag is database-constrained to exactly `verified`.
New facilities default inactive/pending. Existing active/inactive rows migrate
to verified/suspended without deletion. Platform role assignment history keeps
grant/revocation reason, actor provenance, and row version.

The browser receives no database role. `hid_identity_runtime` has owned-domain
reads and exact command execution but no generic role-assignment mutation,
facility update/delete, or audit update/delete. The command-owner functions
revalidate `platform.current_account_id()`. All application/test/dispatcher
roles remain non-owner and non-BYPASSRLS. Migrations `0001`–`0026` were not
changed.

## Staging OTP recovery correction

Additive migration `0029_governed_otp_recovery.sql` binds newly issued recovery
challenges to the account token version and adds `auth.complete_recovery_otp`.
The Identity runtime retains SELECT-only access to `auth.accounts`; the
narrow command locks the current account before the challenge, validates the
purpose/completion HMAC, expiry, attempt limit, current token version and
eligible active/pending-reset state, and refuses disabled/temporarily disabled
accounts. Pre-migration unbound challenges fail closed and must be restarted.

Password replacement, token-version advancement, existing-session revocation,
one-time challenge consumption, invalidation of other recovery challenges,
contact assurance and semantic audit commit together. Existing NIN assurance
is retained. Audit failure rolls back the entire operation. Recovery does not
create a patient or silently issue a session; the caller signs in using the
new password through the appropriate account flow. A later account disable
invalidates pending credentials through token-version binding, including after
reenablement. Concurrent first-use rate buckets are serialized in PostgreSQL.

`database/tests/otp-recovery.integration.sql` exercises the actual Identity
runtime role, denied/replayed/expired/unbound credentials and audit-failure
rollback. The private synthetic staging rehearsal additionally runs the real
OTP service with PostgreSQL and Argon2, a direct-delivery test double, concurrent
completion and rate-limit checks. These tests do not establish live delivery
or staging acceptance.

## Phase 3 patient safety checkpoint

Additive migrations `0064`–`0066` (ADR-036) follow the Phase 2 ledger.
Migrations `0001`–`0063` are unchanged.

- `0064_patient_account_deletion_lifecycle.sql` adds
  `identity.patient_account_deletion_requests` (single-use confirmation token
  SHA-256, configurable cancellation window, one open request per login),
  `platform.record_class_retention_policies` (only `retain`, never automatic
  purge), `platform.legal_holds` (release-only, never deleted), and
  `platform.patient_account_deletion_settings`. Completion revokes sessions
  with `revoked` session events, clears the password credential, revokes
  federated identities, the access PIN, patient-granted grants, pending
  requests, and notification devices, and marks the account `deleted`. The
  `auth.accounts_deleted_terminal` trigger prevents reactivation or a new
  credential. `identity.current_patient_account` and
  `identity.patient_self_session` deny a login from its scheduled deletion time.
  Patient identity, NIN binding, clinical, consent, audit, and notification rows
  are retained; this is not erasure under sections 3.5 and 15.
- `0065_patient_emergency_contacts.sql` adds encrypted
  `identity.patient_emergency_contacts`, single-use HMAC-verified
  `identity.emergency_contact_verifications`, and idempotent
  `identity.emergency_contact_notifications` (`UNIQUE (consent_grant_id,
  contact_id)`, leased delivery, bounded retry, 24-hour window). A trigger on
  the existing `EmergencyAccessActivated` outbox row creates intents for
  verified, consenting contacts and audits a no-eligible-contact result; any
  failure there is audited and does not fail break-glass. Legacy
  `identity.patients.emergency_contact_*` columns are not read or modified.
- `0066_patient_access_safety.sql` adds session-bound patient wrappers for
  access-request decisions, `identity.revoke_my_consent_grant`, break-glass and
  revocability labels in patient access history, and suppresses new inbox items
  for deleted logins. It repeats the `0035` decision commands with
  `#variable_conflict use_column` because their output columns made every call
  ambiguous, and sets the created grant's `purpose_of_use` from the request as
  `0008` already requires.

`runtime-grants.sql` grants these commands, and the previously ungranted
patient inbox commands, to `hid_identity_runtime` only. Internal completion,
retention evaluation, and audit helpers are not granted. Rollback-only coverage:
`patient-account-deletion`, `emergency-contacts`, and `patient-access-safety`
integration suites; `services/identity-api/scripts/verify-patient-safety-runtime.mjs`
exercises the HTTP workflow under the exact Identity runtime role with a local
delivery stub.

## Phase 4 Stage 1 platform admin checkpoint

Additive migrations `0067`–`0068` (ADR-037) follow the Phase 3 ledger.
Migrations `0001`–`0066` are unchanged.

- `0067_platform_admin_scope.sql` adds `platform.current_access_scope()`
  (`app.access_scope`, `facility` or `platform`) and
  `audit.events.access_scope`. It replaces the two `0003` staff facility and
  membership checks with the same rules plus one exception,
  `access_scope IS NOT DISTINCT FROM 'platform'`, and adds
  `events_platform_scope_shape_check` (staff account, no facility or
  membership). The BEFORE INSERT trigger `audit_events_platform_scope` marks
  facility-less staff rows written in a platform-scoped transaction and
  requires an active `platform.admin.access` grant for a successful platform
  row; denied and failed rows remain recordable. `audit.list_platform_events`
  now selects the `patient_id` its result declares (the `0027` body failed every
  call); its signature, authorization, filters and ordering are unchanged.
  `identity.organization_application_admin_account` keeps the `0046`
  membership check for facility-scoped callers and relies on the platform
  permission alone in platform scope.
- `0068_admin_account_transition_safety.sql` adds
  `auth.accounts.disabled_from_status` (only while `disabled`) and replaces
  `auth.admin_transition_account` and `auth.admin_change_platform_role` with
  the same signatures. `active` is accepted only from `disabled` and restores
  the recorded status (`pending_reset` when none was recorded); no-op requests
  and self-targeted commands are refused; `disabled_until` is not cleared.

No grants change: both replaced commands keep their `0027` grants, and the new
helper and trigger function are revoked from PUBLIC. Rollback-only coverage:
`platform-admin-scope.integration.sql`;
`services/identity-api/scripts/verify-platform-admin-runtime.mjs` exercises the
admin HTTP boundaries under the exact Identity runtime role.

## Phase 4 Stage 2A platform security checkpoint

Additive migrations `0069`–`0070` (ADR-038) follow `0068`. Migrations
`0001`–`0068` are unchanged; no existing row is rewritten.

- `0069_platform_mfa_sessions.sql`:
  - `auth.sessions.session_kind` gains `platform`; `sessions_platform_lifetime_check`
    limits platform rows to password sessions with at most 15 minutes from
    issue (or rotation) to `expires_at` and 8 hours to `absolute_expires_at`.
  - `auth.mfa_factors` (TOTP, SHA-1/6/30; AES-256-GCM ciphertext only; one
    pending and one active per account; `last_used_step` only moves forward),
    `auth.mfa_recovery_codes` (keyed digests, used or invalidated once),
    `auth.mfa_login_challenges` (SHA-256 token digests, at most 10 minutes and 5
    attempts) and `auth.session_assurance` (MFA method/time and step-up time per
    platform session family). Guard triggers make secrets, digests and
    evidence immutable and refuse deletes and backwards transitions.
  - New `auth.session_events` types for MFA and step-up and new
    `auth.otp_rate_limits` scopes (`mfa_failure_account`, `mfa_failure_ip`,
    `mfa_request_account`) reuse the existing tables.
  - Permissions `platform.principal.export` and `platform.mfa.reset`
    (`platform_super_admin` only).
  - `platform.current_session_id()` (`app.session_id`, now set by the Identity
    API with the other request GUCs), `auth.account_has_active_mfa`,
    `auth.platform_step_up_is_fresh`/`auth.require_platform_step_up` (active
    platform session of the actor, active factor, step-up in the last 5
    minutes) and `auth.admin_revoke_session_family`.
- `0070_platform_two_person_approval.sql` adds `auth.admin_approval_requests`
  (24-hour window, one pending request per action and target, immutable once
  decided), `auth.admin_request_approval` and `auth.admin_decide_approval`
  (row-locked, executed once, approver must be a different active
  MFA-enrolled `platform_super_admin` with fresh step-up). It replaces
  `auth.admin_transition_account` and `auth.admin_change_platform_role` (same
  signatures): the role command refuses a `platform_super_admin` grant
  (`ADMIN_APPROVAL_REQUIRED`), and last-Super-Admin reachability
  (`auth.other_reachable_super_admins`) counts active role holders with a
  password credential instead of requiring a facility membership.

## Platform controls command fix

`0071_platform_control_command_column_references.sql` replaces
`platform.admin_set_control` with the same signature, result, permission
checks, validation and `platform.control_events` row. In the `0039` version the
`RETURNS TABLE` output columns shadowed `control_key` and `row_version`, so
every call failed with `42702` (ambiguous column) before changing anything.
`runtime-grants.sql` now also grants `EXECUTE` on `platform.admin_list_controls()`
and `platform.admin_set_control(text,boolean,bigint,text)` to
`hid_identity_runtime` (inherited by `hid_identity_api_runtime`) and
`hid_schema_test_runtime`; `0039` revoked them from `public` and no runtime role
had been granted them, so `GET /admin/controls` and `POST /admin/controls`
returned 500. `runtime-roles.integration.sql` asserts the grants and the
absence of direct table privileges, and `platform-controls.integration.sql`
exercises both commands as `hid_identity_api_runtime`.

Grants: the Identity runtime gets `select, insert, update` on the four MFA/assurance
tables (no delete), `select` on approval requests, and `execute` on the new
commands; internal helpers and trigger functions are revoked from PUBLIC.
Rollback-only coverage: `platform-mfa-approval.integration.sql` (killed by nine
recorded mutants); `verify-platform-security-runtime.mjs` exercises the HTTP
workflow under the exact Identity runtime role.

## Platform admin contract gaps (0072)

`0072_platform_admin_contract_gaps.sql` (Phase 4 Stage 4A,
`PHASE_4_STAGE_4A_ADMIN_CONTRACTS.md`):

- `audit.list_platform_events` gains `requested_resource_type` and
  `requested_resource_id` (both default null), so the console can read one
  target's history. Adding parameters changes the signature, so the `0067`
  function is dropped and recreated. Authorization (`platform.audit.read`), the
  result, the other filters and the newest-first `sequence_id` keyset are
  unchanged. A UUID-shaped id matches the generated `resource_uuid` column (any
  letter case) through the new `audit_resource_uuid_sequence_idx (resource_type,
  resource_uuid, sequence_id desc)`. Other ids match `resource_id` exactly. An id
  without a type, or a value outside the documented patterns, raises `22023
  ADMIN_INVALID_AUDIT_FILTER`. The function sets `plan_cache_mode =
  force_custom_plan` so each call is planned for its own filters.
- `identity.admin_transition_facility` keeps its `0027` signature, checks,
  advisory lock, idempotency and evidence. Its last-Super-Admin count is now
  `auth.other_reachable_super_admins(null, null)`, the platform-session
  reachable set of `0070`, instead of Super Admins with a membership at another
  verified facility. A facility change removes no platform-session path, so the
  command is refused only while a Super Admin works at the facility and no
  Super Admin can open a platform session.
- `auth.other_reachable_super_admins` treated a null excluded account as
  excluding every account. A null now excludes nobody; every existing caller
  passes a non-null account.

`runtime-grants.sql` grants `EXECUTE` on the eleven-argument signature to
`hid_identity_runtime` (inherited by `hid_identity_api_runtime`) and
`hid_schema_test_runtime`, the roles that held the old one.
`runtime-roles.integration.sql` asserts:
- the old signature is gone;
- `PUBLIC` and the other API runtimes cannot execute the new one;
- the reachability helper stays internal.

`platform-admin-contracts.integration.sql` exercises both commands as
`hid_identity_api_runtime`. `schema.integration.sql` now expects the facility of
a reachable Super Admin to be suspendable.

## Session revocation serialization (0073)

`0073_session_revocation_serialization.sql` (Phase 4 Stage 5B,
`PHASE_4_STAGE_5_RELEASE_READINESS.md` §2):

- A refresh inserts the new session, then marks the old one `rotated`, in one
  transaction. Under READ COMMITTED, a family or account revocation whose
  `UPDATE` ran in between waited for the old row, skipped it as already revoked,
  and could not see the uncommitted new session. That session stayed live, even
  after a revocation marked compromised.
- The new session's `INSERT` takes `FOR KEY SHARE` on the account row through
  the `auth.sessions.account_id` foreign key. `auth.lock_account_sessions(uuid)`
  takes `FOR UPDATE` on that row, which conflicts with it. A revocation that
  calls it first waits for a rotation in flight, and its `UPDATE`, a new
  statement with a new snapshot, then sees and revokes the new session. A
  rotation that starts after the lock waits, then finds its old session revoked
  and is refused.
- `auth.admin_revoke_account_sessions` and `auth.admin_revoke_session_family`
  are replaced with the lock added before their `UPDATE`. They lock the target's
  and the acting administrator's account rows in one statement, in account
  order, because their idempotency row references the actor's account; two
  administrators revoking each other's sessions at once then cannot deadlock. Signatures,
  permissions, checks, idempotency and results are unchanged, and `CREATE OR
  REPLACE` keeps their owner and grants.
- The Identity API calls the helper before its own revocations: refresh-token
  reuse, an administrator revoking their own session, sign-out and expiry. A
  sign-out revokes the presented session's family, so it also ends a session
  that a refresh in another tab created while it waited. With
  D-Eminence/hid-system#39 (no migration or grant change), a
  sign-out by refresh cookie, once the access token has expired, takes the
  same path. It locks the account by the session that `refresh_token_sha256`
  finds, then reads that session and ends the sign-in if anything of it is
  left (the session unrevoked, or rotated into a family session that is),
  whatever its expiry or the account's state; a sign-in a concurrent sign-out
  has just ended is not recorded again. Its `logout` event carries
  `presented: refresh_token` in `details`.
  Every path that revokes sessions therefore locks the account row before any
  session row. The account actions that change the token version already did.
- Platform MFA transactions do not use this helper: since Phase 4 Stage 7A they
  take the account row with `auth.lock_account_for_mfa(uuid)` (0076, below),
  which is `FOR NO KEY UPDATE`.
- `runtime-grants.sql` grants `EXECUTE` on the helper to `hid_identity_runtime`
  only; `PUBLIC` has none. The runtime still has only `SELECT` on
  `auth.accounts`. `runtime-roles.integration.sql` asserts both.
- `session-revocation-serialization.integration.sql` checks the catalog contract
  that a later `CREATE OR REPLACE` must keep. The two-connection races run in
  `services/identity-api/scripts/verify-platform-security-runtime.mjs`.

## Staff access-request outcomes (0074)

`0074_staff_access_request_outcome.sql` (Phase 4 governed access):

- A request stays `approved` after its grant expires, is revoked by the patient
  or is closed by the clinician. `identity.list_my_staff_access_requests` now
  also returns, from the latest grant made from each request:
  - `consent_grant_id` and `grant_expires_at`;
  - `effective_status`: the request status, except for an approved request with
    a grant. That reports whichever ended the grant first: `active` (current),
    `expired` (lapsed, whether or not a sweep has marked it, and also when it
    was revoked only after it lapsed, for example by a later PIN change or
    account deletion), `closed` (revoked by the requesting clinician, the
    grant's own account, before it lapsed) or `revoked` (by anyone else before
    it lapsed). Who revoked it is not returned, and nothing done after a grant
    lapsed changes its outcome;
  - `authorization_method`: `patient_access_pin` or `patient_approval`.
- Pending requests have no expiry of their own; they stay `pending`.
- The status filter matches the request status or the outcome: `approved`
  still returns every approval, and `active`, `expired`, `closed` and `revoked`
  return the approvals with that outcome (the Identity DTO accepts the two new
  values). Argument, caller checks, order and the 100-row limit are unchanged.
- The result type changes, so the function is dropped and recreated;
  `runtime-grants.sql` restores `EXECUTE` for `hid_identity_runtime` and
  `hid_schema_test_runtime` at the role bootstrap. Until it runs, every Identity
  build is refused the list (`403`), so it runs immediately after the
  migrations.
- `consent_grants_request_idx (request_id, created_at desc) where request_id is
  not null` serves the per-request lookup.
- `staff-access-request-outcome.integration.sql` covers each outcome, the
  filter, a colleague's isolation and a member without `identity.consent.write`,
  as `hid_identity_api_runtime`.

## OCR queue metrics, OCR read audit and OCR outbox inserts (0075)

`0075_ocr_queue_metrics_and_outbox_insert.sql` (Phase 4 Stage 6):

- With every claim, the OCR worker logs queue depth and the age of the oldest
  queued job (`ocr.job.claimed`, read by the `OcrQueueAgeAlarm` and QueueDepth
  metric filters). It read `ocr.jobs` directly, which `hid_ocr_worker` may not
  do, so the read was always refused and only
  `ocr.queue.metrics_unavailable` was logged. `ocr.worker_queue_metrics()`
  returns the two aggregates with the same definitions as before: queued rows
  across every facility, and the time since the earliest `queued_at` (worker
  retries keep the original `queued_at`; an API retry resets it).
- The function is `SECURITY DEFINER` with `search_path = pg_catalog, ocr,
  pg_temp`, and `PUBLIC` cannot execute it. `runtime-grants.sql` grants
  `EXECUTE` to `hid_ocr_worker` only and makes `hid_ocr_queue_metrics` its
  owner. That role is `NOLOGIN NOINHERIT NOBYPASSRLS`, is never granted to
  another role, and holds only `USAGE` on schema `ocr` and `SELECT` on
  `ocr.jobs (status, queued_at)`. It sees every facility's jobs through the
  policy `ocr_jobs_queue_metrics_read ... for select to hid_ocr_queue_metrics
  using (true)`, so the function does not depend on its owner bypassing
  `FORCE ROW LEVEL SECURITY`. This is the pattern of
  `integration.event_delivery_status()` and `hid_event_delivery_commands`.
- `ocr.outbox_events` had only `SELECT` policies under `FORCE ROW LEVEL
  SECURITY`, so every insert by the OCR API runtime was refused. Patient
  confirmation and every publication request, success and failure append an
  outbox event in the same transaction, so all of them failed under the
  least-privilege role. `ocr_outbox_staff_insert` admits rows for the current
  facility only, like the existing extraction and validation insert policies.
- The OCR API now records a patient-linked audit event, in the same transaction
  as the read and after authorization, for the job lookup by document
  (`ocr.job.find`), the validation list (`ocr.validation.list`) and the
  publication list (`ocr.publication.list`). Every OCR API job event names the
  source document's patient, which authorization resolves, rather than the
  job's own `patient_id`, which stays null for jobs created without one.
  Details hold identifiers and counts only. A document with no OCR job
  discloses nothing and is recorded only by the request audit. The worker's
  own database audit events (`ocr.worker.*`) still carry `ocr.jobs.patient_id`.
- The `OcrPatientConfirmed` outbox event is keyed by the job version, which a
  confirmation does not change. A second confirmation of the same job version is
  refused with `409 OCR_PATIENT_ALREADY_CONFIRMED`.
- `ocr-queue-metrics-and-outbox.integration.sql` covers the worker's aggregate
  across facilities, the refusal of six other roles and of any other non-superuser
  role that does not inherit the worker, the owner's exact column limit,
  that visibility comes only from the exact policy, and same-facility outbox
  inserts by `hid_ocr_api_runtime` (another facility is refused).

## MFA account lock and fail-closed OCR validation guards (0076)

`0076_mfa_account_lock_and_fail_closed_ocr_guards.sql` (Phase 4 Stage 7):

- `auth.lock_account_for_mfa(uuid)` takes `FOR NO KEY UPDATE` on the account row.
  Every platform MFA transaction of the Identity API calls it before any other
  lock or write: the password step, sign-in with a TOTP or recovery code,
  enrolment start and activation, step-up and recovery-code regeneration. An
  approved MFA reset (`auth.admin_decide_approval`, 0070) locks the target
  account `FOR UPDATE` and then its factors, recovery codes and sessions. An MFA
  transaction that locked its challenge, assurance or factor first, and reached
  the account only through the `FOR KEY SHARE` of its later inserts, could
  deadlock with it.
- `FOR NO KEY UPDATE` conflicts with that `FOR UPDATE`, with the revocation
  lock (`auth.lock_account_sessions`, 0073) and with itself, so MFA
  transactions of one account run one at a time. Parallel second-factor
  attempts are then checked against the failure limit one after another, and a
  password step supersedes the open challenge of the one before it. It does not
  conflict with the `FOR KEY SHARE` of a refresh rotation or a staff sign-in of
  the account.
- Two other modes were rejected after local reproductions. With `FOR UPDATE`, a
  step-up that raced a refresh found its session rotated and was refused, and
  the password step deadlocked with a staff sign-in through the principal's
  `auth.login_attempts` row. With `FOR KEY SHARE`, six parallel step-ups with a
  wrong code were all tested instead of five and a refusal, and two parallel
  password steps each left a challenge open.
- The helper is `SECURITY DEFINER` with `search_path = auth, pg_temp`.
  `runtime-grants.sql` grants `EXECUTE` to `hid_identity_runtime` only, and the
  runtime still cannot update `auth.accounts`. `mfa-account-lock.integration.sql`
  checks the catalog contract and the exact function body, so a later `CREATE OR
  REPLACE` cannot weaken the lock or add `SKIP LOCKED`, `NOWAIT` or a
  condition. `runtime-roles.integration.sql` checks that the ACL names no
  grantee but the owner and `hid_identity_runtime`. The races run in
  `services/identity-api/scripts/verify-platform-security-runtime.mjs`.

The guards (7B):

- `ocr.validate_patient_confirmation()` and `ocr.validate_validation_insert()`
  are the `BEFORE INSERT` triggers on `ocr.patient_confirmations` and
  `ocr.validations`. They compared with `<>`, which is NULL when either side is
  NULL, and `IF` does not raise on NULL. A confirmation was therefore accepted
  for any patient when the guard could not read the source document (missing,
  or hidden by row-level security from a definer owner that does not bypass it,
  release checklist P8). A validation was accepted when the guard could not
  read the extraction, or when the session had no account
  (`platform.current_account_id()` NULL: no `app.actor_subject`, or no active
  account for it) or no membership (`platform.current_membership_id()` NULL).
- Both guards now refuse a missing job, source patient, extraction, account or
  membership explicitly and compare with `IS DISTINCT FROM`. The confirmation
  guard also requires `confirmed_by` and `confirmed_by_membership_id` to be the
  session's account and membership, as the validation guard already required
  of `validated_by` and `validated_by_membership_id`.
- Error codes (`23514`) and messages are unchanged. `CREATE OR REPLACE` keeps
  each function's owner and ACL; `SECURITY DEFINER`, the `search_path` and the
  volatility are restated as in 0013 and 0016, and the triggers are unchanged.
- Under a non-bypass owner that cannot read the source document, every
  confirmation is refused. Validations read only facility-scoped OCR tables,
  which the session's facility makes visible, and are unaffected.
- `ocr-validation-guards.integration.sql` runs 23 cases with only the guard
  under test enabled (`session_replication_role = replica` plus
  `ENABLE ALWAYS TRIGGER`), each attempted and undone:
  - valid writes;
  - a missing patient, another patient than the source document's or the
    job's own;
  - a missing document, job or extraction, or an extraction of another job;
  - another facility, a job not awaiting validation, a wrong version;
  - a session without an account or membership, and another account or
    membership than the session's.
- The suite also checks that both functions keep `SECURITY DEFINER`, their
  `search_path`, volatility and owner, and their enabled triggers.
- On 0075 it fails with 10 wrong outcomes. Under the non-superuser owner of the
  rehearsal it fails with 12, because the guard cannot read the source document
  and also accepted the wrong patient.
- Removing any one comparison predicate of either guard makes it fail. The
  explicit `IS NULL` refusals are redundant in outcome only because every
  compared column of the new row is `NOT NULL`. `IS DISTINCT FROM` refuses a
  NULL against a value, but a NULL against a NULL is not distinct; the column's
  `NOT NULL` constraint then refuses the row (`23502`, not the guard's
  `23514`). A guard that compares a nullable column needs the explicit
  refusal.

## Fail-closed session guards and OCR worker leases (0077)

`0077_fail_closed_session_guards_and_ocr_worker_leases.sql` (Phase 4 Stage 8)
applies the fail-closed rule of ADR-040 to every remaining guard that compared
a row with the session's account or membership using `<>`. It replaces 18
functions with `CREATE OR REPLACE`, which keeps each owner, ACL and trigger;
`SECURITY DEFINER` (or its absence), the `search_path` and the volatility are
restated as before. Error codes and messages are unchanged.

OCR worker commands (0014):

- `ocr.complete_worker_job` and `ocr.fail_worker_job` compared the claim token
  with `<>`. With a NULL token the lease check was NULL and passed, so any
  session of the OCR worker subject (shared by every worker replica) could
  complete or fail a job another replica held. Both now refuse a NULL token
  (`55000 OCR claim is not active`), as `ocr.renew_worker_claim` did, and
  compare token, holder and status with `IS DISTINCT FROM`. Replaying a
  completed result still depends only on the job, the result key and the
  content hash, as in 0014, not on the token; a NULL token is refused before
  the replay.
- `fail_worker_job` also refuses an expired lease, as `complete_worker_job`
  and `renew_worker_claim` do; the job then belongs to the lease recovery in
  `ocr.claim_worker_job`.
- Missing result or failure metadata (content hash, structured payload,
  provenance, error code, retry flag, retry delay) is refused as invalid
  (`22023`) instead of passing a NULL comparison: before, a NULL content hash
  replayed a stored extraction and a NULL retryable flag failed a job for
  good. A NULL confidence stays allowed.

OCR job trigger (`ocr.validate_job_write`, 0016):

- Lease renewal: the state machine allowed no `processing` to `processing`
  update, so every `ocr.renew_worker_claim` was refused (`23514 Invalid OCR job
  state transition`) and the worker logged `ocr.job.lease_renewal_failed` every
  third of a lease. A job that ran longer than its lease (300 s by default)
  could not complete. A processing job whose lease is still active may now
  take a later expiry, at most an hour ahead (the `renew_worker_claim`
  maximum), and the next `row_version`, and nothing else changes: the trigger
  compares the whole old and new rows without `claim_expires_at`,
  `row_version` and `updated_at`. An expired lease, an endless one and any
  other column change are refused, also for the OCR API runtime, which has
  `UPDATE` on `ocr.jobs`. `ocr.record_job_event` records no job or outbox
  event for an update that leaves the status unchanged, so a renewal that
  names the status is not reported as a new start.
- Source evidence: the latest scan of the source document was compared with
  `<>`, so a document with no scan event at all passed. A write that binds a
  job to its source (an insert, or a change of the document or the source
  object) or starts processing it now needs an exact clean scan and refuses a
  missing one. Other updates keep the 0016 rule, so a job created earlier for
  a document without a scan event can still be failed, recovered, retried,
  renewed and validated; the worker never claimed such a job. A scan that does
  exist must be exactly clean, except as below. Changing the document of a job
  to one without an exact clean scan now fails with `23514` before the
  immutability check (`55000`); no application path changes it.
- Taking a job out of play (to `failed` or `cancelled`, or a failed job back to
  `queued`) no longer reads the source evidence. Before, a job whose document
  was withdrawn (`entered_in_error`) or scanned as not clean while it was
  processing could be neither completed nor failed, and the lease recovery in
  `ocr.claim_worker_job`, which fails and requeues it, raised for every claim
  of its provider until an operator repaired the data. A
  requeued job is still claimed only with exact clean evidence, which the
  claim checks itself, and completing or validating such a job is still
  refused. No API route cancels a job; an operator cancels one with a direct
  update (`status = 'cancelled'`, next `row_version`).

OCR publication trigger (`ocr.validate_publication_write`, 0016):

- An insert must name the session's own account and membership as
  `requested_by` and `requested_by_membership_id`, and is refused (`23514`)
  when the session has none. Before, a request could name any member of the
  facility, the attribution gap 0076 closed for patient confirmations.
  Lifecycle updates read no session, because the OCR API claims, completes and
  retries requests from other sessions; the requester stays immutable.

Lab, Pharmacy and Outreach guards:

- Lab: `lab.validate_imported_evidence`, `lab.validate_work_item`,
  `lab.validate_accession_insert`, `lab.validate_execution_insert` and
  `lab.validate_result_governance` (0017–0021). Pharmacy:
  `pharmacy.validate_work_item`, `pharmacy.validate_work_item_event`,
  `pharmacy.validate_dispensing`, `pharmacy.validate_dispensing_reversal` and
  `pharmacy.validate_imported_medication_evidence` (0023). Outreach:
  `outreach.validate_registration_case_write`,
  `outreach.validate_registration_case_event` (invoker rights) and
  `outreach.validate_campaign_write` (0024, 0045).
- Each now reads the session's account, membership and facility once, refuses
  a missing value wherever the 0017–0045 body compared it, and compares with
  `IS DISTINCT FROM`; missing parent rows are refused explicitly. The
  Outreach registration guard also refuses a missing purpose of use, and
  reports a missing account or membership as missing context (`42501 Valid
  Outreach registration context is required`) rather than with the insert or
  resolution message. Where a guard did not compare a value, it still does
  not: the Pharmacy work-item event guard has no facility term and the
  Outreach campaign update compares only the facility.
- 0080 adds an EHR prescription check after the 0077 checks of
  `pharmacy.validate_work_item` and `pharmacy.validate_dispensing` ("Pharmacy
  source prescription guards (0080)"); the 0077 checks and messages are kept.
- The guards read the session values when they start. A malformed
  `app.membership_id` or `app.facility_id` (not a UUID) therefore raises
  `22023` before a guard's own refusal, also on the Outreach campaign update,
  which did not read the membership before. The services always set UUIDs.
- Forced row-level security already refused these NULL-session writes for the
  runtime roles, after the guard had let them through. A session that bypasses
  row-level security (a superuser, or an owner without `FORCE ROW LEVEL
  SECURITY`) could write Lab, Pharmacy or Outreach rows attributed to any
  member with no request context; now the guard refuses them.
- The OCR publication branch of `lab.validate_imported_evidence` read OCR rows
  that its owner sees through row-level security. Under an owner that does not
  bypass it (release checklist P8), another facility's validation and
  publication read as NULL and passed. It now refuses a missing job,
  extraction, validation or publication. An OCR job without a patient stays
  acceptable, as in 0016 and 0076; the publication binds the patient.
- Refusals that came from row-level security (`42501 new row violates
  row-level security policy`) now come from the guard with its own code. No API
  maps these codes differently.

Outreach runtime grant:

- Outreach RLS policies and the invoker-rights event trigger call
  `platform.current_account_id()`, an invoker SQL function that calls
  `auth.account_id_for_subject(text)`, which is revoked from PUBLIC. The
  Outreach runtime had no `EXECUTE` on it, so every Outreach write (and the
  idempotency replay read) failed with `42501 permission denied for function
  account_id_for_subject`. `runtime-grants.sql` now grants it to
  `hid_outreach_runtime`, as to the Identity and EHR runtimes.
  `runtime-roles.integration.sql` asserts that no runtime can reach a table
  whose policy expression or invoker trigger body calls
  `platform.current_account_id()` directly without that grant.
  `services/outreach-api/src/database/runtime-function-grants.spec.ts` checks
  the Outreach roles without a database, following policies, invoker triggers
  and invoker functions through the migrations, and fails on SQL forms it
  cannot follow.

Tests (rollback-only, synthetic fixtures):

- `ocr-worker-lease.integration.sql`: 41 cases. The worker commands run as
  `hid_ocr_worker` with the worker's session, including the lease recovery of
  a job whose document was withdrawn, and direct job updates as
  `hid_ocr_api_runtime`. On 0076 it fails with 17 wrong outcomes.
- `ocr-job-source-and-publication.integration.sql`: 30 cases as
  `hid_ocr_api_runtime` with the OCR API's session. On 0076 it fails with 12
  (two of them only by error code: `55000` and the foreign key's `23503`).
- Of twelve single-point mutants of the 0077 OCR functions (the row equality,
  the expiry and active-lease bounds of renewal, the start-of-processing
  binding, the out-of-play exemption, each metadata refusal, the same-status
  event rule), the two OCR suites catch eleven. The survivor drops the
  explicit NULL-token refusal in `fail_worker_job`, which the `IS DISTINCT
  FROM` token comparison makes redundant.
- `lab-session-guards.integration.sql`, `pharmacy-session-guards.integration.sql`
  and `outreach-session-guards.integration.sql`: each guard isolated
  (`session_replication_role = replica` plus `ENABLE ALWAYS TRIGGER`) under a
  session that bypasses row-level security, and the services' own statements
  as the runtime role with every trigger and policy. Each records the role and
  replication mode of every case and fails if a case ran in the wrong one.
  - Lab: 86 cases. On 0076 it fails with 60: 42 isolated cases were accepted
    (six missing-session variants for each of the seven guarded tables) and 18
    runtime cases were refused only by row-level security.
  - Pharmacy: 84 cases. On 0076 it fails with 58: 29 isolated cases accepted,
    29 runtime cases refused only by row-level security. Since 0080 its
    fixture holds the active EHR prescriptions its work items accept.
  - Outreach: 121 cases (51 isolated, 50 runtime, 20 for the API's create,
    link, campaign and status commands). On 0076 it fails with 67: 45 change
    with 0077 alone, 33 with the grant alone, and 11 need both.
  - Restoring any one replaced function to its earlier body makes its suite
    fail.
- Each suite checks the replaced functions' `SECURITY DEFINER`, `search_path`,
  volatility, owner and enabled triggers, and probes whether the guard's owner
  can see its fixtures: under the rehearsal's non-superuser owner, refusals are
  required but their codes may differ. Under that owner the OCR worker
  commands cannot claim or see jobs at all (P8) and the Pharmacy event,
  dispensing and reversal guards refuse a missing session anyway, because
  their parent rows are hidden from them; so for the OCR lease, OCR job
  source and those Pharmacy guards, the rehearsal's first run, under the
  migration owner, is the one that detects a regression.

## Runtime command repairs and row locks (0078, Phase 4 Stage 9)

The runtime roles could not run several of their own commands (release
checklist §4.2). `SELECT ... FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` and
`FOR KEY SHARE` need `UPDATE` on each locked table, checked when the statement
starts, and under row-level security the table's `UPDATE` policies also filter
the locked rows. The Pharmacy, Lab, OCR and Outreach APIs locked insert-only
rows their runtime roles cannot update (`42501` before any row is read), and
Identity locked the nullable side of an outer join (`0A000` for every role).
Stage 9 changes the services to lock only rows their role may update (ADR-042)
and repairs, in
`0078_runtime_command_repairs.sql`, two defects hidden behind those locks:

- **Self-NIN identifier policy.** `patient_identifiers_self_nin_insert` (0058)
  has no `TO` clause, so it applies to every role, and its `WITH CHECK` read
  `identity.verification_evidence`. PostgreSQL combines permissive policies
  with `OR` but checks, as the querying role, the privileges on everything
  every applicable policy reads before evaluating any of them. The Identity
  runtime has no `SELECT` on `verification_evidence`, so every Identity
  runtime insert into `identity.patient_identifiers` failed with `42501`,
  including the governed NIN registration review, which another policy
  allows. 0078 drops the policy. The only writer of self-NIN identifiers is
  `identity.bind_my_verified_nin`, a `SECURITY DEFINER` function owned by the
  table's owner, and `identity.patient_identifiers` does not force row-level
  security, so that function never used the policy. The policy only let
  another role insert a self-NIN identifier directly, without the binding
  function's checks (the patient's own session, crosswalk ownership, manual
  review, single-NIN eligibility, the per-NIN lock); repairing its privileges
  (a first version of 0078 did, through a definer predicate) would have given
  that to the Identity runtime, and granting `SELECT` on
  `verification_evidence` would also have exposed every patient's evidence.
  `runtime-roles.integration.sql` requires that no insert policy names the
  self-NIN source and that the table does not force row-level security.
- **Lab work-item child guard.** `lab.validate_work_item_child` (0018) guards
  `lab.work_item_requested_tests` and `lab.work_item_events`. Its
  requested-test check read `NEW.ordinal`, `NEW.code` and other snapshot
  columns in the same `IF` condition as the table-name test. PL/pgSQL resolves
  a condition's record fields before `AND` short-circuits, so on
  `lab.work_item_events`, which has no `ordinal`, it failed with `42703 record
  "new" has no field "ordinal"`, and every Lab acceptance of an EHR order
  failed at its acceptance event. 0078 reaches the check only for
  `lab.work_item_requested_tests`; the checks are unchanged and compare with
  `IS DISTINCT FROM` (ADR-040; the same as `<>` here, as every compared column
  is `NOT NULL`). Signature, owner, ACL, `SECURITY DEFINER`, `search_path`,
  volatility, error code and messages are kept.

Dropping the policy takes an `ACCESS EXCLUSIVE` lock on
`identity.patient_identifiers` for the catalog change only; nothing is scanned
or rewritten. 0078 needs no grant change, but the Stage 9 role assertions
(`runtime-roles.integration.sql`, run by `db:bootstrap` and `db:verify-roles`)
require the self-NIN policy to be gone, so run them after 0078.

Service changes that the database relies on:

- Pharmacy, Lab and OCR no longer lock their insert-only evidence (work items,
  dispensings, reversals, imported evidence, accessions, OCR validations and
  confirmations). Their append-only triggers refuse every update and delete,
  and unique keys decide concurrent writes. OCR keeps the job row lock
  (`FOR UPDATE` on `ocr.jobs`) as the first lock of retry, validation,
  confirmation and publication requests; the publish and failure transactions
  of a publication take the job's `FOR KEY SHARE` (the lock their outbox
  insert's foreign key takes) before the publication row, so every OCR
  transaction reaches the job before the publication. A publication replay
  reads its row without a lock, on a snapshot that can predate a failure that
  committed while it waited for the job, so the publication claim itself
  refuses a terminal failure.
- Outreach locks `FOR SHARE OF campaign` for a campaign-linked registration,
  not the membership row. The campaign `UPDATE` policy then applies, so a role
  with `outreach.registration.write` needs `outreach.campaign.write` too.
- Identity's NIN registration review locks the registration case alone, then
  reads it with its patient.
- The Pharmacy, Lab, OCR and Outreach `DatabaseService` run a `SERIALIZABLE`
  transaction again, up to twelve attempts in all, on `40001`, `40P01` and
  `23505` (a unique violation once only: the next attempt sees the committed
  row and replays it, and a second one is a real conflict), after a random
  pause within a window that doubles from 20 ms to 1 s. `SERIALIZABLE` tracks
  reads by index page, so on small tables
  concurrent requests for different rows also cancel each other; the pauses
  let them commit one after another.

Checks:

- `scripts/verify-runtime-locking-privileges.mjs` (`npm run verify`) finds every
  lock clause in the service source, including clauses built from constants,
  ternaries and helper flags. It reads each literal as the string JavaScript
  makes of it (escape sequences decoded) and each statement as PostgreSQL
  reads it (comments as whitespace, text in SQL strings not a lock). Lock text
  it cannot place fails the check: a fragment counts only inside an
  interpolation a locking statement resolved (the branches of a ternary, not
  its condition), or bound to a constant, not exported, used only as such
  interpolations; an unresolved lock strength (`for ${...}`), an
  interpolation after the lock clause (`of s${more}`), a statement with more
  than 64 variants or with no lock clause the analysis can read, and a name
  that occurs anywhere in the file other than in its literal declaration or
  as a whole interpolation (a parameter, a destructuring, a loop variable, an
  assignment) are refused, not guessed. It resolves the locked tables (`OF`
  aliases, outer joins) and replays the migrations and `runtime-grants.sql`
  to model each runtime role's effective privileges, following only
  memberships that pass on privileges (the `INHERIT` attribute as it is when
  each grant is made, `WITH INHERIT`, `REVOKE INHERIT OPTION`, `CREATE ROLE
  ... IN ROLE`), row-level security and `UPDATE` policies. It refuses a table
  grant or a policy statement inside a dollar-quoted body, except a `DO`
  block that drops and creates one policy only when `pg_policy` lacks it (the
  bootstrap's `platform_controls_definer_read`), whose two statements it
  replays as top-level ones. It fails on a lock the role cannot take, and on
  the locks PostgreSQL refuses for every role
  (`0A000`): the nullable side of an outer join, `DISTINCT`, `GROUP BY`,
  `HAVING`, aggregates, window functions, set-returning functions in the
  select list and set operations. It does not follow SQL assembled by string
  operations outside literals: a keyword split across a concatenation
  (`'fo' + 'r update'`) or a `.replace()` on an assembled statement; the
  runtime command suite and the runtime verifiers, which run the commands as
  their roles, are the check for those. On `main` before Stage 9 it reports
  14 of 43 clauses, exactly the §4.2 statements; now 0 of 31. The rehearsal
  also runs it with `--catalog`, comparing the replayed model with the
  migrated catalogue (146 tables, no difference). CI runs it, its tests and
  the rehearsal in the workspace gates job of `tuf-local-gates.yml`
  (`release/scripts/run-workspace-gates.mjs`).
- `runtime-command-privileges.integration.sql` (rollback-only):
  - Case 1 plans (`EXPLAIN`, which performs the start-of-statement privilege
    checks) a no-op select, insert, update, delete and row lock as each of ten
    runtime roles on every table where it holds the privilege (239 probes) and
    fails on any refusal. On 0077 it fails with the Identity identifier insert
    (`42501 permission denied for table verification_evidence`).
  - Case 2 runs one representative lock statement per role whose locks Stage 9
    kept, changed or added (the Identity registration case, the OCR job
    `FOR UPDATE` and key share, the Outreach `FOR SHARE OF campaign`, a Lab
    specimen), as their runtime roles; the static check covers every clause,
    and the runtime verifiers run the commands.
  - Case 3 requires the eleven tables whose locks were dropped (nine
    insert-only tables, `outreach.campaign_members` and `identity.patients`)
    to stay unlockable for their runtime roles (`42501`): Stage 9 granted no
    `UPDATE`.
  - Case 4 requires every role with `outreach.registration.write` to hold
    `outreach.campaign.write`.
  - Case 5 isolates `lab.validate_work_item_child` (replication mode plus
    `ENABLE ALWAYS TRIGGER`): the acceptance event and a matching requested
    test pass, mismatched snapshots and parents are refused. On 0077 it fails
    with `42703`. The guard reads the work item as its owner, with no session
    in this case, so under the rehearsal's non-superuser owner (P8) it cannot
    see it and must refuse every case; the run under the migration owner is
    the one that checks the accepted cases.
  - Case 6 requires the Identity runtime to be refused (`42501`, row-level
    security) when it inserts a self-NIN identifier directly, even for a
    verified QoreID evidence row of the same patient. It fails on the first
    version of 0078.
- Runtime HTTP verifiers, run by the rehearsal one at a time on disposable
  copies of its database, with every database connection starting as the
  runtime role (libpq `options=-c role=...`) and the other HID services
  replaced by local fakes:
  `services/pharmacy-api/scripts/verify-pharmacy-runtime.mjs`,
  `services/lab-api/scripts/verify-lab-runtime.mjs`,
  `services/ocr-api/scripts/verify-ocr-runtime.mjs` and
  `services/outreach-api/scripts/verify-outreach-runtime.mjs` run the
  service's real `AppModule` through `scripts/service-runtime-harness.mjs`;
  `services/ehr-api/scripts/verify-ehr-lab-handoff-runtime.mjs`
  (D-Eminence/hid-system#56) runs EHR's and, in a child process, Lab's
  through it, each as its runtime role, and checks that an active lab request
  Lab refuses stays saved, is sent again on request, on activation and on
  resume, and that Lab keeps one work item per request;
  `services/identity-api/scripts/verify-registration-review-runtime.mjs`
  composes the authentication and NIN registration controllers with their
  real providers, the global security guard and audit interceptor, and the
  test NIN verification provider; the OTP notification client and Google
  sign-in are stubbed. They cover authorized success,
  denials (permission, facility, Identity decision), concurrent identical and
  conflicting requests, replays and key reuse, stale versions, and rollback
  after a failure injected late in the transaction. The OCR verifier races a
  held job or publication row against the publication transactions and probes
  the other row below the deadlock timeout. Each verifier ends by requiring
  `pg_stat_database` to report no deadlock for its database, read after the
  service's connections closed, so a deadlock the retry hid still fails it.
  `verify-lab-runtime.mjs` also pins which database refusals Lab maps: only
  EHR-order acceptance maps its own (D-Eminence/hid-system#56), the
  `lab.validate_work_item` refusal (`23514`) to `409 LAB_ORDER_NOT_CURRENT`
  and the row-level security refusal of the work-item insert (`42501`) to
  `403 LAB_ACCESS_DENIED`; a member verifying a result they entered (`23514`),
  the loser of two verifications of one result version (`23505`) and an
  external or OCR import without a database consent (`42501`) still answer
  `500`, which OCR stores for its Lab import as the retryable
  `OWNING_SERVICE_UNAVAILABLE`.

## Patient access PIN actor window (0079)

`0079_patient_access_pin_actor_window.sql` replaces
`identity.access_patient_with_pin(text, text, integer)` with `CREATE OR
REPLACE`. The signature, result, `SECURITY DEFINER` attribute, `search_path`,
owner and ACL are unchanged, and so is every statement but one.

The command keeps two failure windows (0033): one per staff member at a
facility (`identity.patient_access_pin_actor_limits`) and one per staff
member, facility and patient (`identity.patient_access_pin_target_limits`).
Five failures within 15 minutes lock a window for 15 minutes. Before 0079 a
correct PIN cleared both the verified patient's window and the actor window.
So a clinician who knew one patient's PIN could enter four wrong PINs for
another patient, enter the known PIN, and repeat without ever reaching the
actor lock; only the per-patient window of each target slowed the guessing.
Since 0079 a success clears only the window of the patient it verified. The
actor window runs out after 15 minutes or locks at five failures, as before.

An honest clinician who mistypes PINs for several patients within 15 minutes
now reaches the actor lock even if some PINs were right in between; the lock
lasts 15 minutes. A limit across all staff for one patient is not added here.

Tests: `services/ehr-api/database/tests/patient-access-pin.integration.sql`
(rollback-only, run by the migration rehearsal as `hid_identity_api_runtime`)
enters three wrong PINs for one patient, one wrong PIN and then the right PIN
for a second patient, and one more wrong PIN for the first. After the right
PIN it requires the second patient's window at 0, the first patient's still
at 3 and the actor's still at 4; at the end, the actor locked at 5, the first
patient's window at 4 and the known PIN refused. It fails without 0079 (the
success reset the actor window), and also if the success leaves its own
patient's window uncleared or clears another patient's.

## Pharmacy source prescription guards (0080)

`0080_pharmacy_source_prescription_guards.sql` replaces
`pharmacy.validate_work_item()` and `pharmacy.validate_dispensing()` with
`CREATE OR REPLACE`. The signature, `SECURITY DEFINER` attribute,
`search_path` (`pharmacy, platform, pg_temp`; `ehr.prescriptions` is
schema-qualified), volatility, owner, ACL, triggers and the 0077 checks and
messages are unchanged. Change: D-Eminence/hid-system#48.

Before 0080 neither guard read `ehr.prescriptions`, and
`pharmacy.work_items.source_ehr_prescription_id` has no foreign key. The EHR
checks eligibility in its own transaction, which commits before it calls
Pharmacy over HTTP, so a prescription cancelled in between was accepted; and
a work item stayed dispensable after the prescriber cancelled, marked entered
in error, put on hold, completed or edited its prescription. Each guard now
also reads the prescription as its owner, after the 0077 checks, with
`SELECT ... FOR SHARE`, and refuses with SQLSTATE `23514` and a constraint
name the Pharmacy API maps to `409` (`INTERFACE_CONTRACT.md` §13):

- `pharmacy_work_item_source_prescription` (acceptance): the prescription must
  exist and equal the snapshot exactly: patient, facility (the ordering
  facility), encounter, `row_version`, status `active`, medication code
  system, code and display, dose quantity and unit, route, frequency,
  instructions and `created_by` (`prescribed_by`), as Lab binds an EHR order
  (`lab.validate_work_item`, 0077). Message: `Pharmacy acceptance does not
  match the exact active EHR prescription version`.
- The acceptance does not compare `prescribed_at` with `created_at`, or
  `starts_on` and `ends_on` with the prescription's dates, yet; Pharmacy
  stores those three as sent, as before 0080. The migrations run before the
  EHR API is deployed and the EHR API may be rolled back (release checklist
  §6, §9). Every EHR build before D-Eminence/hid-system#48 sends
  `created_at` truncated to the millisecond, and the dates as node-postgres
  local-midnight `Date` values, a day early in a process east of UTC; an
  exact time term would refuse nearly every acceptance such a build sends,
  and exact date terms every dated one sent from a process east of UTC.
  Follow-up: add the three terms in a later migration, once the EHR rollback
  floor includes the exact handoff text below.
- `pharmacy_dispensing_source_prescription` (dispensing): the work item's
  prescription must exist, belong to the work item's patient, facility and
  encounter, and be `active` at `source_ehr_prescription_version`. Message:
  `The EHR prescription of this Pharmacy work item is not active at the
  accepted version`.
- The exact version is the current, fail-closed default: every EHR update
  moves `row_version` (0004), so a hold then resume, or an edit of
  frequency, instructions or end date, also makes the work item
  undispensable, and `unique(source_ehr_prescription_id)` stops a second
  acceptance. The lifecycle of accepted work after an EHR change is an open
  product question (release checklist §2).
- Reversals do not read the prescription: a dispensing can be reversed after
  a cancel.

Locks and races. The Pharmacy commands run `SERIALIZABLE` and take no other
row lock (ADR-042); the EHR's update locks the prescription (`FOR UPDATE`,
READ COMMITTED) and then writes `ehr.record_versions` and audit, never a
Pharmacy table. A cancel committed before the command's snapshot is read and
refused. A cancel in progress is waited for: if it commits, the share lock
fails with `40001` and the retried command reads it and is refused; if it
rolls back, the command proceeds. A cancel committed after the snapshot but
before the guard also fails the share lock with `40001` (a plain read would
have used the stale active version). `FOR KEY SHARE` would also conflict here,
but only because the EHR's update locks the row `FOR UPDATE` first; `FOR SHARE`
conflicts with any update of the row. A command that passed the guard first
holds its share lock until it commits, so the EHR's cancel waits for it
(milliseconds) and applies after the dispensing. Pharmacy can therefore delay
an EHR write: a Pharmacy transaction that stalls after the guard holds the
lock (its 15 s `statement_timeout` bounds a slow statement, not an idle
transaction, and no `idle_in_transaction_session_timeout` is set), and the
prescriber's cancel or hold waits up to the EHR's 15 s `statement_timeout` and
then fails with `500`. Lock order is prescription then Pharmacy rows on one
side and prescription then EHR rows on the other, so there is no cycle. The
EHR must not call Pharmacy while it holds the prescription lock: its
eligibility transaction commits before the HTTP call
(`prescriptions.service.spec.ts` asserts the order); otherwise the share lock
would wait for the call until a statement or client timeout.

Ownership. The guards read and lock the prescription as their owner; no
runtime role gains a privilege (`hid_pharmacy_runtime` still has none on
`ehr`). The owner of `ehr.prescriptions` has the `UPDATE` privilege a share
lock needs. Under an owner subject to row-level security (release checklist
P8) the lock applies the `prescriptions_read` and `prescriptions_update`
policies with the session's context, so the pharmacist needs a write consent
for the patient, which `pharmacy_dispensings_insert` and
`pharmacy_work_items_insert` already require; a prescription the owner cannot
lock reads as missing and is refused. The policies call `ehr.context_allows`,
which the single owner owns; the rehearsal's non-superuser owner owns it too,
so the owner probe needs no grant. A dedicated technical owner (ADR-041) would
need `USAGE` on `ehr`, `EXECUTE` on `ehr.context_allows`, column `SELECT` on
`id` and the compared columns, an `UPDATE` privilege for the lock, a
`TO`-role select policy and an `UPDATE` policy with a restrictive
`WITH CHECK (false)`.

EHR handoff text. The EHR now sends `created_at` at the microsecond and the
dates as dates: `PrescriptionsService.acceptForPharmacy` reads
`to_char(created_at at time zone 'UTC', ...)` (`timelineCursorSql`) and
`to_char(starts_on|ends_on, 'YYYY-MM-DD')` in its locking query instead of
sending node-postgres `Date` values (milliseconds; a date at local midnight,
the day before in a process east of UTC). The guard compares neither yet
(follow-up above). An earlier EHR build in a process east of UTC sends a
day-early date, which Pharmacy stores as it did before 0080. No service image
or deployment sets `TZ`, so the processes run in the container default, UTC.
No EHR schema change.

Tests (rollback-only, synthetic fixtures):

- `services/ehr-api/database/tests/pharmacy-source-prescription.integration.sql`:
  42 cases. As `hid_pharmacy_api_runtime` with the Pharmacy API's session and
  INSERT statements: the exact snapshot (prescribed at the microsecond), the
  same snapshot with the time truncated to the millisecond or the start date
  a day early (as earlier EHR builds send them) or the end date left out, and
  the current version of an edited prescription are accepted; a cancelled,
  missing or superseded prescription, another display, encounter or
  prescriber are refused; a dispensing is accepted for an active
  prescription and refused for one entered in error, on hold, completed,
  draft, at a later version, missing, of another patient, encounter or
  clinic, and after the prescriber's cancel, which runs as
  `hid_ehr_api_runtime` through `ehr.capture_record_version` (version 2);
  both refusals report their constraint names; a dispensing made before a
  cancel can still be reversed. Isolated cases (`session_replication_role =
  replica`, one guard `ENABLE ALWAYS`) show each guard refuses alone. It
  checks both guards' security properties and that each share-locks
  `ehr.prescriptions`, and probes whether the guards' owner can lock the
  prescriptions under pharmacist A's session (write consent; required) and
  pharmacist R's (read consent only): R's cases expect the guard's refusal
  under a P8 owner and the insert policy's `42501` under an owner that
  bypasses row-level security. Without 0080 its refusal cases are accepted
  and its two lock checks fail.
- `pharmacy-session-guards.integration.sql` and `schema.integration.sql`
  now accept and dispense real, exact prescriptions (the session-guard
  fixture had none; the schema suite's duplicate acceptance repeats the exact
  snapshot under another key, so it still reaches `unique_violation`).
- `services/pharmacy-api/scripts/verify-pharmacy-runtime.mjs` (HTTP, as
  `hid_pharmacy_api_runtime`): acceptances use real prescriptions with their
  microsecond time; a missing prescription and one cancelled after the
  EHR's check answer `409 PHARMACY_PRESCRIPTION_NOT_ELIGIBLE`, and the
  millisecond time and the day-early start date of an earlier EHR build are
  accepted (`201`); a dispense after a cancel, racing
  a cancel that commits after its snapshot (one retry), or waiting on a
  cancel in progress that commits answers
  `409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` with nothing written; a cancel
  that rolls back lets it through; a dispense in progress makes the EHR's row
  lock fail with `55P03`; replays and reversals of earlier dispensings still
  answer `201`.

## Uniform recovery start cooldown (0081) and recovery code budget

`0081_uniform_recovery_start_cooldown.sql` adds `auth.otp_start_cooldowns`:
one row per recovery purpose (`PASSWORD_RESET`, `LEGACY_ACCOUNT_RECOVERY`,
`LEGACY_SESSION_FALLBACK`) and `identifier_hmac`, a keyed HMAC of the purpose
and the case-folded email address or HID (lower-case hex, 64 characters), with
the `challenge_id` the last start answered and its `started_at`. The key is
`(purpose, identifier_hmac)`. There is no foreign key: the row exists whether
or not the identifier has an account, and its challenge id may name no
challenge. It holds no identifier, authorizes nothing and has no row-level
security, as `auth.otp_challenges` and `auth.otp_rate_limits` have none. The
role bootstrap grants `SELECT`, `INSERT` and `UPDATE` to `hid_identity_runtime`
and `hid_schema_test_runtime`; no runtime may delete rows. There is no
retention job: each identifier keeps one row per purpose, overwritten by its
next start, so the table grows with the number of distinct identifiers ever
started, as `auth.otp_rate_limits` grows with its buckets.

Before 0081 the resend cooldown of `POST /auth/otp/start` was read only from
the account's open row in `auth.otp_challenges`. Within
`OTP_RESEND_COOLDOWN_SECONDS` a repeat for a real account was answered with
the live challenge id and one for an unknown identifier with a new random id,
so two requests told whether an address or HID had an account. The marker
cannot live in `auth.otp_challenges`: `otp_challenges_active_recipient_purpose_uq`
(0028) would refuse a later real challenge for the same address.

The Identity API (`otp.service.ts`), in the start transaction, after the three
rate-limit counts (whose recipient bucket lock already serializes the starts
of one identifier):

1. reads the row; if `started_at` is within the cooldown by
   `clock_timestamp()`, answers its `challenge_id` and sends nothing;
2. otherwise upserts the row with the new candidate id;
3. reads the account's open challenge of the purpose `FOR UPDATE`, as before,
   with its cooldown also computed by `clock_timestamp()`;
4. answers an unknown identifier, an account without a usable recipient, an
   account whose code budget is spent, or an open challenge still cooling that
   this identifier did not start (the account's other identifier did) with the
   new id, sending nothing. The identifier's own challenge, written just after
   its row, does not hold back its retry once its own cooldown has ended;
5. otherwise replaces the open challenge and sends a code, after the response.

A challenge whose delivery failed definitively keeps its id until the cooldown
ends. The cooldown read takes no row lock. The upsert locks only that
identifier's cooldown row until commit, after the three rate-limit transaction
locks and before the challenge row lock; the recipient bucket's lock already
serializes the starts of one identifier, so no new cycle forms.

The recovery code budget needs no schema change. Each wrong code also counts
in `auth.otp_rate_limits`, scope `account`, bucket
`hmac('otp-verify-failure', account_id)`, apart from the start bucket
`hmac('account', account_id)`. The `OTP_VERIFY_FAILURE_MAX`-th wrong code (5
by default) within `OTP_VERIFY_FAILURE_WINDOW_SECONDS` (900) sets
`blocked_until` one window ahead, as the platform MFA budget does. While it is
set, verification refuses every code of the account, a correct one too, and
invalidates that challenge (`attempts_exhausted`); a start reads it without a
lock and sends nothing. Verification locks its challenge row, then takes the
bucket's transaction lock (`otp-rate:account:<bucket>`), and locks no other
challenge: start never takes that lock and `auth.complete_recovery_otp` never
touches the bucket, so no cycle forms. An unknown challenge id counts nothing.
No bucket is keyed by client IP.

Residual: verification work still differs. A wrong code for a live challenge
runs seven statements in its transaction (the challenge row lock, the bucket's
lock, the blocked read, the attempt count, and the bucket count's lock, read
and upsert), four once the budget blocks; a `challengeId` that names no live
challenge, as an unknown identifier's does, runs one. Before this change it was
two against one. Response time can therefore still suggest whether a start's
identifier has an account, as the start's few extra statements for a known
account can (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §2, "Residual"). Decoy
locks and reads would only narrow the gap; closing it would need decoy writes
for ids an attacker chooses.

Tests:
- `otp-recovery.integration.sql` (rollback-only) requires the table and its
  key, no foreign key, the upsert of one row per purpose and identifier and the
  refusal of an upper-case HMAC and of a non-recovery purpose (`23514`) as
  `hid_identity_api_runtime`, which may not delete (`42501`), and refuses
  `hid_ehr_api_runtime` any read. `runtime-roles.integration.sql` requires
  exactly those privileges for the Identity runtime, no `DELETE` or `TRUNCATE`
  through it, and no privilege at all for the twenty other runtime roles it
  requires (all but the schema-test runtime and the migration
  administrator).
- `verify-otp-recovery-runtime.mjs` runs the real service as
  `hid_identity_api_runtime`: five accepted concurrent starts for one unknown
  identifier answer one challenge id; four wrong codes on one challenge, then
  two wrong codes on two purposes of the account at once, both refused with
  `403`; a correct code of a third purpose refused; a start for the suspended
  account sends nothing; after the owner clears the block a new start sends a
  code that verifies. It waits for deliveries before ending its pool.
- `verify-patient-enrollment-runtime.mjs` repeats a start over HTTP for an
  unknown and a known identifier (same challenge id, no code) and starts the
  account's HID (a new id, no code).

## EHR clinical list paging precision (no migration)

The EHR API's six newest-first clinical lists page with a keyset on (sort key,
`id`) (`INTERFACE_CONTRACT.md` §11, "EHR clinical list paging"). The sort keys
are `timestamptz` columns from `0004_ehr_clinical_records.sql`, which keep
microseconds:

| Table | Sort key | Rows per list |
|---|---|---|
| `ehr.encounters` | `started_at`, as the client sends it (no default) | one patient, one facility |
| `ehr.clinical_notes`, `ehr.diagnoses`, `ehr.lab_requests`, `ehr.prescriptions` | `created_at`, `default clock_timestamp()` | one encounter, patient and facility |
| `ehr.vitals` | `recorded_at`, as the client sends it (no default) | one encounter, patient and facility |

- Each list reads `limit + 1` rows ordered by the key and `id`, both
  descending, with the predicate
  `($n::timestamptz is null or (key, id) < ($n::timestamptz, $m::uuid))`.
  The first page binds both parameters to null; later pages bind them from
  the cursor.
- node-postgres returns a `timestamptz` as a JavaScript `Date`, which keeps
  only milliseconds, and the cursor was built from that `Date`. The bound
  therefore fell to the start of the last row's millisecond, and the next
  page left out the rows that sort after the last row within that
  millisecond: those earlier in it, and those at the same instant with a
  lower `id` (for example, `.123400` after a last row at `.123456`). Only a
  row exactly at the start of the millisecond with a lower `id` than the last
  row still passed. The rows left out were never listed; rows created in bulk
  or by import are the likely case.
- Each list now also selects
  `to_char(key at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"`,
  and the cursor carries that text, never the `Date`
  (`services/ehr-api/src/ehr/shared/clinical-context.ts`). `timestamptz` has
  microsecond resolution, so the text is exact. It is rendered in UTC and ends
  in `Z`, so neither the rendering nor the cast back to `timestamptz` for the
  next page depends on the session time zone. `YYYY` has four digits up to
  year 9999 and five or six after it, up to 294276, the last year a
  `timestamptz` holds. `started_at` and `recorded_at` take any instant the
  client sends, so the cursor accepts those years too: a list whose page ends
  on such a row still issues its next cursor.
- The predicates, order, parameters, tables, indexes and grants are
  unchanged; there is no migration. Of the 0004 indexes,
  `encounters_patient_timeline_idx (patient_id, started_at desc)`,
  `clinical_notes_encounter_idx (encounter_id, created_at desc)` and
  `vitals_encounter_time_idx (encounter_id, recorded_at desc)` follow their
  list's scope and sort key, without `id`. Diagnoses, lab requests and
  prescriptions have no index on `encounter_id`. Besides the primary key and
  `unique (id, patient_id, facility_id)`, their indexes are
  `diagnoses_patient_status_idx (patient_id, clinical_status, created_at desc)`,
  `diagnoses_code_idx (code_system, code)`,
  `lab_requests_patient_status_idx (patient_id, status, created_at desc)`,
  `lab_requests_facility_queue_idx (facility_id, priority, created_at) where status = 'active'`
  and `prescriptions_patient_status_idx (patient_id, status, created_at desc)`.
- `ehr-timeline-cursor.integration.sql` (rollback-only, synthetic fixtures)
  checks:
  - that the text form of seven instants (including `0001-01-01`, a leap
    day, `9999-12-31 23:00:00-05:00`, which is year 10000 in UTC, and
    `294276-12-31 23:59:59.999999+00`) has the cursor's form, with six
    fraction digits, and casts back to the same instant under the session
    time zones UTC, Africa/Lagos, America/Los_Angeles and Asia/Kolkata;
  - with five clinical notes, three of them within one millisecond, the
    clinical-notes list predicate and order: after the microsecond cursor the
    next page holds the two `.123400` rows (higher `id` first) and the
    `.122999` row; after the millisecond bound the earlier cursor carried, only
    the `.122999` row.
- The fixtures are inserted with `session_replication_role = replica` (no
  foreign-key checks; `CHECK` constraints still apply). The suite runs as the
  connecting administrator, not as `hid_ehr_api_runtime`, so it does not
  exercise row-level security. The rehearsal runs it with the other additional
  suites (`TUF-STAGING-MIGRATION.md`), and
  `scripts/run-container-database-acceptance.sh` runs it after
  `staff-access-request-outcome.integration.sql`.

## Record summary reads (no migration)

The EHR API's two record summaries (`INTERFACE_CONTRACT.md` §11, "Record
summaries") read under row-level security as `hid_ehr_api_runtime`. Nothing in
the schema, policies or grants changes.

- **Patient summary** (`GET /ehr/me/records`). The patient transaction sets
  `app.purpose_of_use = 'patient-self'` and empty facility and membership, so
  the staff policies (`ehr.context_allows`) never pass, and only the 0030
  patient-self policies release rows: completed encounters, signed or amended
  notes and their current revisions (since 0084 only those of completed
  encounters; "EHR clinical safety and launch module set (0084)"). The other clinical tables have `SELECT`
  but no patient-self policy, so a patient read of them returns no rows and no
  error. The service now reads only the two released categories and names the
  other five as withheld; before, it read all seven and returned five arrays
  that were always empty.
- **Emergency summary** (`GET /ehr/patients/:id/emergency-records`). A
  break-glass emergency context passes `ehr.context_allows` for `read_records`
  at its facility (0012), so every clinical table is readable there.
  - Vitals: read from `ehr.vitals` alone, as first recorded (the row's eight
    measurement columns), the same columns as before; corrections are not
    applied. Applying them is pending the product decision on correction
    semantics (proposed default: the current correction's replacement set is
    the whole current set, as Health-id's clinician chart applies it); the
    implementation is preserved in commit `7401193` for when the decision
    lands. No EHR API route updates the measurement columns (a correction
    updates only `current_correction_no`). Until 0084 the database did not
    refuse it either: `hid_ehr_runtime` holds `UPDATE` on `ehr.vitals`
    (`runtime-grants.sql`), `vitals_update` allows it under `write_records`
    (0005), and `ehr.capture_record_version` (0004) guards only the ownership
    and attribution columns. Since 0084 `ehr.keep_recorded_vital()` refuses
    every update of a vital except of `current_correction_no`. Since 0090 a
    vital can also be marked entered in error, and the summary leaves out a
    vital entered in error (`status = 'final'`; "EHR retraction integrity
    (0090)").
  - Documents: read from `ehr.documents_effective` (0009, `security_invoker`,
    `security_barrier`) where `status = 'available'`, so `documents_read` and
    `document_scan_events_staff_read` apply to the view's reads. The raw
    `ehr.documents.status = 'uploaded'` filter used before also listed
    documents never scanned and those the scanner rejected.
  - Each section reads one row more than it shows, to report truncation.
- `emergency.integration.sql` (rollback-only) adds, after its activation cases,
  a break-glass grant inserted directly and document fixtures inserted with
  `session_replication_role = replica`, then checks as `hid_ehr_api_runtime`
  with the emergency context: `documents_effective` reports `available:clean`,
  `rejected:rejected` and `uploaded:pending` for a clean, a rejected and an
  unscanned upload, and lists only the clean one as available, while the raw
  `uploaded` filter lists all three; and with `direct-care` and no consent
  nothing is visible. These
  cases pass before and after the service change: they guard the database
  behaviour the summary relies on. The rehearsal runs the suite with its
  additional suites, and `scripts/run-container-database-acceptance.sh` now
  runs it after `emergency-contacts.integration.sql` (before, only the
  rehearsal did). The service's own SQL is exercised against the database by
  `verify-delegated-cookie-read-runtime.mjs` (steps 4 to 6).

## Purpose-of-use vocabulary (0082)

`0082_purpose_of_use_vocabulary.sql` inserts one row into
`identity.purpose_of_use_codes`: `direct-care` ("Direct patient care",
active, `source_system` `hid`), with `ON CONFLICT (code) DO NOTHING`
(D-Eminence/hid-system#58).

0003 created the table empty, and nothing inserted a row: no migration, no
role bootstrap (`runtime-grants.sql` gives the Identity runtime `SELECT`
only) and no legacy importer (it holds every imported request and grant
with `purpose_of_use` null and a migration hold). Yet every consent decision
requires an active code:

- `identity.has_active_consent_grant` (0012) returns false, so Identity's
  authorization check, and with it patient lookup by HID and every EHR, Lab,
  Pharmacy and OCR patient access, is denied;
- `identity.create_access_request` and `identity.close_own_consent_grant`
  (0010) and `identity.activate_break_glass` (0031) raise `22023`, which
  Identity answers `400 INVALID_CONSENT_COMMAND` (break-glass only while
  `break_glass_enabled` is on; Identity checks the control first);
- `identity.access_patient_with_pin` (0033, 0079) raises `22023`, answered
  `403 PATIENT_PIN_ACCESS_DENIED`;
- the `purpose_of_use` foreign keys of `identity.access_requests` and
  `identity.consent_grants` (0008) refuse the row, and the consent directive
  trigger (0008) refuses an unknown or inactive purpose (`23514`).

On a database built only from migrations every staff consent check therefore
failed closed. The rollback-only suites and the runtime verifiers insert the
codes they need themselves, so none of them showed it. Whether staging or
production already hold rows inserted by hand cannot be told from the
repository; the release checklist's P10 records them before and after 0082.

**Current default, pending product decisions:** only `direct-care` is seeded.

- `emergency` is not seeded. Break-glass needs it (0010, 0031), and
  `has_active_consent_grant` honours an emergency read only while it is
  active. Seeding it would make break-glass usable at once wherever
  `platform.control_settings` `break_glass_enabled` is on, which is its 0039
  default. Until it is approved and inserted, break-glass answers `423
  BREAK_GLASS_DISABLED` when the control is off and, since the change that
  added 0084, also when it is on: Identity answers the function's
  emergency-purpose refusal (`22023`) as `423 BREAK_GLASS_DISABLED` instead of
  `400 INVALID_CONSENT_COMMAND`. Break-glass is off at launch (owner default, deny by default): the
  control is set false and no `emergency` row exists (release checklist P10
  and P11).
- `healthcare-operations` is not seeded. Identity access requests
  (`consent.controller.ts`), Lab and Pharmacy reads and the OCR commands
  accept it as a purpose, and it belongs to the open OCR purpose-of-use
  decision (which purpose and scope OCR create, retry, validate and confirm
  need); a patient also approves a request without seeing its purpose. Until
  it is decided, requests, grants and reads for that purpose are refused.
  Enrollment, onboarding and registration commands compare the session
  purpose with the text `healthcare-operations` and never read the table, so
  they are unaffected.

The `active` flag is the switch. An operator retires a code by setting
`active = false`, never by deleting it (grants and requests reference it
`ON DELETE RESTRICT`); deactivating `direct-care` refuses every direct-care
grant, request, close and PIN at once. `ON CONFLICT DO NOTHING` keeps a row
inserted or deactivated before 0082 exactly as it is, display and source
included. The service runtime roles only read the table
(`hid_schema_test_runtime` may also insert and update, for the suites), so a
new code is a reviewed change by the migration administrator or a later
migration. The insert takes a `ROW EXCLUSIVE` lock on
`identity.purpose_of_use_codes`; no table is scanned and no grant or service
changes.

Tests:

- `purpose-of-use-vocabulary.integration.sql` (rollback-only; it inserts no
  purpose code) requires an active `direct-care` row. Then, as
  `hid_identity_api_runtime`: the runtime can read the vocabulary but not
  insert, update or delete it; a direct-care `write_records` grant is
  honoured for reads and writes; a direct-care access request is accepted
  (`pending`). After the owner deactivates `direct-care` in the transaction,
  the grant is refused for both actions and a new request is refused with
  `22023 Invalid purpose for a standard access request`. Without 0082 it
  fails at its first assertion ("the migrated purpose-of-use vocabulary has
  no active direct-care code"). The rehearsal runs it with the additional
  suites, under the migration owner, the non-superuser owner and on the
  restored database, and `scripts/run-container-database-acceptance.sh` runs
  it after `runtime-command-privileges.integration.sql`.
- The rehearsal's 0028 upgrade check counts `identity.purpose_of_use_codes`
  among the tables the upgrade may change, and requires exactly one row after
  the upgrade: `direct-care`, active, `source_system` `hid`.
- `schema.integration.sql` and `emergency.integration.sql` insert their three
  codes with `ON CONFLICT (code) DO NOTHING`, as every other suite and
  verifier already did, so they pass on a database where 0082 seeded
  `direct-care`.

## Non-superuser database chain on RDS (0083)

On Amazon RDS for PostgreSQL 16 no role is a superuser. The migration
administrator is a `NOSUPERUSER NOBYPASSRLS CREATEROLE` LOGIN that owns the
schema (`MIGRATION_RUNBOOK.md` §6), and nothing relies on that owner bypassing
row-level security (D-Eminence/hid-system#63). As such a role,
verified locally on PostgreSQL 16.15, four things failed.

**0015 and the OCR claim (0083).** 0015 gave `ocr.claim_worker_job(text,
integer)` the clause `SET plpgsql.variable_conflict = 'use_column'`.
`plpgsql.variable_conflict` has superuser context, so a non-superuser may set
it, in `ALTER FUNCTION` and on every call of a function that carries it, only
with `SET ON PARAMETER` on it. A fresh chain therefore stopped at 0015, and
with the privilege granted every claim kept needing it, because the definer
applies its settings as its owner on entry; after a revoke each claim failed
with `permission denied to set parameter`.
`0083_ocr_claim_in_body_variable_conflict.sql` replaces the function with the
same signature, result columns, `SECURITY DEFINER`, `search_path` and body,
and `#variable_conflict use_column` as the first line of the body. The
compiler option resolves the same unqualified names to columns (for example
`provider` in the stale-lease query), as 0064 to 0066 already do.
`CREATE OR REPLACE` keeps the owner, the `EXECUTE` grants and the comment and
leaves `proconfig` with the `search_path` alone. A catalogue scan finds no
other application function that sets a parameter which is not user-settable
(`audit.list_platform_events` sets `plan_cache_mode`, which any role may set).
0015 is unchanged, so the privilege is still needed while it applies, and only
then; the operator grants it for the migration run and revokes it after 0083.
No table lock, grant or data change.

**The role bootstrap.** `runtime-grants.sql` re-asserted `NOSUPERUSER …
NOBYPASSRLS` with `ALTER ROLE` on every run. PostgreSQL 16 lets only a
superuser change `SUPERUSER`, and only a role holding `BYPASSRLS` change that
attribute, even to its current value, so the file stopped there and rolled
back. It now:

- creates each of the 25 group roles with its attributes, as before, then
  checks them: a role with `SUPERUSER`, `BYPASSRLS` or `REPLICATION` is
  refused, and `LOGIN`, `CREATEDB`, `CREATEROLE` and `INHERIT` are corrected
  only when they differ, so a run that changes nothing issues no
  `ALTER ROLE`;
- refuses a runner that is neither a superuser nor holds `ADMIN OPTION` on
  every role (every membership grant needs it), and empties
  `createrole_self_grant` for its session;
- grants the runner `INHERIT` and `SET` membership in
  `hid_event_delivery_commands`, `hid_ocr_queue_metrics` and
  `hid_platform_control_reader` right after the role check, because a
  non-superuser may give a function to a role only if it may `SET ROLE` to it,
  and may grant or revoke on a function it does not own only with the owner's
  privileges (the `REVOKE ALL` statements of a rerun included);
- grants each technical role `CREATE` on `integration`, `ocr` or `platform`
  only around its `ALTER FUNCTION … OWNER TO`, which a non-superuser transfer
  requires of the new owner;
- revokes the memberships at its end and refuses the run if a membership or
  `CREATE` is left. The file runs as one transaction, so neither is visible
  to another session;
- sets up the platform control owner below before any statement that locks
  a table, and recreates its policy only when it is missing or differs.
  `CREATE POLICY` locks the table `ACCESS EXCLUSIVE` until the bootstrap
  commits, and an Identity break-glass activation reads the controls and then
  inserts into `identity.outbox_events` in one transaction. The run that
  creates the policy therefore locks `platform.control_settings` before the
  `ocr.jobs` and outbox policies, in the activation's order, so the two wait
  for each other instead of deadlocking; until it commits, the guards' control
  reads wait behind it, within the services' 15 s statement timeout. A later
  run takes no lock on that table.

A superuser run grants exactly what it did before, plus the new role below;
a catalogue diff of the two bootstraps on the same 0082 schema shows nothing
else. PostgreSQL 16 records an `ADMIN OPTION`-only membership, granted by the
bootstrap superuser, of a non-superuser creator in each role it creates. It
carries no privilege and no `SET ROLE`, and its holder cannot revoke it.
`runtime-roles.integration.sql` allows that row on a technical owner only
when its member is the `CREATEROLE` role running the assertions (the
administrator, in both `db:bootstrap` and `db:verify-roles`), and refuses any
other member, membership or schema `CREATE`. A superuser records its grants
with the same grantor, so without that condition an `ADMIN OPTION`-only grant
to a runtime role would pass, and with it that role's login could grant
itself the technical owner and `SET ROLE` to it.

**Platform controls.** `platform.control_enabled(text)` (0040) is the
`SECURITY DEFINER` read that the Identity, EHR and Outreach guards make on
every request that is not a platform administrator's.
`platform.control_settings` forces row-level security, and its only read
policy requires `platform.control.read`, so under an owner without
`BYPASSRLS` the function saw no row and raised `PLATFORM_CONTROL_UNAVAILABLE`,
which the guards answer with `503`. The bootstrap gives it a technical owner,
`hid_platform_control_reader` (`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
NOINHERIT NOBYPASSRLS`, never granted to any role), following
`hid_ocr_queue_metrics`:

- `SELECT (control_key, enabled)` on `platform.control_settings`, and the
  policy `platform_controls_definer_read`, `FOR SELECT TO
  hid_platform_control_reader USING (true)`. The six controls are
  platform-wide booleans with no PHI, so reading all of them is the
  function's purpose;
- `USAGE` on `platform` and on `auth`, and no privilege on any `auth` object.
  The table's PUBLIC read policy applies to this role too, and PostgreSQL
  inlines its SQL function `platform.current_account_id()` while planning, as
  the reading role; that body names `auth`. The policies are OR-ed, so the
  `true` policy decides the row and the PUBLIC expression is folded away
  without running;
- `EXECUTE` stays with PUBLIC (0040). `platform.require_control_enabled`
  reads no table and calls `control_enabled`, so its owner is unchanged.

A later migration that replaces a function owned by a technical role needs
that owner's privileges, as the bootstrap's transfers do (`MIGRATION_RUNBOOK.md`
§6.2). The OCR, document-scanner and Outreach definer paths of the release
checklist's P8 still need an owner that bypasses row-level security, or the
technical owners proposed in ADR-041.

**Runtime LOGINs.** `db:verify-roles` checks only the NOLOGIN group roles.
`npm run db:verify-logins` (`scripts/verify-runtime-logins.mjs`) connects with
each of the ten runtime credentials' own URL and runs
`database/runtime-login-assertions.sql` on that connection: the login runs as
itself, is not the RDS master or the migration administrator, has no
`SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB` or `REPLICATION`, is a
direct member of its aggregate only (inherited, without `ADMIN OPTION`) and
reaches no role its aggregate does not, has the privileges of no owner of the
database or of an application schema, relation or function, is named by no
direct grant and may create nothing; two credentials may not share a login.
An owner skips the policies of every table that does not force them, among
them `identity.patients`, `patient_identifiers` and the consent tables (0005),
so a secret holding the migration URL would otherwise read them unfiltered.

In production, each service that connects to the database (the six APIs, the
OCR worker, the event dispatcher and the notification worker; the EHR scanner
pool too) refuses to start when `current_user` or `session_user` is a
superuser, bypasses row-level security or has the privileges of the owner of
any application schema, relation or function (`runtime-role-guard.ts`).

Tests:

- `function-parameter-settings.integration.sql` refuses any application
  function whose `SET` names a parameter that is not user-settable, and
  requires the claim's signature, result, `search_path`-only settings and
  in-body option. Without 0083 it fails: "ocr.claim_worker_job(text,integer)
  sets plpgsql.variable_conflict".
- `platform-control-owner.integration.sql` requires the technical owner
  (`NOLOGIN`, no `SUPERUSER` or `BYPASSRLS`) and, as `hid_identity_api_runtime`,
  `hid_ehr_api_runtime` and `hid_outreach_api_runtime` with no account, a
  non-administrator and an unknown subject, every control as a platform Super
  Admin lists it after changing one, the disabled refusal and the invalid-key
  refusal. Under a non-bypass owner without the bootstrap change the call
  raises `PLATFORM_CONTROL_UNAVAILABLE`.
- `runtime-roles.integration.sql` asserts the new role's attributes, owner,
  column grants, schema usage and single policy, no membership in the three
  technical owners except the running administrator's own `ADMIN
  OPTION`-only row, and no schema `CREATE` on them. The container acceptance
  checks on its superuser database that an `ADMIN OPTION`-only grant of
  `hid_ocr_queue_metrics` to `hid_ocr_worker` fails `db:verify-roles`.
- `ocr-worker-lease.integration.sql`: under a non-bypass owner, the claim of a
  provider whose only job the owner cannot see returns no row and changes
  nothing (0015's setting refused it before 0083).
- `scripts/verify-non-superuser-database.mjs`, run by the rehearsal, does the
  whole chain on its own disposable cluster as a `NOSUPERUSER NOBYPASSRLS
  CREATEROLE NOCREATEDB` administrator (`TUF-STAGING-MIGRATION.md`). Each of
  its two bootstrap runs overlaps a transaction that holds a lock on
  `platform.control_settings` and then locks `identity.outbox_events`: the
  first run must wait for the control table holding no application table
  lock, the second must not wait at all. It also requires `db:verify-roles`
  to refuse an `ADMIN OPTION`-only grant to a runtime role.
- The start-up check has a unit spec in each of the nine services, and
  `scripts/tests` checks `db:verify-logins`'s credential map and that the nine
  copies of the check are identical.

## EHR clinical safety and launch module set (0084)

`0084_ehr_clinical_safety_and_launch_modules.sql` (D-Eminence/hid-system#64)
changes no table, column or grant. It deletes rows of `auth.role_permissions`,
adds three trigger functions and eight triggers, and replaces two row-level
security policies.

**Launch module set (decision D17).** Lab, Pharmacy, OCR and Outreach are off
at launch; EHR prescriptions and lab requests are records only. The migration
deletes, for every role, the write permissions that EHR lab ordering, Lab and
Pharmacy need. The seeded holders were:

| Permission | Seeded holders |
|---|---|
| `ehr.lab-request.write` | doctor, clinician, lab (0006) |
| `lab.work-item.accept` | doctor, clinician, nurse, lab (0018) |
| `lab.accession.create` | lab (0019) |
| `pharmacy.work-item.accept` | pharmacist (0023) |
| `pharmacy.dispensing.create` | pharmacist (0023) |

No SQL function or policy checks these codes: Identity derives an actor's
permissions from `auth.role_permissions`, and the API guards refuse a route
whose permission is missing with `403 PERMISSION_DENIED` before any write or
call to Lab or Pharmacy. The read permissions (`ehr.lab-request.read`,
`lab.work-item.read`, `lab.accession.read`, `pharmacy.work-item.read`,
`pharmacy.dispensing.read` and the others) stay. `runtime-roles.integration.sql`,
which the role bootstrap runs, now fails if any role holds one of the five, or
if a seeded role lost one of those reads. The Lab, Pharmacy, OCR and EHR-to-Lab
runtime verifiers supply their actors' permissions through their own fake
Identity, so they keep exercising the module logic with these permissions.
Re-enabling a module takes a reviewed migration that grants them again, and
that migration must change the assertion.

The platform controls `outreach_portal_enabled`, `uploads_enabled` and
`break_glass_enabled` are not changed by the migration. A change through the
audited structure writes a `platform.control_events` row whose
`actor_account_id` is `NOT NULL` and references `auth.accounts`, and a
migration has no acting account; 0041 changed `maintenance_mode` without an
event, which this migration does not repeat. An operator sets the three to
false with `POST /admin/controls` before ingress (release checklist P11).

**Records follow their encounter (CLIN-EIE).** `ehr.require_open_encounter()`
is a `SECURITY INVOKER` trigger function with `search_path = pg_catalog,
pg_temp`. It fires `BEFORE INSERT` on `ehr.clinical_notes`, `ehr.vitals`,
`ehr.diagnoses` and `ehr.documents`, and `BEFORE INSERT OR UPDATE OF status` on
`ehr.prescriptions` and `ehr.lab_requests`. On an update it checks only an
order's activation (`status` becoming `active` from another status). A
document without an encounter is not checked. It reads the encounter, matched
on `(id, patient_id, facility_id)`, with `FOR SHARE`, and refuses with SQLSTATE
`55000` and message `ENCOUNTER_NOT_OPEN`:

- any of these records, and any activation, on a `cancelled` or
  `entered_in_error` encounter;
- a new prescription or lab request, and the activation of a draft one, on a
  `completed` encounter. Late notes, vitals, diagnoses and documents on a
  completed encounter stay allowed, and so does resuming an on-hold order.

An encounter the writer cannot lock reads as missing and is refused with
`42501` (`ENCOUNTER_NOT_AVAILABLE`): under row-level security `FOR SHARE`
needs both the encounter's `SELECT` and `UPDATE` policies, that is a
`write_records` consent, which the child row's own insert policy requires
anyway. `hid_ehr_runtime` already holds `UPDATE` on `ehr.encounters`; no
other role inserts these records (`hid_schema_test_runtime` also holds it).

The EHR's retraction of an encounter (`EncountersService.update`) holds the
encounter `FOR UPDATE` while it marks its records. A child create that holds
the share lock is waited for and then retracted with the rest; one that
comes later waits for the retraction and then sees the closed encounter.
Every path takes the encounter's lock before any lock on a record of it: the
services share-lock the encounter (`ehr/shared/encounter-status.ts`) before an
insert and before locking an order row for activation, so the trigger's own
share lock is then already held. A writer that locked an order row first and
then activated it would invert that order and can deadlock with a retraction
(PostgreSQL cancels one of the two, `40P01`). With a temporary service mutant
that locked the order row first, the lifecycle verifier's race produced
`40P01`; the committed verifier checks that the services' order produces
none.

**Diagnoses entered in error.** `ehr.keep_entered_in_error_diagnosis()`
(`SECURITY INVOKER`, `BEFORE UPDATE` on `ehr.diagnoses`) refuses any update of
a diagnosis whose `verification_status` is `entered_in_error` (`55000`
`DIAGNOSIS_ENTERED_IN_ERROR`).

**Recorded vitals (D8).** `ehr.keep_recorded_vital()` (`SECURITY INVOKER`,
`BEFORE UPDATE` on `ehr.vitals`) refuses an update that changes any column
other than `current_correction_no` (and `row_version` and `updated_at`, which
the version trigger maintains), with `55000` `VITAL_RECORD_IMMUTABLE`. A
correction is a row of `ehr.vital_corrections` and the current correction
number on the vital; the API never changed the recorded values in place. What
the emergency summary shows of a corrected vital is unchanged (as first
recorded, pending the correction-semantics decision).

Each trigger's name sorts before the table's `*_versioned` trigger, so a
refused write records no version. The three functions are not executable by
`PUBLIC` and take no privilege of their own.

**Patient release of notes (PREC-NOTES, D7).** The 0030 policies
`clinical_notes_patient_self_read` and `note_revisions_patient_self_read`
released a signed or amended note, and its current revision, whatever its
encounter's status, while `encounters_patient_self_read` released an
encounter only once completed; a signed note of a wrong-patient encounter
stayed visible to that patient after the encounter was cancelled or marked
entered in error. Both policies are dropped and recreated: each also requires
the note's encounter, matched on encounter, patient and facility, to be
`completed`. The subquery reads `ehr.encounters` under the patient session's
own policies, which release only completed encounters of that patient anyway.
The EHR service applies the same rule in its SQL (`patient-records.service.ts`).

**Existing rows are not changed.** The version trigger needs an acting
member, which a migration does not have, and open records of closed
encounters are a clinical review. The release checklist lists them (P12) for
review before and after the migration; until then they stay open. Open lab
requests among them are retracted before the migration, while
`ehr.lab-request.write` is still held: after it no role can change a lab
request's status, and their encounter, already closed, has no transition left
to cascade from. The guards apply from the migration's commit.

**Locks.** The `DELETE` takes `ROW EXCLUSIVE` on `auth.role_permissions`.
`CREATE TRIGGER` takes `SHARE ROW EXCLUSIVE` on each of the six clinical
tables for the catalog change, and `DROP POLICY` and `CREATE POLICY` take
`ACCESS EXCLUSIVE` on `ehr.clinical_notes` and `ehr.clinical_note_revisions`
for the catalog change; none scans a table. Each waits for the transactions
in flight on its table within the runner's 5 s `lock_timeout`.

Tests:

- `encounter-lifecycle.integration.sql` (rollback-only; in the rehearsal's
  additional suites and in `scripts/run-container-database-acceptance.sh`):
  the guards' security properties and triggers (12 cases), then 71 cases as
  `hid_ehr_api_runtime` with the EHR session: every record kind on an encounter
  in each of the six statuses, order activation and resumption by encounter
  status, the diagnosis and vital updates. Before 0084 it fails, listing each
  case whose write it expected refused but which succeeded.
- `patient-self.integration.sql`: signed notes of encounters in progress,
  cancelled, entered in error, and completed then entered in error are not
  visible to the patient, nor their revisions.
- `runtime-roles.integration.sql`: the launch module set assertions above.
- `verify-encounter-lifecycle-runtime.mjs` (in the rehearsal): the retraction
  cascade and cancellation over HTTP as `hid_ehr_api_runtime`, a retraction
  waiting for a child create that holds the encounter, and eight activations
  racing their encounter's retraction with no deadlock.
- `verify-delegated-cookie-read-runtime.mjs` (steps 7 and 8): the two summaries'
  note release, and `403 PERMISSION_DENIED` for the seeded doctor on the
  withdrawn write routes, with no row written.

## Public enrollment windows and NIN lookup quota (0085)

`0085_public_enrollment_windows_and_nin_lookup_quota.sql`
(D-Eminence/hid-system#68) implements decisions N2(b) and
N2(c) in the activation command and caps QoreID NIN lookups of public patient
enrollment (IP-1). It replaces two functions and adds one table and one
function; no existing table is changed.

**Activation windows.** `identity.activate_public_patient_enrollment`
(0058) is replaced with the same signature, result columns, `SECURITY
DEFINER` attribute, `search_path`, owner and grants. Two refusals are added;
the rest of the body is 0058's:

- a replay of an active enrollment whose `activated_at` is null or more than
  15 minutes old raises `P0002` (`no_data_found`)
  `PATIENT_ENROLLMENT_REPLAY_EXPIRED` and returns no HID. Identity answers it
  `404 ENROLLMENT_NOT_FOUND`; it also refuses such an enrollment itself on
  every enrollment route before calling the command, so the command's check
  matters only for a request that crosses the 15 minutes in flight;
- a first activation whose `contact_verified_at` is more than 30 minutes old
  raises `23514` (`check_violation`) `PATIENT_CONTACT_REVERIFY_REQUIRED`
  after the token check and before any write. Identity then clears the proof
  and sends the enrollment back to the contact step:
  `update identity.public_patient_enrollments set state='verify_contact'`,
  with `contact_channel`, `contact_hmac`, `contact_lookup_hmac`,
  `contact_ciphertext`, `contact_verified_at` and `verified_challenge_id`
  null, only where the row is still `set_password` and the proof is more than
  30 minutes old by `clock_timestamp()`. It does the same before calling the
  command when its own clock already finds the proof too old, and answers
  `409 ENROLLMENT_CONTACT_REVERIFY_REQUIRED` only when the update changed the
  row or the command refused. The 0051 checks allow that state
  (`set_password` exactly when `contact_verified_at` is set and
  `activated_at` is not). No grant changes: the Identity runtime already
  updates these rows.

Both windows use `clock_timestamp()`. The replay window is shorter than the
enrollment's `expires_at` (24 hours after start), which still bounds pending
enrollments and the prune.

**NIN lookup quota.** `platform.public_patient_nin_quota_counters` holds one
row per `(scope, scope_key, bucket_period, bucket_start)`:

- `scope` `network`: `scope_key` is a keyed HMAC of the client network
  (lower-case hex, 64 characters) that the Identity API computes with its
  server-only OTP HMAC key in its own domain (`patient-enrollment-qoreid-network`)
  over an IPv4 address or the /64 prefix of an IPv6 address (IPv4-mapped IPv6
  counts as IPv4; `quotaNetwork`, as for 0063); `bucket_period` `hour` or
  `day`;
- `scope` `platform`: `scope_key` `all`, `bucket_period` `day` only.

No NIN, raw address or provider payload is stored. Row-level security is
forced and its policies admit only the definer command's own reads and
writes, as in 0049 and 0063; no runtime role has a table privilege.
`platform.consume_public_patient_nin_quota(char, integer, integer, integer)`
takes the network digest and the hourly network, daily network and daily
platform limits that Identity reads from `PATIENT_ENROLLMENT_QOREID_*`
(defaults 5, 15 and 200). It:

1. refuses (`42501`) any caller but the accountless system context (actor
   `system:auth`, a correlation id, no account) and a malformed digest, and
   (`22023`) a missing limit or one outside its bounds: 1–100 an hour, from
   the hourly limit to 1,000 a day per network, and 1–100,000 a day in all;
2. deletes up to 100 counter rows whose bucket started more than 48 hours
   ago;
3. counts the lookup in the network's hour and day buckets and the platform's
   day bucket, in that order, each `INSERT ... ON CONFLICT DO UPDATE` only
   while the count is below its limit. The first bucket at its limit ends the
   charge, and leaving its subtransaction rolls back the increments already
   made, so a refusal changes no counter;
4. inserts one `audit.events` row (`identity.public-patient-enrollment.nin-lookup-quota`,
   actor `system`, resource `qoreid-lookup-quota`/`patient_nin`, outcome
   `success` or `denied`, details `operation`, `exhaustedLimit`
   (`network_hour`, `network_day` or `platform_day`, or null) and
   `networkDigest`), and returns whether the lookup may proceed. A refusal
   returns false instead of raising, so its audit event commits.

Buckets are calendar hours and days by `date_trunc` in the session time zone,
as in 0049 and 0063. The role bootstrap grants `EXECUTE` to
`hid_identity_runtime` and `hid_schema_test_runtime` only, and
`runtime-roles.integration.sql` asserts that no other required runtime role
can execute it or reach the counters. `platform.prune_verification_quotas()`
(0063) is replaced to drain these counters too, hourly, from the Identity
runtime.

Identity calls the command in `QoreIdPublicPatientIdentityProvider.verifyNin`,
after the enrollment gate and immediately before the QoreID request, in its
own system transaction. A resume, a duplicate and every earlier refusal of a
start never reach it. `false` is answered `429 VERIFICATION_QUOTA_EXCEEDED`;
any error, or no row, `503 VERIFICATION_QUOTA_UNAVAILABLE`, and QoreID is not
called. A denial's network digest is in the audit event; the address is not.

Locks: `CREATE OR REPLACE` takes no table lock; the new table and its index
lock nothing else. At run time the command locks only the counter rows it
increments, for the length of its own transaction; the activation command's
locking is unchanged.

Tests:

- `public-patient-enrollment-windows.integration.sql` (rollback-only, as
  `hid_identity_api_runtime`): a wrong token is still `42501`; a contact
  proved 31 minutes earlier is refused `23514
  PATIENT_CONTACT_REVERIFY_REQUIRED` and changes nothing; one proved 29
  minutes earlier activates and replays; a replay 14 minutes after activation
  returns the HID and one 16 minutes after is refused `P0002
  PATIENT_ENROLLMENT_REPLAY_EXPIRED`; the command keeps its signature,
  definer rights and grants. On 0082 it fails at "A contact proof 31 minutes
  old activated a patient".
- `public-patient-nin-quota.integration.sql` (rollback-only, as
  `hid_identity_api_runtime`): only the Identity runtime can execute the
  command and no runtime role can read the counters; with limits 2, 3 and 10
  a network's third lookup in an hour and its fourth in a day are refused and
  change no counter; with a platform cap of 5 another network is refused once
  the platform has 5, without a network row; malformed digests, missing or
  out-of-bounds limits, a missing correlation id and another actor are
  refused and write nothing; five successes and three denials
  (`network_hour`, `network_day`, `platform_day`) are audited exactly; the
  prune drains the counters. Without 0085 it fails at its first statement
  (the command does not exist).
- `runtime-roles.integration.sql` asserts the grant.
- `services/identity-api/scripts/verify-patient-enrollment-runtime.mjs`
  checks both windows and the quota over HTTP (QoreID verification contract).
  The container acceptance runs both new suites after
  `purpose-of-use-vocabulary.integration.sql`, and the rehearsal runs them
  with the additional suites.

## Account recovery and patient search hardening (0086)

`0086_recovery_and_patient_search_hardening.sql` closes the database part of
launch blockers REC-GOOGLE, REC-AUDIENCE, REC-NOTIFY and PSEARCH-1 (change
D-Eminence/hid-system#69). 0001 through 0085 are unchanged.

**Recovery.** `auth.complete_recovery_otp` (0029) is replaced with `CREATE OR
REPLACE`, so it keeps its owner and ACL; its signature, result, `SECURITY
DEFINER` and `search_path` are restated as in 0029. After it revokes the
account's sessions it now sets every external sign-in identity of the account
(`auth.external_identities` rows whose issuer is not `legacy-identity` and
whose status is not `revoked`, active or disabled) to `revoked`, with
`revoked_at` kept if already set, and its `auth.otp.recovery.completed` audit
event adds `details.external_identities_revoked`, the count. Today the only
sign-in issuer is Google (`https://accounts.google.com`). The legacy
importer's provenance record (issuer `legacy-identity`,
`promote-legacy-identity.mjs`) is not a sign-in: it is kept and not counted,
so legacy reconciliation still matches it after a recovery. Before, a Google
link made by whoever once held the password survived the owner's reset, and
Google sign-in issues a session at the current token version. An audit failure
rolls the revocation back with the rest of the completion. The revoked row
stays, and the Google link commands (0059) refuse any subject that was ever
linked (`GOOGLE_IDENTITY_ALREADY_LINKED`), so the owner cannot link the same
Google account again after a recovery, only a different one; re-linking needs
a later change before Google sign-in is enabled.

`auth.recovery_account_audience(account_id uuid, audience text) returns
boolean` (stable, `SECURITY DEFINER`, pinned `search_path`) tells Identity's
recovery start whether an account is of the kind its page reaches: `patient`
(an active `identity.patients` row of the account), `staff` (an active
`identity.staff` row) or `platform` (an unrevoked platform-scoped assignment
of an active role that grants the active `platform.admin.access` permission).
It requires the `system:auth` actor (`42501` otherwise), refuses any other
audience (`22023`) and answers false for a null account. The start runs it in
its system transaction with the account lookup; a mismatch, or a patient whose
email is not verified and who has no verified enrollment phone, is answered and
counted as an unknown identifier. Staff and platform accounts carry no
`email_verified_at` (their email is provisioned), so the verified-contact rule
reads it only for the patient audience.

`otp_challenges_account_consumed_idx` on `auth.otp_challenges (account_id,
consumed_at desc) where consumed_at is not null` serves the 24-hour hold
Identity applies after any consumed recovery challenge of the account (access
PIN set, emergency-contact add and update, new access approvals; `403
PATIENT_RECENT_RECOVERY_HOLD`). The hold reads the table and writes nothing.
The index is built inside the migration transaction under a `SHARE` lock on
`auth.otp_challenges`, held to commit, which blocks recovery starts,
verifications and completions; the table holds one row per recovery
challenge.

**Staff search budgets.** `otp_rate_limits_scope_check` is dropped and re-added
with four more scopes: `patient_lookup_actor`, `patient_lookup_facility`,
`access_request_actor` and `access_request_facility`. Identity counts every
access-request creation there before the command runs, and every refused
patient lookup after its audit event (bucket: SHA-256 of a labelled actor
account or facility id); a lookup reads its two buckets first and is refused
while either is blocked, and one that returns a granted patient is not counted
(FE-10). Re-adding the
check validates the existing rows under an `ACCESS EXCLUSIVE` lock on
`auth.otp_rate_limits`; every existing scope stays allowed.

**Registration reads (PSEARCH-1, ENUM-1, DB-RLS-PATIENTS).** Before 0086 the
policy `patients_registration_read` (0011) admitted a membership holding
`identity.registration.write` or `identity.registration.approve` at its
current facility to every `identity.patients` row, of every facility. 0086
drops the policy and creates it again in the same transaction, with the same
name, table, command (`SELECT`) and role (`PUBLIC`), so no other session sees
it absent. (`ALTER POLICY` would do the same, but the static privilege replay
`scripts/verify-runtime-locking-privileges.mjs` does not follow that form.)
The new expression keeps the permission check and adds that the row is the
resolved patient of a registration case at the current facility, a duplicate
candidate a case at the current facility lists, or the patient an approve-new
review is creating in its transaction
(`source_system` `hid-nin-registration`, no account, and a
`pending_new_identity_approval` case at the facility with the same
demographics and no resolved patient yet). The other `identity.patients`
policies are unchanged. Registration reads what it no longer sees through two
narrow `SECURITY DEFINER` functions that check the same permissions (`42501`
otherwise):

- `identity.registration_nin_holder(lookup_hmac text) returns table
  (patient_id uuid, hid_code text, patient_status text)`: the patient holding
  a verified, unrevoked NIN identifier with that lookup HMAC (lower-case hex,
  64 characters, else `22023`), at most one row. Duplicate checks before
  approve-new and link-existing, and the resolve step, use it.
- `identity.registration_candidates(dob date, first_name text, last_name text)
  returns table (patient_id uuid, first_name text, last_name text, full_name
  text, dob date)`: at most 100 active patients sharing the date of birth or
  either name (case-insensitive), oldest first; Identity scores them as
  before.

`identity.patient_lookup_audit_subject(hid text) returns uuid` (requires
`identity.patient.read` at the current facility) names, for the audit event
only, the active patient a refused staff lookup was about; the API answers
every refusal `404 PATIENT_NOT_AVAILABLE`.

`identity.create_access_request` (0010) is replaced with `CREATE OR REPLACE`
(signature, result, `SECURITY DEFINER` and `search_path` restated as in 0010).
For an HID that names no active patient it no longer raises `P0002`: it
returns a row with a new random request id, no patient, status `pending`, the
requested duration, the current time and `existing_request` false, persists no
request, and appends `identity.access-request.refused` (`denied`, no patient,
resource id the returned request id, details scope, duration and `reason`
`patient_not_available`; the HID is not copied into the event). Every other
check and result is as in 0010. Identity no longer returns the patient id of a
created request.

`identity.list_my_staff_access_requests` (0074) is replaced with `CREATE OR
REPLACE` (argument, result, caller checks, filter, order and limit restated
as in 0074; owner and ACL kept). Its `patient_id` is now the request's
patient only while the grant made from the request is active
(`effective_status` `active`), and NULL for every other request: pending,
denied, expired, closed and revoked. Before, one request for a guessed HID
and one list call gave the clinician the patient id of any active patient
before the patient answered. Identity's projection of the list applies the
same rule.

**Locks.** In the order taken, each held to commit: `ACCESS EXCLUSIVE` on
`identity.patients` (the policy), which holds back every HID sign-in,
recovery start, registration read, patient lookup and access request until
commit; `ACCESS EXCLUSIVE` on `auth.otp_rate_limits` (the check); `SHARE` on
`auth.otp_challenges` (the index). The policy also takes `ACCESS SHARE` on
`identity.registration_cases` and `identity.registration_case_candidates`.
The other statements change functions only. An OTP start of the Identity
build serving during the migration reads `identity.patients`, then writes
`auth.otp_rate_limits` and `auth.otp_challenges`, the same order, so it and
the migration wait for each other without a cycle. With the index first (the
first version of this change) such a start deadlocked with the migration and
PostgreSQL cancelled the start; reproduced locally. An OTP completion writes
`auth.otp_challenges` and then reads `identity.patients` inside
`auth.complete_recovery_otp`, the opposite order, so a completion caught
between those two statements can still deadlock with the migration
(reproduced locally with a pause inserted between them). PostgreSQL then
cancels one of the two (`40P01`): that completion fails and the owner submits
it again while the verification is valid, or the migration rolls back whole
and `migrate` is run again. The runner's 5 s `lock_timeout` bounds every wait
(`55P03` also rolls it back whole).

The four new functions are revoked from `PUBLIC`; the role bootstrap
(`runtime-grants.sql`) grants `EXECUTE` on them to `hid_identity_runtime` and
`hid_schema_test_runtime` only. Run `db:bootstrap` and `db:verify-roles`
immediately after the migration, then deploy the Identity build of the same
change. An older Identity build still reads `identity.patients` directly for
registration duplicate checks and candidates; under the narrowed policy those
reads miss every patient not linked to a case at the facility, so the two must
be deployed together.

Rollback: the migration is forward-only. Restoring the old behaviour means a
later migration restoring the 0011 policy expression, the 0029, 0010 and
0074 function bodies and the old scope check (after deleting rows of the four new
scopes); the index and the new functions may stay. Do not restore the policy
without also returning to the previous Identity build.

Tests:

- `patient-search.integration.sql` (new, rollback-only) as
  `hid_identity_api_runtime`: a registration nurse at facility A reads only
  the patients linked to facility A's cases (resolved and candidate), not a
  patient with a grant only, a patient of facility B or an unlinked one, nor
  the unlinked patient's NIN identifier or that patient by exact HID; a doctor
  with registration and clinical roles reads facility A's linked patients and
  the one it holds a grant for, and at facility B only facility B's linked
  patient; a pharmacist reads none; the audit-subject function names an active patient and refuses a
  membership without `identity.patient.read`; the two registration functions
  answer for a registration member and refuse others; `create_access_request`
  for an unknown HID returns the uniform row and persists nothing, with one
  refused audit event that does not contain the HID; the four scopes are
  accepted; the EHR runtime may execute none of the new functions. Without
  0086 it fails at its first visibility assertion (the nurse reads all five
  fixture patients).
- `otp-recovery.integration.sql` adds: completion revokes the account's
  active and disabled Google links, and
  `auth.resolve_google_identity` finds nothing for it afterwards; the
  account's `legacy-identity` provenance record stays active; the audit
  event counts `2` (and `0` for an account without links); an audit failure
  rolls the revocation back; a staff reset ends staff and platform sessions;
  the audience matrix for patient, staff, platform,
  dual, inactive-staff and revoked-role accounts, `22023` and `42501`.
  Without 0086 it fails with "Recovery left an external identity (Google
  link) of the account usable"; with the first version of 0086, which
  revoked every external identity, with "Recovery revoked the legacy
  importer provenance record, which is not a sign-in".
- `staff-access-request-outcome.integration.sql` adds: the list names the
  patient for the two requests with an active grant and for no other
  (pending, denied, expired, revoked, closed). Without the 0086 list change
  it fails with "the list must name the patient of an active grant only".
- `runtime-roles.integration.sql` requires `EXECUTE` on the four functions
  for the Identity and schema-test runtimes and for no other runtime or
  `PUBLIC`.
- Runtime verifiers (`hid_identity_api_runtime`, real HTTP):
  `verify-otp-recovery-runtime.mjs` (Google link revoked by recovery and
  legacy provenance record kept,
  audience mismatch answered alike with no code, staff reset ends staff and
  platform sessions, unverified patient email gets no code until verified),
  `verify-patient-enrollment-runtime.mjs` (staff and administrator pages send
  a patient no code; five wrong passwords across the email and the HID lock
  the account), `verify-patient-safety-runtime.mjs` (recent sign-in and the
  recovery hold on approval, PIN and emergency contacts; the staff list
  names the patient of the active approval only, not of the pending or the
  revoked one),
  `verify-patient-search-runtime.mjs` (new: lookup `200`, one identical `404`
  for every refusal, whether row-level security hides the patient or the
  authorization check refuses one the caller can read, `400`, audit reasons,
  uniform access-request answer, `429`s for refusals only) and
  `verify-registration-review-runtime.mjs` (registration review, unchanged,
  passes under the narrowed policy).

## Governed workforce provisioning and one membership per facility (0087)

`0087_governed_workforce_provisioning.sql` implements launch decision D14
(workforce part) and N5 (ADR-049; D-Eminence/hid-system#70).

**One active membership per facility (N5).** A unique partial index,
`staff_memberships_one_active_per_facility_uq`, allows one active membership
per account and facility among rows with a facility and no
`migration_hold_reason`. Several roles at one facility are several
`auth.account_roles` rows on that one membership. Before building it the
migration takes a `SHARE ROW EXCLUSIVE` lock on
`identity.staff_facility_memberships` and counts duplicate pairs; if there
are any it raises `23505 MEMBERSHIP_DUPLICATES_FOUND` with a hint naming
operator plan I4 (`PHASE_3_LAUNCH_DECISIONS.md` §3) and changes nothing.
`staff_memberships_scoped_uq` (0002) is narrowed to active rows, so ended and
other inactive memberships stay as history and a clinician can be attached to
a facility again. Dropping and recreating it takes an `ACCESS EXCLUSIVE` lock
on the memberships table for as long as the small index build lasts.

**Permission.** `platform.workforce.manage`, granted to
`platform_super_admin` only, as 0069 did for the other high-risk platform
permissions. The facility-scoped `workforce.manage` (0006) still authorizes
nothing.

**Tables.** All three have row-level security enabled with no policy and no
runtime grant: only their SECURITY DEFINER commands read or write them.

- `identity.staff_credential_attestations` (append-only): the staff record,
  the attested roles (one to three of `doctor`, `clinician`, `nurse`), the
  credential reference, issuing authority, `verification_method`
  (`manual_review` only), evidence reference, `valid_until` (later than the
  recording and at most three years after it), the reviewer (never the
  target), reason and correlation id.
- `identity.workforce_memberships`: the lifecycle of memberships the
  workforce commands attach or end: `pending` (attached, inactive), `active`
  (activated by the first grant) and `ended`, with who and when for each step
  and a row version. Ended is terminal. A trigger,
  `staff_memberships_ended_guard`, refuses every update of an ended membership
  in `identity.staff_facility_memberships`, the schema owner's included, so an
  ended membership and the consent grants still bound to it can never become
  usable again.
- `identity.workforce_role_grants` (append-only): for each facility role the
  grant command created, the attestation it relied on and who granted it.

**Effective roles.** `auth.facility_role_is_effective(account_role_id)` is
false only for a role granted on an attestation that has lapsed. The Identity
staff context joins facility roles through it, and
`auth.membership_has_permission` (0010, same signature, owner and grants) now
calls it too. Roles granted by onboarding or the legacy promotion have no
attestation and are unaffected. The staff context lists as a membership's
roles the codes of exactly those effective, unrevoked assignments (with an
active `auth.roles` row), the rows its permissions come from; it no longer
reads `membership_role` and `app_role`. Those labels keep the role the
membership was activated with (`pending` until then) and are shown only in the
principals list.

**Commands.** Each is SECURITY DEFINER, executable by the Identity runtime
only, and checks, in order: `platform.workforce.manage` for the session's
account and a correlation id (`ADMIN_PERMISSION_DENIED`), its inputs
(`WORKFORCE_INVALID_COMMAND`), an active MFA factor (`ADMIN_MFA_REQUIRED`), a
step-up from the last five minutes on the session's platform session
(`ADMIN_STEP_UP_REQUIRED`), then its idempotency record
(`auth.admin_command_idempotency`, replay or `ADMIN_IDEMPOTENCY_CONFLICT`). It
locks the target's and the caller's account rows in id order before anything
else, as 0073 requires of every session revocation, and then locks the
membership or staff row it works on FOR NO KEY UPDATE. Those updates change no
key column (the keys are `id`, `account_id`, `staff_id` and `facility_id`), and
every insert that references the row through a foreign key (an approval's
consent grant, an access request) takes FOR KEY SHARE on it, which FOR NO KEY
UPDATE does not block. A FOR UPDATE lock there deadlocked: with an approval
that held its access request FOR UPDATE and then inserted the grant, while the
end held the membership and waited on that request; and with a staff
transaction that referenced the membership and then its own account, while
the end held the account and waited on the membership.

- `identity.admin_attach_workforce_member(facility, account, email,
  full_name, reason, key, digest)`: exactly one of an existing account, or an
  email and full name for a new one. The facility must be verified and active
  with an active organization (`WORKFORCE_FACILITY_NOT_VERIFIED`); the caller
  must have no active membership there (`WORKFORCE_FACILITY_CONFLICT`) and is
  not the target (`WORKFORCE_SELF_CHANGE_DENIED`). An existing account must
  have an active staff record and be `active` or `pending_reset`, not
  disabled and not a patient's own account (`WORKFORCE_ACCOUNT_INELIGIBLE`). A
  new account is created `pending_reset` with no password and subject
  `workforce:<id>`, with a `pending` staff record, unless the email is already
  used (`WORKFORCE_EMAIL_IN_USE`). An account with an active or pending
  membership at the facility is refused (`WORKFORCE_MEMBERSHIP_EXISTS`). The
  membership is inserted inactive, labelled `pending`, with a `pending`
  lifecycle row.
- `identity.admin_record_credential_attestation(account, staff_version,
  roles, credential_reference, issuing_authority, evidence_reference,
  valid_until, reason, key, digest)`: the staff record must be at the
  expected version (`ADMIN_VERSION_CONFLICT`), active, of an eligible
  account, and `pending`, `verified`, `approved` or `active`
  (`WORKFORCE_STAFF_INELIGIBLE`). The caller is the reviewer and cannot be the
  target. A `pending` staff record becomes `verified`; the staff row version
  increases either way.
- `identity.admin_change_workforce_role(membership, facility,
  membership_version, role, action, reason, key, digest)`: `grant` takes
  `doctor`, `clinician` or `nurse`; `revoke` also `lab` and `pharmacist`
  (`WORKFORCE_ROLE_NOT_GRANTABLE`). The membership must exist, belong to the
  named facility (`WORKFORCE_FACILITY_MISMATCH`), not be the caller's own, be
  at the expected version, not have ended (`WORKFORCE_MEMBERSHIP_ENDED`) and
  not be held (`WORKFORCE_MEMBERSHIP_HELD`). A grant also requires a verified
  facility, a caller with no active membership there, an active or pending
  membership (`WORKFORCE_MEMBERSHIP_INACTIVE` for any other inactive one), an
  eligible account, a membership holding no `org_admin` or `admin` role or
  label (`WORKFORCE_ROLE_CONFLICT`), and a current attestation for the role
  whose reviewer has no active membership at the facility and is not the
  caller: `WORKFORCE_SECOND_PERSON_REQUIRED` when only the caller's own
  attestation would do, `WORKFORCE_ATTESTATION_REQUIRED` otherwise. A role the
  membership already holds (its live assignment is locked FOR NO KEY UPDATE)
  is `WORKFORCE_ROLE_ALREADY_ACTIVE` when it was not granted on an
  attestation, or when its attestation is current and the chosen one does not
  last longer; otherwise the grant renews it: the old assignment is revoked
  (`revoked_by` the caller, the grant's reason) and the new one rests on the
  chosen attestation, and the command returns `renewed` true. The role is
  inserted with `granted_by` and `grant_reason`, with its
  `workforce_role_grants` row. The first grant on a pending membership
  activates it and labels it with the role. A revoke sets `revoked_at`,
  `revoked_by` and the reason (`WORKFORCE_ROLE_NOT_ACTIVE` when not held).
  Either way the membership's row version increases.
- `identity.admin_end_workforce_membership(membership, facility,
  membership_version, reason, key, digest)`: same membership checks. It
  deactivates the membership; revokes its facility roles; expires its
  `pending` access requests; revokes every `active` consent grant bound to it
  (`revoked_by` the caller, `revoked_reason` the reason); and, when the
  membership was active, revokes every unrevoked `staff` session of the
  account (reason `workforce_membership_ended`) with one `revoked` session
  event. It records the `ended` lifecycle row (inserting one for a membership
  the commands never attached) and returns the counts. Requests come before
  grants: an approval holding a request's row lock makes the request update
  wait, and once the approval commits the grant update, with a new snapshot,
  revokes the grant it made. An access request inserted by a transaction that
  commits after the request update has read the pending requests stays
  pending on the ended membership; it, and any grant later approved from it,
  authorizes nothing, because every authorization requires an active
  membership and an ended one is never reactivated.
- `identity.admin_workforce_profile(account)`: the account, staff record,
  attestations and memberships with their state, version and active roles
  (with whether each is effective), for the administration UI.

The shared helpers (`identity.workforce_command_actor`,
`workforce_require_assurance`, `workforce_works_at`,
`workforce_target_eligible`) and both trigger functions are revoked from
PUBLIC and granted to nobody.

Tests:

- `workforce-provisioning.integration.sql` (rollback-only, as the Identity
  runtime with synthetic platform sessions): the N5 index; the privileges;
  every refusal above; attach (new and existing identity, replay), the
  attestation, the grant by a second administrator and its activation, the
  pending account's lack of authority until it has a password, a lapsed
  attestation, revoke, the end of a membership with its grant, request and
  sessions, terminal ended state, re-attachment, the profile, the lock modes
  and the end's statement order (section 13, read from the function
  definitions), and renewal (section 14: a lapsed role renewed by a second
  administrator, the reviewer and an administrator at the facility refused,
  no renewal without a longer attestation, a legacy role never renewed, a
  renewal before the lapse, and a first grant of another role). Six mutants
  of the migration (no two-person check, no insider check on grants, no
  session revocation, no lapse check, no grant revocation, no request
  expiry) each fail it. On a database without 0087 it fails at its first
  assertion ("a second active membership at one facility was accepted").
  The rehearsal runs it with the additional suites and the acceptance script
  after `purpose-of-use-vocabulary.integration.sql`.
- `runtime-roles.integration.sql` (the role bootstrap's verification) checks
  the command and helper grants, that no runtime reads the three tables or
  updates memberships, and that only `platform_super_admin` holds the
  permission.
- `ocr-job-source-and-publication.integration.sql` gave account A two active
  memberships at one clinic; the second is now inactive, which keeps its
  "the session account's other membership" case.
- `services/identity-api/scripts/verify-platform-admin-runtime.mjs` runs the
  workforce routes end to end as the Identity runtime, including a revoke
  that leaves the clinician's actor with no role and no permission, and the
  end of the membership while a patient approval holds its request FOR
  UPDATE and a staff transaction holds the membership's KEY SHARE and then
  asks for its account's: no deadlock, the end waits for the approval, the
  approval's grant is revoked and the other pending request expires.
- `services/ehr-api/scripts/verify-membership-duplicates-runtime.mjs` (in the
  rehearsal) runs the legacy promotion's membership uniqueness check
  (`membershipUniquenessConflict`) against a disposable copy of the rehearsal
  schema: refused beside an active, unheld target membership (and that row
  would break the N5 index); accepted for an exact re-promotion and beside an
  inactive, held or other facility's membership; staged duplicates refused.
  Dropping `active`, `migration_hold_reason is null` or `id <> $3` from its
  query each fails it.

## Staff MFA sessions (0088)

`0088_staff_mfa_sessions.sql` is the database part of launch blocker MFA-1
(decision D14, ADR-054; change D-Eminence/hid-system#71): every staff
session that can reach patient data is MFA-verified. 0001 through 0087 are
unchanged. A staff session uses the 0069 tables, as a platform session does:
`auth.mfa_factors`, `auth.mfa_recovery_codes`, `auth.mfa_login_challenges` and
`auth.session_assurance`. An account has one factor whichever kind of session
it signs in to.

**Challenges.** `auth.mfa_login_challenges` gains `session_kind` (`platform`
or `staff`, `not null default 'platform'`; existing rows and rows written by an
earlier Identity build, which issues platform challenges only, are
`platform`) and the proof of a staff enrolment: `proof_method`,
`proof_verifier_hmac` (`char(64)`, the keyed digest of the emailed code; the
code is never stored), `proof_key_version`, `proof_sent_at` and
`proof_verified_at`. The check `mfa_login_challenges_proof_check` allows
three shapes: no proof (every platform and staff verify challenge, and a staff
enrolment challenge before a code is sent); `email_code` on a staff enrolment
challenge, with a hex digest, a key version, `proof_sent_at` and a
`proof_verified_at` that is null or not before it; and `provider_activation`
on a staff enrolment challenge, with only `proof_verified_at` (the activation
that opened the challenge is its proof).

`auth.guard_mfa_login_challenge_change` is replaced with `CREATE OR REPLACE`
(owner, ACL and trigger kept). As before, a consumed or invalidated challenge
is immutable, and the identity, token, expiry and attempt columns never change
and the attempt count never falls. It now also keeps `session_kind`
immutable, keeps a verified proof final (neither unset nor replaced by another
code), and refuses to consume a staff enrolment challenge that records no
verified proof (`23514 MFA_ENROLLMENT_PROOF_REQUIRED`). The database records
that a proof was verified; it cannot check the emailed code, whose key only
Identity holds.

**Factors.** `auth.mfa_factors` gains `enrollment_proof` (`email_code` or
`provider_activation`) and `enrollment_challenge_id` (the staff enrolment
challenge that carried the proof); the check
`mfa_factors_enrollment_proof_check` requires both or neither. The new trigger
`mfa_factors_enrollment_proof_guard` (`auth.guard_mfa_factor_enrollment_proof`,
`BEFORE INSERT OR UPDATE`, revoked from `PUBLIC`) accepts them only on a row
that names a staff enrolment challenge of the same account, not consumed,
invalidated or expired, whose verified proof has that method
(`23514 MFA_ENROLLMENT_PROOF_REQUIRED` otherwise), and never lets them change
(`55000 MFA_FACTOR_IMMUTABLE`). Identity sets them when staff enrolment
creates the pending factor; a factor created by platform sign-in, and every
factor that exists before 0088, records none.

**Assurance.** `auth.guard_session_assurance_change` (0069) is replaced with
`CREATE OR REPLACE`, restated exactly except that an assurance row may be
inserted for a `staff` session family as well as a `platform` one, a `staff`
one only on a factor that records a staff proof (`23514
STAFF_MFA_FACTOR_UNPROVEN` otherwise); a patient session still never has one,
a staff assurance row is not step-up evidence (`step_up_at` null and count 0
at insert), and the immutability rules are unchanged. So a factor that a
platform first enrolment created on the password alone never verifies a staff
session, whichever account holds it, while it still verifies platform
sessions. Together these rules mean a staff session's assurance always names
a factor created under a staff enrolment challenge with a verified proof.
Identity authorizes a staff session only while its family has an assurance row
whose factor is still active; sessions issued before the Identity build of
this change have none and are refused and ended
(`revocation_reason = 'staff_mfa_required'`). 0088 itself changes no session,
account or factor row. An administrator whose existing factor records no proof
and whose account holds an eligible staff membership is refused staff sign-in
(`403 STAFF_MFA_FACTOR_UNPROVEN`) until a two-person MFA reset, after which
they enrol at staff sign-in (`MIGRATION_RUNBOOK.md` lists such accounts).

**Recovery and reset.** `auth.complete_recovery_otp` (0086) is unchanged: it
revokes sessions and external sign-in identities and leaves `auth.mfa_factors`
and `auth.mfa_recovery_codes`, so recovering a password never removes the
second factor. The two-person MFA reset of 0070 (`auth.admin_request_approval`,
`auth.admin_decide_approval`) checks no account kind, only that the target has
an active or pending factor, so it already resets staff accounts; only the
`platform.mfa.reset` permission description changes ("administrator or
staff").

**Locks.** `ACCESS EXCLUSIVE` on `auth.mfa_login_challenges` and then on
`auth.mfa_factors` while their columns, checks and (on `auth.mfa_factors`) the
new trigger are added, until commit; Identity also locks a challenge before a
factor. The columns need no table rewrite; the checks scan the tables, whose
rows are kept (until now written by platform sign-in only). Everything else
replaces functions, sets comments or updates one `auth.permissions` row. No
grant changes: the Identity runtime's table grants on the three tables
(`runtime-grants.sql`) cover the new columns, the new trigger function is
revoked from `PUBLIC` in the migration, and `runtime-roles.integration.sql`
passes unchanged.

Tests:

- `staff-mfa.integration.sql` (new, rollback-only) as
  `hid_identity_api_runtime`: assurance accepted for a staff session on a
  factor with a staff proof and refused for a patient session, another
  account's factor, a stepped-up row and a factor without a staff proof (a
  platform-enrolled factor of a security auditor who is also a doctor, which
  still verifies that account's platform session), and a staff assurance row
  is not step-up evidence; a factor records a proof only from a live, verified
  staff enrolment challenge of its own account of that method (refused for an
  unverified, platform, other account's, other method's, consumed or missing
  challenge, and for an inconsistent pair), the record never changes, and an
  activated factor with a proof verifies the staff session; challenge shapes
  outside the three allowed are refused; a staff enrolment challenge cannot be
  consumed without a proof or with a sent but unverified code, a resend
  replaces the digest, a verified proof is final, a `provider_activation`
  challenge is consumable, a staff verify challenge needs no proof and its
  kind is immutable; `auth.complete_recovery_otp` leaves the factor row
  identical (`to_jsonb`) and both unused recovery codes, revokes the
  sessions and bumps the token version; a staff target's MFA reset through
  `auth.admin_request_approval` and `auth.admin_decide_approval` with
  step-up revokes the factor (`admin_reset`), invalidates the codes, ends the
  staff session (`mfa_reset`), bumps the token version, records the
  `mfa_reset` event and leaves no live assurance; the permission description
  names staff. On a database built to 0086 it fails with
  `SESSION_ASSURANCE_INVALID` at its first staff assurance insert; with the
  guard's proof check removed it fails with "a staff enrolment was completed
  without a proof"; with the assurance guard's staff proof check removed it
  fails with "a factor enrolled without a staff proof verified a staff
  session".
- `platform-mfa-approval.integration.sql`: the case that expected a staff
  session to be refused assurance now expects `STAFF_MFA_FACTOR_UNPROVEN`: that
  Super Admin's factor was enrolled by platform sign-in. With the assurance
  guard's staff proof check removed it fails with "a platform-enrolled factor
  verified a staff session".
- Runtime verifiers (`hid_identity_api_runtime`, real HTTP):
  `verify-staff-mfa-runtime.mjs` (new: the password step sets only the
  challenge cookie and creates no session; enrolment refused without the
  emailed code and with a wrong one; the session and its assurance at the
  first TOTP code; refresh in the same family; TOTP replay and recovery-code
  reuse refused; a staff challenge refused by the platform steps; a staff
  session without assurance refused by cookie and bearer and ended on
  refresh, but able to sign out; staff Google exchange refused; OTP recovery
  keeps the factor; a two-person reset of a staff account and re-enrolment;
  the platform first enrolment of a security auditor who is also a doctor
  refused with `409 MFA_ENROLLMENT_STAFF_SIGN_IN_REQUIRED`, then enrolled at
  staff sign-in and used for platform sign-in; a platform-enrolled factor
  refused at staff sign-in with `403 STAFF_MFA_FACTOR_UNPROVEN` and by the
  database as the runtime role, then reset by two Super Admins and enrolled
  again with the proof).
  Every verifier that signs staff in now does it with password and
  authenticator through `staff-session-client.mjs`, and
  `verify-delegated-cookie-read-runtime.mjs` checks that the EHR refuses an
  unassured reader with `403 STAFF_MFA_REQUIRED`.

## Session facility selection (0089)

`0089_session_facility_selection.sql` (ADR-046, `BRANCH:launch/facility-selection-0089`;
written as `0080` in D-Eminence/hid-system#47) follows `0088` (staff MFA).
Migrations `0001`–`0088` are unchanged; no existing row, function, policy or
grant changes. Creating
the table's four foreign keys takes `SHARE ROW EXCLUSIVE` on `auth.sessions`,
`auth.accounts`, `identity.facilities` and
`identity.staff_facility_memberships` until the migration commits, within the
runner's 5 s lock timeout (`MIGRATION_RUNBOOK.md`).

- `auth.session_facility_selection` holds the facility a staff sign-in
  explicitly selected with `POST /auth/facility`: `family_id` (primary key,
  the sign-in's root session in `auth.sessions`), `account_id`, `facility_id`,
  `membership_id`, `selected_at` (`clock_timestamp()`) and `row_version`. Like
  `auth.session_assurance` (0069) it is keyed by the session family, so the
  refresh rotation, which keeps the family, keeps the selection, and another
  sign-in of the same account has its own. A composite foreign key binds
  `(membership_id, facility_id, account_id)` to one membership of that account
  at that facility. Every foreign key is `ON DELETE RESTRICT`.
- The row is only the default `GET /auth/session` and refresh report. It
  authorizes nothing: facility-scoped requests still carry `X-Facility-ID`,
  checked against the actor's active memberships, and the Identity API checks
  the stored facility against them on every read (`reselect` when it is no
  longer active). It compares facility ids, so a membership replaced by another
  active one at the same facility is still reported `selected`, with the new
  membership's roles; `membership_id` records the membership the choice was
  made under.
- `auth.guard_session_facility_selection_change()` (invoker, fixed
  `search_path`, revoked from `PUBLIC`) fires before every row insert, update
  and delete. An insert or update must name the root session of a staff
  sign-in of the same account (`id = family_id`, `session_kind = 'staff'`),
  the family must still have a live session (unrevoked, within its idle and
  absolute windows), and the membership must be active, of this account and
  facility, without a migration hold, with an active staff record of the
  account whose trimmed, lower-cased verification status is `verified`,
  `approved` or `active`, in an active organization, at an active facility of
  that organization. These membership, hold, staff, organization and facility
  conditions mirror `CurrentStaffContextService`; the account's status and
  `disabled_until` are not repeated, since `TokenService.verify()` refuses an
  inactive or disabled account before the API writes. The status list
  duplicates `ACTIVE_STAFF_VERIFICATION_STATUSES` (`auth-policy.ts`), as
  `identity.has_active_membership` (0008) does; comments at each place name the
  others. Otherwise
  `23514 SESSION_FACILITY_SELECTION_INVALID`. An update cannot change
  `family_id` or `account_id`, and DELETE is refused, both with
  `55000 SESSION_FACILITY_SELECTION_IMMUTABLE`. Sign-out and revocation leave
  the row; with no live session left, the sign-in can never change it again.
- The Identity API writes it in one system transaction: `auth.lock_account_sessions`
  on the account first (0073, as sign-out and revocation), then
  `INSERT ... SELECT` from the presented session while it is a live staff
  session of the account, `ON CONFLICT (family_id) DO UPDATE` (a new choice
  replaces the old and increments `row_version`), then the
  `auth.facility.select` audit row on the same transaction. It reads the row
  only through a live staff session of the family. A read that fails is never
  reported as a choice: `GET /auth/session` answers
  `503 DEPENDENCY_UNAVAILABLE`, and a refresh, whose rotation has committed,
  answers `200` with `facilitySelection: 'unavailable'` (ADR-046, as ported).
  Since staff MFA (0088) the API reaches the row only through a staff session
  its guard found MFA-verified; the database guard does not repeat that check,
  because the row authorizes nothing.
- `runtime-grants.sql` grants `SELECT`, `INSERT` and `UPDATE` to
  `hid_identity_runtime` (so `hid_identity_api_runtime`), and no `DELETE`,
  next to the `auth.session_assurance` grants and before the bootstrap's
  closing membership revocation; no other role, `hid_schema_test_runtime`
  included, gets any privilege. The guard reads only tables the Identity
  runtime already reads. The bootstrap fails on a database without 0089.
- `session-facility-selection.integration.sql` (rollback-only, synthetic
  fixtures) checks the catalog contract (columns, keys, the guard's
  attributes, trigger timing and grants) and, as `hid_identity_api_runtime`,
  the API's upsert and replacement, and the guard's refusals: another
  account's id on a sign-in, an ended membership, a membership held for
  migration, a suspended facility, a deactivated organization, another
  account's membership, a membership of another facility, another account's
  sign-in, a patient sign-in (of the same account, so only the kind differs)
  and another patient's, a signed-out and a lapsed sign-in, an inactive and an
  unverified staff record, a session that is not its family's root, an unknown
  session, an update to an ended membership or to another sign-in or account,
  and DELETE (refused to the runtime by privilege and to the owner by the
  guard). It then checks that the rotated session reads the selection while
  the replaced session and another sign-in of the account do not, and that
  after sign-out the row stays but is neither read nor changeable. Its
  privilege check covers every `hid_` role that is neither the Identity
  runtime, one of its members, nor the table owner, so roles added after #47
  (`hid_platform_control_reader`, among others) are covered too.
  `scripts/run-container-database-acceptance.sh` runs it last, after
  `staff-mfa.integration.sql`.
  `services/identity-api/scripts/verify-facility-selection-runtime.mjs`
  exercises the HTTP contract against a migrated database as
  `hid_identity_api_runtime`, with the global `AuditInterceptor` registered as
  `AppModule` registers it, so each refused selection must also write its
  failed `auth.facility.select` row past 0067's staff CHECKs. It signs staff
  in through `staff-session-client.mjs` (password, enrolment with the emailed
  code, then TOTP), checks that the password step stores and reports nothing
  and that the enrolment activation and the second-factor responses report
  `default`, and revokes `SELECT` on the table from `hid_identity_runtime` for
  one step (restored in `finally`) to check that the session read answers
  `503` with no `Set-Cookie` and the refresh `200` with the rotated cookies
  and `unavailable`. The rehearsal runs it after the sign-out verifier.

## EHR retraction integrity (0090)

`0090_ehr_retraction_integrity.sql` (BRANCH:launch/ehr-retraction-integrity)
adds one column, six trigger functions (one of them replacing 0084's) and six
triggers, and one runtime grant (`runtime-grants.sql`). It changes no row.
Migrations 0085 to 0089 belong to other changes.

**Retraction needs the records' write permissions (ENC-RETRACT-1).**
Cancelling an encounter cancels its open orders, and marking it entered in
error retracts its records (0084). Both ran for any member who may write the
encounter: the update policies check the patient's consent
(`ehr.context_allows`), not the role, so a nurse could retract a doctor's
confirmed diagnosis and prescription through the encounter, and a
receptionist (who holds only `ehr.encounter.write`) could retract notes they
cannot read. `ehr.require_retraction_permission()` (`BEFORE UPDATE OF status`
on `ehr.encounters`, trigger `encounters_retraction_permission`) runs when the
status becomes `cancelled` or `entered_in_error`. It looks, under the writer's
row-level security, for each kind of record the close changes, and refuses
with `42501` `ENCOUNTER_RETRACTION_NOT_PERMITTED` (PostgreSQL detail: the
missing permission codes; the EHR answers a fixed detail and never passes them
on) unless the writing membership holds that kind's write
permission, as `auth.membership_has_permission(subject, membership, the
encounter's facility, permission)` answers it from the membership's role
assignments:

| Close | Records changed | Permission |
|---|---|---|
| entered in error | notes `draft`, `signed`, `amended` | `ehr.note.write` |
| entered in error | diagnoses not yet `entered_in_error` | `ehr.diagnosis.write` |
| entered in error | vitals `final` | `ehr.vital.write` |
| entered in error | prescriptions `draft`, `active`, `on_hold`, `completed` | `ehr.prescription.write` |
| entered in error | lab requests `draft`, `active`, `on_hold`, `completed` | `ehr.lab-request.write` |
| entered in error | documents linked to it, `initiated` or `uploaded` | `ehr.document.write` |
| cancelled | prescriptions `draft`, `active`, `on_hold` | `ehr.prescription.write` |
| cancelled | lab requests `draft`, `active`, `on_hold` | `ehr.lab-request.write` |

An encounter that holds none of these needs no record permission, and holding,
resuming or completing an encounter needs none. Only the statuses in the table
count: a record already entered in error, a cancelled order or a rejected
document blocks nothing. With the seeded roles (0006, 0084):

- marking entered in error: doctors and clinicians may retract any encounter
  unless it holds a `draft`, `active`, `on_hold` or `completed` lab request;
  nurses unless it holds a diagnosis not yet `entered_in_error`, or such a
  prescription or lab request; receptionists only one that holds none of the
  records in the table;
- cancelling: anyone holding `ehr.encounter.write` (receptionists included),
  whatever notes, vitals, diagnoses and documents it holds, unless it holds a
  `draft`, `active` or `on_hold` prescription (then doctors and clinicians
  only) or lab request.

No role holds `ehr.lab-request.write` since 0084, so no one can cancel or
retract an encounter that still holds an open (or, for a retraction,
completed) lab request until Lab ordering is enabled again; no lab request can
be created at launch, and the release checklist retracts open ones before 0084
(P12). The EHR API refuses the same close itself, before writing anything,
with the same code and a fixed detail ("Cancelling or retracting this
encounter changes records you may not write"); the missing permissions go to
the refusal's audit row only, because only a kind the encounter holds is
checked and naming it would tell the caller which kinds of record the
encounter holds.

`auth.membership_has_permission` is the existing `SECURITY DEFINER`
permission decision (0010) that Identity's commands use; `hid_ehr_runtime`
gains `EXECUTE` on it in `runtime-grants.sql`, its only new privilege. It
answers a boolean for a subject, membership and facility, and reveals nothing
else. It is called only when the encounter holds such a record, so a close of
an empty encounter does not depend on the grant. Without the grant (a release
that applies 0090 but not the role bootstrap), such a close fails with `42501`
on the function, answered `403 ACCESS_DENIED`, and nothing is written.

**Closed encounters are final (ORDER-CLOSED-EDIT).**
`ehr.keep_closed_encounter()` (`BEFORE UPDATE` on `ehr.encounters`, trigger
`encounters_closed_final`) refuses any update of a `cancelled` or
`entered_in_error` encounter with `55000` `ENCOUNTER_NOT_OPEN`, as 0084's
guard does for records added to one. The row lock (`FOR UPDATE`) and the
share lock of 0084 are not updates and are not refused.

**Closed orders are final (RX-FINAL, ORDER-CLOSED-EDIT).**
`ehr.keep_closed_order()` (`BEFORE UPDATE` on `ehr.prescriptions` and
`ehr.lab_requests`, triggers `prescriptions_closed_final` and
`lab_requests_closed_final`) refuses:

- any update of a `cancelled` or `entered_in_error` order, and of a
  `completed` one except marking it `entered_in_error` with no other column
  changed: `55000` `PRESCRIPTION_FINAL` or `LAB_REQUEST_FINAL`;
- any status change outside the transitions the services apply (`draft` to
  `active`, `cancelled` or `entered_in_error`; `active` to `on_hold`,
  `completed`, `cancelled` or `entered_in_error`; `on_hold` to `active`,
  `cancelled` or `entered_in_error`; `completed` to `entered_in_error`):
  `55000` `INVALID_PRESCRIPTION_TRANSITION` or
  `INVALID_LAB_REQUEST_TRANSITION`.

Before 0090 a cancelled prescription could be made active again, and a
completed, cancelled or retracted one could have its frequency, instructions
or end date rewritten, by the API and by the runtime role. Pharmacy's 0080
guards read prescriptions and never update them.

**A vital can be entered in error (ENC-RETRACT-2).** `ehr.vitals` gains
`status text not null default 'final'` with `vitals_status_check` (`final` or
`entered_in_error`). Existing vitals are `final` through the default: adding a
column with a constant default rewrites no row, so no version is recorded and
the version trigger, which needs an acting member, does not run.
`ehr.keep_recorded_vital()` (0084, trigger `vitals_recorded_values_immutable`)
is replaced: it still refuses any change of a recorded value
(`VITAL_RECORD_IMMUTABLE`), also allows the one-way change of `status` from
`final` to `entered_in_error`, and refuses any update of a vital entered in
error, its correction number included (`55000` `VITAL_ENTERED_IN_ERROR`).
Nothing is deleted: a retracted vital keeps its values and versions, the EHR
lists it with its status, and the emergency summary leaves it out. The
retraction of an encounter now also marks its final vitals, its completed
orders and its linked documents entered in error, in the same transaction.

`ehr.require_final_vital()` (`BEFORE INSERT` on `ehr.vital_corrections`,
trigger `vital_corrections_vital_final`) refuses a correction row of a vital
entered in error with `55000` `VITAL_ENTERED_IN_ERROR` (the EHR answers
`409 VITAL_NOT_AMENDABLE`). Without it a writer could add a correction row to
a retracted vital as long as it left the vital's correction number alone; the
corrections list would show it. It reads the vital `FOR SHARE`, which waits
for an uncommitted retraction of that vital and then sees it, so a correction
never commits beside a retraction it did not see (the foreign key's own
`FOR KEY SHARE` does not conflict with a status update). A vital it cannot
read under the writer's row-level security is refused with `42501`
`VITAL_NOT_AVAILABLE`. The EHR's correction already holds the vital
`FOR UPDATE` when it inserts the row, so it takes no new lock.

**A retracted document stays retracted (ENC-RETRACT-2).**
`ehr.keep_retracted_document()` (`BEFORE UPDATE` on `ehr.documents`, trigger
`documents_retracted_final`) refuses any update of a document whose status is
`entered_in_error` with `55000` `DOCUMENT_ENTERED_IN_ERROR`. Without it a
writer could set a retracted wrong-patient document back to `uploaded`;
`ehr.documents_effective` would then show it as `available` again if its scan
was clean, and the emergency summary and the download route would serve it.
Upload completion (`initiated` to `uploaded`) and the retraction itself
(`initiated` or `uploaded` to `entered_in_error`) select only those statuses
and are unchanged; no EHR route changes a retracted document, so no new error
reaches a client.

**Order of checks and locks.** Each trigger's name sorts before the table's
`*_versioned` trigger, so a refused write records no version
(`ehr.vital_corrections` is append-only and has none); on `ehr.encounters` the
closed check runs before the permission check. The
functions are `SECURITY INVOKER` with `search_path = pg_catalog, pg_temp`,
qualify every name, and are not executable by `PUBLIC`. The permission check
reads the encounter's records while the update holds the encounter's row lock,
which every record create and order activation waits for (0084), so no record
can join a category during the check. A vital, order or document changes
status on its own route under its own row lock, never under the encounter's,
so no new lock order arises. The correction guard's share lock is on the
corrected vital only; it takes no encounter lock, so it cannot wait on a
retraction that waits on it.

**Locks.** `ALTER TABLE ... ADD COLUMN` takes `ACCESS EXCLUSIVE` on
`ehr.vitals` for the catalog change (no rewrite: the default is constant, and
the check constraint is validated by a scan of the table under that lock).
`CREATE TRIGGER` takes `SHARE ROW EXCLUSIVE` on `ehr.encounters`,
`ehr.prescriptions`, `ehr.lab_requests`, `ehr.vital_corrections` and
`ehr.documents`. Each waits for the transactions in
flight on its table within the runner's 5 s `lock_timeout`; a timeout rolls
0090 back whole, and it can be run again.

Tests:

- `encounter-retraction.integration.sql` (rollback-only; in the rehearsal's
  additional suites and in `scripts/run-container-database-acceptance.sh`):
  15 property cases (the six functions' security, the seven triggers' events,
  columns, functions and order before the version trigger, the vital status
  column, and the runtime's `EXECUTE` on the permission decision), then 82
  cases as `hid_ehr_api_runtime` with the session the EHR API sets for a
  doctor, nurse and receptionist of one clinic, each holding the seeded role:
  retraction and cancellation by role and by the records held, closed
  encounters, the cascade's statements on vitals, completed orders and
  documents, every order transition for both order tables, vital retraction,
  correction rows of a final and a retracted vital, and a retracted document
  set back to uploaded, renamed, sent its own status, or retracted and
  restored in one transaction (refused), beside an upload completion
  (allowed). On 0084 (with this branch's role bootstrap) it fails with 63
  mismatches.
- `encounter-lifecycle.integration.sql` (0084) passes unchanged.
- `verify-encounter-lifecycle-runtime.mjs` (in the rehearsal): over HTTP as
  `hid_ehr_api_runtime`, a nurse refused retracting a doctor's diagnosis and
  prescription with nothing changed, a fixed detail and the refusal audited
  with the missing permissions, a nurse retracting her own notes and vitals,
  the cascade over vitals and a completed prescription with `cascade` in the
  response, the vital route, a direct runtime-role correction that waits for
  an uncommitted retraction of its vital and is then refused (with the
  guard's `FOR SHARE` removed it does not wait and the step fails), a closed
  prescription and a closed encounter refused, and a staff session refused on
  `GET /ehr/me/records`. Its fixture now gives the doctor and nurse role
  assignments, and grants the copy's doctor role `ehr.lab-request.write`,
  which its fake Identity session has always carried, so that it keeps
  exercising lab requests as when Lab ordering is enabled again.
- `scripts/tuf-staging-migration-rehearsal.mjs`: the 0028 upgrade has the six
  triggers, the vital status, and the runtime grant after the role bootstrap.

## Launch module withdrawal and patient access transparency (0091)

`0091_launch_module_withdrawal_and_patient_access_transparency.sql` (decisions
D17 and D9, ADR-058; change `BRANCH:launch/launch-permission-withdrawal`)
makes the launch database start in the launch module set, binds the
patient-self row-level security context to the patient's own session, names
the requesting clinician to the patient and tells the patient when their PIN
is used. 0001 through 0090 are unchanged; 0089 and 0090 are on other
branches.

**Launch controls.** 0039 seeded `uploads_enabled`, `outreach_portal_enabled`
and `break_glass_enabled` on; 0084 left them to an operator (P11). 0091 sets
each off only while it is exactly as 0039 seeded it (`enabled`,
`row_version = 1`, `updated_by is null`, reason `Initial platform control
state`); a control an administrator has changed keeps its value. The row
records the change (version 2, `updated_by` null, a reason naming 0091), and no
`platform.control_events` row is written: its `actor_account_id` is required
and a migration has no actor, as for 0041. `platform.control_settings` forces
row-level security, and its policies need a platform account, so the
migration administrator, which owns the table and is no superuser on RDS,
would update no row (probed locally under a `NOSUPERUSER NOBYPASSRLS` owner:
0 rows): the migration runs `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`,
the update and `FORCE ROW LEVEL SECURITY` in its transaction, so no other
session ever sees the table unforced. For the same reason the release
checklist's read-only P10 and P11 checks, which that administrator runs, read
the controls through `platform.control_enabled` (owned by
`hid_platform_control_reader`, admitted by its own policy), not from the
table; `verify-non-superuser-database.mjs` runs both checks as a
`NOSUPERUSER NOBYPASSRLS` administrator.

**Launch module permissions.** Every row of `auth.role_permissions` whose
permission is `lab.*`, `pharmacy.*`, `ocr.*`, `outreach.*`,
`identity.break-glass.write` or `ehr.document.write` is deleted (admin,
clinician, doctor, lab, nurse, ocr_worker, org_admin, pharmacist and
receptionist held some). The permission codes stay in `auth.permissions`.
The database's own checks follow: `identity.activate_break_glass` and
Outreach's `outreach.context_allows` read role permissions, so break-glass and
Outreach writes and reads are refused in the database as well as by the
services; Lab, Pharmacy and OCR row-level security does not read role
permissions. `ocr_worker` loses `ocr.job.process`, which nothing checks (the
worker commands check the `ocr_worker` role). The EHR's own permissions,
`ehr.lab-request.read`, `ehr.prescription.*` and `ehr.document.read`
included, stay. `runtime-roles.integration.sql` (the bootstrap assertions)
fails if any role holds a withdrawn permission or loses a kept one, on every
bootstrap. Re-enabling a module is therefore a reviewed migration that grants
the permissions again and changes these assertions; like every ledger
migration it applies to every environment (ADR-058). A permission granted by
hand on one database stops that database's next bootstrap.

**With 0090.** 0090 (`BRANCH:launch/ehr-retraction-integrity`, ADR-056)
makes marking an encounter entered in error require the write permission of
each record it retracts, `ehr.document.write` for a linked document in status
`initiated` or `uploaded` (`ehr.require_retraction_permission`). Once both
are applied no role holds it, so such an encounter cannot be marked entered
in error (`42501 ENCOUNTER_RETRACTION_NOT_PERMITTED`) until uploads are
re-enabled; cancelling it is not affected (that rule asks only for the open
orders' permissions). A database on which no upload was ever started, as the
launch production database is expected to be, holds no such document; a
staging database might. 0090's `encounter-retraction.integration.sql`
expects the seeded nurse to hold `ehr.document.write`, so the merge that
brings both together grants it to the nurse role inside that suite's
rollback-only transaction and adds the doctor's refusal (release checklist
§2); verified locally on a database built from empty through the real 0089,
0090 and 0091 (98 cases).

**Patient-self binding (PSELF-RLS).** `ehr.patient_self_context(uuid)` keeps
its signature, so the 0030/0084 policies on `ehr.encounters`,
`ehr.clinical_notes` and `ehr.clinical_note_revisions` are unchanged. It
becomes `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog,
pg_temp` (CREATE OR REPLACE keeps its owner and its `EXECUTE` for
`hid_ehr_runtime` and `hid_schema_test_runtime`). It still requires
`app.purpose_of_use = 'patient-self'`, the patient, subject, account, session
and correlation settings and a future `app.self_authorized_until`, and now
also that the patient is the one `identity.patient_self_session(subject,
session)` returns (a live patient session of that subject, not revoked or
expired, at the account's token version, with an active account and patient)
and that it belongs to `app.account_id`. A malformed account or session id
answers false, not an error. The binding is checked per row (one indexed
lookup), bounded by the 50-row section limits; on a staff read the setting
checks return false before any lookup. Under the rehearsal's non-superuser
owner the function and `identity.patient_self_session` run as that owner,
which owns `identity.patients` (row-level security not forced).

**Named grantee (CONSENT-GRANTEE).** `identity.list_my_access_requests()` and
its session-bound wrapper `identity.list_my_patient_access_requests(text,
uuid)` are dropped and recreated with two more columns,
`requester_display_name` (`auth.accounts.display_name` of the request's
membership account) and `requester_role` (that membership's
`membership_role`), joined on the request's membership at its facility (left
joins: a missing membership gives nulls). The wrapper's `EXECUTE` for
`hid_identity_runtime` and `hid_schema_test_runtime` returns with the role
bootstrap (`runtime-grants.sql`), so run the bootstrap immediately after the
migrations, as for 0074; until then the patient's request list answers `403`.
`identity.patient_self_access_history(text, uuid)` (CREATE OR REPLACE, grants
kept) adds `requesterDisplayName` (the grant's account) and `requesterRole`
(the grant's membership at its facility) to each item, reads 51 grants and
returns the latest 50 with `truncated`. The staff list is unchanged.

**PIN-use notice.** `notification.on_identity_pin_outbox_created()`
(`SECURITY DEFINER`, revoked from `PUBLIC` in the migration and the bootstrap)
runs from the new `AFTER INSERT` trigger `pin_use_notification_inbox` on
`identity.outbox_events` (`WHEN (new.event_type =
'PatientAccessPinVerified')`) and calls
`notification.enqueue_patient_inbox_item(patient, 'PATIENT_ACCESS_PIN_USED',
'consent-grant', grant, {consentGrantId, reviewRequired: true})`, as 0037's
emergency trigger does. `identity.access_patient_with_pin` writes the event
only for a new grant, so a replay adds no item, and a deleted login gets
none. The EventBridge rule is unchanged.

**Not included.** Pending access requests still do not lapse
(ACCESS-REQ-STALE, ADR-058): `identity.create_access_request` (0086) reuses a
pending request, so a lapse needs it, the approval command and both request
lists changed together.

**Locks.** `ACCESS EXCLUSIVE` on `platform.control_settings` first, to commit
(every control read waits; the same order as a break-glass activation and the
role bootstrap: controls, then `identity.outbox_events`), `ROW EXCLUSIVE` on
`auth.role_permissions`, function replacements (no table lock), and `SHARE ROW
EXCLUSIVE` on `identity.outbox_events` for the new trigger (in-flight outbox
writers finish first; new ones wait to commit). Each waits at most the
runner's 5 s lock timeout; a timeout rolls 0091 back whole.

Tests:

- `runtime-roles.integration.sql` (bootstrap assertions): no role holds a
  withdrawn permission, the kept EHR, access-request and PIN permissions stay;
  `ehr.patient_self_context` is `SECURITY DEFINER` with the pinned search path
  and executable only by the EHR runtime; the PIN trigger exists and its
  function is not callable by a runtime role; the request list is reachable
  only through its wrapper. On 0088 it fails on the first.
- `patient-self.integration.sql`: seven unbound patient-self contexts (another
  patient with the caller's own session, a session that does not exist, a
  revoked session, another account's session, another account id, another
  subject, a malformed session id) read no encounter, note or revision, and a
  patient bound to its own session reads exactly its released records. On
  0088 all seven read records.
- `patient-access-safety.integration.sql`: the list and the history name the
  clinician and role; `truncated` is false for three grants and true, with 50
  items, for 51.
- `patient-access-pin.integration.sql`: one `PATIENT_ACCESS_PIN_USED` item
  per verification with the grant and minimum metadata, none for the replay,
  the refused PINs or the rolled-back audit failure.
- `platform-controls.integration.sql`: the three launch controls start off,
  the other three keep their launch state.
- Suites that exercise break-glass or Outreach (`schema`, `emergency`,
  `emergency-contacts`, `outreach-session-guards`) grant those permissions to
  the doctor role inside their rollback-only transaction, as the module's
  re-enabling migration would; `runtime-command-privileges` keeps its Outreach
  registration/campaign invariant without requiring a holder.
- All 45 SQL suites pass on a database built from empty to 0091, and the 44
  additional suites again with every schema, table and function owned by a
  `NOSUPERUSER NOBYPASSRLS` role (the rehearsal's P8 owner check, which now
  counts `ehr.patient_self_context` among its 9 definer commands).
