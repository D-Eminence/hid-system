# Migrate plan addition: take photos of paper records with the phone camera

**Owner, 2 Nov 2026:** "put in plan that staff can use their phone camera to ocr take/scan picture to ocr for patient migration".

**Plan item.** Staff can use their phone camera to take or scan pictures of paper records for OCR during patient migration, on migrate. and in the EHR on ehr.

Plan only. No code has been written for this.

---

## 1. What the upload page does on a phone today

Checked on health `main` (d66dd307): `apps/patient-web/src/ehr-blue/departments/migrate/DocumentCapture.tsx`, the "Upload a document" form on Migrate's document page. The same page is used on migrate. and in the EHR workspace on ehr.

- The file field is `<input type="file" accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff">`: file extensions, not `image/*`, and **no `capture`**.
- So the page never opens the camera directly. Depending on the phone and browser, the phone's own file chooser may list a camera option among its choices, but staff have to find it, and nothing on the page says so.
- **One file at a time** (no `multiple`). A record of 5 paper pages means 5 separate uploads, 5 separate documents and 5 separate OCR runs.
- The file goes up **exactly as chosen**: no metadata is removed, so a phone photo keeps its location (GPS), camera details and thumbnail. This does not meet decision 30 (orientation only), which today applies to patient uploads only.
- Types and size: PDF, JPEG, PNG or TIFF, up to 50 MiB, checked in the browser by the file's declared type (`file.type`), not by its first bytes.
- No check of the picture's quality before upload. A blurred, dark or cut-off photo is only found out after OCR has run on it.

Pages elsewhere already open the rear camera, so the pattern is proven in this codebase: the patient's "Add a record" (`routes/AddRecord.tsx`, a "Take a photo" input with `accept="image/jpeg,image/png" capture="environment"` next to a separate upload input), the Lab's new request and the Pharmacy walk-in (`capture="environment"`).

## 2. What to build

1. **A "Take a photo" button** beside "Choose a file" on Migrate's upload form. On a phone it opens the **rear camera** directly (`accept="image/jpeg,image/png" capture="environment"`, as AddRecord does). On a computer, where there is no camera input, it is not shown; "Choose a file" stays as today.
2. **Several pages, one record.** After each photo the page shows a strip of page thumbnails with "Add another page", "Retake" and "Remove" for each, and the page order (move up and down). "Done" turns the pages into **one document** for the patient's encounter, so OCR reads the record once, in order. Recommended way: wrap the JPEG pages into one PDF in the browser without re-encoding them (each page's JPEG bytes placed in the PDF as they are), with each page's rotation taken from its orientation, so the PDF shows upright. Limit to agree: about 20 pages and the existing 50 MiB per document.
3. **The same metadata rule as patient uploads (decision 30).** Before anything is sent, each photo goes through `photoMetadata.ts`: location, camera make and model, thumbnails and every other metadata block are removed, and only the orientation is kept. A photo that cannot be cleaned with certainty is refused. Apply the same rule to photos chosen from the gallery through "Choose a file". Also check each file's first bytes (`fileSignature.ts`), not only its declared type.
4. **A quality check before OCR**, in the browser, on each page before "Done":
   - too dark or too bright (average brightness);
   - blurred (a simple sharpness measure on a small copy of the image);
   - too small to read (short side under a set number of pixels).
   A failed page shows a plain message ("This page looks blurred. Retake it?") with **Retake** and **Use anyway**. "Use anyway" keeps the page and notes it on the document so the reviewer knows. The check only advises; it never sends anything anywhere and never blocks a record.
5. **Plain guidance on screen** while taking photos: flat page, good light, whole page in the frame, one page per photo.
6. **Works on both sites.** The form is shared, so migrate. and ehr. (Migrate inside the EHR workspace) get it together. Test on an Android phone with Chrome and an iPhone with Safari, on each site, signed in as a staff member allowed to upload.
7. **Offline.** Offline wave 1 (`offline/base`) keeps Migrate photos encrypted until upload and, as written in the offline staff rules today, **re-encodes** JPEG and PNG photos to remove location and camera details. That conflicts with decision 30 (keep the picture's bytes, keep only orientation). Pick one rule for both paths before either ships: recommended, decision 30's no-re-encode rule everywhere. Staff may now use their own phones (owner, 2 Nov 2026), so the offline staff rules apply to these photos on personal phones too.

## 3. Backend pieces that already exist

- **Document upload**: the three-step upload (ask for an upload link, put the bytes straight into storage, confirm), with only the account that started an upload able to finish it. Migrate already uses it (`staffApi.uploadDocument`).
- **Document types** (owner's rule of 31 Oct), already sent with the file once the EHR says it serves them.
- **Document storage** in AWS eu-west-1 (Ireland), with the bucket's CORS rule allowing uploads from the EHR, Lab, Pharmacy and Migrate sites.
- **Virus scanning**: GuardDuty Malware Protection for S3, built (database half and scanner bridge, in hid-system's backend release chain). Not yet live. Until it is, every upload stays waiting for its scan and cannot be opened or sent to OCR.
- **OCR, records processing Stage 1**: text reading by Amazon Textract (the worker is permitted the multi-page call, `StartDocumentTextDetection`), then the AI reading step, code checks and item review by staff; laboratory records included; patients under 18 refused; working data deleted after 24 hours (owner decision 6). Built, in the backend release chain, not yet live.
- **The orientation-only metadata remover and the file-type check** in the website (`photoMetadata.ts`, `fileSignature.ts`), written for patient uploads; the orientation-only version ships in the next website batch.

## 4. What is left

- **Website**: the "Take a photo" button, the page strip, joining pages into one PDF, the quality check, using the metadata remover and file-type check on Migrate, the on-screen guidance, and tests (camera input present on touch devices, pages kept in order, metadata removed, a blurred page warned).
- **Backend**: none needed for single photos. For one multi-page PDF: confirm the OCR worker reads every page of a PDF (the asynchronous Textract path), not just the first, and set a page limit. Optional: a field on the document saying a page was kept after a quality warning.
- **Releases in order**: the virus scanner and OCR Stage 1 must be live first; until then photos upload and wait.
- **Decisions for the owner**: the page limit per record; whether "Use anyway" is allowed or a failed check must be retaken; the one metadata rule for online and offline photos (section 2, item 7).
- **Cost**: more pages per record means more Textract and AI reading per record, inside the USD 400 a month AWS budget (decision 5) for Textract; the AI reading is billed outside AWS (decision 6).
