# HID Architecture Documentation

This directory contains the architectural source of truth for the HID platform.

Current browser application placement, gateway paths, and offline/PWA
boundaries are recorded in
[`FRONTEND_LAYOUT_CONVERGENCE.md`](FRONTEND_LAYOUT_CONVERGENCE.md).
The same document records the seven-app telemetry policy and current local
browser evidence; [`OFFLINE.md`](OFFLINE.md) and [`SECURITY.md`](SECURITY.md)
remain authoritative for capability and PHI controls.

## Documentation Map

### `PRODUCT.md`

Defines:

* what HID is
* platform goals
* major product domains
* target operating environment
* core product principles

### `ARCHITECTURE.md`

Defines the target system architecture including:

* apps
* services
* API Gateway
* event-driven communication
* database ownership
* frontend strategy
* AWS target architecture
* OCR
* NIN integration
* service boundaries
* observability
* development ports
* future extensibility

### `DECISIONS.md`

Contains Architecture Decision Records.

Significant architectural decisions must be recorded here.

### `INTERFACE_CONTRACT.md`

Defines:

* API conventions
* service boundaries
* required headers
* API versioning
* identity resolution
* OCR interfaces
* EHR interfaces
* Lab interfaces
* Pharmacy interfaces
* Outreach temporary-registration interfaces
* event contracts
* error handling

### `OFFLINE.md`

Defines HID's offline-first architecture for low-connectivity environments.

### `OUTREACH_EXTRACTION_INVENTORY.md`

Records the active/historical Outreach inventory, ownership classification,
direct-access findings, implemented minimum boundary, and deliberately deferred
features.

### `SECURITY.md`

Defines:

* authentication
* authorization
* RBAC
* facility isolation
* audit requirements
* consent
* break-glass
* NIN protection
* file security
* offline security

### `SECRET_ROTATION_AND_BASELINE_READINESS.md`

Defines the pre-release secret-audit scope, value-free rotation inventory,
frontend public-variable policy, Git baseline safety, migration integrity
ledger, and required local/external release gates.

### `CODING_STANDARDS.md`

Defines engineering standards for implementation, refactoring, testing, folder structure, documentation, CI/CD, and code quality.

### `ROADMAP.md`

Defines platform implementation phases and future modules.

### `TASK.md`

Defines the current implementation scope.

This file may change frequently.

### `PLATFORM_INTEGRATION_ACCEPTANCE.md`

Records the current executable service inventory, dependency and ownership
matrices, ports, gateway routing, runtime roles, workload identity,
authorization, idempotency/retry, database isolation, negative tests, health,
build/migration evidence, external verification gaps, and exact next stage.

### AWS deployment foundation

`AWS_DEPLOYMENT_ARCHITECTURE.md` records the synthesized regional AWS topology
and external Cloudflare frontend/edge boundary, parameters, local acceptance
and external evidence. `AWS_IAM_MATRIX.md` maps execution/task/database authority.
`AWS_COST_MODEL.md` identifies environment cost variables without fabricated
totals. `AWS_DEPLOYMENT_RUNBOOK.md` defines account through rollback gates.
`RELEASE_ARTIFACT_GATE.md` and `RELEASE_FINDINGS.md` govern immutable digests,
SBOM/scans and the dependency findings resolved before release.

`TUF-PRODUCTION-IMPLEMENTATION.md` is the canonical trusted-release execution
record. It contains the release surface, TUF trust architecture, exact key and
role boundaries, implementation milestones, verification evidence, staging
gates, blockers, and the explicit production prohibition/status.

### `EVENT_DELIVERY_ARCHITECTURE.md`

Records the active outbox inventory, normalized event envelope, dispatcher
claim/retry and transport semantics, durable consumer inbox transaction rule,
least-privilege roles, operations contract, and acceptance evidence.

### `EVENT_DISPATCHER_DEPLOYMENT_ACCEPTANCE.md`

Records dispatcher image/build-context review, host and PostgreSQL deployment
acceptance, representative non-owner LOGIN and verified-TLS evidence, health,
metrics, SIGTERM, horizontal-scale checks, exact-bus IAM contract, and the
container/AWS evidence that still requires an external environment.

### `SUPER_ADMIN_FOUNDATION.md`

Records the active/legacy admin inventory, explicit platform capability model,
one-time bootstrap, Identity-owned command/API surface, dedicated Admin UI,
facility/principal/audit/operations semantics, migration/runtime-role/RLS
boundaries, local acceptance evidence, and external verification gaps.

### Extraction inventories

`IDENTITY_EXTRACTION_INVENTORY.md`, `LAB_EXTRACTION_INVENTORY.md`,
`PHARMACY_EXTRACTION_INVENTORY.md`, `OUTREACH_EXTRACTION_INVENTORY.md`, and
`OCR_EXTRACTION_INVENTORY.md`
preserve the repository evidence and ownership classification that governed
each physical service cutover.

## Codex Reading Order

For substantial work, Codex should read:

1. `/CODEX.md`
2. `README.md`
3. `ARCHITECTURE.md`
4. `DECISIONS.md`
5. `INTERFACE_CONTRACT.md`
6. relevant security/offline standards
7. `TASK.md`

`CODEX.md` contains permanent operating rules.

`TASK.md` contains temporary implementation objectives.

## Documentation Rule

Implementation and documentation must remain synchronized.

A significant architecture change must update:

* Architecture
* Decisions
* Interface Contract when interfaces change
* Security when security boundaries change
* Offline architecture when synchronization behavior changes
* Roadmap when implementation phases change

Documentation updates are part of implementation, not optional cleanup.

### Phase C staging preparation

- [Execution sequence and binary acceptance](TUF-STAGING-EXECUTION.md)
- [GitHub protection and CI evidence](TUF-CI-PROTECTION.md)
- [Identifier binding and irreversible infrastructure plan](TUF-STAGING-INFRASTRUCTURE.md)
- [Synthetic migration, restore and forward rollback](TUF-STAGING-MIGRATION.md)
