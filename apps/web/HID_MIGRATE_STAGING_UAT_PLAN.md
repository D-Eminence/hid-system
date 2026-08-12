# HID Migrate staging and UAT plan

Status: ready for execution after environment and governance approval. This document does not authorize deployment or real patient data.

## Entry criteria

- Separate staging retired hosted identity backend project, private buckets, queue, worker identity, provider credentials, and observability destination.
- Migrate feature disabled by default and enabled only for the approved synthetic pilot organization.
- Approved OCR/AI provider region, retention, no-training terms, and data-processing agreement.
- De-identified or wholly synthetic source documents only.
- Phase 4-12 migrations applied from a clean database and schema tests passing.
- Named UAT owner, clinical/data-governance reviewer, security reviewer, and incident contact.

## Synthetic pilot

- 100 folders and at least 1,000 pages.
- Printed, handwritten, rotated, blurred, blank, duplicate, table, multi-page, and corrupt samples.
- Existing-patient exact identifiers, conflicting identifiers, shared phone, twins/similar names, missing DOB, and no-match cases.
- Every supported canonical document category plus `unclassified`.
- Provider timeout, rate limit, malformed response, worker lease expiry, and dead-letter cases.
- Import partial failure, retry, duplicate request, wrong-match correction, and verification failure.

## UAT journeys

1. Project manager creates and staffs a project, pauses/resumes it, and reviews progress.
2. Scanner captures a folder, reconnects after interruption, reorders pages, and resolves quality warnings.
3. Worker pipeline preserves originals and produces versioned OCR, classification, and extraction.
4. Validator claims, corrects, approves, rejects, and sends back tasks.
5. QA reviewer receives policy samples and independently approves, returns, and escalates.
6. Records officer compares masked, explainable patient candidates and records manual outcomes.
7. Project manager imports eligible folders, retries one failed item, and verifies canonical targets.
8. Authorized provider opens the existing patient-record route and views the archive source badge and signed scan.
9. Security reviewer proves cross-organization, stale-assignment, guessed-ID, and direct privileged-RPC denial.
10. Operations team simulates provider outage, dead-letter replay, feature shutdown, restore, and reconciliation.

## Evidence to capture

- Migration and schema-test logs, build artifact digest, function/worker versions.
- Role-by-role screenshots or recordings using synthetic data.
- Tenant-isolation and signed-URL expiry results.
- Accuracy/confusion metrics by document category and field.
- Matching false-positive/negative results with threshold calibration evidence.
- Queue latency, throughput, retry/dead-letter rate, provider latency/cost, and storage use.
- Import item reconciliation and restore-drill report.
- Accessibility/device matrix and signed issue disposition.

## Exit criteria

- No severity-1 defects and no unresolved critical/high security findings.
- Zero tenant-isolation failures.
- No uncertain automatic identity links.
- All imported items reconcile to canonical records, current versions, files, and provenance.
- Restore drill succeeds within approved RTO/RPO.
- Clinical, records, privacy, security, operations, and hospital UAT owners sign the evidence register.
