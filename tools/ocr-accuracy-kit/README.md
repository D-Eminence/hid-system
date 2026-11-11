# Paper reading launch check (OCR accuracy kit)

This kit checks, before launch, how well Health ID reads paper records (owner decision 33, item 10):

- **200 fictional documents** with answer keys,
- **at least 99% of medicines right after checking**, and
- **under 1% of items that are not on the paper** ("unsupported").

It runs the real reading pipeline from `services/ocr-worker` (Amazon Textract, then the Claude reading
step, grounding and checks) on the documents and compares what comes out with the answer keys.

> **Only fictional documents may ever be used with this kit.** Every name, date of birth, folder number,
> prescriber and facility in it is invented (surnames such as "Example" and "Testperson", facilities such as
> "Demo Hospital", folder numbers such as `DH-TEST-0042`), and every page says
> "FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT". Never scan, photograph, copy in or upload a real patient's
> record to run this check. The runner refuses any file whose fingerprint (sha256) is not in the kit's
> manifest, and refuses to start without `--i-confirm-fictional-documents`.

## What is in the kit

| File | What it is |
|---|---|
| `generate.py` | Makes the 200 fictional documents and their answer keys from a seed. |
| `keys/keys.jsonl` | The answer keys (committed): one line per document. |
| `keys/manifest.json` | The sha256 fingerprint of every generated file for seed 20261103 (committed). |
| `run.mjs` | Reads every document with the real pipeline and saves one result per document. |
| `score.mjs` | Compares the results with the answer keys and writes the report. |
| `fonts/` | The fonts used to draw the documents, with their licences. |
| `test/` | Automatic tests (they run offline). |

The generated documents (`generated/`) and results (`results/`) are never committed; they are made again
from the seed and proved identical with the manifest.

### The documents

Six kinds, in the styles of Nigerian clinics and hospitals: outpatient card, prescription, discharge summary,
lab report (MP, mRDT, Widal, PCV, FBC, E/U/Cr, FBS), referral letter and vital signs chart. 105 are single-page
PNG images and 95 are PDFs of 2 to 4 pages: 392 pages in all. They hold 559 medicines, 289 diagnoses, 134
allergy entries, 366 lab results, 1,753 vital signs and 401 notes.

- Medicines from the Nigerian Essential Medicines List with the usual signs: od, bd, tds, qds, nocte, stat,
  prn, x5/7, and also b.d., tid, 8hrly, 12hrly, daily.
- Diagnoses such as malaria, typhoid, HTN, T2DM, URTI, PUD, UTI, anaemia, pneumonia; allergies including
  NKDA and "Nil known"; vitals (BP, pulse, temperature, RR, SpO2, weight).
- Different difficulty: clean typed (born-digital PDFs and clean images), faint scans, skewed and noisy
  scans with specks and a dark scanner edge, handwriting (three handwriting fonts) and noisy handwriting.
- Traps: look-alike names in the same document (hydroxyzine / hydralazine, chlorpromazine / chlorpropamide,
  carbamazepine / carbimazole), look-alike strengths on the same page (5 mg next to 50 mg), and negations
  ("No evidence of malaria", "?Malaria", "Query typhoid", "FHx DM", "Past history of PUD", "(stopped)").

### The answer keys

Each line of `keys/keys.jsonl` is one document: its id (`D001`...), file name, number of pages, kind of
document, difficulty, traps, the patient details as written (name, date of birth or age, folder number, sex),
every line of text on every page (with its position), and every expected item with its kind, `asWritten`,
page, line and fields, in the same shape as the reading contract `hid-paper-reading-v2`:

- medicine: name, strength, form, route, frequency, duration, status (and the prescriber and date on a
  prescription),
- diagnosis: name, status (confirmed, suspected, ruled_out, history, family_history),
- allergy: substance, reaction, severity, noKnownAllergies,
- lab result: test, value, unit, referenceRange, flag,
- vital: measure, value, unit,
- note: text.

The keys are written by the generator from the same seed as the documents, so they always agree.

## Step by step

### 1. Install (once)

You need Python 3.11 or newer and Node.js 22 or newer.

```bash
cd tools/ocr-accuracy-kit
python3 -m pip install -r requirements.txt

cd ../../services/ocr-worker
npm ci
npm run build
cd ../../tools/ocr-accuracy-kit
```

### 2. Make the documents

```bash
python3 generate.py --seed 20261103 --count 200 --out generated --check-against keys
```

This takes about a minute and must end with
`OK: regenerated set is identical to the committed keys and manifest`. If it says `MISMATCH`, install the
exact versions in `requirements.txt` and try again; do not run the check on a set that does not match.

### 3. Try it offline first (no cost)

```bash
node run.mjs --i-confirm-fictional-documents --fake --docs generated/documents --out results/fake
node score.mjs --results results/fake
```

`--fake` uses stand-ins for Textract and Claude built from the answer keys, so it must score 100% on both
measures. It prints `NOT A LAUNCH RESULT (fake mode; thresholds met ...)` and exits with code 3, never 0: it
proves the kit and the pipeline are wired up and says nothing about real accuracy.

### 4. Run it for real, in Demo Hospital's test setup

Use the test AWS account and a test Anthropic API key, never production ones. You need:

- AWS credentials for the test account (the normal AWS credentials chain: environment, profile or role)
  with `textract:DetectDocumentText`, `textract:StartDocumentTextDetection`,
  `textract:GetDocumentTextDetection`, and `s3:PutObject` / `s3:GetObjectVersion` / `s3:DeleteObjectVersion`
  on the test bucket (each uploaded PDF version is deleted again as soon as Textract has read it, also when
  reading fails or the run is stopped; a version that could not be deleted shows as `s3-cleanup=failed:...`
  on the document's line and in its `.run.json`);
- an S3 test bucket **with versioning on** (the PDFs are read by Textract from S3 by exact version, as the
  worker does; PNGs are sent as bytes);
- a test Anthropic API key, injected at run time and never written to a file in the repository.

See the cost first:

```bash
node run.mjs --estimate-only
```

Then run (the same environment variables the worker uses):

```bash
export AWS_REGION=eu-west-1
export OCR_AI_MODE=claude
export OCR_AI_US_PROCESSING_APPROVED=true   # the worker reads only with US processing (inference_geo "us")
export OCR_TEXTRACT_FEATURES=text          # or layout (better reading order, costs more)
export ANTHROPIC_API_KEY=...               # test key, from the secret store
node run.mjs --i-confirm-fictional-documents --docs generated/documents --out results/real-1 \
  --s3-bucket <versioned-test-bucket> --concurrency 2
```

The runner prints the cost estimate before it starts, then one line per document with only its id, pages,
status, item counts and token usage (never any text from the document). Each document's result is saved as
`results/real-1/D001.json` (the contract payload) and `D001.run.json` (pages, tokens, models, timing).

If it stops (network, Ctrl-C, a failure), run the same command again: finished documents are skipped and only
the rest are read. A document that failed is retried (it is uploaded and read by Textract again, which is
paid for again). A finished result is only reused by a run with the same mode (fake or real), models, text
reading features and facility; if the output directory holds results from any other run, the runner refuses
and asks for a new `--out` directory, so fake or differently made results are never mixed into a real run. `--limit 10` or `--only D001,D007` runs a few
documents first; `--facility-id` sets the facility used for the AI switch (default: the first id in
`OCR_AI_FACILITY_IDS`, otherwise a fixed test id).

### 5. Score it

```bash
node score.mjs --results results/real-1
```

This writes `results/real-1/score-summary.md` (plain English: read this one) and
`results/real-1/score-report.json` (every number), prints `PASS` or `FAIL`, and exits with code 0 on pass
and 1 on fail. Documents without a result count as missed, so a launch decision always needs all 200; use
`--partial` only to look at a few documents. Only a full, real run can `PASS`: a `--partial` run or a fake
run whose numbers meet both thresholds prints `NOT A LAUNCH RESULT` and exits with code 3 (the report has
`pass: false`, `thresholdsMet: true`). A results directory that mixes fake and real records is refused
(code 2).

## What pass means

**PASS** means both of these are true on the 200 fictional documents:

1. **Medicines right after checking is at least 99%.**
2. **Unsupported items are under 1%.**

The summary also lists up to 20 documents with the most serious problems (by number only) so they can be
looked at: open `generated/documents/<file>` and the document's line in `keys/keys.jsonl`.

A pass does not replace the check screen: every item still goes to a person before it enters a record. It
says the reading is good enough that the person checking is very unlikely to be shown a wrong medicine
without a warning, and that the reading almost never adds anything that is not on the paper.

## How the score is worked out

### Matching a medicine

For each medicine in the answer key, the scorer looks for one the pipeline produced **on the same page**:

1. **Exact:** the same name, strength and frequency after normalisation (below). Exact pairs are made first,
   one to one. The pair only counts as exact when the status also says the same thing: taking it (`new`
   or `current`), not taking it (`stopped` or `past`), or `unknown`. A stopped medicine read as current is
   therefore not exact; it is caught only if it is marked `check_carefully`, otherwise it is missed.
2. Otherwise it pairs the key medicine with a remaining produced medicine on the same page whose name is
   at least 80% alike (1 minus the edit distance divided by the longer name), or, for a misread name, one
   read from the same place on the page (its box covers at least half of the key line's box). A produced
   medicine whose name matches another key medicine on the page (for example a duplicate of it) is never
   paired by place with a medicine that was skipped. Pairs are made best first, one to one.

### Normalisation

- Case and spaces are ignored; a leading form or route word is dropped from a name (`Tab Amlodipine` =
  `Amlodipine`); hyphens and slashes in a name count as spaces (`Artemether-Lumefantrine` =
  `Artemether/Lumefantrine`).
- A strength ignores the space between number and unit (`5mg` = `5 mg`) and unit spellings (`mcg` = `ug` =
  `µg`, `mg` = `mgs`, `g` = `gm`, `ml` = `mls`, `tab` = `tabs`). Units are not converted (`1g` is not
  `1000mg`), and `5mg` is never `50mg`. A leading decimal point is kept: `.5 mg` is `0.5 mg`, never `5 mg`.
- A frequency is mapped to one code; dots and spaces inside an abbreviation are ignored (`b.d.` = `bd`):

| Code | Counts as the same |
|---|---|
| od | od, qd, daily, once daily, once a day, 1 daily, 24hrly, 24 hourly, q24h, every day |
| bd | bd, bid, twice daily, twice a day, 12hrly, 12 hourly, 12h, q12h, every 12 hours |
| tds | tds, tid, three times daily, three times a day, thrice daily, 8hrly, 8 hourly, 8h, q8h, every 8 hours |
| qds | qds, qid, four times daily, four times a day, 6hrly, 6 hourly, 6h, q6h, every 6 hours |
| nocte | nocte, on, at night, at bedtime, every night, hs, nightly |
| mane | mane, om, in the morning, every morning |
| stat | stat, immediately, at once, now, single dose, once only |
| prn | prn, as needed, as required, when required, when needed, sos, if needed |

(The table is `FREQUENCY_TABLE` in `lib/normalise.mjs`.)

### (a) Medicines right after checking

> The share of medicines in the answer keys for which the pipeline produced **either** an exact match
> (name + strength + frequency, normalised, with the same status) **or** a paired medicine marked
> `check_carefully`, so that the person checking is warned and would catch the mistake.

A medicine counts as **missed** when nothing was paired with it, or the paired medicine is wrong and marked
`clear`. A page flag alone (for example `possible_missed_item`) does not count. A document with no result
counts every one of its medicines as missed.

**Strict** variant (reported, not a launch threshold): the share read exactly, with no credit for a warning.

Also reported: medicines with the right name, strength and frequency but another status (for example
"stopped" read as current; these are not counted as exact), and the score on each trap.

### (b) Unsupported items

> The share of **all items the pipeline produced** (every kind) that state something that is not on the
> paper, judged against the answer key's own text of that page.

An item is checked on its `asWritten`, its text fields (medicine name, strength, form, route, frequency,
duration; diagnosis name; allergy substance and reaction; lab test, value, unit, range and flag; vital value
and unit; note text), its date and its prescriber. A value is **on the paper** when all its words and numbers
are found, in order, within three consecutive lines of that page. Numbers must match exactly; words may
differ by one letter (two for words of 8 letters or more), so a small reading slip such as `Amlodipme` is
not counted, while `Hydralazine` for a written `Hydroxyzine`, or `50` for a written `5`, is. A frequency
also counts as on the paper when another spelling of the same code is (`daily` for a written `od`); a spelling
that is also an everyday word (`on`, `now`) only counts on the same line as the medicine's name, after it,
so an invented `nocte` is not supported by "seen on 3 Nov". Choices
such as status, vital measure and allergy severity are not text and are not checked here.

The report also gives the same count against the text-reading step's own lines, which separates "the AI
added something" from "the scan was misread".

### Other numbers in the report

For each kind of item: how many the key has, how many were read, **found** (recall: share of the key that
was paired), **correct** (share of the pairs with every field right), and **extra** (1 minus precision: share
of what was read that matched nothing in the key). Diagnoses, lab tests and notes are paired on name or
words (notes: at least half the words in common); vitals on measure and value. Patient details (name, date of
birth or age, folder number, sex) are compared as written. Results are also broken down by difficulty and
by kind of document.

## Cost of a real run (200 documents, 392 pages)

Planning prices: Textract `DetectDocumentText` about $1.50 per 1,000 pages (`layout` about $4 per 1,000);
Claude Opus 5.5 $4 / $20 per million input / output tokens. Cached prompt reads cost a tenth of input. The kit
runs the worker with its own defaults: Opus 5.5 at high effort for the first pass (owner decision of
2026-11-05), and two reads of the picture for every hard page (handwriting or low confidence).

| Part | Estimate |
|---|---|
| Textract, 392 pages (`text`) | about $0.59 (`layout`: about $1.57) |
| First pass, 392 pages, Opus 5.5 | about $33 |
| Hard pages, two reads each, Opus 5.5 (about 35% of pages) | about $49 |
| **Expected total** | **about $82** |
| If every page were a hard page | about $172 |
| Hard ceiling (every page a hard page, each read using its full 32,000-token output cap) | about $549 |

Assumptions per page: about 2,000 cached prompt tokens and 900 page tokens in, about 4,000 tokens out on the
first pass (thinking and the answer); on a hard page two reads, each about 4,000 page and picture tokens in and
8,000 out (`lib/cost.mjs`). The first live hard page (2026-11-10) cost about $0.45 for its two reads, a little
above this estimate's $0.35, so allow for the upper end. `node run.mjs --estimate-only` prints the estimate,
and every real run prints it again before starting and the measured cost (from the recorded token usage) at
the end, in `run-summary.json`. Check the current AWS and Anthropic price pages before a large run.

## Tests

```bash
npm test    # in tools/ocr-accuracy-kit, after building services/ocr-worker
```

The Node tests (`node --test`) check the scorer on small hand-made cases, that the committed keys and
manifest agree and are fictional, and run the whole kit end to end offline: generate 10 documents, prove they
match the committed manifest byte for byte, read them with the real worker code in `--fake` mode and score
100%. They also check that the runner refuses to start without the confirmation flag, refuses a file that is
not the kit's, resumes, and never prints document text. The Python test (`unittest`) checks that the same
seed gives byte-identical files and that they match the committed keys and manifest.

## Fonts and licences

All fonts are bundled in `fonts/` and are under the SIL Open Font License 1.1 (licence text next to each
font, `OFL-*.txt`). They were taken from the Google Fonts repository (`github.com/google/fonts`, `ofl/`).

| Font | File | Licence | sha256 |
|---|---|---|---|
| PT Sans | `PT_Sans-Web-Regular.ttf` | OFL 1.1 (`OFL-ptsans.txt`) | `9cc831490532009bae2b3ce0d39c62adfc889060beb421593bfd9d2396d0f10a` |
| PT Sans Bold | `PT_Sans-Web-Bold.ttf` | OFL 1.1 (`OFL-ptsans.txt`) | `3128bd5ecf01816e59a23d54c57a7a6b14615b07db53ff277c77376010265b05` |
| Courier Prime | `CourierPrime-Regular.ttf` | OFL 1.1 (`OFL-courierprime.txt`) | `72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af` |
| Courier Prime Bold | `CourierPrime-Bold.ttf` | OFL 1.1 (`OFL-courierprime.txt`) | `ff1f38786c849d1c41fa8e447960abdb2bd75fdfb0cfcdeb524fad65a5af3638` |
| Patrick Hand (handwriting) | `PatrickHand-Regular.ttf` | OFL 1.1 (`OFL-patrickhand.txt`) | `0f173b3e6cb6d1af25babf7f0057c5ac4ee11f9992b0469bb817e967ef4ad0fc` |
| Kalam (handwriting) | `Kalam-Regular.ttf` | OFL 1.1 (`OFL-kalam.txt`) | `57cecb63d4608019371954274ae1d8c397764debd5b19d4a33c1efa4dc923c0b` |
| Indie Flower (handwriting) | `IndieFlower-Regular.ttf` | OFL 1.1 (`OFL-indieflower.txt`) | `ccc94b22b156e9c5dfe50fd051f01b097600b252c24473e624bb43a143140a94` |

## Notes for engineers

- `run.mjs` imports the built worker (`services/ocr-worker/dist`): `readOcrWorkerConfig` on the process
  environment (with placeholder database settings, which it never uses, and `NODE_ENV=development`),
  `TextractOcrProvider`, `S3ExactDocumentReader` (PDFs are uploaded, then read back by exact version, size
  and sha256), `ClaudePageClient` and `PaperReadingService`, and validates every payload with
  `paperReadingPayloadSchema`. It does not touch the database, the page allowance or the job queue.
- `--fake` patches the provider's Textract client with `lib/fake.mjs` (LINE and WORD blocks from the key,
  paged with `NextToken`) and replaces the Claude page client with one that answers from the key; everything
  in between is the real worker code.
- Determinism: each document depends only on the seed and its number (so the first 10 of the 200 are the
  same as a set of 10). PNGs are written by Pillow, scanned PDFs by Pillow's PDF writer with fixed dates,
  born-digital PDFs by reportlab with `invariant=1` and no page compression. Byte identity holds with the
  pinned library versions.
