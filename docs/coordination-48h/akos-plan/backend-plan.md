# Backend plan: Akos handover, items 1 to 5

Written 1 Nov 2026 for the owner (D-Eminence) and the build team.
Inputs: Akos's handover (31 Oct), the owner's decisions of 1 Nov, the EHR and Ops design drafts, and the code as it stands.
Code checked: hid-system `origin/staging-novu-ci-20261005` at 6c6fc18 (production, with 0100 and 0101 live) and health `origin/main` at ebbe8b8.
Payments, price list, stock, walk-ins, end of day and result sharing (items 6 to 14) come after EHR parity, as the owner decided. They are not planned here.

---

## Part 1. In plain English (for the owner)

### What each item does

1. **Records patients add themselves.** A patient can add a visit, test, medicine, diagnosis or vaccine from anywhere, with notes. Later they can add photos or PDFs of the paper too. Each one shows as "Added by you" to the patient. Clinicians see it read-only, marked "Added by the patient. Not checked by a health worker." It is never mixed into the clinician's own lists.
2. **Sharing the card by email, opened with a one-time code.** When a patient shares with a clinician, the clinician gets an email with a link. Opening the link asks for a code, and the code is emailed to that same clinician right then. Anyone else the email reaches gets nothing without that inbox. Every open is recorded in the patient's activity, and the patient is told each time. The link stops working the moment the share ends.
3. **Patient details on the lab and pharmacy queues.** Staff see the patient's name, date of birth, sex and the end of their Health ID on this facility's own lab and pharmacy work, not only on work sent from another facility. That way they can match a sample or medicine to the person in front of them. Urgent prescriptions come first and carry a badge.
4. **Drug details in the pharmacy.** Each item shows the exact strength and form ("500 mg capsule"), how long it is for ("7 days") and how much to give, and the dispense form is filled in ahead. The prescriber enters these, so they appear on new prescriptions only. The drug picture comes with the price list (see decision D6).
5. **Outreach improvements.** Staff can record follow-up visits, referrals and next dates on a field registration. They can link a registration to an existing patient by typing the Health ID, and see the name and date of birth before they confirm. Each case shows who registered it, and campaign members show by name. Phone and notes already come back from the server; only the screens need to show them.
6. **Where the chat's facts come from.** Every source the patient's chat assistant uses is labelled "You added this", "Recorded by a health worker" or "From a scanned paper record".

### What I found that changes the designs

- **The card email must not carry the card.** The redesign puts a picture of the card in the email: name, Health ID, blood group, genotype, allergies and photo. That would hand the sensitive data to anyone the email reaches, before any code, which defeats your one-time-code decision. Our current sharing emails also deliberately carry no patient name or Health ID. So the email carries the link and nothing else.
- **The link must not put the secret in the address bar path.** Our gateway logs every request path, and so do the CDN logs. The secret therefore goes after a `#` in the link and is sent in the request body.
- **Email security scanners open links on their own.** So opening the link never sends a code and never counts as an open. Only "Send me a code" sends one, and only entering the right code counts as an open.
- **Existing bug: busy queues hide new work.** Both the lab and pharmacy queues return the 200 oldest items they can read, done or not. A busy facility stops seeing new work. I fix this first, with no database change.
- **Outreach phone and notes are already served.** Production's outreach service already returns `phone` and `operationalNotes` on every case. The handover is out of date here, so only the website needs changing.
- **New audit names would vanish from the patient's activity.** The activity list only shows actions it already knows by name. A new name such as `ehr.patient-entry-file.download` would never show. So new reads use names it already shows (`ehr.record.read`, `ehr.document.download`).
- **The shared card page would crash today.** The redesign's page expects seven record lists. Production's records answer has two (visits and signed notes). The server will send all seven, the five not released to the patient as empty, and the page will also guard against missing lists.
- **Both designs claimed migration 0106.** I renumbered them in a single chain below.

### Decisions still needed from you

| # | Decision | My recommendation |
|---|---|---|
| D1 | What the share email contains | The link only: no name, Health ID, health data or card picture. The card shows after the code. |
| D2 | Where the one-time code goes | To the clinician's verified sign-in email, sent when they press "Send me a code" on the page. It lasts 10 minutes and allows 5 tries. |
| D3 | What the card page shows | The card plus what the patient sees of their own record: visits, signed notes, imported history, health information they entered, and records they added. It does not show the full chart; the clinician already has that by signing in. |
| D4 | How the patient is told about each open | An inbox notice and a phone/computer push on every open, plus an email for the first open of each link per day. |
| D5 | Who can get a card link | Only shares to a clinician on Health ID (found by search, or an invitation they accepted and the patient confirmed). Sharing with any email address not on Health ID would be a new kind of access, and it is not in this plan. |
| D6 | Drug picture (you listed it under item 4) | Comes with the price list after EHR parity, because a picture belongs to a drug in the price list, not to one prescription. Until then the card shows the form tile. |
| D7 | Removing a record a patient added | Hide it everywhere and keep it, as every other record is kept today (account deletion keeps records too). Legal to confirm this answers NDPA erasure requests, or tell us to truly delete. |
| D8 | Emergency (break-glass) sessions in the lab or pharmacy | Show the patient card whenever the work row itself is shown, emergency included. |
| D9 | Quantity to dispense | Pre-filled from the prescriber. The pharmacist still confirms it, and the server does not compare the two. |
| D10 | Outreach "campaign site" | Send the campaign name now. A site/location field needs a campaign change, which waits for campaign governance. |
| D11 | Linking an outreach case by Health ID | Works only when the worker already has access to that patient (shared, PIN or approved), exactly as linking does today. Otherwise the screen says "Ask the person to share their record with you, or use their PIN." |
| D12 | Patient photo/PDF limits | JPG, PNG or PDF only, 10 MB each, 5 per record, 10 a day. Phone camera photos come through as JPG. |
| D13 | Legal sign-off | Needed before items 1b (patient files) and 2 (card links) go live. Item 2 is health data reached through an emailed link, so NDPA applies. |

You also sign the schema declaration for every migration (0106 to 0111 below), as you did for 0100/0101.

---

## Part 2. Ground rules for every item

- **Shapes.** Existing routes keep their request and response shapes. Changes are new routes, new optional fields and new optional request fields only.
- **Switches.** Every new route sits behind its own setting and answers a plain 404 while off. A plain 404 is the website's "not set up" signal. A missing record answers its own `*_NOT_FOUND` code, never a bare 404.
- **Staff routes.** Scoped to the member's current facility (`X-Facility-ID`), with `X-Purpose-Of-Use: direct-care`. Authorized by `ClinicalRepository.run` (EHR) or the service's existing consent/route check (lab and pharmacy).
- **Audit.** Every write and every share open writes an `audit.events` row in the same transaction, with ids, codes and counts only. Never a name, email, phone or free text. A read that should show in the patient's activity uses a name `identity.patient_self_access_log` (0093) already classifies:
  - "viewed": `ehr.record.read`, `ehr.document.download`, `lab|pharmacy.work-item.read|list`.
  - "changed": `ehr.document.upload.complete`, etc.
  - Other names are kept in the audit but are not shown to the patient.
- **Plain English.** Every screen message is plain English with no internal codes, ids or table names. Server messages are written to be shown as they are, and the website maps codes to its own copy where it has one.
- **Migrations.**
  - Each migration has preconditions (md5 pins of every body it relies on, CHECK definitions it writes through, the applying role owns what it reads), a `runtime-grants.sql` block, and a DB suite under `services/ehr-api/database/tests/`.
  - It also needs ledger entries: `scripts/verify-migration-ledger.mjs`, `release/config/components.json` and `docs/INTERFACE_CONTRACT.md`.
  - Each needs an owner-signed `config/production-schema-compatibility.json`. That file is replaced per release and lists that release's files and hashes, so one migration goes per release.
  - No migration number appears inside a function body, so renumbering changes only file names and ledgers.
- **Locks.** Locks are taken NOWAIT and retried for at most 5 s, under the runner's 5 s `lock_timeout`, and measured on a production-sized copy as 0100 was. New CHECKs on existing tables go in as `NOT VALID`, then `VALIDATE CONSTRAINT`.

### Migration numbers (provisional)

| No. | Status | What |
|---|---|---|
| 0100, 0101 | live | pharmacy guard (`pharmacy.validate_work_item`, `pharmacy.validate_dispensing`) |
| 0102 | taken | records processing (branch `rp-db`, file still named 0100 there) |
| 0103 | taken | document scanner (branch `scan-be`, file still 0101) |
| 0104 | taken | support Health ID check (branch `sup-be`, file still 0102) |
| 0105 | held | replacing issued Health IDs that are all letters or all digits. The generator change on `hid-mix` has no migration; the replacement is a separate change. |
| **0106** | proposed | `work_item_patient_cards` (item 3a) |
| **0107** | proposed | `prescription_dispensing_details` (items 3b, 4) |
| **0108** | proposed | `outreach_visits_and_names` (item 5) |
| **0109** | proposed | `patient_entries` (item 1a, chat evidence kind) |
| **0110** | proposed | `patient_entry_files` (item 1b; needs 0103 live) |
| **0111** | proposed | `shared_card_links` (item 2) |

All numbers from 0106 on are provisional. Each takes the next free number when its PR is next to release. If 0105 is not used, everything moves down by one.

The EHR and Ops drafts both claimed 0106; this table replaces both.

---

## Part 3. Items

### Item 0 (do first, no migration): queue order fix and chat source labels

**Queue order (existing bug).**
- `LabWorkItemsService.list` (`services/lab-api/src/lab/lab-work-items.service.ts`) and `PharmacyService.listWorkItems` (`services/pharmacy-api/src/pharmacy/pharmacy.service.ts`) both run `order by w.accepted_at asc, w.id asc limit 200` with no filter.
- Once a facility can read 200 rows, it never sees newer work.
- Change: open work first, oldest first, up to 200; then done work, newest first, filling up to 200. Open work means:
  - Pharmacy: no dispensing, or a dispensing that was reversed.
  - Lab: no released result on every execution.
- The response shape is unchanged.
- Tests: jest for both services, 250 rows of which 30 are open (all 30 returned); the existing audit rows are unchanged.

**Chat source labels (item 1c, first half).**
- Add `origin: 'patient' | 'health_worker' | 'scanned_paper' | 'health_id_profile'` to `Evidence` (`patient-evidence.types.ts`). It is computed in code, not by the model:
  - `patient`: `health_profile` (0094 patient-entered), `import` whose origin is `patient-provided`, and (after 0109) `patient_entry`.
  - `health_worker`: note, encounter, diagnosis, prescription, investigation, vital, `lab_result`, and `import` whose origin is `provider-authored`.
  - `scanned_paper`: `document` and `attachment` extractions, and any note that has an `ehr.ocr_import_provenance` row.
  - `health_id_profile`: `profile`.
- Every returned chat source gains an optional `origin`, plus `originLabel`: "You added this", "Recorded by a health worker", "From a scanned paper record (checked by a health worker)" or "Your Health ID profile".
- The system prompt in `claude-ai.service.ts` gains one rule: say for each fact whether the patient added it, a health worker recorded it, or it came from a scanned paper record, using the given origin. The existing citation check stays the gate.
- Staff chat gets the same field.
- Tests: jest on the origin mapping for every `SOURCE_KINDS` value, and on an answer whose sources carry `origin`.

**Website:** chat source chips show `originLabel`. No registry change.
**Sign-offs:** none (no schema).
**Size:** S.

---

### Item 3a: patient card on this facility's own lab and pharmacy work (0106)

**Checked against code.**
- Only route-backed rows carry `patient`, through `LabOrderRouteCards.cards()` / `pharmacy order-route-cards.ts` → `ehr.receiving_order_route_cards` → `ehr.order_route_patient_card` (0086 line 7061). That reads `full_name, gender, dob, right(hid_code,4)`.
- `hid_lab_runtime` / `hid_pharmacy_runtime` have no table grant on `identity` (runtime-grants.sql 206-214). They do have EXECUTE on `identity.has_active_consent_grant`.
- Own rows are visible only when `lab|pharmacy.work_item_allows` holds (0086 H8): same facility, plus a consent grant for the member, or a live route.
- The Ops draft's claims hold. The owner's answer (yes: labs and pharmacies run as stand-alone products for the whole facility, without the EHR to identify patients) removes the old assumption that own work is identified in the EHR.

**API.**
- No request change.
- `GET /api/v1/lab/work-items`, `/lab/work-items/:id`, `/pharmacy/work-items` and `/pharmacy/work-items/:id` add the existing optional `patient: { fullName, sex|null, dateOfBirth|null, healthIdLast4|null }` on own rows.
- It is left out when the database read fails (savepoint) or the member has no grant now.
- Routed rows are unchanged.

**Schema (0106, functions only).**
- `lab.work_item_patient_cards(uuid[])` and `pharmacy.work_item_patient_cards(uuid[])`: SECURITY DEFINER, STABLE, `search_path pg_catalog, pg_temp`, every name schema-qualified. Both owned by the role that owns `identity.patients`.
- At most 200 ids (else 22023).
- Only rows with `order_route_id is null`, `facility_id = platform.current_facility_id()`, `auth.membership_has_permission(..., 'lab.work-item.read' | 'pharmacy.work-item.read')` and the same `identity.has_active_consent_grant(..., 'read_records', current purpose)` test RLS uses. Per D8, emergency is included because the row is.
- Reads `identity.patients` directly.
- Pins: md5 of `has_active_consent_grant` (8b12ce866ee75cce411a2721795ffb92, as 0100 pins it), `membership_has_permission`, `platform.current_*`, and both `work_item_allows`.
- Does not touch C12/C18 (pinned by 0090/0091).
- EXECUTE to `hid_lab_runtime`, `hid_pharmacy_runtime` and `hid_schema_test_runtime`; revoked from PUBLIC.
- Locks: none beyond catalog.

**Services.**
- lab-api: a `patients(client, ids)` reader in a savepoint (like `cards()`); `project()` attaches the card on own rows; `get()` reads it after its read audit.
- `auditShownPatients()` writes one `lab.work-item.list` row per own-row patient shown, with `{ basis: 'consent', workItemIds }`.
- pharmacy-api: the same in `listWorkItems` / `getWorkItem` / `projectWorkItem`. It keeps its collection row.
- Update `lab-work-items.types.ts` (it says "only routed") and `packages/api-client/src/lab.ts`, `pharmacy.ts`.
- Setting: `OWN_WORK_PATIENT_CARD_ENABLED` (off: behaves as today).

**Tests.**
- New suite `work-item-patient-cards.integration.sql`: no grant, so no row; another facility's id gives no row; a routed id gives no row; 201 ids raises 22023; a revoked grant gives no row; an emergency purpose with grant gives a row.
- jest for projection, the savepoint failure path and per-patient audit rows.

**Website.**
- Registry notes for `lab.workItems`, `pharmacy.workItems`: "patient on every row the member may read".
- The mock's pharmacy own rows gain `patient` (lab's already have it).
- `PharmacyRecord` and the queue already read `item.patient`.
- Copy: Health IDs are now 6 characters, so `healthIdLast4` shows 4 of 6. The same is true on routed cards today; keep it.

**Risks.**
- Patients will now see "Pharmacy/Laboratory at X viewed your record" after queue loads, collapsed by the access log's 10-minute rule. This is correct under NDPA, but new to them.
- Audit volume: one row per patient per list load. There is no polling, only refresh on action, so volume is bounded.

**Sign-offs:** 0106 declaration.
**Size:** M.

---

### Items 3b and 4: pharmacy priority and drug details (0107)

**Checked against code.**
- `ehr.prescriptions` (0004:202) has no priority, strength, form, duration or quantity.
- `pharmacy.work_items` is insert-only.
- 0100's same-facility branch reads the prescription `FOR SHARE` and compares 17 copied fields (PRESCRIPTION_SOURCE_MISMATCH).
- `order_routes_kind_ck` (pinned by 0089) forces `priority is null` for prescriptions.
- The website's `PharmacyWorkItem` (`apps/patient-web/src/staff/api.ts:660`) has none of the new fields, so "the screens already show each one" is true only for `patient`.

**API.**
- `POST /api/v1/ehr/patients/:patientId/encounters/:encounterId/prescriptions` takes these optional, create-only fields:
  - `priority` (`routine|urgent|asap|stat`)
  - `strength` (1-80)
  - `doseForm` (`tablet|capsule|liquid|injection|cream|inhaler|drops|other`)
  - `durationValue` (1-3650) with `durationUnit` (`day|week|month`), as a pair
  - `quantityToDispense` (>0) with `quantityUnit` (1-80), as a pair
- EHR prescription answers echo them when set. `UpdatePrescriptionDto` is unchanged.
- Pharmacy work items (list and `:id`) gain optional:
  - `priority`
  - `medication.strength`, `medication.doseForm`
  - `duration: { value, unit }`: from the prescription, else inclusive days from `starts_on..ends_on` when both are set
  - `quantityToDispense`, `quantityUnit`
- All are absent on prescriptions written before release and on route-backed work (until item 4b).
- `medication.imageUrl` is not built (D6).
- The dispense request is unchanged; the pharmacist confirms the quantity (D9).

**Schema (0107).**
- `alter table ehr.prescriptions add column priority text, medication_strength text, medication_dose_form text, duration_value integer, duration_unit text, quantity_to_dispense numeric(12,4), quantity_unit text`. All nullable, no default, so there is no rewrite.
- Then `add constraint ... check (...) not valid` for each value set and each pair, then `validate constraint` (SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE).
- The ADD COLUMN takes a brief ACCESS EXCLUSIVE, NOWAIT with retry for at most 5 s. Measure it while a pharmacy acceptance holds `FOR SHARE`: it must wait-and-fail, never block acceptances.
- Nothing is copied into `pharmacy.work_items`, so 0100/0101 bodies (e2411539…, 17f7e889…) and their 17-field comparison are untouched. A caller of pharmacy-api cannot supply or forge the new fields.
- New `pharmacy.work_item_prescription_details(uuid[])`, SECURITY DEFINER STABLE, at most 200 ids. Own rows only, same facility, `pharmacy.work_item_allows(..., 'read_records')`.
  - Preferred source: the immutable snapshot `ehr.record_versions.resulting_state` at `(resource_type 'prescription', resource_id = source_ehr_prescription_id, version_no = source_ehr_prescription_version)`. This is exactly the row 0100 accepted, and it is still readable after the prescription later changes.
  - Fallback if `record_versions` RLS does not admit the pharmacy session: join `ehr.prescriptions` on id and `row_version = source_ehr_prescription_version`. Details then vanish once the prescription changes, which matches 0101 making the item not dispensable.
  - Verify which policy applies during the build.
- Pins: 0100 and 0101 bodies, `work_item_allows`, `capture_record_version`.
- EXECUTE to `hid_pharmacy_runtime` and `hid_schema_test_runtime`.
- Re-run the 0100/0101 suites on top. Include one acceptance in a pooled connection that ran the guard before the ALTER: `source_row` is read with `select prescription.*`, so the row type must re-resolve after new columns.

**Services.**
- ehr-api: `CreatePrescriptionDto` (IsOptionalButNotNull, IsIn, pair checks), `prescriptions.service.ts` COLUMNS and projection. `acceptForPharmacy` and pharmacy-api `AcceptEhrPrescriptionDto` are unchanged.
- pharmacy-api: details reader in a savepoint; `projectWorkItem` merges the fields. No extra audit, because no new identity is shown.
- `packages/api-client/src/pharmacy.ts`, `ehr.ts`.

**Tests.**
- Suite `prescription-dispensing-details.integration.sql`: pairs enforced; old rows null; the details function returns nothing for another facility, a routed row or no grant; returns the accepted version's values after a later update (snapshot path); 201 ids raises 22023.
- The 0100/0101 suites pass unchanged.
- jest for DTO pairs and merge.

**Website.**
- `PharmacyWorkItem` gains the optional fields.
- `pharmacyText.ts` sorts by priority (stat > asap > urgent > routine > none), then oldest, and shows the badge. The lab code already does this.
- Prefer the server's `strength`/`doseForm` over `drugForm.ts` guesses; keep the guesses as fallback.
- Pre-fill the dispense quantity from `quantityToDispense`.
- The prescribe form (EHR parity build) sends the new inputs. Until it does, every field stays empty.
- Mock: add the fields to two items.

**Risks.**
- Value appears only once prescribers use the new form fields.
- A pharmacist cannot raise priority; a pharmacy-side flag would need its own table later.

**Sign-offs:** 0107 declaration; D6, D9.
**Size:** M.

**Item 4b (later, after 0111).** The same details on work routed from another facility need snapshot columns or a side table filled by `ehr.send_order_route` (md5 pinned through 0088-0091) and a new route-gated reader. It is its own migration and owner decision; it is not in this round.

---

### Item 5: outreach (0108)

**Checked against code.**
- Production's `registrationCase()` (`services/outreach-api/src/outreach/outreach.types.ts`) already returns `phone` and `operationalNotes`, so the handover's "doesn't return them" is wrong for production.
- `linkExisting` takes only `canonicalPatientId` and calls Identity's authorization check, so the worker needs access to that patient.
- `listCampaignMembers` returns membership ids only.
- Campaigns have no site/location column.
- `hid_outreach_runtime` has no identity table grants.
- The website calls none of visits, preview or names yet. `OutreachCaseView` sends a typed `canonicalPatientId`.

**API.**
- Case answers (`GET …/registration-cases`, `GET …/:caseId`, `POST`, `link-existing`) gain optional:
  - `createdBy: { name }`: the staff record name of `created_by_membership_id`
  - `campaignName`
  - `nextFollowUpOn` (latest visit's follow-up date)
  - `visitCount`
- `GET …/campaigns/:id/members`: each item gains optional `displayName`.
- New `POST /api/v1/outreach/registration-cases/:caseId/link-preview { healthId }` (permission `outreach.registration.write`, campaign member, CSRF). It returns `200 { patient: { fullName, dateOfBirth, healthIdLast4 } }`.
  - outreach-api calls Identity `POST /identity/patient-lookup { hid, purpose: 'direct-care' }` with the caller's own authorization.
  - Identity already refuses without access (403) and audits `identity.patient.lookup`, which shows in the patient's activity as a view.
  - Errors: `404 OUTREACH_HEALTH_ID_NOT_FOUND` ("No one has this Health ID. Check it and try again."); `403 OUTREACH_PATIENT_ACCESS_REQUIRED` ("Ask the person to share their record with you, or use their PIN.").
  - Rate limit: 20 an hour per member.
- `POST …/:caseId/link-existing` takes new optional `healthId` instead of `canonicalPatientId`; exactly one must be sent. Identity resolves it again at link time. Nothing from the preview is trusted.
- New `GET` and `POST /api/v1/outreach/registration-cases/:caseId/visits` (read: `outreach.registration.read`; write: `outreach.registration.write`, Idempotency-Key).
  - Body: `kind` (`visit|referral|follow_up`), `occurredOn` (Lagos date, not future), `followUpOn` (null or after `occurredOn`), `referredTo` (null or 2-160), `notes` (null or at most 1000, newlines only).
  - Answers `201 { visit }`. GET answers `{ items }`, newest first, at most 100.
  - `404 OUTREACH_REGISTRATION_NOT_FOUND` for a case the member cannot see.

**Schema (0108).**
- `outreach.registration_case_visits` columns:
  - id, `registration_case_id`, `facility_id`, kind, `occurred_on`, `follow_up_on`, `referred_to`, notes
  - `recorded_by_account_id`, `recorded_by_membership_id`
  - `idempotency_key`, `request_sha256`, `created_at`
- Rules: insert-only (trigger refuses UPDATE/DELETE); RLS forced; read and insert policies the same as `registration_cases` (`outreach.registration_campaign_member(campaign_id, facility_id)` through the case).
- Grant `select, insert` to `hid_outreach_runtime`.
- `outreach.member_display_names(uuid[])`, SECURITY DEFINER: membership ids of the session facility's campaigns the caller belongs to, giving the staff record `full_name`. It never returns an email, phone or licence. At most 200.
- `outreach.case_registrar_names(uuid[])`: the same rule, for case ids the caller can see.
- Pins: `registration_campaign_member`, `platform.current_*`.
- Locks: a new table with FKs to `outreach.registration_cases` (SHARE ROW EXCLUSIVE, NOWAIT, retry for at most 5 s).

**Services.**
- outreach-api: visits controller/service/DTO, link-preview, `healthId` on link, the name readers in projections, and an Identity client call for lookup.
- Audit: `outreach.registration-case.visit.create`, `outreach.registration-case.visit.list`, `outreach.registration-case.link-preview` (ids only).
- Setting: `OUTREACH_VISITS_ENABLED`.

**Tests.**
- Suite `outreach-visits.integration.sql`: a non-member is refused; another facility is refused; no update/delete; names only for the caller's campaigns.
- jest for exactly-one-of, the future date, the 403/404 mapping and the idempotent replay.

**Website.**
- Show phone and notes on the case view now. This is website-only; a masked phone on the list is a website choice.
- Preview step: Health ID, then name and date of birth, then confirm with reason.
- Visits list and form, member names, "Registered by".
- Registry: add `outreach.linkPreview`, `outreach.caseVisits`; note the new optional fields.
- Mock: samples for all three.

**Risks.**
- Visit notes can hold health information; only campaign members at that facility read them.
- Link by Health ID does not widen access (D11).

**Sign-offs:** 0108 declaration; D10, D11.
**Size:** M.

---

### Item 1a: records patients add (0109)

**Checked against code.**
- Nothing stores patient-written records.
- `ehr.patient_reported_health_profiles` (0094) is the right model: patient write through a SECURITY DEFINER bound to `ehr.patient_self_context`, staff read through `ClinicalRepository.run`, audited `ehr.record.read`.
- `GET /ehr/me/records` answers `{ encounters, notes, importedRecords, importedHealthProfile, limit: 50 }` (`patient-records.service.ts:70`).
- `AddRecord.tsx` posts base64 `attachments`, has no Idempotency-Key, and allows 2000-character notes.
- The EHR draft's 1a API is sound. It is adopted with the changes below.

**API.**
- Patient routes (patient session, CSRF, `Cache-Control: no-store`, `authorizeSelf` re-checked, 404 while `PATIENT_ENTRIES_ENABLED=false`):
  - `POST /api/v1/ehr/me/patient-entries`.
    - Body: `{ kind, title, facilityName, occurredOn, notes, attachments?, fileIds? }`.
    - Limits: title 2-160 with no control characters; `occurredOn` not before 1900-01-01 and not after today in Africa/Lagos; notes at most 1000 with newlines only. The website also checks the body is under 8,000 bytes (the edge WAF refuses over 8 KB).
    - `attachments` must be absent or `[]` until 1b ships. A non-empty list answers `422 PATIENT_ENTRY_FILES_NOT_READY`: "Photos can't be added yet. Save the record without them."
    - `fileIds` are accepted only once 0110 is live; before that, a non-empty list answers 422 with the same message.
    - Idempotency-Key is optional:
      - Same key and body: `200 { id, replayed: true }`.
      - Same key, different body: `409 IDEMPOTENCY_KEY_REUSED`.
      - No key: the same body within 60 s answers the earlier entry.
    - New entry: `201 { id }`.
    - Errors: `400 VALIDATION_FAILED` per field, `429 PATIENT_ENTRY_LIMITED` (30 in 24 h: "You've added a lot of records today. Try again tomorrow."), `403 PATIENT_SESSION_REQUIRED`.
  - `GET /api/v1/ehr/me/records`: existing keys unchanged, plus optional:
    - `patientEntries: [{ id, source: 'patient', kind, title, facilityName, occurredOn, notes, addedAt, files: [] }]`, active only, newest `occurredOn` then `addedAt`, at most 50
    - `patientEntriesMore`
    - The audit details gain `patientEntryCount`.
  - `GET /api/v1/ehr/me/patient-entries?before=<cursor>` answers `{ items, nextBefore }`.
  - `POST /api/v1/ehr/me/patient-entries/:entryId/withdraw` answers `{ id, status: 'withdrawn', replayed }`. The entry is hidden from the records page, chat, clinicians and shared cards; the row is kept (D7). Missing entry: `404 PATIENT_ENTRY_NOT_FOUND`.
- Staff route `GET /api/v1/ehr/patients/:patientId/patient-entries` (permission `ehr.note.read`, direct-care, current facility, consent) answers `{ items, more }`.
  - Audited `ehr.record.read`, resource type `patient-entries`, so it shows as a view in the patient's activity.
  - `403 CONSENT_REQUIRED` without access.
- The emergency read (`/emergency-records`) is unchanged.

**Chat (item 1c, second half).**
- `patient_entry` becomes an evidence kind (origin `patient`, label "You added this").
- It is added to `SOURCE_KINDS`, the evidence query and the `ehr.patient_evidence_chunks` source-kind CHECK. Withdrawn entries leave the evidence set and their chunks are deleted on the next refresh.

**Schema (0109).**
- `ehr.patient_entries` columns:
  - id, `patient_id` (FK `identity.patients`), kind (CHECK, 6 values), title (CHECK), `facility_name`, `occurred_on` (CHECK ≥ 1900-01-01), notes (CHECK)
  - status (`active|withdrawn`), `withdrawn_at`, `created_by_account_id`
  - `idempotency_key`, `request_sha256 char(64)`, `row_version`, `created_at`, `updated_at`
- Constraints: unique `(patient_id, idempotency_key)`; index `(patient_id, status, occurred_on desc, created_at desc)`; triggers refuse DELETE and allow only active → withdrawn.
- RLS forced:
  - owner policy (as 0094);
  - read policy `ehr.imported_record_read_context(patient_id) and status = 'active'`.
- SELECT only for `hid_ehr_runtime`; no INSERT/UPDATE grant.
- Commands, SECURITY DEFINER, `search_path pg_catalog, pg_temp`, bound to `ehr.patient_self_context`, each writing `audit.events` `ehr.patient-entry.create` / `.withdraw` with ids and counts only:
  - `ehr.create_my_patient_entry(kind, title, facility_name, occurred_on, notes, idempotency_key, request_sha256)`, which does the Lagos date and the 30-a-day check;
  - `ehr.withdraw_my_patient_entry(entry_id)`.
- Evidence CHECK: drop and re-add `patient_evidence_chunks` (and `staff_evidence_chunks` if staff chat includes entries) source-kind CHECK with `patient_entry`, as `NOT VALID`, then `VALIDATE`.
- Pins: `patient_self_context` (0083), `imported_record_read_context` (0061). Measure again on the chain head, in case 0102-0105 replace them.
- Locks:
  - FK to `identity.patients`: SHARE ROW EXCLUSIVE, NOWAIT, retry for at most 5 s.
  - CHECK swap on the chunks table: brief ACCESS EXCLUSIVE for drop/add NOT VALID, then SHARE UPDATE EXCLUSIVE to validate.

**Services.**
- ehr-api `ehr/patient-entries` module (controller, DTOs with the limits above, service).
- Patient routes use `withPatientTransaction`; the staff route uses `ClinicalRepository.run`.
- `PatientRecordsService.read` adds `patientEntries` on the self read only.
- Problem mapping for SQL codes. Setting `PATIENT_ENTRIES_ENABLED`.

**Tests.**
- Suite `patient-entries.integration.sql`: another patient is refused; a withdrawn entry is hidden from self, staff and chat; staff without consent are refused; staff at another facility are refused; 31st in 24 h is refused; idempotency replay and reuse; a future Lagos date is refused; DELETE is refused; withdrawn → active is refused.
- jest for DTO limits, the 60 s double-tap and the 422 attachments rule.

**Website.**
- `AddRecord`:
  - sends an Idempotency-Key, made once per Save and reused on retry;
  - caps notes at 1000 and checks the body is under 8,000 bytes;
  - hides the photo step until the files route answers. Probe: `GET ehr/me/patient-entry-files/availability` (from 1b) answers 200.
- The records page lists `patientEntries` as "Added by you", with Remove (withdraw).
- The blue EHR chart gets a read-only "Added by the patient" list, each row labelled "Added by the patient. Not checked by a health worker."
- The shared card shows them with the same label.
- Registry:
  - `ehr.myPatientEntries` becomes GET+POST surface-verified;
  - add `ehr.myPatientEntryWithdraw`, `ehr.patientEntries`;
  - correct the note (no base64).
- Mock: samples.

**Risks.**
- Patient text is unverified: it is always labelled and never merged into clinician lists.
- Withdraw only hides (D7).

**Sign-offs:** 0109 declaration; D7 (legal).
**Size:** L.

---

### Item 1b: photos and PDFs on records patients add (0110)

**Checked against code.**
- Staff documents use `ehr.documents`, which needs `facility_id` and `created_by_membership_id` (0004:263), so patients cannot use it.
- `s3-storage.provider.ts` presigns a 300 s PUT with `x-amz-checksum-sha256`, `x-amz-meta-declared-sha256` and SSE headers. `inspect()` HEADs the object.
- The ehr task role has Get/PutObject on the documents bucket (Terraform on `dev`, `modules/application/iam.tf:20`).
- The GuardDuty scanner (0103, `scan-be`) scans only `clinical/objects/` and resolves only to `ehr.documents`.
- Base64 in JSON cannot pass the edge: the WAF `AWSManagedRulesCommonRuleSet` has no override in `ingress.tf:346`, so its 8 KB body rule applies.

**Change from the EHR draft: same key space, no Terraform or bridge change.**
- The draft's new `patient/objects/` prefix would need the unreleased scanner's plan prefix, EventBridge rule, plan role and bridge changed, plus a Terraform apply.
- Instead, patient files use keys `clinical/objects/<uuid>`, like staff documents (uuids never collide).
- ehr-api's existing scanner routes (`/ehr/documents/scan-targets/resolve`, `GET /ehr/documents/scan-targets`, `/ehr/documents/scan-events`) look a key up in `ehr.documents` first, then `ehr.patient_entry_files`, and dispatch by id. The bridge, its Terraform and the public gateway refusal stay as 0103 ships them.
- Detected type must be jpeg, png or pdf (D3 sniffing, D12). Anything else is `not_usable`.

**API (patient session, Idempotency-Key on POSTs, 404 while `PATIENT_ENTRY_FILES_ENABLED=false`).**
- `GET /api/v1/ehr/me/patient-entry-files/availability` answers `{ maxFiles: 5, maxBytes: 10485760, perDay: 10, types: [...] }`. It is the website's probe.
- `POST /api/v1/ehr/me/patient-entry-files { fileName, mediaType, sizeBytes, sha256Hex }` answers `201 { file: { fileId, fileName, mediaType, sizeBytes, status: 'waiting_for_upload' }, upload: { method: 'PUT', url, expiresInSeconds: 300, requiredHeaders } }`. Errors:
  - `400 PATIENT_ENTRY_FILE_TYPE`: "Use a JPG or PNG photo, or a PDF."
  - `400 PATIENT_ENTRY_FILE_TOO_LARGE`: "Each file can be up to 10 MB."
  - `429 PATIENT_ENTRY_FILE_LIMITED`: 10 a day, at most 20 waiting and not on a record.
- The browser PUTs the bytes straight to S3, so the edge 8 KB rule does not apply.
- `POST …/patient-entry-files/:fileId/complete` answers `{ fileId, status: 'checking' }`. It HEADs and checks size, SHA-256, declared type and KMS. A mismatch answers `409 PATIENT_ENTRY_FILE_MISMATCH`: "This file didn't upload correctly. Add it again."
- `POST ehr/me/patient-entries` with `fileIds` (at most 5, the caller's own, completed, not on another entry) attaches them in the same transaction.
  - `404 PATIENT_ENTRY_FILE_NOT_FOUND`, `409 PATIENT_ENTRY_FILE_IN_USE`.
  - A non-empty base64 `attachments` now answers `422 PATIENT_ENTRY_FILES_SEPARATE`: "Add your photos again. They now upload one at a time before you save."
- `patientEntries[].files[]` carries `status: 'checking' | 'ready' | 'not_usable'`.
- `GET …/patient-entry-files/:fileId/download` answers `{ url, expiresInSeconds: 60 }` only when the scan is clean. Otherwise `409 PATIENT_ENTRY_FILE_NOT_READY` ("This file is still being checked." / "This file couldn't be used.").
- Staff: `GET /api/v1/ehr/patients/:patientId/patient-entry-files/:fileId/download` (`ehr.note.read` + `ehr.document.read`, direct-care, current facility, consent).
  - Audited `ehr.document.download`, resource type `patient-entry-file`, so it shows in the patient's activity. The draft's `ehr.patient-entry-file.download` would not show.

**Schema (0110; needs 0103 live, because it grants to `hid_document_scanner`).**
- `ehr.patient_entry_files` columns:
  - id, `patient_id`, `entry_id` (null until set, set once, FK `patient_entries`), `uploader_account_id`
  - `original_file_name` (1-255, no slash, backslash or control characters), `storage_bucket`, `storage_key` (unique, CHECK `clinical/objects/<uuid>`), `object_version_id`
  - `declared_media_type` (3 types), `detected_media_type`, `size_bytes` (1-10485760), `sha256_hex`
  - status (`waiting_for_upload|checking|ready|not_usable`), `created_at`, `completed_at`
- `ehr.patient_entry_file_scan_events`, append-only, mirroring 0009's document scan events.
- RLS forced: owner policy; read policy `imported_record_read_context(patient_id)` and the entry active.
- SECURITY DEFINER commands, patient-bound:
  - `create_my_patient_entry_file_intent`
  - `complete_my_patient_entry_file`
  - `create_my_patient_entry` replaced to accept `file_ids uuid[]`
- Scanner-bound commands (`hid_document_scanner`):
  - `resolve_patient_entry_file_scan_target(bucket, key, version)`
  - `list_patient_entry_file_scan_targets(older_than, limit)`
  - `append_patient_entry_file_scan_event(...)`
- Pins: 0103's scanner role check and `create_my_patient_entry` from 0109.

**Services.**
- ehr-api file module, presign via the existing `S3StorageProvider` under the same key format.
- Scanner route dispatch, download presign (60 s).
- Setting `PATIENT_ENTRY_FILES_ENABLED`.

**Infra (owner applies).**
- Documents bucket CORS for browser PUT from the patient host only (task in progress).
- The website CSP `connect-src` adds the bucket's regional endpoint.
- No GuardDuty or bridge change.

**Tests.**
- Suite `patient-entry-files.integration.sql`: another patient's file is refused; a file on a second entry is refused; 11th a day is refused; scanner role only on scanner commands; download blocked until clean; a withdrawn entry's files are hidden.
- jest for presign headers, HEAD mismatch and dispatch (a document id still goes to documents).
- Gateway test: scanner paths still 404 publicly.

**Website.**
- `AddRecord` uploads each file as soon as it is picked: intent, SHA-256 by `crypto.subtle`, PUT, complete.
- It shows per-file "Checking…", keeps `fileIds` and sends them on Save.
- Download links when ready.
- Registry: add `ehr.myPatientEntryFiles`, `…Complete`, `…Download`, `…Availability`, `ehr.patientEntryFileDownload`.

**Cost.**
- GuardDuty Malware Protection for S3 bills per GB scanned and per object; S3 storage is small.
- The 10-a-day and 10 MB caps bound the worst case per patient. Watch it under the $400 budget alarm.

**Risks.**
- HEIC photos are refused if a browser does not convert them; the website says "Use a JPG or PNG photo".
- Files stay "checking" if the scanner is down; they become usable once it is back.

**Sign-offs:** 0110 declaration; CORS Terraform apply; D12; legal (D13).
**Size:** L.

---

### Item 2: share the card by email, opened with a one-time code (0111)

**Checked against code.**
- Sharing (0095) creates a consent grant to one clinician membership, either from search (`create_my_consent_share`) or from an invitation the clinician accepts and the patient confirms. D7: an invitation is accepted only from a verified sign-in email equal to the invited address.
- E2 (`share-received`) already emails the clinician, with no patient name or Health ID (`sharing-emails.ts`).
- OTP purposes are fixed by CHECK (0029), so codes need their own table.
- Inbox codes are a pattern CHECK (0095:307), so `SHARED_CARD_OPENED` needs no constraint change.
- The gateway logs `$uri`.
- The website's `SharedCardPage` calls `GET identity/shared-cards/:token` with no sign-in and expects records in the same answer. `rowsOf` calls `records.diagnoses.map` and would crash on production's records shape.

**Model.**
- A card link belongs to one share grant (search share or confirmed invitation, D5).
- It works only while that grant is active: patient revoke, expiry, replacement and account deletion (0096 revokes 0095's grants) all end it at once.
- The code goes to the grantee account's verified sign-in email (D2). For invitations, that is the invited address.

**Flow.**
1. The patient shares, or confirms an invitation.
   - Identity creates the link (random 32 bytes; only its SHA-256 is stored).
   - The E2 email gains an optional `cardLink`, `https://<patient host>/card#<token>`.
   - The email text gains "Open the card (we'll email you a code)". It has no health data (D1); the portal sign-in line stays.
2. The clinician opens the link.
   - The page shows "Send me a code" and sends nothing on load, because email scanners prefetch links.
3. `POST /api/v1/identity/shared-cards/code { token }` (public, Origin checked, no-store).
   - Sends a 6-digit code to the grantee's verified email. Only its HMAC is stored; it lasts 10 minutes.
   - Answers `{ sentTo: 'd•••@clinic.ng', expiresInSeconds: 600, resendAfterSeconds: 60 }`.
   - Limits: 3 codes per link per 15 minutes, 10 per day. Past them: `429 SHARED_CARD_CODE_LIMITED` ("Too many codes asked for. Try again later.").
   - An ended or unknown link answers `410 SHARED_CARD_ENDED` ("This card is no longer shared."). The answer is the same for unknown and ended, so nothing can be learned.
4. `POST /api/v1/identity/shared-cards/verify { token, code }`. A right code:
   - creates a view (30 minutes, bound to the link) and sets cookie `hid_card_view` (HttpOnly, Secure, SameSite=Strict, Path=/api/v1, no-store);
   - answers `{ card: { fullName, hid, ninVerified, bloodGroup, genotype, allergies, photoUrl (60 s signed) }, sharedBy, recipientEmail, level, duration, expiresAt }`;
   - writes `identity.shared-card.open` (success) to audit;
   - adds an inbox notice `SHARED_CARD_OPENED` ("Dr X at Y opened your Health ID card") and a web push on every open, plus an email on the first open per link per Lagos day (D4).
   A wrong code:
   - answers `400 SHARED_CARD_CODE_WRONG` ("That code isn't right. Check the email and try again.");
   - after 5 wrong codes the code dies, and after 3 dead codes the link is locked for 1 hour;
   - each failure is audited.
5. `GET /api/v1/ehr/shared-card/records` (cookie only; ignores any patient session in the same browser).
   - Answers the `PatientRecords` shape limited to D3: `encounters`, `notes`, `importedRecords`, `importedHealthProfile`, `patientEntries`, plus `vitals`, `diagnoses`, `prescriptions`, `labRequests`, `documents` as `[]` with `released`/`withheld` naming them. All seven keys are always present.
   - Audited `ehr.record.read`, resource type `shared-card`, actor the grantee's account and membership, details `{ via: 'card_link', viewId }`. The patient's activity therefore shows "Dr X at Y viewed your record" without changing 0093, and the patient never sees the clinician's email (0095 D4).
6. `POST /api/v1/identity/shared-cards/end-view` clears the cookie.
- Every request re-checks: view live, link live, grant active.
- Opens from more than 3 networks (IP /24 hash) on one link in 24 h raise an ops alert.

**Schema (0111).**
- Identity tables:
  - `identity.shared_card_links`: id, `consent_grant_id` (FK, unique), `patient_id`, `grantee_account_id`, `token_sha256` (unique), `created_at`, `revoked_at`, `locked_until`.
  - `identity.shared_card_codes`: `link_id`, `code_hmac`, `expires_at`, attempts, `consumed_at`, `created_at`.
  - `identity.shared_card_views`: id, `link_id`, `view_secret_sha256`, `verified_at`, `expires_at`, `ended_at`, `network_hash`.
  - All RLS forced, owner policy only, no grants; only commands touch them. Never deleted.
- Identity commands (system or public bound, audited, ids only):
  - `create_shared_card_link` (called inside `create_my_consent_share` / `confirm_my_share_invitation` paths by Identity after commit, idempotent per grant)
  - `issue_shared_card_code`
  - `verify_shared_card_code` (writes the open audit and inbox notice in the same transaction)
  - `shared_card_view_context`
  - `end_shared_card_view`
- EHR read context: `ehr.shared_card_read_context(patient_id)` is true only when the transaction setting `app.shared_card_view` names a live view whose link and grant are active for that patient.
- New permissive SELECT policies `<table>_shared_card_read` using it on:
  - `ehr.encounters` (completed only)
  - `ehr.clinical_notes`, `ehr.clinical_note_revisions` (signed/amended only)
  - `ehr.imported_medical_records` (and its version table as the self read uses)
  - `ehr.patient_reported_health_profiles`
  - `ehr.patient_entries` (active only)
- The new policies are SELECT-only, so no write path and no `FOR SHARE` read (0100) can use them. No existing policy or function body is replaced.
- Pins: 0095's share commands, `has_active_consent_grant`, `patient_self_context`, `imported_record_read_context`, and the policy sets of the tables above (catalog compare).
- Locks: new tables with FKs to `identity.consent_grants` and `identity.patients`; `CREATE POLICY` takes ACCESS EXCLUSIVE briefly on each listed table, NOWAIT with retry for at most 5 s. Measure on a production copy.

**Services.**
- identity-api `consent/shared-cards` (controller, service, DTOs): link creation hook after share/confirm commit, code email via notification-api, verify, view cookie, inbox and push via the existing dispatchers, and the alert.
- notification-api:
  - E2 DTO gains optional `cardLink` (validated https on the patient host);
  - new route `shared-card-code` (E5: subject "Your Health ID card code", body: code and 10 minutes, nothing else);
  - patient "card opened" email (E6: time only, as E3).
- ehr-api: `withSharedCardTransaction` (sets `app.shared_card_view`, no patient or staff context), records projection reused from `PatientRecordsService`.
- Gateway (`gateway/nginx.conf.template`): a `limit_req` zone for `/api/v1/identity/shared-cards/` (10 r/m per IP, burst 3) and `client_max_body_size 1k`. The token never appears in a path.
- Setting `SHARED_CARD_LINKS_ENABLED` (off: no link made, routes 404, E2 as today).
- No PNG card rendering. It would carry the data (D1) and add a headless renderer to notification-api.

**Tests.**
- Suite `shared-card-links.integration.sql`:
  - ended, revoked, expired or replaced grant: no code and no read;
  - wrong code 5 times: the code dies;
  - lock after 3 dead codes;
  - a view from link A cannot read patient B;
  - a view after the grant is revoked reads nothing;
  - the policies admit only SELECT;
  - every open writes the audit and inbox rows.
- jest:
  - prefetch-safe GET (none exists);
  - cookie flags;
  - a patient session cookie in the same browser is ignored;
  - the answer always has all seven keys.
- notification jest: E2 with/without `cardLink`, E5, E6 carry no name or Health ID.
- Gateway test: path logging has no token (none in the path).

**Website.**
- `SharedCardPage` reads the token from `location.hash` (`/card#…`, so CDN and gateway logs never see it).
- Steps: "Send me a code", code entry, then the card from `verify` and records from `ehr/shared-card/records`. It replaces the single GET.
- Guard every records list with `?? []`.
- `ShareEmailPreview` shows the real email (link and code note, no card face).
- `ShareRecords` copy: "They'll get a link by email and a code to open it."
- Notification title for `SHARED_CARD_OPENED`.
- Registry: retire `identity.sharedCard` (GET); add `identity.sharedCardCode`, `identity.sharedCardVerify`, `identity.sharedCardEndView`, `ehr.sharedCardRecords`.
- `BACKEND-NEEDS.md` §2 is updated to the code model.

**Risks.**
- An inbox that auto-forwards everything also forwards codes (residual; the clinician is accountable).
- A clinician can screenshot the page; it carries their address on every view, as designed.
- Email cost rises by one code email per open, bounded by the limits.

**Sign-offs:** 0111 declaration; D1-D5; legal NDPA sign-off (D13) before the switch is turned on.
**Size:** L.

---

## Part 4. PR and release order (smallest and safest first)

Each backend PR has its own branch off the production branch and a declaration when it carries a migration. The website PR merges first and works against both today's and the new backend; the backend then releases, and the registry flips to surface-verified in the same website release. The chain 0102 → 0103 → 0104 (→ 0105) releases before any of ours.

| # | PR | Migration | Depends on | Why this place |
|---|---|---|---|---|
| 1 | Queue order fix (lab, pharmacy) + chat source labels | none | none | Fixes a live bug and needs no schema or sign-off. |
| 2 | Website: outreach phone/notes shown, pharmacy type fields, chat origin chips, records guards | none | none | Website only; uses fields already served or optional. |
| 3 | Own-work patient card (3a) | 0106 | chain released | Functions only, no table change, no lock risk. |
| 4 | Prescription details + priority (3b, 4) | 0107 | 3 | Columns on `ehr.prescriptions`; guard untouched; lock measured. |
| 5 | Outreach visits, names, link by Health ID (5) | 0108 | 3 | New table; outreach-only blast radius. |
| 6 | Patient-added records, text (1a + chat kind) | 0109 | 3 | New table; the patient flow works without files. |
| 7 | Patient files (1b) | 0110 | 6, 0103 live, CORS applied, legal | Needs the scanner, bucket CORS and CSP. |
| 8 | Card link with one-time code (2) | 0111 | 6 (entries shown on card), legal | Most privacy weight; switch on only after sign-off. |

Rollback:
- Every item has its own setting, so a release can be switched off without a schema change.
- 0106, 0108 and 0109 to 0111 add objects only; leaving them unused is safe.
- 0107's columns are nullable and unused by the guard.

## Part 5. What the designs got right, wrong, or left out

- **Right:**
  - the 0094 pattern for 1a;
  - presigned direct-to-S3 for files;
  - 3a's database-enforced consent test;
  - keeping item 4's fields out of `pharmacy.work_items`, so 0100/0101 stay untouched;
  - nullable priority with no back-fill.
- **Wrong or stale:**
  - both claimed 0106;
  - outreach phone/notes already return;
  - "the screens already show each field" (only `patient` and lab `priority` are typed);
  - the card email carrying the card;
  - a token in the path;
  - `ehr.patient-entry-file.download` (invisible in the patient's activity);
  - a new S3 prefix (needs unreleased Terraform changes).
- **Missing:**
  - the queue cap bug;
  - email link prefetch;
  - the seven-key records shape on the shared card;
  - CHECK swap for chat evidence kinds;
  - `NOT VALID` + `VALIDATE` for new CHECKs on `ehr.prescriptions`;
  - snapshot reads from `ehr.record_versions` so drug details survive later prescription changes;
  - the outreach design and the whole card-link design (both drafts were cut off);
  - CSP `connect-src` for S3.
