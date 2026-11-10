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
   the reading each page ended with, plus `heading` and `duplicate_of_order`
   for the items the last step leaves out, which are not ungrounded and not
   in `droppedUngrounded`; see "Cleanups of 2026-11-10") go in the
   `ocr.job.completed` log only,
   never in the payload or provenance. The same log carries, codes and counts only,
   `hardPages` (hard pages sent for best-guess readings), `hardPageReads`
   (best-guess requests sent, two per page), `hardPageAgreement`
   (`fieldsCompared`, `fieldsAgreed`, `itemsPaired`, `itemsSingle`) and the
   hard-page zoom counts `zoomCalls`, `zoomLimited` and `zoomFailed`, and
   `hardPageDeadlineHits` (hard pages where `OCR_AI_HARD_PAGE_DEADLINE_MS`
   cut a read). Every kept item gets check reasons
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
   is `hid-paper-reading-prompt-12` (version 3 for this routing, 4 since picture
   items on hard lines whose scanned text is nonsense are kept, 5 since hard
   pages get two best-guess readings, 6 since hard pages use the brand,
   diagnosis and lab test lists and read handwritten signs, 7 since those
   reads may zoom, 8 since hard pages are read in the clean style of
   2026-11-06, below, 9 since the hard-page time and cost bounds of
   2026-11-10 (at most 4 zooms per read, so rule J says 4; see "Hard-page
   time and cost bounds"), 10 since rule J asks for all of a read's zooms
   in one turn (see "Zooms in one turn"), 11 since a hard read that has
   not answered in time is sent one answer-only turn (see "A hard read
   always ends with an answer"), 12 since the cleanups of 2026-11-10 (one
   other option per field, two items for two drugs, headings and repeated
   orders left out; see "Cleanups of 2026-11-10"); the text prompt and request bodies are unchanged
   from version 2, and the label is only recorded), so `ocr-api` never reuses
   a reading made under older rules.

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
   read, or, for a PNG, when its chunks do not walk cleanly to IEND with
   correct CRCs and exactly one IHDR, first: see zoom below). Only if the API rejects the request with the picture as an invalid
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

   **Clean reading** (owner decision of 2026-11-06, about 10:13 UTC, relayed
   by the coordinator: "i want the output clean ... doctor no get time"; the
   owner had compared our output with Opus in claude.ai chat reading the same
   fictional handwritten page, which gave rows like "IV Flagyl? 500mg?
   8hrly?", "Transfer to the ward", "Switch to IV Ceftriaxone 1g"). Hard pages
   only; every other path, the text-only request (body-hash test) and the
   ordinary image re-read are unchanged. `PROMPT_VERSION` 8; hard-page prompt
   `hid-paper-reading-hard-page-prompt-8` with zoom and `-7` without (the same
   text without rule J, pinned by hash). `-6`/`-5` were this change's first
   prompt and were never released; the prompt text changed again the same day
   (partial words, placeholders, "IV? (or ✓?)", see below), so the hard-page
   version moves on, while `PROMPT_VERSION` stays 8: it too is not yet
   released, so no stored reading was made under an older 8 that could be
   reused. What changed against #196 and #197:
   - *Read like chat.* A best guess for every word and number, "?" straight
     after each uncertain one ("IV Ceftriaxone? 1g? 8hrly?"); a word read with
     certainty has none. The two max-effort reads and zoom stay.
   - *Tokens.* `[?]`: writing is there but no letter or digit shapes can be
     made out (it replaces `[unreadable]`; the model is no longer asked for
     `[unreadable]`, and code turns one it still writes into `[?]`).
     `(? on paper)`: a question mark written on the paper itself (a clinical
     query, "?TB"); it was `[?]` under #196, so `[?]` is now kept for the
     owner's "no letter shapes" and the paper's own "?" gets words that cannot
     be mistaken for a mark of the reading: it is still a status cue
     (`status_cue_on_line`), never taken off for checking, and a list key
     ignores it (`(? on paper) TB? (Tuberculosis)`); `[?]` is not a status cue
     and no list matches a name holding it. `A? (or B?)`: the two reads
     differ. `(crossed out: X?)`: writing struck through on the paper.
     Payloads written before keep their old tokens.
   - *Disagreement.* Where the two reads differ, read A's guess is shown with
     "?" and read B's after it: `Cefuroxime? (or Ceftriaxone?)`,
     `500mg? (or 250mg?)`, `tds? (or bd?)`, for names, numbers, units, routes,
     frequencies, any text, and word by word in `asWritten` (word for word
     where both stretches have as many words: `Cefuroxime? (or Ceftriaxone?)
     750mg? (or 1g?)`). Nothing becomes `[?]` because the reads disagree.
     Read A is chosen once per item, never field by field (so the first
     options are always one read's order): the read with more fields read
     from the letters (basis `letters`), else the first read; so a guess from
     what is usual is the second option where the other read read the
     letters (`field_from_context` says it). The reason is
     `readings_disagree`, also whenever the two `asWritten` differ at all. A
     stretch only one read has is shown alone, marked (`Stop? IV Ceftriaxone
     1g bd`), never as a bare `(or Stop?)`. The same listed medicine under two
     spellings respelled by the list is shown once with "?" (still
     `readings_disagree`); a brand against its generic (`Flagyl` and
     `Metronidazole`) shows both, since the reads read different words.
   - *Lists only correct spelling.* The drug, brand, diagnosis and lab lists
     keep their strict matching and add the generic or title in brackets as
     before (`Flagyl? (metronidazole)`, `HTN? (Hypertensive diseases)`). A
     listed drug shows "?" only where it is a guess (the model marked it,
     basis `context`, or the list respelled it): `Flagyl (metronidazole)`
     read with certainty. **A drug name not on the list is no longer hidden**:
     it is shown as read with "?" after every word (`Fictionalmab?`), a
     deliberate owner decision; safety rests on every hard-page item being
     `check_carefully`, so a person must Keep or Change it. A deny-listed
     look-alike is never resolved silently either way: a name the strict
     match would have respelled but for `UNLISTED_LOOKALIKES`,
     `UNLISTED_DIAGNOSIS_LOOKALIKES` or `UNLISTED_LAB_LOOKALIKES` is shown with
     both options, `Arteether? (or Artemether?)`, `Nephritic? syndrome? (or
     Nephrotic? syndrome?)`. Ambiguous abbreviations (`UNGROUNDED_ABBREVIATIONS`,
     the lab guards PT, BG, GT, CS, HCV, `od`) are still never expanded. A
     non-code frequency and a non-numeric dose are kept as read (before:
     `[unreadable]`); `od` is still never put in words. The strength is shown
     as written on a prescription, `500mg?` (before: `500? mg`).
   - *The item's text is the reading.* The check screen shows an item's
     `plain` as its main text. On a hard page `plain` is built in code, never
     the model's own wording. Re-review of 2026-11-06: building it from the
     fields (route, drug, strength, how often, plus the words before and
     after) kept dropping or contradicting written words (a second dose, a
     taper, another drug on the line, `(? on paper)`, a stop word while the
     status said new), so `plain` is now the (merged) `asWritten` itself,
     every kind: word by word in the order written, with its "?" marks,
     `(or B?)` options, `(crossed out: X?)`, `[?]`, placeholders and
     `(? on paper)`, never a word dropped or moved, annotated where each
     field's words stand (`displayOf`, hard-page.ts): the generic after a
     listed brand (`Flagyl? (metronidazole)`), a list respelling as
     `Respelled? (generic)` with "?" (never silently), a look-alike as
     `Arteether? (or Artemether?)`, a grounded diagnosis or test name
     (`Dx HTN? (Hypertensive diseases)`), "?" on a field guessed from context,
     and a frequency or duration in words only where certain
     (`tds (three times a day)`). Numbers stay as written (`500 mg`, `1gm?`).
     A field that is a guess or a respelling whose words `asWritten` does not
     hold is added at the end, marked, so no guess is lost. The fields stay
     structured data for the payload (still marked "?" word by word where
     `asWritten` marks the word they hold, by whole words only: "ward" is no
     longer found in "forward"). Descriptive text such as "Handwritten
     treatment entry that cannot be read; check the paper" came from the
     model's `plain` (system prompt rule 4 asks for a plain-English reading,
     and #196 kept the model's `plain` for every kind but a medicine, and an
     empty one for a disagreeing pair). The hard-page prompt now says every
     field is the reading itself, never a description, and to leave `plain`
     empty. `isDescription` (hard-page.ts) is non-destructive: it never
     replaces or drops text. An item with text that looks like a description
     of the writing gets the reason `description_suspected` (and is
     `check_carefully`, as every hard-page item is); the text is shown
     exactly as read. Replacing it with `[?]` had kept removing clinicians'
     notes about handwriting (dysgraphia, micrographia, "Writing unclear
     since stroke", "Script illegible, called prescriber"), so the patterns
     are now only obvious reader phrases: "cannot be read" with no subject or
     the writing as subject ("entry that cannot be read"), "Illegible" or
     "Illegible handwriting" as the whole text, a "handwritten ... entry",
     "check the paper" closing the text, and "the writing appears to say".
     A miss costs only the flag. Tests keep the clinical notes byte for byte
     whether flagged or not. Free-text instructions
     ("Transfer to the ward", "Review in 2 days") are asked for as `note`
     items.
   - *Status from the words shown.* A medicine whose shown text has a word
     that stops, holds or changes it (`STATUS_WORDS`: stop, hold, withhold,
     omit, discontinue, d/c, DC, cease, suspend, switch, change, convert, and
     their past forms; crossed-out writing aside), or whose two reads differ
     on any such word or on start, continue, restart, resume, reduce,
     increase, taper, wean or give, has status `unknown` (a status already
     `stopped` or `past` is kept), with `status_cue_on_line` (and
     `readings_disagree` for a difference). "Switch to IV Ceftriaxone 1g" is
     therefore `unknown`.
   - *Partial words and placeholders* (owner's transcripts). `Am…`: the
     letters seen and "…" where the rest trails off; never matched to a list
     or completed; a guess for the whole word only in brackets with "?"
     (`Pl… (or Ph…) (Plasil?)`; code adds the "?" where the model left it
     off, and never adds a generic). `[route?]`, `[drug?]`, `[dose?]`,
     `[freq?]`: one part of an otherwise readable order is written but shows
     no letter shapes, so the line is kept (`IV Cefuroxime? [dose?] 8hrly?`);
     like `[?]` (they name which part: `[?]` stays the token for any other
     writing), they are not a guess mark, not a query (`STATUS_CUES` counts
     no "?" before "]") and never a word for a list; the checks read each as
     `[?]`. The model's `[frequency?]` is read as `[freq?]`. A mark that may
     be either of two things is `IV? (or ✓?)`. Show-through and text cut off
     at the picture's edge stay out (rule G).
   - *Context against letters.* `field_from_context` is set whenever any
     field's basis is `context` (a frequency read from where a squiggle sits,
     "8hrly?"); `unsure_from_letters` is set where the shown text has a "?"
     on a word no context field holds, a partial word, `[?]` or a
     placeholder. The website shows both as "?"; the codes keep them apart.
   - *Unlisted values.* A frequency that is none of the codes and a dose
     written in words are marked "?" word by word, like an unlisted drug
     (`alternate? days?`). An unlisted diagnosis or lab test name gets "?"
     only where the model marked it or its basis is `context` (unchanged).
     The model's strength marked "?" keeps its "?" where the strength rebuilt
     from dose and unit has none.
   - *Crossed out.* Writing struck through on the paper is never an item of
     its own or part of a field: the model writes it as `(crossed out: X)`
     in `asWritten` and X in a new hard-page answer field `crossedOut`; code
     shows it on the same item where it stands, `IV Flagyl (metronidazole)
     500mg (crossed out: 400mg?) 8hrly (every 8 hours)` (a struck drug before
     its replacement: `IV? (crossed out: Ceftriaxone?) Cefuroxime? [dose?]
     8hrly?`), with the reason `crossed_out`; an
     item crossed out as a whole (nothing live outside the struck writing, or
     no live drug name outside it: `IV (crossed out: Flagyl 500mg tds)`)
     becomes a note (never an active medicine); checks take crossed-out
     writing off (`forMatching`), so a struck dose is never held to be the
     dose. Two reads that see different crossed-out writing are
     `readings_disagree`.
   - *Crossed out, line by line.* Matching struck drug names to orders
     (brand against generic, a name only in the struck group, one read live
     and the other struck) kept missing cases, so it is replaced by one rule
     with no name matching: if any read (either hard read, or the first
     pass where its item shows a `(crossed out: X)` group) shows crossed-out
     writing on a line, every medicine from any read citing that line, or
     whose box overlaps the struck item's box by half the smaller box (the
     pairing overlap), has status `unknown` (unless `stopped` or `past`) and
     `crossed_out`, and `readings_disagree` where only the other read shows
     the strike. So a struck dose (`500mg (crossed out: 400mg?)`) or a struck
     drug before its replacement makes the order `unknown`. One read's live
     order and the other's wholly struck note are kept as a pair (both
     shown, the order `unknown`, `crossed_out`, `readings_disagree`), no
     longer joined into one item. The struck text stays shown in place as
     `(crossed out: X?)`.
   - *Reasons stay codes.* `checkReasons` are codes, as before; `checkReason`
     stays the one sentence derived from them, so the payload contract
     (`hid-paper-reading-v2`, schema 2) is unchanged and neither `ocr-api` nor
     `@hid/api-client` changes. Two codes are added (`crossed_out`,
     `description_suspected`); the contract allows any code. The website shows
     the reasons behind "Why?" (not this change). `unsure_from_letters` is a
     third code (above).
   - *Every "?" goes to a person.* Every hard-page item is `check_carefully`
     (a test sweeps all hard-page outputs of the fixture, alone, paired,
     swapped and merged with a first pass).
   - *Fixture.* `src/reading/clean-reading-fixtures.ts` holds fictional rows
     in the target style and the model answers that produce them;
     `clean-reading.spec.ts` runs each through prepare, the checks, the
     two-read merge, the lists and grounding. It holds the rows of the
     owner's two chat transcripts of a fictional treatment sheet (relayed on
     2026-11-06 about 10:16 UTC; target style only, not ground truth) as
     model answers in our schema with the clean text we show.
   - *Logs.* Unchanged: codes and counts only, never item text.
   - **Cleanups of 2026-11-10** (coordinator and owner, about 20:30 UTC,
     after the first live run with #201 to #204, job 656c9cf3: 70 s, about
     $0.45 a page, 13 items, close to the owner's chat transcripts; one line
     read "sc? (or IV?) Omeprazole? (or Enoxaparin?) 40mg? (or IM? cr…
     (Pentazocine?) 30mg?) 8hrly?"). `PROMPT_VERSION` 12, hard-page prompt
     `-12` / `-12-no-zoom`. Everything else is as before. Decisions and rules:
     - *One other option per field* (`hard-page.ts` `alternatives`,
       `mergeAsWritten`, `limitAlternatives`). A field shows at most one
       `(or X?)`, and an option never holds one itself. Read A's own reading
       comes first (read A chosen as before); the option is the strongest of
       one pool: the other read's reading, the other read's own option (a
       look-alike, the model's own strength or `(or X?)`) and read A's own
       option, ranked, in this order, by read from the letters before from
       context (that read's basis for the field), on its list before not
       (drug list for a drug name, diagnosis or lab list for those names, the
       frequency codes), then the other read's before read A's own, then
       closest to read A's reading by its letters (edit distance), ties in
       the order offered (deterministic). So read A's own option is shown
       only where it is stronger by letters or list than everything the
       other read offers, or where the other read offers nothing different. In `asWritten` a read's own `(or X?)` stays
       with the word it follows; where the reads differ on that word one
       option is chosen the same way; where they differ on a stretch of
       unequal length the other read's words are the one option and the
       reads' own options in it are left out; the other read's crossed-out
       writing is written after the option, never inside it. Every shown text
       is then guarded: an option straight after another is left out, an
       option inside one is taken out of it. Nothing that changes safety is
       silently lost: the item keeps `readings_disagree` and goes to a person
       (`check_carefully`); two different drugs are never an option left out
       but two items (below); a difference in what to do with an order still
       makes its status unknown; and the options left out are counted in the
       completion log (`hardPageAgreement.alternativesDropped`, a count only,
       never text; no payload change). The dropped option itself is not
       stored anywhere (the payload contract is unchanged).
     - *No option that adds nothing* (`dropEmptyOptions`; coordinator,
       second cleanup round of 2026-11-10; PROMPT_VERSION 13). An `(or X?)`
       is never shown, in the shown text, `asWritten` of a pair or any field,
       inside `(crossed out: …)` too, where X is only a placeholder or `[?]`
       (`500mg? (or [dose?])`), or is the same as the words straight before
       it, compared without case, `?`, `…` or spacing, or by listed generic
       (`Pl… (Plasil?) (or Plasil?)`, `Flagyl? (metronidazole) (or
       Metronidazole?)`), or is a drug name, with no digits, that a word before
       it in the same text already names (`(crossed out: Ceftriaxone? 1g? (or
       Ceftriaxone?))`). A dose, route or frequency repeated further back is
       kept: it may be another field's option. Each is counted in
       `alternativesDropped`; the item keeps `readings_disagree`.
     - *Two drugs, two items* (`sameDrug`, `splitPair`). Where two items
       paired by place are medicines whose reads name different drugs, they
       are two items, one per read, each with its own fields, `asWritten` and
       crossed-out writing (never fields mixed across reads), both on the
       lines and box of the two together, both `check_carefully` with
       `readings_disagree` (not `single_reading_only`), the read with more
       read from the letters first, each drug name marked "?". Same drug:
       both names on the drug list with the same generic (a brand and its
       generic, two spellings the list matches); two unlisted names, or a
       listed and an unlisted one, only when their letters match exactly
       (no fuzzy match: "Fictomycin" / "Fictomicin" split, since a wrong
       split only shows a second `check_carefully` line and a wrong merge
       mixes two drugs' fields). Hyphens and other separators split words,
       and a joined vitamin is read spaced ("VitaminK", "Vit-K", "VitB12"),
       so "Vitamin C" / "Vitamin-K", "Vit B1" / "Vit B6" and "Ca-gluconate" /
       "K gluconate" split. Form, route and release words ("Inj", "Tab",
       "IV", "retard", "SR", "XR") are left out of a name's identity, "Vit"
       is read as "Vitamin", and a short list of ward abbreviations is read
       as its generic for this rule only (Vitamin K, PCM, MgSO4, Mg
       sulphate, Ca gluconate, KCl; never shown or respelled), so "Vit K" /
       "Vitamin K", "MgSO4" / "Magnesium sulphate" and "Nifedipine" /
       "Nifedipine retard" are one item. An abbreviation is matched as the
       whole name only ("KCl 10%" / "KCl" split).
       Except that a real unlisted look-alike
       of a listed name (`UNLISTED_LOOKALIKES`, or one letter from one:
       "Quinidine" / "Quinine", "Arteether" / "Artemether") is a different
       drug and splits; a word cut
       short ("cr… (Pentazocine?)") by its bracketed guess, or by its letters
       starting the other name. A name that says nothing (blank, `[drug?]`,
       `[?]`) never splits. A read's own `(or X?)` on the name does not
       count: its first reading does. Counted as `drugSplits`.
     - *Headings are not items* (two layers). Rule A of the hard-page prompt
       now says page headings, section titles and form labels ("Treatment
       sheet", "Immediate management", "Plan") are not items and are left
       out, the writing under them listed. The first-pass and ordinary image
       prompts are unchanged: they ask only for clinically relevant items and
       have not been seen to give headings, and the text-only request is
       pinned by hash. Then, on every page however it was read, a
       whole-phrase filter (`tidy.ts` `isHeadingNote`, applied in
       `reader.ts` after each page's reading is final; re-review of
       2026-11-10 replaced the earlier word lists, which dropped "→ Renal
       unit", "Admission: medical unit", "Plan: medical unit" and "→
       Accident & Emergency"). A `note` only (never a medicine, diagnosis,
       lab result, allergy or vital) is left out only if its whole text,
       with the reading marks "?" and "(? on paper)" and case off, is
       exactly a form title: an optional prefix (`HEADING_PREFIXES`:
       trauma, trauma surgery, surgery, surgical, general surgery, medical,
       medicine, internal medicine, paediatric(s), pediatric(s),
       obstetric(s), gynae, gynaecology, gynecology, emergency) and then one
       title (`HEADING_TITLES`: treatment sheet, drug chart, medication
       chart, prescription chart, fluid chart, observation chart, progress
       notes, clinical notes, case notes, doctor's notes, nursing notes,
       immediate management), or exactly "plan", "management" or
       "treatment" with nothing else (`HEADING_ALONE`; never after a
       prefix: "Medical management", "Surgical management" are plans). The
       text may hold only letters, spaces, apostrophes and those marks: a
       colon, an arrow (→, ->, =>, >), a slash, a digit, a bracket or any
       other symbol keeps it. Nothing else is a heading: "Transfer to the
       ward", "Admit?", "Plan: theatre", "For theatre", "ICU", "Surgery",
       "Observation", "Investigations", "Medical unit", "Fluids", "Accident &
       Emergency", "Ward notes" stay. When in doubt the note is kept: a kept
       heading costs one Keep/Change tap, a dropped plan is a safety loss.
       Counted as `droppedByReason.heading`.
     - *No repeated order* (`tidy.ts` `duplicatesOrder`). A note that only
       repeats a medicine's stop ("DC? Gentamicin?" beside the medicine "Dc
       Gentamicin", status stopped) is left out and the medicine kept, only
       if all hold: (1) the medicine's status is stopped (its status alone,
       never a stop word in its writing) and the two share a cited line or
       their boxes overlap by half the smaller; (2) the note (and its note
       text), marks off, is exactly one stop cue (`STOP_CUES`: dc, d/c,
       stop, stopped, discontinue, discontinued, off) and a drug name, in
       either order, with nothing else (letters, spaces and a hyphen inside
       the name only); (3) that name, its words joined, is the same drug as
       the medicine's live name (the name field without any bracketed
       group: never its crossed-out writing or an "(or …)" option): both
       found by `matchDrugName` with the same generic and the note's name
       as many words as a listed name of it ("Stop IV gentamicin" stays),
       else, for an unlisted name, the same whole name once normalised; (4)
       where the medicine is a combination, the note names the whole
       combination, never a part. Kept (re-review of 2026-11-10): "Stop
       artemether" beside Coartem, "Stop sodium" beside sodium valproate,
       "Stop ceftriaxone" beside "Gentamicin (crossed out: Ceftriaxone)",
       "Gentamicin?" alone, "Continue gentamicin", a stop note beside a
       medicine of status new or unknown, a stop note on another line.
       Counted as `droppedByReason.duplicate_of_order`.
     - *Fixture.* Owner transcript rows changed only where these rules
       apply: the two-drug row (`Cefuroxime` / `Ceftriaxone`) is now two
       items; the heading rows ("Immediate? Management?", "Treatment?
       Sheet?") are left out by the tidy step (`cleanups.spec.ts`); every
       other row is as it was. `cleanups.spec.ts` also holds a fictional
       reconstruction of the live run's line.

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
     prompt, at `OCR_AI_HARD_PAGE_EFFORT` (default `high` since the owner's
     decision of 2026-11-10, `max` before; Claude Opus 5.5 accepts `low` to
     `max`; any other value fails startup). Its user turn is
     `[image, hardPageMessage]` (`hid-paper-reading-hard-page-prompt-12` when
     the reads are offered zoom, else `hid-paper-reading-hard-page-prompt-12-no-zoom`,
     the same text without rule J; `-12` and `-12-no-zoom` add rule A's
     sentence leaving headings out (see "Cleanups of 2026-11-10") to the
     `-11` and `-11-no-zoom` texts, which were the `-10` and `-7` texts;
     `-11` adds the
     answer-only turn of "A hard read always ends with an answer" to the
     `-10` text, unchanged, and `-11-no-zoom` to the `-7` text, recorded as
     `-7` before; `-9` until the one-turn zoom wording of
     2026-11-10, `-8` before that, when rule J allowed 8 zooms; until 2026-11-06 `-4` and `-3`, and `-6`
     and `-5` were never released; the rules
     below are as of `-4`, with the clean-reading changes above; recorded in provenance as
     `hardPagePromptVersion` when used): read the
     page line by line; give a best reading of every field with "?" after each
     uncertain word; a word not readable even as a guess is `[unreadable]`;
     a medicine as route, drug name, dose (a number), unit and frequency, the
     frequency only one of `od bd tds qds 6hrly 8hrly 12hrly nocte mane stat prn`
     (anything else: `[unreadable]`, its words kept in `asWritten`); for each
     field a basis, `letters` (read from the letter shapes) or `context`
     (inferred from what is usual), a field filled from context only with
     basis `context`, and a common medicine not to be preferred over what the
     letters show; ignore show-through from the back of the sheet and text cut
     off at the edges; never invent an item; cite the scanned lines its box
     covers and give its pixel box; rule I, handwritten signs (below); and, with
     zoom on, rule J, the zoom tool (below). Its answer schema
     (`MODEL_OUTPUT_HARD_PAGE_JSON_SCHEMA`) is the image schema plus `dose`,
     `doseUnit`, a restricted `frequency` and a per-item `basis` object
     (`name`, `dose`, `unit`, `route`, `frequency`, `duration`, `value`,
     `other`). The text-only request is byte for byte unchanged (body-hash
     test), and so is the image request for other flagged pages.
   - *Each reading* (`hard-page.ts`): frequency and dose normalised as above,
     the strength rebuilt as dose and unit (`400? mg`), and the drug name
     checked against the drug list (below): a listed name is shown in its
     list spelling with "?" (`Metronidazole?`), a brand as `Flagyl?
     (metronidazole)`, an unlisted one as `[unreadable]` (until 2026-11-06;
     now as read with "?", see *Clean reading*). `asWritten` keeps
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
     query, "?TB" or "TB?") is transcribed `[?]` (since 2026-11-06
     `(? on paper)`) by the hard-page prompt and
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
     compared after normalisation ("?" marks, case, spacing aside; since
     2026-11-06 a disagreement is shown "A? (or B?)", see *Clean reading*,
     replacing what this item says of `[unreadable]` and `A? / B?`): agreeing
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
     `image_refused`). A read still running at `OCR_AI_HARD_PAGE_DEADLINE_MS`
     is aborted and counts as failed here (`hardPageDeadlinePages`; see
     "Hard-page time and cost bounds"). The merged hard reading then goes through
     `mergeReread` with the first pass unchanged, so no first-pass item is
     lost.
   - *Stored.* No new payload field: the per-field basis is carried only by
     the reason codes, so both contract copies are unchanged. The page is in
     `imageRereadPages`; provenance adds `hardPages`, `hardPageReads`,
     `hardPageSingleReadPages`, `hardPageDeadlinePages`, `hardPagePromptVersion` and
     `hardPageZoomPages` (the hard pages whose reads were offered zoom;
     `hardPagePromptVersion` is `-4` only when there is one, else `-3`, the
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
     names (frusemide, lignocaine, co-amoxiclav), and the brand table below.
     Applied only on hard pages. The list never creates a drug: it only
     checks, and respells, a name the model proposed. A medicine not on the
     list (a newer or non-essential drug, an unlisted brand) was shown as
     `[unreadable]` on a hard page until 2026-11-06; it is now shown as read
     with "?" (*Clean reading*).
   - *Strict matching* (`src/reading/list-match.ts`, shared by the drug,
     diagnosis and lab test lists). Exact first (each list normalises case,
     spacing, the reading's "?" marks and punctuation; the drug list also
     ignores salt and form words such as hydrochloride, tab, inj). Otherwise a
     fuzzy match corrects one slip only: names of 6 letters or more, edit
     distance 1, similarity (1 - distance / longer length) 0.85 or more, the
     same first letter, and the same short words (under 4 letters) and digits,
     so "vitamin c" is never respelled "vitamin e", "type 1" never "type 2",
     "hepatitis b" never "hepatitis c". Two different entries equally near is
     no match (ambiguous). A drug name within 2 letters of a real medicine that
     is not on the list (`UNLISTED_LOOKALIKES`: arteether, pefloxacin,
     esomeprazole, ...) is no match either. `list-match.spec.ts` enumerates
     every pair of entries within each list (generics, synonyms and brands
     together; diagnoses with their synonyms; lab tests with their
     abbreviations) and proves no two entries standing for different things
     are within this threshold of each other; the handled-pairs list is empty.
     No new unlisted look-alike was found within 2 letters of a new brand, so
     `UNLISTED_LOOKALIKES` is unchanged; products sold under a listed brand
     name with other ingredients (Panadol Extra, Lofnac Plus, Piriton
     Expectorant, Ciprotab-TN, Galvusmet, Co-Micardis, Gvither Plus, NovoMix
     30) are too far from the brand to match and are tested as no match.
   - *Brands* (`src/reading/brand-names.ts`, a data table with columns
     `brand`, `generic`, `strength_forms`, `source`, `reviewed_by`). A row is
     active only when its `source` cites a public NAFDAC listing: "NAFDAC
     Greenbook, NRN <registration number>,
     https://greenbook.nafdac.gov.ng/products/details/<id> (...), retrieved
     2026-11-05". Each such listing was retrieved from the Greenbook on
     2026-11-05 (its search and the listing's own page) and checked: brand
     name at the start of the product name, active ingredients matching the
     generic(s), nothing else active. Registration numbers were never written
     from memory, and a brand with no such listing found was not added. The
     listing status (Active or Inactive that day) is recorded in the source;
     an inactive (lapsed) registration still names the brand and its
     ingredients. `reviewed_by`: `coordinator-curated` for the 23 brands
     curated with the coordinator before the table (kept active; 11 of them
     now cite a Greenbook listing, the other 12, Plasil, Flagyl, Amoxil,
     Septrin, Panadol, Fansidar, Daraprim, Lasix, Norvasc, Buscopan, Valium
     and Phenergan, had no single-ingredient listing under that name on the
     Greenbook that day and keep source `coordinator-curated 2026-11`), and
     `pending-pharmacist` for the 63 brands added from the Greenbook. A
     pharmacist's review is pending but does not gate use: every brand is
     shown `Brand? (generic)` (for example `Lonart? (artemether +
     lumefantrine)`) on a hard-page item, which is always `check_carefully`.
     Only true brand names, never a manufacturer's name.
   - *Diagnoses* (`src/reading/diagnosis-list.ts`). Two lists. (a)
     `ICD11_TITLES`: 134 titles of the ICD-11 for Mortality and Morbidity
     Statistics, reproduced verbatim, with their codes where they have one
     (a block has none). **ICD-11, World Health Organization, licensed under
     CC BY-ND 3.0 IGO** (https://creativecommons.org/licenses/by-nd/3.0/igo/).
     The titles are not modified (not shortened, respelled, re-cased or
     translated), and the same attribution is in the data file's header. Each
     title and code was checked on 2026-11-05 against WHO's own release file
     for the ICD-11 MMS 2026-01 release, `SimpleTabulation-ICD-11-MMS-en`
     (https://icdcdn.who.int/static/releasefiles/2026-01/SimpleTabulation-ICD-11-MMS-en.zip,
     linked from the browser at https://icd.who.int/browse/2026-01/mms/en);
     only titles found there exactly are listed. (b) `DIAGNOSIS_SYNONYMS`: 120
     abbreviations and local names in our own words (HTN, DM, T2DM, PUD,
     URTI, MP+, typhoid, SCD in crisis, BPH, CCF, CKD, UTI, RVD,
     PIH, PPH, ...), each mapped to one title of (a); no ICD-10 content.
     Abbreviations that stand for more than one thing on Nigerian notes are
     left out and never expanded (`UNGROUNDED_ABBREVIATIONS`): PID (pelvic
     inflammatory disease, or prolapsed intervertebral disc), PET (pre-eclamptic
     toxaemia, or a PET scan), AGE (acute gastroenteritis, or the word "age"),
     SCA (sickle cell anaemia, spinocerebellar ataxia or sudden cardiac arrest),
     SCD (sickle cell disease, or sudden cardiac death; "SCD in crisis" stays
     listed), PTB (pulmonary tuberculosis, or preterm birth on antenatal notes);
     the spelled-out names stay listed. Real diagnoses that are not listed but
     are a letter or two from a listed name (`UNLISTED_DIAGNOSIS_LOOKALIKES`:
     nephritic syndrome, malacia) block a fuzzy match, as for drugs:
     "Nephritic syndrome" is never respelled into "Nephrotic syndrome". An
     abbreviation that does not say which of several titles is meant maps to
     the broader title true of all of them (HTN to "Hypertensive diseases", DM
     to "Diabetes mellitus", SCD to "Sickle cell disorders or other
     haemoglobinopathies"), never to a narrower one that adds what is not
     written. Nothing is coded from the list; it only grounds the shown name.
   - *Lab tests* (`src/reading/lab-list.ts`). 34 test names and 96
     abbreviations in our own words (FBC, PCV, Hb, WBC, ESR, MP, Widal, RBS,
     FBS, HbA1c, E/U/Cr, LFT, urinalysis, MCS, HIV screen, HBsAg, anti-HCV, VDRL,
     lipid profile, PSA, TFT, clotting profile, blood group, genotype,
     pregnancy test, CRP, ...). **No LOINC content**: no LOINC names or codes.
     Names that stand for more than one test are left out and never expanded:
     PT (prothrombin time or pregnancy test), BG (blood group or blood
     glucose), GT, CS, HCV (antibody or RNA), stool analysis. An abbreviation
     never adds a specimen or assay that is not written: Cr is "creatinine",
     AFB is "acid-fast bacilli (afb)", stool M/C/S keeps its culture and
     sensitivity. An unlisted look-alike (`UNLISTED_LAB_LOOKALIKES`: creatine)
     blocks a fuzzy match.
   - *How diagnosis and lab names are used.* On a hard page only, after the
     two readings are held to the page and compared (so every check, and the
     comparison, is made on the names as read, and a lab value is still bound
     to its test as written), a diagnosis name and a lab test name are
     grounded: a listed one that the list changes is shown as read with the
     listed name after it, `HTN? (Hypertensive diseases)`, `FBC? (full blood
     count)`, `(? on paper) TB? (Tuberculosis)` (a query on the paper stays); a name that
     is the listed name as written is left as read; an unlisted one is left
     as read. `asWritten`
     is never changed. Two readings giving different names for one diagnosis
     ("HTN" and "Hypertension") disagree: since 2026-11-06 both are shown,
     each grounded, the title said once where both stand for it (`HTN? (or
     Hypertension?) (Hypertensive diseases)`; before, `[unreadable]`). Every
     hard-page item is `check_carefully`.
   - *Handwritten signs* (`src/reading/signs.ts`; rule I of the hard-page
     prompt). Doctors write signs that stand for words. A sign from the table
     is written as its meaning followed by "(sign)", in `asWritten` and in the
     field ("alternate (sign) days"); any other mark that may be a sign, or a
     sign the model is not sure of, is written `[sign?]`, never a guessed
     word. Code never expands a sign or `[sign?]`: an item holding either gets
     `sign_read` ("A handwritten sign was read as a word, marked "(sign)", or
     could not be read, marked "[sign?]"; check it against the paper.", said
     after `field_from_context` and `single_reading_only`, so an item only one
     reading found says so first); no list
     matches a name holding either; `forMatching` keeps `[sign?]` (like
     `[?]` and `(? on paper)`), its "?" is not a status cue, and the marks never anchor an item
     to a line (the word "sign" is not on the paper). No picture of a sign is
     kept anywhere; each is described in words. The table:

     | Sign (described) | Written as | Source |
     |---|---|---|
     | two strokes or arrows pointing opposite ways, one above the other, like a zigzag or ⇌ | alternate (as in alternate days) | owner, 2026-11-05 (doctors' usage); "alternate days" as a prescription direction: Wikipedia, "List of abbreviations used in medical prescriptions" (alt. d., *alternis diebus*), read 2026-11-05 |
     | c with a bar over it (c̄) | with | Wikipedia, "List of abbreviations used in medical prescriptions" (c̄, *cum*), read 2026-11-05 |
     | s with a bar over it (s̄) | without | same (s̄, *sine*) |
     | arrow up (↑) | increased (raised) | Wikipedia, "List of medical abbreviations", orthographic styling: arrows for elevation, read 2026-11-05 |
     | arrow down (↓) | decreased (low) | same (diminution) |
     | triangle (Δ) | diagnosis | common clinical usage |
     | # before a bone or a part of the body | fracture (# before a number is a count, copied as written) | common clinical usage |
     | tick (✓) | done (for something done or given) or present (for a finding), by its printed heading; else `[sign?]` | common clinical usage |
     | cross (✗) alone in a box or after a label | not done or absent, by its heading; else `[sign?]`; a cross through writing is a crossing-out | common clinical usage |

     Abbreviations written in letters and numbers are not signs: they are
     copied as written (never with "(sign)"); the prompt gives their meaning
     only to help read hard letters: Hx history (Wikipedia, "List of medical
     abbreviations: H"), Rx treatment or prescription; stat at once, prn when
     needed, od once a day (or, on eye drops, the right eye), bd twice a day, tds three times a day, qds four
     times a day, nocte at night, mane in the morning (each in Wikipedia,
     "List of abbreviations used in medical prescriptions", read 2026-11-05,
     which also notes "o.d." can mean right eye); n/7 days and n/52 weeks
     (common clinical usage), n/12 months (Wikipedia, "List of medical
     abbreviations": "/12" used in some regions). The BNF and ISMP pages were
     tried and could not be read from here (BNF: HTTP 403; ISMP's list is a
     gated download), so neither is cited. `mane` is now one of the hard-page
     frequencies. Dose shorthand is put in words only in a hard-page
     medicine's `plain`, and only where the read is certain (no "?",
     `[?]` or `[sign?]` in the field): `tds (three times a day)`,
     `5/7 (5 days)`; otherwise it is kept as written. `od` is always kept as
     written, never put in words: on eye drops it is the right eye, and the
     code is lower-cased before this step. Signs are in the
     hard-page prompt only: they are read from the picture, which the first
     pass never sees (its scanned text loses or garbles a sign), and the image
     re-read of a page that is not a hard page keeps rule D (never guess), so
     the system prompt and the other requests are byte for byte unchanged.
   - *Decisions* (owner, relayed by the coordinator): 2026-11-05 about 18:40
     UTC, "Yes, use a drug list"; about 20:25 UTC, the licences (ICD-11 titles
     verbatim under CC BY-ND 3.0 IGO with attribution; our own lab names, no
     LOINC; brands each sourced to a NAFDAC listing); about 21:00 UTC, "add
     all those list now" (brands with NAFDAC sources and `reviewed_by`,
     ICD-11 diagnoses with our own synonyms, lab tests), and that doctors
     write signs that mean words (the example: two strokes pointing opposite
     ways, like a zigzag or ⇌, meaning "alternate"; no photo kept).
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
       (the prompt text adds rule J only when zoom is on). A page whose
       picture fails zoom's checks from its bytes (below, *Limits*) is not
       offered the tool either: no tool, no rule J, and `-3` as its prompt
       version.
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
     - *Limits.* At most `OCR_AI_ZOOM_MAX_CALLS` (default 4, 0 to 4, since
       2026-11-10; was 8; 0
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
       decodes a picture only if it passes checks made from its bytes, before
       anything is inflated or decoded (`zoomDecodable`); a picture that fails
       them is still sent whole, with zoom off (not offered):
       - a PNG of at most 24 MP (6000 x 4000; below the 64 MP the picture
         itself may have, on purpose), at 8 bits or fewer per sample and not
         interlaced, whose chunks walk cleanly (`pngStructure`, on the walk
         `pngChunks` in `page-image.ts`): the signature, every chunk's length
         inside the bytes and its CRC correct (zlib's native `crc32`; pngjs
         and libpng both refuse a bad CRC, and it costs about 6 ms for a
         23 MB file), exactly one IHDR and it first (13 bytes; a later IHDR
         anywhere is refused), a bit depth the colour type allows,
         compression and filter method 0, only IHDR, PLTE, IDAT, IEND and
         known ancillary chunks (PNG third edition's and Apple's `iDOT`; any
         other chunk, critical or not, is refused), PLTE and tRNS where and
         as long as the specification says, all IDATs in one run, and IEND
         last with nothing after it. (A reviewer showed that pngjs 7.0.0
         takes a second IHDR as the picture's new size, depth and
         interlacing and inflates and allocates at that size, outside the
         V8 heap the worker's limits bound: a 249 KB file whose first IHDR
         said 100 x 100 reached about 995 MB RSS, its 16-bit variant
         (498 KB) 1.43 GB, its interlaced one 577 MB. All three are now
         refused by the walk in about 1 ms at 65 MB RSS for the process.)
         The size the picture is sent at (`pngDimensions`) is read from the
         same walk, so a PNG with a second IHDR, a bad CRC or no IEND is not
         sent at all (`image_size_unknown`; the API's decoder might see
         another size than the line boxes assume); the chunk type list is
         zoom's only;
       - a JPEG of at most 12.5 MP (4000 x 3125; a 12 MP phone photo fits),
         whose marker segments parse (`jpegStructure`: every length checked,
         DQT, DHT, SOF, DRI and SOS exactly as long as their contents, the
         entropy-coded data skipped with stuffed `0xFF 0x00` bytes and restart
         markers handled, only APPn, COM, DQT, DHT, DRI, SOF0-SOF2, SOS and
         EOI allowed), with exactly one 8-bit Huffman frame (baseline,
         extended or progressive) of 1 or 3 components (CMYK and YCCK
         refused), and at most 16 scans, counted both in the walk and as
         `0xFF 0xDA` pairs anywhere in the bytes. jpeg-js walks every block in
         every scan, so without a scan limit a small progressive file could
         keep it busy for minutes (measured: 5,000 near-empty scans in a
         492 KB file took 17 s at 24 MP). 16 covers libjpeg's standard
         progressive script (10 scans) and similar encoders with room for an
         EXIF thumbnail. The walk also refuses the byte patterns in scan data
         where jpeg-js 0.4.4 would read markers somewhere else (its parse loop
         and `decodeScan`, enumerated in `zoom-raster.ts`): after a restart
         marker, `0x00 0xE0`, `0x00 0xE1` (its "malformed APP" recovery jump),
         `0xFF 0x00` or another restart marker; after a stuffed `0xFF 0x00`,
         `0x00 0xE0`/`0x00 0xE1` whose recovery jump would land on `0xFF`. (A
         reviewer showed that a restart marker after a scan's last MCU,
         followed by `0x00 0xE0`, sent jpeg-js into a COM segment holding a
         hidden second frame, which it allocated before refusing: a 16 x 16
         checked file reached about 540 MB to 1 GB RSS.) Real photos hit
         these by chance about once in 20,000 restart markers; only zoom is
         off for them (20 fictional noise photos with 85,000 restart markers,
         4:4:4, 4:2:2, 4:2:0, grey and progressive, all passed the walk; two
         grey ones with restart markers jpeg-js itself cannot decode, as
         before).
       Not relying on the walk and jpeg-js agreeing, jpeg-js is given its own
       limits from the frame the walk checked: `maxResolutionInMP` that
       frame's pixels, and `maxMemoryUsageInMB` exactly what its own count
       (`requestMemoryAllocation`) needs for that frame: its padded blocks
       (256 bytes each, per component and sampling), its component lines, its
       colour conversion and its RGB output, the tables in the walk, and 64
       KiB (`jpegMemoryBudget`; a test checks the count is exact at 4:4:4,
       4:2:2, 4:2:0, a 4 x 2 luma and grey). A frame jpeg-js finds anywhere
       else is refused by that count before its blocks are made: on the
       reviewer's layout with the walk bypassed, the 16 x 16 file is refused
       in 1 ms at 52 MB RSS (before: 540 MB), and a hidden 4-component frame
       as large as a 12.5 MP checked one is refused at about 665 MB (before:
       890 MB; the real 12.5 MP decode itself peaks about 555 to 605 MB).
       Likewise for a PNG, pngjs's chunk parser is not used at all: zoom
       inflates the checked IDATs itself with zlib's `maxOutputLength` set to
       exactly what the checked IHDR needs (`pngInflatedSize`: each row's
       filter byte and packed samples), refuses any other inflated size, and
       hands the rows to pngjs 7.0.0's own unfilter, unpack and palette code
       (`lib/filter-parse-sync`, `lib/bitmapper`, `lib/format-normaliser`,
       with PLTE and tRNS from the walk), so every buffer made is that
       header's size (`decodePngWithin`). With the walk bypassed (the 100 x
       100 header taken over the reviewer's IDAT), zlib stops at 30,100 bytes
       and the decode is refused in 1 ms at 53 MB RSS (before: 995 MB to
       1.43 GB); a clean walk whose IDAT inflates to more or less than its
       header needs is refused the same way. A 24 MP RGBA page with light
       noise (43 MB, over the picture limit, so heavier than any page sent)
       decodes and crops in 1.7 s at about 480 MB peak RSS for the process
       (before: 2.1 s, 550 MB).
       Every decode, and every crop's resample and PNG encode, runs in a
       worker thread of its own (`zoom-jobs.ts`, `zoom-worker.ts`; built to
       `dist/reading/zoom-worker.js`, which the image copies with the rest
       of `dist`): the pixels come back as a transferred `ArrayBuffer`, and
       the raster is moved to each crop's worker and back, never copied. A
       decode not answered within 5 s or a crop within 3 s (from when the
       worker is ready; starting it has its own 10 s limit) is ended with
       `worker.terminate()`, which stops even a decoder stuck in a loop; an
       abort (the worker's shutdown) terminates it at once. Each worker is
       terminated when its job ends, answered or not, so none outlives a
       job or a reading (tests check). The worker has V8 heap limits (512 MB
       old generation, 64 MB young: a backstop four times the measured need,
       since V8 can abort the whole process when a worker hits its heap
       limit while allocating a buffer). One zoom worker runs at a time in
       the process; another job's zoom waits for it (an abort ends the
       wait). The main event loop no longer stalls: measured on fictional
       pages at the limits, built (Node 22, one core), the worst JPEG
       allowed (12.5 MP, 4:4:4, 6 to 7 MB of noise) took 2.0 to 2.2 s
       (baseline) and 3.0 s (progressive) to decode and crop, and a
       full-page crop 1.4 s, while a 10 ms timer on the main thread was
       never more than 40 ms late; the worst PNG for time (24 MP, 1- or 2-bit grey or
       palette) about 2.4 s to decode, and for memory (24 MP RGBA) 1.7 s. Peak
       memory of the process: one decode at a time, at most about 610 MB
       RSS measured for the whole process during the worst JPEG (520 MB for
       the PNG), plus the rasters kept for the readings in progress (RGB, at
       most 72 MB per zoomed page, dropped with the reading), within the
       2 GiB task. A decoded size other than the header's, any decoder
       error, a heap limit, a worker crash or a time limit turns zoom off for
       that page ("zoom unavailable"), never the reading.
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
       turn, read at $0.22 per million), plus the turn's own output. (Before
       2026-11-10, when a read could zoom 8 times:) eight
       zooms in one read can add roughly 40,000 input tokens and a few
       thousand output tokens; the `zoomCalls` and `hard_page_read` usage
       lines give the real figures.
   - *Cost and time.* Each hard page costs two reads where the earlier image
     re-read was one request at `high`. The first estimate here (about $0.37
     to $0.46 for the two reads, from about 7,000 to 9,000 output tokens per
     read at `max`) was wrong by about 8x in production; the bounds below
     replace it.
   - *Hard-page time and cost bounds* (coordinator decision of 2026-11-10,
     relaying production numbers). **Evidence**: job 5419047a on 2026-11-06,
     the owner's one fictional handwritten treatment sheet, read with the
     #200 reader: `durationMs` 788,235 (13 minutes); `hard_page_read` 8
     requests, 146,246 output tokens, 70,773 cache-write tokens, 16 zoom
     calls, 1 refused at the limit; 12 items; `droppedByReason`
     `{rows_not_together: 1}`. About $3.60 for the page against the $0.37 to
     $0.46 above, and the website polls for 3 minutes only, so the owner
     never saw the result. **Where it went** (from the code and those
     counts; the real API was not called): the two reads already ran at once
     (`Promise.allSettled`; each holds a permit of
     `OCR_AI_MAX_CONCURRENT_REQUESTS`, default 4, per attempt only; the
     repository's deployment does not override it). 8 requests for 16 + 1
     zoom calls is 4 turns per read with no retries (each read: about 3 turns
     of 2 to 3 zoom calls each, then its answer; both reached the 8-call
     limit). Output was 88% of the cost: 146,246 x $22 per million = $3.22,
     cache writes 70,773 x $5.50 per million = $0.39. That is about 18,300
     output tokens per request, almost all thinking at `max` (12 items of
     JSON are about 3,000 to 4,000 tokens per answer), and every zoom turn
     thinks again. About 73,000 output tokens per read in about 700 seconds
     (the rest of the 788 went to Textract and the first pass) is about 100
     output tokens per second per stream, so one `max` turn took about 3
     minutes. Zoom itself is not where the time went: measured on a
     fictional 12 MP JPEG with the built worker, the page's one decode and
     its first crop take about 1.7 s, each later crop about 0.2 s, so 16
     crops (one at a time in the process) add about 5 s.
     **Bounds** (all fail-closed settings; startup fails on any other value):
     - `OCR_AI_HARD_PAGE_DEADLINE_MS` (default 150,000; 30,000 to
       1,800,000): from when a hard page's two reads start. Each read has its
       own abort signal (the job's and its own together), so the deadline
       ends a permit wait, a streamed request, a zoom crop or a backoff sleep
       alike: the whole tool loop with its retries. At the deadline every
       read still running is aborted. A read that had answered is used alone
       (`single_reading_only` on its items, as when the other read fails;
       no new item reason, since what the doctor must do is the same); none
       answered: the page is a failed image re-read (the first pass kept,
       every item `reread_failed`). The job never fails for it; a shutdown
       during the reads still stops the reading as before.
       `ocr.job.completed` carries `hardPageDeadlineHits` (pages where the
       deadline cut a read), provenance `hardPageDeadlinePages`, and the cut
       read's usage line `endedBy: "deadline"`. The per-request
       `OCR_AI_HARD_PAGE_TIMEOUT_MS` (default 900,000) still applies inside
       it but no longer bounds the page.
     - `OCR_AI_ZOOM_MAX_CALLS` default and maximum 4 (was 8), so at most 4
       crops per read and (since "A hard read always ends with an answer",
       which replaced the 3 turns allowed past the limit) at most 6 turns:
       up to 4 zoom turns, one follow-up turn with zoom no longer offered,
       and the answer-only turn only if that one did not answer; rule J's text says 4 (hard-page prompt 9, `PROMPT_VERSION` 9;
       still 4 in prompt 10).
     - `OCR_AI_HARD_PAGE_MAX_TOKENS` (default 32,000; 4,096 to 128,000):
       output tokens for one read, all its turns together; each turn's
       `max_tokens` is what is left (turn 1: 32,000; after a turn of 10,000:
       22,000), and a turn with less than 2,048 left is not sent (the read
       ends `max_tokens`, a failed read). Since "A hard read always ends
       with an answer" each turn before the answer-only one keeps 8,000 of
       it back (turn 1: 24,000), and the answer-only turn gets them. It counts the output the API
       *reported*, so it bounds each attempt, not the read's billed output:
       a retry of a turn (`OCR_AI_MAX_RETRIES`) is sent the same
       `max_tokens`, and an attempt that failed mid-answer counts about 1
       output token (see `outputTokensIncomplete` below), so up to
       `OCR_AI_MAX_RETRIES` + 1 attempts of one turn can each use what was
       left. The bound relied on for a read is the deadline. Other requests keep
       `OCR_AI_MAX_TOKENS` (64,000), so the text-only body is byte for byte
       unchanged. 32,000 is under half of what one read used in production
       and about 4x the answer plus thinking of a `max` read without zoom.
     - `OCR_AI_HARD_PAGE_FOLLOWUP_EFFORT` (default `high`): the effort of each
       turn after a zoom `tool_result`; the first turn keeps
       `OCR_AI_HARD_PAGE_EFFORT` (default `high`). Checked against the Claude
       API reference: a different top-level effort between turns of one
       tool-use conversation is accepted with adaptive thinking, and the
       earlier thinking blocks (sent back unchanged, signatures and all) stay
       valid; but it is a messages-cache breaker, so the first follow-up turn
       writes the cache again (picture, prompt and crops so far: about 10,000
       to 15,000 tokens, about $0.06 to $0.08 per read at $5.50 per million,
       where reading it would cost about $0.003) and later turns read it. The
       cache-keeping alternative, a per-message effort system message (beta
       `mid-conversation-output-config-2026-07-01`), cannot work here: placed
       after a user turn of only `tool_result` blocks it waits for the next
       user turn with new input, which a zoom loop never has. Setting the
       follow-up effort equal to `OCR_AI_HARD_PAGE_EFFORT` keeps one effort
       and no cache break.
     - `OCR_AI_MAX_CONCURRENT_REQUESTS` must be at least 2 when the hard-page
       reads are on (startup fails otherwise): with one permit the two reads
       would take turns (a test shows both reads in flight before either
       answers with 2 permits, and only one with 1).

     **Zooms in one turn** (coordinator's decision of 2026-11-10, a
       follow-up to the bounds above; hard-page prompt 10, `PROMPT_VERSION`
       10). Production showed about 4 turns per read, one zoom per turn,
       each turn thinking again over the picture and the crops so far. Rule
       J now asks the model to decide every place where a closer look would
       help, request all of those zooms together in one response (several
       zoom calls at once), answer from what they show, and zoom again only
       if a crop is still unclear and calls are left. The zoom tool's
       description says the same (its strict schema is unchanged). The cap
       of 4 calls per read, the effort, the token cap and the deadline are
       unchanged; the hard-page text without zoom (`-7`) and the text-only
       request are byte for byte unchanged. The client already handled
       several calls in one turn (Claude API parallel tool use: several
       `tool_use` blocks in one assistant turn, all their `tool_result`
       blocks in the next user turn, in call order): every call counts
       against the cap whether answered or not, so 5 calls in one turn with
       the cap at 4 give 4 crops and 1 `zoom limit reached` error (tested),
       and a later turn's calls are counted against what is left.
       *Expected effect*: about 2 turns per read (one turn of zooms, one
       answer; 3 when one crop is still unclear) instead of about 4, so
       fewer thinking passes and fewer re-sends of the picture and crops,
       and more reads finishing inside the 150 s deadline. *How to see it*:
       the per-read `ocr.reading.usage` line (`pass: "hard_page_read"`)
       carries `turns` (answered requests of the read) and `zoomCalls`; with
       this wording a read that zoomed should mostly show `turns` 2 with
       `zoomCalls` 1 to 4, where before `turns` was about `zoomCalls` + 1.
       It is an instruction, not a constraint: the model may still zoom one
       at a time, which the cap and the deadline bound as before.

     **Cost model** (Claude Opus 5.5 list price $4 / $20 per million input /
     output tokens, x1.1 for US-only: $4.40 / $22; 5-minute cache writes
     $5.50, cache reads $0.22):
     - *Before* (measured, job 5419047a): $3.22 output + $0.39 cache writes
       + uncached input and cache reads (not in the evidence; a few cents) =
       about $3.60 to $3.70 per hard page, 13 minutes.
     - *Worst case now*, both reads to their token cap before the deadline,
       no attempt failing mid-answer: 2 x 32,000 x $22 per million = $1.41
       output, plus about $0.10 to $0.20 input: about $1.50 to $1.60. Above
       the $1 target: `OCR_AI_HARD_PAGE_MAX_TOKENS` 20,000 or less keeps it
       under $1 (2 x 20,000 x $22 per million = $0.88, plus input) only while
       no attempt is retried after failing mid-answer: the cap is per
       attempt, so a stream that fails late and is retried can add up to
       another cap's worth. What actually holds the money is time:
       `OCR_AI_HARD_PAGE_DEADLINE_MS` (next point) at the production rate.
       Raising the deadline (allowed up to 1,800,000 ms) raises this bound.
     - *Deadline-bound* (what production's rate implies): about 100 output
       tokens per second per read for 150 s is at most about 15,000 output
       tokens per read, 30,000 per page: about $0.66 output, plus input,
       about $0.80 per page, never over 150 s for the reads.
     - *A page that finishes*: per read, turn 1 at `max` about 9,000 output
       tokens (the earlier estimate for a whole `max` read without zoom),
       then 2 follow-up turns at `high` of about 5,000 each: 19,000 per read,
       38,000 per page = $0.84 output; input per read about 6,000 written on
       turn 1 ($0.033), about 11,000 written again on the first follow-up
       turn ($0.06) and a little read: about $0.10, so $0.20 per page; about
       $1.04 per page. At about 100 tokens per second, 19,000 tokens take
       about 190 s: longer than the deadline. **Trade-off**: at production's
       measured rate, a read that starts with a `max` turn (about 18,300
       output tokens, about 3 minutes, on the owner's page) will usually be
       cut by the 150 s deadline, and the page will then keep its first
       reading. A read finishes within 150 s only at about 15,000 output
       tokens or fewer, which is what 3 turns at `high` (about 5,000 each)
       give: about $0.66 output plus about $0.15 input (no effort change, so
       no second cache write) = about $0.80 per page. **Owner decision of
       2026-11-10, about 16:40 UTC** (relayed by the coordinator): "High
       (Recommended)" thinking for hard handwritten pages, about 2.5 minutes
       and about $0.80 a page, both reads kept, 32,000 cap kept. So both
       `OCR_AI_HARD_PAGE_EFFORT` and `OCR_AI_HARD_PAGE_FOLLOWUP_EFFORT` default
       to `high` (one effort for the whole read, no cache rewrite); `max` stays
       a setting for the comparison below.
     **Measuring `high` against `max` in staging** (no API key or owner
     photo was available where this was written, so no offline comparison
     was run): set `OCR_AI_HARD_PAGE_EFFORT` to `max` or `high` (and
     `OCR_AI_HARD_PAGE_FOLLOWUP_EFFORT`), restart, and read the same
     fictional page a few times each. `ocr.worker.ready` logs the hard-page
     settings in force; each read logs one `ocr.reading.usage` line
     (`pass: "hard_page_read"`, `page`, `read` 1 or 2, `requests`, `turns`,
     `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
     `durationMs`, `zoomCalls`, `zoomLimited`, `effort`, `followupEffort`,
     `endedBy`: `answer`, `deadline`, `max_tokens`, `refused` or `error`,
     `outputTokensIncomplete`), in place of the one line for the pass, so
     the lines still add up to the reading's use; numbers, codes and that
     flag only, no item text. **Cut reads are not costed by these lines.**
     A streamed answer reports its output tokens only in its final event;
     an attempt cut after the model had begun (a read ended by the
     deadline mid-turn, which is the usual case for a first turn at `max`,
     a shutdown, a timeout or a stream failure) counts its input and only
     about 1 output token, while the thinking it had generated is billed.
     Such a line has `outputTokensIncomplete: true` and its `outputTokens`
     is a lower bound; `ocr.job.completed` carries
     `hardPageReadsOutputIncomplete` (the number of such reads), and the
     job's `outputTokens` and stored usage under-count by the same amount.
     The cost of cut reads, and so of a `max`/`high` comparison where
     reads are cut, must come from the Anthropic usage and cost report for
     the staging key and time window, not from these lines. Compare the
     readings against the owner's two chat transcripts for style (they are
     not ground truth) and the usage lines for cost and time.
   - **A hard read always ends with an answer** (coordinator decision of
     2026-11-10, after staging job 566c38bf on the #200 reader, before the
     bounds above were deployed). **Incident**: claimed 16:38:18, completed
     16:57:22, `durationMs` 1,143,769 (19 minutes); `hard_page_read` 8
     requests, 174,266 output tokens, 16 zoom calls; `ocr.job.completed`
     `imageRereadFailedPages` 1, `rereadFailedPages` 1, `itemCount` 0,
     `hardPageReads` 2, `hardPageAgreement` all zeros; no warn or error line
     for the job. About $3.50 (174,266 x $20 per million is $3.49 output)
     and the owner got nothing.
     **Diagnosis** (from the #200 code, `git show f411b760`, and those
     counts; the real API was not called, and the #200 reader logged
     nothing per read, so the exact stop reasons are not in the logs). In
     #200 every turn of a zoom read was sent `max_tokens` =
     `OCR_AI_MAX_TOKENS` (64,000 by default) at `max` effort, up to 8 zoom
     calls per read, no deadline, and a read ended at the first turn that
     did not stop with `tool_use` (`interpret`): `refusal` (refused),
     `max_tokens` or `model_context_window_exceeded` (failed `max_tokens`),
     another stop reason (failed `incomplete`), or `end_turn` whose text was
     not JSON or not the answer schema (failed `malformed`); or a turn with
     `tool_use` and no call, or the 12th turn (8 calls + 3 extra turns +
     1), as failed `incomplete`; or an error after the retries. None of them
     logged anything: the reader turned a hard page with no answer into a
     failed image re-read (`imageRereadFailedPages`), and that was all.
     What the counts allow: 16 crops returned is 8 per read, each read's
     whole cap; 8 requests is 4 per read (the two reads always run
     together), so each read ended on its 4th request and that request did
     not stop with `tool_use` (else a 5th would have been sent). That rules
     out the turn guard (it needs 12 turns), a timeout (each turn could take
     900 s and a turn that timed out is retried, so a read ending that way
     shows at least 5 attempts and about 1 output token for each cut one,
     not 87,000 reported tokens per read), and both reads refused (the page
     would then have gone to a text re-read and not be counted in
     `imageRereadFailedPages`). What is left for each read: its last turn
     stopped at `max_tokens`, or ended `end_turn` with an answer that failed
     the schema check. **The counts do not separate these two.** A
     `max_tokens` ending fits them (3 zoom turns per read and a last turn
     stopped at the 64,000 cap: 2 x 64,000 + 6 x 7,711 = 174,266), but that
     7,711 is solved from the total, so the sum matches by construction and
     is a consistency check, not evidence; a `schema_error` ending fits them
     as well (8 turns averaging about 21,800 output tokens at `max`, each
     under the 64,000 cap). Leaning `max_tokens` (a guess, not a measured
     likelihood) only on priors: with all 8 crops in front of it, a `max`
     turn deciding every field of a dense handwritten page has little to
     stop it before the cap, while structured outputs
     (`output_config.format`) constrain the final JSON to the schema and
     the worker's own checks beyond it (strings up to 2,000 characters, 60
     line ids, 300 items, finite numbers) are rarely reached. **The deciding
     test** is per request: in the Anthropic Console's usage for that key
     and time window, two requests with exactly 64,000 output tokens mean
     `max_tokens`; none means the answers were off-schema. The rule below
     covers both: a `max_tokens` stop gets the answer-only turn, and a
     schema failure is now logged with its code. The `max_tokens` path is
     reproduced with the fake API (`claude.client.spec.ts`, "reproduces job
     566c38bf").
     **`itemCount` 0 is not a bug**: with both reads failed, the page keeps
     its first reading (`markRereadFailed`, every item `reread_failed`;
     `rereadFailedPages` 1 is that path), and `itemCount` counts what the
     page ends with, so the first pass kept no item on that page: a hard
     page is chosen by its lines' legibility (`handwriting` or
     `low_confidence`), not by its items, and on garbled handwriting the
     text-only first pass often has nothing that holds to the scanned lines.
     The job's `droppedUngrounded` and `droppedByReason` (which, with the
     re-read failed, are the first pass's) would show whether it read
     items that were then dropped. Tested: both reads failing keep the first
     pass's items (worker test), and a first pass with none gives 0 items,
     the page flagged `ai_unsure` and named in `imageRereadFailedPages`
     (reader test, "incident shape"). `ocr.job.completed` now also logs
     `firstPassItemCount`.
     **Could the bounded reader (#201, #202) fail the same way?** Yes, and
     more often: at the measured rate of about 100 output tokens per second
     a read gets about 15,000 output tokens in the 150 s deadline, so the
     32,000-token cap and the 2,048-token rule almost never bind first (they
     would only above about 210 tokens per second); the zoom cap of 4 plus 3
     extra turns is out of reach in 150 s; refusals and schema failures are
     rare. What does bind is the deadline: a read whose turns had not
     finished at 150 s was aborted with no answer, and the two reads run the
     same request at the same time, so they tend to be cut together. That
     is the incident again (a page with nothing from either read after the
     thinking was paid for), only shorter: up to about $0.66 output per page.
     **The rule**: a hard read that has not answered gets one answer-only
     turn, while time allows (`claude.client.ts`):
     - Reserves: each turn before it is sent `max_tokens` = what is left of
       `OCR_AI_HARD_PAGE_MAX_TOKENS` less 8,000 (at most half the cap), so
       8,000 are always left for the answer (a 12-item answer is about 3,000
       to 4,000 tokens, job 5419047a; room for a page about twice as dense);
       and the last 50 s before the page's deadline (at most a third of
       `OCR_AI_HARD_PAGE_DEADLINE_MS`) are kept for it: about 4,000 to 5,000
       tokens at 100 per second, a 12-item answer with little thinking, plus
       a few seconds to read the picture and crops again. The time reserve
       never leaves the first turn less than 40 s (twice the 20 s turn
       minimum), and a reserve that would then be under 20 s is none
       (`answerReserveMs`): below a 60 s deadline (the setting allows
       30 s) there is no time reserve, and the read runs bounded by the
       deadline alone, as before. Without this, a 30 s deadline (a reserve of
       10 s, 20 s before it, less than the turn minimum after any elapsed
       millisecond) sent every hard read straight to the answer-only turn.
     - When the zoom calls are used up (or the read has had as many zoom
       turns as it has calls), zoom is closed, not the read: the next turn is
       an ordinary follow-up turn (`followupEffort`, the tokens left less
       the reserve, no new instruction) with `tool_choice: {type: "none"}`.
       This is the normal path the prompt asks for (rule J: all zooms in one
       turn, then the answer), so a read that asked for its 4 crops at once
       answers at the same effort as one that asked for 3. The usage line
       records it as `zoomClosed` (`zoom_cap` or `turns`), at info.
     - The answer-only turn is sent when: the tokens left reach the reserve
       (`budget`); less than 20 s is left before the time reserve, or a turn
       is still thinking when the reserve begins (that attempt is aborted,
       not retried; its thinking so far is billed and lost) (`deadline`); a
       turn stops at `max_tokens` (`max_tokens`); or a turn ends with neither
       an answer nor a tool call, or still calls the tool after zoom was
       closed (`incomplete`).
     - **Trade-off of the time reserve**: a turn that is already writing its
       answer text when the reserve begins (its latest content block is
       text) is not cut: it is left to finish, bounded by the request
       timeout and the page's deadline, so an answer that #202 would have
       finished before the deadline is not thrown away. A turn still
       thinking at that point is cut, and some of those would have finished
       in time under #202: they now end as a low-effort answer-only reading
       instead of a full-effort one (the thinking already billed is lost,
       and the effort change rewrites the messages cache). That is the
       price of never ending with nothing when the thinking runs long, as
       in the incident; `forcedAnswer` `forced_answer_deadline` with
       `answered: true` counts how often it is paid.
     - What it is: the conversation so far, append-only (a turn cut off or
       stopped without an answer is left out: its thinking block cannot be
       sent back), then a new user message (`FORCED_ANSWER_INSTRUCTION`:
       stop looking, answer from what has been seen, in the answer format;
       for a read never offered zoom, `FORCED_ANSWER_INSTRUCTION_NO_ZOOM`,
       the same without the sentence saying the zoom tool is gone),
       `max_tokens` the reserve (or what is left, if less), effort `low`
       (thinking cannot be turned off on Claude Opus 5.5; the turn writes
       down what earlier turns read, and every thinking token is time and
       tokens the answer does not get), the same answer schema
       (`output_config.format`), and, when the zoom tool was declared,
       `tool_choice: {type: "none"}` with the tool still declared (earlier
       turns hold `tool_use` and `tool_result` blocks; forced tool use is a
       400 on Claude Opus 5.5, `none` is accepted, with adaptive thinking and
       with structured outputs). The changed effort and `tool_choice` break
       the messages cache for that one turn.
     - Only one answer-only turn; how it ends is how the read ends. A
       refusal ends a read at once (the reader may still send the page to a
       text re-read), and so does an answer that is not JSON or not the
       schema: no repair turn, since structured outputs constrain the JSON
       and a failure would most likely repeat, at the price of another read
       of the picture and crops; its reason is logged.
     - Unchanged: the two reads run at once; the page's deadline still ends
       every read (the answer-only turn included; it is not retried past
       it); the read's reported output stays within
       `OCR_AI_HARD_PAGE_MAX_TOKENS` (the reserve is carved out of it, never
       added); text-only and ordinary image re-read requests are byte for
       byte as before. The hard-page prompt is version 11 (`-11`,
       `-11-no-zoom`) and `PROMPT_VERSION` 11, here and in ocr-api, so a
       reading made the older way is not reused.
     **Logs** (codes and counts only; never item text, page content or the
     picture). The warn lines are written as soon as the reading is done,
     before the payload's contract check and completion, so they appear
     however the job then ends (a contract violation or a failed
     completion included):
     - `ocr.reading.hard_read_failed` (warn), one per hard read without an
       answer: `page`, `read`, `reason` (`max_tokens`, `parse_error`,
       `schema_error`, `refusal`, `zoom_loop`, `incomplete`, `deadline`,
       `api_error`, `api_rejected`), `code` (the AI_* code of an API
       failure), `forcedAnswer`, `turns`, `requests`, `outputTokens`,
       `outputTokensIncomplete`, `zoomCalls`, `zoomLimited`, `durationMs`.
     - `ocr.reading.hard_read_forced_answer` (warn), one per read sent the
       answer-only turn: `reason` `forced_answer_budget`, `_deadline`,
       `_max_tokens` or `_incomplete`, `answered`, and the same counts.
     - `ocr.reading.page_read_failed` (warn), one per page whose reading in a
       pass gave nothing usable, for the paths that logged nothing before:
       `page`, `pass` (`first_pass`, `reread`, `image_reread`,
       `hard_page_read`, `last_resort_read`), `reason` (as above, or
       `kept_nothing` for an answer none of whose items held to the page while
       the first pass had some, `hard_reads_failed`, or for the last resort
       `last_resort_failed`, `last_resort_no_picture`),
       `code`, and for the last resort `detail` (see "Last resort").
     - `ocr.reading.usage` per hard read gains `failure`, `forcedAnswer`,
       `forcedEffort` (`low` when the answer-only turn was sent, else null;
       `followupEffort` counts only the follow-up turns, never the
       answer-only one) and `zoomClosed`;
       `ocr.job.completed` gains `hardReadFailures` and
       `hardReadForcedAnswers` (counts per reason), `pageReadFailures` and
       `firstPassItemCount`.
   - **Last resort** (coordinator decision of 2026-11-10, after staging job
     566c38bf on the #203 reader). **Evidence**: the owner's fictional
     handwritten page; the text-only first pass (Claude Opus 5.5, its request
     byte for byte as since 2026-11-05, hash-pinned) came back almost empty
     (`outputTokens` 150, `inputTokens` 745, against 483 to 1,036 output tokens
     on earlier runs of nearly the same page: a model outcome, not a change of
     ours), so it kept no item on the page; then both hard-page reads failed,
     and the page ended with `itemCount` 0: the owner got nothing.
     **The rule**: when a page has no usable reading at all, it gets **one**
     last-resort image re-read, if it has a picture:
     - *When.* (a) A hard page whose two reads **both** failed (no hard
       reading; `hard_reads_failed`) **and** whose first pass kept no item on
       that page, or a hard read answered but no item of the hard reading
       held to the page while the first pass kept none either (a
       `page_read_failed` warn with `pass` `hard_page_read`, `reason`
       `kept_nothing`).
       (b) A page whose first pass **failed or was declined** and whose text
       re-read then gave no answer either (failed, declined, or unavailable
       after its retries), or answered with no item that held to the page (a
       `page_read_failed` warn with `pass` `reread`, `reason` `kept_nothing`;
       if the last resort gives nothing too, the page is failed, `ai_unsure`,
       not an empty page counted as re-read). Not when the first pass kept
       items (they stay, `reread_failed`, as before), not when a hard reading
       kept an item (even if the first pass was empty), not when a hard page's reads
       were both declined or refused as invalid (the page goes to its text
       re-read, as before: the picture is the likely cause), and not for a
       flagged page that is not a hard page.
     - *What.* The ordinary image re-read request (`imagePageMessage`,
       `hid-paper-reading-image-prompt-5`, the image answer schema, no zoom, no
       hard-page text), by `OCR_AI_REREAD_MODEL`, at effort `high`
       (`LAST_RESORT_EFFORT`), with `max_tokens` 16,000
       (`LAST_RESORT_MAX_TOKENS`; every other request keeps its own). The
       text-only request and the ordinary image re-read are byte for byte
       unchanged (the body-hash test, and a client test that the last resort
       differs from the ordinary image re-read in `max_tokens` only); no prompt
       text changed, so `PROMPT_VERSION` stays 11.
     - *Time.* A window of its own (coordinator decision of 2026-11-10,
       about 18:58 UTC): `OCR_AI_LAST_RESORT_SECONDS` (default 60; 30 to
       300, anything else fails startup) from when the last resort is
       decided, for (a) and (b) alike, never what is left of the hard page's
       deadline. Before, (a) had only the remainder, and when both hard reads
       were cut by the deadline (the usual way they fail together) almost
       nothing was left, so the page was failed with no answer; now it still
       gets one. The same machinery as a hard read: its own abort signal (the
       job's and its window's together), so the window's end stops a permit
       wait, a streamed request or a backoff sleep alike (`detail`
       `deadline`), and a shutdown still stops the reading. The per-request
       `OCR_AI_TIMEOUT_MS` still applies inside it.
       *Bounds.* 30 s is the least worth sending: at the ~100 output tokens
       per second measured in production it is about 3,000 tokens, a sparse
       page's answer with little thinking (a 12-item answer is about 3,000 to
       4,000); with less it would almost surely be cut, its thinking billed
       for nothing. 300 s is more than the 16,000-token cap
       (`LAST_RESORT_MAX_TOKENS`) needs at that rate (about 160 s) and keeps a
       hard page within about 150 s + 300 s. The default 60 s is about 6,000
       tokens, room for a sparse page's answer and some thinking. The cap only
       bounds what one attempt can cost (16,000 x $22 per million = $0.35)
       where `OCR_AI_MAX_TOKENS` would allow 64,000.
       *Worst case* per hard page, defaults: about 150 s
       (`OCR_AI_HARD_PAGE_DEADLINE_MS`, both reads) + 60 s (the last resort)
       = about 210 s, plus the first pass; up to about 450 s at the 300 s
       maximum. That is past the 3-minute target for a hard page (the
       deadline's 150 s default exists for it), accepted for this rare case by
       the coordinator's decision of 2026-11-10. It is inside the website's
       poll: the 3-minute poll noted above was raised to up to 20 minutes,
       with a "Check now" button after that (coordinator, 2026-11-10, in the
       website's own repository, health#191; not visible in this repository).
       With
       `OCR_AI_PAGE_CONCURRENCY` 2, two such pages run at once.
       *No "no time left" case.* Since the window starts fresh and is at
       least 30 s, the earlier skip (`last_resort_no_time`, `LAST_RESORT_MIN_MS`)
       could no longer happen and was removed. The worker has no job-level
       time budget it could exceed: the job's lease is renewed every third of
       `OCR_WORKER_LEASE_SECONDS` (default 300 s, so every 100 s) for as long
       as the job runs (`ocr.renew_worker_claim` takes up to an hour ahead per
       renewal), there is no overall job timeout, and a shutdown aborts the
       last resort through the job's signal at once.
     - *Its items.* The normal checks of an image re-read (`checkPage`: the
       placement rules, `read_from_image`, the fail-safe merge with the first
       pass, which here has no items), and every kept item also
       `check_carefully` with `last_resort_read` ("The other readings of this
       page did not work; this was read from the picture as a last try. Check
       every word against the paper.", below the item's own disagreements and
       `not_matched_to_scanned_text`, above the general picture sentence). The
       page counts in `imageRereadPages` and `rereadPages`, and provenance's
       `imagePromptVersion` names the image prompt.
     - *If it fails too* (no answer: cut off, off-schema, declined, the
       window's end, unavailable or rejected; or an answer of which no item
       holds to the page, `kept_nothing`): the page is clearly failed: in
       `imageRereadFailedPages` (payload and provenance), `rereadFailedPages`,
       flagged `ai_unsure` (and still `ai_declined` where both earlier readings
       were declined), any first-pass items `reread_failed`; and an
       `ocr.reading.page_read_failed` warn with `pass` `last_resort_read`,
       `reason` `last_resort_failed` and `detail` how it ended (`max_tokens`,
       `parse_error`, `schema_error`, `refusal`, `incomplete`, `deadline`,
       `api_error`, `api_rejected` with its `code`, or `kept_nothing`).
     - *Not sent*: a page with no picture that can go (a PDF or TIFF, no
       document bytes, too large, `OCR_AI_IMAGE_REREAD=off`, a masked number
       under `text_only`, ...) gives `reason` `last_resort_no_picture` with
       `detail` the `imageRereadSkipped` code saying why (a hard page always
       has its picture, so this is case (b) only).
     - *Contract*: the payload gains **no** field (`ocr-api` parses
       `reading` strictly, so a new field there would need ocr-api first);
       the failure shows through the existing optional
       `imageRereadFailedPages`, and the new item reason fits the existing
       `checkReasons` pattern. Provenance (stored as an unparsed object; the
       api-client reads it as `Record<string, unknown>`) gains
       `lastResortPages` (pages sent the last resort), `lastResortFailedPages`
       and `lastResortSkipped` (`{page, reason: no_picture, picture?}`; it
       had `no_time` too until the last resort got its own window): page
       numbers and codes only.
     - *Logs*: the last resort's use is its own `ocr.reading.usage` line
       (`pass: "last_resort_read"`); `ocr.job.completed` gains
       `lastResortReads`, `lastResortFailed` and `lastResortSkipped` (counts);
       `ocr.worker.ready` logs `aiLastResortSeconds`, the window in force.
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
never line text, items, SDK error messages or SDK error objects. The ids are
opaque UUIDs: `jobId`, `correlationId` and, on `ocr.job.claimed` and
`ocr.job.completed`, `documentId` (the document's UUID, so a job's lines can be
found from the document the owner names; never its storage key, bucket,
version, file name or patient). This rule allows a document id; the stricter
rule of `ocr-api`'s refusal log (`ProblemDetailsFilter`: never any identifier,
since it echoes request input) is about that log only.

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
model and pass (`pass`: `first_pass`, `reread`, `image_reread`,
`hard_page_read`, both reads of each hard page, or `last_resort_read`; requests and
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
