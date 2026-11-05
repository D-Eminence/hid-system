# HID OCR Worker

Independent non-HTTP worker for lease-bound OCR extraction. It has no EHR API
or OCR API application imports and can run while both HTTP services are
stopped. It claims work only through the exact `ocr` security-definer command
surface using a login that inherits `hid_ocr_worker`; that role has no table
privileges. Every command also requires `OCR_WORKER_SUBJECT` (set as
`app.actor_subject`) to be an active account holding the platform `ocr_worker`
role, or it answers 42501; in production that is `hid:staging:ocr-worker`,
seeded by migration 0106. Queue depth and the oldest queued age, logged with each claim, come
from the aggregate-only `ocr.worker_queue_metrics()` (migration 0082).

The worker preserves `SKIP LOCKED` claims, expiring and renewable leases,
per-attempt tokens, bounded retry, exact S3 object-version/size/SHA-256
verification, provider isolation, and immutable completion/failure commands.
It never publishes clinical truth and exposes no network port.

Use Node.js 22 or newer and configure from `.env.example` through injected
process environment. The executable does not load env files itself.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm start
```

`OCR_PROVIDER=disabled` fails closed without claiming work. The deterministic
`test` provider is accepted only with `NODE_ENV=test`; production requires
Textract, PostgreSQL TLS with a trusted CA, private versioned S3, least-
privilege IAM, and the approved KMS policy. The root development launcher runs
this worker only when `OCR_WORKER_DATABASE_URL` and a non-disabled provider are
explicitly configured.

## Reading paper records (text reading v2 and the AI step)

Each claimed job runs, in order:

1. **Exact source.** The S3 object version is read and its size and SHA-256
   verified before anything is charged.
2. **Page allowance** (migration 0107). `ocr.worker_page_allowance` is checked
   first. When the facility has used this Africa/Lagos month's pages (default
   500, Textract and AI counted together), `ocr.pause_worker_job_for_allowance`
   requeues the job until the allowance resets without using an attempt, and
   the worker logs `ocr.job.paused_for_allowance` (job id, correlation id,
   resume time only). A retry whose pages are already counted is never paused,
   and a pause that answers NULL (the limit was raised meanwhile) lets the
   worker read the job. Review and manual entry are unaffected.
3. **Text reading v2** (processing contract `hid-textract-v2`).
   `OCR_TEXTRACT_FEATURES` picks the Textract API (coordinator decision on
   cost):
   - `text` (default, cheapest): PNG and JPEG go to `DetectDocumentText`
     (synchronous, `Document.Bytes`); PDF and TIFF to
     `StartDocumentTextDetection` / `GetDocumentTextDetection`. Provider model
     `amazon-textract-detect-document-text`.
   - `layout`: `AnalyzeDocument` / `StartDocumentAnalysis` /
     `GetDocumentAnalysis` with `FeatureTypes: ["LAYOUT"]` only, whose layout
     blocks give a better reading order on multi-column pages. Provider model
     `amazon-textract-analyze-document-layout`.

   `FORMS` and `TABLES` are never requested. PDF and TIFF are read
   asynchronously from the exact S3 object version (`VersionId`) with a
   deterministic `ClientRequestToken` (source object, processing contract,
   operation and features), polled every `OCR_TEXTRACT_POLL_MS` and paged
   through with `NextToken`. Both modes give the same line output: each line
   keeps its id (`p<page>-l<n>`, in reading order), page, box (page fractions,
   4 dp), confidence (least legible `WORD`, 0-1) and a handwriting flag (any
   `WORD` with `TextType` `HANDWRITING`). Provenance records the operation and
   features. More than `OCR_TEXTRACT_MAX_PAGES` (20) pages fails the job
   terminally with `DOCUMENT_TOO_MANY_PAGES`. Throttling is retried in the
   call with full-jitter backoff (`OCR_TEXTRACT_MAX_RETRIES`).
4. **Pages recorded.** `ocr.record_worker_pages` counts the pages read, always,
   even with AI reading off (idempotent per job).
5. **AI step** (`src/reading/`, only when `OCR_AI_MODE=claude` and the facility
   is in `OCR_AI_FACILITY_IDS` when that is set). One Claude API request per
   page with the frozen, cached system prompt (`hid-paper-reading-prompt-2`,
   model schema `hid-paper-reading-model-schema-2`),
   structured JSON output, adaptive thinking, `inference_geo: "us"`, the
   page's lines without boxes, and 11-digit NIN-like numbers and Nigerian phone
   numbers masked. The client always calls `https://api.anthropic.com` (an
   inherited `ANTHROPIC_BASE_URL` is ignored) and owns its retries: 429, 5xx,
   529 and connection errors back off with full jitter honouring
   `retry-after`; 400/401/403/404 are not retried. A refusal on the first pass
   is asked again on the re-read (by default the same model and effort as the
   first pass, so a second refusal is likely); a page declined both times is
   flagged `ai_declined`.
6. **Grounding** (`src/reading/grounding.ts`, `items.ts`, pure functions). An
   item citing no line, a line not on its page, or whose `asWritten` is not in
   its cited lines (whole words and whole numbers) is dropped and only
   counted. Every kept item gets check reasons (dose, frequency, route, value
   or unit not as written, corrected wording, lines not together, inactive
   status or status words, date not on the page or ambiguous, low OCR
   confidence, handwriting) and one plain sentence for the check screen. An
   allergy's `severity` (`mild`, `moderate`, `severe`, `unknown` or `null`)
   is filled only when the paper says how bad; a `mild`, `moderate` or
   `severe` whose word is not on the cited lines (`anaphyla...` also counts
   for `severe`) gets `field_not_on_paper`. Item ids are `it-` and 16 hex
   characters from the source, kind, cited lines and `asWritten`, unique
   within one extraction: an exact repeat (same kind, lines, `asWritten` and
   fields) collapses to one; two different items with the same base id are
   both kept, the later ones (reading order: page, then first cited line)
   suffixed `-2`, `-3`, ..., each marked `check_carefully` with
   `duplicate_source_span`, and the page flagged `possible_missed_item`.
7. **Re-read.** A page is re-read once by `OCR_AI_REREAD_MODEL` when the model
   was unsure, an item was dropped, a cited handwritten line was below 0.80, or
   at least 30% of its items need checking for a reason other than legible
   handwriting (at most `OCR_AI_MAX_REREAD_PAGES` per document). If the re-read
   fails, the first-pass items are kept as `check_carefully` with
   `reread_failed`.
8. **Completion.** `ocr.complete_worker_job` stores the `hid-paper-reading-v2`
   payload (schema `hid-paper-reading-schema-2`: `src/reading/contract.ts`), `raw_text` (every line in
   reading order) and the mean line confidence. Provenance holds models,
   prompt and schema versions, counts, token usage and inference geography,
   never document text. No raw model output and no text of a dropped item is
   stored.

Failure states: when the AI step stays unavailable after its retries the job
retries with `AI_UNAVAILABLE` (60 s) until its last attempt, which completes
with `reading.status: "ai_failed"` and no items so staff can enter the record
by hand. A rejected request (key, permission, model) also completes as
`ai_failed` and logs only the code. With AI off the job completes as `ai_off`;
a document with no text as `no_text`.

## Fair claiming and call limits

- **Fair claim** (migration 0107). Claim loops call `ocr.claim_worker_job_fair`
  (same authorization, validation, lease recovery and eligibility as
  `ocr.claim_worker_job`, which stays as it was) with
  `OCR_WORKER_MAX_INFLIGHT_PER_FACILITY` (default 2, 1-16): a facility that
  already has that many jobs processing under a live lease is skipped, and the
  facility with the fewest processing goes first, so one facility's large
  upload cannot hold every claim loop while other facilities wait.
- **Claude API limit.** `OCR_AI_MAX_CONCURRENT_REQUESTS` (default 4, 1-32)
  requests in flight for the whole process, shared by every claim loop and every
  page. Inside it, `OCR_AI_PAGE_CONCURRENCY` (default 2, 1-8) pages of one
  document are read at once; after a page fails no further page starts.
- **Textract limit.** `OCR_TEXTRACT_MAX_CONCURRENT` (default 2, 1-16) Textract
  calls in flight for the whole process.
- A permit is held for one API call only: never across a backoff sleep, a
  `retry-after` wait or a Textract poll delay. Waiting for one does not stop
  the lease renewal (every third of `OCR_WORKER_LEASE_SECONDS`), and shutdown
  ends the wait without a call. Keep `OCR_WORKER_LEASE_SECONDS` long enough for
  a document's pages to wait their turn.
- **AI use recorded.** After the AI step and before completion the worker calls
  `ocr.record_worker_ai_usage` once per model used (requests, input, output,
  cache-read and cache-write tokens; counts only, no text), idempotent per job,
  attempt and model. Every HTTP request counts, including those of a call that
  ended in an error (overloads, timeouts, rejections, a failed re-read), with
  any tokens the API had already reported on a cut-off stream. An attempt
  retried with `AI_UNAVAILABLE` records what it used first, and so does a job
  stopped mid-reading by shutdown or an unexpected error (before it is failed,
  while the claim is still held). A failure to record is logged as
  `ocr.reading.usage_record_failed` (job id, correlation id, model, code) and
  never fails the job. Platform administrators read the month's use per
  facility in the Identity API (`GET /admin/facilities/:facilityId/ocr-usage`).

Logs carry only ids, counts, codes, model names, token usage and durations:
never line text, items, SDK error messages or SDK error objects.

`OCR_AI_MODE=claude` requires `ANTHROPIC_API_KEY` (injected at run time, never
committed) and `OCR_AI_US_PROCESSING_APPROVED=true`, the owner's approval of
US-only processing on the Claude API (owner decision "Lift hold, US only",
2026-11-04): every request sends `inference_geo: "us"`, never `"global"`, and
the served geo from `usage.inference_geo` is reported as `servedInferenceGeo`. The
retired `OCR_AI_GLOBAL_PROCESSING_APPROVED` is ignored and approves nothing;
without the new switch the worker refuses to start. Models must be first-party
Claude ids (`^claude-[a-z0-9-]+$`).

Cost note: on the Claude API, US-only inference (`inference_geo: "us"`) is
billed at 1.1x the standard per-token price (claude-api reference,
platform availability). Since the owner's decision of 2026-11-05 both the first
pass and the re-read default to `claude-opus-5-5` at effort `high`
(`OCR_AI_FIRST_PASS_MODEL` / `_EFFORT`, `OCR_AI_REREAD_MODEL` / `_EFFORT`), sent
explicitly on every request with adaptive thinking; a Fable model is not used
(it needs 30-day data retention, which the owner declined). Planning price:
list price $4 / $20 per million input / output tokens; US-only x1.1 = $4.40 / $22
(cache reads $0.22, 5-minute cache writes $5.50). Per page that is more than
twice the earlier Sonnet first pass at medium effort, since high effort also
writes more thinking and output. Each job logs `ocr.reading.usage` per model
(requests and token counts, never text, with `pagesSent`), so the cost per page
can be seen. The reference lists `inference_geo` as supported
on the Claude API with no per-model exclusion for these models; a model that
did not support geographic pinning would answer 400, which the client does not
retry, so the reading would end `ai_failed` (Textract text only, no items)
rather than be read outside the US.

`OCR_AI_FACILITY_IDS` is an emergency off-switch only, not a rollout list:
comma-separated facility UUIDs, whitespace around each trimmed and compared
case-insensitively (blank entries from stray commas are ignored). Unset or
empty means every facility. A value with no UUID, or with anything that is
not a UUID, fails startup. `ocr-api` reads the same variable, so both services
must be given the same value.

IAM for the worker role:

- `OCR_TEXTRACT_FEATURES=text`: `textract:DetectDocumentText`,
  `textract:StartDocumentTextDetection`, `textract:GetDocumentTextDetection`.
- `OCR_TEXTRACT_FEATURES=layout` adds `textract:AnalyzeDocument`,
  `textract:StartDocumentAnalysis`, `textract:GetDocumentAnalysis`.
- S3 read of the exact object versions (`s3:GetObjectVersion`), and for the
  asynchronous PDF/TIFF reads Textract needs `s3:GetObjectVersion` and
  `kms:Decrypt` on the document bucket and its key.
- HTTPS egress to `api.anthropic.com` when AI reading is on.
