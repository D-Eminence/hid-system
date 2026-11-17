# Migrate paper records: items, checking and publishing (backend)

Owner decisions 33 and 34 (3 Nov 2026), the approved Migrate design (decision 34), and the
48-hour brief for Session C. Migrations **0107, 0108, 0109**, written on 0103 (staging
34d69557). Nothing here uses or needs 0104 (records processing), 0105 (virus scanner),
0106 (support check) or 0110 (Session B's page allowance). Where 0110 exists it is
looked up with `to_regprocedure` and used if present.

Reading output contract: Session B's `hid-paper-reading-v2`, stored by ocr-worker in
`ocr.extractions.structured_payload` through the existing `ocr.complete_worker_job`
(agreed B/C, 3 Nov). Session D's route names are kept where nothing argues against them.

## Identity of a paper

A **paper record** is one `ehr.documents` row uploaded as a paper record. Its id is the
**document id**, so a paper has an id before a reading job exists. Every `:id` in the
`/ocr/paper-records/:id/...` routes is a document id. The current reading job is the
newest `ocr.jobs` row for that document.

## Plain status (per paper)

| status | when |
|---|---|
| `checking_for_viruses` | uploaded, latest scan is pending or `scan_started` |
| `reading` | a job is queued, processing or extracted, or reading is paused by the allowance |
| `ready_to_check` | job `awaiting_validation`; `checkBy` = extraction time + 24 h |
| `published` | the set was published (some items may have failed; `canRetry`) |
| `couldnt_read` | scan rejected or failed, job failed, the auto-start was refused, or the check window passed; `failure` is a plain reason code, `canRetry` |
| `withdrawn` | stopped as the wrong patient before publishing, or withdrawn after publishing |

`failure` codes (never shown raw; the website maps them to words): `virus_found`,
`scan_failed`, `unreadable`, `access_ended`, `under_18`, `allowance_used_up`,
`check_time_passed`, `reading_failed`.

## 0107 `ocr_paper_record_review` (ocr and ehr schemas)

1. `ehr.paper_record_uploads` (document_id PK/FK, facility_id, patient_id, page_count 1-20,
   flagged_pages smallint[] within 1..page_count, requested_by, requested_by_membership_id,
   correlation_id, created_at, ocr_job_id null, start_refusal_code null, start_attempted_at).
   Written by ehr-api when an upload intent has `documentType: "paper_record"`. RLS: facility.
2. **Auto-start.** An AFTER INSERT trigger on `ehr.document_scan_events` for `clean` events
   calls the SECURITY DEFINER `ocr.start_paper_record_reading(document_id)`. It:
   - finds the paper upload, does nothing for other documents;
   - checks the patient is 18 or over (refusal `under_18`) and that the uploader still has
     an active write grant for the patient (refusal `access_ended`);
   - inserts an `ocr.jobs` row (created_by = the uploader, idempotency key
     `paper-record:<document id>`, provider `textract`) so ocr-worker claims it;
   - never raises: any failure is caught and kept as `start_refusal_code`, so the scan
     result is always recorded.
3. `ocr.found_items`: one row per item copied from `structured_payload.items` when staff
   first open the check screen (job, extraction, item_id, kind, as_written, plain,
   date_as_written, page, line_ids, box, confidence, check_reason, fields, prescription,
   source `reading` or `added_by_staff`). Unique (job_id, extraction_id, item_id).
4. `ocr.paper_identity_checks`: the "Is this the patient's paper?" answer per job and
   extraction. Fields: `match` computed on the server (`matches | differs | no_name |
   folder_number_only`), answer `this_patient | wrong_patient`, confirmed_by, membership,
   and `confirmed_with_patient` (required true for `folder_number_only` and `no_name`).
   A `differs` match can only be answered `wrong_patient`.
5. `ocr.review_drafts`: one draft per job (decisions jsonb, row_version, saved_by, saved_at).
   Working data.
6. `ocr.item_decisions`: written at publish, one per found item: `accept | change | remove`,
   changed_fields jsonb (`change` only), remove_reason (`not_on_paper | not_this_patient |
   listed_twice | other`), decided_by.
7. `ocr.item_publications`: per accepted item: status (`pending | published | failed`),
   target_resource_id, failure_code, attempt_count, and an idempotency key held on the server
   (`ocr-item:<publication id>:<item id>`).
8. Widened checks on existing 0016 tables (md5 preconditions on the old definitions):
   - `ocr.validations.candidate_type` + `paper_record_items`;
   - `ocr.patient_confirmations.method` + `paper_identity_check`;
   - `ocr.publications.target_operation` + `create_paper_record_items`.
9. Grants: hid_ocr_runtime gets S/I/U on the new ocr tables; hid_ehr_runtime gets S/I on
   `ehr.paper_record_uploads`. runtime-grants.sql gains a 0107 block.

## 0108 `ehr_paper_record_items` (ehr schema, permissions, short lists)

1. `ehr.paper_record_items`: the chart's "From paper records". One row per published item.
   Columns: patient_id, facility_id, kind, values jsonb (the checked values), as_written,
   date_as_written, source document, ocr job, extraction, validation, publication, item_id,
   checked_by, published_by, published_at, `prescription_prescriber_as_written`,
   `prescription_date_as_written`, status (`active | entered_in_error | withdrawn`),
   correction fields (by, membership, at, reason). Unique (publication_id, item_id).
   Medicines are history only. Lab results are stored as imported results and vitals as
   recorded values; no visit is made up.
2. `ehr.paper_record_corrections`: append-only log of every correction (item or whole paper).
3. New permissions:
   - `ehr.paper_records.read`: doctor, clinician, nurse.
   - `ehr.paper_records.correct`: **doctor and clinician only** (not nurse).
4. Corrections (SECURITY DEFINER, permission checked in SQL with
   `auth.membership_has_permission`):
   - `ehr.mark_paper_record_item_entered_in_error(item, reason, expected_row_version)`;
   - `ehr.withdraw_paper_record(document, reason)`: every active item from that paper becomes
     `withdrawn` in one step, and a facility notice is written. Nothing is deleted.
   Correction reasons: `wrong_value | wrong_patient | not_on_paper | duplicate | other`.
5. `ehr.prescriptions.source_paper_record_item_id` (nullable FK). A prescription made from a
   scan must point at an active medicine item of the same patient that carries a
   prescription. The prescriber who creates it is the one who signs it, and the pharmacy
   sees it only through the existing guard.
6. Short lists for "Change" (`ehr.paper_record_pick_lists`), seeded as data and marked
   `needs_clinical_check` until Ola and a pilot clinician check them:
   - medicines from the Nigeria Essential Medicines List;
   - common conditions;
   - lab tests (MP, mRDT, Widal, PCV, FBC, E/U/Cr) with units;
   - frequencies, medicine statuses, diagnosis statuses, allergy severities, remove reasons
     and correction reasons.

## 0109 `ocr_working_data_expiry`

- 0013's `ocr.reject_immutable_change` stays on job events, validations, confirmations and
  provenance. On `ocr.extractions`, only one change is allowed: through
  `ocr.clear_expired_working_data()`, which sets `raw_text = null`,
  `structured_payload = '{}'` and records `working_data_cleared_at`, for rows older than
  24 hours. Every other update or delete is still refused.
- The same function deletes found items, drafts and the changed or removed details of
  rejected decisions older than 24 hours. The decision rows themselves, identity checks,
  publications and chart items stay. Audit counts are written, with no patient text.
- ocr-api runs it every 15 minutes (the `patient-lifecycle.sweeper.ts` pattern), with
  SKIP LOCKED and batches.

## Routes

ocr-api (`/api/v1`):
- `GET /ocr/patients/:pid/paper-records/availability` → `{available, reason, coveredUntil,
  allowance}`. `reason` is one of `under_18 | emergency_access | view_only | no_permission |
  not_enabled_here | allowance_used_up`. `allowance` is null until 0110 is live.
- `GET /ocr/patients/:pid/paper-records` → the papers: status, checkBy, failure, canRetry,
  pageCount, takenAt, and published counts.
- `GET /ocr/jobs?patientId=` → jobs with plain status.
- `POST /ocr/paper-records/:id/retry`.
- `GET /ocr/paper-records/:id/review` → pages (signed `imageUrl`), identity (+`match`), items,
  saved draft, short lists. `GET /ocr/jobs/:id/items` returns the same items.
- `PUT /ocr/paper-records/:id/review-draft` (expectedVersion).
- `POST /ocr/paper-records/:id/identity` → this_patient | wrong_patient, confirmedWithPatient.
- `POST /ocr/paper-records/:id/validate` → checks the whole set without publishing.
- `POST /ocr/paper-records/:id/publish` (Idempotency-Key) → per-item results.
- `POST /ocr/paper-records/:id/withdraw` → before publishing: stops the paper; after: calls
  ehr-api withdraw.

ehr-api (`/api/v1`):
- `POST /ehr/documents/upload-intents` accepts `documentType: "paper_record"` and
  `paperRecord{pageCount, flaggedPages}` with no `encounterId`.
- `GET /ehr/documents?patientId=` (encounterId now optional) lists documents with no visit.
- `GET /ehr/patients/:pid/paper-record-items`.
- `POST /ehr/paper-record-items/:id/entered-in-error`.
- `POST /ehr/internal/ocr/patients/:pid/paper-record-items` (ocr-api only).
- `POST /ehr/internal/ocr/paper-records/:documentId/withdraw` (ocr-api only).
- Prescription create accepts optional `sourcePaperRecordItemId`.

## Publish rules (server-side)

- The identity check is answered `this_patient`, and `match` is not `differs`. For
  `folder_number_only` and `no_name`, `confirmedWithPatient` is true and the confirmer is
  recorded.
- Every found item has its own decision. There is no bulk accept, so any missing decision
  refuses the publish with `ITEMS_NOT_ALL_CHECKED`.
- A `change` keeps only allowed fields for its kind, and the values are checked against the
  short lists where one exists.
- Only doctor, clinician or nurse (`ocr.publication.write`) may publish. One person may check
  and publish.
- The patient is re-checked at publish: 18 or over, a write grant, and not emergency access.
- Publishing is per item, each with its own server-held key. A failed item can be retried
  from any device with the same Idempotency-Key, and items already published are never
  duplicated.
- The check window is 24 hours from reading. After that, the found items are cleared and the
  paper shows `couldnt_read` with `check_time_passed` and `canRetry`.

## Agreed with Session B and the coordinator (3 Nov, 12:18 UTC)

- 0110's read function is exactly
  `ocr.facility_page_allowance(requested_facility_id uuid) returns table(pages_used integer,
  pages_limit integer, resets_on date, paused boolean)`. It is granted to the ocr-api runtime and
  authorized for facility staff holding `ocr.job.read`. Look it up with
  `to_regprocedure('ocr.facility_page_allowance(uuid)')` and return `allowance: null` when it's
  absent.
- Lines live only in `ocr.extractions.structured_payload.pages[].lines`, so 0109's clear-out of
  that column removes the line positions.
- The coordinator will check these in review. Each needs a DB-suite test:
  - 0109's exception covers working data only (extractions, found items, drafts, the details of
    rejected or removed suggestions). It never covers published items, decisions, identity checks
    or audit rows. It applies only to rows older than 24 hours, only through the one clear-out
    function, and logs counts, never content. The same update or delete is still refused for every
    runtime role, the table owner path outside the function, and rows younger than 24 hours.
  - A failed reading start (forced error inside `ocr.start_paper_record_reading`) leaves the
    `ehr.document_scan_events` row and the document's `clean` status intact.
  - Under-18 refusal is checked on the server at upload, at reading start and at publish. The
    24-hour cover's grant objects come from 0104, so until then a write grant is accepted.
  - The server refuses a publish unless every item, including every medicine, allergy and lab
    result, has its own decision.
  - Every short-list row is `needs_clinical_check = true` until Ola and the pilot clinician sign
    them off.
