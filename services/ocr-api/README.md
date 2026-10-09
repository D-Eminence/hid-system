# HID OCR API

Independent NestJS service owning OCR job, extraction-read, human-validation,
patient-confirmation, publication-command, audit, and outbox orchestration under
`/api/v1/ocr/*`. Local development uses port `3005`. Liveness and
PostgreSQL-backed readiness are `/api/v1/health/live` and
`/api/v1/health/ready`; neither depends on Textract or on an OCR worker.

The API uses `OCR_DATABASE_URL` through a login that inherits only
`hid_ocr_api_runtime`. It never reads or mutates EHR, Lab, Pharmacy, Outreach,
or Identity persistence directly. Human authentication and patient
authorization use Identity over the shared typed client. Exact source-document
evidence and EHR clinical-note publication use the typed EHR client. Lab and
Pharmacy publications use their owning typed clients. Each downstream call
propagates the human credential and carries an independent `ocr-api` workload
identity; production rejects local shared secrets and requires mounted,
audience-bound workload JWTs.

The OCR extraction worker remains a distinct process at
`services/ocr-worker`. It uses only the lease-bound `hid_ocr_worker`
database commands and can start without this API or the EHR API. Likewise this
API can start without the worker. Provider selection, object reads, Textract
polling, leases, retries, and immutable extraction writes remain worker-owned.

Run `npm run start:dev`, `npm test`, `npm run typecheck`, or `npm run build` in
this directory. The authoritative platform documents define deployment,
security, persistence, and interface ownership.
