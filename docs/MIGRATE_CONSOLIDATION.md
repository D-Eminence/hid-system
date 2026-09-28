# HID Migrate consolidation

Date: 2026-09-28

## Canonical product

HID Migrate is the `apps/ocr` application, publicly served at:

`https://migrate.healthidentitydirectory.com/`

Its user-facing name is Migrate. Its internal OCR APIs, services, permissions,
database fields, telemetry identifiers, processing worker, and typed
`/api/v1/ocr/*` contract remain unchanged.

The Cloudflare production build sets `HID_PUBLIC_BASE=/` for `apps/ocr`. The
local one-origin developer gateway intentionally retains `/migrate/` as a
convenience mount; it is not the canonical public URL.

## Comparison and decision

| Area | `apps/ocr` domain application | Former Web `/migrate/*` feature |
| --- | --- | --- |
| Backend | Active OCR API and OCR worker | Retired `migration-*` function-gateway endpoints only found in reference material |
| Access | Shared Identity cookie/CSRF session; active facility; `ocr.job.read`, plus `ocr.job.write` for create/retry | Prototype project and role model with no active owning service |
| Supported workflow | Exact document/job lookup, governed job creation/retry, extraction metadata, validation/publication state, contextual EHR handoff | Projects, capture/uploads, queues, review/QA, matching, imports, reports, and operations |
| Runtime status | Active and architecture-aligned | Removed: its unique flows could not safely operate without restoring unsupported persistence, API, and worker contracts |

They were different implementations, not two UIs over the same backend. The
active `apps/ocr` implementation is the single consolidated base. The Web
feature source, its routes, lazy loading, session/SEO branches, and source-only
verification script were removed so there is no second executable Migrate
application. No active OCR processing or backend contract was duplicated or
rewritten.

## Public routing

| Incoming URL | Result |
| --- | --- |
| `https://migrate.healthidentitydirectory.com/` | Canonical Migrate dashboard |
| `https://migrate.healthidentitydirectory.com/jobs/123?view=safe` | Direct Migrate deep link |
| `https://migrate.healthidentitydirectory.com/migrate/jobs?view=safe` | One 308 redirect to `/jobs?view=safe` |
| `https://migrate.healthidentitydirectory.com/ocr/jobs?view=safe` | One 308 redirect to `/jobs?view=safe` |
| `https://ocr.healthidentitydirectory.com/jobs?view=safe` | One 308 redirect to `https://migrate.healthidentitydirectory.com/jobs?view=safe` |
| `https://ocr.healthidentitydirectory.com/api/v1/ocr/jobs?view=safe` | One 308 redirect retaining `/api/v1/ocr/jobs?view=safe` |

Legacy Web-only prototype paths have no active backend equivalent and redirect
to the Migrate root rather than exposing a dead second application. Redirects
preserve query strings and are constructed from configured origins, not request
supplied redirect targets.

## Configuration boundaries

The production and staging Cloudflare Worker profiles, generated AWS browser
CORS origins, Turnstile hostname/action validation, release configuration, and
staging-readiness checks use the Migrate hostname. The old OCR hostname remains
only as an explicit redirect source; it is not reintroduced as a CORS origin or
an application host.

This consolidation performs no deployment, DNS change, AWS change, live API
call, or data migration.
