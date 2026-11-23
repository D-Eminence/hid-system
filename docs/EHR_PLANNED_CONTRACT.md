# HID planned contract for the rest of Akos's EHR list (Release B and C, not live)

This file lists the API that Akos's EHR frontend will need but that is not built yet. With it, he can build each screen once: the shape now, and the fallback he shows until the route ships.

**Nothing in this file is live.** Every section says "Status: planned, not live." Do not call these routes on staging or production until the section moves into the live contract.

- The live contract is [INTERFACE_CONTRACT.md](INTERFACE_CONTRACT.md). Release A's sections (ID-0, ID-2, ID-4, 0132, EHR-C7, 0136, ORD-2, QA-1 and the rest) land there when they are signed. Sections here cite them by name.
- A section moves from this file into the live contract when its release is signed. The final text may change in review; any change to a shape here is noted in the PR that makes it live.
- Migration numbers here are provisional. Numbers are given out in merge order at each release cut-off.
- All owner questions for these sections are answered as of 19 Nov 2026. **"(owner decision Qnnn A, 19 Nov 2026)"** marks a line that rests on one of the answers given that day (Q124 A, Q126 A, Q127 A, Q128 A, Q129 A, Q130 A, Q131 A, Q132 A; Q125 B made ORD-4 a planned section; Q132 A made "Q132 A: A change after dispensing reaches the pharmacy" a planned section). Lines without the mark rest on decisions made earlier (Q100 B, Q105, Q109, Q115, Q117, Q119 and Q121 A, Q123 A). **(coordinator decision 1, 20 Nov 2026)** marks a line of Q132 A that rests on the coordinator's design decision on #258.
- For Q124 A, Health ID's named clinical lead approves changes to the national lists (medicines, lab tests, diagnoses, vitals ranges and same-class rules). The lead is not named in this repository.

Rules that hold in every section:

- A Health ID or a NIN never goes in a URL. They go in POST bodies only; routes use UUIDs or a search card's `matchRef`.
- Every read of patient data is audited.
- Screens say "NIN Verified" or "NIN Not Verified" (`ninStatus` `verified` / `not_verified`, Release A ID-0). No other label is used.
- Consent rules are unchanged unless a section says so.
- Every error has a stable `code` and a plain-English message. Screens branch on the code, never on the text.
- Creates that could be retried take an `Idempotency-Key`.

## Contents

| Section | Akos items | Release | Migration | Size |
|---|---|---|---|---|
| [ID-6: Verify a NIN later and link it](#id-6-verify-a-nin-later-and-link-it-planned-release-b-needs-a-migration-yes) | P0-1 | B | yes | M |
| [ID-7: Unknown patient record](#id-7-unknown-patient-record-planned-release-b-needs-a-migration-yes) | P0-4, P0-1 | B | yes | M |
| [SX-4: Add or remove one role for a staff member](#sx-4-add-or-remove-one-role-for-a-staff-member-planned-release-b-needs-a-migration-yes) | N-2a, N-2c | B | yes | M |
| [SX-8: Keep the open patient across a reload](#sx-8-keep-the-open-patient-across-a-reload-planned-release-b-needs-a-migration-yes) | P1-2 | B | yes | S |
| [EHR-C6: Consultation drafts saved on the server](#ehr-c6-consultation-drafts-saved-on-the-server-planned-release-b-needs-a-migration-yes) | N-5, P1-13 (auto-save) | B | yes | M |
| [MY-1: "Ordered by me" list](#my-1-ordered-by-me-list-planned-release-b-needs-a-migration-yes) | P1-4 | B | yes | M |
| [VIT-1: Soft "abnormal" vitals warnings](#vit-1-soft-abnormal-vitals-warnings-planned-release-b-needs-a-migration-no) | P1-11 | B | no | S |
| [EHR-C8b: Vitals marked entered in error](#ehr-c8b-vitals-marked-entered-in-error-planned-release-b-needs-a-migration-yes) | P1-14, QA question | B | yes | S |
| [ORD-12: Refills on prescriptions](#ord-12-refills-on-prescriptions-planned-release-b-needs-a-migration-yes) | N-9 (refills) | B | yes | M |
| [ORD-7: Medicine and lab-test lists, and lab tests by name only](#ord-7-medicine-and-lab-test-lists-and-lab-tests-by-name-only-planned-release-b-needs-a-migration-yes) | P0-5, N-7, N-9, R-2, R-3, P2-5 | B | yes | L |
| [ORD-9: Diagnosis search on ICD-11, recent diagnoses, and diagnoses by name only](#ord-9-diagnosis-search-on-icd-11-recent-diagnoses-and-diagnoses-by-name-only-planned-release-b-needs-a-migration-yes) | P1-12, R-1, P2-5, P0-5 | B | yes | M |
| [ORD-10 phase 2: Same-class medicine warning by ATC](#ord-10-phase-2-same-class-medicine-warning-by-atc-planned-release-b-needs-a-migration-no) | N-9, P0-5 | B | no | S |
| [ORD-4: Pharmacy accepts a prescription before dispensing](#ord-4-pharmacy-accepts-a-prescription-before-dispensing-planned-release-b-needs-a-migration-yes) | N-1, N-8 (pharmacy part) | B | yes | M |
| [Q132 A: A change after dispensing reaches the pharmacy](#q132-a-a-change-after-dispensing-reaches-the-pharmacy-planned-release-b-needs-a-migration-yes) | owner question Q132 | B | yes | M |
| [ID-8: Merge an unknown or duplicate record into the real one, with a 30-day undo](#id-8-merge-an-unknown-or-duplicate-record-into-the-real-one-with-a-30-day-undo-planned-release-c-needs-a-migration-yes) | P0-4, P0-1 (duplicates) | C | yes | L |
| [SX-6: Change password while signed in, and edit own profile](#sx-6-change-password-while-signed-in-and-edit-own-profile-planned-release-c-needs-a-migration-yes) | P1-8 | C | yes | M |
| [SX-7: Preferences and up to 12 home shortcuts](#sx-7-preferences-and-up-to-12-home-shortcuts-planned-release-c-needs-a-migration-yes) | P1-8, home shortcuts | C | yes | S |
| [CHW-1: A community health worker role for Outreach](#chw-1-a-community-health-worker-role-for-outreach-planned-release-c-needs-a-migration-yes) | N-2 (Outreach row) | C | yes | S |
| [ORD-6: Several tests in one lab request](#ord-6-several-tests-in-one-lab-request-planned-release-c-needs-a-migration-yes) | N-7 | C | yes | M |
| [ORD-8: Order sets, favourites, and note and visit templates](#ord-8-order-sets-favourites-and-note-and-visit-templates-planned-release-c-needs-a-migration-yes) | P0-5, P1-13, P1-12 | C | yes | L |
| [ORD-11: Result and dispensed notices to the ordering doctor](#ord-11-result-and-dispensed-notices-to-the-ordering-doctor-planned-release-c-needs-a-migration-yes) | P1-6 | C | yes | L |
| [ORD-13: No drug-interaction checks](#ord-13-no-drug-interaction-checks-not-planned-no-release-needs-a-migration-no) | P0-5, N-9 (interactions) | not planned | no | — |
| [P2-1: National ID type per country and a neutral company number](#p2-1-national-id-type-per-country-and-a-neutral-company-number-not-planned-yet-after-release-c-needs-a-migration-yes-when-designed) | P2-1 | after C | yes, when designed | M |
| [P2-2: Interface translations and language](#p2-2-interface-translations-and-language-not-planned-yet-after-release-c-needs-a-migration-yes-when-designed) | P2-2, P1-8 (language) | after C | yes, when designed | L |
| [P2-3: Measurement units](#p2-3-measurement-units-not-planned-yet-after-release-c-needs-a-migration-yes-when-designed) | P2-3 | after C | yes, when designed | M |
| [P2-4: Time zone, date and phone formats](#p2-4-time-zone-date-and-phone-formats-not-planned-yet-after-release-c-needs-a-migration-yes-when-designed) | P2-4 | after C | yes, when designed | M |
| [QA-2: Migrate account test pass and one real save of every drawer form](#qa-2-migrate-account-test-pass-and-one-real-save-of-every-drawer-form-planned-before-the-release-a-go-live-needs-a-migration-no) | R-4, QA question | before A go-live | no | S |

Owner answers of 19 Nov 2026, and the sections that rest on them: Q124 A (ORD-7, ORD-8, ORD-9, ORD-10 phase 2, ORD-6, VIT-1), Q125 B (ORD-4, now planned for Release B), Q126 A (EHR-C6, ORD-8), Q127 A (ID-8, ORD-11), Q128 A (ORD-11, SX-7), Q129 A (SX-4, CHW-1), Q130 A (CHW-1), Q131 A (ORD-12, ORD-13, ORD-10 phase 2, P2-1 to P2-4), Q132 A (Q132 A, now planned for Release B; ORD-4 refers to it). No owner question for these sections is waiting for an answer.

Open points with no decision yet, each to be decided before that section is built:

- ID-7: whether the sealed QA facility may make unknown records for testing (recommended: yes, as sealed QA patients).
- ORD-8: who keeps a facility's order sets and templates (and so who holds `ehr.order-set.manage`).
- ORD-7 and ORD-10 phase 2: the WHOCC terms for using ATC codes in a commercial product (until then `atcCode` stays `null`).
- CHW-1: whether to record a community health worker's registration number.

# Release B

## ID-6: Verify a NIN later and link it (planned, Release B, needs a migration: yes)

Akos items:
- P0-1 ("Endpoint to verify the NIN later and link it")

Status: planned, not live.

Owner decisions applied: Q109 (no limit per staff member or facility on NIN checks), Q115 (a checked NIN record is kept 90 days from the first check and at least 30 days from each later use), Q117 (the words shown when a NIN cannot be verified) and Q100 B (404 `PATIENT_NOT_FOUND`). Screens say "NIN Verified" or "NIN Not Verified" (ID-0). Consent rules are unchanged: the route works only on this facility's own patients (0131's basis), the same desk scope as ID-2.

A patient registered without a NIN (ID-2, 0130), or an unknown patient who has since been identified (ID-7), gets a NIN checked with QoreID and attached to their record. On success `ninStatus` becomes `"verified"` wherever ID-0's rule reads it: a verified, unrevoked `nin` row in `identity.patient_identifiers` (contract "ID-0", `nin-status.ts`). Nothing else changes: names, date of birth, Health ID and who has access all stay the same. Migration number: given at the Release B cut-off. The plan's 0137 is now Release A's `0137_qoreid_nin_check_once.sql`.

### Routes

`POST /api/v1/identity/patients/:patientId/nin`

- `:patientId` is the patient's UUID. A Health ID never goes in the path, and the NIN goes only in the body.
- Who may call: holders of `identity.registration.write`. Release A's 0132 section lists them: front desk, approvers, doctors, nurses and clinicians. Send `X-Facility-Id`. `Idempotency-Key` is required.
- The call is allowed only when the patient is this facility's own patient under 0131's `identity.own_facility_basis` (contract "ID-4"). That includes a record created as unknown here under ID-7, which keeps the basis after it is identified (see ID-7).
- A consent grant (Access PIN or approval) does not allow this route. A clinical grant covers reading and writing records for direct care, not changing a patient's identity.
- Linking a NIN never creates or extends an own-facility basis.

Request:

```json
{ "nin": "<11-digit-NIN>", "purpose": "healthcare-operations" }
```

| Field | Type | Rule |
|---|---|---|
| `nin` | string | exactly 11 digits once spaces are removed |
| `purpose` | string | `healthcare-operations` (as ID-2) |

Unknown fields give 400 `VALIDATION_FAILED`.

The order of checks matters. A NIN that does not belong to this patient never reveals whether anyone else holds it.

1. The patient must be active, on the member's facility's side of the seals, this facility's own patient, and not an unknown record (`recordKind: "unknown"`, ID-7). Otherwise 404, 403 or 409, as in the table below.
2. If the patient already holds a verified NIN:
   - the same NIN (compared by its lookup HMAC) answers 200 `already_linked`, with no QoreID call;
   - a different NIN answers 409 `PATIENT_ALREADY_HAS_NIN`.
3. The NIN check goes through `NinCheckOnce`, path `desk` (docs/QOREID_VERIFICATION_CONTRACT.md, "One QoreID check per NIN", 0137). A stored answer is reused and not charged again. The Q115 keep rule applies to every use (`identity.keep_qoreid_nin_record`). There is no limit per staff member or facility (Q109).
4. The NIN record's first and last names (in either order) and its date of birth must match the patient's. They are compared exactly as `POST /api/v1/identity/me/verification/nin` compares them (QoreID contract, "Existing-patient NIN evidence"). "No record" and "does not match" give the same answer: 422 `NIN_VERIFICATION_FAILED`, the code the desk NIN path already uses (`nin-registration.service.ts:233`), with the Q117 words. As on `nin/resolve`, it is an answer, not a failure, and does not count toward ID-0's breaker.
5. Only after a match: if another patient record already holds this NIN (the unique index `patient_identifiers_lookup_uq`, `0002_auth_and_canonical_identity.sql:257`), the answer is 409 `NIN_ON_ANOTHER_RECORD`. Nothing changes, and the other record is never named.
6. The link is written in one transaction under a row lock on the patient: the verified `nin` identifier and its QoreID evidence row are inserted, and the patient's `row_version` goes up. A new SECURITY DEFINER function, `identity.link_patient_nin`, re-checks steps 1, 2 and 5 under that lock. This function is the migration.

Answer `200`:

```json
{ "patientId": "uuid", "outcome": "nin_linked", "ninStatus": "verified",
  "message": "NIN Verified. It is now on this patient's record.", "replayed": false }
```

- `outcome` is `nin_linked` or `already_linked`.
- The answer never carries the NIN, its last 4 digits, or any detail from the NIN record.
- Replaying the same key with the same body returns the first answer with `replayed: true`.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | "Enter the 11-digit NIN." |
| 400 | `PURPOSE_OF_USE_REQUIRED` | "Purpose of use is required." |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | "This request needs an Idempotency-Key." |
| 403 | `PERMISSION_DENIED` | "You do not have permission to do this." |
| 403 | `NIN_LINK_NOT_PERMITTED` | "You can add a NIN only for this facility's own patients." |
| 404 | `PATIENT_NOT_FOUND` | "No such patient." (Q100 B; also for an inactive or merged patient, or one on another side of the seals) |
| 409 | `UNKNOWN_PATIENT_NOT_IDENTIFIED` | "Add this patient's name and date of birth first (Identify patient), then verify the NIN." |
| 409 | `PATIENT_ALREADY_HAS_NIN` | "This patient already has a verified NIN." |
| 422 | `NIN_VERIFICATION_FAILED` | "This NIN could not be verified. Check the number and try again." (Q117; does not count toward the breaker) |
| 409 | `NIN_ON_ANOTHER_RECORD` | "This NIN is already on another patient record. Ask an approver to review the two records." |
| 409 | `NIN_CHECK_IN_PROGRESS` | "We are still checking this NIN. Please wait a minute, then try again." (0137, with `retryAfterSeconds`) |
| 409 | `NIN_CHECK_HELD` | "We could not finish checking this NIN. Please try again in 5 minutes." or "... in 6 hours." (0137) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | "This request key was already used for a different request." |
| 502 | `QOREID_PROVIDER_RESPONSE_INVALID` | as 0137 |
| 503 | `NIN_PROVIDER_UNAVAILABLE` | "The NIN service is not answering right now. Please try again in a minute." (ID-0 breaker; nothing is sent) |
| 503 | `NIN_CHECK_UNAVAILABLE` | as 0137 (nothing is sent) |
| 504 | `QOREID_TIMEOUT` | "The NIN check is taking longer than usual. Please wait a minute, then try again." (0137) |

Audit:
- Each answer and each refusal writes one `identity.patient.nin-link` row. It holds the patient id, the outcome or refusal kind (`no_record`, `details_mismatch`, `on_another_record` with the other patient's id, `already_has_nin`, `not_permitted`) and `qoreidCalled`. It never holds the NIN or its HMAC.
- 0137's `identity.qoreid.nin-check` row is written as well.
- When the patient has a login, `GET /api/v1/identity/me/access-log` gains the action `nin_added`, with `facilityName` ("NIN added at <facility>").

### Screen notes

- Show "Verify NIN" on a patient whose `ninStatus` is `not_verified` and who is not an unknown record. Show it only to staff who hold `identity.registration.write`, only for this facility's own patients, and only while `registration-capabilities` answers `nin.available: true` (ID-0). Take `patientId` from the registration answer, the registration-case list, the waiting-list card (EHR-C7) or the own-facility answer.
- On success, show "NIN Verified".
- On 422 `NIN_VERIFICATION_FAILED`, show the Q117 words exactly.
- On 403 `NIN_LINK_NOT_PERMITTED`, show the message. The patient can add their own NIN on their profile if they have a login.
- On `NIN_ON_ANOTHER_RECORD`, show the message. From Release C, offer "Ask to merge" (ID-8): the desk then searches for the other record by full name and date of birth.
- On 409 `NIN_CHECK_*` or 504, show the message and offer to try again after `retryAfterSeconds`. Never retry automatically.
- Never echo the NIN after sending it.
- Before this ships: show "NIN Not Verified" with no Verify button and the line "Adding a NIN later is not available yet." A patient with a login can add their own NIN on their profile today (`POST /api/v1/identity/me/verification/nin`). Do not register the person again with the NIN route, because that makes a duplicate record.

### Depends on

- ID-0 (`ninStatus`, the breaker).
- ID-2 / 0130 (records without a NIN).
- ID-4 / 0131 (`identity.own_facility_basis`).
- 0137 `NinCheckOnce`.
- ID-7, for identified unknown records. ID-7's basis for "created as unknown here" must last after the record is identified, or this route cannot reach those patients.
- ID-8, for the follow-up after `NIN_ON_ANOTHER_RECORD`.
- Owner questions: Q109, Q115, Q117 and Q100 B are decided. None are pending.

### Target

Release B, lane A. Size M: one definer function and one route, but every QoreID path and the match rule are reused.

## ID-7: Unknown patient record (planned, Release B, needs a migration: yes)

Akos items:
- P0-4 ("Create an 'Unknown patient' temporary record"; P0-4c in the build plan)
- P0-1 (unconscious patients with no NIN)

Status: planned, not live.

This record is for a person who cannot say who they are: someone unconscious or confused, or a child brought in alone.
- It is a real patient record with a Health ID, so visits, vitals, notes, orders and lab and pharmacy work attach to it as usual.
- It is marked `recordKind: "unknown"`. It has no login, no NIN and no phone, and it is found only at the facility that made it.

Consent rules are unchanged except for one addition. The record counts as "this facility's own" under 0131 at the facility that made it.

Migration (number given at the cut-off):
- `identity.patients` gains `record_kind` (`standard` by default, or `unknown`), `dob_estimated`, `unknown_label` (`U-0001` and up, unique per facility), `created_facility_id`, and `arrival_note_ciphertext` with its key version.
- New definer functions for the routes below.
- 0131's basis function gains one basis: "created as unknown at this facility", read from `created_facility_id` on a record created with `record_kind = 'unknown'`.
  - The basis lasts after `identify` or `confirm-separate` turns the record `standard`, with the same lifetime as ID-2's "registered here".
  - It ends when the record is merged (ID-8) or cancelled.
  - ID-6 relies on this, so the desk can add the NIN after identification, and doctors keep the PIN-free opening.
- 0132's search excludes unknown records from search everywhere and from emergency search.
- First and last names hold placeholders ("Unknown", the label), which are never shown as a name. The 0002 status CHECK is unchanged.

### Routes

All routes below need `X-Facility-Id` and the purpose `healthcare-operations`:
- POST routes send it in the body as `purpose: "healthcare-operations"`.
- GET routes send it as the header `X-Purpose-Of-Use: healthcare-operations`.

Every write needs `Idempotency-Key`. Each route sees only this facility's unknown records; another facility's record, or a missing one, answers 404 `PATIENT_NOT_FOUND` (Q100 B), with the reason kept in the audit row.

**1. `POST /api/v1/identity/unknown-patients`**: make an unknown record.
- Permission `identity.registration.write` (front desk, approvers, doctors, nurses, clinicians; contract "0132").
- Refused at a sealed demo or QA facility, as ID-2 is.

```json
{ "gender": "male", "estimatedAgeYears": 35, "unknownReason": "unconscious",
  "arrivalNote": "Brought by ambulance from Ikeja junction, blue shirt", "purpose": "healthcare-operations" }
```

| Field | Type | Rule |
|---|---|---|
| `gender` | string | required: `female`, `male`, `intersex`, `other` or `unknown` (ID-2's field name and list; ID-2 has it optional, here it is required) |
| `estimatedAgeYears` | integer | optional, 0-120. It is stored as 1 July of (this year in Lagos minus the age), with `dateOfBirthEstimated: true` |
| `unknownReason` | string | required: `unconscious`, `confused`, `unaccompanied_child`, `cannot_communicate` or `other` |
| `arrivalNote` | string | optional, 1-1000 characters. It is encrypted, and never appears in lists, logs or audit rows |

Answer `201`. Answers and cards name the same value `sex`, as 0132's search cards do:

```json
{ "patientId": "uuid", "hid": "HID-...", "recordKind": "unknown", "label": "U-0007",
  "displayName": "Unknown patient U-0007", "sex": "male", "dateOfBirth": "1991-07-01",
  "dateOfBirthEstimated": true, "ninStatus": "not_verified", "status": "open",
  "createdAt": "2026-11-19T14:05:00.000Z", "version": 1, "replayed": false }
```

- `hid` is returned once, for the wristband, as ID-2's answer does.
- No duplicate check runs at creation, because there are no details to compare.
- There is no daily limit (as ID-2, Q109). When one facility makes 20 in a day, Identity logs `identity.unknown_patient.facility_daily_high` with the facility id and the count only.

**2. `GET /api/v1/identity/unknown-patients?status=open|all&limit=1..100&cursor=`**: this facility's unknown records, newest first, with the same permission.
- Cards carry `patientId`, `label`, `displayName`, `sex`, `dateOfBirth`, `dateOfBirthEstimated`, `healthIdLast4`, `unknownReason`, `status` (`open`, `sent_for_review`, `identified`, `merged` or `cancelled`), `createdAt`, `openDays`, `overdue` and `version`. They never carry the arrival note.
- `overdue` is true for an open record older than 30 days. A daily log line `identity.unknown_patient.overdue` holds the facility id and the count only. Nothing is closed or deleted automatically.

**3. `GET /api/v1/identity/unknown-patients/:patientId`**: one card plus `arrivalNote`, with the same permission.

**4. `POST /api/v1/identity/unknown-patients/:patientId/identify`**: record the person's real details once they are known.
- Permission `identity.registration.write`.
- Body: ID-2's fields (`firstName`, `lastName`, `dateOfBirth`, `gender`, and the contact set `phone`, `addressLine`, `city`, `stateCode`, `lga`, required unless the person is a child) plus `expectedVersion`.
- The request runs ID-2's possible-duplicate check (the same candidate rules). The person who identifies the patient never sees candidate details.
  - **No candidates:** the details are saved, the record becomes `standard` (`dateOfBirthEstimated: false`, `ninStatus: "not_verified"`), and the answer is `outcome: "identified"`. The record is now found by search like any ID-2 patient, and ID-6 can add the NIN.
  - **Any candidate:** the answer is `outcome: "sent_for_review"` with "This may be someone who is already registered. An approver will review it." The proposed details are held, and the record stays `unknown`, so it stays hidden from search everywhere and stays a merge source. An approver then decides with route 5, or from Release C by merging (ID-8).

**5. `POST /api/v1/identity/unknown-patients/:patientId/confirm-separate`**: the approver decides the person is nobody already registered.
- Permission `identity.registration.approve`. The approver must not be the member who identified the patient.
- Body `{ "expectedVersion": 3, "reason": "8-500 characters", "purpose": "healthcare-operations" }`.
- The held details are applied, and the record becomes `standard`.

**6. `POST /api/v1/identity/unknown-patients/:patientId/cancel`**: for a record made in error.
- Permission `identity.registration.approve`.
- Body `{ expectedVersion, reason (8-500), purpose }`.
- Allowed only while nothing clinical is attached: no visit that is not cancelled or entered in error, and no note, vitals, order, diagnosis or document.
- The record's status becomes `inactive`.

How the rest of the system treats an unknown record:

- **Own facility (0131):** at the facility that made it, doctors, nurses and clinicians open it with `POST /api/v1/identity/own-facility-access` with no PIN (24 hours, and opened again as needed). This stays true after it is identified. Another facility has no basis and must use break-glass.
- **Search (0132):** an unknown record is never found by search everywhere or by emergency search. At this facility, a Health ID alone finds it (from the wristband). Search cards, the waiting-list card (EHR-C7) and `patient-lookup` gain `recordKind`.
- **Waiting list (EHR-C7):** check-in by `patientId` works, because the record is this facility's own.
- **Pharmacy and lab (0133):** they work as for any own-facility patient. Cards show `displayName`.
- **Logins:** an unknown record never gets a login, enrolment or Access PIN.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | "Check the highlighted fields." (an unknown field, an age outside 0-120, a note over 1000 characters) |
| 400 | `PHONE_REQUIRED`, `NOT_A_CHILD` | as ID-2 (identify only) |
| 400 | `PURPOSE_OF_USE_REQUIRED`, `IDEMPOTENCY_KEY_REQUIRED` | as ID-6 |
| 403 | `PERMISSION_DENIED` | "You do not have permission to do this." |
| 403 | `UNKNOWN_PATIENT_NOT_AVAILABLE` | "Unknown patient records cannot be made at this facility." (sealed facility) |
| 403 | `UNKNOWN_PATIENT_SECOND_PERSON_REQUIRED` | "Another approver must confirm this. You identified this patient." |
| 404 | `PATIENT_NOT_FOUND` | "No such patient." (Q100 B; a missing record, or one that is not this facility's unknown record) |
| 409 | `UNKNOWN_PATIENT_ALREADY_IDENTIFIED` | "This patient has already been identified." |
| 409 | `UNKNOWN_PATIENT_NOT_IN_REVIEW` | "This record is not waiting for review." (confirm-separate) |
| 409 | `UNKNOWN_PATIENT_HAS_RECORDS` | "This record already has clinical records, so it cannot be cancelled. Merge it into the right record instead." |
| 409 | `IDEMPOTENCY_KEY_REUSED` | as ID-6 |
| 412 | `VERSION_CONFLICT` | "Someone else changed this record. Reload it and try again." |
| 503 | `UNKNOWN_PATIENT_UNAVAILABLE` | "Unknown patient records are not available right now." (a database without this migration) |

Audit:
- Every route writes one row, and every list read also writes one row per patient shown. The actions are `identity.unknown-patient.create`, `.list` plus `.list.shown`, `.read`, `.identify`, `.confirm-separate` and `.cancel`.
- Each row holds patient ids, outcome or refusal kind (including the not-found reason behind a 404), and candidate counts.
- No row ever holds a name, date of birth, phone, Health ID or the arrival note.

### Screen notes

- Add "Unknown patient" next to "Register without a NIN" and in the emergency flow. It asks for gender, estimated age, the reason and the arrival note.
- Show `displayName` and the label in large type, "Estimated age" when `dateOfBirthEstimated`, and "NIN Not Verified". Offer to print the Health ID for the wristband.
- Add an "Unknown patients" list for this facility. Mark `overdue` records "Open for more than 30 days: identify or merge".
- "Identify patient" uses ID-2's form. On `sent_for_review`, show the message and no one else's details. Approvers see Confirm separate; Merge comes from Release C.
- After identify gives `identified`, offer "Verify NIN" (ID-6).
- Before this ships: show "Unknown patient records are not available yet." Do not create a made-up name through ID-2. ID-2 needs a real date of birth and a phone for adults, and a made-up record cannot be told apart from a real one later. For an existing patient, emergency search plus break-glass (0132, ID-5) works today.

### Depends on

- ID-2 / 0130 (fields, duplicate rule, approver review).
- ID-4 / 0131 (basis function, extended with "created as unknown here").
- 0132 (search exclusion and `recordKind` on cards; lane B edits its own function).
- EHR-C7 / 0135 (card field).
- 0133.
- ID-6, after identify.
- ID-8, the merge path from Release C.
- Owner questions: none pending for this package. The merge path follows owner decision Q127 A, 19 Nov 2026 (see ID-8). Open point with no decision yet, to be decided before this section is built: whether the sealed QA facility may make unknown records for testing. Recommended: yes, as sealed QA patients.

### Target

Release B, lane A (with the lane B search change). Size M.


## SX-4: Add or remove one role for a staff member (planned, Release B, needs a migration: yes)

Akos items:
- N-2a (one person can hold several roles at a facility)
- N-2c (admin routes to assign roles)

Status: planned, not live.

Owner decision Q129 A, 19 Nov 2026. Facility administrators add and remove roles for their own staff. At governed facilities (QA Hospital included), Health ID support does it, with a licence check.

**What exists today.** The database already lets one membership hold several roles (`auth.account_roles`). Today's screens can only *replace* a member's roles with one role: `POST /identity/facility-staff/:membershipId/role` (`facility-staff.controller.ts`, `identity.change_facility_staff_role` in 0086). That route works only at self-signed-up facilities. Governed and legacy facilities get 403 `STAFF_MANAGEMENT_NOT_AVAILABLE`. The route stays as it is. SX-4 adds two narrower commands beside it.

### Routes

All routes are under `/api/v1`. Membership ids are UUIDs, and no Health ID or NIN appears anywhere in these routes.

| Method and path | Who may call | Permission |
|---|---|---|
| `POST /identity/facility-staff/:membershipId/roles/add` | The facility's administrator, at a self-signed-up facility that support has reviewed, for their own staff. Needs a staff session at the `X-Facility-ID` facility, plus Origin and CSRF checks as today. | `workforce.manage` (owner decision Q129 A, 19 Nov 2026) |
| `POST /identity/facility-staff/:membershipId/roles/remove` | Same as above. | `workforce.manage` (owner decision Q129 A, 19 Nov 2026) |
| `POST /admin/facilities/:facilityId/staff/:membershipId/roles/add` | Health ID support, at any facility. This is the only way at governed facilities, QA Hospital included (owner decision Q129 A, 19 Nov 2026). | new `platform.facility-staff.manage`, given to the platform roles that hold `platform.principal.manage` today |
| `POST /admin/facilities/:facilityId/staff/:membershipId/roles/remove` | Same as above. | `platform.facility-staff.manage` |

**Facility administrator: add**

Headers: `Idempotency-Key` (required, 16-128 URL-safe characters).

```json
{ "role": "nurse", "licenceBody": "NMCN", "licenceNumber": "NMCN-12345",
  "attested": true, "reason": "Also covers night triage", "currentPassword": "…", "expectedVersion": 4 }
```

| Field | Rule |
|---|---|
| `role` | One of the facility's invitable roles. Today these are `doctor`, `nurse`, `lab`, `pharmacist` and `receptionist`, narrowed by the facility type (`staff-licence.ts`, 0086 `staff_invitable_roles`). CHW-1 adds `community_health_worker`. |
| `licenceBody`, `licenceNumber` | Each role has its own licence: MDCN for doctor, NMCN for nurse, MLSCN for lab, PCN for pharmacist. The front desk (and CHW-1) sends neither field. The number is 3-100 characters. This is the same rule as an invitation (`LicenceMatchesRole`, `staff-invitation.dto.ts`). |
| `attested` | Must be `true`. The administrator vouches for the licence, as on an invitation. |
| `reason` | 8-500 characters. |
| `currentPassword` | 1-256 characters. Re-entered as for today's role change. |
| `expectedVersion` | Integer, at least 1: the membership's `version` from `GET /identity/facility-staff`. |

**Facility administrator: remove**

Body:

```json
{ "role": "lab", "reason": "Moved to the ward full time", "currentPassword": "…", "expectedVersion": 5 }
```

- No licence fields and no `Idempotency-Key`.
- A retry after success answers 409 `FACILITY_STAFF_ROLE_NOT_HELD`. The screen then reloads the list.

**Support routes**

Support sends the same bodies, with these differences:
- No `currentPassword` and no `expectedVersion`.
- `If-Match: "<version>"` and `Idempotency-Key` are required, as for every section 19 command.
- Add also needs `verificationMethod`, which records how support checked the licence. It is one of `regulator_register`, `in_person`, `officer_match`, `cac_registered_contact` or `other` (`VERIFICATION_METHODS`, `staff-licence.ts`), and the licence check is required for every licensed role (owner decision Q129 A, 19 Nov 2026).
- QA Hospital's seal (0123) still applies: support may change roles only for the QA tenant's own fictional staff.

**Answers**

- Add: `201` when a new grant is made. A replay with the same key and body answers `200` with `replayed: true`.
- Remove: `200`.

```json
{ "membershipId": "uuid", "version": 6, "roles": ["doctor", "nurse"], "replayed": false }
```

**What happens**
- An add inserts one `auth.account_roles` row for the membership. For a licensed role it also inserts one licence attestation row tied to that grant (`staff_licence_attestations.role_grant_id`, 0086). Support's attestation records `verification_method`.
- A remove revokes that one role. The revocation reason is "Role removed by the facility administrator" or "Role removed by Health ID support".
- Other roles are untouched.
- Permissions are read on every request (see section 0136), so the change applies from the member's next request. Nobody is signed out.
- Sign-in sites follow section 53's gate. For example, adding `lab` to a hospital doctor also admits them on `lab.`.
- Removing a role closes any open records-processing request the member can no longer use. This is done the way 0136 does it: status `expired`, one `identity.access-request.close` audit row each.

**The last role**
- A member must keep at least one role.
- To end someone's access, use today's `POST /identity/facility-staff/:membershipId/end`.
- An administrator's own membership, the facility administrator's membership, and platform accounts are refused, as today.

**Recovery hold**
- If the caller recovered their account in the last 24 hours, add is refused with `STAFF_RECENT_RECOVERY_HOLD`, as today's role change is (`recent-authentication.ts`).
- Remove is still allowed.

**Audit**
- One row for each success or refusal at the facility: `identity.facility-staff.role-add` or `identity.facility-staff.role-remove`.
- Support's routes write `admin.facility-staff.role-add.request` or `admin.facility-staff.role-remove.request`.
- Each row holds the membership, role, reason and outcome, never a licence number.

**Read change**
- In `GET /identity/facility-staff` and support's `GET /admin/facilities/:facilityId/staff`, each member's `roles` already lists every active role.
- Each member gains `licences: [{ role, body, numberHint, vouchedBy, vouchedAt, method }]`, one per licensed role.
- `licence` stays as it is for older screens.

### Errors

Codes marked "today" already exist. Most are in `staff-invitation-problems.ts`; `STAFF_REAUTHENTICATION_FAILED` is raised in `staff-reauthentication.service.ts:44`, and `STAFF_RECENT_RECOVERY_HOLD` in `auth/recent-authentication.ts`. The others are new.

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Check the highlighted fields. |
| 400 | `STAFF_INVITATION_INVALID` (today) | The licence does not match the role. (Today's text is "The invitation is invalid"; this route gets its own wording.) |
| 400 | `STAFF_INVITATION_ROLE_NOT_ALLOWED` (today) | This facility cannot invite that role. |
| 400 | `FACILITY_STAFF_REASON_INVALID` (today) | Enter a reason of 8 to 500 characters. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Please try again. (The screen sends a new key.) |
| 403 | `PERMISSION_DENIED` | Staff management is not permitted. |
| 403 | `STAFF_MANAGEMENT_NOT_AVAILABLE` (today) | Staff management is not available at this facility. Screen wording: "Ask Health ID support to change roles here." |
| 403 | `STAFF_REAUTHENTICATION_FAILED` (today, `staff-reauthentication.service.ts`) | That password isn't right. |
| 403 | `STAFF_RECENT_RECOVERY_HOLD` (today, `recent-authentication.ts`) | This account was recovered with a verification code less than 24 hours ago; role changes are available again once that period ends. |
| 404 | `FACILITY_STAFF_NOT_FOUND` (today) | Staff member was not found. |
| 409 | `FACILITY_REVIEW_PENDING` (today) | Staff can be added once Health ID support has checked this facility. |
| 409 | `FACILITY_STAFF_SELF` (today) | You cannot change your own membership. |
| 409 | `FACILITY_STAFF_ADMINISTRATOR` (today) | The facility administrator's membership is changed by Health ID support. |
| 409 | `FACILITY_STAFF_ALREADY_ENDED` (today) | This person no longer works at the facility. |
| 409 | `FACILITY_STAFF_PLATFORM_ACCOUNT` (today) | This account's access is managed by Health ID. |
| 409 | `FACILITY_STAFF_ROLE_ALREADY_HELD` | This person already has that role. |
| 409 | `FACILITY_STAFF_ROLE_NOT_HELD` | This person does not have that role. |
| 409 | `FACILITY_STAFF_LAST_ROLE` | This is the person's only role. To stop their access, remove them from the facility. |
| 409 | `VERSION_CONFLICT` (today) | This changed meanwhile; reload before retrying. |
| 409 | `IDEMPOTENCY_KEY_REUSED` | This request was already used for a different change. Please reload and try again. |
| 428 | `IF_MATCH_REQUIRED` (support routes) | Reload the staff list and try again. |
| 503 | `STAFF_MANAGEMENT_UNAVAILABLE` (today) | Staff management is temporarily unavailable. |

### Screen notes

**Staff page**
- Show each member's roles as a list.
- "Add role" offers only the roles in `inviteOptions.roles` that the member does not hold yet, with that role's licence fields.
- "Remove" sits on each role. When only one role is left, it is disabled with the text "To stop their access, remove them from the facility."
- Ask for the password and a reason on both add and remove, as for today's "Change role".

**Governed facilities**
- The administrator sees the roles read-only, with "Ask Health ID support to change roles here."
- Support's console gets the same add and remove controls, plus "How did you check the licence?" (`verificationMethod`).

**Before this ships**
- Keep today's single "Change role" at self-signed-up facilities only.
- Show several roles read-only wherever `roles` has more than one.
- Do not offer add or remove.

### Depends on

- SX-1: session `roles` lists every role, `modules` per facility, and the role-matrix fixture.
- 0136 (role table).
- Ola's 0129, because SX-4 touches the same Identity staff code.
- Q129 A (owner decision, 19 Nov 2026).
- CHW-1 adds one more role to the list.

### Target

Release B (provisional number 0139). Size M: four routes, two database functions (facility and support), the read change, and tests.

## SX-8: Keep the open patient across a reload (planned, Release B, needs a migration: yes)

Akos items:
- P1-2 (a reload loses the open patient)

Status: planned, not live.

The owner's default "Open patient remembered for 8 hours" applies unless the owner objects. Built after Ola's 0129 (section 56), on the same kind of per-sign-in row.

**Why the server holds it.** Health IDs stay out of page addresses, and the app stores nothing on the device. So only the server can remember which patient was open. The server holds it for one sign-in, at one facility, for at most 8 hours. That is also the staff sign-in's own longest life ("Staff and platform sessions keep 8 hours", Patient sessions and self service).

### Routes

All routes are under `/api/v1`. Identity's API allows only GET and POST (section 43.4), so every write is a POST.

| Method and path | Who may call | Permission |
|---|---|---|
| `POST /auth/open-patient` | A staff session of an Identity sign-in at the `X-Facility-ID` facility, with Origin and CSRF checks. | none beyond membership; access to the patient is checked (below) |
| `POST /auth/open-patient/clear` | The same caller. | none |
| `GET /auth/session` (existing, section 56) | As today. | as today |

**Set the open patient**

Body (exactly this; no other field):

```json
{ "patientId": "uuid", "purpose": "direct-care" }
```

- `patientId`: the canonical UUID that the chart's routes already use.
- `purpose`: `direct-care` or `emergency`. Use `emergency` for a patient opened through break-glass.
- A body with `hid`, `healthId`, `matchRef` or `nin` is refused with 400. The open patient is remembered only after access is granted, and by then the screen holds the UUID.

Answer `200`:

```json
{ "openPatient": { "state": "kept", "patientId": "uuid", "expiresAt": "2026-11-20T17:00:00.000Z" } }
```

How the set works:
- Before storing anything, Identity runs the same decision as `POST /identity/authorization/check` for `read_records` at this facility, with this purpose, for this member.
- It uses the check's no-notice form (`precheck`, `identity.service.ts`), so setting the patient never sends the patient a second "Your records were opened" notice. The chart's own reads already sent it.
- A refused or unknown patient stores nothing. Both get the same answer, so this route cannot be used to test whether a UUID exists.
- A new set replaces the old one.
- `expiresAt` is the earlier of the set time plus 8 hours and the sign-in's own end.

**Clear the open patient**
- Called when the user closes the patient. The body is empty: `{}`.
- Answers `200 { "openPatient": null }`.
- It is safe to repeat.

**On the session read**

`GET /auth/session` gains `openPatient` beside `actor` and `facilitySelection`. `POST /auth/refresh` does not carry it, which keeps patient reads to a reload.

```json
{ "openPatient": { "state": "restored", "patientId": "uuid", "purpose": "direct-care",
    "expiresAt": "…", "card": { "fullName": "Amaka Okafor", "sex": "female",
    "dateOfBirth": "1990-05-01", "healthIdLast4": "AA22", "ninStatus": "verified" } } }
```

The card has the same fields as a 0132 search card, with no full Health ID. The chart loads through its normal routes.

| `state` | When |
|---|---|
| `restored` | A patient is stored for this sign-in at the facility being reported, it is under 8 hours old, and the access check still allows `read_records` with the stored purpose. |
| `ended` | The access check no longer allows it: the grant ended or was revoked, a deny directive applies, or the patient is no longer active. No card is sent, and the row is cleared. |
| `expired` | 8 hours have passed. No card is sent, and the row is cleared. |
| `unavailable` | The store could not be read. The session read still answers `200`, as in section 56, never a 5xx. |
| (field absent) | Nothing is stored, the facility being reported is a different one, the setting is off, or the caller is not a staff sign-in. Patients, account-only outreach sessions, OIDC bearer callers and service-session never get the field. |

**What clears it**
- The user clears it, or sets another patient.
- `POST /auth/facility` moves to a different facility. The clear happens in the same transaction as 0129's choice is stored, in every 0129 mode, `off` included.
- Sign-out, sign-out everywhere, or the sign-in ending (the row is read only through a live session of the same family, as 0129's is).
- An `ended` or `expired` read.

**What it does not do**
- It grants nothing. Every chart read still carries `X-Facility-ID` and goes through `authorization/check` as today, and that check sends the patient's "Your records were opened" notice as today.

**Setting**
- A new Identity setting `STAFF_OPEN_PATIENT_ENABLED` (default `false`).
- While it is off, the two routes answer 404 and the field is never sent.
- Identity refuses to start with it on while the 0140 table or its grants are missing, the same start-up check as 0129.

**Database (0140, provisional)**
- One table, `auth.session_open_patient`, one row per sign-in family. Columns: `family_id` (primary key), `account_id`, `membership_id`, `facility_id`, `patient_id`, `purpose`, `set_at`, `expires_at`, `row_version`.
- The foreign keys are as in 0129.
- Identity's runtime gets SELECT, INSERT, UPDATE and DELETE.
- A guard rejects a row for a sign-in that is not a live staff sign-in, or for a membership that is not active at that facility.

**Audit**
- A set writes `auth.open-patient.set`, naming the patient, with outcome success or denied.
- A clear writes `auth.open-patient.clear`.
- Each session read that checks a stored patient writes `auth.open-patient.restore`, naming the patient, with the state.
- The patient's access history is unchanged: restoring is not an opening.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Send the patient's id, not the Health ID. (For a missing or extra field, or a value that is not a UUID.) |
| 400 | `FACILITY_REQUIRED` | Choose where you are working first. |
| 400 | `PURPOSE_OF_USE_REQUIRED` | Choose why you are opening this record. |
| 401 | `AUTHENTICATION_REQUIRED` | Please sign in again. |
| 403 | `PATIENT_SCOPE_DENIED` | This is for staff accounts. |
| 403 | `FACILITY_ACCESS_DENIED` | You are not working at this facility. |
| 403 | `OPEN_PATIENT_NOT_ALLOWED` | You don't have access to this patient's records now. Ask for their Access PIN or send an access request. |
| 404 | `NOT_FOUND` | (setting off; the screen treats it as "not served") |
| 503 | `DEPENDENCY_UNAVAILABLE` | Something went wrong on our side. Please try again. |

Both routes need `X-Facility-ID`. Section 56's known gap (a refusal with no `X-Facility-ID` comes back as 503) therefore does not arise here.

### Screen notes

- After the chart opens (that is, after any read the access check allowed), call `POST /auth/open-patient`. When the patient is closed, call `.../clear`.
- On reload, read `GET /auth/session`:
  - `restored`: reopen that patient's chart with the card as its header while the chart loads.
  - `ended`: show "Your access to this patient has ended", then go to Find patient.
  - `expired`, or the field absent: open Home.
  - `unavailable`: open Home and say nothing.
- Since there is one open patient per sign-in, the patient opened last in any tab is the one restored.
- Never put the patient id in the address.

**Before this ships:** a reload opens Home, as today. Show no "restore" control.

### Depends on

- Ola's 0129 (section 56): SX-8 is rebased after it and uses the same session-family pattern and the same `POST /auth/facility` transaction.
- SX-1 (same `src/auth` code).
- ID-4 (0131) and 0132/ID-5: how a member reaches an allowed patient.
- The owner's default of 8 hours.

### Target

Release B (provisional number 0140). Size S.

## EHR-C6: Consultation drafts saved on the server (planned, Release B, needs a migration: yes)

Akos items:
- N-5 (draft save / auto-save endpoint)
- P1-13 (auto-save part only; note and visit templates are ORD-8, Release C)

Status: planned, not live.

A draft is the unfinished consultation form, saved by the server while the
clinician types, so a refresh, a dropped connection or a switch of device does
not lose it. A draft is not part of the patient's record. It is never shown to
the patient, to other staff, in the chart, the patient chat, the record
evidence, Migrate or OCR, and nothing checks it clinically (no allergy or
same-medicine check) until it is finished through the normal routes. ehr-api
only. The migration adds one table (the plan's provisional number is 0141;
numbers are given out in merge order at the cut-off). Unlike clinical tables,
this table is **not** versioned in `ehr.record_versions` and rows **can** be
deleted (clinical tables cannot: `0004:497` and `0004:514`).

Rules (owner decision Q126 A, 19 Nov 2026):
- **Author only.** Only the member who created the draft (same account, same
  membership, same facility) can list, read, save or discard it. Not another
  doctor, not a facility admin, not Health ID support. Enforced by row-level
  security on the account and membership (owner decision Q126 A, 19 Nov 2026).
- **Deleted 7 days after its last save.** A sweeper removes it for good; it
  is not kept anywhere else in the service (owner decision Q126 A, 19 Nov 2026).
- One draft per author per visit, and one per author per patient with no
  visit yet.
- Every call also needs the patient's consent, as for clinical notes:
  `read_records` to list or read, `write_records` to create or save. Discard
  needs only authorship, so a clinician can always throw away their own draft.

All routes: `X-Facility-Id`, `X-Purpose-Of-Use: direct-care`, permission
`ehr.note.write` (the clinical-notes write permission,
`clinical-notes.controller.ts`). `patientId` and `draftId` are UUIDs. No
Health ID anywhere.

The routes use only `GET`, `POST` and `PATCH`, the methods ehr-api's CORS
allows today (`services/ehr-api/src/main.ts:55`), so no CORS change is needed.

### Routes

| Method and path | Who | Permission |
| --- | --- | --- |
| `POST /api/v1/ehr/patients/:patientId/consultation-drafts` | the author | `ehr.note.write` + `write_records` consent |
| `GET /api/v1/ehr/patients/:patientId/consultation-drafts` | the author (own drafts only) | `ehr.note.write` + `read_records` consent |
| `GET /api/v1/ehr/patients/:patientId/consultation-drafts/:draftId` | the author | `ehr.note.write` + `read_records` consent |
| `PATCH /api/v1/ehr/patients/:patientId/consultation-drafts/:draftId` | the author | `ehr.note.write` + `write_records` consent |
| `POST /api/v1/ehr/patients/:patientId/consultation-drafts/:draftId/discard` | the author | `ehr.note.write` (no consent check) |
| `GET /api/v1/ehr/my-consultation-drafts` | the author (own drafts, all patients, this facility) | `ehr.note.write` |

**Create** needs `Idempotency-Key` (16-128 URL-safe characters, as every
create today, `common/idempotency.ts`). Body:

```json
{ "encounterId": "<uuid>", "formVersion": 1, "content": { "chiefComplaint": "...", "examination": "...", "diagnoses": [] } }
```

| Field | Type and limit |
| --- | --- |
| `encounterId` | optional UUID of an open or completed visit of this patient at this facility; leave out before a visit exists |
| `formVersion` | whole number 1-1000, chosen by the screen so it can read its own older drafts |
| `content` | a JSON object, at most 256 KB (262,144 bytes as UTF-8 JSON), at most 20 levels deep. The server stores it as given and does not read it |

Any other field is refused (`400 VALIDATION_FAILED`). `null` is refused for
every field.

Answer `201` (and the same answer on an idempotent replay):

```json
{ "draftId": "<uuid>", "encounterId": "<uuid>", "formVersion": 1, "rowVersion": 1,
  "sizeBytes": 1834, "createdAt": "...", "savedAt": "...", "expiresAt": "..." }
```

`expiresAt` is `savedAt` + 7 days (owner decision Q126 A, 19 Nov 2026).

**Save** (`PATCH`, the auto-save call) replaces the whole content:

```json
{ "expectedRowVersion": 3, "formVersion": 1, "content": { "...": "..." } }
```

Same limits as create. Answer `200` with the create answer's shape, new
`rowVersion`, `savedAt` and `expiresAt`. No typed reason is ever needed (a
draft is not a clinical record, so FR-1 and Q105 do not apply). A retry of a
save that already went through (same content, and the stored `rowVersion` is
`expectedRowVersion + 1`) answers `200` with the stored draft, not a conflict.

**List for this patient** answers `200` `{ "items": [ draft without content ] }`,
newest save first, at most 20.

**Read one** answers `200` with the create answer's fields plus `content`.

**Discard** (`POST .../:draftId/discard`, body `{}`) answers `204`. It is safe
to repeat: discarding a draft that is already gone answers `204` too. The
screen calls it after the consultation is saved for real (or EHR-C5 does it,
see Depends on).

**My drafts (all patients)** answers `200`:

```json
{ "items": [ { "draftId": "<uuid>", "encounterId": "<uuid>", "savedAt": "...", "expiresAt": "...",
    "patient": { "patientId": "<uuid>", "fullName": "Amaka Okafor", "sex": "female",
                 "dateOfBirth": "1990-05-01", "healthIdLast4": "AA22" } } ],
  "hiddenCount": 1 }
```

The patient fields are the waiting-list card's (EHR-C7, Release A contract).
A draft for a patient whose records the author cannot read now is not listed;
it is counted in `hiddenCount` (it is still deleted on time). At most 50
items, newest save first.

Save limit: 60 saves per member per minute (`429`).

Audit (never the content): `ehr.consultation-draft.create`, `.update`,
`.read`, `.list`, `.discard` and `.expire` (sweeper), each naming the patient,
with `sizeBytes`; `my-consultation-drafts` writes one collection row plus one
row per patient shown, as the waiting list does (EHR-C7). Refusals are
audited as every clinical read is today.

### Errors

| HTTP | Code | Message |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | One or more request fields are invalid. (names the field) |
| 400 | `CONSULTATION_DRAFT_TOO_LARGE` | This draft is too large to save (limit 256 KB). Remove pasted text or split the note. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Idempotency-Key must contain 16 to 128 URL-safe characters (existing) |
| 400 | `PURPOSE_OF_USE_REQUIRED` | existing |
| 403 | `CONSENT_REQUIRED` | existing; the author's access to this patient has ended |
| 403 | `PERMISSION_DENIED` | existing |
| 404 | `CONSULTATION_DRAFT_NOT_FOUND` | This draft was not found. It may have been finished, discarded or kept for more than 7 days. (also for another member's draft) |
| 404 | `CLINICAL_RESOURCE_NOT_FOUND` | existing; the `encounterId` is not this patient's visit here |
| 409 | `CONSULTATION_DRAFT_EXISTS` | You already have a saved draft for this visit. Open it to carry on. (problem carries `draftId`) |
| 409 | `CONSULTATION_DRAFT_CHANGED` | This draft was saved from another tab or device. Reload it before you carry on. |
| 409 | `VISIT_ENTERED_IN_ERROR` | existing (EHR-C8a) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | existing |
| 429 | `CONSULTATION_DRAFT_SAVE_LIMITED` | Saving too often. Your draft will save again in a few seconds. |
| 503 | `CONSULTATION_DRAFTS_UNAVAILABLE` | Drafts cannot be saved right now. Keep this page open and try again. (also on a database without the migration) |

### Screen notes

- Create the draft on the first change, then save with `PATCH` about 3 seconds
  after typing stops and at most every 10 seconds. Always send the
  `rowVersion` from the last answer.
- On opening a consultation, call the per-patient list; if a draft exists,
  offer "Carry on with your saved draft (saved 10:42)" or "Start again"
  (discard).
- Show "Saved 10:42" from `savedAt`, and "Not saved" with a retry after a
  `503` or a network error. On `CONSULTATION_DRAFT_CHANGED`, offer to load the
  newer draft.
- Show "Drafts are kept for 7 days" near the save status
  (owner decision Q126 A, 19 Nov 2026).
- Home or "My work" may show "Unfinished consultations" from
  `my-consultation-drafts`, with "N more for patients you can no longer
  open" from `hiddenCount`.
- **Before this ships:** keep the form in page memory only (the app stores
  nothing on the device) and warn before leaving the page with unsaved
  changes. Save the visit, note and vitals with today's routes (or EHR-C5's
  one call once it ships); a draft note (`status: "draft"`) is the only way
  to keep part of the work on the server today, and it is part of the record.

### Depends on

- Owner decision Q126 A, 19 Nov 2026.
- EHR-C5 (one-call consultation). Proposed: EHR-C5's body takes an optional
  `draftId`, and a successful save deletes that draft in the same
  transaction. Until that is agreed, the screen calls discard after the save
  succeeds.
- EHR-C7 card shape (Release A) for `my-consultation-drafts`.
- ORD-8 (Release C) for note and visit templates; a template fills a new
  draft on the screen only.

### Target

Release B. Size M (one table with row-level security, a sweeper, six routes,
the audit, tests for author-only access and expiry).

## MY-1: "Ordered by me" list (planned, Release B, needs a migration: yes)

Akos items:
- P1-4

Status: planned, not live.

One list of the lab requests and prescriptions this member ordered at this
facility, with their status and the facility's own lab or pharmacy progress,
so doctors stop using the lab and pharmacy work queues. ehr-api only. The
migration adds `ehr.list_my_orders` (SECURITY DEFINER) and indexes on
`(facility_id, created_by_membership_id, created_at desc)` for
`ehr.prescriptions` and `ehr.lab_requests` (the plan's provisional number is
0143). "Ordered by me" means `created_by_membership_id` is this member's
membership at the session facility (the column every order already has,
`prescriptions.service.ts` and `lab-requests.service.ts` COLUMNS).

### Routes

`GET /api/v1/ehr/my-orders`. `X-Facility-Id`, `X-Purpose-Of-Use:
direct-care`. Permission `ehr.prescription.read` for prescription rows and
`ehr.lab-request.read` for lab rows; a member with only one gets only that
kind; with neither, `403`. No patient in the path or query.

Query:

| Parameter | Type and limit | Default |
| --- | --- | --- |
| `kind` | `all`, `lab`, `prescription` | `all` |
| `state` | `open` (draft, active, on hold) or `all` | `all` |
| `since` | `YYYY-MM-DD` (Lagos day), at most 2 years back | 90 days ago |
| `limit` | 1-50 | 25 |
| `cursor` | from the last answer (16-512 URL-safe characters, as today's lists) | none |

Default reach: open orders of any age, plus ended orders (completed or
cancelled) created on or after `since`. This is the same default the owner
chose for the lab and pharmacy lists (Q123 A); `since` is the way to look
further back. Orders entered in error are never listed. Newest first.

Answer `200`, `Cache-Control: no-store`:

```json
{
  "items": [
    { "kind": "lab_request", "orderId": "<uuid>", "encounterId": "<uuid>",
      "patient": { "patientId": "<uuid>", "fullName": "Amaka Okafor", "sex": "female",
                   "dateOfBirth": "1990-05-01", "healthIdLast4": "AA22" },
      "display": "Full blood count", "status": "active", "priority": "urgent",
      "createdAt": "...", "updatedAt": "...",
      "ownProgress": { "status": "results_ready", "receivedAt": "...", "collectedAt": "...", "lastResultAt": "..." },
      "orderRoute": null }
  ],
  "hiddenCount": 2,
  "since": "2026-08-21",
  "nextCursor": null
}
```

- `display`: `testDisplay` or `medicationDisplay` (as stored).
- `priority`: the lab request's priority; for a prescription, 0125's
  `priority` when set, else `null` (section 46).
- `ownProgress`: exactly ORD-3's shapes and statuses (pharmacy: `received`,
  `accepted` once ORD-4 ships, `dispensed`, `dispensing_reversed`, `withdrawn`; lab: `received`,
  `sample_collected`, `some_results_ready`, `results_ready`; plus
  `not_received` and `unknown`). Result values are not in this list; the row
  opens the lab request.
- `orderRoute`: the existing order summary for an order sent to another
  facility (sections 21-24), or `null`.
- The patient fields are the waiting-list card's (EHR-C7). The list never
  carries a Health ID, only `healthIdLast4`.
- **Access ended:** a row is listed only while the member may read that
  patient's records now under direct care (a consent grant or 0131's
  own-facility opening). Other matching orders, including those reachable
  only by break-glass, are not listed and are counted in `hiddenCount`.

Audit: one `ehr.my-orders.list` row (filters, count, `hiddenCount`, patient
ids shown) plus one `ehr.my-orders.list.shown` row per patient shown, on
every read, as the waiting list does (EHR-C7). The progress lookups are
audited by ORD-3 as today.

### Errors

| HTTP | Code | Message |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | One or more request fields are invalid. (bad `kind`, `state`, `since` or `limit`) |
| 400 | `MY_ORDERS_SINCE_TOO_OLD` | You can look back up to 2 years. Choose a later date. |
| 400 | `INVALID_CURSOR` | existing (`clinical-context.ts`) |
| 400 | `PURPOSE_OF_USE_REQUIRED` | existing |
| 403 | `PERMISSION_DENIED` | existing; also `kind=lab` without lab-request read, or `kind=prescription` without prescription read |
| 503 | `MY_ORDERS_UNAVAILABLE` | Your orders cannot be listed right now. Please try again. (also on a database without the migration) |

### Screen notes

- An "Ordered by me" page with tabs All, Lab, Prescriptions, and a switch
  "Open only" (`state=open`). Show patient name, sex, date of birth,
  `•••• healthIdLast4`, the test or medicine, status, priority and the ORD-3
  progress words ("Results ready 11:05", "Dispensed 11:05", "Progress not
  available right now" for `unknown`).
- Show "Showing the last 90 days and everything still open" with "Look
  further back" (sets `since`).
- When `hiddenCount` is above 0: "N more orders are for patients whose
  records you can no longer open."
- Opening a row goes to the visit's order using `patientId`, `encounterId`
  and `orderId` (UUIDs), through the usual consent check.
- **Before this ships:** the per-visit lists (`GET .../encounters/:encounterId/lab-requests`
  and `.../prescriptions`, with ORD-3's `ownProgress`) are the only way. Keep
  doctors off the lab and pharmacy work queues (0136, Release A, removes
  both work-list reads from doctors).

### Depends on

- ORD-3 (wave 1, on staging). Its internal progress call takes one `patientId`
  per call (ORD-3 section). Needed from lane D: a form that takes several
  patients in one call (at most 100 ids in all), or MY-1 makes one call per
  patient on the page (hence the page limit of 50).
- EHR-C7 card shape and 0131 own-facility access (Release A).
- Q123 A (decided) for the default reach.
- ORD-11 (Release C) later adds "new result" and "Seen" marks; not in this
  list.

### Target

Release B. Size M (the definer function with a per-row access check,
indexes, cursor paging, progress calls, audit, tests with ended access).

## VIT-1: Soft "abnormal" vitals warnings (planned, Release B, needs a migration: no)

Akos items:
- P1-11

Status: planned, not live.

The build plan lists this as a gap with no package; VIT-1 is the new id. It
can ship without a migration: the warnings are worked out each time from a
fixed table in ehr-api code and are not stored. Lane C.

**Hard limits already exist today.** Every vitals create and correction is
checked against fixed limits in `VitalMeasurementsDto`
(`clinical.dto.ts`) and the same CHECKs in the database (`0004:124-131`):
height 20-300 cm, weight 0.2-700 kg, temperature 20-50 °C, pulse 10-350,
breathing rate 1-100, systolic 30-350, diastolic 10-250, oxygen 0-100 %.
So BP 900 and pulse −5 already answer `400 VALIDATION_FAILED` naming the
field. Akos's report should be checked on QA against the screen. Blood
pressure must be sent as a pair (`BLOOD_PRESSURE_INCOMPLETE`,
`vitals.service.ts`).

VIT-1 adds one hard rule and the soft warnings:

- **New hard rule (code only):** diastolic must be lower than systolic on a
  create or correction (`400 BLOOD_PRESSURE_ORDER_INVALID`). Rows already
  stored are not touched.
- **Soft warnings never block a save.** They are returned with the answer.

### Routes

| Method and path | Who | Permission |
| --- | --- | --- |
| `GET /api/v1/ehr/vitals/usual-ranges` | any member who can read vitals | `ehr.vital.read` |
| `POST .../encounters/:encounterId/vitals` (existing, `vitals.controller.ts`) | unchanged | `ehr.vital.write` |
| `POST .../vitals/:vitalId/corrections` (existing) | unchanged | `ehr.vital.write` |
| `GET /api/v1/ehr/patients/:patientId/vitals/latest` (EHR-C3, wave 1) | unchanged | `ehr.vital.read` |

Request bodies do not change, so Idempotency-Key digests do not change.

**Usual ranges** (no patient, no consent check, no patient audit; `Cache-Control:
private, max-age=3600`):

```json
{ "version": "2026-11-adult-1", "appliesTo": "adults (18 and over)", "approvedBy": null,
  "ranges": [
    { "measure": "pulseBpm", "level": "far_outside_usual", "atOrBelow": 40 },
    { "measure": "pulseBpm", "level": "outside_usual", "from": 41, "to": 50 },
    { "measure": "pulseBpm", "level": "outside_usual", "from": 111, "to": 130 },
    { "measure": "pulseBpm", "level": "far_outside_usual", "atOrAbove": 131 },
    { "measure": "pulseBpm", "level": "check_entry", "atOrAbove": 251 }
  ] }
```

Draft table for the clinical lead to approve. The low bands and the very
high pulse, breathing and temperature bands follow the Royal College of
Physicians' NEWS2 score; the high blood pressure bands (systolic 180,
diastolic 110) follow common severe-hypertension thresholds:

| Measure | `outside_usual` | `far_outside_usual` | `check_entry` (probably a typing mistake) |
| --- | --- | --- | --- |
| Breathing rate | 9-11 or 21-24 | 8 or below, 25 or above | 61 or above |
| Oxygen % | 92-95 | 91 or below | below 50 |
| Systolic | 91-100 or 180-219 | 90 or below, 220 or above | above 300 |
| Diastolic | 110 or above, or 40 or below | | above 200 |
| Pulse | 41-50 or 111-130 | 40 or below, 131 or above | above 250 |
| Temperature °C | 38.1-39.0 | 35.0 or below, 39.1 or above | below 30 or above 44 |
| Height, weight | none | none | none |

`approvedBy` stays `null` until Health ID's named clinical lead signs the
table off, with the same review as the medicine and lab-test lists
(owner decision Q124 A, 19 Nov 2026). Child ranges are a later version of the
table.

**Warnings on answers.** The vitals create answer (`201`, and its replay)
and the correction answer gain:

```json
{ "warnings": [
    { "measure": "pulseBpm", "value": 135, "level": "far_outside_usual",
      "code": "VITAL_FAR_OUTSIDE_USUAL_RANGE",
      "message": "Pulse is very high: 135 a minute. Usual for adults: 51 to 110." } ],
  "usualRangesVersion": "2026-11-adult-1" }
```

For a correction the warnings are for the values after the correction. Each
measure in `vitals/latest` gains `warning` (the same object, or `null`;
for `bloodPressure`, the more serious warning of the two halves).
`warnings` is `[]` when nothing is outside the usual range. Codes:
`VITAL_OUTSIDE_USUAL_RANGE`, `VITAL_FAR_OUTSIDE_USUAL_RANGE`,
`VITAL_CHECK_ENTRY` ("Check this entry: a temperature of 45 °C is very
unlikely."). Warnings are worked out for every patient from the adult
table; the screen decides whether to show them (see Screen notes). Nothing is
stored and no audit field changes; the reads are audited as today.

### Errors

| HTTP | Code | Message |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | One or more request fields are invalid. (existing hard limits, names the field) |
| 400 | `BLOOD_PRESSURE_INCOMPLETE` | Systolic and diastolic pressure must be supplied together (existing) |
| 400 | `BLOOD_PRESSURE_ORDER_INVALID` | The lower blood pressure number (diastolic) must be less than the upper one (systolic). Check the reading. (new) |
| 403 | `PERMISSION_DENIED` | existing (usual-ranges without vitals read) |

Warnings are never errors.

### Screen notes

- Before Save, compare the typed values with `usual-ranges` (fetch once per
  session) and show the "are you sure" step for `check_entry` and
  `far_outside_usual`; Save stays possible. After Save, show the answer's
  `warnings` next to each value.
- Show warnings only for patients 18 and over (the screen has the date of
  birth on the patient card). For younger patients show nothing until child
  ranges exist.
- BMI is worked out on the screen from height and weight (Akos's plan).
- Mark values with a `warning` in "Latest vitals" (EHR-C3).
- **Before this ships:** the hard limits above already refuse impossible
  values; show the `400` field messages. The screen may use the draft table
  above as its own copy, labelled as not yet approved.

### Depends on

- EHR-C3 (wave 1, on staging) for the `warning` on latest vitals.
- EHR-C8b: vitals entered in error get no warnings and are not in latest.
- Q124 A (owner decision, 19 Nov 2026): Health ID's named clinical lead signs the
  table off. The screen can
  ship before sign-off with `approvedBy: null`.

### Target

Release B (code only; it can ship any time after the table is agreed). Size
S.

## EHR-C8b: Vitals marked entered in error (planned, Release B, needs a migration: yes)

Akos items:
- P1-14 (latest vitals must leave out a wrong reading)
- QA open question: mark the QA test vitals record "entered in error"

Status: planned, not live.

Today a single vitals record cannot be withdrawn. A correction must keep at
least one value (`VITAL_MEASUREMENT_REQUIRED`, `vitals.service.ts`), so vitals
taken on the wrong patient stay unless the whole visit is entered in error
(EHR-C8a). EHR-C3 states this gap ("A single vital entered in error waits for
EHR-C8b"). The migration adds `ehr.vitals.status` (`recorded` or
`entered_in_error`, default `recorded`), a partial index for the latest
reading per patient and facility that leaves out entered-in-error rows, and
the patient's own read policy change (the plan's provisional number is
0142). The change goes through the existing version trigger, so the reason,
who and when are kept in `ehr.record_versions` (`0004:497`); rows still
cannot be deleted (`0004:514`).

### Routes

`PATCH /api/v1/ehr/patients/:patientId/encounters/:encounterId/vitals/:vitalId`
(new). `X-Facility-Id`, `X-Purpose-Of-Use: direct-care`, permission
`ehr.vital.write`, the patient's `write_records` consent (the same as a
correction today, `vitals.controller.ts`). Any member who may correct
vitals here may do it. UUIDs only.

Body, exactly these fields:

```json
{ "expectedRowVersion": 2, "status": "entered_in_error", "changeReason": "Recorded on the wrong patient" }
```

| Field | Type and limit |
| --- | --- |
| `expectedRowVersion` | whole number, 1 or more (the vital's `rowVersion`) |
| `status` | only `entered_in_error` |
| `changeReason` | **required**, trimmed, 3-500 characters (entering in error always needs a typed reason, FR-1 table) |

No Idempotency-Key: like other `PATCH` routes it is protected by
`expectedRowVersion`. The vital is locked (`FOR UPDATE`) before the checks.

Answer `200`: the vital as `GET .../vitals/:vitalId` returns it, with
`status: "entered_in_error"`, `statusChangedAt` and the new `rowVersion`.

Every vitals answer (list, read, create, correction, replay) gains `status`
(`recorded` or `entered_in_error`). Exact-body tests need updating.

What changes elsewhere:

| Read | Entered-in-error vitals |
| --- | --- |
| `GET .../encounters/:encounterId/vitals` | left out by default; `?includeEnteredInError=true` lists them with their status |
| `GET .../vitals/:vitalId` and `.../corrections` | still answered, with `status` |
| `GET /ehr/patients/:patientId/vitals/latest` (EHR-C3) | left out; the next newest reading is used |
| Patient's own record and patient chat; staff record evidence and staff chat (`patient-evidence.query.ts`) | left out |
| Chart summary (EHR-C4) and VIT-1 warnings, when they ship | left out |
| `POST .../vitals/:vitalId/corrections` | refused, `409 VITAL_ENTERED_IN_ERROR` |

It cannot be undone. To fix a mistake, record the vitals again.

Audit: `ehr.vital.update` naming the patient, with `enteredInError: true`;
never the typed reason or the values (as FR-1: the typed text is never in
the audit row). A refusal is audited as today.

### Errors

| HTTP | Code | Message |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | One or more request fields are invalid. (another status, a reason under 3 or over 500 characters, an unknown field) |
| 400 | `CHANGE_REASON_REQUIRED` | Please say why you are changing this. (existing) |
| 400 | `PURPOSE_OF_USE_REQUIRED` | existing |
| 403 | `CONSENT_REQUIRED` | existing |
| 403 | `PERMISSION_DENIED` | existing |
| 404 | `VITAL_NOT_FOUND` | existing code; message becomes "These vitals were not found." |
| 409 | `VITAL_ALREADY_ENTERED_IN_ERROR` | These vitals are already marked as entered in error. |
| 409 | `VITAL_ENTERED_IN_ERROR` | These vitals were marked as entered in error. Record new vitals instead. (on a correction) |
| 412 | `VERSION_CONFLICT` | existing code; message becomes "Someone else changed these vitals. Reload them and try again." |
| 503 | `VITALS_STATUS_UNAVAILABLE` | This cannot be done right now. Please try again. (also on a database without the migration) |

### Screen notes

- Offer "Entered in error" on each vitals row of a visit. Ask for the reason
  (required), send `expectedRowVersion`, then read the list and "Latest
  vitals" again.
- History may show withdrawn readings struck through, labelled "Entered in
  error", using `includeEnteredInError=true`.
- On `VITAL_ALREADY_ENTERED_IN_ERROR` treat it as done; on `VERSION_CONFLICT`
  reload and ask again.
- Show "Latest vitals" (P1-14) at the top of the consultation from EHR-C3,
  one call per patient.
- **Before this ships:** a wrong value can be corrected
  (`POST .../vitals/:vitalId/corrections`, reason required), but a whole
  reading cannot be withdrawn. Vitals on the wrong patient leave "Latest
  vitals" and the patient's record only if the whole visit is entered in
  error (EHR-C8a for a completed visit). For the QA test record: enter the
  QA visit in error once its notes and orders are entered in error.

### Depends on

- EHR-C3 and EHR-C8a (wave 1, on staging).
- EHR-C4 (chart summary) must use the same rule when it ships.
- VIT-1 (warnings leave these out).
- No owner question.

### Target

Release B. Size S (one column and index, one route, the read filters,
policy change, tests).

## ORD-12: Refills on prescriptions (planned, Release B, needs a migration: yes)

Akos items: N-9 (refills only; strength, form, duration and quantity are live in 0125, section 46; create-as-active already works; formulary search is ORD-7).

Status: planned, not live. Owner decision Q131 A, 19 Nov 2026: yes to refills.

(ORD-12 is a new package id; the build plan lists this under its gaps as "N-9b refills".)

Today one pharmacy work item takes one dispensing only. `pharmacy.dispensings.work_item_id` is unique (`0023:118`), and a second dispensing answers 409 `PHARMACY_WORK_ITEM_ALREADY_DISPENSED` (`pharmacy.service.ts:368`). Section 13 says it too: "partial fills and refills are not modeled".

### Routes

No new route. Changed:

| Method | Path | Who | Permission |
|---|---|---|---|
| POST | `/api/v1/ehr/patients/:patientId/encounters/:encounterId/prescriptions` | prescriber | `ehr.prescription.write` |
| GET | prescription list and read (as today, plus ORD-3) | as today | `ehr.prescription.read` |
| GET | `/api/v1/pharmacy/work-items`, `/api/v1/pharmacy/work-items/:workItemId` | pharmacy staff | `pharmacy.work-item.read` |
| POST | `/api/v1/pharmacy/work-items/:workItemId/dispensings` | pharmacist | `pharmacy.dispensing.create` |

Prescription create body: new optional field (owner decision Q131 A, 19 Nov 2026).

| Field | Value |
|---|---|
| `refillsAllowed` | whole number 0-11. Left out means 0. Set at creation only, like the 0125 fields. The update body never changes it; for a different number, write a new prescription. |

Every prescription answer gains `refillsAllowed`. `ownProgress` (ORD-3) gains `fillsDispensed` (whole number) and `refillsRemaining` (whole number, or `null` when not known).

Own pharmacy work items (no order route) gain:

```json
{ "refillsAllowed": 2, "fillsDispensed": 1, "refillsRemaining": 1, "lastDispensedAt": "2026-11-19T11:05:00.000Z" }
```

Dispensing: the body is unchanged (`CreateDispensingDto`: `expectedWorkItemVersion`, `quantityDispensed`, `quantityUnit`, `reason` 8-500), and the `Idempotency-Key` is required as today.
- A work item now takes up to `1 + refillsAllowed` dispensings (owner decision Q131 A, 19 Nov 2026).
- The answer gains `fillNumber`: 1 is the first fill, 2 and above are refills.
- A refill also needs the prescription to be active and not past its `endsOn` (Lagos day). It is checked by 0101's guard, as the first fill is.
- A reversed fill still counts as used. A reversal never gives a refill back, as today a reversed dispensing counts as done.

Routed prescriptions (an outside pharmacy) do not carry refills in this package, as the 0125 details don't ("item 4b, later"). After the hospital pharmacy's first fill, refills stay at the hospital pharmacy. The prescriber may route to an outside pharmacy only until the hospital pharmacy starts dispensing (Q119 and Q121 A). Splitting one prescription across several pharmacies is a later project.

Pharmacy work list:
- Its default stays open work plus the last 90 days (Q123 A).
- An item with refills left whose prescription is still active is also listed, marked "Refills left: N", until the refills are used or the prescription ends.

Audit: today's `pharmacy.dispensing.create` row, plus `fillNumber`. No new patient read, so no new audit row.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Names `refillsAllowed` (not a whole number 0-11, or `null`). |
| 409 | `PHARMACY_NO_REFILLS_LEFT` | No refills are left on this prescription. Ask the prescriber for a new one. |
| 409 | `PHARMACY_REFILL_PRESCRIPTION_ENDED` | This prescription has ended. Ask the prescriber for a new one. |
| 409 | `PHARMACY_WORK_ITEM_ALREADY_DISPENSED` | Unchanged, for a prescription with no refills. |
| 409 | `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` | Unchanged (0101): held, stopped, changed or entered in error. |
| 412 | `PHARMACY_WORK_ITEM_VERSION_CONFLICT` | Unchanged. |

### Screen notes

- **Before this ships:** hide a refills field. Next to Quantity, show "Refills are not available yet. Write a new prescription for each fill." Do not put refills in the instructions text: the pharmacy cannot record a second fill today.
- **After:**
  - Prescribe form: "Refills" (0-11, default 0).
  - Prescription row: "Dispensed 11:05 · 1 refill left".
  - Pharmacy: "Fill 2 of 3", with "Last dispensed 19 Nov". On the error, show its message.
  - When routing to an outside pharmacy: "Refills apply at this hospital's pharmacy only."

### Depends on

- 0125 (section 46) and 0101 (dispensing guard).
- ORD-2 (0133, own pharmacy work) and ORD-3.
- Q123 A and Q119 and Q121 A (decided). Q131 A (decided 19 Nov 2026).
- ORD-11 does not notify for refills, only for the first fill and reversals.

### Target

Release B (lane D), as the build plan's default ("refills are added to the 0125 prescription details"). Size **M**:
- one column and CHECK on `ehr.prescriptions`, taking 0125's lock (ACCESS EXCLUSIVE NOWAIT);
- replacing the unique `work_item_id` on `pharmacy.dispensings` with a unique (`work_item_id`, `fill_number`);
- 0101's guard;
- the list and progress fields.

If the pharmacy half misses the Release B cut-off, it moves to Release C. Release B then ships the field and its display only, and the screen keeps the "not available yet" line for second fills.

## ORD-7: Medicine and lab-test lists, and lab tests by name only (planned, Release B, needs a migration: yes)

Akos items: P0-5, N-7, N-9, R-2, R-3, P2-5.

Status: planned, not live.

Build plan of 18 Nov 2026, migration 0144 (provisional; numbers are given in
merge order at the Release B cut-off), lane D. Today there is no list route:
the screen's built-in lists and Wave 0's HID-LAB codes (live contract, "Wave
0", R-2; `docs/codes/hid-lab-codes.json`) are the answer, and a lab request
must have a code (`0004:243`, F3).

### Routes

All in ehr-api (`ehr/catalog/`). Each needs `X-Facility-Id` (facility items
differ per facility). They hold no patient, so they take no
`X-Purpose-Of-Use` and write no patient audit row. The search text goes in
`q`: a `q` shaped like a Health ID or an 11-digit NIN is refused, so neither
lands in a URL or a log, and `q` is never written to an audit row or log.
Answers carry `Cache-Control: private, max-age=60`.

| Method and path | Who may call | Permission |
| --- | --- | --- |
| `GET /api/v1/ehr/catalog/status` | any staff member of the facility | facility membership only |
| `GET /api/v1/ehr/catalog/medicines?q=&limit=&doseForm=&route=` | prescribers, pharmacy staff | `ehr.prescription.write` or `pharmacy.work-item.read` (existing codes) |
| `GET /api/v1/ehr/catalog/lab-tests?q=&limit=` | lab requesters, lab staff | `ehr.lab-request.write` or `lab.work-item.read` (existing codes) |
| `GET /api/v1/ehr/catalog/facility-items?kind=` | hospital administrator | `ehr.catalog.facility-item.write` (new) |
| `POST /api/v1/ehr/catalog/facility-items` | hospital administrator | `ehr.catalog.facility-item.write` (new); `Idempotency-Key` required |
| `PATCH /api/v1/ehr/catalog/facility-items/:itemId` | hospital administrator | `ehr.catalog.facility-item.write` (new) |

The new permission goes to the `admin` role only. The SX-1 role-matrix
fixture is updated in the same PR.

**`GET .../catalog/status`** tells the screen what is live. Before 0144
ships it answers 404. ORD-9 and ORD-10 phase 2 fill their own fields.

```json
{ "medicines": { "available": true, "version": "2026.1", "approvedAt": "2026-12-01" },
  "labTests":  { "available": true, "version": "2026.1", "approvedAt": "2026-12-01" },
  "diagnoses": { "available": false, "release": null },
  "labTestNameOnly": true, "diagnosisNameOnly": false, "classDuplicateCheck": false,
  "attribution": ["This material contains content from LOINC (http://loinc.org) ..."] }
```

**Medicine search.** `q` 2-100 characters after trimming. `limit` 1-25,
default 10. Optional `doseForm` is one of section 46's values (`tablet`,
`capsule`, `liquid`, `injection`, `cream`, `inhaler`, `drops`, `other`).
Optional `route` is a plain word up to 100 characters. Each word of `q` must
start a word of the generic name, another name or a brand name. Other names
and brands come from `ocr-worker/src/reading/drug-list.ts` and
`brand-names.ts`, and an item is always shown under its generic name. Names
that start with `q` come first, then the rest in A to Z order. Withdrawn
items are never offered.

```json
{ "listVersion": "2026.1", "more": false,
  "items": [ { "codeSystem": "HID-MED", "code": "M00042",
    "display": "Amoxicillin 500 mg capsule", "genericName": "Amoxicillin",
    "strength": "500 mg", "doseForm": "capsule", "doseFormText": "Capsule",
    "routes": ["oral"], "atcCode": "J01CA04",
    "commonAdultDose": "500 mg every 8 hours",
    "matchedName": null, "scope": "national", "source": "nigeria-eml-7" } ] }
```

| Field | Type and limit |
| --- | --- |
| `codeSystem`, `code` | `HID-MED` (national) or `HID-FACILITY` (this facility's own). The code is up to 100 characters, fixed, never changed and never reused |
| `display` | 1-500 characters. It fits `medicationDisplay` |
| `genericName` | the INN, 1-200 characters |
| `strength` | up to 80 characters or `null`. It fits section 46's `strength` |
| `doseForm` | section 46's value; `doseFormText` is the list's own words (up to 80) |
| `routes` | plain words, each up to 100 characters (R-3) |
| `atcCode` | text or `null` |
| `commonAdultDose` | a hint up to 240 characters or `null`. No children's doses in the first version |
| `matchedName` | the other name or brand that matched, or `null` |
| `scope` | `national` or `facility` |
| `source` | `nigeria-eml-7`, `who-eml` or `facility` |
| `more` | `true` when more items matched than `limit` |

The prescription create route does not change (R-3, section 46). The screen
sends `display` as `medicationDisplay`, `codeSystem` and `code` as
`medicationCodeSystem` and `medicationCode`, `strength` and `doseForm`, and
one of `routes` as `routeCode`. Every value fits today's limits.

**Lab test search.** `q` and `limit` work as for medicines. Matches are on
the name and its other names (FBC, E/U/Cr).

```json
{ "listVersion": "2026.1", "more": false,
  "items": [ { "codeSystem": "LOINC", "code": "58410-2", "display": "Full blood count",
    "otherNames": ["FBC", "Complete blood count"], "specimen": "Blood (EDTA)",
    "category": "haematology", "matchedName": "FBC", "scope": "national" },
    { "codeSystem": "HID-LAB", "code": "WIDAL", "display": "Widal test", "otherNames": [],
      "specimen": "Serum", "category": "serology", "matchedName": null, "scope": "national" } ] }
```

- `codeSystem` is `LOINC`, `HID-LAB` or `HID-FACILITY`.
- `display` is 1-500 characters and fits `testDisplay`.
- `specimen` is up to 100 characters and fits `specimenTypeCode`.
- `category` is one of `haematology`, `chemistry`, `microbiology`,
  `serology`, `parasitology`, `urine-and-stool`, `hormones`, `molecular`,
  `other`.
- The 13 Wave 0 HID-LAB codes move in unchanged: same codes and names.
  Wave 0's rules still apply, so a code is never changed or reused, and the
  names stay as they are for the patient record chat's sensitive-test check.
  New HID-LAB codes follow the same rules.

**Facility items** (build plan section 6). A facility's own items show only
at that facility, marked "Added by this facility". A facility may have at
most 500 active items of each kind.

`POST` body. `kind` is required: `medicine` or `lab_test`. `display` is
required (1-500). For a medicine, `genericName` (1-200) is also required,
with optional `strength` (up to 80), `doseForm` (section 46's values) and
`routes` (at most 5 words, each up to 100). For a test, `specimen` (up to
100) and `category` are optional. Any other field is refused.

```json
{ "kind": "medicine", "display": "Artemether + lumefantrine 20/120 mg dispersible tablet",
  "genericName": "Artemether + lumefantrine", "strength": "20/120 mg", "doseForm": "tablet",
  "routes": ["oral"] }
```

Answer `201`: the item in the search shape, with `codeSystem:
"HID-FACILITY"`, `code` equal to `itemId` (a UUID), and `rowVersion`,
`active: true` and `addedAt`. A replay with the same key and body gives the
same answer.

`PATCH` body is `{ "expectedRowVersion": 3, "active": false }`. It only
withdraws an item or brings it back. To correct one, withdraw it and add a
new one.

`GET ?kind=` lists this facility's items, active and withdrawn, at most 1,000.

Audit rows: `ehr.catalog.facility-item.created` and `.changed`, with the
item and the actor. No patient is involved.

**Lab requests by name only (F3).** While `LAB_REQUEST_NAME_ONLY_ENABLED`
is `true`, `POST .../encounters/:encounterId/lab-requests` takes
`testCodeSystem` and `testCode` as optional, both or neither. `testDisplay`
is still required (1-500). The setting is set in ehr-api and lab-api
together, like section 46's setting.

- Every lab request answer (list, read, create, update, replay) gives
  `"testCodeSystem": null, "testCode": null` for a request saved by name
  only. Lab work items (own and routed) do the same.
- Sending to this facility's lab (`POST .../:requestId/lab-work-item`, and
  ORD-2) and to another facility's lab (order routes) carries the nulls. The
  route mapping already types the test code as nullable
  (`order-route.mapping.ts:89`).
- A sensitive test is still hidden from the patient's record chat by its
  name (`patient-evidence.policy.ts:146-148` checks the name first).
- While the setting is off, the routes behave exactly as today.

**Database (0144).**
- `ehr.lab_requests.test_code_system` and `test_code` (`0004:242-243`) and
  `lab.work_items.test_code_system` and `test_code` (`0018:27-28`) become
  nullable. A pair CHECK is added NOT VALID, then validated.
- Lab's check that a work item equals its EHR order compares the codes with
  `IS NOT DISTINCT FROM`. Lab-api's `AcceptEhrOrderDto`
  (`accept-ehr-order.dto.ts:15-16`) makes the pair optional.
- New tables: `ehr.catalog_versions`, `ehr.catalog_medicines`,
  `ehr.catalog_lab_tests`, `ehr.catalog_facility_items` (row security by
  facility) and `ehr.duplicate_class_rules` (used by ORD-10 phase 2).
- Search uses PostgreSQL's built-in full-text search with prefix matching
  and a GIN index. No new extension is needed (only pgcrypto and vector are
  installed). So the first version does not match misspellings.
- Rows are never deleted. A withdrawn item stays readable, so old
  prescriptions keep their meaning.

**Who keeps the lists.**
- Medicines come from the Nigeria Essential Medicines List, 7th edition
  (2020). It is already recorded as a source in
  `ocr-worker/src/reading/drug-list.ts`. Gaps are filled from the WHO Model
  List. Generic names only at first.
- Lab tests: about 150, scoped by the WHO Essential Diagnostics List and
  coded with LOINC (free under its licence, with the attribution above).
  HID-LAB codes cover tests with no good LOINC code.
- Health ID's named clinical lead owns the national lists and approves every
  change to them (owner decision Q124 A, 19 Nov 2026).
- Each change is a reviewed PR to versioned seed files,
  `docs/codes/hid-medicines.json` and `docs/codes/hid-lab-tests.json`
  (HID-LAB codes stay in `hid-lab-codes.json`). It is published only after
  the lead's sign-off is recorded in the PR (owner decision Q124 A, 19 Nov 2026).
- A check like `scripts/tests/hid-lab-codes.test.mjs` proves that codes are
  unique and well formed, and that none is removed or reused.
- The governed loader (planned, lane D) loads the files. The release
  integrator runs it after the migration, never inside one. It refuses a
  file whose hash is not the signed one, switches the version in one
  transaction and keeps old versions.
- Facility admins keep their own facility's items. The lead does not review
  them.
- The lead reviews the lists every quarter. A monthly report of the most
  common names typed without a code feeds the next version. The report has
  counts only: no patient, no facility, and groups under 5 left out.

### Errors

| HTTP | Code | Message |
| --- | --- | --- |
| 400 | `CATALOG_SEARCH_TEXT_TOO_SHORT` | "Type at least 2 letters to search." |
| 400 | `CATALOG_SEARCH_TEXT_NOT_ALLOWED` | "Search by medicine or test name. Do not type a Health ID or NIN here." |
| 400 | `LAB_TEST_CODE_INCOMPLETE` | "Test code and its code system must be supplied together." |
| 400 | `VALIDATION_FAILED` | existing (unknown field, `null`, bad `limit`, `doseForm`, `kind` or `category`) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | existing (`common/idempotency.ts:8-11`) |
| 403 | existing permission refusal | — |
| 404 | `CATALOG_ITEM_NOT_FOUND` | "This list item was not found at this facility." |
| 409 | `FACILITY_ITEM_EXISTS` | "This facility already has an active item with this name." |
| 409 | `FACILITY_ITEM_LIMIT` | "This facility already has 500 items of this kind. Withdraw one first." |
| 409 | `IDEMPOTENCY_KEY_REUSED` | existing |
| 412 | `VERSION_CONFLICT` | "This item changed since it was loaded. Reload and try again." |
| 429 | `CATALOG_SEARCH_LIMITED` | "Too many searches. Please wait a minute and try again." (300 searches per 5 minutes per membership) |
| 503 | `CATALOG_UNAVAILABLE` | "The list cannot be searched right now. You can type the name instead." |

### Screen notes

- **Before 0144 ships** (the status route answers 404):
  - Keep the built-in lists (68 medicines, 26 tests).
  - Send HID-LAB codes for the 13 tests that have no LOINC code (Wave 0
    R-2).
  - Require a code on every lab request. A name-only request is refused
    today.
- **After it ships:**
  - Call `catalog/status` once per page load.
  - When `medicines.available` or `labTests.available` is true, switch that
    type-ahead to the search route. Wait about 250 ms after typing stops,
    and keep the last answer for the same `q`.
  - Show "Added by this facility" on `scope: facility`.
  - Show `commonAdultDose` as a hint. Never fill it into the dose fields.
- **Free text:** offer "Use '<typed text>' as written" under the results.
  When `labTestNameOnly` is true, send `testDisplay` alone. Otherwise keep
  the "a code is needed" rule.
- Expect `testCode` and `testCodeSystem` to be `null` on lab request
  answers and lab work items.
- On 503 or 429, fall back to the built-in list or typing. Never block the
  order.
- Show the LOINC attribution from `attribution` on the About or Help page.
- Several tests in one request is ORD-6 (Release C). Order sets and
  favourites are ORD-8 (Release C).
- Admin screen: a "This facility's medicines and tests" list with Add and
  Withdraw.

### Depends on

- 0125 (section 46): `strength` and `doseForm` on prescriptions.
- Wave 0 HID-LAB codes.
- Q124 A (owner decision, 19 Nov 2026): Health ID's named clinical lead
  approves list changes, including the first load.
- Licence checks before the first load:
  - LOINC attribution text.
  - WHO Model List terms. We copy only generic names, strengths and forms.
  - WHOCC terms for using ATC codes in a commercial product. This is an open
    point with no decision yet, to be decided before this section is built.
    Until it is decided, `atcCode` stays `null`.
- ORD-2 (0133) and order routes for the name-only send paths.
- SX-1 fixture for the new permission.

### Target

Release B (0144).

Size: **L**.
- Code: two searches, facility items, the name-only change across ehr-api,
  lab-api and order routes, and the loader.
- Data: curating strengths, forms, routes and ATC for several hundred
  medicines and LOINC for about 150 tests needs a pharmacist and a lab
  scientist working under the lead. The data is the longer part.

## ORD-9: Diagnosis search on ICD-11, recent diagnoses, and diagnoses by name only (planned, Release B, needs a migration: yes)

Akos items: P1-12, R-1, P2-5 (and P0-5's coding ask).

Status: planned, not live.

Build plan of 18 Nov 2026, migration 0145 (provisional), lane D. This
section follows owner decision Q124 A, 19 Nov 2026: ICD-11 is the search list, and
ICD-10 codes typed in are still accepted.

Today a diagnosis must have a code (`clinical.dto.ts:304-307`,
`0004:181`). Any code system text is accepted unchecked (Wave 0 R-1, P2-5).
The route Akos suggested, `GET /api/v1/ehr/terminology/icd10`, does not
exist and will not be built (owner decision Q124 A, 19 Nov 2026).

### Routes

ehr-api `ehr/terminology/`. `X-Facility-Id` is required, and there is no
purpose header (no patient data). `q` follows the ORD-7 rules: no Health ID
or NIN shapes, never logged.

| Method and path | Who may call | Permission |
| --- | --- | --- |
| `GET /api/v1/ehr/terminology/diagnoses?q=&limit=` | anyone who records diagnoses | `ehr.diagnosis.write` (existing) |
| `GET /api/v1/ehr/terminology/diagnoses/recent?limit=` | the same; only their own | `ehr.diagnosis.write` (existing) |
| `POST /api/v1/ehr/patients/:patientId/encounters/:encounterId/diagnoses` | unchanged (`diagnoses.controller.ts:27-33`) | `ehr.diagnosis.write`; `Idempotency-Key` as today |

**Search.** `q` is 2-100 characters. `limit` is 1-25, default 10. The list
is every coded entry of the ICD-11 MMS release 2026-01 (the release
`ocr-worker/src/reading/diagnosis-list.ts` already uses), with its titles
copied verbatim (CC BY-ND 3.0 IGO: not shortened, respelled or re-cased).
Extension codes (X...) and blocks without a code are left out.

Each word of `q` must start a word of the title or of one of our own other
names. Those come from `DIAGNOSIS_SYNONYMS` in the same file (HTN, DM,
"MP+", typhoid...), are kept apart from WHO's words, and contain no ICD-10
content. Exact title starts come first, then shorter titles.

Example for `q=falciparum`:

```json
{ "release": "ICD-11 MMS 2026-01", "more": false,
  "results": [
    { "codeSystem": "ICD-11", "code": "1F40", "display": "Malaria due to Plasmodium falciparum",
      "matchedName": "falciparum malaria" } ],
  "typedIcd10": null }
```

- `codeSystem` is always `ICD-11`.
- `code` is up to 100 characters.
- `display` is WHO's title, up to 500 characters. It fits the diagnosis
  `display`.
- `matchedName` is our own other name that matched, or `null`. Here
  `DIAGNOSIS_SYNONYMS` maps "falciparum malaria" to 1F40's title
  (`diagnosis-list.ts:214`).
- Some other names point to a block without a code: "MP+" and "HTN" map to
  "Malaria" and "Hypertensive diseases" (`diagnosis-list.ts:181`, `:212`).
  Blocks are left out of the search, so those names find nothing by
  themselves in the first version; the words of `q` still match coded titles
  as usual. Before release the clinical lead checks that no other name points
  to a narrower title than the words say (for example to "Malaria without
  parasitological confirmation"). (owner decision Q124 A, 19 Nov 2026)
- When `q` looks like an ICD-10 code (a letter, two digits or a digit and a
  letter, then optionally a dot and up to 4 more characters, such as
  `B50.9`), `typedIcd10` is `{ "codeSystem": "ICD-10", "code": "B50.9" }`
  (upper-cased). No ICD-10 title is shipped or looked up: we hold no ICD-10
  licence (owner decision Q124 A, 19 Nov 2026).

**Recent diagnoses.** These are the caller's own last picks at this
facility, newest first. `limit` is 1-50, default 20.

```json
{ "items": [ { "codeSystem": "ICD-11", "code": "1F40",
  "display": "Malaria due to Plasmodium falciparum", "lastUsedAt": "2026-12-03T10:42:00.000Z",
  "useCount": 14 } ] }
```

- The list is kept in its own table (`ehr.clinician_recent_diagnoses`:
  membership, code system, code, display, last used, count). It is written
  in the same transaction as each diagnosis this member saves, at most 200
  per membership, and the oldest drop off.
- It holds **no patient id**, so it stays usable after a grant ends and
  shows no patient.
- The read is audited as `ehr.terminology.recent-read` with the count only.
- Favourites are ORD-8 (Release C).

**Diagnoses by name only, and ICD-11 codes.** While
`DIAGNOSIS_NAME_ONLY_ENABLED` is `true`:

- `CreateDiagnosisDto` (`clinical.dto.ts:299-312`) takes `codeSystem` and
  `code` as optional, both or neither. `display` is still required (1-500).
  The EHR-C5 consultation body uses the same DTO
  (`consultation.dto.ts:44-47`), so it follows.
- ICD-10 typed codes are still accepted exactly as today (owner decision
  Q124 A, 19 Nov 2026). So is any other code system text.
- The create answer gains `codeStatus`:
  - `in_list`: an `ICD-11` code found in the loaded release.
  - `not_in_list`: an `ICD-11` code not found. The diagnosis is still
    saved. Post-coordinated codes with `&` or `/` are checked on their
    first code only.
  - `not_checked`: any other code system.
  - `no_code`: a diagnosis saved by name only.
- Every diagnosis answer (and EHR-C4's `problems` section,
  `chart-summary.service.ts:91`) may carry `"codeSystem": null, "code":
  null`.
- The patient record chat's sensitive-diagnosis check is split already. It
  needs no migration and does not depend on `DIAGNOSIS_NAME_ONLY_ENABLED`
  (`patient-evidence.policy.ts:135,151-268,276`; the ranges are listed in
  Wave 0 R-1 of `INTERFACE_CONTRACT.md`):
  - The ICD-10 pattern runs exactly as before for every code system
    containing "ICD", so nothing hidden before is shown.
  - A table of ICD-11 ranges also runs for every code system containing
    "ICD", whichever revision it names (`ICD-10`, `ICD-11`, `ICD-10/11`,
    `ICD`, a WHO URI), on each part of the code in ICD-11 form: HIV, viral
    hepatitis, sexually transmitted infections, neoplasms, mental and
    behavioural disorders, and pregnancy. The label is free text, so an
    ICD-11 code sent as `ICD-10` is still hidden; no ICD-10 diagnosis code
    has the ICD-11 form (a letter second), so no ICD-10 result changes.
    Every stem of a post-coordinated code or list is checked, not only the
    first, a code without its dot or with a note after it is still read, and
    extension codes (X...) are ignored. **Draft:** the clinical lead confirms its code
    ranges before release (owner decision Q124 A sign-off; Ola's decision 5
    on #258). The central nervous system group is marked uncertain, and the
    haematopoietic and moved-out-of-chapter-06 groups need the lead's choice;
    R-1 lists the codes it hides whose ICD-10 codes are shown today.
  - The name check stays for every code system, and it is what still hides
    a name-only diagnosis.
- While the setting is off, the routes behave exactly as today.

**Database (0145).**
- `ehr.diagnoses.code_system` and `code` (`0004:180-181`) become nullable,
  with a pair CHECK added NOT VALID, then validated.
- New tables: `ehr.terminology_icd11` (code, title, release, a
  full-text-search column with a GIN index, our other names in a separate
  column) and `ehr.clinician_recent_diagnoses` (row security by membership).
- The ICD-11 extract is checked in as `docs/codes/icd11-mms-2026-01.json`,
  with the WHO release file's hash. The governed loader loads it (ORD-7).
  A new WHO release is a reviewed PR with the clinical lead's sign-off
  (owner decision Q124 A, 19 Nov 2026).

### Errors

| HTTP | Code | Message |
| --- | --- | --- |
| 400 | `CATALOG_SEARCH_TEXT_TOO_SHORT` | "Type at least 2 letters to search." |
| 400 | `CATALOG_SEARCH_TEXT_NOT_ALLOWED` | "Search by diagnosis name or code. Do not type a Health ID or NIN here." |
| 400 | `DIAGNOSIS_CODE_INCOMPLETE` | "Diagnosis code and its code system must be supplied together." |
| 400 | `VALIDATION_FAILED` | existing (a diagnosis with no code while the setting is off, unknown field, `null`, bad `limit`) |
| 400 | `PURPOSE_OF_USE_REQUIRED`, `IDEMPOTENCY_KEY_REQUIRED` | existing, on the create route only |
| 403 | existing permission refusal; `CONSENT_REQUIRED` on create as today | — |
| 409 | `IDEMPOTENCY_KEY_REUSED` | existing |
| 429 | `CATALOG_SEARCH_LIMITED` | "Too many searches. Please wait a minute and try again." (shared with ORD-7's limit) |
| 503 | `TERMINOLOGY_UNAVAILABLE` | "Diagnosis search is not available right now. You can type the diagnosis instead." |

### Screen notes

- **Before 0145 ships** (`catalog/status` gives `diagnoses.available: false`
  or answers 404):
  - Keep the built-in list of 57 with code system `ICD-10` and dotted codes
    (Wave 0 R-1).
  - A diagnosis must still have a code. Ask for one, or say it cannot be
    saved without one.
- **After it ships:**
  - Search the route as the clinician types (about 250 ms after typing
    stops).
  - Show the recent list when the field is empty.
  - Show `display` exactly as given (WHO's licence does not allow changing
    the title). Show `matchedName` in grey, as "matched falciparum malaria".
  - When `typedIcd10` is present, offer "Use ICD-10 code B50.9". Then the
    clinician types the name for `display`.
  - When `diagnosisNameOnly` is true, offer "Use '<typed text>' as written"
    with no code.
  - On `codeStatus: not_in_list`, show "This ICD-11 code was not found in
    the list. It was saved as typed." Do not block.
- Expect `code` and `codeSystem` to be `null` on diagnosis and chart-summary
  answers.
- Show "ICD-11, World Health Organization, CC BY-ND 3.0 IGO" on the About
  or Help page.
- On 503, fall back to the built-in list.

### Depends on

- Q124 A (owner decision, 19 Nov 2026): ICD-11 search, ICD-10 typed
  codes kept, and Health ID's named clinical lead.
- ORD-7 (0144): the loader, the status route, the shared search limit.
- EHR-C4 and EHR-C5 (built in wave 1): their answers and bodies follow the
  nullable code.
- The patient-evidence change (lane D edits `patient-records/` only for the
  ICD-11 split, agreed with lane C as FR-1 was).

### Target

Release B (0145).

Size: **M**: one search table and loader input, the recent table, the
nullable code, and the sensitive-list split. The ICD-11 sensitive ranges
need the lead's review.

## ORD-10 phase 2: Same-class medicine warning by ATC (planned, Release B, needs a migration: no)

Akos items: N-9 (N-9c), P0-5.

Status: planned, not live.

This builds on ORD-10 phase 1, built in wave 1 (live contract,
"ORD-10 phase 1"). It is code shipped alongside Release B. It needs no
migration of its own: it uses 0144's `ehr.catalog_medicines.atc_code` and
`ehr.duplicate_class_rules`.

It adds a warning when a current prescription is a *different* medicine of
the same class. It is a warning, never a block. It does not check drug
interactions: interactions would come only from a licensed, maintained
database, later (owner decision Q131 A, 19 Nov 2026; see ORD-13).

### Routes

No new route. These change while `DUPLICATE_CLASS_CHECK_ENABLED` is `true`:

| Method and path | Who may call | Permission |
| --- | --- | --- |
| `POST /api/v1/ehr/patients/:patientId/duplicate-medicine-check` | prescribers, direct care | `ehr.prescription.write` (unchanged) |
| `POST /api/v1/ehr/patients/:patientId/encounters/:encounterId/prescriptions` | prescribers, direct care | `ehr.prescription.write` (unchanged; `Idempotency-Key` as today) |

The request body is unchanged: `medicationDisplay`, optional
`medicationCodeSystem`, `medicationCode` and `excludePrescriptionId`. The
compared set is unchanged: this facility's current prescriptions readable
under consent, at most 500.

**How the class is found**, for the new medicine and for each compared
prescription:
1. `HID-MED` or `HID-FACILITY` code: the item's `atcCode`.
2. Code system `ATC`: the code itself.
3. Otherwise: the generic name found by phase 1's name rule against the
   formulary's generic names, then its `atcCode`.

No ATC means no class warning for that prescription. The same-medicine
check still runs.

**What counts as the same class.**
- By default, the same ATC level 4 (the first 5 characters, such as
  `C09AA`) with a different level 5.
- `ehr.duplicate_class_rules` (seed file `docs/codes/duplicate-class-rules.json`,
  approved by Health ID's named clinical lead, owner decision Q124 A, 19 Nov 2026) can
  change that per class:
  - `compare_at_level_3`: for example `M01A`, so two NSAIDs warn even
    though their level-4 classes differ.
  - `never_warn`: classes normally given together, for example
    antiretrovirals in one HIV regimen. Each rule carries a reason and its
    reviewer.
- Each class has a plain name from the same file (for example "NSAID pain
  relievers"), not WHO's ATC wording.

**Answer.** It has the same shape as phase 1. Each match gains `kind`
(`same_medicine` or `same_class`), and `matchedBy` gains the value `class`.
A class match adds `class`:

```json
{ "checked": true,
  "message": "This patient already has a current prescription for another medicine of the same kind (NSAID pain relievers). Check it before you continue.",
  "matches": [ { "prescriptionId": "…", "encounterId": "…", "medicationDisplay": "Diclofenac 50 mg tablet",
    "status": "active", "startsOn": "2026-12-01", "endsOn": null, "createdAt": "…",
    "matchedBy": "class", "kind": "same_class",
    "class": { "atc": "M01A", "name": "NSAID pain relievers" } } ] }
```

- Same-medicine matches come first, then class matches, newest first
  within each.
- A prescription is listed once only. When it is both, it is a same-medicine
  match.
- `message` keeps phase 1's sentence for same-medicine matches. It adds
  "This patient already has a current prescription for another medicine of
  the same kind (<name>)." or "This patient already has N current
  prescriptions for other medicines of the same kind (<name>).", and ends
  "Check it before you continue." or "Check them before you continue."
- While the setting is off, the answers are exactly phase 1's.
- Audit: phase 1's `ehr.prescription.duplicate-check` row adds
  `classMatchCount`. It still never names a medicine.

### Errors

The same as phase 1. A missing formulary or rule table never fails the
check. Class matching is then skipped, and `classChecked: false` is added
to the answer.

| HTTP | Code | Message |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | existing |
| 400 | `PURPOSE_OF_USE_REQUIRED` | existing |
| 403 | `CONSENT_REQUIRED` | existing (phase 1) |

### Screen notes

- **Before it ships:** show phase 1's same-medicine warning only. It is
  already built (wave 1).
- **After it ships** (`catalog/status` gives `classDuplicateCheck: true`):
  - Read `kind` and show class matches under their own line: "Same kind of
    medicine: <class name>".
  - Save stays enabled.
  - Treat an unknown `kind` or `matchedBy` as a plain match, so later values
    never break the form.
  - When `classChecked` is false, show nothing extra.
- Free-text medicines get class warnings only when their name matches a
  formulary generic name. Picking from the list (ORD-7) gives the best
  checks.

### Depends on

- ORD-7 (0144): ATC on formulary items, the rules table and the loader.
- ORD-10 phase 1 (built in wave 1).
- Q131 A (owner decision, 19 Nov 2026): same-medicine and same-class
  warnings only, no interaction checks now.
- Q124 A (owner decision, 19 Nov 2026): Health ID's named clinical lead approves
  the class rules.
- The ATC licence question in ORD-7. Without ATC codes this package has
  nothing to compare.

### Target

Release B, code alongside 0144.

Size: **S** for code. The clinical lead's first class-rule file is the real
work.

## ORD-4: Pharmacy accepts a prescription before dispensing (planned, Release B, needs a migration: yes)

Akos items:
- N-1 (the "Accepted" status)
- N-8 (the pharmacy part of "accepted by"; the laboratory keeps "Sample taken" as its first visible step, see Screen notes)

Status: planned, not live. Built in #<PR, to come> (migration 0147, provisional); live when Release B is signed. The contract as built is the section "ORD-4. The pharmacist accepts a prescription before dispensing" in [INTERFACE_CONTRACT.md](INTERFACE_CONTRACT.md), and this section is corrected to match the build (the ORD-4 build spec of 20 Nov 2026). Owner decision Q125 B, 19 Nov 2026: the pharmacy "Accepted" step is wanted.

Today (Release A, 0133) this hospital's pharmacy has a prescription as soon as the prescriber activates it. The automatic send makes the work item and records the prescriber as the one who accepted it into Pharmacy, with the fixed reason "Sent automatically when the prescription was activated" (0133 D7; never recorded as a pharmacist's acceptance, ORD-2). So the work item's `status: "accepted"` and `acceptedAt` (`pharmacy.service.ts:730` and `:736` on Release A) only mean "the pharmacy has it". No pharmacist has taken it on. ORD-4 adds that step: a pharmacist accepts the prescription, and the prescriber sees "Accepted" between "Sent to pharmacy" and "Dispensed".

### The steps

A work item gains `pharmacyStep`:

| `pharmacyStep` | Meaning | The prescriber's `ownProgress.status` (ORD-3) |
|---|---|---|
| `received` | sent to this hospital's pharmacy by itself (0133) and no pharmacist has accepted it yet | `received` |
| `accepted` | a pharmacist at this pharmacy accepted it; not dispensed yet | `accepted` (new value) |
| `dispensed` | dispensed | `dispensed` |
| `dispensing_reversed` | dispensed, then the dispensing was reversed | `dispensing_reversed` |

The third column is for this hospital's own items while they are not withdrawn. An item withdrawn before it was dispensed reads `withdrawn` or `sent_elsewhere`, whether `received` or `accepted` (which status wins: "The prescriber's progress" below), and to an ehr-api that does not send the second progress header (below) `accepted` is answered `received`. A route-backed item is always `accepted`, but it is another facility's prescription: its prescriber's `ownProgress` reads `not_received`, and its progress is on `orderRoute`.

`withdrawn: true` (0133 D8) stays a separate flag, as today. It can be on a `received` or an `accepted` item. An item a pharmacist brought in by hand is never flagged on a hold, a cancellation, an entry in error or an edit, because 0133 D8 marks automatic sends only. It is flagged only when it is sent to an outside pharmacy (`withdrawnReason: "sent_elsewhere"`, 0133 D14). After a dispensing, a change shows on every item, a hand-off item included, as Q132 A's notice (`changedAfterDispensing`).

Which items start at `accepted`:
- **A prescription from another facility.** The route's Accept (`POST /api/v1/pharmacy/order-routes/:routeId/accept`, `pharmacy.order-route.receive`) is already a member of this pharmacy taking the order on. It makes the work item with that member as `accepted_by` (`0086:8523`). The item is `accepted` from that moment (`acceptedWith: "order_route"`, read from the work item's `accepted_by_membership_id` and `accepted_at`), and needs no second step.
- **An own item a pharmacist brought in by hand** (`POST /api/v1/pharmacy/work-items/accept-ehr-prescription`, permission `pharmacy.work-item.accept`, which only the pharmacist role holds, `0023:24`). It is `accepted` from that moment, by that member (`acceptedWith: "hand_off"`, read from the work item).
- **An own item sent automatically** (a row in `pharmacy.own_prescription_sends` in state `sent` names its `work_item_id`, 0133 D6). It is `received` until a pharmacist accepts it or dispenses it (below).

The migration writes no rows for existing items. Items sent automatically before ORD-4 ships, and not dispensed, show `received` until they are accepted or dispensed.

### Routes

| Method | Path | Who | Permission |
|---|---|---|---|
| POST | `/api/v1/pharmacy/work-items/:workItemId/accept` (new) | A pharmacist at the `X-Facility-Id` facility who may write this work item: for this hospital's own work, on 0133's own-work basis (holds `pharmacy.work-item.read` and `pharmacy.order-route.receive` there) or the member's own consent grant to write records; for a prescription from another facility, its order route. Direct care only; an emergency (break-glass) session is refused, as for a dispensing. Origin and CSRF checks as for other browser writes. | `pharmacy.work-item.accept` (pharmacist role only; no role-table change) |
| GET | `/api/v1/pharmacy/work-items`, `/api/v1/pharmacy/work-items/:workItemId` (changed) | pharmacy staff, as today | `pharmacy.work-item.read` |
| POST | `/api/v1/pharmacy/work-items/:workItemId/dispensings` (changed) | pharmacist, as today | `pharmacy.dispensing.create` |
| POST | `/api/v1/pharmacy/work-items/progress` (changed; internal, ehr-api only, ORD-3) | ehr-api with the clinician's own credentials | `ehr.prescription.read` |
| GET | prescription list and read in ehr-api (changed, ORD-3) | as today | `ehr.prescription.read` |

**Accept.** Headers: `X-Facility-Id`, `X-Purpose-Of-Use: direct-care`, and a required `Idempotency-Key`. UUIDs only in the path; never a Health ID. Body, exactly this field:

```json
{ "expectedWorkItemVersion": 1 }
```

No typed reason, as for other first steps (FR-1, Q105). The work item's version does not change (an acceptance is its own row), so dispensing keeps binding to the same version.

Answer `201` the first time, `200` after that:

```json
{
  "workItemId": "uuid",
  "pharmacyStep": "accepted",
  "pharmacistAcceptance": {
    "acceptedAt": "2026-11-19T10:52:00.000Z",
    "acceptedByMembershipId": "uuid",
    "acceptedWith": "accept"
  },
  "alreadyAccepted": false
}
```

- `acceptedWith`: `accept` (this route), `dispensing` (recorded by a dispensing, below), `order_route` (the route's Accept) or `hand_off` (brought in by a pharmacist by hand).
- The screen shows the name through `GET /api/v1/identity/facility-staff-names?membershipIds=<id>` (SX-9, live contract).

Rules:
- **Once per work item, and safe to repeat.** The database keeps one acceptance per work item. Any later accept, by anyone and with any key, answers `200` with the stored acceptance and `alreadyAccepted: true`, and writes nothing except its audit row. A route-backed or hand-off item answers that `200` too, from its work item. The same `Idempotency-Key` with a different body answers 409 `IDEMPOTENCY_CONFLICT`; keys are kept per facility and pharmacist in the acceptances table, which also keeps the key of a dispensing that accepted an item. pharmacy-api looks the key up under row-level security, so an earlier acceptance under that key that the pharmacist can no longer read (that patient's consent grant ended, or a deny directive) is met only by the insert, through the table's unique key (23505): pharmacy-api runs its transaction once more, in case a request with the same key committed meanwhile, and if the insert meets the key again it answers the same 409, not a 500. Two pharmacists at once: one acceptance is recorded; the other's insert is refused (23505) or cancelled (40001), and pharmacy-api runs its transaction again, which gets the `200` answer (SERIALIZABLE, as a dispensing).
- **Only while it can still be dispensed.** If the item is not yet accepted, the accept refuses an item marked `withdrawn` (read from the migration's steps reader, below), and the database's insert trigger makes the same check that 0101 makes for a dispensing (`pharmacy.validate_dispensing()`: the prescription is active and at the version the pharmacy holds, read FOR SHARE) and checks 0133's claim and send again. Either refusal answers 409 `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE`, with the problem member `withdrawnReason` when the item was withdrawn: `changed` with "This prescription can no longer be dispensed here"; `sent_elsewhere` with "This prescription was sent to another pharmacy, so it can no longer be dispensed here". With no reason (no longer active, or not at the version held, for example completed) the answer is "This prescription can no longer be dispensed here" with no `withdrawnReason`. An item already accepted answers its acceptance (`200`), even once withdrawn.
- **Already dispensed.** If an acceptance is stored, the accept answers it (`200`). An item dispensed with no acceptance on record (before ORD-4 shipped, or by a Release A pharmacy-api after it) has none, and the accept answers 409 `PHARMACY_WORK_ITEM_ALREADY_DISPENSED` with the dispensing's message (existing code: a second dispensing's refusal, `pharmacy.service.ts:459` on Release A).
- **It cannot be undone.** There is no "un-accept". A dispensing reversal does not remove the acceptance.
- **Dispensing a `received` item accepts it first**, in the dispensing's own transaction, by the dispensing pharmacist (`acceptedWith: "dispensing"`, a moment before the dispensing's time; the acceptance keeps the dispensing's `Idempotency-Key` and request digest). A dispensing is never refused because there is no acceptance, nor because the acceptance could not be written: it is written in a savepoint and skipped on a database without the migration or on any failure (a serialization failure or deadlock runs the whole dispensing again). Today's pharmacy screens, and a pharmacy site rolled back alone, keep working.
- **Refills (ORD-12):** one acceptance per work item, before the first fill. Refills need no new acceptance.
- **Audit.** Every accept call that answers `200` or `201` writes one row naming the patient, `pharmacy.work-item.pharmacist-accept` (resource `pharmacy-work-item`), with `outcome` (`accepted` or `already_accepted`), `acceptedWith`, and the basis always named, as the work list's rows name it (`basis: 'consent'`, `'own-work'`, or `'order-route'` with `orderRouteId`). It is written in the same transaction: no answer without its audit row. A refusal writes no row of its own (its transaction is rolled back), as a refused dispensing writes none. A dispensing that recorded the acceptance adds `acceptedWithDispensing: true` to its `pharmacy.dispensing.create` row. The work item's history gains one `pharmacist_accepted` event (`event_version` 2, reason "Accepted by the pharmacist"). No outbox event and no notice: ORD-11 notifies only for dispensings and reversals.

**Work item answers** (list, read, and the accept answer) gain:

```json
{ "pharmacyStep": "received", "pharmacistAcceptance": null }
```

`status: "accepted"` and `acceptedAt` stay as they are, so no exact-body test of today's fields changes. They mean "the pharmacy has it" and "when it arrived". The screen uses `pharmacyStep` for the steps. The two fields come right after `dispensing`. A route-backed item always carries them (`acceptedWith: "order_route"`, from its work item), also on a database without the migration. An own item carries them only when the migration's steps reader answered it; they are absent from an older pharmacy-api, and for an own item on a database without the reader or when the reader fails: never a guessed step. The first answer of `accept-ehr-prescription` carries neither; its replay carries both.

**The prescriber's progress (ORD-3, extended).**
- The pharmacy progress item may now carry `status: "accepted"`, and gains `acceptedAt` (ISO time, or `null`). The exact new value is `accepted`. It is added to `PharmacyProgressStatus` (`services/pharmacy-api/src/pharmacy/work-item-progress.service.ts:26` on Release A) and to ehr-api's `PharmacyOwnProgressStatus` and `PHARMACY_STATUSES` (`services/ehr-api/src/integrations/work-item-progress.service.ts:26` and `:56` on Release A).
- ORD-3's table gains one row: `accepted` means a pharmacist at this hospital's pharmacy accepted it at `acceptedAt`, and it is not dispensed yet.
- Which status wins: `dispensing_reversed`, then `dispensed`, then `sent_elsewhere`, then `withdrawn`, then `accepted`, then `received`. So an accepted prescription that is then put on hold reads `withdrawn`, with its `acceptedAt` kept. A prescription a pharmacist brought in by hand reads `accepted`, with `acceptedAt` equal to `receivedAt` (it is never `withdrawn` on a hold, above).
- ehr-api's `ownProgress` gains `acceptedAt` next to `receivedAt`, `dispensedAt` and `reversedAt`, always present (`null` when there is none). A missing `acceptedAt` parses as `null`.
- **Either image may go first: a second header.** ehr-api sends `X-HID-Own-Progress-Accepted: ord4` beside `X-HID-Own-Progress: 0133` on the pharmacy call only (always; not a setting). pharmacy-api answers `accepted` and `acceptedAt` only when both headers are there, each value matched exactly. Without the second header, `accepted` is answered `received` (times kept) and `acceptedAt` is left out. So today's ehr-api, which treats a whole batch as `unknown` when one status is a value it does not know (`parseItems`, same file, `:194` on Release A), never meets `accepted`. Today's pharmacy-api matches `X-HID-Own-Progress` exactly (it stays `0133`) and ignores the second header, so it never sends `accepted` or `acceptedAt`. Either image may be deployed, or rolled back, first. This replaces the earlier "deploy ehr-api first".
- A prescription sent to another facility is unchanged. Its `ownProgress` stays `not_received`, and its progress is on `orderRoute`, whose own state already shows the other pharmacy's Accept (sections 21-24).
- MY-1's "Ordered by me" list carries the same `ownProgress`, so it shows `accepted` too.

**Sending to an outside pharmacy (Q119 and Q121 A, built in 0133 D14, Release A).** The prescriber may send a prescription to an outside pharmacy until this hospital's pharmacy dispenses it (ORD-2). **An acceptance does not block that. Only a dispensing does.** The send withdraws this hospital's pharmacy item whether or not it was accepted (`withdrawnReason: "sent_elsewhere"`). The acceptance stays on record and the item keeps `pharmacyStep: "accepted"`. ORD-4 adds no check of its own to that send. Accepting an item sent elsewhere that nobody had accepted answers 409 `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` "This prescription was sent to another pharmacy, so it can no longer be dispensed here", with `withdrawnReason: "sent_elsewhere"`. Its `ownProgress` reads `sent_elsewhere`, with `acceptedAt` kept when it was accepted.

**Stop and hold.** An acceptance does not stop the prescribing team from putting the prescription on hold, cancelling it, entering it in error, editing it or resuming it. 0133 D8 marks the item `withdrawn` exactly as today. The acceptance is kept, `ownProgress` reads `withdrawn`, and Dispense answers 409 `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` (0101, unchanged). D8 marks automatic sends only, so an item a pharmacist brought in by hand is never marked: it stays `accepted` (`ownProgress` too), and Dispense answers the same 409 (0101). After a dispensing, the item stays `dispensed` and shows Q132 A's notice.

**"We can't complete this order" (D18, section 24).** This is for prescriptions from another facility, and it is unchanged. Such an item is `accepted` when its route is accepted, so the command is offered exactly as today (`POST /api/v1/pharmacy/order-routes/:routeId/cannot-complete`, `pharmacy.order-route.receive`). ORD-4 adds no "can't complete" for this hospital's own prescriptions. A pharmacist who accepted one and then cannot dispense it tells the prescriber, who holds or stops it (the item is then `withdrawn`).

**Database** (migration 0147, number provisional, given in merge order at the Release B cut-off; needs 0001-0137):
- A new table, `pharmacy.work_item_acceptances`: one row per work item (`work_item_id` unique), with patient, facility, `accepted_by`, `accepted_by_membership_id`, `accepted_at`, `accepted_with` (`accept` or `dispensing`), the idempotency key, the request digest and the correlation id, and unique `(facility_id, accepted_by, idempotency_key)`. No foreign keys (0133 D6's pattern; the insert trigger checks what they would). Rows are never updated or deleted (0023's `pharmacy.reject_immutable_evidence()`; no runtime holds UPDATE or DELETE). Row-level security, enabled and forced, follows the dispensings table: four policies, the two consent and order-route ones (`pharmacy.context_allows`) and 0133's two own-work ones for a row anchored on its work item (0133's own-work policies are now 46). SELECT and INSERT for `hid_pharmacy_runtime` and `hid_schema_test_runtime`, here and in `runtime-grants.sql`.
- An insert trigger, `pharmacy.validate_work_item_acceptance()` (SECURITY DEFINER), owned by the owner of `pharmacy.validate_dispensing()`: 0133 D5's two `ehr.prescriptions` policies name only that role, so with another owner a pharmacist with no consent grant would find no prescription under forced row-level security. No role may execute it. It refuses with 23514, in this order:
  - "Pharmacist acceptance does not match its work item and actor context": the session is incomplete, or its purpose is not `direct-care` (an emergency session and any other purpose are refused, as for a dispensing), or the row is not the session's (facility, account, membership), or the work item is not found with the row's patient and facility;
  - `PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY`, DETAIL `order_route` or `hand_off`: the item is route-backed, or no `sent` row of 0133's sends table names it (pharmacy-api answers those items from the work item and never inserts for them);
  - `PRESCRIPTION_SOURCE_NOT_DISPENSABLE`, after the prescription is read FOR SHARE as 0101 does, the most specific first: DETAIL `not_claimed` (the claim is dispensed or missing), `sent_elsewhere` (the claim was released, 0133 D14), `changed` (the send was withdrawn, 0133 D8), or no DETAIL when 0101's source check fails.
- `pharmacy.work_item_events` accepts `event_type` `pharmacist_accepted` with `event_version` 2, as well as `prescription_accepted` with version 1 (today only the latter, `0023:105`): both 0023 CHECKs are widened under their names (added NOT VALID, then validated), and `unique (work_item_id, event_version)` keeps one event of each per item. `pharmacy.validate_work_item_event()` is replaced: 0077's text, unchanged, for a version-1 `prescription_accepted` event; for a version-2 `pharmacist_accepted` event, the session's account and membership (0077's rule; not its facility or purpose, which the acceptance's trigger checked), equal to the event's actor and to the item's acceptance's, the event's patient and facility the acceptance's, and the reason "Accepted by the pharmacist", else 23514 "Pharmacy work-item event does not match its pharmacist acceptance"; any other pair refused with 0077's message. Its attributes, owner and ACL stay 0077's.
- A reader, `pharmacy.own_work_item_steps(uuid[])` (SECURITY DEFINER, STABLE, at most 200 ids, EXECUTE for the same two runtimes): 0133's `pharmacy.own_work_item_states` columns, exactly (`work_item_id`, `basis`, `withdrawn`, `withdrawn_reason`), plus `sent_automatically` and the acceptance's `accepted_at`, `accepted_by_membership_id` and `accepted_with` (or null), for own items only. It is needed because no runtime may read 0133's sends table, so pharmacy-api cannot tell `received` from a hand-off by itself; and one call answers what `own_work_item_states` answers too, so the list, a read and the progress still make one reader statement.
- No change to `pharmacy.work_items`. Its `status` stays `accepted` (`0023:62`) and its `row_version` stays 1 (`0023:82`), so dispensings keep binding to version 1 (`0023:119`). Items from another facility and items brought in by hand need no row: their acceptance is read from the work item itself.
- The progress read (`WORK_ITEM_PROGRESS_QUERY`) and the work list's queries are unchanged. Where pharmacy-api asked `pharmacy.own_work_item_states`, it asks the steps reader, and on a database without the migration (42883) it asks `own_work_item_states` again in the same savepoint.
- Locks: ACCESS SHARE on the seven tables the migration opens without changing them (the work items, dispensings, 0133's sends and claims, `ehr.prescriptions`, `identity.staff_facility_memberships` and `auth.accounts`) and on the indexes of all but `ehr.prescriptions`, then, last, ACCESS EXCLUSIVE on `pharmacy.work_item_events` until commit (the CHECKs' validation included, since the runner applies each file in one transaction); NOWAIT, tried again every 100 ms for at most 50 attempts (5 to 5.5 seconds), and nothing after that waits for a lock. 43 to 46 ms in all on a copy with 20,000 work items and events, of which the hold was 25 to 29 ms. No backfill.
- Undo by hand only, in the order the migration's header gives, and before any step of 0133's undo (its own-work policies call 0133's D1 functions, and its reader and trigger read 0133's sends table). The widened CHECKs stay, so the migration cannot be applied again: its ledger row stays, and a later migration brings the step back.
- Release A images work unchanged on this schema (they never call or write the new objects; their version-1 events meet 0077's text), so each image can be deployed, or rolled back, on its own after the migration.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | One or more request fields are invalid. (an unknown field, a version that is not a whole number of 1 or more) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | existing, "Idempotency-Key must contain 16 to 128 URL-safe characters" |
| 400 | `PURPOSE_OF_USE_REQUIRED` | existing, "X-Purpose-Of-Use must be direct-care or emergency" |
| 403 | `PERMISSION_DENIED` | existing, "Required Pharmacy permission is missing" (no `pharmacy.work-item.accept`) |
| 403 | `PHARMACY_ACCESS_DENIED` | existing, "Pharmacy access is not authorized" (no basis to write this item), or "Break-glass authorization cannot mutate Pharmacy records" (an emergency session) |
| 404 | `PHARMACY_WORK_ITEM_NOT_FOUND` | existing, "Pharmacy work item was not found" |
| 409 | `ORDER_ROUTE_CLOSED` | existing, "This prescription from another facility is closed: stop work on it" (a route-backed item whose route is closed, as for a dispensing) |
| 409 | `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` | existing, "This prescription can no longer be dispensed here" (withdrawn, with `withdrawnReason: "changed"`; or no longer active at the version held, with no `withdrawnReason`) |
| 409 | `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` | existing, "This prescription was sent to another pharmacy, so it can no longer be dispensed here" (sent elsewhere, with `withdrawnReason: "sent_elsewhere"`) |
| 409 | `PHARMACY_WORK_ITEM_ALREADY_DISPENSED` | existing, "A full dispensing is already recorded for this work item; partial dispensing is not supported" (dispensed with no acceptance on record) |
| 409 | `IDEMPOTENCY_CONFLICT` | existing, "Prescription acceptance conflicts with existing Pharmacy work" (the hand-off's message; also when the earlier acceptance under that key is one the pharmacist can no longer read) |
| 412 | `PHARMACY_WORK_ITEM_VERSION_CONFLICT` | existing, "Dispensing must bind to the exact accepted work-item version" (the dispensing's message) |
| 423 | `CROSS_FACILITY_ORDERS_UNAVAILABLE` | existing, "Work on orders from other facilities is paused by Health ID" (a route-backed item while work on routes is paused, as for a dispensing) |
| 503 | `ORDER_ROUTE_UNAVAILABLE` | existing, sent as "The service could not complete the request." (the order route check answered something unexpected; every 5xx detail but the next row's is replaced by that text) |
| 503 | `PHARMACY_ACCEPTANCE_UNAVAILABLE` | Accepting is not available right now. Please try again. (on a database without the migration; the only new code, and its text is sent as written) |

These are the route's own answers. It also gives those every Pharmacy browser write gives (the guard's 401 and 403 `FACILITY_ACCESS_DENIED`, Identity's refusals passed on, 502 `INVALID_IDENTITY_RESPONSE`, 503 `IDENTITY_SERVICE_UNAVAILABLE`, and 500 `INTERNAL_ERROR` on any other failure, a failure of the steps reader included); the built contract lists them.

### Screen notes

- **Pharmacy list and item:**
  - On a `received` item that is not withdrawn, show "Accept" as the main button. After it, show "Accepted by <name> 10:52" (the name from SX-9's staff names).
  - Dispense stays enabled on a `received` item, because a dispensing accepts it too. Lead with Accept, then Dispense.
  - On `alreadyAccepted: true`, show "Already accepted by <name> 10:52" and treat it as done.
  - On 409 `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE`, show its message and reload. A withdrawn item stays "Changed or stopped by the prescribing team" (`withdrawnReason: "changed"`) or "Sent to another pharmacy by the prescribing team" (`sent_elsewhere`), with Accept and Dispense disabled (ORD-2).
  - With no `pharmacyStep` (an older pharmacy-api, or a database without the migration), show no step, as before this ships.
  - A dispensed item with `changedAfterDispensing` shows Q132 A's notice next to the step.
- **The prescriber's order row:** "Sent to pharmacy 10:40", "Accepted 10:52", "Dispensed 11:05". Use ORD-3's withdrawn text for `withdrawn`. The prescriber's row shows no pharmacist's name: `ownProgress` carries none.
- **Before this ships:** show "Sent to pharmacy 10:40", then "Dispensed 11:05". Never show "Accepted" or "Accepted by pharmacist" for this hospital's own prescriptions.
- **A prescription sent to another facility:** show the route's own states (sections 21-24), as today.
- **A lab request:** "Sample taken 09:30" (`sample_collected`) stays the laboratory's first visible step. There is no laboratory "Accepted" step in this package.

### Depends on

- ORD-2 (0133) and ORD-3 (Release A).
- 0101 (the dispensing source check) and section 13.
- Sections 21-24 for prescriptions from another facility; D18 is unchanged.
- Q125 B (owner decision, 19 Nov 2026). Q119 and Q121 A (decided) for the outside send.
- ORD-12 (one acceptance per work item, refills included), MY-1 (shows `accepted`), ORD-11 (no notice for an acceptance), Q132 A (a change after dispensing; the step stays `dispensed`).

### Target

Release B (lane D). Size **M**:
- one table with its row-level security and insert trigger, two widened CHECKs, the replaced event validator, and one reader;
- one route, and the dispensing change;
- the list, read and progress fields in pharmacy-api and ehr-api (either image first: the second progress header);
- audit and tests, including a step in `services/ehr-api/scripts/verify-own-facility-work-runtime.mjs`: a pharmacist without a consent grant accepts on the own-work basis, the doctor's `ownProgress` reads `accepted` and then `dispensed`, and a hold after an acceptance reads `withdrawn`.

## Q132 A: A change after dispensing reaches the pharmacy (planned, Release B, needs a migration: yes)

Akos items:
- none; owner question Q132 (asked in the review of ORD-2, #280)

Status: planned, not live. Built in #<PR, to come> (migration 0148, provisional); live when Release B is signed. The contract as built is the section "Q132 A. A change after dispensing reaches the pharmacy" in [INTERFACE_CONTRACT.md](INTERFACE_CONTRACT.md), and this section is corrected to match the build (the Q132 A build spec of 20 Nov 2026). Owner decision Q132 A, 19 Nov 2026: "it reaches the pharmacy. If a prescription is held, cancelled, entered in error or edited after the pharmacy dispensed it, the dispensed item shows a clear notice (for example 'Changed after dispensing: cancelled by the prescriber'), so the pharmacist can contact the patient. Built in Release B; it does not change 0133 or block Release A." The shape below is the coordinator's decision 1 on #258, 20 Nov 2026; **(coordinator decision 1, 20 Nov 2026)** marks the lines that rest on it.

Today (Release A, 0133, and ORD-4, 0147) a change made after the pharmacy dispensed an item reaches no pharmacy screen. The item stays dispensed (`pharmacyStep: "dispensed"`, ORD-4), and `withdrawn` is never set on a dispensed item (ORD-2). The records that exist are not enough for a notice:

| Record today | What it lacks |
|---|---|
| The automatic send's `withdrawn_at` (0133 D8) | It keeps the first change only, with no kind, and exists only for items sent automatically. An item a pharmacist brought in by hand, or one from another facility, has no send. |
| The route event `order_changed_after_completion` (0086) | Items from another facility only. Its reason is only `order_changed` or `entered_in_error`, so a hold, a cancellation, an edit and a resume look the same. |
| ehr-api's audit row `ehr.prescription.update` | No status and no field list. |
| The chart's version history (`ehr.record_versions`) | It has everything, but a pharmacist working on the own-work basis cannot read it (consent only), and 0133 gives the pharmacy no reader of chart tables. |

So a pharmacist who handed over a medicine that was then cancelled is not told. Q132 A tells them.

### What the pharmacy sees

A dispensed work item gains `changedAfterDispensing` when its prescription is changed after the dispensing. Each change is one of these, checked in this order; the first that holds wins, so a stop always wins over an edit sent in the same change:

| `change` | The change | Words on this hospital's own item |
|---|---|---|
| `entered_in_error` | entered in error | Changed after dispensing: entered in error by the prescribing team |
| `cancelled` | cancelled | Changed after dispensing: cancelled by the prescribing team |
| `on_hold` | put on hold (also when an edit came in the same change) | Changed after dispensing: put on hold by the prescribing team |
| `edited` | resumed from hold, and what it now says is not what was dispensed: an edit made during the hold, in the same change, or before the hold | Changed after dispensing: edited by the prescribing team |
| `resumed` | resumed from hold, exactly as dispensed | Changed after dispensing: resumed by the prescribing team |
| `edited` | still active, and what it says changed (through ehr-api: its frequency, instructions or end date) | Changed after dispensing: edited by the prescribing team |

- The owner named four changes; `resumed` is added by the coordinator's decision **(coordinator decision 1, 20 Nov 2026)**.
- Not shown and not counted: completing a prescription; a change that changes nothing (ehr-api raises the version when a value is sent again unchanged); an edit while the prescription stays on hold (it shows when the prescription is resumed, as `edited`); and a status this build does not know. Not recorded at all: any change after the prescription was cancelled, entered in error or completed (ehr-api accepts such edits), so a later edit never hides a stop.
- "What was dispensed" is the prescription as it was when the item was dispensed. An own item is dispensed only at the version the pharmacy holds (0101), and any change to another facility's prescription before its dispensing cancels the route (0086), so the first change recorded after the dispensing starts from it. For an item already changed before migration 0148 ran, the comparison starts from what it said just before its first change after 0148 (no backfill, below). An edit of an active prescription is compared with the version just before it, so an edit back to the dispensed text is still `edited`, and counted.
- Which items: this hospital's own items sent automatically, own items a pharmacist brought in by hand, and items from another facility's order route. This differs from `withdrawn` (ORD-2), which marks automatic sends only.
- "After dispensing": the item's first dispensing was recorded before the change. A reversed dispensing still counts; the item shows `dispensing.reversed: true` beside the notice. The database decides it by the order in which the two commit, not by comparing times: a dispensing holds the prescription (own items, 0101) or the route (items from another facility) until it commits, and a change waits for it.
- With ORD-12 (refills), "after dispensing" means after the first fill.
- No backfill: only changes made after migration 0148 runs are shown, for items dispensed at any time **(coordinator decision 1, 20 Nov 2026)**.
- No acknowledgement in Release B: the notice stays on the item, and nobody can mark it seen **(coordinator decision 1, 20 Nov 2026)**.
- Never on the same item as `withdrawn`, which exists only before a dispensing.
- `pharmacyStep` (ORD-4) stays `dispensed` or `dispensing_reversed`. `status`, `acceptedAt`, `version` and `dispensing` keep their meaning.

### Routes

No new route. Changed:

| Method | Path | Who | Permission |
|---|---|---|---|
| GET | `/api/v1/pharmacy/work-items`, `/api/v1/pharmacy/work-items/:workItemId` | pharmacy staff, as today | `pharmacy.work-item.read` |
| POST | `/api/v1/pharmacy/work-items/accept-ehr-prescription` (its replay only; internal, ehr-api only) | a pharmacist, through ehr-api's `POST /api/v1/ehr/patients/:patientId/encounters/:encounterId/prescriptions/:prescriptionId/pharmacy-work-item`, which passes the answer through unchanged, as today | `pharmacy.work-item.accept` |

Not changed: the dispensing and its reversal, ORD-4's Accept, the order-route routes, the progress call (ORD-3) and its two headers, and ehr-api's code and its own answers (it passes the hand-off's replay through unchanged, so the notice reaches the pharmacist through any ehr-api image).

**Work item answers** (the list, a read, and a replay of `accept-ehr-prescription`) gain, on a dispensed item whose prescription changed afterwards **(coordinator decision 1, 20 Nov 2026)**:

```json
{ "changedAfterDispensing": { "change": "cancelled", "changedAt": "2026-11-20T09:15:00.000Z", "changeCount": 2 } }
```

- `change`: the latest shown change, one of the five codes above.
- `changedAt`: when the latest shown change was made (ISO time, as the database recorded it, after any dispensing it waited for).
- `changeCount`: how many shown changes were made after the dispensing (1 or more).
- "The latest change first" means that `change` and `changedAt` are the latest change's. The field is one object, not a list.
- It is the item's last field, after `withdrawn` and `withdrawnReason`.
- Absent when no change is shown, when the item has no dispensing, from an older pharmacy-api, on a database without migration 0148, when the reader fails (pharmacy-api logs a warning and answers the list and the read without it), and on one item whose recorded time or count does not read cleanly (a warning naming that work item only). Never a guessed notice.
- `change` may be missing from a notice that is present: the database may answer a code this pharmacy-api does not know, or pharmacy-api one the client does not know (a newer backend). Clients must accept that.
- It adds no prescription id, version, encounter or name. An item from another facility still carries none of that facility's ids.
- No audit row is added: no new person is shown (0125's rule). The list's and the read's audit rows are unchanged and already name the item and the patient. The change itself is audited where it is made (ehr-api's `ehr.prescription.update`, and for an item from another facility the route's `ehr.order-route.order-changed`).

**Who changed it.** The answer names nobody. The screen says "by the prescribing team" on this hospital's own items: anyone at the prescribing facility who may change the prescription can do so, not only its writer (ORD-2). The owner's "cancelled by the prescriber" is an example of the notice, not its words. On an item from another facility it says "by <ordering facility>", from the item's `orderRoute.orderingFacilityName` **(coordinator decision 1, 20 Nov 2026)**.

**Who sees it.** Exactly the pharmacy staff who see the item: at the session's facility, by the member's own consent grant or the item's order route, or, for this hospital's own items, by 0133's own-work basis. The route checks `pharmacy.work-item.read`, and the database reader checks it again.

**Items from another facility: a stated limit of Release B.** The notice shows only while the pharmacy may read the item: its route allows reads until 14 days after the dispensing, and never more than 45 days after acceptance. Entering the prescription in error after the dispensing ends that access at once. So a pharmacist with no consent grant of their own never sees "entered in error" on such an item: the item leaves their list, a read answers 409 `ORDER_ROUTE_CLOSED` "This prescription from another facility is closed: stop work on it", and the patient is told (`ORDER_ROUTE_CANCELLED`, 0086). A member with a consent grant of their own still sees the item and the notice. Changing this needs a change to 0086's route rules, which Release B does not make.

**The list's order (unchanged).** A dispensed item keeps its place in the done work, ordered by the day it was received, and leaves the list 90 days after that day (Q123 A). A change does not move it up or bring it back. A read by its id still answers it, with the notice.

**The prescriber's side (unchanged)** **(coordinator decision 1, 20 Nov 2026)**. `ownProgress` stays `dispensed` (or `dispensing_reversed`). The progress call, its headers and ehr-api's prescription answers are unchanged, and the PATCH answers no `pharmacyHandoff`, as today. No notice and no outbox event is sent (ORD-11 notifies dispensings and reversals only).

**Database** (migration 0148, number provisional, given in merge order at the Release B cut-off; needs 0001-0137, not 0147):
- One trigger on `ehr.prescriptions`, `prescriptions_pharmacy_change_after_dispensing`: AFTER UPDATE, for each row, only when the prescription was active or on hold before the change, in origin mode (as 0133 D8's). Its function (SECURITY DEFINER, run as the owner, executed by no role) never refuses the change it follows. It reads only 0133's claims (row-level security on and not forced, so the owner is never filtered) and writes one row per prescription version for each dispensed item of the prescription, with the time taken when it runs. Its name sorts after `prescriptions_order_routes_sync` (0086) and D8's trigger, so it runs after the route sync has waited for a dispensing in flight. The migration checks that no trigger on the table sorts after it.
- One table, `pharmacy.prescription_changes_after_dispensing`: the work item, its facility, the prescription version, the status before and after, a SHA-256 fingerprint of the prescription's content before and after, and the time. No actor, no reason, no field value, no prescription id. Key (`work_item_id`, `prescription_version`). Rows are never updated or deleted. Row-level security on, not forced, no policy, no grant: the owner's only, like 0133's claims. The fingerprint is the prescription row without its status, version and two times, so it names no column. A later migration that adds a column with a value in every row adds that column to the fields the fingerprint leaves out, or the first resume after it reads `edited`.
- One reader, `pharmacy.work_item_changes_after_dispensing(uuid[])` (SECURITY DEFINER, STABLE, at most 200 ids, else 22023 `WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID`): the labels above, only for items the session may read (`pharmacy.work_items`' two read policies, repeated as conditions, so a superuser owner and production's owner answer alike). EXECUTE for `hid_pharmacy_runtime` and `hid_schema_test_runtime`, here and in `runtime-grants.sql`. The labels are set by the reader from the recorded facts, so a later change to the rules applies to rows already recorded, and an edit made during a hold can show at the resume.
- No change to 0133 or 0147, to `pharmacy.work_items`, or to `ehr.prescriptions`' columns, policies or row-level security. No 0148 function body names `ehr.prescriptions`, so 0133's list of owner-run readers of prescriptions stays as it is.
- Locks: ACCESS SHARE on the tables the migration reads (the work items, 0133's claims, and the account, staff, membership, role, permission, facility and organization tables its post-check probe of the reader opens) and their indexes, then, last, SHARE ROW EXCLUSIVE on `ehr.prescriptions` until commit (what CREATE TRIGGER needs). While it is held, every prescription create and change waits until the migration commits; reads, `FOR UPDATE` and the dispensing's `FOR SHARE` do not, and nothing fails. NOWAIT, tried again every 100 ms for at most 50 attempts (5 to 5.5 seconds), and nothing after that waits for a lock; an autovacuum or ANALYZE of `ehr.prescriptions` that is still running after the last attempt stops the file, nothing applied. On a copy with 20,000 prescriptions, work items and claims the file took 44 to 78 ms, of which the hold was 20 to 25 ms. No backfill.
- Undo by hand only, in the order the migration's header gives: the trigger first, then the reader, the trigger function and the table. Dropping the trigger takes ACCESS EXCLUSIVE on `ehr.prescriptions`, so it is run under a short `lock_timeout` and repeated, or the trigger is disabled first (SHARE ROW EXCLUSIVE) and dropped later. Dropping the table while the trigger stands would make every change of an active or held prescription fail. 0148's undo comes before any step of 0133's undo and does not depend on 0147's.
- Release A images work unchanged on this schema: ehr-api's changes fire the trigger, which cannot refuse them and costs one index probe when nothing was dispensed; Release A pharmacy-api calls nothing of 0148.

**Rollout.** Either image may be deployed, or rolled back, first, and no header is needed. The list and the read are browser calls and the field is optional, and ehr-api only passes the hand-off's replay through; today's pharmacy-api never calls 0148's reader; the new pharmacy-api answers no notice on a database without 0148; ehr-api does not change. Release A's `@hid/api-client` builds the item from the fields it knows and drops this one.

### Errors

None new. The list and the read keep their errors. A failure of the new reader never fails them: the notice is left out (above).

### Screen notes

- **Pharmacy list and item:**
  - On an item with `changedAfterDispensing`, show the words from the table above, then the time in Lagos time (for example "Last change: 20 Nov 2026, 09:15" for a `changedAt` of `2026-11-20T08:15:00.000Z`) and the next step, "Contact the patient." With `changeCount` above 1, add " (changed n times)", for example " (changed 2 times)".
  - On an item from another facility, say "by <orderRoute.orderingFacilityName>" in place of "by the prescribing team"; with no route card or no name, "by the ordering facility".
  - With no `change` (a newer backend), show "Changed after dispensing by the prescribing team" (or "by <ordering facility>").
  - Show the words, never the code (`on_hold`, `entered_in_error`), a version or an id. Keep the words in the strings file.
  - No "Dismiss" or "Seen" button in Release B.
  - The notice sits next to the dispensed step, and next to the reversal when there is one. `withdrawn` items keep ORD-2's words; the two never meet.
  - With no `changedAfterDispensing`, show nothing, as before this ships.
- **The prescriber's order row:** unchanged.
- **Before this ships:** nothing changes on screen.
- **`@hid/api-client`:** `PharmacyWorkItem` gains `changedAfterDispensing?` with `change?`, `changedAt` and `changeCount`. A notice with a `change` the client does not know is kept without `change`, unlike ORD-4's steps, which are dropped: a safety notice is better shown without its reason than not at all. A notice that is not an object, a missing time, or a count that is not a whole number of 1 or more is refused with 502, like any other broken field.
- **Items from another facility through `@hid/api-client`:** the client today refuses a list that holds such an item (it requires ids such an item never carries) and has no `orderRoute`. A separate fix comes first, in its own PR; until it lands, "by <ordering facility>" cannot be shown through the client.

### Depends on

- ORD-2 (0133: D8's trigger is the model; D14's claims say when an item was dispensed; D2's own-work basis), ORD-4 (0147; the step stays `dispensed`).
- 0101 (a dispensing holds the prescription until it commits); sections 21-24 and 0086 (order routes, their access windows and the route sync); Q123 A (the list's window and order).
- Q132 A (owner decision, 19 Nov 2026); coordinator decision 1 (20 Nov 2026).
- ORD-12 (refills, 0149-0150): "after dispensing" means after the first fill. 0133's claim records the first fill only and refuses a second today (`not_claimed`), so ORD-12 replaces that claim function and keeps the first fill's time. ORD-12's create-only refills column is added to the fields the fingerprint leaves out, or the first resume after ORD-12 reads `edited`. After any change, 0101's version check refuses the next refill; ORD-12 says what a refill after a change means. 0148 merges first, or is pinned again.
- ORD-11 (no notice for a change), MY-1 (unchanged).

### Target

Release B (lane D). Size **M**:
- one trigger on `ehr.prescriptions`, one table and one reader;
- the list, read and replay field in pharmacy-api, and the type and parser in `@hid/api-client`;
- tests: a database suite for 0148 (every label, both owner kinds, visibility equal to `pharmacy.work_items`', the undo order, and removal cases that each fail when one clause is taken out), 0133's suite's undo case with 0148 undone first, steps in `services/ehr-api/scripts/verify-own-facility-work-runtime.mjs` (an edit and then a hold after the dispensing show on the pharmacist's list; a hand-off item dispensed by a pharmacist without a consent grant and then cancelled shows `cancelled`; a change racing a dispensing is recorded once) and in `services/ehr-api/scripts/verify-order-routes-runtime.mjs` (the outside pharmacy sees `on_hold` with the ordering hospital's name; the same race through the route).

# Release C

## ID-8: Merge an unknown or duplicate record into the real one, with a 30-day undo (planned, Release C, needs a migration: yes)

Akos items:
- P0-4 ("merge it into the real record later, with audit"; P0-4c in the build plan)
- the duplicate risk from P0-1 (registration without a NIN)

Status: planned, not live.

The work is in two parts, as in the plan:
- **ID-8a:** merge requests and the review list.
- **ID-8b:** the merge itself and the 30-day undo. ID-8b ships in its own Release D if its rehearsal is not clean by the Release C cut-off.

Both need migrations, numbered at the cut-off. They add:
- `identity.patient_merges` (request, decision and status);
- `identity.patient_merge_moves` (the manifest of moved rows);
- `identity.patients.merged_into_patient_id`;
- the definer functions behind the routes;
- two access-log actions.

Rules:
- Two different staff members: one asks and another approves. (owner decision Q127 A, 19 Nov 2026)
- A merge goes only **from** a record that is unknown (ID-7) or "NIN Not Verified", and that nobody signs in to: no login and no enrolment in progress. (owner decision Q127 A, 19 Nov 2026)
- The merge goes **into** an active, standard record (NIN Verified or not) on the same side of the seals. A record merged into is never changed: names, date of birth, NIN and Health ID all stay.
- The source must be this facility's own record: made at this desk (ID-2) or an unknown record made here (ID-7). So only the facility that made a record can merge it.
- An undo is possible for 30 days after the merge. After that the merge is final. (owner decision Q127 A, 19 Nov 2026)

### Routes

All routes need `X-Facility-Id` and the purpose `healthcare-operations`: POST routes send it in the body as `purpose: "healthcare-operations"`, GET routes as the header `X-Purpose-Of-Use: healthcare-operations`. Every write needs `Idempotency-Key`.

**1. `POST /api/v1/identity/patient-merges`**: ask for a merge.
- Permission `identity.registration.write`.

```json
{ "sourcePatientId": "uuid", "targetMatchRef": "psr_...",
  "reason": "Identified on 19 Nov; her own record found by full name and date of birth.",
  "purpose": "healthcare-operations" }
```

| Field | Type | Rule |
|---|---|---|
| `sourcePatientId` | UUID | this facility's own unknown or NIN Not Verified record, with no login |
| `targetMatchRef` | string | a matchRef from this member's own direct-care search (0132) in the last 10 minutes. It is resolved with lane B's `resolvePatientMatchRef` using purpose `direct-care`, the purpose of the search that issued it, whatever the merge request's own purpose (a matchRef resolves only for the same member, facility and purpose; Release A contract "matchRef"). A test pins this pairing. The target is never given as a Health ID or a bare id, so a merge can reach only records the member could find by search |
| `reason` | string | 8-500 characters |

Answer `201`:

```json
{ "mergeId": "uuid", "status": "requested", "version": 1, "requestedAt": "...",
  "source": { "patientId": "uuid", "fullName": "Unknown patient U-0007", "sex": "male", "dateOfBirth": "1991-07-01",
              "dateOfBirthEstimated": true, "healthIdLast4": "QX7P", "ninStatus": "not_verified", "recordKind": "unknown" },
  "target": { "fullName": "Musa Bello", "sex": "male", "dateOfBirth": "1990-03-14",
              "healthIdLast4": "AB12", "ninStatus": "verified", "recordKind": "standard" },
  "moves": { "visits": 2, "notes": 3, "vitals": 5, "diagnoses": 1, "prescriptions": 2,
             "labRequests": 1, "documents": 0, "allergies": 0 },
  "replayed": false }
```

- The target card is the search card the member already saw. It has no `patientId` and no clinical counts, because there is no consent for the target.
- `moves` counts the source's rows only.

**2. `GET /api/v1/identity/patient-merges?view=mine|facility&status=requested|merged|undone|refused|cancelled&limit=1..100&cursor=`**
- `mine` needs `identity.registration.write`. `facility` needs `identity.registration.approve`. This mirrors SX-10.
- Items have the shape of the answer above.

**3. `GET /api/v1/identity/patient-merges/:mergeId`**: one merge, with `undoUntil` once it is merged. Same permissions as the list (the member who asked, or an approver at this facility).

**4. `POST /api/v1/identity/patient-merges/:mergeId/approve`**: carry out the merge (ID-8b).
- Permission `identity.registration.approve`. The approver must not be the member who asked. (owner decision Q127 A, 19 Nov 2026)
- Body `{ "expectedVersion": 1, "purpose": "healthcare-operations" }`.
- Every rule is checked again with both records locked (in UUID order). The merge happens in one transaction.

**5. `POST /api/v1/identity/patient-merges/:mergeId/refuse`**: an approver refuses. Body `{ expectedVersion, reason (8-500), purpose }`.

**6. `POST /api/v1/identity/patient-merges/:mergeId/cancel`**: the member who asked withdraws the request before a decision. Body `{ expectedVersion, purpose }`.

**7. `POST /api/v1/identity/patient-merges/:mergeId/undo`**: an approver at this facility undoes the merge, until `undoUntil` (30 days after `mergedAt`). (owner decision Q127 A, 19 Nov 2026)
- Body `{ expectedVersion, reason (8-500), purpose }`.
- Answer: the merge with `status: "undone"` and the counts moved back.

What a merge does (ID-8b):

- **Rows that move:** every row that names the source patient in the clinical, order, lab, pharmacy, waiting-list and document tables moves to the target, and each moved row is recorded in the manifest.
- **The table list is checked:** the migration and a test both read pg_catalog. Every foreign key to `identity.patients(id)` must be on the "moved" list or the "kept" list, or the migration fails.
- **Rows that never move:** consent grants, access requests, break-glass grants, Access PINs, shares, audit rows, identifiers and the source's Health ID.
  - The source's active grants and open access requests are ended with the words "Record merged".
  - So nobody gains access to the target through the source. Each member still needs their own basis for the target: Access PIN, approval, 0131 own-facility, or break-glass.
- **No own-facility basis on the target:** the merge creates none, and moved visits never count toward 0131's "visit here".
- **The source record:** its `status` becomes `merged` (already a value in the CHECK, `0002_auth_and_canonical_identity.sql:180`). 0132 search already leaves merged records out. A staff lookup of its Health ID gets the answer for any patient who is not active (contract "Q100 B": 404 `NOT_FOUND`, "Patient was not found or is not available"). That answer never points to the target.
- **Refusals:** a source with an order sent to another facility that is still open (contract sections 21-24) is refused, because the other facility's work would otherwise change patient under it.
- **The target patient's access log:** when the target has a login, `GET /api/v1/identity/me/access-log` gains `records_merged_in` ("Records from <facility> were added to your Health ID") and, after an undo, `records_merge_undone`.

What an undo does:
- It moves every manifest row back. It also moves back any row added after the merge that hangs off a moved row (for example a result on a moved lab request), found through the same foreign-key list.
- Other rows added to the target after the merge stay there. The answer counts them.
- The source becomes active again, as it was.
- Grants ended by the merge are not restored.
- After 30 days, the manifest is kept as audit evidence and is never deleted.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED`, `PURPOSE_OF_USE_REQUIRED`, `IDEMPOTENCY_KEY_REQUIRED` | as ID-6 |
| 403 | `PERMISSION_DENIED` | "You do not have permission to do this." |
| 403 | `MERGE_SECOND_PERSON_REQUIRED` | "Another approver must approve this. You asked for this merge." (owner decision Q127 A, 19 Nov 2026) |
| 403 | `MERGE_SEARCH_FIRST` | "Search for the right record first, then ask to merge. A search result can be used for 10 minutes." (target matchRef not this member's, expired, emergency, or invalid; one answer for all) |
| 404 | `MERGE_NOT_FOUND` | "No merge request of this facility matches." |
| 404 | `PATIENT_NOT_FOUND` | "No such patient." (source not this facility's own or not active; Q100 B) |
| 409 | `MERGE_SOURCE_NOT_ALLOWED` | "Only an unknown or NIN Not Verified record that nobody signs in to can be merged into another." (owner decision Q127 A, 19 Nov 2026) |
| 409 | `MERGE_SAME_RECORD` | "These are the same record." |
| 409 | `MERGE_TARGET_NOT_ALLOWED` | "This record cannot receive a merge." (not active, unknown, or across the seals) |
| 409 | `MERGE_SOURCE_HAS_OPEN_ROUTED_ORDER` | "This record has an order sent to another facility that is still open. Wait until it is finished or stopped." |
| 409 | `MERGE_ALREADY_OPEN` | "There is already a merge request for this record." |
| 409 | `MERGE_ALREADY_DECIDED` | "This merge request has already been decided." |
| 409 | `MERGE_UNDO_EXPIRED` | "The 30 days to undo this merge have passed." (owner decision Q127 A, 19 Nov 2026) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | as ID-6 |
| 412 | `VERSION_CONFLICT` | "Someone else changed this merge request. Reload it and try again." |
| 503 | `MERGE_UNAVAILABLE` | "Merging records is not available right now." (a database without the migration) |

Audit:
- Each route and each refusal writes one row: `identity.patient-merge.request`, `.approve`, `.refuse`, `.cancel`, `.undo`, `.read`, or `.list` plus `.list.shown` (one row per patient shown).
- `.read` is written for `GET .../patient-merges/:mergeId` on success and on refusal, naming both patient ids, the same way `.list.shown` does.
- Each row holds both patient ids, the counts and the outcome or refusal kind. The typed reason goes in the row's `reason`.
- No row holds a name, date of birth, phone or Health ID.

### Screen notes

**Release C:**
- Show "Ask to merge" on this facility's unknown or NIN Not Verified records that have no login. The flow:
  1. Search for the right record with strong keys (0132).
  2. Pick its card, which sends that card's `matchRef`.
  3. Type the reason.
  4. Show what will move (`moves`).
- Approvers get a "Merge requests" list (`view=facility`) showing both cards side by side, with the counts and Approve or Refuse.
- After a merge:
  - Say "Merged. Open the patient's own record with their Access PIN or an access request." The merge gives no access to the target.
  - Show "Undo merge" until `undoUntil`.
- Under ID-6's `NIN_ON_ANOTHER_RECORD` and ID-7's `sent_for_review`, link to "Ask to merge".

**Before this ships (Release B and earlier):**
- Show "Possible duplicate" where ID-2 or ID-7 says the record was sent for review, with no merge button and the line "Merging records is not available yet. Keep using this record; do not make another."
- Keep ID-2's rule that the desk never sees the other person's details.

### Depends on

- ID-2 / 0130, the source records and `?evidence=none` list.
- ID-4 / 0131: the source must be this facility's own, and the merge must never create an own-facility basis. ID-7's "created as unknown here" basis ends on merge.
- 0132: the matchRef (resolved with purpose `direct-care`) and the exclusion of merged records.
- ID-6.
- ID-7.
- EHR-C7 / 0135, 0133 and every clinical table (the foreign-key coverage check).
- The order-route sections 21-24.
- Owner decision Q127 A, 19 Nov 2026. Every line marked above follows it.

### Target

Release C, lane A. ID-8a is size M. ID-8b is size L, and it is the riskiest migration in the plan. It may move to a Release D of its own. Overall size: L.

## SX-6: Change password while signed in, and edit own profile (planned, Release C, needs a migration: yes)

Akos items:
- P1-8: "My profile (read and edit)" and "change password"

Status: planned, not live.

The owner's default "Changing the password signs out other devices" applies unless the owner objects. SX-5 (`GET /identity/me/staff-profile`) is the read and is live. When SX-6 is switched on, its `canChange.password` and `canChange.name` turn `true`.

### Routes

All routes are under `/api/v1`, with Origin and CSRF checks for cookie sessions.

| Method and path | Who may call | Permission |
|---|---|---|
| `POST /identity/me/password` | Any staff session, including a platform administrator. `X-Facility-ID` is optional, as in SX-5. | none: the caller's own account |
| `POST /identity/me/staff-profile` | The same callers. | none: the caller's own account |

**Change password**

Headers: `Idempotency-Key` (required, 16-128 URL-safe characters).

```json
{ "currentPassword": "…", "newPassword": "…" }
```

- `currentPassword`: 1-256 characters.
- `newPassword`: 12-256 characters, the same rule as a reset (`otp.dto.ts`) and as accepting an invitation. It must differ from the current password.

Answer `200`:

```json
{ "changed": true, "otherSignInsEnded": 2, "passwordChangedAt": "2026-11-20T09:00:00.000Z", "replayed": false }
```

What happens, in one transaction:
1. The current password is checked the way `staff-reauthentication.service.ts` checks it. A wrong password counts towards the sign-in lockout (five in 15 minutes lock sign-in for 15 minutes).
2. The new hash is stored and `password_changed_at` is set.
3. **Every other sign-in of the account is ended**, staff and patient kinds and every product site alike, with revocation reason `password_changed`.
4. The account token version is raised, and **the current sign-in is renewed in the same answer**: new cookies, as `POST /auth/refresh` gives. The person stays signed in on this device.

Afterwards:
- A single sign-on provider session from before the change opens nothing. Section 54 already refuses one older than `password_changed_at` (`stale_provider_sign_in`).
- The "Your Health ID password was updated" email is sent through notification-api's existing `password-updated` route (`notification-otp.client.ts:260`), keyed by the change's id. This is best-effort and never fails the change.
- A replay with the same key and body answers the same `200` with `replayed: true` and changes nothing.

**Edit own profile**

Body:

```json
{ "name": "Ada Fictional-Bello", "expectedVersion": 3 }
```

- `name` is the only field a person can change. It must be a person's full name of 2-80 letters, by the same rule as an invitee's name (`acceptableStaffPersonName`, `staff-invitation.dto.ts`).
- `expectedVersion` comes from SX-5's answer, which gains `profileVersion` (an integer).
- Email is not editable here: a change of email needs a code to the new address, which is later work.
- The licence and roles are not editable here: they are vouched for by the facility administrator or Health ID support (SX-4).
- At most 3 name changes in 24 hours.

Answer `200`: the SX-5 profile with the new `name` and `profileVersion`.

How the name is stored:
- It is written to `auth.accounts.display_name`. SX-5 reads `name` from there, and the staff names list (SX-9) and order screens read it too.
- Records already written keep the name they were written with.

**Database (provisional)**
- Two definer functions, `auth.change_own_password` and `auth.change_own_display_name`.
- A `profile_version` column on `auth.accounts`.
- Identity's runtime is not assumed to update these columns directly.

**Audit**
- `auth.password.change` records success, denied (wrong password), or failure. No password material is kept.
- `auth.staff-profile.update` records the previous and new name (this is staff data, not patient data).
- No patient is read by either route.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Check the highlighted fields. |
| 400 | `PASSWORD_TOO_SHORT` | Use at least 12 characters. |
| 400 | `PASSWORD_SAME_AS_CURRENT` | Choose a new password that is different from your current one. |
| 400 | `STAFF_NAME_INVALID` | Enter your full name: 2 to 80 letters, without digits or the words Health ID, HID, support, admin, administrator or ministry. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Please try again. |
| 401 | `AUTHENTICATION_REQUIRED` | Please sign in again. |
| 403 | `PATIENT_SCOPE_DENIED` | This is for staff accounts. |
| 403 | `STAFF_REAUTHENTICATION_FAILED` (today, `staff-reauthentication.service.ts`) | That password isn't right. |
| 409 | `PASSWORD_NOT_SET` | This account signs in with Google and has no password. Use "Forgot password" on the sign-in page to set one. |
| 409 | `VERSION_CONFLICT` (today) | This changed meanwhile; reload before retrying. |
| 409 | `IDEMPOTENCY_KEY_REUSED` | This request was already used for a different change. Please reload and try again. |
| 429 | `STAFF_REAUTHENTICATION_LOCKED` | Too many wrong passwords. Try again in 15 minutes. |
| 429 | `STAFF_NAME_CHANGE_LIMITED` | You have changed your name 3 times today. Try again tomorrow. |
| 503 | `DEPENDENCY_UNAVAILABLE` | Something went wrong on our side. Please try again. |

### Screen notes

**Change password** (shown when `canChange.password` is `true`)
- Fields: current password, then new password twice. The second entry is compared in the browser only.
- After `200`, say "Password changed. You have been signed out on your other devices." Then re-read `GET /auth/session`.
- If `signIn.hasPassword` is `false`, show "You sign in with Google" and a link to "Forgot password".

**My profile** (name editable when `canChange.name` is `true`)
- The name is the only edit box.
- Email, licence ("Licence number ending 4567") and roles are read-only, with "Ask your facility administrator to change this."

**Before this ships:** SX-5 answers `canChange: false`. Show the profile read-only and no password form. To change a password today, use "Forgot password" from the sign-in page.

### Depends on

- SX-5 (live read; gains `profileVersion`).
- Section 54 (stale provider sign-in rule).
- The owner's default on signing out other devices.
- No pending owner question.

### Target

Release C. Size M: the in-place session renewal and the sign-out of other devices need care and runtime checks. The name edit alone would be S.

## SX-7: Preferences and up to 12 home shortcuts (planned, Release C, needs a migration: yes)

Akos items:
- P1-8: language preference and notification preferences
- Home shortcuts (raised after the review; no id)

Status: planned, not live.

The owner's default "Staff language is English only for now" applies. SX-7 stores a `language` field, but its only value is `en` until P2-2 adds translations. Notification choices follow ORD-11 (owner decision Q128 A, 19 Nov 2026).

### Routes

All routes are under `/api/v1`, for any staff session. These are the caller's own settings, so no permission is needed.

| Method and path | Who may call | Permission |
|---|---|---|
| `GET /identity/me/preferences` | Any staff session. `X-Facility-ID` is optional. When it is sent, the answer includes that facility's shortcuts. | none |
| `POST /identity/me/preferences` | The same callers. Saves language and notices for the person. | none |
| `POST /identity/me/shortcuts` | A staff session at the `X-Facility-ID` facility. Saves that facility's shortcuts. | none beyond membership |

**Read answer**

```json
{ "version": 2, "language": "en", "languagesAvailable": ["en"],
  "notices": { "served": false, "labResultReady": true, "prescriptionDispensed": true,
               "criticalResult": true, "criticalResultCanChange": false },
  "shortcuts": { "facilityId": "uuid", "version": 5, "max": 12,
                 "items": [ { "module": "find-patient", "available": true },
                            { "module": "lab-queue", "available": false } ] } }
```

- `shortcuts` is `null` when no `X-Facility-ID` is sent.
- Defaults are given when nothing has been saved: `version` 0, English, every notice on, and no shortcuts.
- `languagesAvailable` stays `["en"]` until P2-2.

**Save preferences**

Headers: `Idempotency-Key`.

```json
{ "language": "en", "notices": { "labResultReady": true, "prescriptionDispensed": false }, "expectedVersion": 2 }
```

- The save replaces the whole record.
- `language` accepts only `en` for now.
- `criticalResult` cannot be sent: a critical result always notifies and must be marked Seen (owner decision Q128 A, 19 Nov 2026).
- `expectedVersion` is `0` for the first save.

**Save shortcuts**

Headers: `Idempotency-Key`.

```json
{ "items": [ { "module": "find-patient" }, { "module": "triage" } ], "expectedVersion": 5 }
```

- 0-12 items, kept in the order sent, with no repeats.
- `module` must be one of the keys of SX-1's `modules` map. The examples here are illustrative; SX-1's section fixes the list.
- A shortcut may name only a page, never a patient: no patient id, Health ID or matchRef is accepted or stored.
- A shortcut to a page the member's roles do not allow at this facility is refused when saved.
- If a role is removed later (SX-4), the saved shortcut is kept and answered with `available: false`.

Both saves answer `200` with the read answer above. A replay with the same key and body answers the same, with `replayed: true`.

**Database (provisional)**
- `identity.staff_preferences`: one row per account, holding the language, the notice choices and a version.
- `identity.staff_shortcuts`: one row per active membership, holding up to 12 module keys and a version. These rows are not read once the membership ends.
- Neither table holds patient data.

**Audit**
- `identity.staff-preferences.update` and `identity.staff-shortcuts.update`, with the new values. They contain no patient data.
- Each read writes one `identity.staff-preferences.read` row (success or refusal), as SX-5 does.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Check the highlighted fields. |
| 400 | `LANGUAGE_NOT_AVAILABLE` | Only English is available for now. |
| 400 | `SHORTCUTS_TOO_MANY` | You can keep up to 12 shortcuts. |
| 400 | `SHORTCUT_UNKNOWN` | One of these shortcuts is not a page Health ID knows. Reload and try again. |
| 400 | `SHORTCUT_DUPLICATE` | Each shortcut can appear only once. |
| 400 | `SHORTCUT_NOT_ALLOWED` | Your role here cannot open one of these pages. |
| 400 | `FACILITY_REQUIRED` | Choose where you are working first. (Shortcuts only.) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Please try again. |
| 403 | `PATIENT_SCOPE_DENIED` | This is for staff accounts. |
| 403 | `FACILITY_ACCESS_DENIED` | You are not working at this facility. |
| 409 | `VERSION_CONFLICT` | This changed meanwhile; reload before retrying. |
| 409 | `IDEMPOTENCY_KEY_REUSED` | This request was already used for a different change. Please reload and try again. |
| 503 | `PREFERENCES_UNAVAILABLE` | Your settings could not be loaded. Please try again. |

### Screen notes

**Account menu, under "Settings"**
- Language: hide it, or show "English" read-only, while `languagesAvailable` has one entry. Offer a choice only once P2-2 adds a second language. Always send `"language": "en"` on save.
- Notice switches appear only while `notices.served` is `true` (after ORD-11). "Critical results" is shown switched on, with "Always on for patient safety."

**Home**
- Show the facility's saved shortcuts in their saved order.
- Hide items with `available: false`.
- "Edit shortcuts" offers only pages the session's `modules` allows, and stops at 12.
- Save on "Done", not on every tap.
- On `503`, keep the tab's shortcuts and show "Your shortcuts could not be saved."

**Before this ships**
- Shortcuts stay only while the tab is open, as today. Nothing is saved on the device.
- No language or notice settings are shown.
- SX-5's `canChange.preferences` stays `false`.

### Depends on

- SX-1: the `modules` keys.
- SX-5: `canChange.preferences` turns `true`.
- SX-4: a removed role marks shortcuts unavailable.
- ORD-11 for the notice choices (owner decision Q128 A, 19 Nov 2026).
- P2-2 (translations) before any second language.

### Target

Release C. Size S.

## CHW-1: A community health worker role for Outreach (planned, Release C, needs a migration: yes)

Akos items:
- N-2: the role table's Outreach row
- His open question: "Is 'Outreach' meant for community health workers? If so, it needs its own role."

Status: planned, not live.

Owner decision Q130 A, 19 Nov 2026. A new Outreach-only role, for field health workers who register and screen people but never open the clinical record.

**What exists today**
- Outreach groups already have `outreach_volunteer` (0115). It holds `outreach.campaign.read`, `outreach.registration.read` and `outreach.registration.write`.
- 0115's fence lets that role be granted only at an outreach group's facility, and no clinical role there.
- So a hospital or clinic has no Outreach-only role. Its outreach work is done by roles that also carry clinical permissions. (After 0136, doctors no longer have any Outreach code.)

### The role (owner decision Q130 A, 19 Nov 2026)

**Code and name**
- `community_health_worker`, titled "Community health worker".

**Where it can be granted**
- Hospital and clinic facilities only.
- Outreach groups keep `outreach_volunteer`.
- 0115's fence is extended by one rule: this role is granted nowhere else, and it is never granted at an outreach group.

**Permissions**
- Exactly the volunteer's three: `outreach.campaign.read`, `outreach.registration.read` and `outreach.registration.write`.
- Nothing else. In particular it gets no `identity.*`, `ehr.*`, `lab.*`, `pharmacy.*`, `ocr.*`, `workforce.manage`, consent or break-glass code.

**Licence**
- None is asked in this release, as for the front desk.
- Whether to record a community health practitioner registration number is an open point with no decision yet, to be decided before this section is built.

**Sign-in**
- Admitted on `outreach.` only, under section 53's gate. The role holds no `ehr.encounter.write`, so it is not a hospital clinical role.
- The release adds a test pinning that a hospital membership holding only this role opens `outreach.` and is refused elsewhere with 403 `PRODUCT_NOT_AUTHORISED`.

**Home**
- SX-1's `modules` map gives this role the Outreach module only, and Home opens there.

### Routes

No new route. The role uses existing ones:

- See the campaigns it is a member of, and their staff list (section 40).
- Register people into those campaigns (section 8 "Outreach registration boundary", `POST /outreach/registration-cases`, with `Idempotency-Key`).
- Read and save a screening (section 48, `GET`/`PUT .../screening`).
- See only the registrations of campaigns it belongs to (0045 row rules, section 48.3).
- Campaign admins add it to a campaign as `health_worker` or `enumerator` (section 40).

**What it cannot do**
- It cannot create, open, close or manage a campaign. It has no `outreach.campaign.write`, the same rule 0115 gives volunteers ("a helper must not create campaigns").
- It cannot search for patients (0132), register at the desk (ID-2), check people in (EHR-C7), open a chart, request access, use an Access PIN, use emergency access, scan paper records, or see any lab or pharmacy work.
- It cannot link a registration to an existing patient (`link-existing`): that needs Identity's patient authorization, which this role does not have. The facility's front desk or a nurse does it.
- At a hospital, it cannot create a Health ID through Outreach (section 49), because that route refuses groups that are not outreach groups. Changing that is outside this package.
- Recording an export (section 48.x) is not given to this role (proposed). Campaign admins export.

**How it is given**
- An invitation (`POST /identity/staff-invitations`): the role list gains `community_health_worker`, with no licence fields.
- SX-4's add and remove.
- At governed facilities, Health ID support does it (owner decision Q129 A, 19 Nov 2026).

**Database (provisional)**
- One `auth.roles` row and three `auth.role_permissions` rows.
- The 0115 fence change.
- `staff_invitable_roles` gains the role for hospital and clinic facilities.
- The SX-1 role-matrix fixture is updated in the same PR.
- No table changes. No existing member is changed.

### Errors

No new codes. These are the answers this role meets:

| HTTP | Code | Message |
|---|---|---|
| 400 | `STAFF_INVITATION_ROLE_NOT_ALLOWED` (today) | This facility cannot invite that role. (At a laboratory, a pharmacy or an outreach group.) |
| 403 | `PRODUCT_NOT_AUTHORISED` (today, section 53) | This account cannot sign in to this site. (On `ehr.`, `lab.`, `pharmacy.` or `migrate.`.) |
| 403 | `PERMISSION_DENIED` (today) | You don't have permission to do this. (Any non-Outreach route.) |
| 403 | `OUTREACH_CAMPAIGN_ADMIN_REQUIRED` (today, section 40) | Only this campaign's admins can do this. |
| 404 | `OUTREACH_REGISTRATION_NOT_FOUND` (today, section 48) | This registration was not found. (Another campaign's registration.) |

### Screen notes

**Facility administrator**
- "Invite staff" and SX-4's "Add role" list "Community health worker" at hospitals and clinics, with no licence fields.

**The worker's own screens**
- On `outreach.`: campaigns they belong to, register, and screening.
- No "Create campaign", no export, no patient search, no chart links.
- If they open `ehr.`, show "Your account works on Health ID Outreach" and a link to `outreach.`.

**Before this ships**
- Do not show the role anywhere.
- Field workers at a hospital keep using the roles they have.
- Outreach groups keep using volunteers.

### Depends on

- Q130 A (owner decision, 19 Nov 2026), and Q129 A (owner decision, 19 Nov 2026) for adding it to existing staff.
- SX-1: `modules` and the role-matrix fixture.
- SX-4.
- 0136: doctors lose Outreach.
- Section 53's gate.

### Target

Release C. Size S: role rows, the fence change and the gate test. Treat it as M if section 53's gate needs code beyond the permission rule for a hospital membership with Outreach codes only.

## ORD-6: Several tests in one lab request (planned, Release C, needs a migration: yes)

Akos items:
- N-7 (several tests per request; "send to this facility's lab" on create)

Status: planned, not live.

What exists today, so nothing here repeats it:
- One lab request holds one test (`ehr.lab_requests.test_code`, `0004:243`; `CreateLabRequestDto`, `clinical.dto.ts:562-588`).
- Sending to this facility's lab on create already works: create with `status: "active"` and the answer carries `labWorkItem` and `labHandoff` (`lab-requests.service.ts` `create`). `status: "draft"` saves without sending. First activation needs no typed reason (Q105).
- Lab can already hold several requested tests on one work item (`lab.work_item_requested_tests`, `0018:56`), but EHR sends one test per work item (`accept-ehr-order.dto.ts`).

Design: one form, several tests, saved together. Each test becomes its own lab request (as today), linked by a `requestGroupId`. This keeps every per-request rule unchanged: progress (ORD-3), order routes, cancelling or holding one test, released results per order, and the reason rules (FR-1, Q105).

### Routes

| Method | Path | Who | Permission |
|---|---|---|---|
| POST | `/api/v1/ehr/patients/:patientId/encounters/:encounterId/lab-request-groups` | anyone who may create a lab request today | `ehr.lab-request.write` |
| GET | `/api/v1/ehr/patients/:patientId/encounters/:encounterId/lab-requests?requestGroupId=<uuid>` | as today's list | `ehr.lab-request.read` |

Headers as the single create: `X-Facility-Id`, `X-Purpose-Of-Use`, and a required `Idempotency-Key` (16-128 URL-safe characters, `common/idempotency.ts`). One key covers the whole group. Patient and visit are UUIDs; no Health ID anywhere.

Request:

```json
{
  "status": "active",
  "priority": "routine",
  "clinicalInformation": "Fever for 3 days",
  "tests": [
    { "testCodeSystem": "LOINC", "testCode": "58410-2", "testDisplay": "Full blood count", "specimenTypeCode": "Blood (EDTA)" },
    { "testCodeSystem": "HID-LAB", "testCode": "MP-RDT", "testDisplay": "Malaria rapid diagnostic test", "priority": "urgent" }
  ]
}
```

| Field | Type and limits |
|---|---|
| `status` | `draft` or `active` (required). Applies to every test. |
| `priority` | `routine` (default), `urgent`, `asap`, `stat`. A test may override it. |
| `clinicalInformation` | optional, up to 4000 characters, copied to every test |
| `tests` | 1-20 entries. Each takes today's single-create test fields with today's limits (R-2): `testCodeSystem` 1-255, `testCode` 1-100, `testDisplay` 1-500, optional `specimenTypeCode` up to 100, optional `priority`. |

- A code is required until ORD-7 (0144) makes it optional. Use the HID-LAB codes (Wave 0, R-2) for tests with no LOINC code. Once ORD-7 ships, a test may name a catalogue item instead; that shape is ORD-7's.
- The same code system and code twice in one group is refused.
- Any field not listed is refused, and `null` is refused, as on every EHR body.

Answer `201`:

```json
{
  "requestGroupId": "uuid",
  "labRequests": [
    { "id": "uuid", "requestGroupId": "uuid", "testDisplay": "Full blood count", "status": "active",
      "rowVersion": 1, "labWorkItem": { "id": "uuid" }, "labHandoff": { "state": "accepted" } }
  ]
}
```

- Each `labRequests` entry is the single create's full answer, plus `requestGroupId`, in the order sent.
- All requests are written in one transaction: every one, or none.
- With `status: "active"`, each is sent to this facility's lab after the commit. Each `labHandoff` reports its own outcome (`accepted`, `already_accepted` or `failed` with a code).
- Unlike the single create, which answers 409 `LAB_HANDOFF_REFUSED` or 502 `LAB_HANDOFF_UNCONFIRMED`, a group never fails because of the lab. Every request is saved, and a failed send shows only in its `labHandoff`.
- A replay with the same key and body returns the same group as it is now. A different body gets 409 `IDEMPOTENCY_KEY_REUSED` (`clinical.repository.ts:148`).
- Every lab request answer (list, read, create, update) gains `requestGroupId`: a UUID, or `null` for a single request.
- Lab work items (`GET /api/v1/lab/work-items`, and by id) gain `requestGroupId`, so the lab can show a group's tests together.
- Accessions, specimens and results stay per test. Taking one sample for the whole group (one accession) is not in this package.

Audit: today's `ehr.lab-request.create` row for each request, plus one `ehr.lab-request-group.create` row naming the patient, with the request ids and the count. No test names are stored in that row.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Names the field (for example, more than 20 tests). |
| 400 | `LAB_REQUEST_TEST_REPEATED` | This test is already in the request. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | As today (`common/idempotency.ts:10`). |
| 403 | `PERMISSION_DENIED` | As today. |
| 403 | `CONSENT_REQUIRED` | As today: no access to this patient's records here. |
| 404 | `CLINICAL_RESOURCE_NOT_FOUND` | As today: the visit is not found. |
| 409 | `VISIT_ENTERED_IN_ERROR` | As today (EHR-C8a). |
| 409 | `IDEMPOTENCY_KEY_REUSED`, `REQUEST_IN_PROGRESS` | As today (`clinical.repository.ts:148-151`). |
| 503 | `LAB_REQUEST_GROUPS_UNAVAILABLE` | Several tests in one request are not available yet. Add each test on its own. |

### Screen notes

- **Before this ships:** let the clinician pick several tests. Send one `POST .../lab-requests` per test, each with its own Idempotency-Key and the same `status`. Show any test that failed by name ("Malaria RDT was not saved. Try again."). Keep the group only on the open page; the app stores nothing on the device. After a reload the tests show as separate requests. Treat a 409 or 502 handoff answer as "saved, not sent to lab", with "Send to lab" for that test.
- **After:** one Save button. Show each test's own state from `labHandoff` and later from `ownProgress` (ORD-3): "Sent to lab", "Sample taken 09:30", "Results ready 11:05". Offer "Send to lab" (today's `POST .../lab-requests/:requestId/lab-work-item`) only on the tests whose send failed. Group rows by `requestGroupId` in the visit's order list, and let the clinician hold or cancel one test at a time.
- The lab work list may group by `requestGroupId` under one patient card. Its default stays open work plus the last 90 days (Q123 A).

### Depends on

- ORD-3 (progress) and FR-1 and Q105 (no reason on a first activation): live contract sections.
- ORD-7 (0144, Release B) for catalogue picks and name-only tests. Its national list is kept by Health ID's named clinical lead (owner decision Q124 A, 19 Nov 2026).
- Lab's `lab.validate_work_item` (0077) must also check `requestGroupId` against the EHR order.
- ORD-8 uses groups when it applies an order set's tests.

### Target

Release C (lane D). Size **M**: one column on `ehr.lab_requests` and on `lab.work_items`, one ehr-api route, an optional field on Lab's `accept-ehr-order`, and one Lab list field.

## ORD-8: Order sets, favourites, and note and visit templates (planned, Release C, needs a migration: yes)

Akos items:
- P0-5 (order sets such as "Fever workup")
- P1-13 (visit templates per facility: fever, antenatal, follow-up)
- P1-12 (favourite diagnoses only; recent diagnoses are ORD-9)

Status: planned, not live.

Rule for the whole package: **applying a set or template creates drafts only.**
- It never activates an order, sends to a lab or pharmacy, or signs a note.
- The clinician checks each draft, then activates or signs it with today's routes. A first activation or signature needs no typed reason (FR-1, Q105).
- The allergy check runs at activation, as today (0117).

Order sets and templates belong to one facility. They hold no patient data. Favourites belong to one staff member at one facility.

### Routes

| Method | Path | Who | Permission |
|---|---|---|---|
| GET | `/api/v1/ehr/order-sets[?includeRetired=true]` | anyone who may order | `ehr.lab-request.write` or `ehr.prescription.write` |
| POST | `/api/v1/ehr/order-sets` | keepers of the facility's sets | `ehr.order-set.manage` (new) |
| PATCH | `/api/v1/ehr/order-sets/:orderSetId` | keepers | `ehr.order-set.manage` |
| POST | `/api/v1/ehr/patients/:patientId/encounters/:encounterId/order-sets/:orderSetId/apply` | the clinician ordering | `ehr.lab-request.write` for test items, `ehr.prescription.write` for medicine items |
| GET | `/api/v1/ehr/note-templates[?kind=note\|visit][&includeRetired=true]` | anyone who writes notes | `ehr.note.write` |
| POST | `/api/v1/ehr/note-templates` | keepers | `ehr.order-set.manage` |
| PATCH | `/api/v1/ehr/note-templates/:templateId` | keepers | `ehr.order-set.manage` |
| POST | `/api/v1/ehr/patients/:patientId/encounters/:encounterId/visit-templates/:templateId/apply` | the clinician | `ehr.note.write`, plus the order permissions for its order set |
| GET | `/api/v1/ehr/me/favourites` | the staff member | any of `ehr.lab-request.write`, `ehr.prescription.write`, `ehr.diagnosis.write` |
| POST | `/api/v1/ehr/me/favourites` (saves the whole list) | the staff member | as above |

- `ehr.order-set.manage` is recommended for doctors and clinicians, not lab staff. Lab staff hold `ehr.lab-request.write` (`0006`), which is why the write permission alone is not enough. This is part of the open point on who keeps a facility's order sets (no decision yet, to be decided before this section is built). The new rows go into the role-matrix fixture (SX-1).
- Every create and both apply routes take a required `Idempotency-Key`. Updates take `expectedRowVersion`.
- Patient routes need `X-Purpose-Of-Use: direct-care`.

Order set:

```json
{
  "orderSetId": "uuid", "name": "Fever workup", "description": "Adult fever, first visit",
  "status": "active", "rowVersion": 3, "updatedAt": "2026-11-19T10:00:00.000Z",
  "items": [
    { "itemId": "uuid", "kind": "lab_test", "testCodeSystem": "HID-LAB", "testCode": "MP-RDT",
      "testDisplay": "Malaria rapid diagnostic test", "specimenTypeCode": "Blood", "priority": "routine" },
    { "itemId": "uuid", "kind": "medicine", "medicationDisplay": "Paracetamol", "strength": "500 mg",
      "doseForm": "tablet", "doseQuantity": 1000, "doseUnit": "mg", "routeCode": "oral",
      "frequency": "Every 8 hours", "instructions": "After food", "durationValue": 3, "durationUnit": "day" }
  ]
}
```

| Field | Limits |
|---|---|
| `name` | 1-120 characters. Unique among the facility's active sets, ignoring case. |
| `description` | optional, up to 500 characters |
| `items` | 1-30 entries |
| `lab_test` item | today's lab request fields and limits (R-2). No `status` and no `clinicalInformation`: those belong to the patient. |
| `medicine` item | today's prescription fields and limits (R-3, plus the seven 0125 fields while that setting is on). No `status`, `startsOn`, `endsOn` or `allergyAcknowledgement`. |
| per facility | at most 200 active sets and 200 active templates |

- Items are checked against the same rules as the create routes when the set is saved, so applying a set never fails validation.
- `PATCH` body: `{ "expectedRowVersion": 3, "name"?, "description"?, "items"? (the whole list), "status"?: "active" | "retired" }`. A retired set is hidden from the default list and cannot be applied. Nothing is ever deleted.

Apply an order set. Body: `{ "expectedOrderSetVersion": 3, "itemIds"?: ["uuid"] }`. `itemIds` picks some items; leave it out for all.

Answer `201`:

```json
{ "requestGroupId": "uuid or null",
  "labRequests": [ { "...": "draft lab request, as the create answer" } ],
  "prescriptions": [ { "...": "draft prescription, as the create answer, with duplicateMedicines (ORD-10)" } ] }
```

- Everything is written in one transaction, all as `draft`. Tests are linked by one `requestGroupId` once ORD-6 is live; before that the value is `null`.
- If the clinician lacks the permission for any chosen item, nothing is written.

Note and visit templates:

```json
{ "templateId": "uuid", "kind": "note", "name": "Antenatal visit", "noteType": "progress",
  "title": "Antenatal visit", "content": "Gestational age:\nFundal height:\n...", "status": "active", "rowVersion": 1 }
```

```json
{ "templateId": "uuid", "kind": "visit", "name": "Fever, first visit", "encounterType": "ambulatory",
  "noteTemplateId": "uuid or null", "orderSetId": "uuid or null",
  "complaintWords": ["Fever", "Headache"], "status": "active", "rowVersion": 1 }
```

| Field | Limits |
|---|---|
| `name` | 1-120 characters, unique per kind among the facility's active templates |
| `noteType` | 1-80 characters; `title` 1-240 characters (today's note limits, `clinical.dto.ts:190-209`) |
| `content` | 1-20,000 characters |
| `encounterType` | optional, one of today's `EncounterType` values |
| `complaintWords` | at most 10 entries, each 1-60 characters |
| visit template | must name a `noteTemplateId` or an `orderSetId`, or both, from the same facility |

- A note template is read only. The screen puts its text into the note form. No apply route is needed.
- Applying a visit template uses an existing visit. It never creates or starts one (use EHR-C1 or EHR-C5 for that). Body: `{ "expectedTemplateVersion": 1 }`.
- Answer `201`: `{ "clinicalNote": draft note or null, "requestGroupId", "labRequests", "prescriptions" }`. The note is `status: "draft"` with the template's `noteType`, `title` and `content`.

Favourites:

```json
{ "items": [
  { "kind": "lab_test", "testCodeSystem": "LOINC", "testCode": "718-7", "testDisplay": "Haemoglobin" },
  { "kind": "medicine", "medicationDisplay": "Amoxicillin", "strength": "500 mg", "doseForm": "capsule" },
  { "kind": "diagnosis", "codeSystem": "ICD-11", "code": "1F4Z", "display": "Malaria, unspecified" },
  { "kind": "order_set", "orderSetId": "uuid" }
] }
```

- At most 50 items. A save replaces the whole list.
- Item fields use the create routes' limits (R-1 for diagnoses).
- Diagnosis favourites take ICD-11 picks from the search list, and ICD-10 codes typed in are still accepted (owner decision Q124 A, 19 Nov 2026).
- A favourite fills the form. It never saves an order by itself.

Audit:
- Changes to sets and templates: `ehr.order-set.create` and `ehr.order-set.update`, `ehr.note-template.create` and `ehr.note-template.update`. These name no patient.
- Each apply: one `ehr.order-set.apply` or `ehr.visit-template.apply` row naming the patient, with the created ids. Each created record also gets today's create row.
- Reading sets, templates and favourites shows no patient and adds no patient audit row.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Names the field and the item. |
| 400 | `ORDER_SET_EMPTY` | Add at least one test or medicine. |
| 400 | `TEMPLATE_NEEDS_CONTENT` | A visit template needs a note template, an order set, or both. |
| 400 | `FAVOURITES_TOO_MANY` | You can keep up to 50 favourites. Remove one first. |
| 403 | `PERMISSION_DENIED` | As today. |
| 403 | `ORDER_SET_ITEMS_NOT_ALLOWED` | Your role can't order some items in this set. Choose only the items you can order. (`errors[]` lists the item ids.) |
| 403 | `CONSENT_REQUIRED` | As today. |
| 404 | `ORDER_SET_NOT_FOUND`, `TEMPLATE_NOT_FOUND` | This order set (or template) is not available at this facility. |
| 404 | `CLINICAL_RESOURCE_NOT_FOUND` | As today: the visit is not found. |
| 409 | `ORDER_SET_NAME_TAKEN` | This facility already has an order set (or template) with this name. |
| 409 | `ORDER_SET_RETIRED` | This order set is no longer in use. Choose another. |
| 409 | `VISIT_ENTERED_IN_ERROR`, `IDEMPOTENCY_KEY_REUSED` | As today. |
| 412 | `ORDER_SET_CHANGED` | Someone changed this order set (or template). Reload it and try again. |
| 503 | `ORDER_SETS_UNAVAILABLE` | Order sets and templates are not available yet. |

### Screen notes

- **Before this ships:** keep the built-in pick lists (Wave 0, R-1 to R-3). Do not offer order sets, templates or favourites, or store them on the device. Show "Order sets and templates are not available yet" where they will go.
- **After:**
  - Show "Apply" with a tick list of the set's items, all ticked.
  - After applying, show the drafts under "Drafts to check", each with its own Activate button, and the allergy and same-medicine warnings as today. Never present an applied set as "ordered".
  - A note template fills the note form. Today it creates nothing. Once server-saved consultation drafts (EHR-C6) ship, the template text goes into that draft (owner decision Q126 A, 19 Nov 2026).
  - Warn keepers not to put patient details in a template.

### Depends on

- ORD-6 (one group for the tests), ORD-7 (0144, catalogue picks; national list approved by Health ID's named clinical lead, owner decision Q124 A, 19 Nov 2026), ORD-9 (0145, diagnosis search; ICD-11 list with ICD-10 still accepted, owner decision Q124 A, 19 Nov 2026).
- EHR-C6 (0141, owner decision Q126 A, 19 Nov 2026).
- FR-1 and Q105, 0117 (allergy check), ORD-10 (duplicate warnings).
- 0136 and SX-1 for the new permission row.
- Open point, to be decided before this section is built: who keeps a facility's sets and templates.

### Target

Release C (lane C). Size **L**: three tables (sets, templates, favourites), ten routes, two apply paths over three record types, and a role-table row.

## ORD-11: Result and dispensed notices to the ordering doctor (planned, Release C, needs a migration: yes)

Akos items:
- P1-6 (new lab result, critical value, prescription dispensed; a results list with read and unread)

Status: planned, not live. Owner decision Q128 A, 19 Nov 2026: an in-app notice list first; critical results must be marked Seen.

Today staff see only access requests as notifications (Akos P1-6). Lab writes a `LabResultReleased` outbox event when a result is released (`lab-executions.service.ts:167`). Pharmacy has no dispensing event (`pharmacy.service.ts` writes only `PharmacyWorkItemCreated` and import events). Lab's README says there is no critical-result acknowledgement today (`services/lab-api/src/lab/README.md:38`).

Who gets a notice: only the person who placed the order (the lab request's or prescription's `createdBy` with `createdByMembershipId`), and only at the ordering facility. Nobody else sees it: not colleagues, admins or the patient.

When a notice is written:
- lab-api writes it in the same transaction as the result release.
- pharmacy-api writes it in the same transaction as the dispensing or reversal.

So no notice is lost, and no event bus is needed. This works for the hospital's own lab and pharmacy and for order routes to other facilities.

| `kind` | When | Needs Seen |
|---|---|---|
| `lab_result_ready` | a result for the order is released | no |
| `lab_result_critical` | the released version's `abnormalFlag` is `critical_candidate` (`lab-api/src/lab/dto/execution.dto.ts:31`) | **yes** (owner decision Q128 A, 19 Nov 2026) |
| `lab_result_corrected` | a correction to an already released result is released | no |
| `prescription_dispensed` | the first fill is dispensed (refills, ORD-12, do not notify) | no |
| `dispensing_reversed` | a dispensing is reversed | no |

- Each order keeps at most one unread notice per kind. A later event updates its time and count, for example "3 results ready".
- A critical notice is never merged with another notice.

### Routes

| Method | Path | Who | Permission |
|---|---|---|---|
| GET | `/api/v1/ehr/me/order-notices?state=unread\|all[&cursor=<noticeId>][&limit=1-50]` | the recipient, at the session facility | `ehr.lab-request.read` or `ehr.prescription.read` |
| GET | `/api/v1/ehr/me/order-notices/summary` | the recipient | as above |
| POST | `/api/v1/ehr/me/order-notices/read` | the recipient | as above |
| POST | `/api/v1/ehr/me/order-notices/:noticeId/seen` | the recipient | as above |

All routes take `X-Purpose-Of-Use: direct-care`. No Health ID appears in any path, body or answer. The only ids are UUIDs.

Notice:

```json
{
  "noticeId": "uuid", "kind": "lab_result_critical", "createdAt": "2026-11-19T10:42:00.000Z",
  "count": 1, "readAt": null, "needsSeen": true, "seenAt": null,
  "order": { "type": "lab_request", "id": "uuid", "encounterId": "uuid", "display": "Potassium" },
  "patient": { "patientId": "uuid", "fullName": "Amaka Okafor", "sex": "female",
               "dateOfBirth": "1990-05-01", "healthIdLast4": "AA22" },
  "accessEnded": false,
  "message": "Critical result: Potassium. Open it and mark it Seen."
}
```

- `patient` is the waiting-list card shape (EHR-C7). `order.display` is the test or medicine name.
- Both are given only while the recipient may still read the patient's records here. That is checked on each read with the same consent check as other EHR reads, including own-facility access (0131). Consent rules are unchanged.
- Otherwise `patient` and `order.display` are `null`, `accessEnded` is `true`, and the message is "A result is ready for a patient whose access has ended. Ask the patient for access to see it." For a critical notice it ends with ", or call the laboratory".
- No result value is ever in a notice. The clinician opens the result with today's reads, for example `GET /api/v1/lab/ehr-orders/:sourceEhrOrderId/released-results`.

List answer: `{ "items": [notice], "nextCursor": "uuid or null" }`, newest first, with critical notices that are not yet Seen always on top. `limit` defaults to 20.

Summary answer: `{ "unread": 4, "criticalNotSeen": 1 }`. It names no patient. Like the patient bell count (`patient-self.controller.ts:32`), it is not audited when it succeeds, because it is polled.

Mark read:
- Body `{ "noticeIds": ["uuid"] }`, 1-100 ids. Answer `{ "updated": n }`.
- Ids that are not the caller's are ignored and not counted.
- Reading does not clear `needsSeen`.

Mark Seen:
- Body `{}`. Answer: the notice with `seenAt` set.
- The recipient must be able to read the patient's records now, because Seen means they saw the result.
- Allowed on any notice. Required only for critical ones (owner decision Q128 A, 19 Nov 2026).
- Seen is final and is recorded with who and when.

Keeping: a notice is kept 90 days after it is read, and a critical notice 90 days after it is Seen. A critical notice that is not Seen is never removed (proposed).

Audit:
- Each list read: one `ehr.order-notice.list` row (count, patient ids shown) plus one `ehr.order-notice.list.shown` row per patient shown, as EHR-C7 does.
- Each read or Seen: `ehr.order-notice.read` or `ehr.order-notice.seen`, naming the patient.
- No test name, medicine or value goes in an audit row.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Names the field (for example, more than 100 ids). |
| 403 | `PERMISSION_DENIED` | As today. |
| 403 | `CONSENT_REQUIRED` | Ask the patient for access to see this result first. (Seen only.) |
| 404 | `ORDER_NOTICE_NOT_FOUND` | This notice is not available. (Also for someone else's notice.) |
| 503 | `ORDER_NOTICES_UNAVAILABLE` | Notices about your orders are not available yet. |

### Screen notes

- **Before this ships:**
  - Keep the bell for access requests only.
  - On the doctor's Home, show "Notices about your orders are not available yet. Check each order's progress." Link to each visit's order rows, which already show `ownProgress` (ORD-3): "Results ready 11:05", "Dispensed 11:05".
  - When MY-1 (0143, Release B) ships, use "Ordered by me" for this.
- **After:**
  - Poll `summary` and put it on the bell: "4 new, 1 critical".
  - The results list puts critical notices first, in red, with "Open result" and then "Mark as Seen". Seen stays disabled until the result has been opened on the page.
  - Unread and read: bold and plain.
  - When `accessEnded` is true, show the message and "Ask for access". Show no name.
- **Not in this package (each would be a later package):** sending to phone or email (the in-app list comes first, owner decision Q128 A, 19 Nov 2026), handing a notice to a colleague, and raising an alarm when a critical result is not Seen. Until then, the laboratory's phone call stays the safety net for critical results.

### Depends on

- ORD-3, ORD-2 (0133), order routes (sections 21-24), EHR-C7 (card shape), 0131 (own-facility access), MY-1 (0143) and ORD-12 (no refill notices).
- ID-8b (merge, owner decision Q127 A, 19 Nov 2026) must carry the notices table in its foreign-key coverage, so notices follow the kept record.
- Q128 A (owner decision, 19 Nov 2026).

### Target

Release C (lane D). Size **L**:
- writes from two services inside their own transactions (lab release and correction; pharmacy dispensing and reversal), including a new dispensing hook;
- one ehr table with a per-read consent filter;
- four routes;
- audit;
- a runtime check across Lab, Pharmacy and EHR.

# Not planned yet

## ORD-13: No drug-interaction checks (not planned, no release, needs a migration: no)

Akos items:
- P0-5 and N-9 (the interaction parts)

Status: not planned (owner decision Q131 A, 19 Nov 2026). The build plan (section 6) allows interaction data only from a licensed, maintained commercial database, never a hand-made list.

### Routes

None. The checks that exist or are planned instead:
- Allergy check at create, Activate, Resume, send and hand-off: 409 `ALLERGY_ACKNOWLEDGEMENT_REQUIRED` (0117, section 44). Live.
- Same-medicine warning: `POST /api/v1/ehr/patients/:patientId/duplicate-medicine-check` and `duplicateMedicines` on create (ORD-10 phase 1, live contract). It never blocks.
- Same-class warning (by ATC class): ORD-10 phase 2, alongside Release B.

### Errors

None.

### Screen notes

- Never show "No interactions found", a green tick, or anything that suggests interactions were checked.
- Above Save on the prescribe form, show a fixed line: "Drug interactions are not checked by Health ID. Check them in your usual reference."
- Show the allergy, same-medicine and (from Release B) same-class warnings as each answer gives them. Keep Save enabled for warnings, as today.

### Depends on

Q131 A (owner decision, 19 Nov 2026). A licensed interaction database and its contract would be a separate later package. Other countries come later too (Q131 A).

### Target

None.

## P2-1: National ID type per country and a neutral company number (not planned yet, after Release C, needs a migration: yes, when designed)

Akos items:
- P2-1

Status: not planned yet, not live. Nigeria only for now (owner decision Q131 A, 19 Nov 2026: "other countries later"). No route, field or migration is designed. The heading says "after Release C" because no release in A to C includes this work.

What to assume and hard-code today:
- **The only national ID is the NIN.** It is 11 digits (`^\d{11}$`, in `services/identity-api/src/identity/dto/resolve-nin.dto.ts`). It goes only in POST bodies (`POST /api/v1/identity/nin/resolve`, contract section 43.3). It never goes in a URL, a query string or a log line.
- **A patient with no NIN, including a foreigner,** is registered through `POST identity/registration-cases/without-nin` (Release A contract, ID-2) with `noNinReason` set to one of `nin_service_unavailable`, `no_nin`, `not_carried`, `child` or `foreign_national`. The screen shows "NIN Not Verified".
- **Do not collect passport or other ID numbers.** No field stores them. Do not put them in free-text fields either.
- **NIN status is shown with two labels only.** Show `ninStatus` (`verified` / `not_verified`, Release A ID-0) as "NIN Verified" or "NIN Not Verified". No other label is used.
- **The company number is the CAC number.** It is `cacRegistrationNumber` on `POST /api/v1/identity/provider-enrollments` (section 43.2, for example `RC1234567`; `BN`/`IT` prefixes are also used, see section 9 near line 879). It is checked by `POST /api/v1/identity/organizations/verification/cac/{hospital|laboratory|pharmacy}`. Label it "CAC registration number".
- **Facility addresses are Nigerian.** `stateCode` is ISO 3166-2:NG (section 43.5). `lga` is free text. GPS must be within latitude 4 to 14 and longitude 2.5 to 15 (section 43.1).

### Routes

None new. The existing ones above stay as they are.

### Errors

Existing; match on the code and not the text.

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | NIN not 11 digits, or another field rule broken |
| 422 | `NIN_VERIFICATION_FAILED` | "This NIN could not be verified. Check the number and try again." (owner Q117. The text live today is "The NIN could not be verified".) |
| 400 | `PHONE_REQUIRED`, `NOT_A_CHILD`, `REGISTRATION_WITHOUT_NIN_INVALID` | Registration without a NIN (Release A ID-2) |
| 400 | `FACILITY_PROFILE_INVALID` | "Check the facility details and try again" (section 43.2) |

### Screen notes

- Build the ID field as "NIN (11 digits)" and the company field as "CAC registration number".
- Keep each label in one constant so a later country setting can swap the wording without a redesign.
- Do not show an "ID type" picker or a passport option.
- For any patient without a NIN, use "Register without a NIN" and choose the reason. There is no limit per staff member or per facility on NIN checks (Q109).

### Depends on

Q131 A (other countries later, owner decision of 19 Nov 2026); the P2-6 data-residency answer; a future owner question on which ID types are allowed in each country.

### Target

Not in Releases A to C. Size when designed: M. It needs a country setting on the facility, an ID type on the identifier, a neutral `companyRegistrationNumber` kept as an alias of `cacRegistrationNumber`, and suite changes.

## P2-2: Interface translations and language (not planned yet, after Release C, needs a migration: yes, when designed)

Akos items:
- P2-2 (and the language part of P1-8)

Status: not planned yet, not live. Everything is English only (owner decision Q131 A, 19 Nov 2026). The build plan's default is "staff language is English only for now". SX-7 preferences (Release C) hold an English-only `language` field: its list (`languagesAvailable`) stays `["en"]`, and the screen keeps it hidden or read-only until P2-2 adds a second language.

What to assume and hard-code today:
- **Every API `detail` and `message` is plain English.** Show it as it arrives.
- **Branch on the stable `code`, never on the text.** The text may change (see the Q117 note in P2-1), and later translations will key off codes.
- **Layout is left to right only.** Do not build a language switcher.

### Routes

None new. P2-2 would widen SX-7's `languagesAvailable`; it adds no route of its own.

### Errors

None new.

### Screen notes

- Put interface text in one strings file now (English only), so that adding translation files later is mechanical.
- Do not offer a language choice in My profile or Settings. Once SX-7 ships, its language field may be shown read-only as "English"; offer a choice only when `languagesAvailable` has more than one entry.

### Depends on

Q131 A (19 Nov 2026); SX-7 (where the language preference sits).

### Target

Not in Releases A to C. Size when designed: L (strings across every site, the second language's list in SX-7, right-to-left checks).

## P2-3: Measurement units (not planned yet, after Release C, needs a migration: yes, when designed)

Akos items:
- P2-3

Status: not planned yet, not live. Metric only (owner decision Q131 A, 19 Nov 2026).

What to assume and hard-code today:
- **Units are metric, and each field name carries its unit.** The API takes and returns metric values only:

| Field | Unit | Server limits today |
|---|---|---|
| `heightCm` | cm | 20 to 300, up to 2 decimals |
| `weightKg` | kg | 0.2 to 700, up to 3 decimals |
| `temperatureC` | °C | 20 to 50, 1 decimal |
| `pulseBpm` | beats per minute | 10 to 350, whole number |
| `respiratoryRate` | breaths per minute | 1 to 100, whole number |
| `systolicMmhg` | mmHg | 30 to 350, whole number |
| `diastolicMmhg` | mmHg | 10 to 250, whole number |
| `oxygenSaturationPercent` | % | 0 to 100, up to 2 decimals |

Source: `VitalMeasurementsDto` in `services/ehr-api/src/ehr/shared/clinical.dto.ts`. The same names come back from `GET /ehr/patients/:patientId/vitals/latest` (Release A EHR-C3).

- **Outreach screening has its own, tighter limits** (section 48.2).

### Routes

None new.

### Errors

Existing:

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | A value outside the limits above (ehr-api `common/validation-pipe.ts`) |

### Screen notes

- Show the unit beside every input and value (°C, kg, cm, mmHg, %).
- Do not offer °F, lb or inches, and do not convert.
- Keep unit labels and any future conversion in one helper. When P2-3 ships, storage stays metric and only a per-facility display setting is added, so the helper is the only place that changes.

### Depends on

Q131 A (19 Nov 2026); P1-11 (VIT-1: physical-limit validation and soft warnings), which may tighten the limits above.

### Target

Not in Releases A to C. Size when designed: M (a facility setting and screen conversion; no stored data changes).

## P2-4: Time zone, date and phone formats (not planned yet, after Release C, needs a migration: yes, when designed)

Akos items:
- P2-4

Status: not planned yet, not live. "Today" is the calendar day in Lagos until P2-4 ships (owner decision Q131 A, 19 Nov 2026).

What to assume and hard-code today:
- **Timestamps:** the API sends and takes ISO-8601 UTC with `Z` (for example `recordedAt`, `X-HID-Captured-At`). Show them in Lagos time (`Africa/Lagos`, UTC+1, no daylight saving) whatever the device's own time zone is.
- **"Today" and calendar days are always Lagos days.** The server already works this way:
  - `GET /ehr/patients/:patientId/encounters/open-today` answers `"timeZone": "Africa/Lagos"` (Release A EHR-C1, `services/ehr-api/src/ehr/encounters/lagos-day.ts`).
  - A date of birth may not be after today in Lagos (ID-2).
  - Under-18 checks use the Lagos date (`RECORDS_PROCESSING_MINOR`).
  - OCR allowance months are Lagos months.
  - `checkInDay` is the Lagos day (Release A EHR-C7).
- **Never compute "today" from the device clock's zone.**
- **Calendar dates** (`dateOfBirth`, `startsOn`, `endsOn`, `day`) are `YYYY-MM-DD` with no time. Show them as they are and never pass them through a time-zone conversion (see the `calendar-date.ts` note in the order-routes section).
- **Phones:**
  - Accept what the person types. The server takes E.164 from any country, or a Nigerian `0` and 10 digits, and stores `+234…`. Spaces, dots, dashes and brackets are ignored (sections 43.1 and "International phones at sign-up").
  - Show the stored E.164 value, or the masked value the server returns.
  - Hint text: "like 08012345678 or +234 801 234 5678".

### Routes

None new.

### Errors

Existing:

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Phone refused: "Enter your phone number with its country code, like +44 7700 900123, or a Nigerian number like 08012345678." (patient sign-up). Also a date of birth after today in Lagos. |

### Screen notes

- Use one date helper with `timeZone: 'Africa/Lagos'` and a day-month-year display (for example "18 Nov 2026"), so that P2-4 only swaps the zone for the facility's setting.
- Write a test that runs the screens with the device set to a zone other than Lagos.

### Depends on

Q131 A (19 Nov 2026); P2-2 (locale display).

### Target

Not in Releases A to C. Size when designed: M (a facility time-zone and locale setting, and moving every server Lagos rule to the facility zone; phone storage is already E.164).

# QA tasks

## QA-2: Migrate account test pass and one real save of every drawer form (planned, before the Release A go-live, needs a migration: no)

Akos items:
- R-4 ("not tested against the real API: saving from inside a drawer")
- The open question "Lab, Pharmacy and Migrate accounts aren't tested yet"

Status: planned, not live. Who does it: the Health ID team, on staging, before go-live.

How:
- Use the sealed QA logins (section 52; QA-1 adds the pharmacist and lab memberships at QA Hospital, written on production and staging) and fictional QA patients only.
- Record one row per form: the form, the route, the HTTP answer, the correlation id, and pass or fail.
- Afterwards, mark completed test visits "entered in error" (Release A EHR-C8a).
- Confirm that the extra page read each time a drawer closes stays within the published per-route rate limits (plan R-4).

1. **Migrate account test pass.** Sign in as `migrate@healthidentitydirectory.com` (clinician at QA Hospital) on the staging Migrate site. Run every Migrate screen Akos's frontend uses, end to end. The site admits `ehr.encounter.write` and `organization.manage` only (section 53).
2. **One real save of each drawer form**, through the routes below.

### Routes

No new route. Each drawer saves through an existing one:

| Drawer | Route it saves through |
|---|---|
| New consultation | `POST /ehr/patients/:patientId/encounters` (EHR-C1) and `POST .../encounters/:encounterId/clinical-notes` (`clinical-notes.controller.ts`) |
| Record vitals | `POST .../encounters/:encounterId/vitals` (`vitals.controller.ts`) |
| Orders | `POST .../encounters/:encounterId/lab-requests` and `.../prescriptions` |
| Ask for access | `POST /api/v1/identity/access-requests` |
| Patient PIN | `POST /api/v1/identity/standard-access/pin` |
| Find a patient | `POST /api/v1/identity/patient-search` (Release A, 0132) |
| New registration | `POST /api/v1/identity/nin/resolve` (43.3) and `POST identity/registration-cases/without-nin` (ID-2) |
| Paper prescription | There is no route to type a paper prescription by hand. Paper prescriptions come in through OCR import: `POST /api/v1/pharmacy/imports/from-ocr` and `/imports/from-ocr/batch` (`pharmacy.controller.ts:63`, `:73`). Test the drawer against that route if it uses it; otherwise Akos names the route it calls before the test. |
| Receive stock | No matching route in staging `services/pharmacy-api/src`. Marked "cannot save yet" unless Akos names a route before the test. |

### Errors

None new. Each failed row records the code and correlation id the route answered.

### Screen notes

- On a failed row, Akos fixes the drawer (or the route call it makes) and the row is run again.
- A drawer with no route (Receive stock today) shows "This cannot be saved yet" and disables its Save button, rather than failing after the user has typed.
- Do not keep a drawer's typed content on the device to work around a failed save; the app stores nothing on the device.

### Depends on

Release A live on staging (0132, 0134, ID-2, EHR-C8a); QA-1 seeded on staging.

### Target

Before the Release A go-live. Size: S.
