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
next to 50mg), negations ("No evidence of", "Query", "r/o", "?", "Working diagnosis", "FHx", "Hx", "Past history
of", "D/C", "(stopped)"; "Previously on" is a past medicine, not a trap), "NKDA" and "Nil known" allergies, and a page with no patient identity (L008).
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

## Labelling rules followed

The set follows `../../LABELLING.md` as of #153's head `76bb6561`, including the answers to Lekan's 11
questions on hid-system#153 (now "Rules for common cases" 1-11 there). For each:

1. **Handwriting**: `handwritten` is on every line: true for lines drawn in a handwriting font, false for printed
   letterheads, headings, typed lines and footers. `--fake` uses the flag.
2. **Traps**: `trap` is on every item (null when none): `lookalike:a/b`, `strength:5mg/50mg` or `negation`, with
   every diagnosis that is not `confirmed` and every `stopped` medicine marked `negation`, never a `past` one.
   No medicine in the set clashes with its document's recorded allergy (L001 sulphonamides, L003 ceftriaxone,
   L007 penicillin, L016 cotrimoxazole, L019 aspirin), so there is no `allergy_conflict`, and no page is dated
   after the set was made, so there is no `future_date`. The document's `traps` is the sorted trap types of its
   items.
3. **`asWritten`** keeps words that give status or meaning ("?UTI", "Query pneumonia", "r/o PTB", "Hx: HTN",
   "FHx: DM (mother)", "Past history of PUD", "No evidence of malaria", "Working diagnosis: Depression",
   "(stopped)", "- D/C", "Previously on ...", a vital's label, a lab row's test name, "Allergy:") and drops pure
   section labels ("Dx:", "Diagnosis:", "Secondary:", "Assessment:", "C/O:", "Clinical details:", "Plan:",
   "Comment:", "Note:", "Nurse note:", "Presenting complaint:", "Follow-up:", "On admission:", "At D/C:", list
   numbers "1."). No `name` holds a status cue.
4. **Diagnosis `name`** is the condition only ("T2DM" for "T2DM (poorly controlled)", "Hypertension" for "FHx:
   Hypertension (father)", "HTN" for "HTN - poorly controlled"); the qualifier stays in `asWritten`.
5. **Requests and imaging** are notes, never a `lab_result` without a value ("Urine m/c/s", "E/U/Cr, FBS",
   "CXR, sputum AFB x3", "CXR: right lower lobe consolidation", "Thyroid USS: diffuse goitre, no nodules").
6. **Combined frequency** is all of it as written ("tds prn", "qds prn").
7. **Medicine status**: `new` when the page starts or prescribes it (prescriptions, "Rx", "(new)", discharge
   medication); `current` for "continue", "Currently on" and a chart's "given"; `stopped` for "(stopped)" and
   "D/C"; `past` for "Previously on" and for treatment given during the admission ("Treatment given", "Given on
   ward").
8. **Identity** once, from the first page; the name and folder number repeated on continuation pages are neither
   identity nor items. Fields not written are null (L017 has no sex written); L008 has no identity (null).
9. **Lab `test`** is the row's own name with no panel prefix ("WBC" under FULL BLOOD COUNT, "S. typhi O" under
   WIDAL TEST); a bracketed method stays ("MP (thick film)", "Species (thin film)", "mRDT (HRP2)"). A table row is
   one item with the whole row as `asWritten`; header rows are not items.
10. **Vital units** as written ("/min", "b/min", "mmHg", "%", "C", "kg"), null when not written; "on air" (L003)
    is not part of the SpO2 unit.
11. **`prescription`** only on `new` medicines in a document of kind `prescription`, as in the kit's keys; a
    stopped or past medicine has `prescription: null`.

Also from that head:

- **Working diagnosis** is `suspected` (a `negation` trap), with "Working diagnosis:" kept in `asWritten`
  (L018-i02 Depression, L019-i02 Thyrotoxicosis; both were `confirmed` before).
- **`dateAsWritten`** is on every item, copied from its own page: the visit or prescription date on
  prescriptions and outpatient cards (L001's only date is on its signature line, as in LABELLING.md's worked
  example); the request line's date on lab reports (L002 "Received: 09/11/2026", not the 10/11/2026 sign-off;
  L014 page 2 gives the same 10/11/2026 on its scientist line); the letter date on referral page 1, null on
  L019's undated page 2; the chart day on L020. In discharge summaries: the discharged date for the final and
  secondary diagnoses, the admitted date for the other diagnoses, allergy, presenting complaint and vitals on
  admission, null for investigations and treatment given (including L017's undated "PCV: 30%"), and for the
  discharge medicines, notes and follow-up on a continuation page, the date on that page's signature line, which
  is the discharged date (L003 p2, L015 p2, L016 p3, L017 p2). L016 page 2 gives no date, so its items are null.
  L017's "Delivered by C/S 02/11/2026" takes its own date. 242 items are dated, 33 null.
- Every text field is on the item's own lines (`check` tests it).

Known scorer effect: score.mjs counts a null `sexAsWritten` in the key as a miss, so with L017 the set's sex score is
94.7% (18 of 19) even in fake mode, where everything is read exactly.

## Open questions for Session B

Not answered on hid-system#153 yet. Until they are, the set keeps the choice shown.

- **L012 "Clinical details: T2DM, HTN on follow-up"** is one note. It could instead be two confirmed diagnoses; the
  kit has no precedent, because its lab reports carry only symptom-type clinical details.
- **L016 insulin infusion** has frequency `"infusion"`. It could instead be frequency null, with "IV infusion" as
  the route.
- **L008 has two Salbutamol items** (nebulised and inhaler). Pairing "check carefully" items works by name only,
  so a real run could pair them the wrong way round.
- **L017 `sexAsWritten`** is null, which score.mjs still counts as a miss.
- **Continuation-page dates.** Discharge medicines and follow-up on a continuation page take the date on that
  page's signature line (the discharged date). The kit's own continuation pages have no date line, so it has no
  precedent; the alternative is null.
