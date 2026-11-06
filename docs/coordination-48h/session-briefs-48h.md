# Health ID: 48-hour sessions (3 Nov 2026)

Paste one brief into each new Claude Code session. Start every session in the **HID** environment with **D-Eminence/health** and **D-Eminence/hid-system** attached.

The coordinator session hands out migration numbers, reviews, merges, and runs every release. Releases must never overlap.

## Rules for every session (paste these with each brief)

- **Draft PRs only.** Never merge into health `main` or hid-system `staging-novu-ci-20261005`; merging there releases production. The coordinator merges.
- **Branches:** one per task, named `claude/<topic>`.
- **Git:** never force-push, rebase someone else's branch, or bare `git stash`.
- **Commit messages:** plain English, with no AI model names.
- **Databases:** only throwaway PostgreSQL 16 clusters you create and delete. Never connect to production data.
- **Migration numbers:** ask the coordinator through the owner; never pick one. Already taken: 0102 and 0103 (live), 0104 (records processing) and 0105 (virus scanner), both releasing soon.
- **Every migration follows the 0102/0103 release pattern** (hid-system commits 4ce7cf1d to 105bbc6f):
  - decision header and catalog-only preconditions;
  - a runtime-grants block;
  - the ledger and components;
  - a declaration with `reviewed_by` EMPTY (the owner signs);
  - a DB suite proven fresh, and on an upgrade from production.
- **Screens:** plain friendly English. No codes, IDs, server text or status numbers.
- **Never:**
  - get around Cloudflare Turnstile;
  - sign in to production from an automated browser;
  - put a password or key in chat, Git, a file or a command line.
- **Before every push:** typecheck, lint on the changed files, targeted tests, then the full check. Have an independent review of your diff and fix what's real.
- **Reporting:** when a PR is ready, tell the owner its link and head, what it changes in plain words, the checks, and what's left. The owner passes it to the coordinator.

---

## Session A: DevOps (AWS)

**Before starting:** the owner adds an **AWS SigV4** secret in the HID environment for a dedicated IAM user, region `eu-west-1`.

You do the AWS steps in the attached **Health-ID-DevOps-Runbook-2026-11-02.pdf** (the owner sends it), in its order. It follows `infra/DEVOPS_HANDOVER.md` on hid-system `dev`.

For every apply:
1. Use the section 4 guarded helper.
2. Show the owner the plan summary (resource names and counts, no secrets).
3. Apply only after the owner writes "apply".
4. Report the applied SHA256 and the check result.

Order:
1. **Runbook section 4, read-only checks.** Send the output.
2. **Apply 1: document upload (CORS).** Allow **PUT and GET** from ehr. and migrate. (the Migrate check screen views pages). If `dev` allows PUT only, open a small Terraform PR into `dev` adding GET and ask the owner to merge it. The plan also carries any pending cost changes. Check with one fictional upload at Demo Hospital.
3. **Textract.** Give the ocr-worker role `textract:DetectDocumentText` and `textract:AnalyzeDocument`, plus the async `StartDocumentAnalysis` and `GetDocumentAnalysis` if the Migrate backend session asks. Do it as a reviewed Terraform change in `dev`.
4. **Claude API for ocr-worker.** Give ocr-worker the existing Anthropic secret and HTTPS access to api.anthropic.com. Today only ehr-api has the secret (`infra/terraform` `workloads.tf`). Reviewed change in `dev`, then apply.
5. **AI services opt-out** in AWS Organizations (runbook section 5).
6. **Caller limit 6 → 8,** in an apply of its own, then the GuardDuty virus scanner stages from the runbook. The coordinator says when backend release 0105 is live; do nothing before that.
7. **Web push,** once the owner has stored the private key and sends you the public key.

Don't start any apply while the coordinator is running a release. Ask the owner first.

---

## Session B: Migrate backend, AI reading (hid-system)

Build in hid-system, on a branch from `origin/staging-novu-ci-20261005`.

**Goal:** every page of a paper record becomes typed items, each grounded in the page.

The owner decided:
- Textract on AWS for the text, then Claude through the **Anthropic Claude API** (global, NOT Bedrock) for the AI step;
- a 500-pages-per-facility-per-month allowance; at 100%, reading pauses but review and manual entry keep working;
- working data deleted after 24 hours;
- under-18s refused;
- Demo Hospital first.

Build:
1. **Text reading version 2 in ocr-worker.** Keep each line's page, position, confidence and a handwriting flag (Textract AnalyzeDocument, or its async version for multi-page PDFs), stored as working data only.
2. **The AI step in ocr-worker.** Read lines go to Claude with structured outputs, and come back as typed items: medicine, diagnosis, allergy, note, lab result and vital. Each item carries:
   - the line ids it came from;
   - the words exactly as written;
   - a confidence.
3. **Deterministic grounding checks.** An item whose words aren't on the page is dropped and counted.
4. **Model setup:** a cheaper first pass, with the stronger model re-reading only flagged pages. Make the models configurable.
5. **Robustness:** retries with backoff, clear failure states, and no patient text in logs.
6. **The page allowance:** count pages per facility per month, pause at 100%, and return plain status.

Use the Anthropic secret the DevOps session wires in. Start from the scratchpad design (the coordinator can share `ocr-fhir-design.md` and `ocr_extract.py` through the owner). That script used Bedrock and has 19 open review findings; fix them as you port.

Ask the coordinator for a migration number for any database change. Test only on fictional documents.

---

## Session C: Migrate backend, items, checking and publishing (hid-system)

Build in hid-system, on a branch from `origin/staging-novu-ci-20261005`. Start with the data model and routes; agree item shapes with Session B through the owner.

1. **Storage and routes.** New OCR tables for found items, saved drafts and per-item decisions (Accept / Change / Remove with reason). Routes:
   - `GET /ocr/jobs/:id/items`;
   - `PUT` for a review draft;
   - validation of the whole set of decisions;
   - publishing the accepted set in one step.
2. **Plumbing:**
   - list a patient's documents, including ones with no visit;
   - `GET /ocr/jobs?patientId` with plain status;
   - reading starts by itself when a paper's virus check comes back clean.
3. **"Is this the patient's paper?"** Compare the name and date of birth on the paper with the patient. A mismatch stops publishing.
   - A paper with only a folder number can be published after staff confirm with the patient. Show a stronger warning and record who confirmed.
4. **Publishing** goes into the chart under "From paper records":
   - medicines as history;
   - diagnoses, allergies and notes;
   - lab results as imported results;
   - vitals.

   Each item links back to the paper and records who checked it. One person (doctor, clinician or nurse) may check and publish. There's no "Accept all" for medicines, allergies or labs; the website enforces this, and the server checks every item has its own decision.
5. **"Prescribe from this scan."** An EHR prescriber gets the usual prescription form pre-filled, keeping the paper's prescriber and date. It reaches the pharmacy only after they sign.
6. **24-hour deletion** of working data: raw text, AI output, line positions, drafts and rejected suggestions. Today migration 0013 blocks every delete. Add a scheduled clear-out.
7. **Corrections:** a new permission for doctors and clinicians only, not nurses.
   - "Entered in error" on every imported item.
   - A whole-paper "wrong patient" withdrawal that tells the facility.
   - Nothing is deleted.
8. **Short lists for "Change":** medicines from the Nigeria Essential Medicines List, common conditions, and lab tests and units (MP, mRDT, Widal, PCV, FBC, E/U/Cr), seeded as data. Ola and a pilot clinician check them.

Ask the coordinator for migration numbers. You may need two or three migrations; ask for all of them at once.

---

## Session D: Migrate website (health)

Build in health, on a branch from `origin/main`. Use the website's mock gateway (`dev/mock-gateway`) until Sessions B and C ship, so nothing waits on them.

The owner's flow: nothing is typed and there are no JSON boxes.
1. Open the patient as usual.
2. Tap "Bring in paper records".
3. If no OK covers it yet, ask the patient. The patient's first access OK, or their Access PIN, covers paper records for 24 hours.
4. Take photos or choose files.
5. The paper is virus-checked and read automatically.
6. "Is this Amina's paper?" comes first.
7. Item cards with Accept / Change / Remove.
8. One Publish.

Build:
1. **Remove all typed boxes.** In `Migrate.tsx`, remove the Document and Patient ID forms, the short IDs and the raw text panel. Remove the four JSON boxes in `ocrSteps.tsx`.
2. **Entry points:**
   - "Bring in paper records" in the patient page's Next steps, and on the visit's Documents card in place of "Extract with OCR";
   - plain "can't use it here" lines: permission, view-only, under 18, emergency access, Demo Hospital first;
   - migrate.'s start page: "Open a patient".
3. **Phone capture:**
   - the rear camera (`capture="environment"`), plus "Choose files" (PDF, JPEG, PNG);
   - a page strip with Retake, Remove and reorder, up to 20 pages;
   - a blur, dark or too-small check with "Use anyway", which flags the page;
   - orientation-only metadata, using `photoMetadata.ts` and `fileSignature.ts`;
   - pages joined into one PDF without re-encoding.
4. **The patient's "Paper records" list,** with one plain status each: Checking for viruses / Reading / Ready to check (check by …) / Published / Couldn't read (with Try again).
5. **The check screen:**
   - the page picture with zoom beside the cards;
   - "Is this Amina's paper?" first;
   - each card shows the page cut-out, the words as written, and "Clear" or "Check carefully";
   - Accept / Change (short lists, or one number) / Remove (reason list);
   - no "Accept all" for medicines, allergies and labs;
   - a progress count and one Publish;
   - "Add something that was missed".
6. **After publishing:**
   - "From paper records" items in the chart;
   - "Prescribe from this scan" for prescribers;
   - "Mark as entered in error" and "Wrong patient: withdraw this paper" for doctors and clinicians.
7. **Release order:** the coordinator's records-processing release (0104) changes the patient-facing access wording. Ship that wording, exactly as the coordinator gives it, in your first PR.

---

## Session E: EHR to full parity (health, small backend where needed)

Work from the EHR audit's ranked list (the owner can paste it from the coordinator). Each item is a small draft PR, or a few together.

1. **Broken:**
   - access request length: set the minimum to 5 minutes (`RequestAccess`);
   - on lab. and pharmacy., hospital-only buttons (Open chart, Start a consultation, Record vitals, Emergency summary or access) are hidden or replaced with plain words, instead of silently going Home;
   - the lab work list stops asking for payment settings at real facilities (gate it with `pointOfCareOpen`).
2. **Misleading:** remove "every view is reviewed" from the emergency notice, tick box and summary. Say only what's true: the patient is told, access ends after the set time, and every opening is recorded.
3. **Plain words:**
   - patient registration: no "backend", "API" or "identity service", and no case IDs;
   - Outreach: no "case 1a2b…" or raw statuses;
   - Home and the bell: requests are waiting for the patient;
   - "All clear" only when it's true;
   - each product's own name on staff sign-in;
   - the wrong-patient panel points to the right button;
   - Home's "Today" card shows the lab stage.
4. **Clinical codes** (ICD-10, LOINC, routes): the plain name first, the codes under "More details".
5. **Sample workspaces** (Appointments, Wards, Maternity, Theatre, Billing and others) open only at demo facilities.
6. **A lab with one scientist:** keep the two-person check by default, and let a one-person facility release with a typed, logged reason. This needs a small backend change; ask the coordinator for a migration number.
7. **Then the remaining partial parity rows,** area by area (Frame, Consultation, Orders, Access, Patients, Departments).

Coordinate with the team: Ola owns Consultation and Orders, and Rahman owns the frame and patient checks. Take what they haven't started, and tell the owner which items you took.
