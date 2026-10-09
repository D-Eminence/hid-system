# Retired Web Migrate implementation status

Status: retired on 2026-09-28 during Migrate consolidation.

The former Web `/migrate/*` implementation has been removed from this package.
It was a broad prototype for projects, capture, processing, review, matching,
imports, and operations that called retired `/api/v1/functions/migration-*`
endpoints. Those endpoints, persistence contracts, and worker ownership do not
exist in the active platform, so retaining it would leave a second unsupported
Migrate application.

The single active HID Migrate product is `apps/ocr`, served at
`https://migrate.healthidentitydirectory.com/`. It uses only the active typed
`/api/v1/ocr/*` API, shared Identity session/CSRF handling, and OCR permissions.
It supports governed job/document lookup, job creation and eligible retry,
extraction metadata, validation/publication state, and contextual EHR review
handoff. Internal OCR names and backend contracts remain unchanged.

See [`../../docs/MIGRATE_CONSOLIDATION.md`](../../docs/MIGRATE_CONSOLIDATION.md)
for the comparison, redirect behavior, and current architecture. Historical
prototype planning material remains under `upstream_snapshot/`; it is not a
runtime implementation or deployment plan.
