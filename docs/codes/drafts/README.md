# Draft medicine and lab-test lists (not approved)

These are **drafts** for ORD-7, the medicine and lab-test pickers. Nothing here is loaded. A clinician reviews and signs off each list first (owner decision Q124 A). The sign-off is recorded later in `docs/codes/catalog-approvals.json`, and the reviewed lists become the versioned seed files the planned contract names (`docs/codes/hid-medicines.json` and `docs/codes/hid-lab-tests.json`).

The files hold facts only: medicine names, strengths, dose forms and routes, test names and specimens, and codes. No text from any source document is copied.

## Files

| File | Rows | What it holds |
|---|---|---|
| `medicines-nigeria-eml-8.csv` | 1,371 | One row per product (generic name + strength + dose form) on the Nigeria Essential Medicines List, 8th edition: 1,248 from the main list and 123 from Appendix 2, the restricted medicines list. |
| `medicines-who-eml-gaps.csv` | 253 | Products of 116 medicines on the WHO Model List of Essential Medicines (24th list, 2025) that the Nigeria list does not have at all, under any name or salt: 188 rows from WHO's core list and 65 from its complementary list. Same columns; `source` is `who-eml-24`, and `source_list` is `core` or `complementary`. **Kept apart because of WHO's licence (see Sources): the owner can drop this file on its own.** |
| `lab-tests.csv` | 158 | Tests Nigerian hospitals and clinics order most, with specimen, category and a code where one is certain. |

What is left out of the medicine files:
- **From the Nigeria list:** the primary health care lists, the list for patent and proprietary medicine vendors and the vitamin appendix, since nearly all their medicines are on the main list. A few appear only there, for example levamisole oral liquid and nicotinamide. The reviewer decides whether to add them.
- **From the WHO list:** medicines the Nigeria list already has, whether matched by name, salt or ATC code. Also devices and supplies (condoms, diaphragms, copper devices, dental filling materials), disinfectants and hand rub, and blood components (whole blood, red cells, platelets, plasma, cryoprecipitate).
- **Products:** a WHO medicine the Nigeria list has in another strength or form is not added in WHO's strength.

### Medicine columns

| Column | Meaning |
|---|---|
| `generic_name` | The INN, in lower case. A fixed combination reads `a + b`. |
| `strength` | As the list gives it. A pack size is kept only where it defines the product. Empty for medical gases. |
| `dose_form` | One of the contract's values: `tablet`, `capsule`, `liquid`, `injection`, `cream`, `inhaler`, `drops`, `other`. |
| `dose_form_text` | The list's own words for the form, for example "Oral liquid". |
| `route` | Plain words: `oral`, `intravenous`, `topical` and so on. `injection` where the list does not say which. |
| `atc_code` | The WHO ATC code, **only where checked**. Every one of the 539 distinct codes in the Nigeria file (and the 83 more in the WHO gap file) was looked up on the WHOCC ATC index (atcddd.fhi.no) on 22 Nov 2026, and its substance matches the row. Blank where no code could be confirmed (118 rows). |
| `source` | `nigeria-eml-8`. The planned contract's example says `nigeria-eml-7`; the 8th edition replaces it (see Sources). |
| `source_section`, `source_list` | The list's section number, and `main` or `restricted`. |
| `notes` | Short notes, for example a misprint in the source corrected to the INN spelling, or "for children". |

### Lab-test columns

| Column | Meaning |
|---|---|
| `name`, `other_names` | The plain name, and common abbreviations and synonyms (separated by `; `). |
| `specimen`, `category` | The usual specimen, and a category for grouping in the picker. |
| `code_system`, `code` | `LOINC` with its code, `HID-LAB` with an existing code from `docs/codes/hid-lab-codes.json`, or blank. Each of the 143 LOINC codes was looked up on the US National Library of Medicine's LOINC search service on 22 Nov 2026: it exists, and its name matches the test as ordered. |
| `loinc_long_name` | LOINC's long common name for that code, so the reviewer can check it. |
| `notes` | Short notes, including "HID-LAB code exists" where the local list already has the test. |

13 tests have no code: no LOINC code clearly matched, and none is in `hid-lab-codes.json`. The reviewer decides whether each needs a new HID-LAB code.

## Sources

| Source | Edition and date | Where it came from | Licence and terms |
|---|---|---|---|
| Nigeria Essential Medicines List for Adults | **8th edition, 2024**. Federal Ministry of Health and Social Welfare; foreword by the Coordinating Minister of Health and Social Welfare. Published on the Ministry's site in August 2025. | `https://health.gov.ng/wp-content/uploads/2025/08/Final-NEML-Adult-8th-Edition.pdf` (105 pages, sha256 `00511d93ea52ee1c794682be6138f221c77cb88029890204ec61f2021bf6152b`), read on 20 Nov 2026 | The document says "All rights reserved" and presents the list "for use by the public". It gives no licence. Only facts are taken (names, strengths, forms, routes); no text, tables or layout are copied. **Owner:** please confirm this use is acceptable. |
| WHO Model List of Essential Medicines | **24th list, 2025** ("The selection and use of essential medicines, 2025"). World Health Organization, Geneva; https://doi.org/10.2471/B09474 | The PDF the owner supplied (74 pages, sha256 `69daf7c8399b85978ba85e143d3af34e6ccf7f3d493b1e056daa7ef909d64eb2`) | **CC BY-NC-SA 3.0 IGO**: non-commercial use only, with attribution, and adaptations under the same licence. Only facts are taken (names, strengths, forms, routes); no text or tables are copied. Whether a list of facts drawn from it may be used in Health ID is **for the owner to decide** before anything in `medicines-who-eml-gaps.csv` loads. Where it is used, cite: "WHO Model List of Essential Medicines, 24th list. Geneva: World Health Organization; 2025. Licence: CC BY-NC-SA 3.0 IGO." |
| WHO ATC classification | The index as published on 22 Nov 2026 | `https://atcddd.fhi.no/atc_ddd_index/` | WHOCC's terms for ATC codes need checking before release (decision 9 on #258). Codes only; no DDDs or text are copied. |
| LOINC | As served on 22 Nov 2026 | NLM Clinical Table Search Service, `https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search` | LOINC is free to use under its licence. Any product that shows these codes must carry LOINC's attribution notice, as the planned contract's catalog answer does ("This material contains content from LOINC (http://loinc.org) ..."). |

**Why the 8th edition:** the coordinator asked for the latest edition. The ocr-worker drug list (`services/ocr-worker/src/reading/drug-list.ts`) and the planned contract cite the 7th edition (2020), which was the latest found on 5 Nov 2026. The 8th edition was found on 20 Nov 2026 on the Ministry's own site.

**The OCR'd source:** the PDF is a scanned document with a text layer, so some names were misread (for example "Isotlurane"). Each one is corrected to its INN spelling, and the notes column says so. The reviewer should still compare strengths against the printed list.

## What the reviewer should check

1. Every strength and dose form against the printed list, especially rows whose notes mention a correction.
2. The routes the list leaves unstated (`injection`).
3. The 118 medicine rows and 13 tests with no code.
4. Whether any medicines common in Nigerian practice are missing from the 8th edition and should come from another source.
5. The lab tests: whether the 158 are the right ones, and their specimens.
