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
   page with the frozen, cached system prompt (`hid-paper-reading-prompt-4`,
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
   counted, by a reason code (`DROP_REASONS` in `items.ts`: `no_line_cited`,
   `line_not_on_page`, `empty_as_written`, `text_not_on_line`, and for a
   picture item `no_box`, `box_too_small`, `too_many_lines`,
   `too_many_lines_on_row`, `too_many_rows`, `rows_not_together`,
   `cited_lines_no_box`, `not_on_cited_line`, `area_too_large`,
   `side_overflow`, `covers_uncited_line`, `uncited_share`, `not_anchored`).
   The counts per code (`droppedByReason`, summing to `droppedUngrounded`, for
   the reading each page ended with) go in the `ocr.job.completed` log only,
   never in the payload or provenance. The same log carries, codes and counts only,
   `hardPages` (hard pages sent for best-guess readings), `hardPageReads`
   (best-guess requests sent, two per page), `hardPageAgreement`
   (`fieldsCompared`, `fieldsAgreed`, `itemsPaired`, `itemsSingle`) and the
   hard-page zoom counts `zoomCalls`, `zoomLimited` and `zoomFailed`. Every kept item gets check reasons
   (dose, frequency, route, value or unit not as written, corrected wording,
   lines not together, inactive status (`status_not_active`: past, stopped,
   suspected, ruled out, history, family history), a medicine whose status
   the paper doesn't give (`status_not_written`: "The paper doesn't say
   whether this is current.", only where the line has no status words such
   as "stopped" or "d/c", which give `status_cue_on_line` instead), status
   words, date not on the page or
   ambiguous, low OCR confidence, handwriting) and one plain sentence for the
   check screen. An
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
7. **Re-read** (owner decision 2026-11-05). Each page gets at most one
   re-read by `OCR_AI_REREAD_MODEL`, at most `OCR_AI_MAX_REREAD_PAGES` per
   document: first the pages whose first pass failed (cut off or malformed) or
   was declined, then the flagged pages in page order.
   - A page whose first pass **failed or was declined** gets a **text**
     re-read (never the picture).
   - A page the first pass **flagged** (`low_confidence`, `handwriting`,
     `many_dropped`, `ai_unsure` or `possible_missed_item`) gets the **image**
     re-read, and no text re-read. Where the picture cannot go (setting off,
     PDF, TIFF, not a one-page image, no document bytes, too large or size
     unknown, EXIF orientation, a masked number, a re-read model of unknown
     image tier, or the API rejecting or the model declining the picture), it
     gets the **text** re-read instead. Every flagged page within the cap thus
     has a second reading requested; the exceptions are flagged pages past
     `OCR_AI_MAX_REREAD_PAGES`, which are not re-read, and a re-read that
     itself fails, after which the page keeps its first reading. This replaces
     the earlier rule that sent the picture only when a line was below 0.80.
   - An unflagged page the first pass read is not re-read.

   If the re-read fails, the first-pass items are kept as `check_carefully`
   with `reread_failed` and the page is flagged `ai_unsure`.

   **Merge with the first pass.** For every re-read (from the picture or
   from the text) of a page whose first pass gave an answer, the result is
   merged with the first pass, fail-safe, never replacing it wholesale. If
   the re-read keeps no item while the first pass had items, it counts as a
   failed re-read (in `rereadFailedPages`, and for an image re-read also in
   `imageRereadFailedPages`) and the first-pass items stay, marked
   `reread_failed`; if the first pass had no items either, the re-read's
   (empty) result stands. Otherwise the re-read's items are kept, and a
   first-pass item is removed only when a kept re-read item is its exact
   twin: the same kind, a shared cited line, and every field the contract has
   for the kind equal after normalising (case, spacing, and "5 mg" = "5mg"),
   plus `dateAsWritten` and the prescription (prescriber and date); a missing
   field equals only a missing field. A re-read item that carries every field
   the first-pass item filled in (equal after normalising) and only adds
   fields it left empty (a route, say) also replaces it: nothing is lost.
   Each re-read item removes at most one first-pass item (exact twins first,
   then such supersets, each in reading order). Every other first-pass item is kept,
   with `readBy: "first_pass"`, as `check_carefully` with
   `not_in_picture_reading` ("The second reading, from the picture, did not
   find this; check it against the paper.") after an image re-read or
   `not_in_second_reading` ("The second reading did not find this; check it
   against the paper.") after a text re-read. Where it has a single best match
   among the re-read items (same kind, a shared line, and the same normalised
   name for a medicine or diagnosis, substance for an allergy, test for a lab
   result or measure for a vital, or for a note the most shared words of four
   letters or more), that one pair gets `differs_from_second_reading` ("The
   second reading differs from this one; compare both with the paper."),
   shown below any real disagreement and above the not-found sentences; it
   does not set `possible_missed_item`. Other items on the line are not
   marked, and a name read differently ("Amlodipine" for "Amlodipne") is not
   a best match: both items are kept, the first-pass one marked not found. Items are in reading order and their ids made
   unique again with the usual suffixes. The identity is merged field by
   field: a name, date of birth, folder number or sex only the re-read gives
   is taken; where both readings give one and they differ, the first pass's
   is kept and the page is flagged `ai_unsure` (identity drives patient
   matching, so it never changes silently); the lines of both and the box
   around both are kept. `possible_missed_item` is worked out again from the lines all kept
   items and the identity cite; `droppedUngrounded` for the page stays the
   count of the re-read's dropped items, including any whose content a kept
   first-pass item still carries. A page whose first pass failed or was
   declined has nothing to merge: its re-read stands. `PROMPT_VERSION`
   is `hid-paper-reading-prompt-6` (version 3 for this routing, 4 since picture
   items on hard lines whose scanned text is nonsense are kept, 5 since hard
   pages get two best-guess readings, 6 since those reads may zoom, below;
   the text prompt
   and request bodies are unchanged from version 2, and the label is only
   recorded), so `ocr-api` never reuses a reading made under older rules.

   Reuse keys on `PROMPT_VERSION` only (with the processing and payload
   contracts and the reading status): `OCR_AI_IMAGE_REREAD` and
   `OCR_AI_IMAGE_MASKED_PAGES` are not part of it. A reading made with
   `OCR_AI_IMAGE_REREAD=off`, or with `OCR_AI_IMAGE_MASKED_PAGES=send`, is
   still reused for the same document after those settings change (and one
   made with the picture is reused after the picture is turned off).

   **Image re-read of flagged pages** (owner decisions "Yes, send image for
   hard pages" and the routing above, 2026-11-05; `OCR_AI_IMAGE_REREAD`, `on`
   or `off`, default `on` when `OCR_AI_MODE=claude`, any other value fails
   startup). The re-read of a flagged page carries the picture of the page
   when the document is a one-page PNG or JPEG by its detected media type (the
   exact verified bytes, as stored; never resized or re-encoded). The request is the
   same Claude API request (`inference_geo: "us"`, fixed endpoint, same system
   prompt) with the user turn `[image, text]`: the text gives the picture's size
   as the model sees it (the API's resize for the re-read model's tier, computed
   with the vision coordinates guide's reference `resizedSize`: 2,576 px and
   4,784 visual tokens on the high-resolution tier, 1,568 and 1,568 on the
   standard tier; never the padded size). The tier comes from an explicit list
   of model ids in `page-image.ts` (high: `claude-opus-4-7`, `-4-8`, `-5`,
   `-5-5`, `claude-sonnet-5`, `-5-5`, `claude-fable-5`, `-5-1`,
   `claude-mythos-5`, `-5-1`; Opus 5.5, Sonnet 5.5, Fable 5 and Mythos 5
   inferred, the rest documented; Fable 5.1's "no downscaling cap" wording is
   to be checked against the vision docs before a Fable model is used for
   re-reads; standard: `claude-opus-4-6`, `-4-5`,
   `claude-sonnet-4-6`, `-4-5`, `claude-haiku-4-5`), never guessed from the
   id: with any other re-read model the page gets the text re-read
   (`image_tier_unknown`). The text lists the lines with their boxes in those pixels and
   asks the model to read the writing from the picture, cite the lines it sits
   on, give the item's own box as absolute pixel coordinates `{x1, y1, x2, y2}`
   (Anthropic advises pixel, not normalised, coordinates), write `asWritten` as
   it reads it in the picture, never invent anything and write `[unreadable]`
   rather than guess (`imagePageMessage`,
   `hid-paper-reading-image-prompt-5`, the same text as version 4, now used
   only for flagged pages that are not hard pages: it asks the model to cite every
   scanned line its item's box covers, small fragments on the same row
   included, and to read from the picture where the scanned text of hard
   handwriting is wrong or nonsense; since version 3 it says the first reading needs
   checking, for any page flag, no longer that the page was hard to read;
   recorded in provenance as
   `imagePromptVersion`). Only these requests use the image answer schema
   (`MODEL_OUTPUT_IMAGE_JSON_SCHEMA`, a required `box` per item); text-only
   requests are byte for byte as before (`MODEL_SCHEMA_VERSION` unchanged). The client turns the model's pixel
   boxes into page fractions before any check. First, an uncited hard line
   (confidence below 0.80) that the item's box lies on and that is on the
   same written row as one of its cited lines (vertical overlap at least half
   the smaller line's height) is a fragment of the same writing that Textract
   split off, and is added to the item's cited lines in reading order. With
   the cited and added lines together, an item may have at most 4 lines on
   any one row and 6 lines in all, or it is dropped (a box cannot claim a
   whole row or block of cells, whether the model cited them or not). A legible line on
   the row is never taken for a fragment (a box over it drops the item). An
   item read from the picture is then kept only when it cites lines on its
   page, on at most 3 written rows (fragments of one row count once; a row is
   lines that are all on one row with each other, never a slanted chain, and
   at most 1.5 times as tall as its tallest line), the rows lying together (on one row,
   or consecutive in reading order and vertically adjacent: the
   `lines_not_together` test applied to rows, here a reason to drop), and its box
   (clipped to the page, at least 0.005 of the page on each side, its area at
   most 2 times the area of the box around its cited lines plus 0.002 of the
   page, or that box padded by 0.005 of the page on every side if larger, and
   running past that box's left and right edges by at most a quarter of its
   width in total, or by up to 0.01 of the page width on each side (0.02 in
   all), so a few pixels of padding around a short word are allowed) lies on every cited line that has a box, each line on its own (over
   half the line's height and half the narrower width), lies on no line it
   does not cite by that same test, with at most half of the line area it
   covers on lines it does not cite (so never a line on another row), and,
   where any cited line is legible (confidence 0.80 or more), its `asWritten`
   shares a word of three letters or more, or a number, with the text of its
   cited lines (so a box copied from a clean line around a made-up item is
   dropped); otherwise it is dropped and counted in `droppedUngrounded`.
   Where every cited line is below 0.80 (hard handwriting or faint print),
   the scanned text may be nonsense ("Lis day my" for "IV Ceftriaxone 1g
   daily"), so that text test is not required: an item that passes every
   placement rule but shares nothing with the scanned text is kept, with
   `not_matched_to_scanned_text` ("Read from the picture; it could not be
   matched to the scanned text. Check it against the paper.", shown below
   any real disagreement and above the general picture sentence). Known
   limit: writing on which Textract found no line at all cannot be cited
   (every item needs at least one line), so it is still dropped. It need not match the Textract text: its
   fields are held to its own `asWritten` as read in the picture (so a word or
   dose the service misread is not a "doesn't match the paper" reason, and the
   page is not flagged `possible_missed_item` for the line text it corrected),
   and a number the text of its lines does not have adds
   `number_not_in_text_read`. Every such item is `check_carefully` with
   `read_from_image` ("This was read from the picture of the page; check it
   against the paper.", shown unless its own fields disagree with what it read
   or a number is not in the text read), `readBy: "reread"`, and its stored box
   is the model's box clipped to the page.

   Scope (v1): PNG and JPEG only. PDF and TIFF pages get the text re-read
   (`image_not_available_pdf`, `image_not_available_tiff`). A JPEG whose EXIF
   Orientation (APP1 `Exif`, tag 0x0112, either byte order, read without a new
   dependency) is not 1, or whose EXIF cannot be read, is not sent
   (`image_orientation_unsupported`): the picture as the API shows it might be
   turned relative to the line boxes. PNG `eXIf` orientation is not checked.

   Masked numbers: the text sent hides 11-digit NIN-like and Nigerian phone
   numbers, but the picture shows them. By default
   (`OCR_AI_IMAGE_MASKED_PAGES=send`; owner decision 2026-11-05, about 14:06
   UTC: "send images with numbers") the picture of such a page is sent anyway,
   **which shows those NIN-like and phone numbers to the Claude API** (US-only
   processing; the text sent stays masked). `OCR_AI_IMAGE_MASKED_PAGES=text_only`
   keeps such a page text-only and gives it the text re-read
   (`image_has_masked_number`); any other value fails startup. A picture over the
   Claude API image limits (10 MB base64-encoded, 8000 x 8000 px; the size is
   read from the PNG IHDR or JPEG frame header, never by decoding) stays text
   only (`image_too_large`; `image_size_unknown` when the header cannot be
   read). Only if the API rejects the request with the picture as an invalid
   request (HTTP 400 with error type `invalid_request_error`) is the page
   re-read from its text (`image_rejected`); if the model declines the
   request with the picture, the page is likewise re-read from its text once
   (`image_refused`: the decline may be about the picture). Any other
   rejection (413, key, permission, model), a cut-off or malformed answer, or
   an overload or timeout after the retries is a failed re-read, with no
   second request. The reading summary and the payload's `reading` carry
   `imageRereadPages` (re-reads answered from the picture),
   `imageRereadSkipped` (`{page, reason}` for each flagged page re-read without
   it, including `image_reread_off`, `image_has_masked_number`,
   `image_orientation_unsupported`, `image_tier_unknown`, `image_rejected` and
   `image_refused`; `not_hard_to_read` is no longer written but still reads in
   older payloads) and `imageRereadFailedPages` (pages sent with the picture
   whose re-read gave no usable answer or kept no item where the first pass
   had some). The picture and its
   base64 are never logged, stored (beyond the original document, already in
   S3) or put in an error.

   **Hard pages: best-guess readings** (owner decisions of 2026-11-05, about
   18:40 UTC, relayed by the coordinator, after the owner ran Opus 5.5 at max
   effort on a handwritten test photo in claude.ai and got useful best-guess
   readings, names marked "?", with two runs disagreeing on several names):
   (1) "recommended with prompt that makes them do best result": tentative
   best-guess readings, only for hard pages; (2) "Yes, use a drug list";
   (3) zoom deferred, a documented seam only, since replaced by zoom in our
   reader (below).

   - *Which pages.* A hard page is a page the first pass flagged
     `handwriting` or `low_confidence` whose re-read goes with its picture
     (`OCR_AI_HARD_PAGE_READS`, `on` or `off`, default `on` when
     `OCR_AI_MODE=claude`; any other value fails startup; `off` gives such a
     page the image re-read above). Every other path keeps rule D
     (`[unreadable]`, never a guess): the first pass, every text re-read
     (including a hard page that cannot go with its picture, such as a PDF),
     and the image re-read of a page flagged only for other reasons.
   - *Request.* The same request twice (`Promise.allSettled`, both inside the
     process-wide request limit), same model (`OCR_AI_REREAD_MODEL`), adaptive
     thinking, `inference_geo: "us"`, fixed endpoint and the same cached system
     prompt, at `OCR_AI_HARD_PAGE_EFFORT` (default `max`, which Claude Opus 5.5
     accepts: `low` to `max`; any other value fails startup). Its user turn is
     `[image, hardPageMessage]` (`hid-paper-reading-hard-page-prompt-3` when
     the reads are offered zoom, else the unchanged
     `hid-paper-reading-hard-page-prompt-2` text; recorded in provenance as
     `hardPagePromptVersion` when used): read the
     page line by line; give a best reading of every field with "?" after each
     uncertain word; a word not readable even as a guess is `[unreadable]`;
     a medicine as route, drug name, dose (a number), unit and frequency, the
     frequency only one of `od bd tds qds 6hrly 8hrly 12hrly nocte stat prn`
     (anything else: `[unreadable]`, its words kept in `asWritten`); for each
     field a basis, `letters` (read from the letter shapes) or `context`
     (inferred from what is usual), a field filled from context only with
     basis `context`, and a common medicine not to be preferred over what the
     letters show; ignore show-through from the back of the sheet and text cut
     off at the edges; never invent an item; cite the scanned lines its box
     covers and give its pixel box. Its answer schema
     (`MODEL_OUTPUT_HARD_PAGE_JSON_SCHEMA`) is the image schema plus `dose`,
     `doseUnit`, a restricted `frequency` and a per-item `basis` object
     (`name`, `dose`, `unit`, `route`, `frequency`, `duration`, `value`,
     `other`). The text-only request is byte for byte unchanged (body-hash
     test), and so is the image request for other flagged pages.
   - *Each reading* (`hard-page.ts`): frequency and dose normalised as above,
     the strength rebuilt as dose and unit (`400? mg`), and the drug name
     checked against the drug list (below): a listed name is shown in its
     list spelling with "?" (`Metronidazole?`), a brand as `Flagyl?
     (metronidazole)`, an unlisted one as `[unreadable]`. `asWritten` keeps
     what the model read, "?" marks included: it is the transcription the
     clinician compares with the paper, while the drug name field is what may
     be taken into the record, so only the field is held to the list. Every
     filled text field whose basis is `context`, of any kind (a diagnosis
     name, an allergy substance or reaction, a lab value, a route), gets "?"
     in the field itself; enum fields (status, severity, measure) cannot
     carry it and are marked by `field_from_context` instead, as are a date
     or prescriber from context (`checkPage` keeps those only where written
     exactly on the page, so they get no "?"). The answer schema gives one
     basis, `other`, for all of an item's remaining fields together, so
     when it is `context` every filled one of them gets "?" (an allergy's
     substance and reaction, a lab test, range and flag, a medicine's form),
     even one read from the letters: more marks than guesses, never fewer.
     The marks are only for showing: every check against the page (and the
     re-read merge's comparison with the first pass) is made with the "?"
     after a word or number taken off (`forMatching` in `grounding.ts`), so
     `Sulfa?` is still found in "No sulfa allergy" and `Hb?` still labels
     its value. A question mark written on the paper itself (a clinical
     query, "?TB" or "TB?") is transcribed `[?]` by the hard-page prompt and
     never taken off, so it still counts as a status cue
     (`status_cue_on_line`: a queried diagnosis is never shown as confirmed
     without it), while the reading's own "?" never looks like a query. The
     reading is then held to the page by `checkPage` exactly as any picture
     reading (#194's placement rules, the row and line limits and the anchor
     rule, unchanged).
   - *Two readings compared.* Items are paired one to one by kind and place
     (a shared cited line, or boxes overlapping by half the smaller box; a
     vital also by measure), best pairs first, then the same listed medicine
     on neighbouring rows of one column (boxes sharing at least half the
     narrower box's width, and cited lines at most one apart or boxes sharing
     part of their height; the same medicine at one height in two columns is
     two orders). Nothing pairs along one row: two halves of one written
     line ("Metronidazole" | "400 mg tds"), each found by one reading, stay
     two `single_reading_only` items. That is a safe duplicate: merging them
     would turn every field only one half fills into `[unreadable]`, and a
     lone name beside a full order would swallow that order. For each pair every field is
     compared after normalisation ("?" marks, case, spacing aside): agreeing
     fields keep the best guess, with "?" where either reading was unsure and
     basis `context` where either said so; a disagreeing drug name becomes
     `A? / B?` when both names are on the list and both were read from the
     letters, else `[unreadable]` (a name filled from context is never offered
     as an alternative: on an unusual prescription that is the guess most
     likely to be wrong); a disagreeing dose, unit, route, frequency or other
     text becomes `[unreadable]` (two doses are never shown; `asWritten` keeps
     the words both read and writes each differing stretch once as
     `[unreadable]`); a disagreeing medicine status becomes `unknown`. The pair
     gets `readings_disagree` ("Two readings of the picture disagree on part
     of this; check it against the paper.", said just after the dose and
     number disagreements). An item only one reading found is kept (it has
     passed every placement rule) with `single_reading_only` ("Only one of two
     readings of the picture found this; check it against the paper."). Every
     hard-page item is `check_carefully`, `readBy: "reread"`, with
     `read_from_image` and `best_guess_from_picture` ("This is a best guess
     from the picture; check every word against the paper."), and
     `field_from_context` ("Part of this was guessed from what is usual, not
     read from the writing; check it against the paper.") when any filled
     field's basis is context. These three sentences come below the real
     disagreements and in place of the general picture sentence, most specific
     first; each code is listed once. A medicine's `plain` is built from its
     final fields only, never the model's own wording.
   - *Failures.* If one reading fails or is declined, the other is used alone,
     with `single_reading_only` on every item (the page is in
     `hardPageSingleReadPages`). If both fail, the page is a failed image
     re-read as before (`imageRereadFailedPages`, first pass kept with
     `reread_failed`); if both were refused as invalid requests or both
     declined, the page is re-read from its text (`image_rejected`,
     `image_refused`). The merged hard reading then goes through
     `mergeReread` with the first pass unchanged, so no first-pass item is
     lost.
   - *Stored.* No new payload field: the per-field basis is carried only by
     the reason codes, so both contract copies are unchanged. The page is in
     `imageRereadPages`; provenance adds `hardPages`, `hardPageReads`,
     `hardPageSingleReadPages`, `hardPagePromptVersion` and
     `hardPageZoomPages` (the hard pages whose reads were offered zoom;
     `hardPagePromptVersion` is `-3` only when there is one, else `-2`, the
     text those reads were sent) (`imagePromptVersion` is set only when a page
     that is not a hard page was read from its picture).
   - *Drug list* (`src/reading/drug-list.ts`). Generic names from the
     Federal Ministry of Health, Nigeria, "Nigeria Essential Medicines List",
     7th Edition, 2020 (the latest edition found on 2026-11-05; no 8th edition
     was found), read from
     https://extranet.who.int/cpcd/sites/default/files/public_file_repository/NGA_Nigeria-Essential-Medicine-List_2020.pdf
     (WHO country planning cycle database entry
     https://extranet.who.int/cpcd/health-legislation/nigeria-essential-medicine-list-7th-edition):
     the main list, the primary health care lists, the patent and proprietary
     medicine vendors list, the vitamin appendix, the restricted list and the
     index; vaccines, sera, diagnostics, devices and disinfectants left out;
     the list's misprints given in their standard spelling (listed in the file
     header). Plus the list's own bracketed other names, a few marked British
     names (frusemide, lignocaine, co-amoxiclav), and a small, separate brand
     list, **curated, not exhaustive; review before relying on it** (23 brands
     such as Plasil, Flagyl, Augmentin, Rocephin, Zinnat, Septrin, Coartem,
     Fansidar, Daraprim; only true brand names, never a manufacturer's name).
     Matching: lower case, "?" and punctuation removed, salt and form words
     (hydrochloride, tab, inj, ...) ignored; exact first, else the closest
     name by edit distance, only for names of 6 letters or more, at distance
     2 or less and similarity (1 - distance / longer length) 0.8 or more, and
     only when one medicine is closest (two lookalikes equally close: no
     match). The list never creates a drug: it only checks, and respells, a
     name the model proposed. Applied only on hard pages. Limits: a medicine
     not on the essential medicines list (a newer or non-essential drug, most
     brands) is always shown as `[unreadable]` on a hard page, and a misreading
     that happens to be within two letters of another listed medicine would
     be shown as that medicine, with "?", for the clinician to check.
   - *Zoom* (owner decision of 2026-11-05, about 18:45 UTC, relayed by the
     coordinator: "Zoom in our reader (Recommended)"; Anthropic's
     code-execution sandbox was declined because it keeps page photos for up
     to 30 days). During each of the two hard-page reads the model may call a
     client tool, `zoom(page, box {x, y, w, h}, scale)` (`src/reading/zoom.ts`):
     the box is in the picture's pixels as the model sees it (the same frame
     as the line boxes and the answer boxes: the size `resizedSize` gives for
     the model's tier), `scale` 1 to 4 (default 2). The worker cuts the box
     from the same verified bytes the picture came from (mapped back to the
     original pixels), enlarges it (bilinear; area averaging where the view
     is in fact smaller), caps it to the tier so the API does not resize it
     again, encodes it as PNG and returns it as an image `tool_result` with a
     line saying where it is in the picture. How it works:
     - *Only here.* The tool is declared only on hard-page requests with zoom
       on (`OCR_AI_HARD_PAGE_ZOOM`, `on` by default when the hard-page reads
       are on, `off`; any other value fails startup). The text-only request
       (hash-pinned in `claude.client.spec.ts`) and the ordinary image re-read
       request are unchanged; with zoom off the hard-page request is as before
       (the prompt text adds rule I only when zoom is on).
     - *The tool loop* (`claude.client.ts`). Streamed, adaptive thinking,
       `inference_geo: "us"` unchanged. On `stop_reason: "tool_use"` every
       call of the turn is answered in one user turn, in order, after the
       assistant turn exactly as it came (thinking blocks and signatures
       included, as tool use with thinking requires; the conversation only
       grows, so top-level automatic caching lets later turns read the
       picture and earlier crops from cache). The answer stays structured
       output (`output_config.format`, which combines with tools: a turn ends
       either in tool calls or in the JSON answer); `tool_choice` is `auto`
       (Claude Opus 5.5 refuses forced tool use); the tool is `strict` and its
       input is checked again in code. A cut-off (`max_tokens`) or refused
       turn never runs its tools. Malformed input, another page or an
       unknown tool get an `is_error` result; a zoom that fails (decode
       error, a decoder limit, a time limit) gets `is_error` "zoom
       unavailable" and the read goes on. A read that keeps calling past its
       limit ends after three more turns as an incomplete (failed) reading.
       Each attempt of each turn gets `OCR_AI_HARD_PAGE_TIMEOUT_MS`, as a read
       without zoom does, and the loop's time in requests (every turn and
       retry; not the waits for a request permit, the backoff sleeps or the
       crops) is held to `OCR_AI_HARD_PAGE_TIMEOUT_MS` x
       (`OCR_AI_MAX_RETRIES` + 1), what one request with all its retries could
       take. The loop stops on shutdown between turns as within them; every
       request and the usage of every turn is counted.
     - *Limits.* At most `OCR_AI_ZOOM_MAX_CALLS` (default 8, 0 to 8; 0
       declares no tool) calls per page per read; every later call gets
       `is_error` "zoom limit reached; finish your answer". Each crop at most
       4,000,000 base64 characters (made smaller until it fits) and all crops
       of one read at most 30,000,000 less the picture (the API takes 32 MB
       per request, and every crop is sent again on each later turn); past
       that, the limit message. Boxes under 8 px (after clamping to the
       picture) or with non-finite numbers are refused. Decoding happens only
       for a page already eligible for the image re-read (the same 10 MB
       base64, 8000 x 8000 px and upright-JPEG checks), on the first call,
       once per page for both reads, and is dropped with the reading. Zoom
       decodes at most 24 MP (6000 x 4000; below the 64 MP the picture itself
       may have, on purpose), and a PNG only at 8 bits or fewer per sample and
       not interlaced; both are checked from the header before anything is
       inflated or decoded, and a larger picture is still sent whole, with
       zoom off. JPEG decoding is also held by jpeg-js to 24 MP and 640 MB of
       its own count (`maxResolutionInMP`, `maxMemoryUsageInMB`; 24 MP needs
       about 481 MB). Measured on fictional pages at 24 MP, one decode takes
       about 3 s and about 1 GB at its peak for a JPEG, under 1 s and about
       400 MB for a PNG; the RGB raster kept for the reading is 72 MB. The
       decoders run on the event loop (pure JS, synchronous), so one process
       decodes one page at a time and a decode stalls the process (the other
       job's reads and lease renewal included) for its whole length: the
       pixel and bit-depth limits are what bound that stall and the memory,
       within the 2 GiB task. A decode over 5 s or a crop over 3 s (checked
       when it ends, so it does not cut the stall short), a decoded size other
       than the header's or any decoder error turns zoom off for that page
       ("zoom unavailable"), never the reading.
     - *Libraries* (pure JavaScript, no native code, pinned exactly in
       `package.json`, integrity hashes in `package-lock.json`): `jpeg-js`
       0.4.4 (BSD-3-Clause; 2022-06-07; no dependencies; the fix for
       GHSA-xvf7-4v9q-58w6, which affected earlier versions), `pngjs` 7.0.0
       (MIT; 2023-02-20; no dependencies), and `@types/pngjs` 6.0.5 (MIT,
       development only; jpeg-js ships its own types). Each is the latest
       release, over 14 days old; `npm audit` reports no advisory for any of
       them (the audit's findings are the existing ones in the jest
       toolchain, development only; `npm audit --omit=dev` finds none).
     - *Logs.* `ocr.reading.usage` for `pass: "hard_page_read"` carries
       `zoomCalls` (crops returned in that pass); `ocr.job.completed` carries
       `zoomCalls`, `zoomLimited` (calls refused at the limit) and
       `zoomFailed` (calls answered "zoom unavailable" or refused as
       malformed). Numbers only.
     - *Privacy.* No crop is stored, logged or put in an error: crops are
       made in memory from the same picture, sent only in the same US-only
       Claude API request as the picture, and dropped with the reading.
     - *Cost.* Each zoom adds an image of up to the tier's tokens (4,784 on
       the high-resolution tier, about $0.021 at $4.40 per million input
       tokens), and every later turn of the read sends the picture, the
       earlier crops and the turn's thinking again (cached after the first
       turn, read at $0.22 per million), plus the turn's own output. Eight
       zooms in one read can add roughly 40,000 input tokens and a few
       thousand output tokens; the `zoomCalls` and `hard_page_read` usage
       lines give the real figures.
   - *Cost and time.* Each hard page costs two requests at `max` effort where
     the earlier image re-read was one at `high`. Estimate per A4 photo page
     at list price x1.1 for US-only ($4.40 / $22 per million input / output
     tokens): about 6,000 input tokens (system prompt, lines with boxes and up
     to about 4,800 picture tokens; the picture is in the user turn, not
     cached), and about 5,000 output tokens at `high` versus roughly 7,000 to
     9,000 at `max` (thinking grows most): about $0.14 for the earlier image
     re-read and about $0.37 to $0.46 for the two hard-page reads, so roughly
     3x. The `ocr.reading.usage` lines with `pass: "hard_page_read"` give the
     real figures to check this against. The two reads run at once, so a hard
     page takes about as long as one read at `max` effort; such a read may
     think for many minutes, so it has its own timeout,
     `OCR_AI_HARD_PAGE_TIMEOUT_MS` (default 900,000 ms, 10,000 to 1,800,000;
     other requests keep `OCR_AI_TIMEOUT_MS`), and `OCR_AI_MAX_TOKENS` now
     defaults to 64,000 (was 32,000; at most 128,000) so a long answer at `max`
     is not cut off (a cut-off answer is a failed reading; only tokens
     generated are billed). The job's lease is renewed meanwhile.
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
- **Image re-read cost.** The picture's tokens are ordinary input tokens and
  count in the same usage records (`ocr.record_worker_ai_usage`). An image costs
  about `ceil(width/28) x ceil(height/28)` tokens, at most 4,784 on
  `claude-opus-5-5` (larger pictures are downscaled by the API): an A4 scan at
  150 dpi (1240 x 1754) is about 2,800 tokens. At the re-read model's $4 per
  million input tokens with the 1.1x US-only price, that is about $0.012 to
  $0.021 more per image-read page, plus a few tokens per line for the boxes
  (and the system prompt uncached, below). Only flagged one-page PNG/JPEG
  pages pay it. Under the 2026-11-05 routing every flagged page is re-read
  (pages flagged only `possible_missed_item` or `low_confidence` by a printed
  line were not before), so expect more re-reads than under version 2: one
  re-read-model request per flagged page, with or without the picture. Image re-reads send a
  different answer schema (`output_config.format`), which is a prompt-cache
  breaker, so they do not read the text requests' cached system prompt: count
  the system prompt as ordinary input (or a cache write) for each image re-read
  unless `cache_read_input_tokens` on live runs shows otherwise. The accuracy
  kit does not yet measure image re-reads (its runs pass no document, so every
  re-read is `image_not_given`, and its cost table has no picture tokens):
  change and run it before relying on its numbers for PNG and JPEG pages.
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
writes more thinking and output. Each job logs `ocr.reading.usage` once per
model and pass (`pass`: `first_pass`, `reread`, `image_reread` or
`hard_page_read`, both reads of each hard page; requests and
token counts, never text, with `pagesSent`), so the cost per page, and what the
re-reads and the pictures add, can be seen even though both passes use one model.
A reading stopped before it finished logs one line per model, without `pass`.
The database keeps one usage record per model, as before. The reference lists `inference_geo` as supported
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
