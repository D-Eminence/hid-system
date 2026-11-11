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
For each page you copy **every line of writing, in reading order** into `text`, numbered from 1. Each item then
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
  "difficulty": "handwriting",
  "fictional": true,
  "identity": { "page": 1, "lines": [2], "nameAsWritten": "Ada Example", "dateOfBirthAsWritten": "34yrs",
                "folderNumberAsWritten": "DH-TEST-0042", "sexAsWritten": "F" },
  "text": [ { "lines": [
    { "n": 1, "text": "DEMO HOSPITAL - OUTPATIENT" },
    { "n": 2, "text": "Name: Ada Example   Age: 34yrs   Sex: F   Folder No: DH-TEST-0042" },
    { "n": 3, "text": "Dx: ?Malaria" },
    { "n": 4, "text": "Hx: HTN" },
    { "n": 5, "text": "Allergy: Penicillin - rash" },
    { "n": 6, "text": "BP 132/84   T 38.2C" },
    { "n": 7, "text": "Tab Artemether/Lumefantrine 80/480mg bd x3/7" },
    { "n": 8, "text": "Tab Paracetamol 1g tds x3/7" },
    { "n": 9, "text": "Amlodipine 5mg od (stopped)" },
    { "n": 10, "text": "MP: +ve (++)" },
    { "n": 11, "text": "Review in 3 days" },
    { "n": 12, "text": "Dr T. Testperson  10/11/2026" },
    { "n": 13, "text": "FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT" }
  ] } ],
  "items": [
    { "id": "L001-i01", "kind": "diagnosis", "page": 1, "lines": [3], "asWritten": "?Malaria",
      "fields": { "name": "Malaria", "status": "suspected" } },
    { "id": "L001-i02", "kind": "diagnosis", "page": 1, "lines": [4], "asWritten": "Hx: HTN",
      "fields": { "name": "HTN", "status": "history" } },
    { "id": "L001-i03", "kind": "allergy", "page": 1, "lines": [5], "asWritten": "Allergy: Penicillin - rash",
      "fields": { "substance": "Penicillin", "reaction": "rash", "severity": null, "noKnownAllergies": false } },
    { "id": "L001-i04", "kind": "vital", "page": 1, "lines": [6], "asWritten": "BP 132/84",
      "fields": { "measure": "blood_pressure", "value": "132/84", "unit": null } },
    { "id": "L001-i05", "kind": "vital", "page": 1, "lines": [6], "asWritten": "T 38.2C",
      "fields": { "measure": "temperature", "value": "38.2", "unit": "C" } },
    { "id": "L001-i06", "kind": "medicine", "page": 1, "lines": [7], "asWritten": "Tab Artemether/Lumefantrine 80/480mg bd x3/7",
      "fields": { "name": "Artemether/Lumefantrine", "strength": "80/480mg", "form": "Tab", "route": null,
                  "frequency": "bd", "duration": "x3/7", "status": "new" },
      "prescription": { "prescriberAsWritten": "Dr T. Testperson", "dateAsWritten": "10/11/2026" } },
    { "id": "L001-i07", "kind": "medicine", "page": 1, "lines": [8], "asWritten": "Tab Paracetamol 1g tds x3/7",
      "fields": { "name": "Paracetamol", "strength": "1g", "form": "Tab", "route": null,
                  "frequency": "tds", "duration": "x3/7", "status": "new" },
      "prescription": { "prescriberAsWritten": "Dr T. Testperson", "dateAsWritten": "10/11/2026" } },
    { "id": "L001-i08", "kind": "medicine", "page": 1, "lines": [9], "asWritten": "Amlodipine 5mg od (stopped)",
      "fields": { "name": "Amlodipine", "strength": "5mg", "form": null, "route": null,
                  "frequency": "od", "duration": null, "status": "stopped" } },
    { "id": "L001-i09", "kind": "lab_result", "page": 1, "lines": [10], "asWritten": "MP: +ve (++)",
      "fields": { "test": "MP", "value": "+ve (++)", "unit": null, "referenceRange": null, "flag": null } },
    { "id": "L001-i10", "kind": "note", "page": 1, "lines": [11], "asWritten": "Review in 3 days",
      "fields": { "text": "Review in 3 days" } }
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
  | `allergy` | `substance`, `reaction`, `severity`, `noKnownAllergies` (true for "NKDA" / "Nil known", else false) |
  | `lab_result` | `test`, `value`, `unit`, `referenceRange`, `flag` (`"H"`, `"L"` or null) |
  | `vital` | `measure`, `value`, `unit` |
  | `note` | `text` |

- **Fixed values:**
  - medicine `status`: `new` (started on this page), `current` (continuing), `stopped` (stopped, "D/C", crossed
    out), `past` (history only);
  - diagnosis `status`: `confirmed`, `suspected` ("?", "query", "r/o"), `ruled_out` ("no evidence of"),
    `history` ("Hx", "past history"), `family_history` ("FHx");
  - vital `measure`: `blood_pressure`, `pulse`, `temperature`, `respiratory_rate`, `oxygen_saturation`, `weight`,
    `height`.
- **One item per thing**: two medicines on one line are two items; a BP and a temperature on one line are two
  vitals. Headings ("Plan", "Treatment sheet"), the letterhead and the footer are not items.
- `lines` are the numbers of the lines in `text` the item was read from (on its `page`); `identity` is the
  patient's details as written (`null` if the page has none); `prescription` (prescriber and date) is optional on
  a medicine.
- `documentKind` and `difficulty` are your own words (for example `prescription`, `lab_result`, `clinic_note`;
  `typed`, `handwriting`, `faint_photo`); the report breaks results down by them.
- `docId` and every item `id` must be unique; `fictional` must be `true`.

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
