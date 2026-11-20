# OCR to FHIR structured records: design (31 Oct 2026)

## Recommended approach

Approach B as the base: Claude on Amazon Bedrock structures each document, deterministic code checks every item against the source text, and approved items go into typed HID 'imported' tables. FHIR R4 sits at the boundary only. Grafts:
- From A: a record-set header row with full provenance, the IPS profile detail (including free 'no known allergy' codes), the terminology licence register, the TIFF routing fix, the AWS AI opt-out policy and one origin-label vocabulary.
- From C: keep Textract LAYOUT+TABLES, an upload document-type hint, no database grants for the pharmacy and lab runtimes on imported tables, a hard-stop item fingerprint, a 5% audit, a clinical safety officer and correction from day one.
- Keep A and B's Pharmacy acceptance guard, which closes a gap that exists today. It can ship first.

## Scores

- **A: AWS-native structuring (Textract v2 + Amazon Comprehend Medical + rules layer), typed ehr.imported_* tables, FHIR R4 at the boundary only**: 7.2/10. Strengths: Sub-scores: safety 8.5, clinical usefulness 6.5, FHIR 8.5, ADR-022 fit 9, privacy 8.5, cost 4.5, delivery 6.
- It has the most complete and correct FHIR profile set. Profiles are derived from IPS. 'No known allergies' uses the free IPS absent-unknown-uv-ips codes, so no SNOMED is needed. It handles Attachment.hash being SHA-1 with an hid-sha256 extension. It maps interpretation to N/L/H/A/AA and observes the vs-1 day-precision rule.
- It found and fixes the real Pharmacy trust gap (0106). I verified the gap:
  - pharmacy.work_items.source_ehr_prescription_id has no foreign key (be:services/ehr-api/database/migrations/0023_pharmacy_domain_foundation.sql:58);
  - the service inserts the literal 'active' using caller-supplied fields (be:services/pharmacy-api/src/pharmacy/pharmacy.service.ts:130);
  - the latest validator checks only actor, facility, 'active' and live routes on the local path (be:services/ehr-api/database/migrations/0086_provider_self_service_onboarding.sql:9424-9488).
- It found the TIFF gap, which I verified. Upload accepts image/tiff (web:apps/patient-web/src/ehr-blue/departments/migrate/DocumentCapture.tsx:203), but the worker refuses any image that is not PNG or JPEG (be:services/ocr-worker/src/textract.provider.ts:69-70).
- It fits ADR-022 exactly (be:docs/DECISIONS.md:587). Labs stay in lab-api and everything is published through the owning service (be:CODEX.md:1132-1138).
- Data minimisation is strong: the identity header is kept out of the NLP text, and identity evidence comes locally from Textract QUERIES.
- Comprehend Medical runs in-region in eu-west-1, so the data stays Ireland-only.
- Useful ideas worth keeping:
  - an ehr.imported_record_sets row per publication (one provenance anchor, and a whole-set wrong-patient withdrawal);
  - a terminology licence register with an 'exportable' flag;
  - one origin-label vocabulary;
  - retiring the old single-target operations;
  - the AWS Organizations AI opt-out policy. Weaknesses: - It is the most expensive: about $3,400 a month at pilot volume (about $41k a year), and Comprehend Medical entity detection is about 75% of the AWS bill.
- Comprehend Medical is English-only and trained on US text. It has weak recall on Nigerian brands, local abbreviations and lab panels, so the design leans on a large hand-curated rules and lexicon layer that someone must keep up.
- Its ICD-10-CM and RxNorm links are US ontologies and need crosswalks.
- Comprehend Medical cannot decide which section an item belongs to ('treated for' vs past history) the way the owner's request needs.
- Its default export is MedicationRequest with intent 'order'. That is semantically defensible, but a downstream system is more likely to treat it as an order than a MedicationStatement.
- It forces Condition.clinicalStatus 1..1, which makes reviewers guess when the paper is silent. R4 con-3 requires it only for problem-list items.
- Its 121-day estimate looks optimistic for 8 tables, an NLP client, a rules package and a FHIR mapper.
- It says Bedrock is used only for chat embeddings. In fact chat generation calls api.anthropic.com with inference_geo 'us' (be:services/ehr-api/src/ehr/patient-records/claude-ai.service.ts:116,121; dev:infra/terraform/environments/production.tfvars:216,218), and that matters once imported items reach chat.
- **B: Claude LLM structuring on Amazon Bedrock (EU profile) with deterministic grounding, typed ehr.imported_* tables, FHIR R4 at the boundary only**: 8/10. Strengths: Sub-scores: safety 9, clinical usefulness 8, FHIR 8, ADR-022 fit 8.5, privacy 7, cost 8.5, delivery 6.
- It has the strongest hallucination defence:
  - every item must cite OCR line ids;
  - code checks each value against the cited text, and numbers must match exactly;
  - codes the model proposes are dropped unless they exist in loaded code systems;
  - the model gets no tools and schema-only output, and the document text is treated as data.
- An LLM handles Nigerian abbreviations, local drug brands and section meaning ('treated for' vs past history) far better than entity NLP, so it is the most clinically useful structure per reviewer minute.
- Its safety choices are the best of the three:
  - MedicationStatement is the default, which is the safest resource for downstream systems;
  - statuses are CHECK-limited and never 'active';
  - it fixes the real same-facility Pharmacy acceptance gap, which I verified (0086:9424-9488; pharmacy.service.ts:130);
  - it leaves Condition.clinicalStatus out when the paper is silent, which is honest and conforms to con-3 and con-5.
- It reuses existing precedent:
  - a private Bedrock endpoint with an EU inference profile behind an approval precondition (dev:infra/terraform/modules/ai/main.tf:1-21,69);
  - structured outputs, already used by chat (claude-ai.service.ts:121).
- It correctly found that chat goes to the US Claude API, which I verified, and deliberately does not reuse that path.
- Structuring is additive. If it fails, the job is still reviewable by hand, and the job state machine is untouched (be:services/ehr-api/database/migrations/0077_fail_closed_session_guards_and_ocr_worker_leases.sql:236).
- Cloud cost is low: about $410-720 a month at pilot volume. The model prices match Anthropic's published first-party rates (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per million tokens). Bedrock bills separately. Weaknesses: - It drops Textract TABLES and LAYOUT to save money. That loses the column structure of lab reports, the most structured paper input. Keeping LAYOUT+TABLES costs only about $225 a month.
- Under the EU geographic profile, inference can run in 6 EU regions, plus possible abuse-detection storage in opt-in regions. That widens the NDPA transfer record. The Ireland-only option is limited to whatever model is In-Region, and I could not verify B's per-model regional claims.
- Bedrock has no server-side refusal fallbacks, so retries must be client-side. Opus 5.5's 'bio' classifier may refuse microbiology text, and the eval must measure how often.
- It carries a separate Java HL7 validator sidecar in production, which is an operations burden.
- It has the largest effort estimate (155 days): a new structurer service, an eval harness and a gold set.
- It has no record-set header row, so wrong-patient withdrawal is per publication without one patient-scoped anchor.
- It puts vitals and allergies late, in Stage 2b.
- **C: FHIR-native JSON store (fhir_import schema) as system of record for imported history, LLM structuring**: 6.1/10. Strengths: Sub-scores: safety 6.5, clinical usefulness 7, FHIR 8, ADR-022 fit 3, privacy 7.5, cost 8.5, delivery 5.
- It is the literal reading of 'FHIR standard'. One generic store covers nine resource kinds, partial dates are stored natively, export is nearly free, and future inbound partner FHIR could land in the same place.
- It correctly rejects the 'integration' schema. Migration 0026 says integration never owns domain semantics, and CODEX requires publishing through the owning service (be:CODEX.md:1132-1138).
- Good ideas worth keeping:
  - pharmacy and lab runtimes get no grants on the import store, with a suite proving it;
  - a hard-stop unique key on (source_sha256, item fingerprint);
  - an upload-time document-type hint;
  - keeping LAYOUT+TABLES;
  - excluding imported vitals from trend lines by default;
  - a 5% second-review audit;
  - a named clinical safety officer and a hazard log;
  - correction and entered-in-error in the first release, because validation is final.
- Its cloud cost is low. Weaknesses: - It contradicts ADR-022's 'FHIR is not the primary internal persistence model' (be:docs/DECISIONS.md:587). It needs a new ADR-036 plus amendments to CODEX §32, §33 and §34, and it moves imported lab evidence out of lab-api. That is the most governance and review friction of the three.
- It creates two models of the same clinical concept, typed ehr.diagnoses rows and Condition JSON. Every view, duplicate check and future decision-support rule must read both, with two status vocabularies.
- It makes a factual safety error. It says pharmacy work items require an ehr.prescriptions row, so 'no path exists'. The code shows no foreign key, and the service inserts caller-supplied fields with a hard-coded 'active' (0023:58,61; pharmacy.service.ts:130; 0086:9424-9488). It therefore misses the real acceptance gap that A and B close.
- It infers clinical state: acute conditions on documents older than 90 days default to 'resolved'.
- It forbids 'NKDA' unless SNOMED is licensed. That is wrong, because the IPS absent-unknown codes are free.
- It fixes Condition category to encounter-diagnosis, which loses problem-list history.
- It adds a 'structuring' job state, which changes the hashed transition table at 0077:236.
- jsonb is weaker for reporting, and the TypeScript validator can drift from the HL7 validator.

## Plain summary

What will happen
When staff scan a paper record, the system reads it and splits it into separate entries. Prescriptions go under Prescriptions, notes under Notes, what the patient was treated for under Conditions. Lab results, vital signs, allergies and vaccinations each get their own section too.

An AI model hosted by Amazon in Europe suggests the entries. The software then checks that every suggestion matches words actually on the page. A staff member accepts, edits or rejects each entry while looking at the scanned page, and a doctor, clinician or nurse files them into the record. Nothing is ever filed automatically.

What the record will look like
Each section shows the hospital's own entries and, beside them, entries marked "Paper record". Each one shows where it came from and who checked and filed it, and has a link that opens the original page.

Paper-record medicines are shown as history only. They can never be sent to a pharmacy or dispensed. We will also close a separate gap we found: today Pharmacy can accept a prescription without checking that a real, active one exists.

Patients will see a "From your paper records" section, can report mistakes, and get a notification when items are added. Records for under-18s stay refused, as in Stage 1. The data is stored in a form that can later be exported in the international FHIR format, so other systems can read it.

What it costs
Cloud costs are about $550-900 a month for 5,000 three-page documents, about $7-11k a year. Building it takes about 150 person-days, with the first slice in about 7 weeks once the virus scanner and Stage 1 are live.

The bigger cost is people. Checking documents takes about 2-4 full-time reviewers at that volume, plus some clinician time to file them.

What you must decide first
1. Approve using Claude on Amazon Bedrock, and whether processing may happen anywhere in the EU or only in Ireland.
2. Agree that paper prescriptions are filed as medicine history, never as active orders.
3. Approve the Pharmacy safety fix.
4. Choose when patients see imported items, and whether sensitive results can be held back.
5. Approve the code systems (ICD-10/11, LOINC, a Nigerian medicines list).
6. Sign the privacy assessment (DPIA) and the updated patient notice before any real document is processed.
7. Name a clinical safety lead and a pilot facility.

## Buildable plan

VERDICT AND WHAT "FHIR STANDARD" WILL MEAN
- Each item on a scanned record is filed in its own chart section:
  - prescription → Prescriptions;
  - note → Notes;
  - what the patient was treated for → Conditions;
  - also labs, vitals, allergies, procedures and immunisations.
- Each item is stored in a typed HID table whose columns map 1:1 to a FHIR R4 resource: value sets, partial dates, verbatim text, codes and provenance.
- One shared mapper renders FHIR for reviewers (the draft) and for export (Stage 3).
- This meets the request without breaking ADR-022 ("FHIR is not the primary internal persistence model", be:docs/DECISIONS.md:587; "never a second patient identity authority", :591). It also keeps "publish through the owning service" (be:CODEX.md:1132-1138).
- Approach C's FHIR JSON store stays an owner option, but it needs an ADR change and duplicates clinical models.

FACTS I VERIFIED THAT SHAPE THE PLAN (read-only, on the scratchpad archives)
- V1. The Pharmacy gap exists today.
  - pharmacy.work_items.source_ehr_prescription_id has no foreign key (be:services/ehr-api/database/migrations/0023_pharmacy_domain_foundation.sql:58), and source_status is only CHECKed to equal 'active' (:61).
  - acceptPrescription inserts caller-supplied medication fields with the literal 'active' (be:services/pharmacy-api/src/pharmacy/pharmacy.service.ts:130).
  - The current validator's local path checks only actor, facility, the 'active' literal and live routes (be:services/ehr-api/database/migrations/0086_provider_self_service_onboarding.sql:9424-9488).
  - So an invented or imported id can become dispensable work. A and B are right; C is wrong.
- V2. The TIFF gap. Upload accepts image/tiff (web:apps/patient-web/src/ehr-blue/departments/migrate/DocumentCapture.tsx:203), but the worker refuses anything except PNG and JPEG (be:services/ocr-worker/src/textract.provider.ts:69-70).
- V3. Chat generation calls https://api.anthropic.com with inference_geo 'us' (be:services/ehr-api/src/ehr/patient-records/claude-ai.service.ts:116,121), with ai_generation_provider "anthropic" and ai_allow_anthropic_us_processing true (dev:infra/terraform/environments/production.tfvars:216,218). Imported items must not become chat evidence until the DPIA covers that path.
- V4. The Bedrock precedent.
  - A bedrock-runtime interface endpoint uses an EU inference profile across eu-central-1, eu-north-1, eu-south-1, eu-south-2, eu-west-1 and eu-west-3 (dev:infra/terraform/modules/ai/main.tf:1-21).
  - It sits behind the precondition allow_eu_processing (:69).
  - Ingress is from the EHR security group only (:36).
- V5. Claude API facts (Anthropic reference):
  - first-party prices: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per million tokens. Bedrock is priced separately.
  - Structured outputs work on Bedrock. Server-side refusal fallbacks do not, so the SDK's client-side refusal middleware is used.
  - Forced tool_choice returns 400 on Opus 5.5 and Sonnet 5.5, so the design uses output_config.format.
  - Opus 5.5 thinking cannot be disabled and its effort default is medium, so effort is set explicitly.
  - Not verified: which 5.5 models each EU profile or In-Region option offers. Re-check at build.
- V6. The job already emits OcrAwaitingValidation (be:services/ehr-api/database/migrations/0013_durable_ocr_persistence.sql:230). awaiting_validation → validated/rejected is final (0077:236).
- V7. No AWS AI-services opt-out policy appears in dev infra (grep found nothing). It may exist at the organisation level; verify it.

ARCHITECTURE (pipeline)
P0. Gates
- The virus scanner is live; documents become 'available' only after a clean scan (be:services/ehr-api/src/documents/document.service.ts:143).
- Stage 1 (0100) is live (rp-be:services/ehr-api/database/migrations/0100_records_processing_purpose.sql:5-13).
- Documents-bucket CORS is in place for the page viewer.
- The DPIA is signed before the first real document. Until then, test with fictional documents in the sealed demo tenant (0098).

P1. Upload
- Add an optional document-type hint: discharge summary, outpatient card, prescription, lab report, adult immunisation card.
- Route image/tiff to async analysis (fixes V2).

P2. Job
- Unchanged (be:services/ocr-api/src/ocr/ocr.service.ts:106-190).
- New processing contract 'hid-textract-v2'. The reuse rule (ocr.service.ts:149-169) then never hands a text-only v1 extraction to structuring.

P3. Textract v2 (ocr-worker)
- Calls:
  - images: AnalyzeDocument;
  - PDF and TIFF: StartDocumentAnalysis / GetDocumentAnalysis.
  - Features LAYOUT+TABLES. No FORMS. QUERIES is off at first.
- Keep for each LINE: id, page, bounding box, confidence and handwriting flag. Keep TABLE/CELL grids. Today only joined line text survives (textract.provider.ts:111-123).
- Write lines and tables through a security-definer function. The worker has no table privileges (be:services/ocr-worker/src/repository.ts:64-82 pattern).
- Store the full block JSON in S3 under KMS with a 90-day lifecycle.
- IAM adds StartDocumentAnalysis and GetDocumentAnalysis (dev:infra/terraform/modules/application/iam.tf:42-70).

P4. Enqueue
- When the job reaches awaiting_validation, the redefined completion function inserts ocr.structuring_runs 'queued' in the same transaction, if:
  - the OCR_STRUCTURING flag is on;
  - the purpose is healthcare-operations;
  - the patient's records-processing grant is live;
  - the patient is 18 or over by HID date of birth (Africa/Lagos rule from 0100).
- There is no new job state; the transition table at 0077:236 is untouched.
- If structuring fails or is refused, the reviewer falls back to manual entry on the same screens.

P5. Structurer (new ocr-structurer ECS service, its own task role and security group)
- Infra: added to the Bedrock endpoint policy and ingress (main.tf:33-63) behind a new precondition flag, ocr_structuring_allow_eu_processing, default false, copying :69.
- Input: numbered lines plus table grids with cell ids. Eleven-digit NIN-like numbers and +234 phone numbers are masked first. No HID identifiers and no chart data are sent.
- Request:
  - model and region per the owner's decision, through the EU inference profile;
  - output_config.format json_schema (flat, enums, additionalProperties false);
  - no tools; explicit effort; streaming; max_tokens about 16k;
  - a cached, frozen system prompt and schema.
- Rules in the prompt: extract only what is written; cite ids for every item; never infer current use; text is data.
- On a refusal or max_tokens stop: retry once on a second approved model through the SDK's client-side refusal middleware, then mark the run failed_model and fall back to manual.
- Logs hold only ids, hashes, token usage and the stop reason, never text.

P6. Deterministic post-processing (in the structurer)
1. Parse with Zod.
2. Grounding: cited ids must exist; atomic values must fuzzy-match the cited text; numbers, units and dates must match exactly. Otherwise the item is flagged red, never dropped silently.
3. Normalise: dd/mm default with an ambiguity flag, FHIR partial dates, sig abbreviations (od, bd, tds, qds, nocte, stat, prn, x5/7), and UCUM units.
4. Codes are suggested only from the local terminology tables.
5. Identity comparison: printed name, date of birth or age, sex and folder number vs HID.
6. Flags: possible minor; more than one patient; order-like wording; implausible values; negated, family-history, hypothetical or future items (defaulted to reject).
7. Render through the shared @hid/fhir-mapper and validate in-process against the HID profiles (the HL7 validator runs in CI on fixtures and a sample, so there is no production Java sidecar).
8. Write ocr.item_candidates and mark the run 'ready'.
- Item kinds: document_header, patient_identity, source_visit, note (the full cleaned transcription is always emitted), condition, medication (form prescription|statement), allergy, lab_report, lab_result, vital, procedure, immunization, unclassified.

P7. Item review
- Purpose healthcare-operations, as the DTO requires (be:services/ocr-api/src/ocr/dto/validate-ocr-job.dto.ts:37-38). Done by holders of ocr.validation.write: doctor, clinician, nurse, and lab staff for lab items only (be:services/ehr-api/database/migrations/0013_durable_ocr_persistence.sql:13,18-21).
- For each item: accept, edit, reject with a reason, add from a region drawn on the page, or move to another section. Drafts save server-side.
- Submit writes one ocr.validations row (target_domain 'RECORD_SET', candidate_type 'record_set') plus ocr.validation_items.
- Each item passes its kind's candidate check now and again at publish (the assertPublishableCandidate pattern, be:services/ocr-api/src/ocr/ocr-publication-policy.ts:111-120).

P8. Source-patient confirmation
- The existing step (ocr.service.ts:346-400), now showing the identity comparison.
- A conflict on both name and date of birth blocks confirmation. One conflict needs a written reason, plus a second clinician if the owner decides so.

P9. Publish
- Purpose direct-care, permission ocr.publication.write (doctor, clinician, nurse).
- Preview: reconciliation against native chart rows, earlier imports and the patient-reported profile. This is possible only here, because healthcare-operations is refused on the chart (rp-be:services/ehr-api/src/ehr/shared/clinical-context.ts:15-30).
- The publisher excludes items with a reason and attests.
- Still one ocr.publications row per validation (ocr.service.ts:431-435), with N ocr.publication_items.
- ehr-api writes, in one transaction through ehr.publish_imported_record_set(), the ehr.imported_record_sets row and every EHR item.
- lab-api writes the lab imports with record_set_id.
- Idempotency key per item: ocr-publication:{pubId}:{candidateId}. A failed item can be retried on its own.
- Re-checked at publish: age, identity binding (ocr.service.ts:449) and the non-active medication status set.
- Outbox: OcrPublicationSucceeded, plus a new ImportedRecordSetPublished that drives the patient inbox.

P10. Reads
- ehr-api per-patient lists by kind, under direct-care or emergency only.
- lab-api list by patient. Today imports can only be read by id (be:services/lab-api/src/lab/lab-imports.controller.ts:30).
- Patient self-read bound to the live session.
- Provenance read.

P11. Corrections
- Per-item entered-in-error, for holders of ehr.import.correct.
- Whole record set "wrong patient" in one transaction (the 0088 idea).
- The patient's "Something wrong / This isn't mine" opens a facility task.

P12. Stage 3
- FHIR R4 read facade and export, the patient's IPS download, and integration.fhir_patient_mapping (be:docs/DATABASE.md:996-1011).

DATA MODEL
Migration numbers are assigned at build time, after 0100, 0101 and any other in-flight migrations. Each ships with grants, RLS, suites, the ledger, the manifest and a PG16 proof as pgrun.
- M-pharm (can ship first, independent of OCR): pharmacy.validate_work_item's local path must find an ehr.prescriptions row matching id, version, patient and ordering facility, with status 'active'. The suite includes a negative test with an imported or invented id.
- M1 ocr:
  - new tables extraction_lines, extraction_tables, extraction_artifacts, structuring_runs, item_candidates, validation_items, review_drafts (delete_after) and publication_items;
  - widen the ocr.validations CHECKs (0016:21-28) and restate the full ocr.publications.target_operation set (last rewritten at 0023:43-50), adding 'publish_imported_record_set';
  - redefine the completion function to enqueue structuring.
- M2 terminology (described at be:docs/DATABASE.md:411, never built):
  - code_systems (uri, version, licence text, exportable), concepts, designations, concept_maps, system_aliases ('loinc' → http://loinc.org), formulary and value_sets;
  - loaded by a versioned data job.
- M3 ehr:
  - imported_record_sets: patient, publishing facility, source document id + version + sha256, job, extraction, run, validation version, patient confirmation, reviewer and purpose, publisher and purpose, status, wrong-patient reason;
  - item tables imported_source_visits, imported_notes, imported_conditions, imported_medications and imported_allergies;
  - imported_vital_observations: one row per measurement, fixed LOINC set, plausibility CHECKs mirroring 0004:124-131;
  - imported_procedures and imported_immunizations (2c);
  - imported_record_feedback.
  - Common columns on every item table: record_set_id (composite foreign key with patient), source_item_id, review_decision, item_confidence, source_spans, verbatim_text, the partial-date triple (date, precision, text as written), the code quartet (system URI checked against terminology, code, display, text not null), status including entered_in_error, and row_version.
  - No encounter foreign key. This keeps the "no fabricated encounter" rule (be:services/ehr-api/database/migrations/0061_imported_medical_records.sql:1).
  - imported_medications status CHECK: unknown, completed, stopped, not_taken or entered_in_error.
  - Inserts only through the publish function. An immutability trigger allows only the change to entered_in_error.
  - RLS like native records. hid_pharmacy_api_runtime and hid_lab_api_runtime get no grants, and a suite proves it.
  - Unique on publication_item_id. A hard-stop unique key on (patient_id, source_sha256, item_fingerprint).
- M4 lab: lab.imported_evidence and lab.imported_observations gain code_system (today there is test_code with no system, 0017:70), UCUM unit, value_type, interpretation_code, reference_low and reference_high, record_set_id and source_item_id, an index on (patient_id, reported_at), and a route for the existing entered_in_error status.
- M5 permissions: ehr.import.read and ehr.import.correct.
- M6 (Stage 3): integration.fhir_patient_mapping and the export audit.
- Old paths: create_imported_clinical_note, lab evidence and medication evidence are retired for new validations after a zero-row check. Production OCR has never been able to run, because of the scanner (V1 context). pharmacy.imported_medication_evidence becomes read-only.

FHIR R4 (HID implementation guide)
Written in FSH and built with SUSHI on IPS 1.1, validated in CI.

Common to every resource:
- meta.tag record-origin#paper-import;
- subject through the audience-scoped Patient mapping, never the NIN;
- source facility and clinician as contained resources or display only.

By resource:
- DocumentReference for the scan: a LOINC document type, and an hid-sha256 extension because R4 Attachment.hash is SHA-1.
- DocumentReference for an imported note: relatesTo 'transforms' the scan. It is not Composition and not ClinicalImpression.
- Encounter (imported source visit): class from ActCode.
- Condition:
  - verificationStatus from the paper's wording: confirmed, provisional ("?"), differential ("r/o"), unconfirmed or refuted;
  - clinicalStatus left out when the paper does not say and the category is encounter-diagnosis, and required for problem-list-item (con-3), with no automatic "resolved";
  - category encounter-diagnosis or problem-list-item.
- MedicationStatement, the default for both paper prescriptions and drug histories:
  - status unknown, completed, stopped, not-taken or entered-in-error;
  - informationSource is the source prescriber or facility; dateAsserted; derivedFrom the scan; reasonReference to the Condition;
  - dosage.text verbatim, plus timing codes and UCUM;
  - an HID extension records "written as a prescription by X on date Y".
  - No MedicationRequest is exported in Stage 2.
- AllergyIntolerance: verification defaults to unconfirmed. NKDA uses the IPS absent-unknown codes.
- DiagnosticReport and Observation for labs:
  - interpretation normal→N, low→L, high→H, abnormal→A, critical→HH or LL by direction (else AA);
  - issued only when an exact time is printed.
- Vitals follow the core vitalsigns profiles and need a full date (vs-1).
- Procedure, and Immunization with primarySource false and reportOrigin 'record'.
- Provenance, one per record set:
  - verifier = reviewer, attester = publisher, assembler = a Device carrying the Textract contract, model id, prompt version and schema version;
  - reason HOPERAT plus TREAT;
  - per-item page and box extensions.

CODING
- The verbatim text is always kept. Codes are optional and confirmed by the reviewer.
- Conditions: WHO ICD-10 primary if the commercial licence check passes, with ICD-11 MMS (free) as the second code or the fallback. No ICD-10-CM.
- Labs, vitals and document types: a curated LOINC subset plus a Nigerian lab-name map (MP, mRDT, Widal, PCV, FBC, E/U/Cr, LFT, RVS, HBsAg, genotype) curated by a clinician and a lab scientist. Units in UCUM.
- Medicines: an HID formulary seeded from the Nigeria Essential Medicines List, plus ATC (licence check), plus the NAFDAC number when it is printed. RxNorm is optional.
- Vaccines: CVX plus the national immunisation programme (NPI) vaccine list.
- SNOMED is deferred.
- The licence register's 'exportable' flag gates every export.

REVIEW UX (Lekan; replaces the JSON boxes at web:apps/patient-web/src/ehr-blue/departments/migrate/ocrSteps.tsx:120-137 and web:apps/patient-web/src/staff/routes/Operations.tsx:1174-1186)
- Split view:
  - left: the page image with the cited line boxes highlighted, thumbnails and zoom;
  - right: section tabs in this order: Patient & document, Conditions, Prescriptions, Medication history, Allergies, Lab results, Vitals, Procedures, Immunisations, Notes, Not classified.
- Item cards: an editable form, the verbatim quote with "Show on page", a confidence chip with reasons (text, not colour alone), code pickers, and a partial-date input.
- Prescription statuses offer only Unknown, Completed and Stopped, with the copy "filed as history, not an order".
- Rules:
  - no bulk accept for medicines, allergies or lab values;
  - a red item needs an edit or a ticked "checked against image";
  - every item needs a decision before Submit.
- Keyboard shortcuts j/k and a/e/r.
- Publish screen: section counts, reconciliation hints with "Skip" or "File anyway", exclusions, attestation, and per-item results with retry.
- States: structuring pending, failed, refused; grant expired.

RECORD VIEWS
- One origin vocabulary: "Recorded here", "Paper record", "Reported by patient", "From hid-1.0".
- Every imported row is read-only and shows:
  - a badge, the source facility and the date as written;
  - "Checked by / filed by";
  - "View source", which opens the page with the item highlighted;
  - "Mark entered in error" for holders of ehr.import.correct.
- Classic chart (web:apps/patient-web/src/staff/routes/Clinical.tsx:25-31): "From paper records" groups in Notes, Diagnoses, Prescriptions (banner: "history, not active, cannot be dispensed"), Lab and Vitals. Imported vitals are left out of trends by default. New tabs: Paper records, Allergies, Procedures, Immunisations.
- Blue chart:
  - the PatientPage allergy line gains "(paper record, unverified)" (web:apps/patient-web/src/ehr-blue/clinical/patients/PatientPage.tsx:49-98);
  - a TodaySections card;
  - imported allergies appear in the prescribing-form warnings (NewConsultation.tsx:204, orders/CreateOrder.tsx:150).
- Patient portal: a "From your paper records" section grouped by document, plus a notification and "Tell us". The hid-1.0 block stays separately labelled.

SAFETY CONTROLS
- S1. No path from an import to dispensing:
  - separate tables;
  - a status CHECK;
  - no pharmacy or lab grants;
  - M-pharm;
  - no order actions in the UI;
  - MedicationStatement-only export;
  - tests at the database, API and UI levels.
- S2. Duplicates:
  - job reuse by version and SHA;
  - one publication per validation;
  - the fingerprint hard-stop;
  - soft reconciliation at publish;
  - nothing is ever merged automatically.
- S3. Wrong patient:
  - the Stage 1 per-patient grant;
  - job patient = source patient (ocr.service.ts:138-140);
  - the identity comparison block;
  - the latest confirmation is bound at publish;
  - whole-set withdrawal.
- S4. Minors are refused at Stage 1, at enqueue and at publish.
- S5. Purposes stay split: healthcare-operations for review, direct-care for publish. Both are recorded.
- S6. Model risk: grounding; codes only from terminology; a gold-set eval gates every change of model or prompt; a 5% second review; per-reviewer accept-unchanged and time metrics.
- S7. A clinical safety officer and a hazard log.

PRIVACY / NDPA
- All processing stays in AWS: S3, KMS, Textract eu-west-1 and RDS eu-west-1, plus Bedrock under the chosen profile.
- Bedrock model invocation logging is off, or goes to a KMS bucket in eu-west-1.
- Attach the AWS Organizations AI-services opt-out policy (V7).
- Imported items are kept out of chat evidence until the DPIA covers the US chat path (V3).
- DPIA lines to add:
  - the new derived data: candidates, decisions and run metadata;
  - the EU regions and abuse-detection storage;
  - minimisation and masking;
  - human decision on every item (no solely automated decision);
  - retention: candidates, raw model output and Textract JSON 90 days after the job is final; lines kept with the document; published items under medical-record retention;
  - data subject rights through the portal and "Tell us";
  - the updated notice wording on the Stage 1 approval card;
  - NDPC registration;
  - DPO sign-off.

PHASES
- Stage 2.0, prerequisites (weeks 0-2, in parallel):
  - scanner and 0100 live;
  - owner decisions taken;
  - Bedrock access and quotas;
  - a gold set of about 200 fictional or consented documents labelled by clinicians;
  - DPIA draft;
  - IG skeleton;
  - M-pharm shipped.
- Stage 2a, first slice (about 7 weeks): prescription, note, condition, source document and visit.
  - Backend: Textract v2, the structurer, M1, a minimal M2 (ICD, aliases, formulary of about 300 items), M3 for these kinds, and correction plus whole-set withdrawal from day one.
  - Website: review and publish workspace; chart groups for Prescriptions, Diagnoses and Notes; the Paper records tab. The patient portal stays behind a flag.
  - Exit gate, on the demo tenant:
    - medicine name, strength and dose precision at least 95% before review, and 99% after review;
    - under 1% of accepted items ungrounded;
    - zero active statuses;
    - zero wrong-patient filings in UAT;
    - refusal rate measured;
    - DPIA signed.
- Stage 2b (about 5 weeks):
  - labs (M4, LOINC map, list route, Lab panel), vitals, allergies with warnings;
  - full reconciliation;
  - patient portal, notification and "Tell us";
  - retire the old targets;
  - pilot at one facility.
- Stage 2c (about 4 weeks):
  - procedures and adult immunisations;
  - vision fallback for low-confidence pages, if approved;
  - quality dashboards;
  - ramp to 5,000 documents a month.
- Stage 3 (about 4 weeks): FHIR facade and export, the patient's IPS download, and the patient mapping.

TEAM AND EFFORT (about 150 person-days)
- Coordinator (backend and infra, about 80 days, the critical path): migrations; worker v2; structurer, eval harness and mapper/IG; ocr-api items; ehr-api imported module; lab-api; Terraform (structurer role, endpoint policy, flag, Textract analysis IAM, S3 lifecycle); DPIA annex.
- Lekan (about 22 days): review workspace, viewer, publish screen, document-type hint, TIFF.
- Ola (about 17 days): staff chart groups and tabs in classic and blue, warnings, correction dialogs, clinical copy review.
- Rahman (about 10 days): shared badge, source link and provenance drawer, portal sections, notices, flags, the contracts registry, Stage 3 download.
- Curation (about 10 days), DPIA and legal (about 5), pilot QA (about 8).

COST (pilot volume: 5,000 documents a month x 3 pages; US list prices, confirm for eu-west-1 and Bedrock)
- Textract LAYOUT+TABLES: about $225 a month.
- Model:
  - Opus 5.5 about $490-630;
  - Sonnet 5.5 about $250-320;
  - Haiku 5.5 about $15.
- Compute and storage: about $30.
- Total: about $550-900 a month (about $7-11k a year), against about $3,400 for Approach A.
- People cost dominates: about 330-670 reviewer hours plus 80-170 clinician publish hours a month.
- One-off: 25-40 clinician hours for the gold set; possible WHO ICD-10 and ATC licence fees.

TOP RISKS
- Reviewer rubber-stamping.
- Handwriting recall.
- Model refusals (Opus 5.5 'bio' classifier).
- EU multi-region residency.
- Licensing.
- Prerequisites slipping.
- Classic and blue doubling the chart work.
- Reviewer capacity.

## Owner decisions

1. **What should 'FHIR standard' mean for HID?**
   - Options: (a) Typed HID tables that map 1:1 to FHIR R4, with a FHIR export layer (follows ADR-022). (b) Store FHIR JSON as the record for imported history (needs a new ADR-036 plus CODEX changes). (c) A managed FHIR store such as AWS HealthLake.
   - Recommendation: (a). It meets the request, keeps one model per clinical concept, and needs no ADR change. HealthLake could later be an export or analytics copy only.
2. **Which engine should turn the scanned text into items?**
   - Options: (a) Claude on Amazon Bedrock with code-based checks of every item. (b) Amazon Comprehend Medical plus a Nigerian rules layer. (c) Rules only, with the reviewer typing most items.
   - Recommendation: (a). It is better on Nigerian abbreviations, brands and section meaning, and about $3k a month cheaper than (b). Keep (c) as the fallback whenever the model fails or is switched off.
3. **Where may the AI processing happen?**
   - Options: (a) The Bedrock EU profile, which can run in 6 EU regions; chat AI already uses this pattern. (b) Ireland only, which limits the choice to whatever model Bedrock offers In-Region there. (c) The direct Claude API in the US, as chat generation uses today.
   - Recommendation: (a), behind a new approval switch that is off by default and recorded in the DPIA. Re-check model availability before the build. Do not use (c).
4. **Which Claude model?**
   - Options: Opus 5.5 (about $490-630 a month), Sonnet 5.5 (about $250-320) or Haiku 5.5 (about $15) at pilot volume, chosen after a test on about 200 labelled documents.
   - Recommendation: Test Opus 5.5 and Sonnet 5.5. Pick the cheaper one if it passes the accuracy gate, otherwise Opus 5.5. Approve the pass thresholds: at least 99% medicine accuracy after review, under 1% ungrounded items, and the refusal rate measured.
5. **May page images, not just the extracted text, be sent to the model?**
   - Options: (a) Text only. (b) Images only for low-confidence or handwritten pages. (c) Always.
   - Recommendation: (a) for the first slice. Consider (b) in Stage 2c if the test shows handwriting losses; it costs about $50-100 more a month.
6. **Which Textract features should be paid for?**
   - Options: (a) Text detection only (about $22 a month). (b) LAYOUT+TABLES (about $225 a month). (c) Also FORMS and QUERIES (adds about $975 a month).
   - Recommendation: (b). It keeps lab-report tables intact for little money.
7. **How should a prescription seen on paper be filed in FHIR terms?**
   - Options: (a) MedicationStatement (history), with 'written as a prescription by X on date Y' kept. (b) MedicationRequest with intent 'order' and reported=true. (c) Both.
   - Recommendation: (a). It still appears under 'Prescriptions → From paper records (history, not active)'. It is the safest choice because no outside system will treat it as an order.
8. **Which medicine statuses are allowed on imports?**
   - Options: (a) Unknown, completed, stopped, not taken only. (b) Also 'active', meaning the patient says they still take it.
   - Recommendation: (a) in Stage 2. Current therapy belongs in a native record a clinician creates.
9. **Who owns imported medicines?**
   - Options: (a) EHR (new imported-medications table; Pharmacy never sees them). (b) Pharmacy (extend today's imported medication evidence).
   - Recommendation: (a). Retire the Pharmacy OCR target for new publishes.
10. **Should we close the existing Pharmacy gap now?**
   - Options: (a) Yes: Pharmacy may accept only a real, active EHR prescription for the same patient, facility and version. (b) Later, with OCR.
   - Recommendation: (a), and ship it first. Today Pharmacy accepts caller-supplied prescription details with no check that an active prescription exists. This is a risk now, OCR or not.
11. **How should visits from other hospitals be recorded?**
   - Options: (a) An 'imported source visit' record, never a real HID encounter. (b) Require an existing local encounter, as today's note import does. (c) Create real encounters of a new type.
   - Recommendation: (a). It keeps the 'no fabricated encounter' rule.
12. **How should imported notes work?**
   - Options: (a) Final imported note, visible once published. (b) Today's draft note, which needs a local encounter and an HID clinician's signature.
   - Recommendation: (a). Keep (b) only as an optional 'bring this into today's visit'.
13. **Which code systems should be used?**
   - Options: Conditions: WHO ICD-10, ICD-11, or both. SNOMED: defer, or buy an affiliate licence. Medicines: an HID formulary from the Nigeria Essential Medicines List plus ATC, with NAFDAC numbers and RxNorm optional. Labs: LOINC with a Nigerian lab-name map. Vaccines: CVX plus the national programme list.
   - Recommendation: ICD-10 (WHO) primary if the licence check passes, with ICD-11 as the second code or fallback. Defer SNOMED. Use formulary plus ATC (check the ATC licence). Use LOINC, UCUM and CVX. Name a clinician and a lab scientist to curate the maps.
14. **Who reviews and who publishes, and when must two people agree?**
   - Options: Reviewers: doctors, clinicians and nurses, with lab staff on lab items only. Publishers: doctors, clinicians and nurses with care access. Two people required: (a) never, (b) only for identity-mismatch overrides, (c) also for medicines and allergies.
   - Recommendation: (b), plus a random 5% second-review audit. Watch the pilot data before adding more.
15. **Confidence thresholds and bulk acceptance?**
   - Options: Thresholds: green at 0.95 or above, amber 0.80-0.95, red below 0.80. Bulk accept: never, or only for high-confidence notes and visits.
   - Recommendation: Use those thresholds at first. Never bulk-accept medicines, allergies or lab values. A red item needs an edit or a ticked 'checked against the image'.
16. **When and how do patients see imported items?**
   - Options: (a) Straight after publishing, labelled 'from a paper record'. (b) Only after a separate clinician release. Also: a per-item 'withhold from patient view' option for sensitive results (HIV, mental health)? Can patients open the scanned original? Send a notification?
   - Recommendation: (a), plus a withhold option with a reason for sensitive categories, a notification with no clinical detail, and a 'Tell us / This isn't mine' link. Patients can open the original in Stage 2b, which needs a new read route.
17. **Should unverified imported allergies appear in prescribing warnings?**
   - Options: Yes, labelled 'paper record, unverified'; or no.
   - Recommendation: Yes. Missing an allergy is the more dangerous error.
18. **May imported items feed the patient chat assistant?**
   - Options: (a) No, until the DPIA covers chat's US processing. (b) Yes, labelled.
   - Recommendation: (a). Chat generation currently runs on the Claude API in the US.
19. **How long is the working data kept?**
   - Options: Candidates, rejected content, raw model output and Textract JSON: 30, 90 or 180 days after the job is final. OCR lines: kept with the document. Published items: medical-record retention.
   - Recommendation: 90 days for the working data. Keep lines with the document. Never log patient text.
20. **NDPA sign-offs?**
   - Options: Approve the DPIA lines, the record of processing, the transfer basis (Nigeria → EU), the patient notice wording and the AWS AI-services opt-out policy. Confirm NDPC registration. Name a DPO.
   - Recommendation: Do all of these before the first real document. Until then, test only with fictional documents on the demo tenant.
21. **What about patients under 18?**
   - Options: (a) Keep refusing, which means no childhood immunisation cards. (b) Commission a guardian-approval design.
   - Recommendation: (a) for Stage 2. Revisit (b) as a separate project.
22. **Who can correct imported items?**
   - Options: Entered in error per item, and 'wrong patient' for a whole document. Granted to: doctors and clinicians, or also nurses. Also: allow 'amend' (a new version)?
   - Recommendation: Doctors and clinicians only. Entered in error only in Stage 2, no amend. The facility is notified of every wrong-patient withdrawal.
23. **Should a clinician be able to 'prescribe again' from an imported medicine?**
   - Options: (a) Not in Stage 2. (b) A button that opens a blank native prescription, prefilled, which the clinician completes and signs.
   - Recommendation: (a) now. (b) is acceptable later because it creates a new order and never converts the import.
24. **Retire today's single-target OCR publishing and the JSON review boxes?**
   - Options: Yes, after a zero-row check; or keep both paths.
   - Recommendation: Yes, once item-level review ships. Production has never been able to run OCR, so nothing depends on them.
25. **Pilot scope, safety ownership and budget?**
   - Options: Which facility after the demo tenant. Which document types first (outpatient cards, discharge summaries, prescriptions, lab reports). Who is the clinical safety officer. A reviewer staffing of about 2-4 people. A cloud budget of about $550-900 a month.
   - Recommendation: Demo tenant, then one facility. Start with outpatient cards, prescriptions and discharge summaries, adding lab reports in Stage 2b. Name a clinical safety officer now. Approve the budget and staffing for the pilot.
26. **What is the FHIR web address base and the export plan?**
   - Options: Choose the canonical URL base for HID's FHIR profiles. Export scope: the patient's own download, referrals, partner API.
   - Recommendation: Pick a stable HID-owned URL base now (it is only an identifier). Stage 3: the patient download and staff export. A partner API later, under patients' sharing grants.