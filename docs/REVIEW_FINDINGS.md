# HID Architecture Senior Review Findings

| Field | Value |
|---|---|
| Review status | Historical review evidence for a superseded proposed documentation set |
| P0 findings | None |
| Implementation status | No production implementation is authorized or represented as complete |
| Reviewed scope | The documentation proposal that existed when this review was recorded, including documents that have since been superseded or removed |

This record captures issues found during the senior-engineering self-review and
the corrections applied before handoff. “Resolved” means the documentation is
internally reconciled; it does not prove an implemented control, regulatory
compliance, clinical safety, migration readiness, or production readiness.
Current platform authority is defined by [`CODEX.md`](../CODEX.md) and the
authoritative documents indexed in [`docs/README.md`](README.md). This file is
specialist historical evidence and does not restore or override removed plans,
blueprints, or relational contracts.

## 1. Findings and resolutions

| ID | Severity | Issue found | Resolution applied | Status |
|---|---|---|---|---|
| REV-001 | P1 | The requested per-service tree would prematurely create Identity, EHR, Lab, and a custom API-gateway deployable, introducing distributed identity/audit transactions without evidence. | Defined logical NestJS bounded modules in one core transaction boundary; retained separate Python OCR and provider-isolated Outreach workers; AWS API Gateway remains the managed edge. | Resolved |
| REV-002 | P1 | Patient identity and public identifiers were not sufficiently separated, risking local patient tables or alternate keys. | Made `identity.patient.hid` the sole domain patient FK; login subjects, FHIR IDs, MRNs, visible codes, contacts, and legacy IDs are governed mappings/bindings only. | Resolved |
| REV-003 | P1 | Organization, facility, and identifier-policy names, status, hierarchy, custody, and residency could be mutated in place despite the immutable-version rule. | Added stable headers, immutable versions/events, guarded projections, composite current-head FKs, and explicit field classification. | Resolved |
| REV-004 | P1 | Deferred triggers alone could permit concurrent inverse organization or patient-merge edges under PostgreSQL MVCC; referenced graph versions had no aggregate. | Added tenant hierarchy revisions, patient graph components/revisions, deterministic component/tenant locking, re-read and cycle validation, optional `SERIALIZABLE` defense, bounded retries, and concurrent write-skew tests. | Resolved |
| REV-005 | P1 | A reusable API `patientContextId` was conflated with the request-bound database authorization context. | Split it into an opaque, principal/session/purpose-bound workflow handle and a fresh server-private access context created after complete reauthorization for every protected request. Only the latter enters RLS. | Resolved |
| REV-006 | P1 | Idempotency uniqueness depended on tenant scope even though global Identity and pre-auth operations may have no tenant; nullable PostgreSQL uniqueness could admit duplicates. | Replaced it with non-null `(scope_kind, scope_id, requester_kind, requester_id, operation, key)` semantics; pre-auth requester identity is a server-issued, session/CSRF-bound flow ID. | Resolved |
| REV-007 | P1 | The Lab API could create executions and release results, but the target schema had no execution aggregate or exact FK/evidence path to method, operator, instrument, reagent, calibration, maintenance, and QC. | Added stable/versioned test execution, immutable reagent-use and quality-evidence links, exact result-to-execution references, and guarded release validation. | Resolved |
| REV-008 | P1 | Specimen/container identity and aliquot lineage were underspecified, allowing collisions or unprovable custody relationships. | Added governed issuer/facility-scoped specimen/container identifiers, immutable correction/replacement, stable container records, append-only aliquot lineage, deterministic cycle checks, and quantity validation. | Resolved |
| REV-009 | P1 | Critical-result acknowledgement had no stable notification aggregate and could require mutating an earlier attempt. | Added a stable notification header and append-only attempt, reach, read-back, acknowledgement, failure, escalation, and closure events. | Resolved |
| REV-010 | P1 | Requester-facing asynchronous audit exports had no persistence model and could be confused with continuous WORM archive manifests. | Added a separate versioned evidence-export job with purpose, bounded query hash, source checkpoint, approval, protected output/version, checksum, expiry, and append-only delivery evidence. | Resolved |
| REV-011 | P1 | Data-access and cross-tenant grants had create APIs but no explicit suspend, revoke, or replacement contract. | Added guarded commands with `If-Match`, reason/evidence, approvals, immutable versions, and atomic audit/outbox requirements. | Resolved |
| REV-012 | P1 | FHIR search could place PHI in GET query strings, conflicting with the platform URL/telemetry rules. | Required POST `/{resource}/_search` for any sensitive search and restricted GET search to a reviewed non-sensitive allowlist enforced at edge and application. | Resolved |
| REV-013 | P1 | Identifier documentation did not fully prevent value mutation or retired-binding disclosure/reuse. | Required one immutable value per binding, linked replacement for value correction, guarded encryption rotation, permanent exclusive lookup reservation, and a non-disclosing retired outcome. | Resolved |
| REV-014 | P1 | Phase 0/Identity implementation was inadvertently blocked on later EHR, Lab, OCR, Outreach, and Pharmacy decisions. | Split common/Identity pre-DDL gates from context-specific entry gates across the schema, database, security, architecture, and implementation plan. | Resolved |
| REV-015 | P1 | Migration callback handling was described as a final zero-delta source plane even though callbacks must continue during the freeze, and rollback language covered only clinical writes. | Defined a pre-staged durable buffer with last-applied/first-unapplied boundaries, destination-neutral replay, exact reconciliation, and “no simple rollback after any target domain write.” | Resolved |
| REV-016 | P2 | Facility-code uniqueness referred to an issuer absent from the model. | Added versioned facility identifier-system/issuer definitions, bindings, exact tenant/issuer-scoped permanent uniqueness, and immutable replacement. | Resolved |
| REV-017 | P2 | Canonical alias traversal lacked a required reverse lookup path. | Added a partial `(canonical_hid, hid)` merged-alias index contract plus graph component/revision access path; it is explicitly not a second patient key. | Resolved |
| REV-018 | P2 | FHIR mappings had no merge/split lifecycle and a strict one-to-one statement became invalid after two mapped identities merge. | Added mapping headers/versions/events, one active primary mapping per audience/canonical HID, retained prior IDs, governed `Patient.link`, reviewed split/unmerge, and non-reassignment. | Resolved |
| REV-019 | P2 | Product object-access wording prohibited even the narrowly authorized presigned-object workflow described by Security. | Standardized the rule: no general browser storage access; one short-lived, one-object operation is allowed only after object-specific authorization and audit. | Resolved |
| REV-020 | P2 | The step-up route did not explicitly require CSRF, and session/CSRF/callback responses lacked an explicit no-store requirement. | Added CSRF to cookie-authenticated step-up and required `Cache-Control: no-store` for session, CSRF, callback, step-up, and PHI responses. | Resolved |
| REV-021 | P2 | Repository and deployment inventories omitted `staff-operations`, synchronous Outreach ownership, or Document ownership in some documents. | Reconciled the repository, deployment units, and ADRs: operations UI covers OCR/Outreach; core owns synchronous Document/Outreach control; workers own isolated asynchronous work. | Resolved |
| REV-022 | P2 | Identity issuance state and registration route names drifted across documents. | Standardized `approved-new-identity` and `/registration-cases`. | Resolved |
| REV-023 | P2 | The phase diagram appeared to bypass Outreach on the way to Pharmacy and obscured the migration cutover gate. | Made Phase 4A → Phase 4B → separately approved production cutover explicit; Pharmacy discovery may run in parallel, but implementation cannot bypass shared gates. | Resolved |
| REV-024 | P2 | The authentication text could imply that “Cognito” and “JWT” are alternatives at the same layer. | Separated the provider decision from token format and specified strict issuer, audience, algorithm, signature, time, replay, and token-use validation. | Resolved |
| REV-025 | P1 | A circular Phase 0 gate required executed Identity/Auth reconciliation evidence before the target mappings and DDL needed to produce that evidence could be authored. | Phase 0 now requires verified inventory, an approved mapping/crosswalk specification, and signed acceptance criteria; executed reconciliation gates Phase 1 data promotion and cutover. | Resolved |
| REV-026 | P1 | The rollback boundary referred only to a target “domain write,” allowing target-only Auth, object, durable-job, or provider state to be discarded or diverge. | Defined the irreversible boundary as the first post-transition target-only durable authoritative mutation in any plane, with only explicitly disposable pre-primary test/session/staging state excluded. | Resolved |
| REV-027 | P2 | Some product, interface, and delivery inventories described only an asynchronous Outreach worker and omitted its synchronous core control-plane module/API. | Reconciled the boundary: the core owns campaign/template/enrollment/eligibility/evidence commands; the isolated worker owns provider delivery and callback adapters. | Resolved |
| REV-028 | P2 | Unqualified migration “Phase 0-7” names collided with product delivery “Phase 0-5,” where the same phase number meant different work. | Renamed migration stages `M0`-`M7`; product delivery retains Phase 0-5 terminology. | Resolved |
| REV-029 | P2 | The migration schema defined signed abort and close states, but the operational cutover procedure did not require `ABORTED_TO_SOURCE` or `CLOSED` markers. | Required a signed abort marker after source replay and before traffic resumes, and a signed close marker only after every successful replay/checkpoint reconciliation. | Resolved |
| REV-030 | P2 | The concise and governing repository trees disagreed on Docker infrastructure and the flat governing document set. | Reconciled both trees; optional future documentation subdirectories are additive and do not replace the named governing files. | Resolved |
| REV-031 | P1 | Audit export stored only a query hash, so an approved worker/retry could not reconstruct the exact bounded query, and the API lacked an approval transition. | Added an envelope-encrypted immutable canonical query snapshot, approval bound to exact job version/hash by an independent approver, approve/reject API, and narrow worker decryption. | Resolved |
| REV-032 | P1 | Product expected automatic critical-result notification, but schema/API allowed manual creation and did not make it atomic with result release. | The guarded release now evaluates the approved rule and atomically creates a unique notification thread, initial event, audit, and outbox; no public manual-create route remains. | Resolved |
| REV-033 | P1 | Registration/correction case state and Document/OCR/Outreach workflow state were described as mutable fields despite the universal immutable-state rule. | Added stable headers, immutable versions/events, append-only safety/job/delivery evidence, and explicitly limited mutable fields to fenced leases or rebuildable guarded projections. | Resolved |
| REV-034 | P1 | Current-only exclusivity for practitioner links and primary FHIR mappings was stated over immutable historical versions, which PostgreSQL cannot constrain without blocking history. | Added guarded current reservation/projection tables tied to exact versions; history remains immutable while current uniqueness is locally enforceable. | Resolved |
| REV-035 | P1 | FHIR mapping creation/read could race an Identity merge or retain a stale primary reservation after graph change. | Bound mappings to graph component/revision; graph transitions update them atomically or install fail-closed reconciliation holds before commit, followed by locked reviewed reconciliation. | Resolved |
| REV-036 | P2 | Critical notification cardinality was singular in the API but keyed by result-version/rule in the schema, which could hide parallel rules or amended-version history. | Defined one thread per immutable result version, immutable triggered-rule children, plural history/direct-read routes, and created/opened event vocabulary. | Resolved |
| REV-037 | P1 | A FHIR replacement mapping could reference another audience and leak a partner-specific opaque logical ID. | Added same-audience composite keys/FKs across mappings, replacement links, reservations, and events. | Resolved |

## 2. Residual approval risks

The review intentionally does not guess unresolved business or regulatory
decisions. Work remains blocked, by context, until owners approve:

- canonical HID and global-versus-federated identity jurisdiction;
- tenant, custodian, cross-tenant, consent/legal-basis, break-glass, correction,
  retention, legal-hold, and erasure rules;
- authentication/session providers, regions, vendors, RTO/RPO, capacity, and
  downtime behavior;
- clinical state machines, terminology, Lab QC/release and critical-result
  policy;
- OCR/AI and Outreach provider/data-use boundaries;
- Pharmacy clinical, jurisdictional, inventory, and controlled-drug governance;
  and
- live retired hosted identity backend inventory, source custody, reconciliation, rehearsals, and
  cutover evidence.

These are approval gates, not undocumented implementation assumptions.

## 3. Verification performed

The final documentation pass checks:

- one HID and no shadow patient source of truth;
- immutable/versioned authoritative state and correction history;
- complete authorization inputs, dual tenant/custodian scope, and RLS
  fail-closed behavior;
- PHI-safe API, URL, logging, storage, event, and export rules;
- atomic domain/audit/outbox semantics;
- Lab execution, custody, release, and critical-result evidence;
- idempotent asynchronous work and exact callback reconciliation;
- context-specific delivery gates and migration single-writer behavior; and
- cross-document route, state, deployment, and terminology consistency.

Executable DDL, application code, infrastructure, load tests, penetration
tests, clinical validation, restore drills, and live migration rehearsals remain
future gated implementation evidence.
