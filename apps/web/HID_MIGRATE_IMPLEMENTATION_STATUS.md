# HID Migrate implementation status

Date: 20 July 2026

## Implemented locally

| Phase | Evidence |
|---|---|
| 1 - Foundation | Canonical contracts, state machine, module boundary, data dictionary, shared design-system integration |
| 2 - Auth/RBAC/tenancy | Protected routes, project roles/capabilities, active HID membership checks, RLS |
| 3 - Projects/teams/work | Persistent projects, batches, members, assignments, lifecycle commands and pagination |
| 4 - Capture/storage | Private signed capture, source folders/documents/pages/assets, checksums, quarantine and retry |
| 5 - Processing/OCR | Durable leased jobs, retry/dead-letter, image-quality and versioned OCR contracts |
| 6 - Intelligence | Versioned classification/extraction, schemas, confidence, model and source-span provenance |
| 7 - Validation/QA | Exclusive leases, editable corrections, append-only decisions, sampling and separation of duties |
| 8 - Matching | Tenant-qualified identifiers, masked explainable candidates, manual decisions and correction entry |
| 9 - Import | Idempotent per-folder atomic canonical records/versions/files, retry and verification |
| 10 - Patient Folder | Existing HID record route, archive provenance badge and signed source files |
| 11 - Audit/operations | Tenant triggers, immutable evidence, audit taxonomy, correction/cost models and project metrics |
| 12 - Hardening | CI contract verification, SQL schema test, threat model and incident/recovery runbook |
| 13 - Staging/UAT | Isolated synthetic-pilot execution plan and evidence gates |
| 14 - Launch | Controlled pilot, stop/rollback, reconciliation and release-evidence runbook |

| Platform Admin AI update | Platform-only provider/model/routing/budget configuration, encrypted credentials, real connection tests, job configuration pinning, usage events, and Migrate AI/cost/health analytics |

## Verified in this workspace

- `npm run verify:migrate` passes.
- `npm run build` passes.
- `deno check` passes for all eight Migrate Edge Function entry points and their shared dependencies.
- `deno check` passes for the Platform Admin AI API and updated worker routing/credential integration.
- `npm run security:audit` reports zero vulnerabilities.
- Fixture/mock operational routes and placeholder actions were removed from the active Migrate shell.
- `git diff --check` reports only the repository's existing line-ending conversion warnings.

## Intentionally not claimed

- Migrations and SQL tests have not run because no local retired hosted identity backend CLI/Docker or approved staging connection is available.
- Edge Functions/workers have not been deployed or exercised against a live queue/provider.
- No staging or production environment has been changed.
- UAT, penetration testing, load testing, device testing, restore drills, vendor review, and governance approvals remain pending in the release evidence register.
- New unclaimed Patient creation remains blocked pending the canonical account-claim decision.
