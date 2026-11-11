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
database commands and the aggregate-only queue metrics command and can start without this API or the EHR API. Likewise this
API can start without the worker. Provider selection, object reads, Textract
polling, leases, retries, and immutable extraction writes remain worker-owned.

Publication (`POST /api/v1/ocr/validations/:validationId/publications`) writes
validated OCR evidence into EHR, Lab or Pharmacy. It answers
`503 OCR_PUBLICATION_PAUSED` when `OCR_PUBLICATION_ENABLED=false`. It is on by
default since the owner turned OCR publication on in production (2026-10-31);
job, validation and patient confirmation do not depend on it.

Publishing needs the publisher's own direct-care `write_records` grant on the
patient, for every target (`docs/INTERFACE_CONTRACT.md` section 37). A caller
who can read the job but has no such grant (for example under the
records-processing cover) gets `403 OCR_PUBLISH_NEEDS_DIRECT_CARE` ("Ask a
clinician with access to this patient to publish it."); one who cannot read the
job, and a break-glass write, get `404 OCR_JOB_NOT_FOUND` (an EHR 403 on the
source read is now this 404 too, rather than EHR's own code). A refusal at an
execution attempt (a grant gone after the request) fails the publication with
`OCR_PUBLISH_NEEDS_DIRECT_CARE` in place of `OCR_JOB_NOT_FOUND`.

## Paper readings (`hid-paper-reading-v2`)

The worker writes `provenance.processingContract` `hid-textract-v2` and a
`structured_payload` of contract `hid-paper-reading-v2`
(`src/ocr/reading/paper-reading.contract.ts`, a byte-for-byte copy of the
worker's `src/reading/contract.ts`; `reading-versions.spec.ts` pins the copy,
the processing contract and `PROMPT_VERSION` to the worker's files).

**Reuse.** `POST /api/v1/ocr/jobs` reuses an earlier job for the same source
object version, SHA-256 and provider only when it has an extraction with
`processingContract` `hid-textract-v2`, payload contract
`hid-paper-reading-v2` and `provenance.reading.promptVersion` equal to the
current `PROMPT_VERSION`. Old `hid-textract-v1` work and readings from an
older prompt are never reused. `OCR_AI_MODE` (`off` | `claude`, default
`off`) mirrors the worker's flag and must be set to the same value: with
`claude`, an extraction whose `reading.status` is `ai_off` or `ai_failed` is
never reused, so a new job reads the paper with AI. This API never calls
Claude. The worker's `OCR_AI_FACILITY_IDS` off-switch is not mirrored: a
switched-off facility gets a fresh Textract run instead of a reuse.

**Extraction list.** `GET /api/v1/ocr/jobs/:jobId/extractions` answers
`{ items: [...] }`; each item is `id`, `version`, `attempt`, `provider`,
`providerModel`, `rawText`, `confidence` (number or null), `createdAt`,
`structuredPayload` (the payload re-parsed through its contract: v2 exactly
as the contract defines it, v1 as `{ pages: [{ page, text, confidence }] }`,
`{}` when unreadable), `provenance` (versions, models, status and counts
only: `processingContract`, `adapter`, `operation`, `pageCount`, `lineCount`,
`sourceVersionBound`, `reading.{contract, status, promptVersion,
schemaVersion, firstPassModel, rereadModel, itemCount, flaggedPages,
droppedUngrounded}`; never token usage, geography or failure detail) and
`paperReading`, the view the check screen reads:

- `contract`: `hid-paper-reading-v2`, `hid-textract-v1`, or `null` when the
  stored payload breaks the contract (an unknown key, such as raw model
  output, or a broken rule); then nothing from it is shown.
- `pages[]`: `page`, `text` (v2: the page's line texts joined by newlines),
  `flagged`, `flagReasons`, `lines[]` (`id`, `text`, `box`, `confidence`,
  `handwritten`). v1 pages have `flagged: false` and no lines.
- `identity`: `nameAsWritten`, `dateOfBirthAsWritten`,
  `folderNumberAsWritten`, `sexAsWritten`, `lineIds`, `box` (null for v1).
- `items[]`: `id`, `kind`, `asWritten`, `plain`, `dateAsWritten`, `page`,
  `lineIds`, `box{left,top,width,height}`, `confidence`
  (`clear` | `check_carefully`), `checkReasons`, `checkReason`, `fields` (by
  kind), `prescription`, `readBy` (empty for v1).
- `reading`: `status`, `firstPassModel`, `rereadModel`, `rereadPages`,
  `droppedUngrounded`, `itemCount`, `promptVersion`, `schemaVersion` (null
  for v1).

Run `npm run start:dev`, `npm test`, `npm run typecheck`, or `npm run build` in
this directory. The authoritative platform documents define deployment,
security, persistence, and interface ownership.
