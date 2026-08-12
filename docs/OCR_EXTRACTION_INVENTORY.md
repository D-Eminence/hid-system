# OCR Physical Extraction Inventory

Date: 2026-08-11  
Status: implemented in repository; external environment verification pending

## Scope and governing rule

This inventory records the evidence used to move the existing OCR HTTP
application boundary from the EHR process to `services/ocr-api` on port 3005.
The extraction preserves existing OCR behavior. It does not add a provider,
document class, patient-matching strategy, storage model, clinical target, or
automatic clinical-save path. Applied migrations `0001` through `0025` remain
unchanged.

Classification terms:

- `MOVE`: OCR API-owned code physically belongs in the standalone API.
- `KEEP`: the code has a different active owner and should remain in place.
- `SHARED CONTRACT`: transport/types used across an explicit service boundary.
- `MIGRATION/PROVISIONING`: immutable schema history or idempotent runtime-role
  administration, not service application code.
- `HISTORICAL/TEST`: evidence only; not an active runtime owner.
- `REMOVE AFTER CUTOVER`: old API registration/code proven dead after the new
  service builds and the gateway route changes.

## Pre-extraction active inventory

| Pre-extraction location | Classification | Decision and current owner |
| --- | --- | --- |
| `ehr/server/src/ocr/ocr.controller.ts` | MOVE | Copied to `services/ocr-api/src/ocr`, verified, then removed from EHR. Public routes are unchanged. |
| `ehr/server/src/ocr/ocr.service.ts` | MOVE + BOUNDARY REFACTOR | Moved to OCR. Direct EHR document reads became typed EHR source calls; in-process note creation became typed EHR publication. OCR SQL now references only `ocr` and `audit`. |
| `ehr/server/src/ocr/ocr.module.ts` | MOVE / REMOVE AFTER CUTOVER | Standalone module is active in OCR. EHR `AppModule` no longer imports it. |
| `ehr/server/src/ocr/dto/*` | MOVE | Validation behavior and public request shapes moved unchanged, except a test coupled to the EHR document-list DTO remained an EHR concern and was not copied. |
| `ehr/server/src/ocr/ocr-lifecycle.ts` and tests | MOVE | Provider-neutral lifecycle rules and negative tests now execute in OCR. |
| `ehr/server/src/ocr/ocr-publication-policy.ts` and tests | MOVE | Existing target/candidate allow-list and fail-closed field validation moved unchanged. |
| `ehr/server/src/ocr/ocr.types.ts` | MOVE | OCR API-local provider-neutral types moved; the worker already had a separate executable contract and does not import this file. |
| `ehr/server/src/ocr-worker/*` | MOVE: OCR WORKER | The then-independent worker was later moved unchanged to `services/ocr-worker` by the backend layout convergence. It imports no OCR API or EHR application modules and starts independently. |
| `ehr/src/components/clinical/OcrReviewWorkspace.tsx` | KEEP: EHR UI | Browser review stays in EHR and consumes the stable gateway URL. |
| OCR types/routes/parsers formerly in `ehr/src/api` | SHARED CONTRACT | Types and route orchestration now come from `packages/api-client/src/ocr.ts`; the EHR adapter supplies its authenticated browser transport. Duplicate OCR parsers/routes were removed. |
| `ehr/server/src/documents/*` | KEEP: EHR | Moved with the EHR API to `services/ehr-api/src/documents`; EHR continues to own document metadata/object evidence. A narrow internal source contract exposes only minimum required fields to OCR. |
| `ehr/server/src/ehr/clinical-notes/*` | KEEP: EHR | Moved with the EHR API to `services/ehr-api/src/ehr/clinical-notes`; EHR remains the only clinical-note writer. |
| `ehr/server/src/integrations/identity-api.service.ts` | KEEP: EHR | Moved with the EHR API to `services/ehr-api/src/integrations`; EHR retains only its own Identity caller. |
| `packages/api-client/src/identity.ts`, `lab.ts`, `pharmacy.ts` | SHARED CONTRACT | Existing caller-specific methods are reused. No handwritten service-to-service HTTP was introduced. |
| `packages/api-client/src/ehr.ts` | SHARED CONTRACT: NEW NARROW BOUNDARY | Exact source evidence and imported-note commands; propagated human and independent workload credentials remain separate. |
| `ehr/server/database/migrations/0013`-`0016`, `0017`, `0023` | MIGRATION/PROVISIONING | The immutable history later moved intact to `services/ehr-api/database/migrations`; it remains one platform ledger. |
| `ehr/server/database/runtime-grants.sql` | MIGRATION/PROVISIONING | Now at `services/ehr-api/database/runtime-grants.sql`; it preserves the same role separation. |
| `ehr/server/database/tests/runtime-roles.integration.sql` | HISTORICAL/TEST | Now at `services/ehr-api/database/tests`; assertions still prove EHR/OCR aggregate separation. |
| `upstream_snapshot`, canonical HTML bundles, and old design/reference files | HISTORICAL/TEST | Searched for active OCR server ownership; none is registered as a runtime path. No files moved. |

No active Outreach-to-OCR API integration exists in this repository. Outreach
campaign, visit, screening, document, OCR, and EHR-ingestion behavior remains
outside the implemented minimum Outreach boundary. No speculative route or
client was created.

## Standalone API ownership

`services/ocr-api` owns:

- user authentication through Identity and facility/permission enforcement;
- patient authorization and break-glass write denial;
- durable job create/read/find/retry commands;
- immutable extraction reads;
- human validation and disposition;
- canonical source-patient confirmation;
- version-bound publication command claims, retry, completion, and failure;
- OCR semantic audit and transactional outbox writes; and
- typed publication orchestration to EHR, Lab, Pharmacy, or document-only.

The API does not read objects or invoke Textract. Liveness is process-only;
readiness probes PostgreSQL only. It can start without the worker.

## Worker ownership preserved

`services/ocr-worker` owns:

- `SKIP LOCKED` job claims, expiring leases, renewal, and per-attempt tokens;
- bounded retry and safe terminal failure;
- exact S3 object version, byte-count, and SHA-256 verification;
- provider selection (`disabled`, test-only deterministic, Textract);
- bounded Textract image/PDF execution and polling; and
- immutable extraction completion through command-only functions.

The worker login inherits only `hid_ocr_worker`, has no table privileges, and
can start without either HTTP API.

## Service and credential graph

```text
Browser/EHR UI -> gateway /api/v1/ocr/* -> OCR API :3005
OCR API -> Identity API :3001 (actor + patient decisions)
OCR API -> EHR API :3002 (exact source; imported draft note)
OCR API -> Lab API :3003 (validated imported evidence)
OCR API -> Pharmacy API :3004 (validated historical medication evidence)
OCR worker -> PostgreSQL command functions (no HTTP API dependency)
```

Each service call preserves correlation, facility, purpose, idempotency where
applicable, bearer or cookie/CSRF/origin user evidence, and a distinct workload
credential. Local orchestration generates independent secrets. Production
configuration requires rotating audience-bound JWT files and rejects local
shared secrets.

## Persistence and double-writer controls

- `hid_ocr_api_runtime` inherits `hid_ocr_runtime` and `hid_audit_writer` only.
- `hid_ehr_api_runtime` inherits `hid_ehr_runtime` and `hid_audit_writer` only.
- `hid_ocr_worker` retains command-only function execution and no table access.
- EHR `AppModule` contains no `OcrModule`; old EHR OCR API files were deleted
  only after the standalone service typechecked, tested, built, and the EHR
  compiled with its replacement boundary.
- The gateway places `/api/v1/ocr` before the generic EHR `/api` fallback.
- The platform graph verifier checks route ownership, unique ports, split
  mutation owners, and absence of direct foreign-domain OCR SQL references.

## Verification and remaining evidence

Repository verification covers shared-client build, OCR typecheck/build/tests,
EHR build/tests including the independent worker, frontend build, platform
graph ownership, unchanged migration plan, and runtime-role SQL assertions.
Exact command results are recorded in `docs/TASK.md` and
`docs/PLATFORM_INTEGRATION_ACCEPTANCE.md`.

External evidence still required:

- environment-specific non-owner EHR/OCR/worker LOGINs;
- production issuer/JWKS/audience/subject and rotating workload token mounts;
- PostgreSQL TLS with the approved CA;
- Docker image build/scan/runtime;
- AWS private networking, S3 versioning, IAM, KMS, and Textract execution; and
- deployment routing/observability and authenticated end-to-end publication.

No production-readiness claim is made from repository-local evidence.
