# Labelling your own pages for the launch check

Use this to label pages you make yourself (for example 20 fictional prescriptions, lab results and clinic notes),
so the kit can read them with the real pipeline and score them, exactly as it does its own 200 documents.

> **Fictional pages only.** Every name, date of birth, folder number, prescriber and facility must be invented.
> Never photograph, scan or copy a real patient's record. Write "FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT"
> on every page.

## 1. Put the pages in a folder

One file per document: PNG or JPEG (one page, a photo or scan) or PDF (one or more pages). Use simple file
names, for example `L001-prescription.jpg`, `L002-lab_result.pdf`.

```
my-set/
  documents/   L001-prescription.jpg, L002-lab_result.pdf, ...
  keys/        keys.jsonl   (your labels, below)
```

## 2. Write one line of labels per document in `keys/keys.jsonl`

Each document is **one line** of JSON (shown spread out below to read it; in the file it must be on one line).
For each page you copy **every line of writing, in reading order** into `text` (one entry per page, with its
`"page"` number), the lines numbered from 1. Each item then
says which page and which of those lines it was read from. You write each item the way the reader's output
writes it: the same kinds and the same fields.

### Worked example: a one-page handwritten prescription

The page (fictional) says:

```
1  DEMO HOSPITAL - OUTPATIENT
2  Name: Ada Example   Age: 34yrs   Sex: F   Folder No: DH-TEST-0042
3  Dx: ?Malaria
4  Hx: HTN
5  Allergy: Penicillin - rash
6  BP 132/84   T 38.2C
7  Tab Artemether/Lumefantrine 80/480mg bd x3/7
8  Tab Paracetamol 1g tds x3/7
9  Amlodipine 5mg od (stopped)
10 MP: +ve (++)
11 Review in 3 days
12 Dr T. Testperson  10/11/2026
13 FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT
```

Its line in `keys.jsonl` (spread out here):

```json
{
  "docId": "L001",
  "file": "L001-prescription.jpg",
  "mediaType": "image/jpeg",
  "pages": 1,
  "documentKind": "prescription",
  "difficulty": "handwritten",
  "traps": ["negation"],
  "fictional": true,
  "identity": { "page": 1, "lines": [2], "nameAsWritten": "Ada Example", "dateOfBirthAsWritten": "34yrs",
                "folderNumberAsWritten": "DH-TEST-0042", "sexAsWritten": "F" },
  "text": [ { "page": 1, "lines": [
    { "n": 1, "text": "DEMO HOSPITAL - OUTPATIENT", "handwritten": false },
    { "n": 2, "text": "Name: Ada Example   Age: 34yrs   Sex: F   Folder No: DH-TEST-0042", "handwritten": true },
    { "n": 3, "text": "Dx: ?Malaria", "handwritten": true },
    { "n": 4, "text": "Hx: HTN", "handwritten": true },
    { "n": 5, "text": "Allergy: Penicillin - rash", "handwritten": true },
    { "n": 6, "text": "BP 132/84   T 38.2C", "handwritten": true },
    { "n": 7, "text": "Tab Artemether/Lumefantrine 80/480mg bd x3/7", "handwritten": true },
    { "n": 8, "text": "Tab Paracetamol 1g tds x3/7", "handwritten": true },
    { "n": 9, "text": "Amlodipine 5mg od (stopped)", "handwritten": true },
    { "n": 10, "text": "MP: +ve (++)", "handwritten": true },
    { "n": 11, "text": "Review in 3 days", "handwritten": true },
    { "n": 12, "text": "Dr T. Testperson  10/11/2026", "handwritten": true },
    { "n": 13, "text": "FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT", "handwritten": false }
  ] } ],
  "items": [
    { "id": "L001-i01", "kind": "diagnosis", "page": 1, "lines": [3], "asWritten": "?Malaria",
      "fields": { "name": "Malaria", "status": "suspected" }, "dateAsWritten": "10/11/2026", "trap": "negation" },
    { "id": "L001-i02", "kind": "diagnosis", "page": 1, "lines": [4], "asWritten": "Hx: HTN",
      "fields": { "name": "HTN", "status": "history" }, "dateAsWritten": "10/11/2026", "trap": "negation" },
    { "id": "L001-i03", "kind": "allergy", "page": 1, "lines": [5], "asWritten": "Allergy: Penicillin - rash",
      "fields": { "substance": "Penicillin", "reaction": "rash", "severity": null, "noKnownAllergies": false },
      "dateAsWritten": "10/11/2026", "trap": null },
    { "id": "L001-i04", "kind": "vital", "page": 1, "lines": [6], "asWritten": "BP 132/84",
      "fields": { "measure": "blood_pressure", "value": "132/84", "unit": null }, "dateAsWritten": "10/11/2026",
      "trap": null },
    { "id": "L001-i05", "kind": "vital", "page": 1, "lines": [6], "asWritten": "T 38.2C",
      "fields": { "measure": "temperature", "value": "38.2", "unit": "C" }, "dateAsWritten": "10/11/2026",
      "trap": null },
    { "id": "L001-i06", "kind": "medicine", "page": 1, "lines": [7], "asWritten": "Tab Artemether/Lumefantrine 80/480mg bd x3/7",
      "fields": { "name": "Artemether/Lumefantrine", "strength": "80/480mg", "form": "Tab", "route": null,
                  "frequency": "bd", "duration": "x3/7", "status": "new" },
      "prescription": { "prescriberAsWritten": "Dr T. Testperson", "dateAsWritten": "10/11/2026" },
      "dateAsWritten": "10/11/2026", "trap": null },
    { "id": "L001-i07", "kind": "medicine", "page": 1, "lines": [8], "asWritten": "Tab Paracetamol 1g tds x3/7",
      "fields": { "name": "Paracetamol", "strength": "1g", "form": "Tab", "route": null,
                  "frequency": "tds", "duration": "x3/7", "status": "new" },
      "prescription": { "prescriberAsWritten": "Dr T. Testperson", "dateAsWritten": "10/11/2026" },
      "dateAsWritten": "10/11/2026", "trap": null },
    { "id": "L001-i08", "kind": "medicine", "page": 1, "lines": [9], "asWritten": "Amlodipine 5mg od (stopped)",
      "fields": { "name": "Amlodipine", "strength": "5mg", "form": null, "route": null,
                  "frequency": "od", "duration": null, "status": "stopped" },
      "prescription": null, "dateAsWritten": "10/11/2026", "trap": "negation" },
    { "id": "L001-i09", "kind": "lab_result", "page": 1, "lines": [10], "asWritten": "MP: +ve (++)",
      "fields": { "test": "MP", "value": "+ve (++)", "unit": null, "referenceRange": null, "flag": null },
      "dateAsWritten": "10/11/2026", "trap": null },
    { "id": "L001-i10", "kind": "note", "page": 1, "lines": [11], "asWritten": "Review in 3 days",
      "fields": { "text": "Review in 3 days" }, "dateAsWritten": "10/11/2026", "trap": null }
  ]
}
```

### The rules

- **Every field of the kind is present.** Write `null` when the paper does not say it (never leave it out, never
  guess). Write values **as on the paper** ("bd", "x3/7", "80/480mg"), not expanded.
- **Kinds and their fields:**

  | kind | fields |
  | --- | --- |
  | `medicine` | `name`, `strength`, `form`, `route`, `frequency`, `duration`, `status` |
  | `diagnosis` | `name`, `status` |
  | `allergy` | `substance`, `reaction`, `severity` (`mild`, `moderate`, `severe`, `unknown` or null), `noKnownAllergies` (true for "NKDA" / "Nil known", else false) |
  | `lab_result` | `test`, `value`, `unit`, `referenceRange`, `flag` (`"H"`, `"L"` or null) |
  | `vital` | `measure`, `value`, `unit` |
  | `note` | `text` |

- **Fixed values:**
  - medicine `status`: `new` (started on this page), `current` (continuing), `stopped` (stopped, "D/C", crossed
    out), `past` (history, or "Treatment given" during an admission), `unknown` (the page does not say);
  - allergy `severity`: lower case, from the words on the paper ("severe rash" is `severe`), else null;
  - diagnosis `status`: `confirmed`, `suspected` ("?", "query", "r/o", and "Working diagnosis" or
    "provisional", which the reader's statuses have no separate value for), `ruled_out` ("no evidence of"),
    `history` ("Hx", "past history"), `family_history` ("FHx");
  - vital `measure`: `blood_pressure`, `pulse`, `temperature`, `respiratory_rate`, `oxygen_saturation`, `weight`,
    `height`, `blood_glucose`.
- **One item per thing**: two medicines on one line are two items; a BP and a temperature on one line are two
  vitals. Headings ("Plan", "Treatment sheet"), the letterhead and the footer are not items.
- **Document details are not items**: the patient's name, folder number, date of birth or age and sex (they are
  the `identity`), the requester ("Requested by"), signatures and the prescriber's or doctor's name, "Charted by"
  and "Lab scientist" lines.
- **Discharge summaries**: medicines under "Treatment given" were given during the admission, so they are `past`,
  never `new` or `current`; "Medications on discharge" are `new` (`current` only where the page says to continue).
- `lines` are the numbers of the lines in `text` the item was read from (on its `page`); `identity` is the
  patient's details as written (`null` if the page has none); `prescription` (prescriber and date) is optional on
  a medicine.
- `documentKind` and `difficulty` are your own words (for example `prescription`, `lab_result`, `clinic_note`;
  `typed`, `handwritten`, `faint_photo`); the report breaks results down by them.
- **Handwriting**: give each line in `text` `"handwritten": true` or `false` (true for handwritten lines, false
  for a printed letterhead, headings and footer), as the kit's keys do. The offline test mode (`--fake`) uses
  the flag; where no line of a document carries `"handwritten": true`, it treats every line as handwriting if
  `difficulty` starts with `handwritten`, and none otherwise. The real run never reads the flag.
- **Dates**: each item's `dateAsWritten` is the date the page gives for it, copied exactly from that page
  (`check` refuses one that is not on the item's page), or `null` where its page gives none; it is optional
  and null when left out. Use the visit or prescription date for everything recorded under it; in a discharge
  summary the admitted date for what was found on admission, the discharged date for the final diagnosis,
  discharge medicines and follow-up, and null for treatment given and investigations; null on a continuation page with no date. The
  score reports dates on their own (a day/month swap is listed), outside the two launch measures.
- **Traps**: each item may have `"trap"`: `null`, or one of `lookalike:<a>/<b>` (a look-alike name on the
  same page), `strength:<a>/<b>` (a look-alike strength on the same page), `negation` (required on every
  diagnosis that is not `confirmed` and every `stopped` medicine; never on a `past` one), `allergy_conflict:<allergy>/<medicine>`
  (the allergy and each active medicine it should warn about) or `future_date` (an item dated after the day
  the page was made). The document's `"traps"` is the sorted list of its items' trap types (the part before
  `:`), for example `["lookalike", "negation"]`, and `[]` when none. An item holds one trap; when two apply,
  the safety one wins: `allergy_conflict` over `strength` (as the kit's D026 Diclofenac). `check` refuses any other value and a list
  that differs from the items'.
- Lines need no position. Without one, a medicine read wrongly but marked "check carefully" is paired only by its
  name, not by where it sits on the page, so a hand-labelled set can score slightly lower than the kit's own set.
- `docId` and every item `id` must be unique; `fictional` must be `true`.

### Rules for common cases

These follow what `generate.py` writes in the kit's own keys, so hand labels and the kit set agree. Where the
generator has no example, the rule is the one that suits how `score.mjs` compares (said below). `check` tests the
ones marked *(checked)*.

1. **Handwriting**: the per-line `"handwritten"` flag, above. *(checked: true or false)*
2. **Traps**: item `trap` and document `traps`, above. *(checked)*
3. **What `asWritten` keeps**: the run of text that is this item, keeping the words that give its status or
   meaning ("?", "Query", "Hx", "PMH", "FHx", "Past history of", "No evidence of", "Working diagnosis:",
   "(stopped)", a vital's label "BP", a lab row's test name, "Allergy:"), and dropping a label that only names
   the section ("Dx:", "Diagnosis:", "Final diagnosis:", "C/O", "Plan:", "Clinical details:", "Comment:",
   "Nurse note:", a list number "1."). So "Dx: ?Malaria" is `?Malaria`, "Hx: HTN" is `Hx: HTN`. The fields
   never hold a status cue: `name` is `Malaria`, `HTN`. *(checked: asWritten is on the cited lines; a name
   that starts with a status cue is refused)*
4. **Qualifiers on a diagnosis** ("T2DM (poorly controlled)", "FHx: Hypertension (father)"): `name` is the
   condition only (`T2DM`, `Hypertension`); the qualifier stays in `asWritten`; the relative is said by the
   status `family_history`. No generator example; the scorer pairs diagnoses on the name and a qualifier in the
   name would make it "not all details right". *(checked: no brackets in a name)*
5. **Requests and imaging**: a test asked for with no result ("Urine m/c/s", "Repeat FBC in 1/52") is a `note`,
   as the generator's "GOPD in 1/52 with FBC"; never a `lab_result` with a null value. An imaging finding
   ("CXR: bilateral infiltrates") is a `note` too: no generator example, and its free text does not fit value,
   unit and range, while notes are paired on their words. *(checked: a lab_result needs a value)*
6. **A combined frequency** ("tds prn"): `frequency` is all of it as written, `tds prn`. No generator example;
   the scorer compares the whole frequency, so splitting it would never match. *(checked: on the lines)*
7. **Medicine status**: `new` when this page starts or prescribes it (prescriptions, "Rx", "Medications on
   discharge"); `current` when it says the patient is on it ("Currently on", "continue", a chart's "given");
   `stopped` for "(stopped)", "D/C" or crossed out; `past` for history and for "Treatment given" in a discharge
   summary.
8. **Identity on continuation pages**: `identity` once, from the first page that gives it; the repeated name and
   folder number on later pages are neither identity nor items (the generator writes them and keys none).
9. **Lab test names**: `test` is the test's name on its own row, without the panel heading or a panel prefix
   ("WBC" under "FULL BLOOD COUNT", not "FBC: WBC"); a method in brackets on the row may stay ("MP (thick
   film)"), and the scorer treats "MP (thick film)" and "MP" as the same test. A table row is one `lab_result`
   citing that row, its `asWritten` the whole row (as generate.py does); the header row is not an item.
   *(checked: no "Panel:" prefix)*
10. **Vital units**: as written (`b/min`, `/min`, `c/min`, `mmHg`, `%`, `C`); `null` when no unit is written
    (a BP with no "mmHg" has unit null). "on air" after SpO2 is not part of the unit (`%`); it may stay in
    `asWritten`. *(checked: a unit must be on the item's lines)*
11. **`prescription` on a stopped medicine**: no. `prescription` is only on a medicine prescribed on a
    prescription page with its prescriber or date (the generator sets it only there, on `new` medicines); a
    `stopped` or `past` medicine has `prescription: null`. *(checked)*

Every text field (medicine name, strength, form, route, frequency, duration; diagnosis name; allergy substance
and reaction; lab test, value, unit, range, flag; vital value and unit; note text) must be written on the item's
own lines *(checked: `VALUE_NOT_ON_LINES`)*.

## 3. Check and seal

```bash
cd tools/ocr-accuracy-kit
node label.mjs check --keys my-set/keys --docs my-set/documents
node label.mjs seal  --keys my-set/keys --docs my-set/documents --name lekan-first-pass
```

`check` lists every problem by document id, code and line (never the text) and changes nothing. `seal` checks
again and writes `keys/manifest.json`: the sha256 of each file and of `keys.jsonl`. The runner reads only files
whose sha256 is in it, so if you change a label or a file, **seal again**.

## 4. Run and score

Exactly as in README.md steps 3 to 5, with `--keys` and `--docs` pointing at your set:

```bash
node run.mjs --i-confirm-fictional-documents --fake --keys my-set/keys --docs my-set/documents --out results/my-set-fake
node run.mjs --i-confirm-fictional-documents        --keys my-set/keys --docs my-set/documents --out results/my-set-1 \
  --s3-bucket <versioned-test-bucket> --concurrency 2
node score.mjs --results results/my-set-1 --keys my-set/keys
```

The score uses your `text` for "unsupported items" (a value read that is not in your transcript of the page) and
your items for "medicines right after checking". A set of 20 pages gives a first reading of accuracy; the launch
pass itself is the kit's full 200-document run.
