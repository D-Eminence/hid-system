# EHR readiness audit plan (3 Nov 2026)

```json
{
  "product": "Hospital EHR (blue) with Migrate, on ehr., lab., pharmacy., outreach. and migrate. Website live at health main d66dd307, backend live at hid-system staging-novu-ci-20261005 34d69557.",
  "readiness_percent": 88,
  "how_counted": "Parity list of 252 rows from the baseline (f2c08fc), re-rated against live main d66dd307 plus tonight's batch. Counts: 186 live, 6 shipping tonight (counted as done, but they are not live until the batch ships: #9 PIN and Ask the patient 2 rows, #13 refused lookup said aloud 2 rows, #22 asking before any lookup 1 row, End my access keeping focus 1 row), 53 partial, 2 sample, 1 missing, 4 retired by owner decision (classic EHR stays removed, app. is for patients only). Weights: live = 1, shipping tonight = 1, partial = 0.5, sample and missing = 0. The 4 retired rows are not counted, so the base is 248 rows: (186 + 6 + 0.5 x 53) / 248 = 218.5 / 248 = 88.1%, which rounds to 88%. If the retired rows are counted as done over all 252 rows, the result is 222.5 / 252 = 88.3%. Without tonight's batch (live only: 186 live, 59 partial): (186 + 29.5) / 248 = 86.9%. Two finished PRs that are not in the batch (health#83 and health#87) would add 3 rows, about 0.6 points. About 66 rows in baseline section 3.1 were rated as groups rather than row by row, so the counts can be off by about 3 rows (about 1 point). This number only measures EHR screen parity. It does not cover Migrate's real job. No uploaded file can be opened or read in production today, so in practice Migrate is not usable for moving paper records.",
  "works_today": [
    "Real clinics can today: find a patient by Health ID, get access by asking the patient, PIN or emergency, then run the visit, notes, vitals, diagnoses, prescriptions, lab requests and results, pharmacy dispensing, NIN registration and staff invites. Real clinics cannot today: open or read any uploaded file (production has no virus checker), bring paper records in through Migrate, take payments or manage stock, see a list of all patients at the facility, or attach paper results to lab and pharmacy work.",
    "Every product site (ehr., lab., pharmacy., outreach., migrate.) has the right menu with Patients and Access requests. No site loops or opens on a refusal, and an unknown address shows a real Page not found.",
    "Staff can find a patient by Health ID and get access in three ways: ask the patient, use the patient's Access PIN, or use emergency access. They can end access themselves, and the access request list says plainly that a pending request gives no access.",
    "Doctors and nurses can start and close a visit and write, revise and sign notes. Nursing notes show on the doctor's Notes card. Vitals accept decimals and older vitals are paged. Diagnoses and documents are recorded, and closing a visit shows the full warning.",
    "Prescriptions and lab requests are safe to write: dose and unit are optional but must be given together, so nobody has to make up a dose. Orders go to the hospital's own lab or pharmacy, or to another facility.",
    "The lab can register a sample, collect or reject each sample with its own note, start and finish a test, enter results, then check and release them.",
    "A stand-alone pharmacy opens on Prescriptions with incoming work at the top. The pharmacist types the dispensing reason and can undo a dispensing.",
    "Emergency access works end to end: the emergency summary, refreshing it, and released results.",
    "Front-desk NIN registration, staff and invitations, the audit trail in local time without codes, Outreach cases, staff password recovery and facility sign-up all reach real backend routes.",
    "Real facilities never see the demo shop pages (payments, stock, walk-ins), the sample half of HR, sample setup steps, Facility settings or Reports. Those stay demo-only, as the owner ruled.",
    "Errors on staff pages are in plain words, with no server text, codes or status numbers. (#107 completes this tonight.)",
    "Staff chat ('Ask about this patient') works on ehr. It sends record extracts to the Claude API with worldwide processing (see owner decisions)."
  ],
  "plan": [
    {
      "rank": 1,
      "item": "Access request length: the box allows 1 to 60 minutes, but Health ID only accepts 5 to 1440, so 1-4 minutes is refused with no clear reason. Set the lowest value to 5 (ehr-blue/clinical/consent/RequestAccess.tsx:38,143; server rule identity-api create-access-request.dto.ts:23-24).",
      "why": "Broken. A clinician gets a refusal they cannot understand on the most-used access screen.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 2,
      "item": "On lab. and pharmacy., a patient's page and Find a patient offer Open chart, Start a consultation, Record vitals, Open emergency summary and Emergency access. Each one silently sends the person back to Home. Hide these buttons with opensInProduct, or link to the same page on ehr. (clinical/patients/PatientPage.tsx:231-232,243-244; PatientsWorkspace.tsx:170,206; frame/BlueFrame.tsx:185).",
      "why": "Broken. A hospital doctor using lab. or pharmacy. loses time in an emergency and is never told why.",
      "owner": "Rahman",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 3,
      "item": "The lab work list asks for payment settings at real facilities, and that request fails every time the list opens. Gate it with pointOfCareOpen, as Pharmacy already does (departments/laboratory/Laboratory.tsx:93).",
      "why": "Broken. A failing request on the lab's main screen, every day.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 4,
      "item": "Reproduce, against production, the possible refusal when registering someone into an Outreach campaign (outreach.campaign_members FOR SHARE database rule, from the task #205 note). Fix it with a migration if confirmed.",
      "why": "Possibly broken and not yet checked. If real, outreach registration fails at real facilities.",
      "owner": "coordinator",
      "size": "S",
      "needs_backend": true
    },
    {
      "rank": 5,
      "item": "Emergency screens: remove 'every view is reviewed' from the notice, the tick box staff must tick, and the summary. Say only what is true: the patient is told, access ends after the set time, every opening is recorded (clinical/emergency/access.ts:28, BreakGlass.tsx:25, EmergencySummary.tsx:20; task #209).",
      "why": "Misleading on a high-stakes screen. Staff sign a statement about a safeguard that does not exist, which is an NDPA accountability problem.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 6,
      "item": "Until a virus checker runs in production, stop promising 'It can be opened once the virus check is done'. Say plainly that files are kept safely but can't be opened yet at this facility (plainLabels.ts:101; clinical/consult/Documents.tsx:90; departments/migrate/DocumentCapture.tsx:73-75).",
      "why": "Misleading. A clinic waits for a file that will never open.",
      "owner": "Lekan",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 7,
      "item": "Patient registration: remove server wording ('backend', 'API', 'identity service', 'governed', 'NIN verification is enabled in <mode> mode', the raw capabilities.nin.state) and ids on screen ('Case <id>', the Version column, 'Patient ID: <id>', the 'Registration case ID' box) (departments/registration/registrationText.ts:31,47,67-68,70,77,81-82,86,101,106-107,116-121,156; RegistrationList.tsx:14,42-43,56,104; RegistrationRecord.tsx:86-88,100,130).",
      "why": "Breaks the owner's no-codes, no-ids rule on the first screen receptionists use, every day.",
      "owner": "Ola",
      "size": "M",
      "needs_backend": false
    },
    {
      "rank": 8,
      "item": "Migrate Document OCR page: replace the 'Document UUID' and 'Patient UUID' boxes with choosing a patient and then their document. Remove 'Job 1a2b3c4d', 'Patient 1a2b3c4d' and 'textract · version 3'. Correct the note 'No role holds the OCR work': doctors, nurses and lab staff hold it (departments/migrate/Migrate.tsx:34,204,226,228,316-367; ocrSteps.tsx:85,175).",
      "why": "Breaks the owner's no-ids rule, and real clinical staff can see the page. Staff cannot find a document without copying an id.",
      "owner": "Lekan",
      "size": "M",
      "needs_backend": false
    },
    {
      "rank": 9,
      "item": "Make every sample workspace (Appointments, Wards, Maternity, Theatre, Billing and about 20 more) open only at demo facilities, not just leave it out of the menu. Also stop the sample 'Saved record' / 'Saved <date>' words and the sample My profile drawer from showing at real facilities (frame/pageAccess.ts:14; frame/sampleAccess.ts:104-108,135-138; departments/parts/sample/SampleDetail.tsx:88,92; clinical/parts/Detail.tsx:21).",
      "why": "Misleading. A typed or bookmarked address shows invented rows and a 'Create record' that keeps nothing. It also breaks the demo-only rule.",
      "owner": "Rahman",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 10,
      "item": "Home and the bell say access requests need staff action ('Review and send them on'), and 'All clear' shows even when nothing was read. Say the request is waiting for the patient, and only show 'All clear' after a successful read (home/BlueHome.tsx:96,130; frame/TopBarParts.tsx:138).",
      "why": "Misleading, every day. Staff think they must act on requests that are waiting for the patient.",
      "owner": "Rahman",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 11,
      "item": "Staff sign-in on lab. and pharmacy. says 'Sign in to your hospital workspace' and 'Continue to the Hospital EHR'. Use each product's own name (frame/auth/BlueSignIn.tsx:95,99). In the same pass, give Facility profile on lab. and pharmacy. product wording instead of hospital wording ('Hospital name', 'Bed count', 'Medical Director') (departments/facility/FacilityProfile.tsx:100-131).",
      "why": "Misleading. Every staff member at a stand-alone lab or pharmacy is told they are in a hospital system.",
      "owner": "Rahman",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 12,
      "item": "The 'Today' card on Home labels every lab test 'Laboratory · accepted'. Show the Laboratory page's own stage instead: Collect, Testing, Enter results, Check & release, Done (home/liveCards.tsx:245; home/BlueHome.tsx:89; words in departments/laboratory/stage.ts).",
      "why": "Misleading. A doctor cannot see which results are ready.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 13,
      "item": "The wrong-patient panel says to use a button 'on its row in the work list below'. That button is only inside the opened request, so point there (staff/routes/WrongPatient.tsx:33-37).",
      "why": "Misleading. It sends staff looking for a button that isn't there.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 14,
      "item": "Outreach pages on ehr. show 'case 1a2b3c4d', 'Reference <id>', raw campaign statuses and 'No further actions for your permission and this record state'. Fix the same sentence in HR (departments/outreach/outreachParts.tsx:14,39-46,94; OutreachCaseView.tsx:83,175; OutreachCampaignView.tsx:58,73; Outreach.tsx:307; hr/HrCredentials.tsx:37).",
      "why": "Breaks the owner's no-ids rule on a page outreach officers use every day.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 15,
      "item": "Ship tonight's batch with the merge fixes already worked out. In clinical/consult/Documents.tsx, #122 and #107 conflict: keep both imports and use documentTypeRefusalText(caught) ?? plainErrorText(...). In frame/BlueFrame.tsx and frame/pageAccess.ts, #102 and the lab. menu fix conflict: keep pageUsable and productUsable, and call otherSitesGroup(allowed.filter(pageUsable...), backPath). #64, #124 and #125 conflict only in tests. A scratch merge is at scratchpad/pr-tonight (19e05152).",
      "why": "Blocked release. The 6 'shipping tonight' rows only count once this is live.",
      "owner": "coordinator",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 16,
      "item": "Confirm the documents storage bucket's CORS rule is applied in production (origin/dev 36838470, infra/terraform/modules/data/main.tf:146), then do one test upload at Demo Hospital.",
      "why": "Blocked. If the rule is off, every upload on ehr., lab., pharmacy. and migrate. fails.",
      "owner": "DevOps",
      "size": "S",
      "needs_backend": true
    },
    {
      "rank": 17,
      "item": "Finish and release the GuardDuty virus checker: Terraform, a scanner that posts to POST /ehr/documents/scan-events, and the release declaration the owner already approved in decision 3. DevOps applies it per the runbook.",
      "depends_on": "Rank 16 (uploads must work first)",
      "why": "Blocked. Without it no file ever opens, document reading never shows, and Migrate cannot read anything (document.service.ts:246; ocr.service.ts:134).",
      "owner": "coordinator",
      "size": "L",
      "needs_backend": true
    },
    {
      "rank": 18,
      "item": "Akos steps 3-4: send the patient's name, age and sex (0106) and the medicine details (dose form, strength, quantity, priority: 0107) on the hospital's own lab and pharmacy work. The website already shows them once they are sent (labSteps.tsx:82; PharmacyRecord.tsx:397).",
      "why": "Blocked on the backend. Without it there is a wrong-patient risk on lab and pharmacy cards. Owner decision 23 says build now.",
      "owner": "coordinator",
      "size": "M",
      "needs_backend": true
    },
    {
      "rank": 19,
      "item": "Rebase and ship health#83 (Lab check and release as two steps, each with its own reason) and health#87 (result history only for roles that can read released results) in the next batch.",
      "why": "Built but not released. Closes 3 parity rows. Today one press checks and releases a result with one reason.",
      "owner": "coordinator",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 20,
      "item": "Rate-limit staff chat on the gateway the same way patient chat is (limit_req, body cap, timeout) (gateway/nginx.conf.template:85-101).",
      "why": "Without a limit, AI costs can grow without bound inside the USD 400 a month budget.",
      "owner": "coordinator",
      "size": "S",
      "needs_backend": true
    },
    {
      "rank": 21,
      "item": "Decision 8: tell the patient each time emergency access is used, including which kinds of information were seen, in hid-1.0's format (task #190; identity-api record-access-notice.service.ts:23).",
      "why": "Missing. The owner approved this and it matters under NDPA.",
      "owner": "coordinator",
      "size": "M",
      "needs_backend": true
    },
    {
      "rank": 22,
      "item": "Lab single-scientist rule: until the owner decides, tell staff before they enter a result that a second person must check it (database rule 0021_lab_result_verification_release.sql:76; nothing in departments/laboratory/*).",
      "depends_on": "Owner decision on one-person labs",
      "why": "A small lab will believe its results are stuck.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 23,
      "item": "The approved keyboard-focus follow-up (decision 31f): Send access request and Close access. In the same pass: lab Start test and Finish test, Results Refresh, Accept on shared-record invitations, and the Choose workspace buttons (RequestAccess.tsx:157; RequestDetail.tsx:158; labSteps.tsx:302,325; Results.tsx:69; SharingCards.tsx:152; ChooseWorkspace.tsx:94).",
      "why": "Missing. Already approved. Keyboard and screen-reader users lose their place on the most-used buttons.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 24,
      "item": "After registering a patient, add an 'Open in Patients' button that hands over the Health ID (departments/registration/Registration.tsx; registrationText.ts:147).",
      "why": "The 1 missing parity row. Today staff retype the Health ID.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 25,
      "item": "A findable list of registration cases (for example, recent cases at this facility) so a half-finished registration can be picked up again without pasting an id. This needs an identity-api read first.",
      "depends_on": "Rank 7",
      "why": "Missing. Today cases are lost when the page reloads.",
      "owner": "coordinator",
      "size": "M",
      "needs_backend": true
    },
    {
      "rank": 26,
      "item": "Show today's vitals values (blood pressure, temperature and so on) on the visit page, not only 'Vitals · <date>' links (#3) (clinical/consult/EncounterPage.tsx:182,508-511,559).",
      "why": "Partial, every day. Doctors have to leave the visit to see today's vitals.",
      "owner": "Ola",
      "size": "M",
      "needs_backend": false
    },
    {
      "rank": 27,
      "item": "A visit's order list: show where each order is (declined, couldn't complete) and add row actions (#5) (clinical/consult/orders/index.tsx:211-218).",
      "why": "Partial, every day. A declined prescription isn't seen until the order is opened.",
      "owner": "Ola",
      "size": "M",
      "needs_backend": false
    },
    {
      "rank": 28,
      "item": "The patient page: show medicines, conditions, imported history and 'Ask about this patient', not only allergies (#8) (clinical/patients/PatientPage.tsx:58-100,216-218). Also show more than the first page of 'Visits here' and add Refresh (#24) (PatientPage.tsx:297-314), and make 'Open now' go to the chart.",
      "why": "Partial, every day. Staff see an incomplete patient.",
      "owner": "Ola",
      "size": "M",
      "needs_backend": false
    },
    {
      "rank": 29,
      "item": "Access requests list: add a close action on each row, and show the method, expiry and denied reason (#23) (clinical/consent/ConsentWorkspace.tsx:87-94).",
      "why": "Partial, every day. Grants are left to run out instead of being ended.",
      "owner": "Ola",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 30,
      "item": "Remaining small clinical rows: opening a visit sends about 10 requests (#25, EncounterPage.tsx:179-187); the top Sign button signs only the newest note (Notes.tsx:126); lab 'We can't complete this order' closes the open request (#26, Laboratory.tsx:153-157); 'Shared with you' and Invitations need the patient-lookup permission (#14, SharingCards.tsx); 'Find a patient' sends rare roles to Home (parts/chart.tsx:193-202).",
      "why": "Partial. Slower opens on poor networks and some extra steps.",
      "owner": "Ola",
      "size": "M",
      "needs_backend": false
    },
    {
      "rank": 31,
      "item": "Outreach: add forms to start a campaign, add members and change a campaign's status. The backend already serves all three.",
      "why": "Missing. Outreach teams depend on support to set up each campaign. It comes after EHR in the owner's order.",
      "owner": "Ola",
      "size": "M",
      "needs_backend": false
    },
    {
      "rank": 32,
      "item": "Document types on the backend, so Lekan's #64 lab and pharmacy document cards can be switched on. Pick one of the two duplicate fixes for 'application/pdf' → 'PDF · 20 KiB · Checked' (health#127 742b578a or the lekan-followups branch d3f25833) and close the other. Do the same for #128 against 8140beb7.",
      "why": "Built but not released. Labs and pharmacies cannot attach paper results yet, and the duplicate PRs will conflict.",
      "owner": "Lekan",
      "size": "M",
      "needs_backend": true
    },
    {
      "rank": 33,
      "item": "Migrate's approved design: AI reading on the Claude API, a scanned prescription becoming an active order, phone-camera capture, and deleting working data after 24 hours. This includes the records-processing migration and the renumbering (decision 18).",
      "depends_on": "Rank 17 (virus checker)",
      "why": "Missing. This is what lets a clinic move its paper records in.",
      "owner": "coordinator",
      "size": "L",
      "needs_backend": true
    },
    {
      "rank": 34,
      "item": "Frame polish: switching facility in one step; 'This provider page is unavailable' → 'We can't find that page.' (NotFoundPage.tsx:5); restore 'Card details never pass through Health ID.' on Pay now; the Facility check 'Done' card on lab. and pharmacy.; the facts the Staff & access pop-ups dropped ('Its link and code no longer work.').",
      "why": "Polish. Rare or one extra step.",
      "owner": "Rahman",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 35,
      "item": "Check on real phones at 320-390px: document rows (white-space: nowrap at clinical.css:906-911; also rename 'Extract with OCR' to plain words) and the five-step lab track (LabRequest.tsx:50 grid-cols-5). Fix the Done tab's 'Nothing done yet today', which isn't limited to today (Laboratory.tsx:196).",
      "why": "Polish. These were only checked from the CSS, because there is no browser in the audit environment.",
      "owner": "Rahman",
      "size": "S",
      "needs_backend": false
    },
    {
      "rank": 36,
      "item": "In-person check wording: 9 rows still use long wording and 'Ask a platform administrator' (departments/inperson/inPersonRules.ts:16,132-150).",
      "why": "Polish. The page never shows today, because its backend route and permission don't exist.",
      "owner": "Ola",
      "size": "M",
      "needs_backend": false
    },
    {
      "rank": 37,
      "item": "Later, after parity, per the owner's order: point of care (payments, stock, walk-ins), the facility subscription with Paystack, the in-person check backend route and permission, SSO go-live (VITE_HID_SSO after Identity SSO, task #207), the #61 Help assistant after the support-api check, offline (#35 and #39), and raising the lab work-list limit (decision 27).",
      "why": "Not parity. Kept demo-only or switched off until then.",
      "owner": "coordinator",
      "size": "L",
      "needs_backend": true
    }
  ],
  "owner_decisions": [
    {
      "question": "Staff chat ('Ask about this patient') sends record extracts to the Claude API with worldwide processing, while decision 6 moves chat to the EU (Google Cloud 'eu'). What happens until the move?",
      "recommendation": "Keep it on only if the privacy review (DPIA) is updated now to say plainly that chat is processed worldwide until it moves. If that can't be done this week, switch staff chat off until the EU move. Either way, add the staff-chat rate limit (plan rank 20)."
    },
    {
      "question": "Emergency access promises 'every view is reviewed'. Reword it, or build a real review?",
      "recommendation": "Reword it now (plan rank 5). Then decide separately whether a facility admin should review each emergency opening. A simple 'emergency openings this week' list for facility admins would make the promise true later."
    },
    {
      "question": "A lab with one scientist can never release a result, because the person who entered it cannot check it.",
      "recommendation": "Keep the two-person check as the default for safety. Allow a one-person facility to release with a typed reason that is logged and shown in the audit trail. Until then, warn staff before they enter a result (plan rank 22)."
    },
    {
      "question": "Clinical codes (ICD-10 J45, LOINC 2345-7, route PO) show next to plain names on the emergency summary and on lab results. Do they break the 'no codes on screen' rule?",
      "recommendation": "Show the plain name first and move the clinical codes under a 'More details' line. Doctors who want them still have them, and the screen follows the rule."
    },
    {
      "question": "The Workspaces tile grid on Home is gone (Ola's #79 question). Bring it back?",
      "recommendation": "No. The menu already lists every page a role can use, and the tiles would repeat it. Keep Home focused on today's work."
    },
    {
      "question": "There is no list of all patients, visits or reading jobs at a facility. Every task starts by typing a Health ID (care-relationship decisions AC01, AC02, PT06).",
      "recommendation": "After parity, add a 'patients seen here in the last 30 days' list, limited to patients the facility already has access to. It keeps the consent rule and removes most typing."
    },
    {
      "question": "Typed 'SIGN' step when signing a note: keep it?",
      "recommendation": "Keep it for now. It is one deliberate step on a legal record. Fix the top Sign button so it is clear which note it signs."
    },
    {
      "question": "Offline EHR (#35, #39) waits for the offline escrow secret (decision 11).",
      "recommendation": "Create the secret only when offline work is next in the owner's order. It is not needed for parity or for the pilot."
    }
  ],
  "summary": "The blue EHR is at 88% parity: 186 rows live plus 6 shipping tonight, 53 partial worth half each, 1 missing and 2 samples, out of 248 rows (4 are retired by owner decision). Without tonight's batch it is 86.9%. Real clinics can already do their daily clinical, lab and pharmacy work. Every call the main screens make exists on the live backend. The urgent safety fixes (prescription dose, nursing vitals, vitals decimals) are live, and demo-only features stay demo-only for point of care, settings and reports.\n\nMigrate is a different story. Production has no virus checker, so every uploaded file stays 'Being checked for viruses' forever, never opens and can never be read. Nobody has confirmed the storage rule that uploads need is switched on. Migrate cannot bring in paper records today.\n\nWhat remains:\n- **Broken (4):** the access-request length allows 1-4 minutes, which the server refuses; hospital-only buttons on lab. and pharmacy. send people silently back to Home; the lab work list makes a payment-settings request that always fails; a possible Outreach campaign refusal still needs checking.\n- **Misleading:** the untrue 'every view is reviewed' promise on emergency access; the virus-check promise on uploads; ids and server words in patient registration, the Migrate page and Outreach (against the owner's rule); sample pages that open by typed address at real facilities; Home saying requests need staff action.\n- **Blocked:** tonight's batch, with known merge fixes; the CORS check (DevOps); the virus checker; patient name, age and sex on lab and pharmacy cards (wrong-patient risk); the finished fixes #83 and #87.\n\nMost of the rest is small website work for Ola (clinical) and Rahman (frame). The owner needs to decide on chat processing, the emergency review, one-person labs and clinical codes.\n\nRead-only: nothing was committed, pushed, posted or edited. The audits' worktrees are in /tmp/claude-0/-home-user/9e2fd816-d904-5725-a775-049f6f6c7bf9/scratchpad (pr-live, pr-tonight, ehra2/web, ehra2/be, a3e-107, a3e-health). The owner decisions used are in /tmp/claude-0/-home-user/9e2fd816-d904-5725-a775-049f6f6c7bf9/scratchpad/owner-decisions-2026-11-01.md."
}
```
