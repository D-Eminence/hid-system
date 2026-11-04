# AI and OCR data flows: inventory for the DPIA (read from code, 4 Nov 2026)

Scope: `services/ehr-api` on branch `claude/ecstatic-ramanujan-q4i1eo-patient-chat-safety-2` (f11c9ec9), and `services/ocr-worker` on `origin/claude/ecstatic-ramanujan-q4i1eo-ocr-ai-reading` (d12ab97c, not merged; read with `git show`). Paths into `services/ehr-api` are given relative to `services/ehr-api/src/ehr/patient-records/` unless they say otherwise. Anything marked "(branch)" comes from the unmerged OCR branch. 

Six paths send data out:
- **A–B:** patient chat and staff chat ("Ask about this patient") send to Anthropic.
- **C–D:** the same two chats send text to AWS Bedrock for embeddings.
- **E:** both chats send documents to AWS Textract.
- **F:** the OCR worker sends documents to Textract and then sends the text it reads to Anthropic.

The code contains no other calls to Anthropic, Bedrock or Textract in `ehr-api` or `ocr-worker`. A search found three hits outside that scope, which are not covered here:
- `apps/web/src/pages/admin/AdminAiProcessing.tsx:41`, a provider setting screen in the HID Migrate admin UI.
- `services/ocr-api`, which only creates the jobs that path F processes.
- `OCR_AI_FACILITY_IDS` in `ocr-api`, mentioned in the branch's `.env.example`. The code that reads it is not on either branch.

---

## A. Patient chat → Anthropic Claude API (ehr-api)

**Trigger and who triggers it**
- A patient, signed in to their own record, calls `POST ehr/me/chat` (`patient-records.controller.ts:38-43`).
- The service checks `AI_ENABLED` first (`patient-chat.service.ts:44`).
- Each question makes one or two Claude calls:
  - a "plan" call (`patient-chat.service.ts:71`);
  - an "answer" call, only when the plan says records are needed (`patient-chat.service.ts:151`).
- Limits are held per process: 10 questions per patient per 5 minutes, 50 overall, 4 at once (`patient-chat.service.ts:122-136`).

**Endpoint and model**
- The request goes to a fixed URL with raw `fetch`: `https://api.anthropic.com/v1/messages`, with `redirect:'error'` and no retries (`claude-ai.service.ts:138-145`).
- Headers are only `Content-Type`, `anthropic-version: 2023-06-01` and `x-api-key` (`claude-ai.service.ts:140-141`).
- Model: `AI_GENERATION_MODEL_ID`, default `claude-sonnet-4-6` (`config/environment.ts:68`). It must match `^claude-` (`config/environment.ts:115`).
- `max_tokens: 1200`. A JSON-schema `output_config` is sent when a schema applies (`claude-ai.service.ts:142-144`).
- Timeout: `AI_REQUEST_TIMEOUT_MS`, default 20 s (`config/environment.ts:72`, `claude-ai.service.ts:135`).

**Region**
- `inference_geo: 'us'` is hard-coded in the request body (`claude-ai.service.ts:143`). No config key can change it.
- The flag `ANTHROPIC_PROCESSING_APPROVED` must be true or startup fails ("requires approved US processing", `config/environment.ts:70,119-120`), and each call also checks it (`claude-ai.service.ts:132-134`).

**What is sent**
- **System prompt:** fixed text only. It holds the assistant's purpose and limits (`claude-ai.service.ts:21-34`), the patient-audience rules (`claude-ai.service.ts:36-40`) and per-step instructions (`claude-ai.service.ts:58-67`, `97-115`). It contains no patient data.
- **Messages:**
  - up to 4 earlier exchanges from saved history, each question ≤500 characters and each answer ≤4000 (`claude-ai.service.ts:49-55`, `patient-chat-history.service.ts:159`);
  - the current question, ≤500 characters (`patient-chat.service.ts:46,68`).
- **Answer call only:** the last user message is replaced by JSON (`claude-ai.service.ts:91-96`). It holds:
  - `question`;
  - `authorizedRecords`: up to 12 sources (`patient-chat.service.ts:226`, hard cap 60 sources and 90,000 characters at `claude-ai.service.ts:80`). Each source carries `title`, `content`, `kind`, `provenance`, `quality`, `recordedAt`, `effectiveAt` and an `origin` label (`claude-ai.service.ts:83-89`);
  - `currentDate`, encounter links, `coverage` and `labComparisons`.
- **`content`** is the canonical JSON of the record's title, dates, provenance, quality and fields (`patient-evidence.types.ts:72-81`).
- **Which records:** they come from `PATIENT_EVIDENCE_QUERY` (`patient-evidence.query.ts:15-57,90-118`), the Lab service and documents. They are then filtered by `patientEvidence()` (`patient-evidence.policy.ts:440-464`):
  - **Notes:** `noteType`, `text`, `signedAt`, only from completed visits.
  - **Encounters:** completed ones only.
  - **Diagnoses:** confirmed only, with no clinician notes.
  - **Prescriptions:** active, on hold or completed. Free-text instructions are not sent.
  - **Investigations:** sent without the clinical reason or priority.
  - **Vitals:** an explicit list of measures.
  - **Lab results:** an allow-list of fields that leaves out `correctionReason` (`patient-evidence.policy.ts:30-40`).
  - **Imported records, prior import versions and imported health profile:** fields are not allow-listed; only `_`-prefixed keys are removed (`patient-evidence.policy.ts:410,444`, `patient-evidence.query.ts:41-54`).
  - **Profile:** only `ageYears` and `sex` (`patient-evidence.policy.ts:436-439,447`).
  - **Documents and attachments:** the OCR text (from path E), with the title replaced by "Clinical document" or "Imported document" (`patient-evidence.policy.ts:454-455`).
  - **Sensitive items:** tests, conditions and medicines on the sensitive lists are dropped (`patient-evidence.policy.ts:69-272,280-295,413-434`).

**Which patient**
- Only the signed-in patient. Row-level security limits rows to that patient, and any other patient's row stops the request (`patient-evidence.service.ts:34-35`).
- Every step must authorize the same patient (`patient-chat.service.ts:52-58`).
- Other people's data can still go out inside free text: clinicians' or relatives' names in notes, imported records and OCR text.

**Identifiers and redaction**
- The function is `redactIdentifiers()` (`patient-evidence.policy.ts:358-401`). It removes:
  - emails;
  - any `HID-…` Health ID or `HID xxxx` code;
  - MRN, hospital, folder, card or file numbers after a keyword;
  - NIN or BVN after a keyword;
  - Nigerian phone numbers and `+…` international numbers;
  - any bare 11-digit number, or 4-4-3 digit groups;
  - the patient's date of birth in many formats (`patient-evidence.policy.ts:327-351`);
  - the patient's own full, first and last names, in capitalised or upper-case forms only.
- It is applied to:
  - the question and replayed history (`patient-chat.service.ts:66-69,100-106`);
  - free-text record fields: note `text`, document and attachment `text`, import `record`, `notes`, `structuredData` and `transcriptionText`, and health profile `medical_notes` (`patient-evidence.policy.ts:46-51`);
  - titles of notes and imports (`patient-evidence.policy.ts:52,457`).
- Name and date of birth are fetched only to drive this redaction (`patient-evidence.service.ts:44-61`).

**Free text that can still carry identifiers**
- Other people's names. Only the patient's own name is removed.
- The patient's name written in lower case (`patient-evidence.policy.ts:324-325`), or names that are common words ("Sunday", "Will") when they appear alone (`patient-evidence.policy.ts:322`).
- Addresses. There is no address pattern.
- Record numbers without a keyword, and phone formats that are neither Nigerian nor start with `+`.
- Fields outside the redaction list:
  - lab `textValue`;
  - import `category` and `infoType`;
  - every key of the imported health profile's `clinical_payload` except `medical_notes`;
  - encounter type and vital `source`;
  - diagnosis and medication display text, and the titles of those records.
- Model answers saved earlier are only cleaned when they are replayed (`patient-chat.service.ts:69`).

**Images:** none are sent. Only text.

**What comes back and where it is stored**
- The plan comes back as JSON (`claude-ai.service.ts:12-16,69-75`). The answer comes back as JSON blocks with citations; the response is capped at 100 KB and the answer at 4000 characters (`claude-ai.service.ts:150-168`, `118-126`).
- Saved to `ehr.patient_chat_messages`:
  - `question` (the cleaned question);
  - `reply` jsonb (answer, sources metadata, coverage);
  - `source_bindings` (ids, versions, hashes).
  - Code: `patient-chat-history.service.ts:83-84`; table: migration `0066_patient_chat_history.sql:8-20`.
- Audit rows store counts only (`patient-chat.service.ts:158-161`).

**Retention**
- Each patient keeps at most 10 messages, and nothing older than 30 days.
- Old rows are pruned only when that patient next opens or uses chat. Pruning runs inside `prune()` during `start`, `context`, `save` and `read` (`patient-chat-history.service.ts:33-37,85,98,158`).
- The patient's "clear" deletes everything (`patient-chat-history.service.ts:171-176`).
- No scheduled deletion job was found. Rows are cascade-deleted only when the patient record is deleted (`0066_patient_chat_history.sql:4`).

**Provider-side retention:** the request has no zero-data-retention or other retention header, no `metadata.user_id`, no `cache_control` and no tools (`claude-ai.service.ts:137-144`). Zero data retention, or any other Anthropic retention term, is an organisation or account setting: **not visible in code**.

---

## B. Staff chat "Ask about this patient" → Anthropic Claude API (ehr-api)

**Trigger and who triggers it**
- A staff user calls `POST ehr/patients/:patientId/chat` (`staff-patient-chat.controller.ts:19-26`).
- They need:
  - `ehr.note.read`;
  - an active membership and session;
  - a consent decision with `read_records` scope for `direct-care`;
  - no break-glass access.
  - Code: `staff-chat-scope.service.ts:31-51`.
- Limits are held per staff account and facility (`staff-chat-scope.service.ts:54`).

**Endpoint, model and region:** the same code as path A (`claude-ai.service.ts:129-169`): same URL, `AI_GENERATION_MODEL_ID`, and the hard-coded `inference_geo:'us'`.

**What is sent**
- The same structure as path A, with the staff rules (`claude-ai.service.ts:42-44`).
- **No patient-chat policy and no redaction:**
  - the question and history are sent as typed (`patient-chat.service.ts:101`);
  - records come from `STAFF_EVIDENCE_QUERY`, which keeps clinician diagnosis `notes`, prescription `instructions`, the lab-request `information` (clinical reason) and `priority`, and cancelled or refuted items (`patient-evidence.query.ts:29,32,35,75-97`);
  - vitals carry every column except system ones (`patient-evidence.query.ts:39`);
  - lab fields include `correctionReason` (`services/lab-api/src/lab/patient-results.service.ts:17`);
  - documents and attachments of any classification from completed visits are included, and the title is the **original file name** (`patient-attachment-text.service.ts:47-50,96`).
- With `identity.patient.read` (`staff-chat-scope.service.ts:17`), a profile record with `firstName`, `lastName`, `fullName`, `dateOfBirth` and `gender` is added (`staff-evidence.service.ts:120-126`) and can be selected as a source.
- Which record kinds are included follows the staff member's permissions (`staff-evidence.service.ts:98`, `staff-chat-scope.service.ts:12-18`).

**Which patient**
- Only the one patient whose record is open:
  - row-level security plus the `$1` filter (`staff-evidence.service.ts:103-105`);
  - a database client wrapper that refuses any row for another patient (`staff-evidence.service.ts:25-43`);
  - a per-transaction `app.chat_patient_id` setting (`staff-chat-scope.service.ts:61-64`).
- Identifiers are **not redacted**. Name, date of birth, any Health ID, phone, NIN or folder number written in notes, imports or OCR text, and the names of third parties, can all be sent.

**Images:** none are sent.

**What comes back and where it is stored**
- Saved to `ehr.staff_chat_messages`: `question` as typed, `reply`, `source_bindings`, `permission_hash`, and the facility, account and membership ids (`staff-chat-history.service.ts:54-55`; migration `0070_staff_patient_chat.sql:28-34`).
- Row-level security limits rows to the same patient, facility, account and membership (`0070_staff_patient_chat.sql:2-12`).

**Retention**
- 30 days, last 10 messages, pruned only when the same staff user next uses chat for that patient (`staff-chat-history.service.ts:96-100`).
- The staff "clear" deletes them (`staff-chat-history.service.ts:69-75`).
- There is no scheduled job. Rows are cascade-deleted when the patient is deleted (`0070_staff_patient_chat.sql:34`).

**Provider-side retention:** same as path A. No headers are set; account-level terms are **not visible in code**.

---

## C. Patient chat → AWS Bedrock embeddings (ehr-api)

**Trigger:** inside path A, when the plan picks `recordIntent = 'search'` and the patient has records (`patient-chat.service.ts:147`).

**Endpoint, model and region**
- `BedrockRuntimeClient({ maxAttempts: 1 })` with **no region in code** (`bedrock-ai.service.ts:8`). The region and credentials come from the AWS SDK default chain (for example the `AWS_REGION` environment variable). There is no HID config key for it, and `S3_REGION` is not used here.
- Model: `AI_EMBEDDING_MODEL_ID`, default `amazon.titan-embed-text-v2:0` (`config/environment.ts:71`). That is an in-region model id; whether a cross-region inference profile is configured instead is a deployment value, not visible in code.
- The call is `InvokeModel` with a body of `{inputText, dimensions:1024, normalize:true}` (`bedrock-ai.service.ts:13-18`). Input is capped at 6500 characters (`bedrock-ai.service.ts:12`).

**What is sent**
- Up to 4 new record chunks per question, each up to 2800 characters of the cleaned record `content` (`patient-chat.service.ts:188-190`, `patient-evidence.types.ts:88-92`).
- The cleaned question (`patient-chat.service.ts:206`).
- The profile record (age and sex) is never embedded (`patient-chat.service.ts:177-179`).
- The records are the same cleaned ones as in path A, with the same redaction and the same remaining risks.
- One patient only (`patient-chat.service.ts:180-186`). No images.

**What comes back and where it is stored**
- A 1024-number vector (`bedrock-ai.service.ts:19-27`).
- Saved to `ehr.patient_evidence_chunks` (`embedding vector(1024)`, plus `patient_id`, `source_kind`, `source_id`, version, hash, `chunk_no`, `model_id`) with **no text** (`patient-chat.service.ts:195-198`; migration `0067_patient_chat_evidence.sql:27-37`).

**Retention**
- Vectors that no longer match the current cleaned records are deleted on every patient search (`patient-chat.service.ts:205,241-251`).
- Otherwise they are kept until the patient record is deleted (cascade, `0067_patient_chat_evidence.sql:28`).
- There is no age limit and no scheduled job.

**Provider-side retention:** no options are set. Bedrock model-invocation logging and data handling are AWS account settings: **not visible in code**.

---

## D. Staff chat → AWS Bedrock embeddings (ehr-api)

**Trigger:** inside path B, on a search-type question.

**Endpoint, model and region:** the same client and model key as path C (`bedrock-ai.service.ts:8-18`). The region is not set in code.

**What is sent**
- Up to 4 chunks per question from the **unredacted** staff records, including the profile record (name and date of birth), because staff records are not filtered (`patient-chat.service.ts:179`).
- The staff question as typed (`patient-chat.service.ts:206`).
- One patient only. No images.

**What is stored:** vectors only, in `ehr.staff_evidence_chunks`, scoped to facility, account and membership (`patient-chat.service.ts:195-198`; migration `0070_staff_patient_chat.sql:40-50`).

**Retention**
- When a record changes, its old-version vectors are deleted (`patient-chat.service.ts:200-202`). This only happens inside the same staff user's scope.
- Otherwise vectors are kept until the patient is deleted (`0070_staff_patient_chat.sql:46`). There is no age limit or job.

**Provider-side retention:** **not visible in code**.

---

## E. Chat document reading → AWS Textract (ehr-api)

**Trigger**
- During a records answer in path A or B, `prepareDocuments()` runs (`patient-chat.service.ts:142`, `patient-evidence.service.ts:22-28`, `staff-evidence.service.ts:63-70`).
- It starts or polls at most 2 documents per question (`patient-attachment-text.service.ts:104-105`).
- Patient chat reads the patient's imported attachments and documents classified `phi` (`patient-attachment-text.service.ts:52`).
- Staff chat reads documents of any classification from completed visits, and only when the user has both document and attachment permissions (`patient-attachment-text.service.ts:47-50`, `staff-evidence.service.ts:64`).

**Endpoint and region**
- `TextractClient({ region: S3_REGION })`, default `eu-west-1` (`patient-attachment-text.service.ts:73`, `config/environment.ts:104`).
- Calls: `StartDocumentTextDetection`, then `GetDocumentTextDetection` (`patient-attachment-text.service.ts:129-130,143`).

**What is sent**
- Textract reads the whole file directly from S3 by bucket, key and version: PDF, PNG, JPEG or TIFF. **This means images of the document are processed** (`patient-attachment-text.service.ts:104,129-130`).
- Plain-text files are read locally and never sent (`patient-attachment-text.service.ts:115-127`).
- The file may contain any identifiers and any third-party data. Nothing is redacted before Textract.

**What comes back and where it is stored**
- Textract returns text blocks. Lines below 90% confidence become `[Unclear line omitted]` (`patient-attachment-text.service.ts:56-70`).
- The text (≤200,000 characters), status, confidence, unclear-line count and page count are stored (`patient-attachment-text.service.ts:150-155,168-173`):
  - patient chat: `ehr.patient_attachment_extractions` and `ehr.patient_document_extractions` (migrations `0068_patient_attachment_extraction.sql:3-15`, `0069_patient_document_evidence.sql:9-13`);
  - staff chat: `ehr.staff_attachment_extractions` and `ehr.staff_document_extractions` (`0070_staff_patient_chat.sql:52-77`).
- This stored text is then sent to Claude and Bedrock through paths A–D. For patient chat it is redacted first; for staff chat it is not.

**Retention**
- Kept indefinitely. The runtime role has no `DELETE` on these tables (`services/ehr-api/database/runtime-grants.sql:1453-1454,1463`).
- Foreign keys to the source file are `on delete restrict`. The staff tables cascade when the patient is deleted.
- A job still processing after 6 days is marked failed (`patient-attachment-text.service.ts:136-141`).

**Provider-side retention:** no options are set. The AWS AI-services data-use opt-out is an organisation-level setting: **not visible in code**.

---

## F. OCR worker paper reading → Textract, then Anthropic (ocr-worker, branch)

**Trigger and who triggers it**
- A staff user with `ocr.job.write` creates an OCR job in `ocr-api` (`services/ocr-api/src/ocr/ocr.controller.ts:16-17`).
- The worker claims jobs fairly across facilities (`repository.ts:45` (branch)) and processes them (`worker.ts:42-75` (branch)).
- The AI step runs only when all three hold (`reader.ts:109-113`, `main.ts:20-21` (branch)):
  - `OCR_AI_MODE=claude`;
  - an API key is set;
  - the facility is allowed by `OCR_AI_FACILITY_IDS` (unset means every facility).

**F1. Textract**
- Region: `AWS_REGION`, default `eu-west-1`. An optional `AWS_ENDPOINT_URL` can override the endpoint (`config.ts:54-57`, `textract.provider.ts:105` (branch)).
- PNG and JPEG are sent **as image bytes** to `DetectDocumentText`, or to `AnalyzeDocument` with `LAYOUT` (`textract.provider.ts:156-161` (branch)).
- PDFs are sent by S3 reference to `StartDocumentTextDetection` or `StartDocumentAnalysis` (`textract.provider.ts:167-175` (branch)).
- Mode is set by `OCR_TEXTRACT_FEATURES` (`text` or `layout`), with at most `OCR_TEXTRACT_MAX_PAGES` = 20 pages (`config.ts:60,64` (branch)).
- On the base branch, images go to `AnalyzeDocument` with `FORMS` and `TABLES` (`services/ocr-worker/src/textract.provider.ts:10-11,72-73`).

**F2. Claude**
- **Endpoint:** the Anthropic SDK with `baseURL` fixed to `https://api.anthropic.com`, SDK retries off and SDK logging off (`claude.client.ts:8,96-98` (branch)). The worker's own retries are `OCR_AI_MAX_RETRIES`, default 4; each retry sends the page again (`config.ts:76`, `claude.client.ts:116-153` (branch)).
- **Models:**
  - first pass: `OCR_AI_FIRST_PASS_MODEL`, default `claude-sonnet-5-5`, effort `medium`;
  - re-read of flagged pages: `OCR_AI_REREAD_MODEL`, default `claude-opus-5-5`, effort `high`, up to `OCR_AI_MAX_REREAD_PAGES` = 20 pages (`config.ts:70-77` (branch)).
  - Adaptive thinking is on, and output uses a JSON schema (`claude.client.ts:106-115` (branch)).
- **Region:** `inference_geo: 'global'` is a hard-coded constant (`claude.client.ts:9,109` (branch)). It is gated by `OCR_AI_GLOBAL_PROCESSING_APPROVED`, which must be true when the mode is `claude` (`config.ts:69,113-116` (branch)). The region the API reports serving is recorded (`claude.client.ts:196-197`, `reader.ts:165` (branch)). **This differs from the chat paths, which use `us`.**
- **What is sent:** one request per page.
  - System prompt: fixed instructions on how to read a Nigerian paper medical record (`prompt.ts:13-74` (branch)). It contains no patient data and is marked `cache_control: ephemeral` (`claude.client.ts:113` (branch)).
  - User message: every Textract line of the page as JSON `{id, text, confidence, handwritten}`, without position boxes (`prompt.ts:149-153` (branch)).
  - **No images.**
- **Which patient:** the document's patient. `ocr.jobs.patient_id` can be null (`0013_durable_ocr_persistence.sql:30`), so a page may be read before the patient is confirmed. A page can hold anyone's data: relatives, prescribers (the prompt asks for prescriber names, `prompt.ts:61-63` (branch)), or other patients on shared sheets.
- **Redaction:** `createMasker()` replaces only Nigerian mobile numbers and bare 11-digit numbers (NIN-like) with `[hidden-number-N]` (`masking.ts:9-10,24-34`; applied at `reader.ts:140-143` (branch)).
  - **Names, dates of birth, ages, hospital or folder numbers, Health IDs, emails and addresses are not masked.**
  - The prompt explicitly asks the model to return the patient's name, date of birth or age, folder number and sex (`prompt.ts:69-71` (branch)).
- **What comes back:** per-page JSON with `identity`, `items` and `pageUnsure` (`prompt.ts:80-144` (branch)). The masked numbers are restored to their original values before storage (`items.ts:92,163,202-272` (branch)).
- **Where it is stored:** `ocr.extractions`, written by `ocr.complete_worker_job` (`repository.ts:79` (branch); table at `0013_durable_ocr_persistence.sql:88-110`):
  - `raw_text`: all lines, unmasked;
  - `structured_payload`: pages with line text and boxes, identity and items;
  - `provenance`: models, geo, counts, failure codes and token use, with no text (`worker.ts:233-270` (branch)).
- **Usage counts:** stored per model in `ocr.ai_usage` (`0110_ocr_page_allowance.sql:810-828` (branch)).
- **Logs:** counts and codes only (`worker.ts:76-85` (branch)).

**Retention**
- `ocr.extractions` is insert-only for the runtime roles (`runtime-grants.sql:457`), and its foreign keys are `on delete restrict`. No deletion exists in code.
- No retention for `ocr.ai_usage` was found in code.

**Provider-side retention:** no zero-data-retention or retention header is set. The SDK's prompt caching (ephemeral, system prompt only) is the only cache option. Anthropic account terms and the Textract data-use opt-out are **not visible in code**.

---

## Summary table

| Path | Provider and call | Region setting (where set) | Model (config key) | Data sent | Redaction | Images | Stored in HID | Retention |
|---|---|---|---|---|---|---|---|---|
| A. Patient chat | Anthropic `api.anthropic.com/v1/messages` (`claude-ai.service.ts:138`) | `inference_geo:'us'`, hard-coded (`:143`); gate `ANTHROPIC_PROCESSING_APPROVED` | `AI_GENERATION_MODEL_ID`, default `claude-sonnet-4-6` | Fixed prompt, question, ≤4 past exchanges, ≤12 filtered records, age and sex | `redactIdentifiers` on question, history and free text (`patient-evidence.policy.ts:358`); others' names and some fields not covered | No | `ehr.patient_chat_messages` | 30 days or last 10, pruned only on next use; clear deletes; no job |
| B. Staff chat | Same as A | Same as A | Same as A | Question as typed, history, ≤12 full records including name, date of birth, clinician notes, file names | None | No | `ehr.staff_chat_messages` | Same as A, per staff user's scope |
| C. Patient embeddings | Bedrock `InvokeModel` (`bedrock-ai.service.ts:13`) | Not in code; AWS SDK default chain | `AI_EMBEDDING_MODEL_ID`, default `amazon.titan-embed-text-v2:0` | ≤4 chunks (≤2800 characters) of cleaned records, plus question; no profile | As A | No | `ehr.patient_evidence_chunks` (vectors only) | Purged when stale; otherwise until patient deleted |
| D. Staff embeddings | Same as C | Same as C | Same as C | ≤4 unredacted chunks including profile (name, date of birth), plus question | None | No | `ehr.staff_evidence_chunks` (vectors only) | Old versions deleted; otherwise until patient deleted |
| E. Chat documents | Textract `StartDocumentTextDetection` (`patient-attachment-text.service.ts:129`) | `S3_REGION`, default `eu-west-1` | Not applicable | Whole PDF or image file by S3 reference; ≤2 per question | None | **Yes** | `ehr.{patient,staff}_{attachment,document}_extractions.extracted_text` | Indefinite; no delete grant |
| F1. OCR read | Textract `DetectDocumentText` / `AnalyzeDocument` (bytes), `Start…` (S3 reference) | `AWS_REGION`, default `eu-west-1` | `OCR_TEXTRACT_FEATURES` | Whole page image or PDF | None | **Yes** | `ocr.extractions.raw_text`, `structured_payload` | Indefinite; insert-only |
| F2. OCR AI reading | Anthropic SDK, fixed base URL (`claude.client.ts:96`) | `inference_geo:'global'`, hard-coded (`claude.client.ts:9`); gate `OCR_AI_GLOBAL_PROCESSING_APPROVED` | `OCR_AI_FIRST_PASS_MODEL` (`claude-sonnet-5-5`), `OCR_AI_REREAD_MODEL` (`claude-opus-5-5`) | Fixed prompt, plus every OCR line of each page (text, confidence, handwriting) | Phone and 11-digit numbers only (`masking.ts`); names, date of birth and folder numbers sent and requested | No | `ocr.extractions` (unmasked), `ocr.ai_usage` (counts) | Indefinite; insert-only |

Across all paths, provider-side retention (Anthropic zero data retention, Bedrock invocation logging, Textract data-use opt-out) is not configured in code and is **not visible in code**. It is an account or organisation setting.