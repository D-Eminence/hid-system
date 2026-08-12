# Frontend layout convergence

Status: implemented and verified locally on 2026-08-11; authenticated external,
representative-device, Docker, and deployment evidence remain pending.

## 2026-08-12 production-host addendum

Each canonical app is now an independent Cloudflare Workers Static Assets
deployment at `www`, `ehr`, `lab`, `pharmacy`, `ocr`, `outreach`, or `admin`
under `healthidentitydirectory.com`. Every app is built with production base
`/`, owns its root-scoped service worker, and proxies only same-origin
`/api/v1/*` to the fixed AWS API origin. The path bases and ports below remain
the local one-origin development/preview contract; they are not production
frontend hosting paths. AWS Gateway contains no frontend artifacts.

This is the authoritative browser-application inventory. It supersedes older
active-location references to `identity/hid-unified-package/`, top-level `ehr/`,
and ADR-030's temporary decision to leave Pharmacy without an application.

## Canonical applications

| Application | Canonical source | Gateway path | Direct port | Authentication and service boundary | Offline/PWA result |
| --- | --- | --- | --- | --- | --- |
| Web | `apps/web` | `/` | 3100 | Identity-owned browser session; same-origin Identity/EHR gateway APIs | Installable root-scoped PWA, static shell only, visible connectivity; no broad patient-record cache |
| EHR | `apps/ehr` | `/ehr/` | 3101 | Canonical EHR reference plus build-checked typed Identity/EHR integration; contextual clinical OCR review remains here | Installable `/ehr/` PWA; canonical platform runtime provides shared telemetry and connectivity; no API caching or new offline mutation outbox |
| Lab | `apps/lab` | `/lab/` | 3102 | Shared Identity cookie/CSRF session; `lab.work-item.read`; `/api/v1/lab/*` only | Installable `/lab/` PWA and honest offline shell; result mutations remain live-only and never appear verified/released offline |
| Pharmacy | `apps/pharmacy` | `/pharmacy/` | 3103 | Shared Identity cookie/CSRF session; `pharmacy.work-item.read`; `/api/v1/pharmacy/*` only | Installable `/pharmacy/` PWA; work context is memory-only; dispensing/reversal are disabled offline and become complete only after API confirmation |
| Outreach | `apps/outreach` | `/outreach/` | 3104 | Shared Identity session; `/api/v1/outreach/*`; Identity remains the only canonical patient/HID authority | Strongest offline workflow: installable PWA plus encrypted IndexedDB command outbox, temporary IDs, stable idempotency, retries/conflicts, reauthorization, and acknowledged-PHI cleanup |
| OCR | `apps/ocr` | `/ocr/` | 3105 | Shared Identity cookie/CSRF session; `ocr.job.read`/`ocr.job.write`; `/api/v1/ocr/*` only | Installable `/ocr/` PWA and honest offline shell; no fake extraction, provider, validation, or publication success and no raw OCR payload display |
| Admin | `apps/admin` | `/admin/` | 3106 | Identity-owned platform capabilities; `/api/v1/admin/*` only | Installable `/admin/` PWA and visible connectivity; sensitive mutations require live authoritative connectivity and are never queued offline |

Every production browser API URL is same-origin. Direct ports are loopback
development/preview surfaces, not production API targets. The gateway matches
UI prefixes independently from `/api/v1/pharmacy/*` and `/api/v1/ocr/*`.

## Current classification

### ACTIVE

* The seven `apps/*` applications in the table above.
* `packages/ui`, `packages/api-client`, `packages/identity-browser-client`,
  `packages/offline`, `packages/telemetry`, and `packages/config`.
* Root gateway, port registry, grouped development launcher, production build,
  frontend verifier, and production-preview launcher.

### REUSABLE

* `packages/offline` connectivity, sync vocabulary, durable command envelope,
  idempotency, retry/conflict classification, non-extractable AES-GCM helpers,
  and scoped service-worker registration.
* `packages/telemetry` Sentry/PostHog initialization, app identity, event/property
  allowlists, PHI redaction, replay disablement, and safe React error boundary.
* `packages/ui` connectivity/sync states and non-domain layout primitives.
* Existing Outreach encrypted IndexedDB behavior, retained rather than rewritten.

### TRANSITIONAL

* `apps/ehr/ehr.html` remains the exact local visual/reference entry. Its
  dedicated bundled platform runtime supplies scoped PWA, connectivity, and
  shared telemetry without treating reference actions as durable server truth.
  The typed EHR application/API integration remains the production integration
  path and is build-checked.
* Web retains product-specific portal surfaces while authentication and domain
  persistence continue converging on the current Identity/API boundaries.

### LEGACY

* `identity/hid-unified-package/`, top-level `ehr/`, and `upstream_snapshot/`
  are historical/reference sources only. They do not override `apps/*` and are
  not launched by root orchestration.
* Historical Pharmacy POS and OCR/Migrate screens may inform terminology or
  visual comparison but are not copied into an authoritative workflow.

### DEAD

* The EHR "Pharmacy unavailable" placeholder as the only Pharmacy product
  surface, the former missing standalone Pharmacy decision, and any claim that
  OCR operations are represented solely by an EHR navigation card.
* Direct browser database clients, internal service-port calls, broad API
  service-worker caching, and independent Pharmacy/OCR authentication stores.

## Domain truth and route behavior

Pharmacy preserves `prescribed != accepted != dispensed != administered`.
It implements real incoming/accepted/history, dispensing/reversal, imported
historical medication evidence, patient-scoped lookup, and operational activity
using existing Pharmacy API responses. Inventory, refills, administration, and
unsupported aggregate metrics are not fabricated.

OCR Operations implements job/document lookup, job creation/retry, extraction
metadata, validation state, and publication state supported by the OCR API. It
does not expose raw extracted text to analytics and does not claim global queue,
provider readiness, automatic patient creation, or offline OCR success. EHR
continues contextual clinical review.

Direct route refresh is supported for the app bases and implemented nested
routes, including `/pharmacy/prescriptions` and `/ocr/jobs`.

## Shared offline and telemetry boundaries

`offline-aware != offline-authoritative`. All apps expose connection state and
scoped static shells. Only Outreach currently persists a governed offline
mutation outbox. Pharmacy, OCR, Lab, and Admin fail safely rather than queueing
unsupported/high-risk commands. No worker caches `/api/` responses.

Sentry is technical error/performance observability. PostHog is allowlisted
product analytics. Neither is a clinical data store. Session replay, automatic
capture, pageview capture, and durable analytics persistence are disabled.
Request/response bodies, URLs, identity, clinical/OCR/Lab/medication content,
tokens, cookies, headers, and free-form context are removed or never accepted.
Telemetry initialization and delivery are fail-open for product workflows.

## Verification and commands

```bash
npm run dev
npm run dev:frontends
npm run preview:frontends
npm run build
npm run test:pharmacy
npm run test:ocr
npm run verify:offline
npm run verify:telemetry
npm run verify:frontends
npm run verify:platform-graph
```

Local evidence includes all seven production builds, the canonical root build,
Pharmacy 36 tests, OCR 13 tests, shared static contract checks, Outreach's
encrypted-outbox regression, nine gateway route renders (including nested
Pharmacy/OCR refreshes), and a clean-profile desktop Chrome offline run for all
seven scoped workers. It does not constitute authenticated deployment or
representative phone/tablet acceptance.
