# Owner decisions, 1 Nov 2026 (in chat, D-Eminence)

1. hid-system branches: Claude may push branches named `claude/ecstatic-ramanujan-q4i1eo-<topic>` (one per change).
2. Backend release order (recommended, approved): pharmacy guard first (keeps 0100), then records processing (0101), document scanner (0102), support check (0103). The chain is renumbered from 0100/0101/0102.
3. Release declarations: the owner approves signing all four (pharmacy guard, records processing, scanner, support check). Record the owner as reviewer citing this chat; tell the owner before each release.
4. Pharmacy existing-work-items audit query: approved (read-only, no patient data; run by someone with production read access).
5. Budget: USD 400 a month for ALL of Health ID's AWS costs (owner correction: not just Migrate), with room for more pilot facilities and users. Migrate/OCR and any Bedrock chat must fit in what is left after the rest of the stack.
6. Migrate design: recommendations approved, with these changes:
   - A scanned prescription CAN become an active order (some facilities write by hand, then scan). Supersedes decision 2 of ocr-fhir-decisions.md (history only).
   - The patient chat assistant may use all record history, imported or entered, and must say where each fact came from: the patient's own input, or healthcare professionals (and scanned paper records).
   - Owner asked what "working data" and "corrections" mean (explained in chat).
   - Working data (raw Textract text, raw model output, rejected suggestions, run details) is deleted after 24 hours, not 90 days, to save cost.
   - Corrections: approved as recommended (doctors and clinicians only, entered-in-error, nothing deleted, every correction logged, facility told of wrong-patient withdrawals).
   - AI costs go to the Anthropic Claude API (as chat already does), not Bedrock, where possible, so the AWS bill stays under USD 400. Chat stays on the Claude API (not moved to Bedrock). Owner chose the Claude API for Migrate's AI reading (asked explicitly: global processing, no EU-only option, replaces the Bedrock EU decision; the DPIA must cover it as it does for chat). Textract and the GuardDuty scanner stay on AWS.
   - Owner asked for the Claude API in the EU. Checked live docs: the Claude API offers inference_geo "global" or "us" only and workspace geo "us" only; Claude on Google Cloud (Google managed, Vertex) has an "eu" multi-region endpoint for new models at +10%, billed by Google. Owner's answer: Migrate AI on the Claude API, worldwide (global). Chat assistant moves to the EU (Google Cloud "eu" multi-region), off the AWS bill. (Combination stated back to the owner for confirmation.)
7. EHR: Claude builds the remaining parity work now (151 partial, 6 missing), in the report's order; Ola reviews when back.
8. Emergency access: the patient gets a notice every time emergency access is used, including which emergency details were seen (types of information), in hid-1.0's format.
9. Owner will send the round-14 team message when Rahman, Ola and Lekan are available.
10. Offline documents (health#40): legal review approved. Open placeholders still in the text (DPO contact, effective date, pilot facility, BYOD, risk ratings, NDPA section numbers) to be filled from the owner/legal reviewer.
11. Offline escrow secret: owner to create `/hid/staging/offline-escrow` (steps from hid-system#133).

12. Sign-in across products (owner's end goal, afternoon): app., ehr., lab., pharmacy., outreach., migrate. are standalone products, each with its own landing page, sign-up, sign-in and workspace, working together. No product served under another's path. Signed in on one, opening another the account is authorised for goes straight in with no second sign-in, and back again smoothly. Health ID identity (app. + identity-api) underneath all. Team (Rahman/Ola) recommend OIDC with a central auth. sign-in server and a server-side session per product (host-only cookies) instead of one root-domain cookie; production already refuses a root-domain cookie (identity-api environment.ts: AUTH_COOKIE_DOMAIN must be absent; CODEX host-only rule). Coordinator agrees.
13. Edge: owner told the coordinator to build the edge so each product site's root shows its landing page (team built the pages on the public site at /products/<slug>).

14. Branches: "always create a new branch if needed" - standing permission to create a new branch per change (named claude/ecstatic-ramanujan-q4i1eo-<topic>) in the session's repos, instead of asking each time.
15. SSO library: owner approved adding a certified OpenID provider library to identity-api for the auth. sign-in server (plan: panva's oidc-provider, OpenID Certified; confirm licence and audit gates at build).

16. AWS cost cuts: (1) Container Insights off + alarms on free metrics: approved. (2) Savings Plan and (3) RDS reservation: owner asked for the best option (recommended: Compute Savings Plan, 1 year, no upfront, USD 0.09/hour or AWS's lower recommendation; RDS reserved db.t4g.small PostgreSQL single-AZ eu-west-1, 1 year, no upfront, after confirming the live instance). (4) Bedrock private connection to one zone: approved. (5) ECR old-image clean-up: approved with rollback and backup (keep live, previous and recent releases; record every digest before any expiry). Items 4, 5 and the never-firing scaling policies go into the same Terraform branch as item 1.

17. Product sites and access (owner answers to Ola, afternoon):
   - healthidentitydirectory.com/ keeps its own page; /patients (Health ID Identity landing page) stays on the main site and leads to app.
   - Edge: a session cookie present (hid_access_csrf) -> the workspace (staff sites /provider; app. patient home as today); absent -> the landing page (staff sites: product page; app.: the /patients page).
   - Sign-in buttons go to the workspace entrance (Option A): /provider on staff sites; on app. the patient sign-in (/sign-in, since "/" would loop for a stranger).
   - EHR is the whole hospital system; Lab, Pharmacy, Migrate, Outreach are part of its workspace and also standalone sites. Within the EHR, department staff see only their own module's part of a patient's record; EHR (clinical) staff see the whole record. Access still requires the patient's authorisation (consent, PIN or emergency).
   - Patient registration stays in the EHR only (not on standalone sites).
   - Product side uses the certified token checker (panva openid-client).

18. Migration numbering after the pharmacy review: the pharmacy guard is two migrations (0100 acceptance, 0101 dispensing), so the chain becomes records processing 0102, document scanner 0103, support check 0104. PR hid-system#139 carries 0100/0101 with reviewed_by D-Eminence.

Earlier the same day: classic EHR stays removed (owner, 31 Oct, confirmed 1 Nov); the 5 urgent blue EHR fixes approved for build and release.

19. Website re-pin after the pharmacy guard release (evening): "Approve re-pin" (D-Eminence, 2026-11-01). health#106 pins every service to 6c6fc18 (backend release backend-41333594692-1-124c45a5cdf6c1c7) so health#104's five urgent fixes can release.

20. Rahman's open questions (evening): "All recommended" (D-Eminence, 2026-11-01).
   - Audit (health#101): show refused-access events to facility admins (request-log filter on `api.` only, so security.authorization refusals show); add the four self-describing labels (ehr.order-route.not-completed, identity.emergency-contact.notification.intent-failed, identity.emergency-contact.verification-failed, identity.patient-account-deletion.confirmation-rejected) to the "no prefix" list; say "Automatic" once (drop the "Automatic: " prefix when the actor already reads Health ID (automatic)).
   - Role names (health#97): records_officer "Records officer", billing "Billing officer", outreach_officer "Outreach officer".
   - Document OCR refusal (health#89): "Reading scanned documents isn't available at your facility yet." (no "ask your facility administrator").
   - Setup wizard Launch step at real facilities: remove it if it does nothing there.

21. app. is for patients only (D-Eminence, evening, with screenshot of app./provider/sign-in): staff sign-in must go straight to ehr. (no "Continue to provider sign in" step), the same for other products; hospital (facility) registration and staff password recovery run on their own product site, not app.; app. keeps patient pages only. Build: change A (website/edge: app./provider and /provider/sign-in straight to ehr., in-app too), change B (hid-system identity-api: accept staff-reset, staff-invitation, provider-enrollment on ehr./lab./pharmacy./migrate./outreach.; staff email links to ehr.), change C (website: those pages on each product site; every app./provider/* link redirected to ehr. with path kept), released after B.

22. "approve re-pin" (D-Eminence, evening, given ahead): approval to re-pin the website to the backend release that ships change B (staff recovery, invitations and facility sign-up accepted on the product sites), so change C can release. Cite this in the re-pin's review_reference.

23. Akos's backend handover (31 Oct, redesign/kasuwa) — owner answers (evening):
   - Shared card and outside-doctor result links (items 2, 12): the receiver opens them with a ONE-TIME CODE (not open to anyone the email reaches).
   - Walk-ins without a Health ID (items 9-10): YES, because pharmacies and labs work as standalone products for their whole facility operation.
   - Payments, price list, bills, stock, end of day (items 6-13, with walk-ins built alongside): AFTER the EHR parity work.
   - Build now (coordinator recommendation, not objected): items 1 (patient-added records, source "patient"), 3 (patient name/DOB/sex on own-facility work items, pharmacy priority), 4 (pharmacy drug details), 5 (outreach visits, phone/notes back, link by Health ID, member names), and item 2 with the one-time code.
   - Clarified (D-Eminence, evening): walk-ins without a Health ID apply to the LAB too, not only pharmacy — both work as standalone products for their whole facility operation. (Built with the post-parity payments/stock program; the lab walk-in takes name, age, sex, phone; Health ID optional and can be attached later.)

24. App. patient-only changes: "release it as soon as checks pass" (D-Eminence, evening). Release step 1 (website/edge) on green + clean verification; then step 2 (backend, re-pin pre-approved in 22) and step 3 (website follow-up) in order, each on green.

25. Akos handover backend plan (scratchpad/akoss-handover/backend-plan.md): "all recommended except D5" (D-Eminence, evening).
   - D5 changed: anyone the patient shares with (personal contacts too, not only clinicians on Health ID) can receive and open the card, READ ONLY.
   - D2 therefore changes: the one-time code goes to the email address the patient shared with (no account needed), sent only when the receiver presses "Email me a code"; 6 digits, 10 minutes, single use, 5 tries.
   - All others as recommended: D1 link-only email (no health data), D3 card shows what the patient sees of their own record, D4 inbox + push on every open and at most one email per link per day, D6 drug picture with the price list later, D7 patient-removed record hidden and kept unless legal requires deletion, D8 emergency sessions see patient details with the work, D9 quantity pre-filled and confirmed, D10 campaign name now / site later, D11 link by Health ID needs existing access, D12 JPG/PNG/PDF 10 MB each 10 a day, D13 NDPA legal sign-off before patient uploads (0110) and card links (0111) go live. Build order as in the plan, smallest first.

## 26. No staff pages on app. at all; each product has its own sign-up, sign-in and password (2026-11-02 ~00:25 UTC)
Owner, in chat: "there should not be app./provider or app./provider/sign-in. https://app.healthidentitydirectory.com/sign-in for patient then each other products have their own" and "signup, signin, password and all should be individually".
Meaning: app. serves patients only (/sign-in, /enroll, patient password reset). No /provider page is served on app. Each product site (ehr., lab., pharmacy., migrate., outreach.) has its own staff sign-in, facility sign-up, password reset and invitation pages. Old app./provider/* links (bookmarks, emails already sent) are sent on to the product site so nothing breaks. Public site links go straight to each product's own site.
Delivery: A (health#114) removes the two staff entry pages now; B (hid-system#145) lets product sites accept the checks; C+D (health#115) move every remaining staff page off app. after B is live.

## Coordinator answers to Rahman (2026-11-02 ~00:40 UTC, following decisions 20, 23 and 26; owner can overrule)
- Release order: #89 before #107.
- Product sites: a page that isn't the product's goes to the product's Home (#113), not "open it on the EHR site" (#68). Reason: decisions 23/26, each product is standalone. #68 should ask opensInProduct instead of its own list, and must not redo app.-patients-only (A/C/D cover it).
- Registration refusal: "ask your administrator for the Receptionist or Records officer role" (both roles carry patient create in roleTemplates.ts).
- Outreach refusal: "Outreach isn't available at your facility yet." (same pattern as the decision 20 OCR wording).
- A role with no name: "a staff member".
- #74 ships inside health#115 (merged into that branch), so #74 closes as merged when #115 lands.

## 27. Akos steps 1-2 follow-ups: "all recommended" (2026-11-02 ~00:45 UTC)
1. Re-pin approved for the step 1 backend release (hid-system#146): after it deploys, the website pins move to its commit. Cite this in review_reference.
2. Lab work list limit accepted for now: refused at the 15 s limit past roughly 1,800-2,000 work items at one lab; a later migration raises it.
3. Pharmacy: a reversed dispensing counts as done (not open) until re-dispensing exists.
4. Outreach phone: shown in full on the case page only; still never on the list card or in search.

## Coordinator answers to Lekan (2026-11-02 ~01:05 UTC; owner can overrule)
- health#117 patient upload: contract change accepted (patientEntries inside GET /ehr/me/records; 409 PATIENT_DOCUMENT_ALREADY_UPLOADED counts as uploaded). This is the contract the step-7 backend (0110) builds to.
- Photo location: strip it in the browser before upload (all JPEG EXIF/APP1 incl. GPS and PNG eXIf/text chunks), without re-encoding where possible; PDFs as they are. Reason: data minimisation (NDPA); location has no clinical use here.
- Daily limit (D12, 10 a day) is enforced by the backend; the website shows a plain refusal.
- Patient uploads stay OFF in production until NDPA legal sign-off (D13) and 0110.
- Backend prerequisites (scanner results, ehr-api Textract permission, AI setting, documents bucket CORS for app.) are coordinator/DevOps work, not Lekan's.

## 2026-11-02 ~13:20 UTC — decision 28: demo story release
- Owner: "approve 0102 and 0103" (hid-system#149: 0102 sealed demo story + demo Access PIN for Adaeze/Chinedu, 0103 super admin organization applications, identity-api demo-requests audit fix). Declaration signed reviewed_by D-Eminence citing this, commit dfd98131.
- Owner answers: passwords set for operations@ and patient1@ only (patient2@ not yet); not sure whether Demo Hospital access was ended; no PIN set yet.
- Hold: merge only after patient2@'s password is set (seed refuses SEALED_DEMO_STORY_LOGINS_NOT_READY otherwise, which stops the whole release incl. 0103).
- 15:2x UTC owner "done" (patient2@ password set). hid-system#149 merged 34d69557; release backend-41472309905-1-92af4593c4d92277 success 15:52 (all 12 services; 0102 + 0103 applied). health#126 merged d66dd307 with re-pin of all 9 services to 34d69557 (cited "approve 0102 and 0103"); website release success 16:33; live bundles show the new PIN note (Adaeze/Chinedu, no digits) and the Overview's plain "aren't available" line.
- Demo PIN for Adaeze (HID-ZDEMAAA2) and Chinedu (HID-ZDEMAAA3) given to owner in chat only.

## 2026-11-02 ~17:00 UTC — decision 29: order of work
- Owner: "add the posthog and sentry. i need details admin dashboard like what i share but i want us to finish all the product development first. patient, ehr, migrate(OCR), Lab, pharmacy, outreach, api, others. in this order"
- Then: "go on with this" = the open-items list (1 #107 wording, 2 lab. menu Pharmacy link, 3 #64, 4 Akos steps 3-8, 5 renumbering, 6 waiting items, 7 longer work).
- Reading: PostHog + Sentry instrumentation and the detailed admin dashboard come AFTER product development; product order patient, EHR, Migrate, Lab, Pharmacy, Outreach, API, others. PostHog answer = yes (inputs masked, no patient details).
- Running: wad2knc02 (#107 + lab menu + #64 -> batch3), w0f10q7tb (review Ola #121-#125, #100, #102).
- Team relays: Rahman's Health-id #68/#69 merged (repo outside this session). Lekan: #72/#117 closed (in main via #120); #64 ready. Lekan's questions: Audit trail search/filter/Refresh; #72 doc cards plain wording; EXIF orientation-only; BACKEND-NEEDS §1 daily-limit rule.
- ~17:10 UTC decision 30, owner "all recommended" on Lekan's four: (1) blue Audit trail keeps search, Outcome filter and Refresh for good; (2) Lab and Pharmacy document cards use the plain wording ("PDF · 20 KiB · Checked"); (3) photos keep an EXIF block with ONLY the orientation (location, camera, thumbnails still removed); (4) BACKEND-NEEDS.md §1 daily-limit counting rule confirmed as written (each new upload-intent key answered 201 counts once, removed entries' files still count, Lagos calendar day, replays never refused). Building in w73fm6nzo.
- ~17:45 UTC decision 31, owner "all recommended" on Ola's questions: (a) merge #125 (Ask the patient first); (b) keep both #102 optional commits (6a81b5ff "true" turns switching on; 7d7a5458 no "Back to Hospital EHR" on product sites); (c) keep Demo Hospital's "Open Hospital EHR" button as the one named cross-site exception (demo-only), noted in productSites.ts/otherSitesGroup in a short follow-up; (f) the two area-2 focus buttons in a small follow-up PR; #100 merged dark with a go-live rule: VITE_HID_SSO only after Identity SSO is set up for app. and the shared sign-in provider confirms items 5-6. (d) "shared since" and (e) encounter "Last updated": not in the seven PRs; Ola to say where.
- ~18:10 UTC owner "okay, don't forget" (SSO): health#100/#102 ship dark tonight. Go-live sequence: port hid-system#142 (Identity SSO, main migration 0102) to production with the next free number -> owner signs -> backend release -> verify sign-in/sign-out across all sites -> separate website release switching VITE_HID_SSO on. Tracked as a task.
- ~18:20 UTC owner "dont port hid1.0 yet": paused — the hid-1.0 imported-history sharing switch (patient plan rank 19 / decision 4) and any hid-1.0-only features (voice entry, health events). Not affected: patient Records showing our own EHR/Lab/Pharmacy data (rank 7), which uses hid-1.0 only as the reference. Other 8 patient decisions still awaiting the owner.
- ~18:30 UTC decision 32 (patient plan), owner: "all recommended except 8th". Approved: (1) lab result visible to the patient once the lab has checked/released it, with "Talk to your doctor about what this result means" (Ola confirms clinical safety); (2) send legal the upload design now, uploads stay off until NDPA sign-off; (3) gender/state/country always editable, name and DOB editable until NIN verified then support only; (5) close health#71, Rahman ports only PasswordRules; (7) release hid-system#137 now, replace existing single-kind IDs after the pilot with 180 days overlap and a plain notice; (9) apply push alerts as soon as the key is in. (4) and (6) paused by "dont port hid1.0 yet".
- (8) instead: "we are NDPC Certified, prepare a basic privacy notice (i will update it later), DPO Name: Ibrahim Umar, Contact: ibrahim@healthidentitydirectory.com, +2347026717252. Staff can use thier [own devices]." -> fill the offline notice / DPIA addendum placeholders (health#40) and prepare a basic privacy notice with these DPO details (owner will update later).
- New plan item (Migrate): staff can use their phone camera to take/scan pictures of paper records for OCR during patient migration.
- ~18:40 UTC owner: "no to this [patients would see their lab results, medicines, diagnoses and vitals from our own EHR, Lab and Pharmacy] ... keep it as its today". So patient plan rank 7 (records sections), rank 8 (Ola's patient wording for them) and rank 11 (provider document downloads) are OFF; decision 1 (lab result visibility) is moot. The quick fixes that stop Home/Records promising those sections still ship (they make today's page truthful).
- ~23:20 UTC owner: OCR AI step stays on the Claude API (global), not Bedrock (confirmed again).

## 2026-11-03 ~10:50 UTC — decision 33 (EHR + Migrate audit): owner "all recommended"
EHR: (1) staff chat stays on, DPIA updated now to say worldwide processing until the EU move; (2) reword "every view is reviewed" now, admin emergency list later; (3) two-person lab check default, single-person facility may release with a typed logged reason; (4) plain name first, clinical codes under "More details"; (5) later: "patients seen here in the last 30 days" list (access-limited).
Migrate: (6) numbers: records processing 0104, scanner 0105, support check 0106, SSO 0107, Akos 0108-0113, owner re-signs each; (7) allowance 500 pages/facility/month (Textract+AI), only super admin raises, 100% pauses reading but not review/manual entry; (8) scanned prescriptions: existing prescribers only, paper prescriber/date kept, pharmacy only after EHR prescriber signs; (9) camera: 20 pages/record, "Use anyway" flags the page, orientation-only everywhere incl. offline; (10) accuracy test pass marks >=99% medicine accuracy after review, <1% unsupported, fictional docs, Ola leads labelling with one pilot clinician; (11) release records processing + scanner + CORS for a Demo Hospital rehearsal now, Migrate off at real facilities until stage 2, 24h deletion, corrections, DPIA are live; (12) before first real patient: DPIA signed, AWS AI opt-out, pilot facility + clinical safety lead named.
- Owner on Migrate screens: "make this simplify. staff should not type. just easier as we concluded" -> no typed IDs and no JSON anywhere in Migrate: staff pick the patient and the document, the AI reads it, each found item shows with its page snippet and Accept / Change / Remove, then Publish.
- Note: the container restarted ~10:44 UTC; workflows wad2knc02, w73fm6nzo, wmsx972a8 died mid-run; finishing them in a new batch workflow.
- ~11:30 UTC 3 Nov decision 34 (Migrate design, owner "all recommended"): the chosen flow (from the patient's chart; "Is this Amina's paper?" first; item cards Accept/Change/Remove; one Publish; "Prescribe from this scan" only by an EHR prescriber; doctors/clinicians correct later). (1) the first access request or Access PIN also covers bringing in paper records for 24 h, said clearly to the patient; under-18s still refused; (2) the Health ID from the card (or a tap under Shared with you) is the only thing typed, until the "patients seen here in the last 30 days" list; (3) one person (doctor, clinician or nurse) may check and publish; no Accept-all for medicines, allergies, labs; (4) papers with only a folder number may be published after staff confirm with the patient, stronger warning, who confirmed recorded, one-step withdrawal.

## 35. 48-hour sessions started (3 Nov 2026, 12:04 UTC)
- B Migrate AI reading (hid-system): session_01VG3TB1ge3dQHuHciEWGc5d, migration 0110
- C Migrate items/checking/publishing (hid-system): session_01VG3TB1itEkCVKm15G65ZZk, migrations 0107-0109
- D Migrate website (health): session_01VG3TB4GnSXEY8aNXxHxTUj
- E EHR parity (health, + hid-system backend): session_01VG3TB5CJ62WtanEaJPhCtG, migration 0111
- A DevOps waits for the owner's AWS SigV4 secret (new session needed after it is added)
- Numbers re-sequenced: 0104 records processing, 0105 scanner, 0106 support check (sup-be, built), 0107-0109 Session C, 0110 Session B, 0111 Session E, 0112 SSO, 0113-0118 Akos steps 3-8. Renumber at release if the release order changes.
- All sessions tagged hid-48h; they report to this session via send_message.
