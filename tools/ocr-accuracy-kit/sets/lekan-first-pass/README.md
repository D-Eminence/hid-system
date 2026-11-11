# lekan-first-pass: 20 hand-labelled fictional pages

A first hand-labelled set for the launch check (see `../../LABELLING.md`): 20 documents, 27 pages, 275 labelled
items, in the kit's own key format, sealed with `label.mjs`.

**Every page is fictional.** Names are invented (surnames such as Example, Testperson, Demo), facilities are
"Demo Hospital", "Demo Clinic" and "Demo Laboratory", folder numbers are `DH-TEST-xxxx`, and every page carries
"FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT". No real patient record was used, photographed or copied.

## What is in it

| Kind | Documents |
| --- | --- |
| Prescriptions and outpatient cards | L001, L004-L009 |
| Lab reports (MP, mRDT, Widal, PCV, FBC, E/U/Cr, FBS and others) | L002, L010-L014 |
| Discharge summaries (multi-page PDF) | L003, L015 (2 pages), L016 (3 pages), L017 (2 pages) |
| Referral letters | L018, L019 (2 pages) |
| Vital signs chart | L020 |

Difficulty (`difficulty` in the key): handwritten (L001, L004, L005, L008, L013, L017, L020, in the kit's Kalam,
Indie Flower and Patrick Hand fonts, some skewed, noisy or faint), clean typed (L002, L003, L006, L010, L012,
L015, L018), faint or skewed/noisy scans (L007, L009, L011, L014, L016, L019). Files are PNG, JPEG and PDF (7
PDFs: born-digital typed ones and scanned ones), each under 300 KB.

Traps, marked as in the kit's keys (item `trap`, document `traps`): look-alike names (chlorpromazine /
chlorpropamide, carbamazepine / carbimazole, hydroxyzine / hydralazine), look-alike strengths on one page (5mg
next to 50mg), negations ("No evidence of", "Query", "r/o", "?", "FHx", "Hx", "Past history of", "D/C",
"(stopped)", "Previously on"), "NKDA" and "Nil known" allergies, and a page with no patient identity (L008).
Medicines are from the Nigerian Essential Medicines List with od, bd, tds, qds, nocte, stat, prn, 8hrly, 12hrly
and x5/7-style durations.

## How it was made

`make_pages.py` (in this folder) writes each page and its key from the same list of lines, so the drawn text and
the key's `text` always match, and it checks that every item's `asWritten` is on the lines it names. To
regenerate and reseal:

```bash
python3 tools/ocr-accuracy-kit/sets/lekan-first-pass/make_pages.py      # needs Pillow and reportlab
cd tools/ocr-accuracy-kit
node label.mjs check --keys sets/lekan-first-pass/keys --docs sets/lekan-first-pass/documents
node label.mjs seal  --keys sets/lekan-first-pass/keys --docs sets/lekan-first-pass/documents --name lekan-first-pass
```

The output is byte-for-byte the same on each run (with the same Pillow and reportlab), so the sealed manifest
stays valid unless the script changes.

## Labelling choices

These follow LABELLING.md; where it is silent, these choices were made (they are open questions on PR #153):

- **Prefixes in `asWritten`**: kept only when they carry the status ("Hx: HTN", "FHx: DM (mother)", "?UTI",
  "Query pneumonia", "r/o PTB", "No evidence of malaria", "Past history of PUD", "Previously on ..."); otherwise
  dropped ("Urticaria" for "Dx: Urticaria", "fever x4/7" for "Clinical details: fever x4/7").
- **Diagnosis `name`** is the bare condition ("typhoid" for "No evidence of typhoid").
- **Investigation requests and imaging findings** are notes ("Urine m/c/s", "E/U/Cr, FBS",
  "Thyroid USS: diffuse goitre, no nodules").
- **Combined frequency** as written ("tds prn", "qds prn").
- **Medicine status**: started on this page, or a discharge medicine started on the ward, is `new`; "continue" is
  `current`; "(stopped)", "D/C" or crossed out is `stopped`; history only ("Previously on") and treatment already
  given during the admission ("Treatment given", as the kit's D003) are `past`. A chart entry "given" is `current`,
  as in the kit's own charts.
- **Identity** is labelled on the first page only (continuation pages repeat name and folder number but are not
  labelled); fields not written are null (L017 has no sex written); L008 has no identity (null).
- **Lab `test`** as written, without a panel prefix ("S. typhi O" under the WIDAL TEST heading).
- **Table rows**: `asWritten` is the whole row, as generate.py does.
- **Vital units** as written, null when not written.
- **`prescription`** (prescriber and date) only on `new` medicines in a document of kind `prescription`, as in the
  kit's keys; never on outpatient cards, discharge summaries or referral letters.
- **`handwritten`** is on every line: true for lines in a handwriting font, false for printed letterheads,
  headings and footers (as in the kit's keys). **`trap`** is on every item (null when none) in the kit's format
  (`lookalike:a/b`, `strength:5mg/50mg`, `negation`, with every not-confirmed diagnosis and every stopped
  medicine marked `negation`, never a past one, as in the kit), and **`traps`** lists the trap types on the document.

Known scorer effect: score.mjs counts a null `sexAsWritten` in the key as a miss, so with L017 the set's sex score is
94.7% (18 of 19) even in fake mode, where everything is read exactly.

## Open questions for Session B

These are also on hid-system#153. Until they are answered, the set follows the choices above.

- **L012 "Clinical details: T2DM, HTN on follow-up"** is one note. It could instead be two confirmed diagnoses; the
  kit has no precedent, because its lab reports carry only symptom-type clinical details.
- **L016 insulin infusion** has frequency `"infusion"`. It could instead be frequency null, with "IV infusion" as
  the route.
- **L008 has two Salbutamol items** (nebulised and inhaler). Pairing "check carefully" items works by name only,
  so a real run could pair them the wrong way round.
- **L017 `sexAsWritten`** is null, which score.mjs counts as a miss.
- **The extra fields.** `label.mjs check` ignores `handwritten`, `trap` and `traps`, so their values were checked
  by hand.
