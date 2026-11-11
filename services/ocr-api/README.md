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
patient, for every target (`docs/INTERFACE_CONTRACT.md` section 39). A caller
who can read the job but has no such grant (for example under the
records-processing cover) gets `403 OCR_PUBLISH_NEEDS_DIRECT_CARE` ("Ask a
clinician with access to this patient to publish it."); one who cannot read the
job, and a break-glass write, get `404 OCR_JOB_NOT_FOUND` (an EHR 403 on the
source read is now this 404 too, rather than EHR's own code). A refusal at an
execution attempt (a grant gone after the request) fails the publication with
`OCR_PUBLISH_NEEDS_DIRECT_CARE` in place of `OCR_JOB_NOT_FOUND`.

## Review outcomes (phase 1: measure)

So the reading can learn from live reviews without keeping patient text, every
validation stores a content-free comparison of the AI reading and the review in
`ocr.validations.provenance.reviewOutcome` (schema
`hid.ocr.review-outcome/v1`) and in the `ocr.validation.accept` / `.reject`
audit details (`src/ocr/quality/review-outcome.ts`; contract in
`docs/INTERFACE_CONTRACT.md` section 15). Counts are bucketed by item kind,
decision, AI confidence, hard page, `readBy`, check-reason code and field-change
class. Field comparisons use `src/ocr/quality/normalise.ts`, a port of the OCR
accuracy kit's `lib/normalise.mjs` (`normalise.spec.ts` carries its test
vectors; keep the two in step). Reviews saved as whole text (EHR notes, the
legacy single medicine, medicine or lab lists without `itemId`) are marked
`estimated`. That estimate runs inside the save transaction, so its work is
bounded: the saved text is tokenised once, a word found nowhere in it settles
an item at once, word-pair results are cached, and at most 300 items are
checked within 1,000,000 word comparisons and 2,000,000 edit-distance cells
(the rest count `notChecked`; worst case a few hundred milliseconds).
`onPrepared` follows the kit's `onPage` rule with two deliberate differences: a
value with no words is not found, and it can answer "not checked". The stored outcome is
kept under 16 KB (the audit details row has a 64 KB check): check-reason counts
are dropped first (`checkReasonsDropped`), then `summary_too_large`. The
extraction is read inside a savepoint and the computation is wrapped, so a
failure stores `{ schema, error: 'summary_failed' }` and the review is saved
anyway; the log line `ocr.review_outcome.failed` carries a code and the
job id only.

The 7-day source purge (0112) blanks `validated_payload`, `accepted_fields`,
`rejected_fields`, `corrections` and `reason`; it keeps `provenance`, so review
outcomes outlive the content they were computed from.

`GET /api/v1/ocr/quality/summary?from=&to=` is for platform administrators
(`platform.admin.access` and `platform.operations.read`) and for a facility's
own manager (`workforce.manage` in their membership at the facility named by
`X-Facility-ID`, never at another facility, and not while the facility awaits
Health ID support's review). A manager gets `{ available: false, reason:
'too_few_reviewers' }` unless at least 3 distinct reviewers contributed in the
range, any group with fewer than 3 distinct reviewers is suppressed, and the
range ends at the last finished ISO week (a cut-off last week is left out);
reviewers are counted by a random per-request key, never by id. It sums review
outcomes by ISO week, facility, kind and prompt version, widens the range to
whole ISO weeks, returns groups under 20 items as suppressed, leaves out reason
counts under 5 inside shown groups (`smallCellsHidden`), and has no per-reviewer
figures. Figures from one or two reviewers would in effect be theirs, so a
manager never sees a group with fewer than 3 distinct reviewers, nor a week
still filling up (no staff monitoring); platform administrators do. `ocr.validations`
row-level security admits only `platform.current_facility_id()`, and the
runtime role has no cross-facility policy, so the summary covers the facility
named by `X-Facility-ID`, where the reader (administrator or manager) must be active. A
cross-facility summary would need an aggregate-only `SECURITY DEFINER` function
(as 0027's admin audit read) and is not part of this phase.

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
