# Migrate without typing: chosen design and build plan (owner approved 3 Nov 2026)

```json
{
  "chosen": "A combination built mostly on Design A. Paper records are brought in from the patient the staff member already has open, on ehr. and on migrate. From Design B it borrows three things: the \"is this the right patient?\" check comes before any item, the page picture sits next to the item cards, and one \"Publish\" sends every accepted item. migrate. stays a short start page (\"Open a patient\", then the same paper records page). The facility-wide \"Waiting to be checked\" list comes later. Design B's facility patient list and its \"pending prescription\" state are dropped.",
  "why": "1. Fewest screens and taps. The patient is already open, so Migrate never asks who the paper is for. There is no patient picker, no visit picker and no \"kind of paper\" choice (the AI sorts items into Medicines, Diagnoses and so on). Staff tap \"Bring in paper records\", take photos, tap \"Done\", then later check the cards and tap Publish.\n2. Safest for the right patient. The patient comes from the chart, never from a list or a typed box. The name and date of birth on the paper are compared with the Health ID before any card is shown, and a mismatch stops the paper.\n3. Ships soonest. It needs no new facility patient list (Design B's identity-api list is new work and a privacy risk) and no facility queue for the first rehearsal. Publishing uses the direct-care access the chart already has, so it avoids Design B's \"second approval to publish\" problem.\n4. Prescriptions stay simple. An existing EHR prescriber taps \"Prescribe from this scan\", and the usual prescription form opens filled in. They sign it, and the pharmacy's existing guard does the rest (decision 33-8). Design B's new \"waiting for a prescriber\" state in pharmacy-api is not needed.\n5. Both designs need the same backend, and nothing works until CORS, records processing 0104, the scanner 0105 and the AI step are live. So the website order is: first remove the ID and JSON boxes now, then build the new screens against Demo Hospital mock data while the backend catches up.\nWhat is given up: lab and pharmacy staff, who never open the full chart, get their own capture on a lab work item later.",
  "flow": [
    {
      "step": "1. Open the patient (as today)",
      "what_staff_see": "On ehr.: the patient's page, as now. On migrate.: a start page that says 'Bring in paper records. Open the patient first.' with one button, 'Open a patient', which goes to the usual Patients page. The patient open now and 'Shared with you' can be opened with one tap.",
      "what_staff_do": "Open the patient the usual way: tap them under 'Shared with you' or 'Patient open now', or use the Health ID from the patient's card with the patient's OK or Access PIN. Migrate itself never asks for a patient, a document or a number."
    },
    {
      "step": "2. Tap 'Bring in paper records'",
      "what_staff_see": "A row in Next steps: 'Bring in paper records. Take photos of old cards, results or prescriptions. The system reads them and you check.' The same button is on a visit's Documents card. If it can't be used, one plain line says why instead, for example 'Paper records can't be read for patients under 18 yet', 'Not available during emergency access', 'You can view but not add to this record' or 'Paper records are being tried at Demo Hospital first'.",
      "what_staff_do": "One tap. Nothing goes into the web address."
    },
    {
      "step": "3. The patient allows it (once, for 24 hours)",
      "what_staff_see": "Only if the patient hasn't already said yes today: 'Amina needs to allow this facility to turn her paper records into her digital record for 24 hours.' One button: 'Ask Amina'. Then 'Waiting for Amina...', which changes by itself to 'Amina said yes'. The reason Amina sees is already written.",
      "what_staff_do": "One tap, then wait while Amina approves on her phone. If the owner agrees (question 1), the first request or the Access PIN covers this too, and this step disappears."
    },
    {
      "step": "4. Take photos or choose files",
      "what_staff_see": "Two big buttons: 'Take photos' (the phone's back camera) and 'Choose files' (PDF, JPEG or PNG). A short guide: flat page, good light, whole page, one page per photo. A strip of page pictures, each with Retake, Remove and Move up/down, plus 'Add another page' and '3 of 20 pages'. A blurred, dark or too-small page shows 'This page looks blurred. Retake it?' with Retake and Use anyway. A page kept with Use anyway is marked for the checker. At the bottom: 'Pages left at this facility this month: 312 of 500'.",
      "what_staff_do": "Snap each page, fix any warned page, then tap 'Done, read these pages'. Nothing is typed. Location and camera details are removed from every photo (only which way up it is stays), and the pages become one file."
    },
    {
      "step": "5. Sending, virus check and reading (automatic)",
      "what_staff_see": "'Sending 3 pages...', then 'Checking the file is safe...', then 'Reading the pages. You can leave this page and come back.' A 'Paper records' list on the patient's page shows each paper as 'Clinic card · 3 pages · taken today 10:14' with one status: Checking for viruses / Reading / Ready to check (check by 10:14 tomorrow) / Published / Couldn't read. When the month's pages are used up: 'Reading is paused until 1 December. You can still check papers and add items by hand.'",
      "what_staff_do": "Nothing. They go back to the visit. If a paper says 'Couldn't read', they tap 'Try again' or 'Take the photos again' and pick a reason from a list."
    },
    {
      "step": "6. Is this Amina's paper? (first, before any item)",
      "what_staff_see": "Tapping 'Ready to check' opens the check screen, with the page picture on one side (zoom, 'Page 1 of 3'). At the top: 'The paper says: AMINA BELLO, born 12/03/1985. Matches Amina Bello, 41.' If both differ: 'This paper may belong to someone else. It can't be published.' with 'Remove this paper'. If the paper shows no name: 'This paper has no name on it. Check the page before you go on.'",
      "what_staff_do": "Tap 'Yes, this is Amina's paper' or 'No, wrong patient'. Choosing 'No' stops the paper and nothing from it can be published."
    },
    {
      "step": "7. Check each item the system found",
      "what_staff_see": "Cards under Medicines, Diagnoses, Allergies, Notes, and later Lab results and Vitals. Each card shows the item in plain words ('Amoxicillin 500 mg, three times a day, for 5 days'), the date as written, the cut-out of the page where it was found, the words exactly as written, and either 'Clear' or 'Check carefully: hard-to-read handwriting'. Tapping a card highlights its line on the page. Each card has Accept, Change and Remove, with a count such as '7 of 9 checked'. There is no 'Accept all' for medicines, allergies or lab results.",
      "what_staff_do": "Accept is one tap. Change opens short lists to pick from (medicine names that match the page; how often; still taking / finished / stopped / not known; confirmed / possible / ruled out; reaction and how bad), or one number to fix. Remove asks for a reason picked from a list (Not on the paper / Not this patient / Listed twice / Other). 'Add something that was missed' means choosing the kind, tapping where it is on the page and picking values. Work is saved as they go."
    },
    {
      "step": "8. Publish",
      "what_staff_see": "A bar: '9 accepted · 2 removed · 0 left'. Publish works only when every card has a decision and step 6 is done. Then: 'Added to Amina's record: 3 medicines (as history), 2 diagnoses, 1 allergy, 1 note.' In the chart, each item appears under 'From paper records', labelled 'Checked and published by Nurse Ada, 10:40'. An item that failed has its own 'Try again', which works from any phone or computer.",
      "what_staff_do": "Tap Publish once."
    },
    {
      "step": "9. A scanned prescription becomes an order (only when needed)",
      "what_staff_see": "Only an EHR prescriber sees this, and only on a published medicine that was written as a prescription: 'Prescription on paper: Dr Bello, 2 Oct 2026' and a button 'Prescribe from this scan'. It opens the usual prescription form in the current visit, already filled in. It warns if the same medicine was already prescribed today.",
      "what_staff_do": "Check it and sign. The pharmacy can dispense only after this signature, as today."
    },
    {
      "step": "10. Fix a mistake later",
      "what_staff_see": "On each 'From paper records' item, for doctors and clinicians only: 'Mark as entered in error'. On the paper itself: 'Wrong patient: withdraw everything from this paper'. Nothing is deleted. The item is crossed out with who did it and when, and the facility is told about a wrong-patient withdrawal.",
      "what_staff_do": "Pick a reason from the list and confirm."
    }
  ],
  "build_plan": [
    {
      "order": 1,
      "piece": "Remove the typed boxes now. Delete the 'Document UUID' and 'Patient UUID' forms, the job, patient, provider and version short IDs, and the raw text panel (Migrate.tsx). Delete the four JSON boxes, the 'Canonical patient ID' box and UUID_V4 (ocrSteps.tsx). Remove the untrue 'read by OCR automatically' and 'opened once the virus check is done' lines (DocumentCapture.tsx, consult/Documents.tsx) and correct the 'No role holds the OCR work' note. Stop offering TIFF. Migrate becomes a start page with 'Open a patient'. Add a test that no ID or JSON box exists anywhere in Migrate.",
      "repo": "health (website)",
      "owner": "Lekan",
      "size": "S (2-3 days)"
    },
    {
      "order": 2,
      "piece": "Apply the documents bucket CORS rule (hid-system #130, task #163), allowing upload (PUT) and viewing (GET) from ehr. and migrate., then do one test upload at Demo Hospital.",
      "repo": "hid-system (infra/terraform)",
      "owner": "DevOps",
      "size": "S (1 day)"
    },
    {
      "order": 3,
      "piece": "Rebuild the records processing pieces from rp-web 4139ca85 on current main instead of merging the branch (it is 391 commits behind and clashes with Migrate.tsx): the 'Ask Amina' panel, the purpose on access requests, the patient's approval wording, history and audit. The reason is fixed text and there is no reason box. Per decision 6 this ships before the backend.",
      "repo": "health (website)",
      "owner": "Lekan",
      "size": "M (4-5 days)"
    },
    {
      "order": 4,
      "piece": "Renumber records processing (rp-be 3926c07a) to 0104 and release it once the owner re-signs.",
      "repo": "hid-system (backend)",
      "owner": "coordinator",
      "size": "S-M (2-3 days, already built)",
      "depends_on": "3, and the owner's re-signature"
    },
    {
      "order": 5,
      "piece": "Renumber the virus scanner (scan-be 2f3fd361) to 0105 and release it with GuardDuty scan-tf b51bd90b and scan-tf-cap once the owner re-signs. Check that a clean scan turns a Demo Hospital upload readable.",
      "repo": "hid-system (backend + infra)",
      "owner": "coordinator + DevOps",
      "size": "M (3-5 days, already built)",
      "depends_on": "2 and 4"
    },
    {
      "order": 6,
      "piece": "Entry points and the paper records page: 'Bring in paper records' in Next steps and on the visit's Documents card (in place of 'Extract with OCR'), the plain 'can't use it' lines (permission, write access, under 18, emergency, Demo Hospital only), the new patients/open/paper route with nothing in the address, the 'Paper records' list with plain statuses, and the migrate. start page.",
      "repo": "health (website)",
      "owner": "Rahman",
      "size": "M (3-4 days)",
      "depends_on": "1 (mock data until 8 is live)"
    },
    {
      "order": 7,
      "piece": "Phone capture: 'Take photos' (back camera) and 'Choose files', a page strip with Retake, Remove and reorder, a 20-page limit, the blur, dark and too-small check with 'Use anyway' marking the page, orientation-only cleaning (photoMetadata.ts) and a file check (fileSignature.ts) on every page, online and offline, and the pages joined into one PDF without re-encoding. Test by hand on Android Chrome and iPhone Safari.",
      "repo": "health (website)",
      "owner": "Lekan",
      "size": "M (4-5 days)",
      "depends_on": "2 (works against mock storage before that)"
    },
    {
      "order": 8,
      "piece": "Backend plumbing: list a patient's documents including ones with no visit; GET /ocr/jobs?patientId with plain status; reading starts by itself when a paper record's virus check comes back clean (instead of staff pressing a button); and the 500 pages per facility per month allowance (counter, 'pages left' route, warning at 80%, reading paused at 100% while checking and adding by hand stay open, only the super admin raises it). New migrations take the next free numbers after the agreed chain (0114 and up, after Akos 0108-0113), and the owner re-signs each one.",
      "repo": "hid-system (ehr-api, ocr-api)",
      "owner": "coordinator",
      "size": "M (6-8 days)",
      "depends_on": "4 and 5"
    },
    {
      "order": 9,
      "piece": "Text reading version 2: keep each line's page, position, confidence and handwriting flag (AnalyzeDocument / StartDocumentAnalysis, with the IAM change) as working data only, and make sure every page of a multi-page PDF is read.",
      "repo": "hid-system (ocr-worker, infra iam.tf)",
      "owner": "coordinator + DevOps",
      "size": "M (4-5 days)",
      "depends_on": "5"
    },
    {
      "order": 10,
      "piece": "AI reading on the Claude API (global). A new step after Textract that turns the read lines into typed items (medicine, diagnosis, allergy, note, later lab and vitals), each pointing to its real line, with numbers and dates checked word for word. It also reads the name and date of birth printed on the paper and suggests choices for the 'Change' lists. Logs hold only IDs, hashes and token counts. Port and fix scratchpad ocr-script/ocr_extract.py (19 open findings, task #182), moving it from Bedrock to the Claude API. Infra: give ocr-worker the Anthropic key, outbound HTTPS to api.anthropic.com only, and a monthly spending cap.",
      "repo": "hid-system (ocr-worker, infra workloads.tf/platform.tf)",
      "owner": "coordinator + DevOps",
      "size": "L (8-10 days)",
      "depends_on": "9"
    },
    {
      "order": 11,
      "piece": "Item checking and publishing the whole set: new OCR tables for found items, saved drafts and per-item decisions; GET /ocr/jobs/:id/items and PUT review-draft; validation accepting a set of item decisions (widening the 0016 checks and assertCandidateClassification); a 'wrong patient' outcome that stops the paper; one publish of the whole set with a per-item retry key held on the server; new EHR tables for imported diagnoses, medicines (history only), allergies and notes, with no made-up visit; chart reads 'From paper records' under direct care. Step 1 covers medicines, diagnoses, allergies and notes.",
      "repo": "hid-system (ocr-api, ehr-api)",
      "owner": "coordinator",
      "size": "L (10-12 days)",
      "depends_on": "10"
    },
    {
      "order": 12,
      "piece": "Short lists for 'Change': medicines seeded from the Nigeria Essential Medicines List, common conditions, then lab test names (MP, mRDT, Widal, PCV, FBC, E/U/Cr) and units, checked by a clinician and a lab scientist.",
      "repo": "hid-system (terminology tables)",
      "owner": "coordinator (content checked by Ola and a pilot clinician)",
      "size": "M (4-5 days)",
      "depends_on": "11"
    },
    {
      "order": 13,
      "piece": "The check screen: page picture beside the cards; the 'Is this Amina's paper?' card first; item cards with page cut-out, words as written, Accept / Change (pick lists or one number) / Remove (reason list); 'Add something that was missed' by tapping the page; progress count; no 'Accept all' for medicines, allergies or labs; saved as they go; a 'check by' time; the Publish bar and summary with per-item 'Try again'; chart 'From paper records' groups with who checked and published. All failures in plain words with no codes.",
      "repo": "health (website)",
      "owner": "Ola",
      "size": "L (7-9 days)",
      "depends_on": "6 (mock data first), then 11 and 12"
    },
    {
      "order": 14,
      "piece": "Accuracy test on fictional paper records (clinic cards, prescriptions, discharge letters, handwritten and printed). Pass marks: at least 99% medicine accuracy after checking and under 1% unsupported items. Ola labels with one pilot clinician.",
      "repo": "hid-system (ocr-worker test set)",
      "owner": "Ola",
      "size": "M (4-5 days)",
      "depends_on": "10, 11 and 13"
    },
    {
      "order": 15,
      "piece": "Demo Hospital rehearsal of Step 1 on ehr. and migrate., on an Android phone and an iPhone, with the demo patients (Adaeze, Chinedu). Migrate stays off at real facilities.",
      "repo": "both",
      "owner": "coordinator",
      "size": "S (2 days)",
      "depends_on": "7, 8, 13 and 14"
    },
    {
      "order": 16,
      "piece": "24-hour working data: a migration that allows clearing raw text, AI output, line positions, drafts and rejected suggestions (0013 blocks every delete today), plus a scheduled clear-out after 24 hours and an expiry time on each paper for the 'check by' line.",
      "repo": "hid-system (ocr-api, database)",
      "owner": "coordinator",
      "size": "M (4-5 days)",
      "depends_on": "11"
    },
    {
      "order": 17,
      "piece": "Corrections. Backend: a new permission ehr.import.correct (doctors and clinicians only), entered-in-error on every imported item, 'wrong patient' withdrawal of a whole paper in one step, withdraw routes for lab and pharmacy imports, and a notice to the facility. Website: the 'Mark as entered in error' and 'Wrong patient' buttons.",
      "repo": "hid-system (ehr-api, lab-api, pharmacy-api) + health",
      "owner": "coordinator (backend), Ola (screens)",
      "size": "M (6-7 days)",
      "depends_on": "11"
    },
    {
      "order": 18,
      "piece": "Step 2 items: lab results linked to the paper, vitals, and 'Prescribe from this scan'. That button fills the existing prescription form, keeps the paper prescriber and date, links back to the scan, warns about the same medicine prescribed today, and is shown only to existing prescribers. The pharmacy guard stays as it is.",
      "repo": "hid-system (ehr-api, lab-api) + health",
      "owner": "coordinator (backend), Ola (screens)",
      "size": "M-L (7-9 days)",
      "depends_on": "11 and 13"
    },
    {
      "order": 19,
      "piece": "A 'Waiting to be checked at this facility' list on the migrate. start page (a facility queue, showing name and age, audited), so papers left unchecked are not forgotten.",
      "repo": "hid-system (ocr-api) + health",
      "owner": "coordinator (backend), Rahman (screen)",
      "size": "M (4-5 days)",
      "depends_on": "8 and 16"
    },
    {
      "order": 20,
      "piece": "Before real patients (owner and non-code, decisions 33-11 and 33-12): DPIA signed for Claude API global processing, AWS AI services opt-out confirmed, a pilot facility and clinical safety lead named. Then switch Migrate on at the pilot facility.",
      "repo": "none (governance) + feature switch",
      "owner": "coordinator (owner signs)",
      "size": "S",
      "depends_on": "15, 16, 17 and 18"
    },
    {
      "order": 21,
      "piece": "Later: the same photo capture for lab staff on a lab work item on lab., because lab staff never open the full chart.",
      "repo": "health + hid-system",
      "owner": "Lekan (screen), coordinator (backend)",
      "size": "M",
      "depends_on": "20"
    }
  ],
  "owner_questions": [
    {
      "question": "Reading paper records needs its own 24-hour OK from the patient, separate from the OK to see their record. Today that means a second request on the patient's phone, and the Access PIN doesn't cover it. Should one OK cover both for that visit?",
      "recommendation": "Yes. Let the first request, or the Access PIN, cover both seeing the record and bringing in paper records for 24 hours, and say so clearly to the patient. Patients without a phone at the desk can then still be helped. Under-18s stay refused, and the patient can still say no."
    },
    {
      "question": "Migrate itself never asks for anything, but to open a patient, staff still enter the Health ID from the patient's card (or tap the patient under 'Shared with you'). Is that one entry acceptable as the way to find the patient, with nothing else typed anywhere in Migrate?",
      "recommendation": "Yes, for now. It is the same short number printed on the patient's card that the EHR already uses, and it keeps the right patient every time. Later, the 'patients seen here in the last 30 days' list you approved in decision 33-5 will let staff tap the patient instead. A facility-wide search of all patients is not recommended (privacy)."
    },
    {
      "question": "Can the same person check the items and press Publish, and can nurses publish, or must a doctor or clinician publish?",
      "recommendation": "Allow one person (doctor, clinician or nurse) to check and publish. Every item is checked one by one, medicines, allergies and labs have no 'Accept all', and only doctors and clinicians can correct mistakes later. A scanned prescription still becomes an order only when an EHR prescriber signs it. A second checker would slow small clinics a lot for little extra safety."
    },
    {
      "question": "Many clinic cards show only a folder number, not the patient's name. Can such a paper be published after staff confirm it is this patient's?",
      "recommendation": "Yes, with a stronger warning ('This paper has no name on it. Check the folder number with the patient before you go on.'). Record who confirmed it, and let doctors and clinicians withdraw it in one step if it turns out to be someone else's."
    }
  ],
  "summary": "I compared both designs and recommend a mix built mostly on Design A. Staff bring in paper records from the patient they already have open, and Migrate never asks for a patient, a document number or anything else typed.\n\n**The flow:** open the patient as usual, then tap \"Bring in paper records\". If needed, the patient says yes once on their phone for 24 hours. Staff take up to 20 photos with the phone camera, with a warning on blurred pages, and the system checks the file for viruses and reads it by itself. From Design B it borrows the order of checking: first \"Is this Amina's paper?\", then each found item as a card with its piece of the page and Accept / Change / Remove, where Change and Remove are picked from short lists. One Publish then adds everything accepted to the chart under \"From paper records\". A scanned prescription becomes an order only when an EHR prescriber taps \"Prescribe from this scan\" and signs the usual form. Doctors and clinicians can later mark an item as entered in error, and nothing is deleted.\n\n**Why this mix:**\n- **Fewest taps:** no patient list, no visit choice and no \"kind of paper\" choice.\n- **Safest for the right patient:** the patient comes from the chart, and the name and date of birth on the paper are checked before any item is shown.\n- **Ships soonest:** it needs no new facility patient list, and publishing uses the access the chart already has.\n\n**What has to happen first:** the storage CORS rule applied by DevOps, records processing released as 0104 and the virus scanner as 0105 (both already built; you re-sign each). After that, the new backend work is the AI reading on the Claude API, item checking and publishing. The website can remove the ID and JSON boxes this week (Lekan) and build the new screens against Demo Hospital practice data meanwhile. The phone camera part is Lekan's, the entry buttons Rahman's, and the checking screen and accuracy test Ola's.\n\n**Timing:** about 5 to 6 weeks of backend work (after the three releases above) to a Step 1 rehearsal at Demo Hospital (medicines, diagnoses, allergies, notes). Step 2 adds:\n- 24-hour clean-up\n- corrections\n- lab results and vitals\n- \"Prescribe from this scan\"\n- a \"Waiting to be checked\" list\n\nMigrate stays off at real facilities until Step 2 is done, the DPIA (data protection impact assessment) is signed and a pilot facility and clinical safety lead are named.\n\n**Four questions need your answer** (my recommendation in brackets):\n1. Should one OK from the patient cover both seeing the record and bringing in paper records? (Yes.)\n2. Is the Health ID from the patient's card acceptable as the one thing entered to open a patient? (Yes, until the \"seen here in the last 30 days\" list.)\n3. Can one person, nurses included, check and publish? (Yes.)\n4. Can a paper with no name on it be published after staff confirm it is this patient's? (Yes, with a stronger warning.)\n\nI worked read-only and changed nothing in either repository."
}
```
