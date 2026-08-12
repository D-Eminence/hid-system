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
| `hid_ocr_worker` | OCR asynchronous commands | None | No direct table access; lease/token-bound claim, renewal, extraction-result, and safe-failure functions only. |
| `hid_lab_runtime` | Lab-owned persistence | None | No Identity, EHR, OCR, or Pharmacy mutation privilege. |
| `hid_lab_api_runtime` | Extracted Lab API aggregate | None | Composes Lab persistence and append-only audit only. |
| `hid_pharmacy_runtime` | Pharmacy work, dispense, reversal, import, and outbox persistence | None | No Identity, EHR, Lab, or OCR mutation privilege. |
| `hid_pharmacy_api_runtime` | Extracted Pharmacy API aggregate | None | Composes Pharmacy persistence and append-only audit only. |
| `hid_outreach_runtime` | Temporary registration, mapping, immutable history, idempotency, and outbox | None | No Identity, EHR, Lab, Pharmacy, or OCR mutation privilege. |
| `hid_outreach_api_runtime` | Extracted Outreach API aggregate | None | Composes Outreach persistence and append-only audit only. |
| `hid_event_dispatcher` | Event transport command surface | None | No direct table access; executes only lease-bound claim/result/status functions. |
| `hid_event_delivery_commands` | Technical security-definer owner | None | Never inherited; reads five domain outboxes through exact RLS policies and mutates only `integration` delivery/inbox state. |
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

The EHR does not use a generic JSON medical-record table.

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

The logical `prescriptions` requirement currently maps only to the versioned
`ehr.medication_request` aggregate. It owns medication-order intent, dose and
instructions, requester, reason, status, and provenance.

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
