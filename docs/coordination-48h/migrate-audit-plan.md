# Migrate readiness audit plan (3 Nov 2026)

```json
{
  "product": "Migrate (migrate. and the Migrate area inside ehr.): reading paper records into the chart",
  "readiness_percent": 24,
  "how_counted": "Formula: readiness = sum of scores / number of items counted x 100. Each pipeline stage and each decided feature counts once, after removing duplicates between the two audits. Scores: live = 1, built but not released = 0.5, shipping tonight = 0.5 (built, not live yet), blocked on infra = 0.25, partly built = 0.25, missing / broken / sample only = 0. Owner questions and release paperwork are left out of the count, because they are not features. Result: 6.75 / 28 = 24.1%, rounded to 24%. The 28 items counted: (1) Upload form on Migrate: blocked on infra 0.25. (2) Document service (upload link, confirm, list, download): live 1. (3) Virus scanner (GuardDuty, bridge, database change): built not released 0.5. (4) Records processing Stage 1, backend: built not released 0.5. (5) Records processing Stage 1, website: built not released 0.5. (6) Textract text reading: live 1. (7) AI reading step on the Claude API (the Bedrock script is a sample only): missing 0. (8) Claude key and internet route for the OCR worker: missing 0. (9) Item-by-item staff review: broken 0 (JSON boxes). (10) Pick the patient and document by name, no IDs on screen: broken 0. (11) Publishing into EHR, Lab and Pharmacy: live 1. (12) Paper-record items filed by type (diagnosis, medicine, allergy, lab, vitals, note) with codes: missing 0. (13) Plain error words, health#107: shipping tonight 0.5. (14) Plain refusal wording and chat 'where this came from' labels: live 1. (15) Phone camera, several pages in one record, blur check: missing 0. (16) Removing photo location and camera details on Migrate uploads: missing 0. (17) TIFF files readable: broken 0. (18) Scanned prescription becomes an active order: missing 0. (19) Working data deleted after 24 hours: broken 0. (20) Corrections by doctors and clinicians only: partly built 0.25. (21) Under-18s refused at every step: partly built 0.25. (22) Records processing Stage 2: missing 0. (23) Facility-wide list of scan jobs: missing 0. (24) USD 400 cap, per-facility allowance, 80% warning, pause at 100%: missing 0. (25) 200-document accuracy test: missing 0. (26) Textract table and layout reading: missing 0. (27) True wording on the upload hint: broken 0. (28) DPIA and privacy notice covering the Claude API: missing 0. Totals: 4 live (4), 3 built not released (1.5), 1 shipping tonight (0.5), 1 blocked on infra (0.25), 2 partly built (0.5), 17 at zero (8 missing-type plus 7 broken plus AI and key, as listed). Left out of the count: the migration renumbering (a release step that needs a decision), moving chat to Google Cloud EU (chat, not Migrate), bulk migration (Stage 3, waiting on legal advice and 'don't port hid-1.0 yet'), and the out-of-date design documents (planning paperwork). The headline stays the same whatever the weights: in production today, not one paper record can be uploaded, scanned, read or filed.",
  "works_today": [
    "Staff whose facility can't read scanned documents get a plain message: 'Reading scanned documents isn't available at your facility yet.' (Migrate.tsx:37, live on d66dd307).",
    "The patient chat says where each fact came from: 'You added this', 'Recorded by a health worker' or 'From a scanned paper record' (production backend 34d69557, website ChatSource.tsx:9-49). Nothing scanned has reached chat yet, because nothing scanned has been filed yet.",
    "The document service in the EHR backend can create upload links, confirm an upload, list documents and download them, for PDF, JPEG, PNG and TIFF (ehr-api document.controller.ts:17, :29, :36, :46). The browser can't reach it yet because of the missing storage rule.",
    "The OCR worker is deployed and can read text from photos and from PDFs of any length with Amazon Textract (ocr-worker textract.provider.ts:46-110). No production job has ever reached it.",
    "Publishing reviewed items is deployed and switched on: an EHR clinical note, an imported Lab result, or Pharmacy medicine history, each with a record of where it came from (ocr-api ocr.controller.ts:91, ehr-api ocr-integration.controller.ts:28, lab-api lab-imports.controller.ts:14, pharmacy-api pharmacy.controller.ts:62). It has never run in production.",
    "An imported EHR note can be marked 'entered in error' without being deleted (clinical-notes.service.ts:327-430). Nurses can do this too, which goes against the 'doctors and clinicians only' rule.",
    "Shipping tonight, not live: Migrate and OCR error messages in plain words (health#107), plus a test of the consultation's 'Extract with OCR' hand-off (health#121)."
  ],
  "plan": [
    {
      "rank": 1,
      "item": "Remove every ID box and ID label from the Migrate screens. Staff pick the patient by name and date of birth, and the document by its name and upload date. Fields today: Migrate.tsx:204, 226-228, 336-337, 361-366 and ocrSteps.tsx:175/194 ('Document ID (a UUID)', 'Patient ID', 'Canonical patient ID'). Labels shown today: 'Job <id>', 'Document <id>', 'Patient <id>', 'Provider', 'Version' at Migrate.tsx:50, 57-59, 321-324, 346, 410, 430.",
      "why": "Broken against the owner's 'no codes or IDs on screen' rule, and records staff can't use the screen as it is. Tonight's batch does not touch Migrate.tsx.",
      "owner": "Lekan",
      "size": "M",
      "needs_backend": false,
      "depends_on": "Reuse the EHR's existing patient search. Rahman checks it on a real phone."
    },
    {
      "rank": 2,
      "item": "Replace the four JSON boxes in the OCR review step (ocrSteps.tsx:128-143, including the hint at :138 that names 'encounterId, noteType, title and content'). Short term: a plain form showing the page image and the text that was read, with 'Note title' and 'What the page says' fields that staff fill in. Final version: one card per item (accept, edit or reject), with the source line shown, once the AI step exists.",
      "why": "Broken: the only way to review a scan is to edit raw JSON, which goes against the plain-English rule.",
      "owner": "Ola",
      "size": "L",
      "needs_backend": true,
      "depends_on": "The short-term form needs no backend work. The item cards need ranks 15 and 18."
    },
    {
      "rank": 3,
      "item": "Delete working data after 24 hours (raw Textract text, raw AI output, rejected suggestions, run details). Add a migration that lets 0013's ocr.reject_immutable_change triggers (0013_durable_ocr_persistence.sql:156-160) clear raw_text and structured_payload while keeping the audit events. Then add a scheduled sweeper.",
      "why": "Broken against owner decision 6 (24 hours) and NDPA data minimisation. Today the database refuses to delete the raw text of paper records.",
      "owner": "coordinator",
      "size": "M",
      "needs_backend": true,
      "depends_on": "A migration number from rank 9. It must be live before any real patient record is read."
    },
    {
      "rank": 4,
      "item": "Make TIFF scans readable. Send TIFF to Textract instead of failing it with UNSUPPORTED_MEDIA_TYPE (ocr-worker textract.provider.ts:69-71). Textract accepts TIFF, and multi-page TIFF goes the same way as PDF.",
      "why": "Broken: the upload form accepts .tif/.tiff (DocumentCapture.tsx:251, :314) and the document service allows it, but the file can never be read. Staff only find out after the scan wait.",
      "owner": "coordinator",
      "size": "S",
      "needs_backend": true,
      "depends_on": ""
    },
    {
      "rank": 5,
      "item": "Corrections rule: only doctors and clinicians may mark an imported item 'entered in error', not nurses (nurses hold ehr.note.write, 0006:64). Add a withdraw route for imported Lab results and Pharmacy history (today they can only be created). Log every correction, and tell the facility when an item filed to the wrong patient is withdrawn.",
      "why": "Partly built and partly broken: a wrongly imported lab result or medicine can't be corrected at all, and the 'doctors and clinicians only' rule isn't enforced.",
      "owner": "coordinator",
      "size": "M",
      "needs_backend": true,
      "depends_on": "Rank 9 (migration number). Ola reviews the clinical wording."
    },
    {
      "rank": 6,
      "item": "Change the upload hint at DocumentCapture.tsx:65-67 ('A lab result is read by OCR automatically once its scan is clean') to true, plain words, for example 'After the virus check, open the document and choose Read this record.'",
      "why": "Misleading: no automatic lab OCR exists anywhere. The hint is hidden today only because document types are off, so it would show up the day they are switched on.",
      "owner": "Lekan",
      "size": "S",
      "needs_backend": false,
      "depends_on": ""
    },
    {
      "rank": 7,
      "item": "Update the planning documents so the team doesn't build what the owner overruled. ocr-fhir-design.md still says Bedrock EU (:5, :85, :177, :443), 90-day working data (:367, :489-491), 'never an active order' (:90, :252, :455-458) and imports kept out of chat (:487-488). migrate-plan-additions.md section 3 wrongly says the AI reading, item review and 24-hour deletion are 'built'. ocr_extract.py uses Bedrock.",
      "why": "Misleading: anyone building from these documents builds the old, overruled design.",
      "owner": "coordinator",
      "size": "S",
      "needs_backend": false,
      "depends_on": ""
    },
    {
      "rank": 8,
      "item": "Apply the documents-bucket CORS rule already merged in hid-system#130 (52b39767, module.data.aws_s3_bucket_cors_configuration.documents[0]) by following DEVOPS_HANDOVER.md:328-351 'Document upload (CORS)'. Then close task #163 and check one upload on migrate. and ehr.",
      "why": "Blocked: every upload on migrate. and ehr. fails today with 'The document could not be uploaded. Please try again.' It is one Terraform apply and unlocks everything after it.",
      "owner": "DevOps",
      "size": "S",
      "needs_backend": false,
      "depends_on": "Best done together with rank 14 (removing photo location), so phone photos never go up carrying GPS."
    },
    {
      "rank": 9,
      "item": "Renumber the release chain after production's 0103: records processing 0104, document scanner 0105, support check 0106, SSO 0107, Akos steps 3-8 0108-0113. Rebase rp-be, scan-be and sup-be onto 34d69557 (they are 34 commits behind), rerun the database proof, and re-sign each declaration under its new number.",
      "why": "Blocked: rp-be (0100), scan-be (0101) and sup-be (0102) collide with live 0100-0103, so nothing in the chain can release.",
      "owner": "coordinator",
      "size": "S",
      "needs_backend": true,
      "depends_on": "Owner decision 1 (order and numbers) and the owner re-signing."
    },
    {
      "rank": 10,
      "item": "Release records processing Stage 1 on the website first. Rebase local branch rp-web 4139ca85 onto main d66dd307 (391 commits behind; touches Migrate.tsx, staff Operations.tsx, Portal.tsx and the audit pages). Push it, review it and release it. This adds the 'Ask the patient for records processing' panel and shows patients the purpose in plain words.",
      "why": "Blocked: OCR can't start without the patient's approval, and decision 6 says the website ships before the backend.",
      "owner": "coordinator",
      "size": "M",
      "needs_backend": false,
      "depends_on": "Rank 1 should land first, or together, so the rebased Migrate screen has no IDs on it. Rahman checks it on a real phone."
    },
    {
      "rank": 11,
      "item": "Release records processing Stage 1 on the backend (rp-be 3926c07a, renumbered to 0104): healthcare-operations purpose, who may ask (doctor, clinician, nurse, lab), under-18s refused, 24-hour requests.",
      "why": "Blocked: until this is live, every OCR job answers 'not found' (0098_sealed_demo_tenant.sql:322-325).",
      "owner": "coordinator",
      "size": "M",
      "needs_backend": true,
      "depends_on": "Ranks 9 and 10."
    },
    {
      "rank": 12,
      "item": "Release the virus scanner on the backend: scan-be 2f3fd361 renumbered to 0105, and the scan-result route that marks files clean.",
      "why": "Blocked: without it every file says 'waiting for its virus check' for ever, can't be opened, and OCR refuses it (ocr.service.ts:134-136).",
      "owner": "coordinator",
      "size": "M",
      "needs_backend": true,
      "depends_on": "Rank 9. Push scan-tf b51bd90b and scan-tf-cap b3792b0b, rebased onto dev, for rank 13."
    },
    {
      "rank": 13,
      "item": "Apply the GuardDuty Malware Protection and scan-result bridge Terraform (scan-tf and scan-tf-cap: workload issuer callers 6 to 8) by following the runbook, and confirm its monthly cost fits inside the USD 400.",
      "why": "Blocked: this is the AWS half of the scanner.",
      "owner": "DevOps",
      "size": "S",
      "needs_backend": false,
      "depends_on": "Rank 12 code pushed and reviewed."
    },
    {
      "rank": 14,
      "item": "Remove photo location, camera details and thumbnails from Migrate uploads, keeping only the orientation (decision 30). Reuse photoMetadata.ts and fileSignature.ts (health#128 3ccbdd31) in DocumentCapture.tsx before the file is uploaded.",
      "why": "Missing NDPA safeguard: once uploads work, staff phone photos (personal phones are allowed, decision 32) would carry GPS location.",
      "owner": "Lekan",
      "size": "S",
      "needs_backend": false,
      "depends_on": "Ship before or with rank 8."
    },
    {
      "rank": 15,
      "item": "Build the AI reading step in ocr-worker on the Anthropic Claude API (global). Rewrite the scratchpad ocr_extract.py for the Claude API instead of Bedrock, fix its 19 open review findings (task #182), and keep its grounding checks (unused lines, word-by-word differences, 'needs review' flags).",
      "why": "Missing: this is the core of the owner's Migrate design. Without it staff type every item by hand from raw text.",
      "owner": "coordinator",
      "size": "L",
      "needs_backend": true,
      "depends_on": "Ranks 16 and 17 before any real patient data. Use fictional documents until then."
    },
    {
      "rank": 16,
      "item": "Give ocr-worker the Claude API key and a narrow internet route. In Terraform, add /hid/staging/anthropic to ocr-worker (today only ehr-api has it, workloads.tf:79-80) and allow HTTPS to api.anthropic.com only (platform.tf:29-31, :190). Set a spending cap in the Anthropic console.",
      "why": "Missing: today the worker can reach only AWS endpoints, so the AI step couldn't run.",
      "owner": "DevOps",
      "size": "S",
      "needs_backend": true,
      "depends_on": "The coordinator writes the Terraform change, and rank 15 must exist."
    },
    {
      "rank": 17,
      "item": "Write the DPIA addendum and privacy-notice lines for Migrate: staff scan paper records, Textract reads them on AWS, and Claude API AI reading is processed worldwide, with transfer safeguards. Use the DPO details from decision 32. Confirm the AWS AI-services opt-out.",
      "why": "Missing NDPA step: no real patient's paper record may go to the Claude API until the owner signs this.",
      "owner": "coordinator",
      "size": "S",
      "needs_backend": false,
      "depends_on": "Owner signs it (owner decision 7)."
    },
    {
      "rank": 18,
      "item": "File paper-record items by type into the chart: imported diagnoses, medicines, allergies, lab results, vitals and notes, with codes (ICD-10, LOINC, HID formulary), FHIR at the boundary, and each one marked as a paper record. Build the design's tables (ocr-fhir-design.md:234-259, M1-M5).",
      "why": "Missing: today scans land as text blocks, which the EHR can't list, check or share, and unverified paper allergies can't warn prescribers.",
      "owner": "coordinator",
      "size": "L",
      "needs_backend": true,
      "depends_on": "Rank 15. Ola builds the EHR chart display and the 'Paper record' label."
    },
    {
      "rank": 19,
      "item": "Check the patient's age at queueing and at publishing as well as at the request: add date-of-birth checks in ocr-api's create, validate and publish code (ocr-fhir-design.md:352).",
      "why": "Partly built: only the unreleased request step refuses under-18s, so a grant made before a birthday would slip through.",
      "owner": "coordinator",
      "size": "S",
      "needs_backend": true,
      "depends_on": "Rank 11."
    },
    {
      "rank": 20,
      "item": "USD 400 budget and per-facility allowance. Turn on the Terraform cost-governance module at exactly USD 400 (today it is off and set to 416.67, variables.tf:567, :583-590). Add a per-facility counter with a warning at 80% and an automatic pause at 100% that stops Textract and AI reading but leaves review and manual typing open.",
      "why": "Missing: nothing stops one busy facility from running up the bill.",
      "owner": "coordinator",
      "size": "L",
      "needs_backend": true,
      "depends_on": "Owner decision 2 (what the allowance counts and its size). DevOps applies the Terraform."
    },
    {
      "rank": 21,
      "item": "Phone camera on Migrate: a 'Take a photo' button (capture=\"environment\", as in routes/AddRecord.tsx), several pages joined into one record, a blur check before OCR is paid for, and a page limit.",
      "why": "Missing: the owner's new plan item (2 Nov). Today a 5-page record means 5 uploads and 5 OCR runs.",
      "owner": "Lekan",
      "size": "M",
      "needs_backend": true,
      "depends_on": "Rank 14, and owner decision 5 (camera rules). The backend only needs to confirm every page is read and set the page limit. Rahman checks on real phones."
    },
    {
      "rank": 22,
      "item": "'Prescribe from this scan': open a new EHR prescription filled in from the scanned medicine for a prescriber to check and sign. Pharmacy sees it only after signing, and the live pharmacy guard (0100/0101) stays as it is.",
      "why": "Missing: decision 6 allows a scanned prescription to become an active order, for facilities that write by hand and then scan.",
      "owner": "Ola",
      "size": "M",
      "needs_backend": true,
      "depends_on": "Rank 18 and owner decision 4."
    },
    {
      "rank": 23,
      "item": "Records processing Stage 2: database lock on the purpose, plain wording in the access log and daily notice, a revoke that stops unfinished publishing, permissions for the Records officer role (find, upload, OCR, matching), and the document list without a visit.",
      "why": "Missing: the brief says Stage 2 is required before any real facility uses Migrate. Stage 1 alone is fit for the Demo Hospital rehearsal only.",
      "owner": "coordinator",
      "size": "L",
      "needs_backend": true,
      "depends_on": "Rank 11."
    },
    {
      "rank": 24,
      "item": "A facility-wide list of scan jobs, replacing 'jobs ... are listed until you leave this page' (Migrate.tsx:313), shown with patient names and dates, not IDs.",
      "why": "Missing: work disappears when staff leave the page.",
      "owner": "Lekan",
      "size": "M",
      "needs_backend": true,
      "depends_on": "A list endpoint in ocr-api from the coordinator."
    },
    {
      "rank": 25,
      "item": "Accuracy test on 200 fictional, labelled documents: Haiku first with a Sonnet re-read, against Sonnet only. Record accuracy and cost per page.",
      "why": "Missing: the model choice, and so the monthly AI cost, depends on it.",
      "owner": "coordinator",
      "size": "L",
      "needs_backend": true,
      "depends_on": "Rank 15 and owner decision 6 (pass marks and who labels)."
    },
    {
      "rank": 26,
      "item": "Switch Textract to layout and table reading for lab reports (today only StartDocumentTextDetection is used, textract.provider.ts:2, 10, 12; the design estimates about USD 225 a month).",
      "why": "Missing: lab result columns are lost today.",
      "owner": "coordinator",
      "size": "M",
      "needs_backend": true,
      "depends_on": "Rank 20 (it must fit the USD 400)."
    },
    {
      "rank": 27,
      "item": "After tonight's release, check the plain error words (health#107) on migrate. and ehr. on a real phone.",
      "why": "Polish: confirms tonight's wording change landed. It does not change the ID or JSON boxes.",
      "owner": "Rahman",
      "size": "S",
      "needs_backend": false,
      "depends_on": "Tonight's batch going live."
    },
    {
      "rank": 28,
      "item": "Bulk migration from paper back-files (projects, batches, matching queue with a second checker, sampling, pause and resume, cost per project), as in hid-1.0.",
      "why": "Later: Stage 3 waits for legal advice (brief decision 8) and the owner's 'don't port hid-1.0 yet'.",
      "owner": "owner-decision",
      "size": "L",
      "needs_backend": true,
      "depends_on": "Legal advice and the owner lifting the hid-1.0 pause."
    }
  ],
  "owner_decisions": [
    {
      "question": "Release order and migration numbers: records processing 0104, document scanner 0105, support check 0106, SSO 0107, Akos steps 3-8 0108-0113? Will you re-sign each declaration under its new number?",
      "recommendation": "Yes, in that order. Records processing and the scanner are both needed before one scan can be read, so they go first. Decision 18's numbers (0102-0104) were overtaken by the demo-story release (decision 28)."
    },
    {
      "question": "Per-facility allowance: does it cover the Claude AI reading (billed by Anthropic, not AWS) as well as Textract and storage? How big is it, who can raise it, and what stops at 100%?",
      "recommendation": "Count pages, which staff understand, and include both Textract and AI. Start at 500 pages per facility per month, which is roughly USD 10-15 of reading. Only you (super admin) can raise it. At 100%, pause both Textract and AI reading but keep review and manual typing from the page image open. Look at the figure again after the first pilot month."
    },
    {
      "question": "Do patients see paper-record items in their own Records? Your 18:40 answer was 'keep it as it is today'.",
      "recommendation": "Keep patient Records as they are today, with no paper-record section for now. Chat may still mention scanned items with its live 'From a scanned paper record' label. When a section is turned on later, label it 'Paper record', not 'From a doctor or hospital' (ImportedHistory.tsx:40)."
    },
    {
      "question": "Active prescriptions from scans: who counts as a prescriber, is the paper's own prescriber and date kept, and can the order go straight to the pharmacy work list?",
      "recommendation": "Only doctors and clinicians who can already prescribe in the EHR. Keep the paper's prescriber and date on the new order as 'Original paper prescription by ... on ...'. It reaches the pharmacy work list only after the EHR prescriber signs, like any new prescription, so the pharmacy guard stays intact."
    },
    {
      "question": "Phone camera rules: page limit per record, whether 'Use anyway' is allowed after a blur warning, and one photo-cleaning rule for online and offline.",
      "recommendation": "Limit each record to 20 pages. Allow 'Use anyway', but mark that page 'photo may be blurred' so the reviewer checks it. Use one rule everywhere: keep only the orientation (decision 30), and change offline wave 1 so it stops re-encoding photos."
    },
    {
      "question": "Pass marks and labelling for the 200-document accuracy test.",
      "recommendation": "Approve the design's marks: at least 99% medicine accuracy after review and under 1% unsupported items. Use fictional documents only. Ola leads the labelling with one pilot clinician (about 25-40 hours). Pick the cheaper model setup if it passes."
    },
    {
      "question": "NDPA steps before any real patient's paper record: sign the DPIA addendum for worldwide Claude API reading, confirm the AWS AI-services opt-out, and name the pilot facility and clinical safety lead.",
      "recommendation": "Sign once rank 17 is drafted. Have DevOps set the AWS AI-services opt-out, since Textract stays on AWS. Name the pilot facility and Ola (or the pilot's lead doctor) as clinical safety lead. Until all of this is done, Migrate runs on fictional documents on the Demo Hospital tenant only."
    },
    {
      "question": "Is Records processing Stage 1 enough for the Demo Hospital rehearsal, with Stage 2 required before any real facility?",
      "recommendation": "Yes. Release Stage 1, the scanner and CORS for the demo rehearsal now, and keep Migrate off for real facilities until Stage 2, 24-hour deletion, corrections and the DPIA are live."
    }
  ],
  "summary": "Migrate is about 24% ready, and in production today it can't read a single paper record. Each stage is blocked by the one before it. (1) Uploads fail in the browser because the documents storage rule (CORS, merged in hid-system#130) has never been applied. That is one DevOps apply. (2) Each file would then wait for a virus check for ever, because the GuardDuty scanner is built but exists only on unpushed local branches (scan-be, scan-tf). (3) OCR would then answer 'not found', because patient approval (records processing Stage 1: rp-be, rp-web) is also built but unpushed. These branches use migration numbers 0100-0102, which production has already taken, so they need new numbers from 0104 and your signature again. (4) The AI reading step on the Claude API that you chose hasn't been written into the product. The only version is a scratchpad script that uses Bedrock and has 19 open review findings. What already works: the plain refusal wording, chat's 'where this came from' labels, the document service, Textract reading and publishing into the chart. The last two are deployed but have never run. The worst conflicts with your rules are the Migrate screens, which ask staff to type IDs and edit JSON (Migrate.tsx, ocrSteps.tsx:128-143), raw scanned text that the database refuses to delete (you chose 24 hours), TIFF files that upload but can never be read, an upload hint promising automatic lab reading that doesn't exist, and a budget alarm that is switched off, set to USD 416.67 instead of 400, and can't pause anything. The plan fixes those first. Then it unblocks the chain: CORS apply, renumbering, records processing on the website then the backend, the scanner. Then it builds what's missing: the AI step on the Claude API, the key and internet route for the OCR worker, the DPIA, items filed by type, the allowance and pause, the phone camera, and prescribing from a scan. Stage 2 and the DPIA must be done before any real facility. Until then, Migrate is for fictional documents on Demo Hospital only. Moving the patient chat to Google Cloud EU (decision 6) is separate from Migrate and still not started. Tonight's batch (health#107 plain words) improves the error messages only. This was a read-only synthesis of the two audits plus the owner decisions file /tmp/claude-0/-home-user/9e2fd816-d904-5725-a775-049f6f6c7bf9/scratchpad/owner-decisions-2026-11-01.md. Nothing was edited, committed or pushed."
}
```
