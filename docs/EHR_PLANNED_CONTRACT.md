# HID planned contract for the rest of Akos's EHR list (Release B, C and D, not live)

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
| [REF-1: Referrals between facilities](#ref-1-referrals-between-facilities-planned-release-d-needs-a-migration-yes) | department Referrals between facilities (gap F1) | D | yes (0191-0193, provisional) | L |
| [ORD-13: No drug-interaction checks](#ord-13-no-drug-interaction-checks-not-planned-no-release-needs-a-migration-no) | P0-5, N-9 (interactions) | not planned | no | — |
| [P2-1: National ID type per country and a neutral company number](#p2-1-national-id-type-per-country-and-a-neutral-company-number-not-planned-yet-after-release-c-needs-a-migration-yes-when-designed) | P2-1 | after C | yes, when designed | M |
| [P2-2: Interface translations and language](#p2-2-interface-translations-and-language-not-planned-yet-after-release-c-needs-a-migration-yes-when-designed) | P2-2, P1-8 (language) | after C | yes, when designed | L |
| [P2-3: Measurement units](#p2-3-measurement-units-not-planned-yet-after-release-c-needs-a-migration-yes-when-designed) | P2-3 | after C | yes, when designed | M |
| [P2-4: Time zone, date and phone formats](#p2-4-time-zone-date-and-phone-formats-not-planned-yet-after-release-c-needs-a-migration-yes-when-designed) | P2-4 | after C | yes, when designed | M |
| [QA-2: Migrate account test pass and one real save of every drawer form](#qa-2-migrate-account-test-pass-and-one-real-save-of-every-drawer-form-planned-before-the-release-a-go-live-needs-a-migration-no) | R-4, QA question | before A go-live | no | S |

Owner answers of 19 Nov 2026, and the sections that rest on them: Q124 A (ORD-7, ORD-8, ORD-9, ORD-10 phase 2, ORD-6, VIT-1), Q125 B (ORD-4, now planned for Release B), Q126 A (EHR-C6, ORD-8), Q127 A (ID-8, ORD-11), Q128 A (ORD-11, SX-7), Q129 A (SX-4, CHW-1), Q130 A (CHW-1), Q131 A (ORD-12, ORD-13, ORD-10 phase 2, P2-1 to P2-4), Q132 A (Q132 A, now planned for Release B; ORD-4 refers to it). No owner question for the Release B and C sections is waiting for an answer. Release D sections rest on the owner's approval of the sprint decision sheet on 25 Nov 2026 (Q147 to Q290 at the recommended options; REF-1: Q149, Q151, Q154, Q155, Q157-Q162, Q168, Q181-Q183 and Q261-Q266), and mark any smaller choice built at its recommended option (REF-1: Q-REF-7 to Q-REF-15).

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
every read, as the waiting list does (EHR-C7). The progress lookups use
ORD-3's several-patient form (one call per kind for the page) and are
audited per patient as ORD-3's one-patient lookup is, except where that
form's 2-second limit applies: a patient not checked within it, or whose
refusal completes after it, is `unknown` with no `denied` row (Identity
keeps its own row of a refusal).

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

- ORD-3 (wave 1, on staging). Its internal progress call takes one
  `patientId` per call (ORD-3 section). Lane D adds ORD-3's several-patient
  form (decision 4: `.../progress/batch`, at most 50 patients and 100 ids in
  all, both progress headers); MY-1 makes one call per kind for its page,
  and against an image without that form one call per patient and kind,
  at most 6 at once for the page across both kinds with one
  `OwnProgressSlots` for the page (hence still the page limit of 50).
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

Build plan of 18 Nov 2026, migration number given at merge (0144 was
provisional; ORD-4 took it), lane D. Today there is no list route:
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

**`GET .../catalog/status`** tells the screen what is live. Before ORD-7's
migration ships it answers 404. ORD-9 and ORD-10 phase 2 fill their own fields.

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
`brand-names.ts` (its confirmed rows only: a brand still pending a
pharmacist's review is left out; second slice), and an item is always shown
under its generic name. Names
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

**Database (ORD-7's migration).**
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

- **Before ORD-7's migration ships** (the status route answers 404):
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
  - The owner's confirmation that the Nigeria Essential Medicines List, 8th
    edition ("All rights reserved"), may be used for its facts.
  - Both answers are recorded in the sign-off (second slice, `licences`).
- ORD-2 (0133) and order routes for the name-only send paths.
- SX-1 fixture for the new permission.

### First slice: the lists and their search (0149, draft, not live)

Built on 23 Nov 2026 (lane D) as the design note on hid-system#258 set
out. The number 0149 is provisional and is given in merge order after
Release B. Nothing is loaded: the lists stay empty until the clinical lead
signs a version (Q124 A) and the governed loader (a later slice) loads it.

- **Built:** `ehr.catalog_versions`, `ehr.catalog_medicines` and
  `ehr.catalog_lab_tests`, the two searches and the status, as above.
  `GET .../catalog/status`, `.../catalog/medicines` and
  `.../catalog/lab-tests` work as the tables above say, with these
  choices:
  - The fixed codes are the combined list's ids (hid-system#312):
    `MED-nnnnn` under `HID-MED`, and each test's LOINC or HID-LAB code.
  - `display` is the generic name with a capital first letter, then the
    strength, then the list's form words in lower case ("Amoxicillin 500
    mg capsule"). `genericName` is the list's INN as written (lower case).
  - `source` is the list's own value: `nigeria-eml-8`, `who-eml-24` or
    `hid-common-tests` (#312).
  - A lab test's `category` may also be `blood-bank`, `immunology` or
    `histopathology`, which the combined list uses (twelve values in all).
- **Fixed ids:** `ehr.catalog_retired_codes` keeps each id the loader
  drops, and insert triggers refuse a retired id, an id whose medicine
  (generic name, strength, dose form) or test (code system, code, name)
  differs from an earlier version's, and a lab code another id held. So a
  code is never changed or reused, in the database as well as in the seed
  file's test.
  - `atcCode` is always `null` until the WHOCC terms are settled, though
    the table can hold the code.
  - `attribution` is read from the active versions: each loaded version
    records the notices its sources require (at most 5). A list that is
    not available shows none.
  - A list is `available` only when its active version offers at least one
    item. `approvedAt` is the Lagos day of the sign-off, and `fileSha256`
    (an addition to the shape above) is the sha256 of the signed seed file
    the version was loaded from, so support can tell which list a clinician
    searched; both are `null` when the list is not available.
  - `listVersion` is `null` when nothing matched.
  - A search matches when each word of `q` starts a word of the generic
    name or of one other name. Words are split at anything that is not a
    letter or digit, in `q` and in the names alike (the index and the
    per-name checks use the search's own split), so "co-amox" finds
    co-amoxiclav, "E/U/Cr" finds electrolytes, and "MTB/RIF", "HIV 1/2",
    "COVID-19", "U/A" and "G&XM" find the tests named so. Only the first 6
    words count, each cut to 40 characters;
    `q` never reaches the query parser as typed, so brackets or operators
    answer nothing, never an error. Brand names come with the seed files
    (they are other names, the confirmed brands only; second slice).
  - The order: names that start with `q` first, then by name in the "C"
    collation, then strength and the list id, so it is the same on every
    load.
- **Immutability:** a loaded row never changes; a correction or a
  withdrawal is a new version. Triggers refuse UPDATE, DELETE and TRUNCATE
  on the two lists, and on a version anything but the loader's switch
  (`active`, `loaded_at`, and `sealed` from false to true). The loader
  switches the old version off, then the new one on, in one transaction
  under SHARE ROW EXCLUSIVE on the versions.
  - **Sealed versions:** a version is sealed when it goes live (an active
    version is always sealed) and stays sealed. The lists' insert triggers
    refuse a row for a sealed version (55000 `CATALOG_VERSION_SEALED`),
    reading the version row FOR SHARE so an insert and a switch wait for
    each other. So a live or replaced version never gains a row its signed
    file did not hold; only a version still loading takes rows.
  - Each version also records the sha256 of the approvals file that holds
    the lead's sign-off (`approvals_sha256`), which never changes, like the
    approval reference.
- **Refusals:** `q` missing or under 2 characters gives
  `CATALOG_SEARCH_TEXT_TOO_SHORT`. Characters are counted as the database
  counts them (code points), so an emoji alone is too short. `q` over 100
  characters, a bad `limit`,
  `doseForm` or `route`, or a parameter given twice or unknown gives
  `VALIDATION_FAILED`. `q` containing `HID-` and Health ID characters, a
  six-character word of the Health ID alphabet mixing letters and digits,
  or a run of 11 or more digits (spaces and hyphens ignored) gives
  `CATALOG_SEARCH_TEXT_NOT_ALLOWED`, before any search.
- **429:** 300 searches per 5 minutes per membership, counted in each
  ehr-api instance, not across instances. Refused texts do not count.
- **On a schema without 0149:** the status answers 404
  `CATALOG_NOT_AVAILABLE` ("The medicine and lab-test lists are not
  available yet."), so screens keep their built-in lists; the searches
  answer 503 `CATALOG_UNAVAILABLE`. Any other database failure is 503
  `CATALOG_UNAVAILABLE`, logged with its SQLSTATE only.
- **Caching and audit:** `Cache-Control: private, max-age=60` is set only
  on an answer; a refusal keeps `private, no-store`. Only refusals are
  audited (the method and route, never `q`).
- **Not in this slice:** facility items and `ehr.catalog.facility-item.write`,
  lab requests by name only (`labTestNameOnly` stays `false`), the
  loader and seed files (the loader records each id it drops in
  `ehr.catalog_retired_codes`, which is in this slice),
  `ehr.duplicate_class_rules`, and the screens.
- **Checks:** the database suite `catalog-search` (59 cases), the ehr-api
  spec (68 tests), and three steps in
  `verify-prescription-details-runtime.mjs`: before a list, with a list
  loaded by owner SQL (the doctor and the pharmacist search), and the
  refusals and the audit rows.

### Second slice: the seed files and the governed loader (draft, not live)

Built on 23 Nov 2026 (lane D), stacked on the first slice; Rahman's review
of hid-system#319 built in (five rounds). No migration and no route: three
scripts in `services/ehr-api/scripts`, the approvals file, and an opt-in
phase of the deploy tool. Nothing is loaded until the clinical lead signs a
file.

- **Seed files:** `catalog:build-seeds` turns the combined list (#312) into
  `hid-medicines.json` and `hid-lab-tests.json` (format
  `hid-catalog-seed/1`). The bytes are stable, so the sha256 the lead signs
  is reproducible, and `--check` fails on any drift. The builder prints what
  the lead signs with each file, opening with the record of Ola's brand
  decision (`brandDecision`, below): what was held back and why, how every
  Wave 0 code stands (kept ones included), every brand added (brand ->
  generic, on how many items) and every brand left out, with why. It reads
  `brand-names.ts` with Node's own TypeScript type stripping, so it needs
  Node 22.18 or later; on an older Node it stops first with a plain line
  naming the version it needs (exit 2, nothing built).
  - A row the database would refuse is **held back** with why (for example
    a strength over 80 characters, or a test with no code), never cut or
    guessed. The seed lists its held-back rows, so the lead signs with them
    in view.
  - Every gap in the ids must be a retired id with a reason, and no retired
    id may still be a row. A retired id whose row the builder holds back
    stops it with "MED-00002 is held back in this seed and also listed as
    retired; fix the row, do not retire it; nothing built" (exit 2, one
    line): retired, the row would be gone for good, though it only needs
    fixing.
  - Everything the builder reads is inside that one-line handling: a file
    that cannot be read or is not JSON, a broken CSV (an unclosed quote: "the
    combined list <file>: CSV: a quoted field is not closed; nothing built";
    a row with the wrong number of fields), any other list it cannot make
    into seeds, or a seed that would not load (an HID-LAB code that is not
    Wave 0's) stops it with one plain line, exit 2, nothing built. Both
    seeds are built and checked in memory first and written only when both
    are good, each under a temporary name and then renamed into place, so a
    bad lab-test list never leaves a new medicine file behind, and seeds
    already there stay as they were. A seed file it cannot write is one line
    too (exit 1).
  - **ATC codes:** `atcCode` is `null` in the seed unless the builder is run
    with `--with-atc`, which it refuses until a medicine sign-off of that
    version records the WHOCC terms answer (`licences.whoccAtc`).
  - **Brand names:** only the confirmed rows of `ocr-worker`'s
    `brand-names.ts` go into `otherNames`, so they are signed with the file
    (Ola's clinical decision, round 2 of #319). The file has two review
    statuses: `coordinator-curated` (the brands curated before the table,
    which the file keeps active) is the confirmed one; a row still
    `pending-pharmacist`, or of any other status, is left out. A confirmed
    brand is added only where its generic (compared without case, white
    space collapsed) is the generic name of exactly one medicine in the
    seed. A combination counts only when written as the seed writes it
    ("amoxicillin + clavulanic acid"). The brand then goes on every item
    (strength and form) of that medicine. Nothing is guessed: the builder's
    report lists every brand added and every brand left out with why
    (pending pharmacist review, or no medicine with exactly that generic
    name). When a pharmacist confirms a pending brand, it comes in with the
    next version the lead signs.
  - **Ola's check of the confirmed brands (23 Nov 2026):** the 21
    coordinator-curated brands now in the medicine seed (valium, phenergan,
    flagyl, amoxil, augmentin, septrin, rocephin, zinnat, coartem, fansidar,
    daraprim, panadol, norvasc, adalat, lasix, plasil, glucophage, ventolin,
    postinor, buscopan, voltaren) were checked by Ola as clinical owner and
    are confirmed. Brands pending a pharmacist's review stay out until a
    pharmacist confirms them. The rule above is unchanged, and so is the
    medicine seed built from #312's list (sha256
    `d6a08fe25ed63ab05ad8dfb7bddf6de022d1504188c787f73c514e50e09d3419`);
    the builder's report opens with this record (`brandDecision`), so the
    lead signs with it in view.
  - **Wave 0:** the lab-test seed reports each Wave 0 HID-LAB code as kept,
    renamed, recoded, held back (a row of that name with no code) or
    missing. An HID-LAB item whose code is not in
    `docs/codes/hid-lab-codes.json`, or is there with another name, is
    refused, so a Wave 0 code is never changed or reused.
  - The notices: LOINC's when a test has a LOINC code; the WHO Model List's
    citation (CC BY-NC-SA 3.0 IGO) when a medicine comes from it.
- **Sign-off:** `docs/codes/catalog-approvals.json` (format
  `hid-catalog-approvals/1`, empty until the lead signs). An entry names a
  file's kind, version and sha256, an approval reference and the time. A
  medicine entry also records the owner's licence answers under `licences`,
  each a reference to where the answer is kept: `nigeriaEml8` always, and
  `whoccAtc` for a file with ATC codes. It is added in a reviewed PR that
  records the sign-off; no personal names.
- **The loader,** `catalog:load --seed <file> [--dry-run]`, runs after the
  migrations, never inside one, as the schema owner. It refuses (exit 2,
  nothing written, one line ending "nothing loaded"):
  - before it connects: `--approvals` under `NODE_ENV=production` (only the
    deployed approvals file signs a load); a seed, approvals or Wave 0 file
    that cannot be read or is not JSON; a seed that breaks 0149's rules or
    Wave 0's; a seed that holds back an id and also lists it as retired
    ("MED-00002 is held back in this seed and also listed as retired; fix
    the row, do not retire it"; the load refuses it again before its first
    statement, so nothing is retired); a file whose sha256
    is not signed for its kind and version;
    a medicine sign-off without `licences.nigeriaEml8`, or a file with ATC
    codes whose sign-off lacks `licences.whoccAtc`;
  - in its transaction: a schema without 0149; a version already loaded;
    an id of the active version that the new seed drops without listing it
    in its retired ids with a reason; an id of the active version that the
    new seed holds back ("MED-00002 is in the live list but held back in
    this seed; fix the row, do not retire it");
  - a lock still busy after 5 seconds: "ehr.catalog_versions or another
    catalogue load stayed busy for 5 seconds; nothing loaded; run the
    release again at a quieter time";
  - 0149's own refusals, with the database's message: its insert triggers
    and the versions guard (SQLSTATE 55000: `CATALOG_ID_CHANGED`,
    `CATALOG_ID_RETIRED`, `CATALOG_VERSION_SEALED`) and its table checks
    (23514), for example "the database refused the load:
    CATALOG_ID_CHANGED: MED-00001 (55000); nothing loaded".

  Anything else is a failure: exit 1, also one line ending "nothing
  loaded", never a stack trace. That covers an error before it connects (a
  `DATABASE_HOST` that makes no address: "DATABASE_HOST does not make a
  database address: Invalid URL (ERR_INVALID_URL)"; a bad TLS setting), no
  database, and a connection dropped mid-load (a terminated backend, a
  failover): the loader listens for the client's `error` event, so a drop
  is never an unhandled one, and a load cut off before its commit leaves
  nothing ("terminating connection due to administrator command (57P01);
  nothing loaded").

  A drop once the load's COMMIT is sent is different: the version may have
  committed (a backend terminated while its commit waits for a synchronous
  standby has already committed locally), so the loader never says "nothing
  loaded" then. It tracks that COMMIT was sent; if the connection is lost,
  or a fatal error comes, before COMMIT's reply, it ends with its own exit
  code, 3, and one line: "load-catalog: the connection was lost during
  commit, so the load may have committed; ask for the same load again to
  settle it (it loads, or is refused as already loaded)". An ERROR reply to
  COMMIT means the load rolled back and stays a refusal or a failure, and a
  connection the client already knew was lost is never sent COMMIT, so both
  still end "nothing loaded".

  The loader's exit codes: 0 loaded (or a dry run rolled back), 1 a
  failure with nothing loaded, 2 a refusal with nothing loaded, 3 the
  connection lost during commit, outcome unknown.

  The database refuses a retired, changed or reused id on its own, and the
  whole load rolls back. In one transaction the loader takes its advisory
  lock and SHARE ROW EXCLUSIVE on the versions, records the new retired
  ids, inserts the version (with `approvals_sha256`, the approvals file's
  own sha256) and its rows, then turns the old version off and the new one
  on. `--dry-run`
  rolls back. It prints one line: what loaded, the seed's and the approvals
  file's sha256, and what it replaced.
- **Where it runs in production:** only in the migration image, which
  carries exactly the files the loader reads, by name, at `/app/docs/codes`
  where the loader looks: the approvals file, the Wave 0 codes
  (`hid-lab-codes.json`) and the two signed seed files. Nothing else under
  `docs/codes` ships (drafts never do); until the seed files are committed,
  their one-name pattern (`hid-medicines.jso[n]`) copies nothing.
  `verify-container-platform.mjs` checks that the image carries exactly
  those four and that no stage copies any other file from `docs/`, and a
  change to one of the four runs the build and verify gate as well as the
  staging preparation tests. A change under `docs/codes/` rebuilds the
  migration image. The deploy tool (`scripts/production_deployment.py`)
  has an opt-in catalogue phase:
  - It runs only when the release asks for it: a dispatch of "Production
    backend candidates" with `catalog_load` set to `medicine`, `lab_test`
    or both (`CATALOG_LOAD`; a push always deploys with `none`), in a
    release that carries the migration image. Any other value, a rollback,
    or a release without the migration image is refused before it starts,
    and so is a seed missing from the checkout (`CATALOG_SEED_MISSING`):
    the deploy job checks out the commit the image was built from, and the
    tool reads each asked seed's version and sha256 there.
  - It runs after the migration phase has succeeded (after the apply and the
    final plan, or after a plan that found nothing pending), before any
    service is updated: one Fargate task per seed on the migration task
    definition the release registered, its command
    `scripts/load-catalog.mjs --seed /app/docs/codes/<file>`.
  - A refusal (exit 2) stops the release (`CATALOG_LOAD_REFUSED`), and any
    other non-zero exit stops it too (`CATALOG_LOAD_FAILED`); either way the
    tool prints the loader's last line (its refusal or failure line, or
    whatever it printed last). The receipt records each load
    (`catalog_checks`: kind, `loaded`, version, the seed's and the approvals
    file's sha256, items, the version replaced). Each seed is its own
    transaction: if the lab tests are refused after the medicines loaded,
    the medicines stay loaded and the failed receipt names them.
  - A task that exits 0 has loaded its seed, so the tool names it as loaded
    at once (kind, version, the file's sha256, "evidence pending"), before
    it reads the task's log. The evidence line then replaces that entry; it
    must carry every field the receipt records (`replaced` too, `null` when
    nothing was replaced). If the line is missing or malformed, the entry
    says "evidence line missing" and the release fails with
    `CATALOG_LOAD_EVIDENCE_MISSING`. If the log cannot be read (CloudWatch
    throttling, or the lease check before the read), the entry says
    "evidence unreadable" and the release fails with that error (for
    example `AWS_ThrottlingException`). Either way the tool prints a line
    naming the seed as loaded, and the failed receipt, when the release can
    write one, names it.
  - A task that exits 3 may have loaded. The tool names the seed as
    "outcome unknown" at once (kind, version and the file's sha256 from the
    checkout), before it reads the task's log, and the release stops
    (`CATALOG_LOAD_OUTCOME_UNKNOWN`); the failed receipt names the seed so.
    The exit code is enough: a log that cannot be read (CloudWatch
    throttling, or the lease check before the read) or a line that never
    arrives changes neither the entry nor the error. The log only adds to
    what the tool prints: the loader's line, or `"log_error"` saying why it
    could not be read. The commit line under any other exit code (never
    expected) is treated the same way, the safe side.
  - **After a failure that follows a successful load** (a later seed
    refused, the evidence line missing, or the services failing after the
    catalogue phase), the operator dispatches the release again with
    `catalog_load` set to `none`. The loaded version stays loaded, and
    asking to load it again is refused ("medicine 2026.1 is already
    loaded"), so a re-dispatch that asks again cannot finish. The deploy
    tool prints this step with the failure
    (`"next": "dispatch the release again with catalog_load none"`). When
    the release ends unreconciled (the lease lost, or a rollback that could
    not be confirmed: no failed receipt, and the lease stays held), the step
    says to reconcile first: "reconcile this release first (it ended
    unreconciled and keeps the deployment lease), then dispatch the release
    again with catalog_load none". A seed that did not load is asked for on
    its own once its cause is fixed.
  - The catalogue phase stops at the first seed that does not end loaded
    with its evidence, so a seed asked for after it is never tried. The
    step names every such seed, in load order, so none asked for is
    dropped (`"catalog_not_tried"` lists them). After the medicines loaded
    without their evidence line, with the lab tests asked for too, the step
    is "dispatch the release again with catalog_load lab_test to load what
    this release did not try" rather than `none`.
  - **After a load whose outcome is unknown,** the operator dispatches the
    release again asking for that seed, which settles it: it loads, or it
    is refused as already loaded. The tool prints this step too
    (`"catalog_outcome_unknown"` names the seed, and `"next": "dispatch the
    release again with catalog_load medicine to settle it (it loads, or is
    refused as already loaded; once refused, dispatch again with
    catalog_load none)"`), after the reconcile-first step when the release
    ended unreconciled. A seed loaded before it is named under
    `catalog_loaded_before_failure` and not asked for again. A seed asked
    for after it was never tried, so the step asks for it too, after the
    unknown one: with `medicine,lab_test` asked for and the medicines'
    outcome unknown, "dispatch the release again with catalog_load
    medicine,lab_test to settle medicine and load lab_test (medicine loads,
    or is refused as already loaded; once refused, dispatch again with
    catalog_load lab_test)". The second half is needed because a refusal
    stops that release before the lab tests.
  - Not asked, the release runs exactly as before.
- **Before the first real load:**
  - #312's open points: the Wave 0 codes, the 13 uncoded tests and the four
    over-long fields. The builder shows each one until it is settled.
  - The owner's WHO licence answer (CC BY-NC-SA 3.0 IGO), before the WHO
    rows ship.
  - The owner's confirmation that the Nigeria EML 8th edition may be used,
    recorded in the sign-off as `licences.nigeriaEml8`; the loader refuses a
    medicine file without it.
  - The WHOCC terms answer, recorded as `licences.whoccAtc`, only if ATC
    codes are wanted; until then the seed is built without `--with-atc` and
    every `atcCode` is `null`.
  - The clinical lead's sign-off in `catalog-approvals.json`, and the seeds
    committed as `docs/codes/hid-medicines.json` and `hid-lab-tests.json`.
- **Proven** on a throwaway copy (NOBYPASSRLS schema owner) with #312's
  list as of 23 Nov and a synthetic approvals file recording both licence
  answers:
  - 1,616 medicines (4 held back, 4 retired) and 145 tests (13 held back)
    load. Of the 86 brands, the 23 confirmed ones are considered: 21 are
    added, onto 97 items, and ampiclox and piriton are left out (no
    medicine with exactly their generic name); the 63 pending a
    pharmacist's review are left out. Wave 0: WIDAL and EUCR kept (as
    LAB-0145 and LAB-0113), 9 recoded to LOINC, MP-SMEAR and HIV-SCREEN
    missing.
  - As the EHR runtime, every medicine name and other name typed exactly
    (1,713) finds its item, and so does every lab-test name and other name
    of two or more characters (529; "K" and "E" are under the search's
    2-character minimum). `panadol` finds the 8 paracetamol items and
    `augmentin` the 7 amoxicillin + clavulanic acid items; `lonart`,
    `ciprotab` and `clavulin` (pending) find nothing.
  - A 2026.2 that gives MED-00001 a strength is refused by 0149 ("the
    database refused the load: CATALOG_ID_CHANGED: MED-00001 (55000)"), and
    one that holds back MED-00002, live in 2026.1, is refused with "fix the
    row, do not retire it"; both exit 2, nothing written.
  - An unsigned file, `--approvals` under production, a malformed approvals
    file, a sign-off without the Nigeria EML confirmation, an ATC file
    without the WHOCC answer, a second load of a version, a held lock
    (refused after 5.07 s) and a version that drops the highest id
    (MED-01624) without retiring it are each refused with exit 2, nothing
    written. With MED-01624 retired with a reason, that version loads,
    replaces 2026.1 (kept) and records MED-01624 as retired.
  - Round 3 (same list, same seeds: medicine `d6a08fe2…`, lab tests
    `847040fb…`): the loader's backend terminated with
    `pg_terminate_backend` three times, while it waited on its advisory
    lock, on the versions table's lock and at the insert of the retired ids
    (another session holding each): each time exit 1 and the one line
    "terminating connection due to administrator command (57P01); nothing
    loaded", no 2026.2 row, nothing retired, no session left; the same
    2026.2 then loads. Round 2's loader, terminated the same way, ended with
    a 21-line "Unhandled 'error' event" trace.
  - A 2026.2 that holds back MED-00002 and also lists it as retired is
    refused (exit 2, before it connects), and MED-00002 is not retired.
    Round 2's loader loaded that file and retired MED-00002 for good. The
    builder, given MED-00002 in the retired ids while the list holds its row
    back, stops with one line (exit 2) and writes nothing. A `DATABASE_HOST`
    of "db host" ends with one line (exit 1).
  - Round 4: on a throwaway copy whose sessions commit synchronously and
    whose cluster names a synchronous standby that never connects, the
    loader's COMMIT of the medicine seed waits (wait event `SyncRep`), and
    `pg_terminate_backend` ends its backend there. PostgreSQL warns that
    the transaction has already committed locally, and medicine 2026.1 is
    loaded and active (1,616 items). The loader now ends with the commit
    line ("the connection was lost during commit, so the load may have
    committed; ...", exit 1); round 3's loader said "Connection terminated
    unexpectedly; nothing loaded". Asked for again, the load is refused as
    already loaded, which settles it. Terminated before its COMMIT (waiting
    on the versions table's lock), it still says "nothing loaded" and leaves
    nothing, and the same load then loads.
  - Round 4: #312's list with one more row whose quote is never closed
    stops the builder with one line (exit 2), and the signed seeds in the
    folder stay as they were; round 3's builder ended with a stack trace.
    The list with LAB-0001's code changed to an HID-LAB code that is not
    Wave 0's stops it with one line (exit 2) and writes neither seed; round
    3's builder wrote a new medicine file. The list itself still builds the
    same seeds (`d6a08fe2…`, `847040fb…`), and `--check` passes.
  - Round 5: the same commit proof (a backend terminated while its COMMIT
    waits in `SyncRep`, committed locally, medicine 2026.1 active with
    1,616 items) ends with the same line and exit 3; round 4's loader ended
    with it and exit 1, the code of a failure with nothing loaded, so the
    deploy tool needed the log to tell the two apart. Asked for again, the
    load is refused as already loaded (exit 2). Terminated before its
    COMMIT, the loader still ends with exit 1 and "nothing loaded" and
    leaves nothing, and the same load then loads.

### Target

Release B (number given at merge).

Size: **L**.
- Code: two searches, facility items, the name-only change across ehr-api,
  lab-api and order routes, and the loader.
- Data: curating strengths, forms, routes and ATC for several hundred
  medicines and LOINC for about 150 tests needs a pharmacist and a lab
  scientist working under the lead. The data is the longer part.

## ORD-9: Diagnosis search on ICD-11, recent diagnoses, and diagnoses by name only (planned, Release B, needs a migration: yes)

Akos items: P1-12, R-1, P2-5 (and P0-5's coding ask).

Status: planned, not live.

Build plan of 18 Nov 2026, migration number given at merge (0145 was provisional), lane D. This
section follows owner decision Q124 A, 19 Nov 2026: ICD-11 is the search list, and
ICD-10 codes typed in are still accepted.

Today a diagnosis must have a code (`clinical.dto.ts:304-307`,
`0004:181`). Any code system text is accepted unchecked (Wave 0 R-1, P2-5).
The route Akos suggested, `GET /api/v1/ehr/terminology/icd10`, does not
exist and will not be built (owner decision Q124 A, 19 Nov 2026).

### Routes

ehr-api `ehr/terminology/`. `X-Facility-Id` is required, and there is no
purpose header: neither route reads a patient's record or returns a patient
id (the recent list's `display` is the clinician's own text, which may name
a patient). `q` follows the ORD-7 rules: no Health ID or NIN shapes, never
logged.

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
content. A code typed exactly comes first, then an entry whose title or
one of our other names is `q` itself, then those whose title or other name
starts with `q`, then shorter titles.

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
  (upper-cased). As for an ICD-11 code, any run of characters that are
  neither letters nor digits is taken off both ends first, so "B50.9." and
  "(B50.9)" are B50.9. No ICD-10 title is shipped or looked up: we hold no
  ICD-10 licence (owner decision Q124 A, 19 Nov 2026).

**Recent diagnoses.** These are the caller's own last picks at this
facility, newest first. `limit` is 1-50, default 20.

```json
{ "items": [ { "codeSystem": "ICD-11", "code": "1F40",
  "display": "Malaria due to Plasmodium falciparum", "lastUsedAt": "2026-12-03T10:42:00.000Z",
  "useCount": 14 } ] }
```

- The list is kept in its own table (`ehr.clinician_recent_diagnoses`:
  membership, code system, code, display, last used, count), at most 200
  per membership, and the oldest drop off. It is a best-effort record,
  written in the same transaction as a diagnosis with a code this member
  saves, and a save may skip it while the diagnosis still saves: when
  another save of the same membership, or of a membership whose id has
  the same `hashtext` value (even at another facility), has recorded a
  pick in a transaction that is still open, or when the record fails (the
  second slice, below).
- It holds **no patient id**, so it stays usable after a grant ends. Its
  display is the clinician's own text, which may name a patient.
- Picks are kept as saved across an ICD-11 release switch: a code the new
  release dropped, or an old title, is still offered, with nothing marking
  it, until the `codeStatus` slice changes the read (the second slice,
  below, "Across an ICD-11 release switch").
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

**Database (number given at merge).**
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
| 400 | `CATALOG_SEARCH_TEXT_NOT_ALLOWED` | "Search by diagnosis name or code, and type a code with its dot (such as 2B6B.2Y). Do not type a Health ID or NIN here." (582 ICD-11 codes typed without their dot have a Health ID's shape, such as `2B6B2Y`) |
| 400 | `DIAGNOSIS_CODE_INCOMPLETE` | "Diagnosis code and its code system must be supplied together." |
| 400 | `VALIDATION_FAILED` | existing (a diagnosis with no code while the setting is off, unknown field, `null`, bad `limit`); also a `q` over 100 characters, or with a control character other than tab (U+0000 included: "q must not contain control characters"), before the database |
| 400 | `PURPOSE_OF_USE_REQUIRED`, `IDEMPOTENCY_KEY_REQUIRED` | existing, on the create route only |
| 403 | existing permission refusal; `CONSENT_REQUIRED` on create as today | — |
| 409 | `IDEMPOTENCY_KEY_REUSED` | existing |
| 429 | `CATALOG_SEARCH_LIMITED` | "Too many searches. Please wait a minute and try again." (shared with ORD-7's limit) |
| 503 | `CATALOG_UNAVAILABLE` | sent as "The service could not complete the request." (ORD-7's code, for a schema without the diagnosis list and for any database failure; every 5xx detail is replaced by that text, so a screen reads the status and the code, never the words. The service's own words, "Diagnosis search is not available right now.", give no advice and stay inside it) |

### Screen notes

- **Before its migration ships** (`catalog/status` gives `diagnoses.available: false`
  or answers 404):
  - Keep the built-in list of 57 with code system `ICD-10` and dotted codes
    (Wave 0 R-1).
  - A diagnosis must still have a code. Ask for one, or say it cannot be
    saved without one.
- **After it ships:**
  - Search the route as the clinician types (about 250 ms after typing
    stops).
  - Show the recent list when the field is empty, each pick's `display` as
    saved. After a release switch, until the `codeStatus` slice, that can
    be a dropped code or an old title, shown as saved with nothing marking
    it.
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
- ORD-7: the loader, the status route, the shared search limit.
- EHR-C4 and EHR-C5 (built in wave 1): their answers and bodies follow the
  nullable code.
- The patient-evidence change (lane D edits `patient-records/` only for the
  ICD-11 split, agreed with lane C as FR-1 was).

### First slice: the ICD-11 list and its search (0152, draft, not live)

Built on 23 Nov 2026 (lane D), on ORD-7's tables and loader (#318, #319), as
the design note on hid-system#258 (13:55 UTC) set out. The number 0152 is
provisional. Nothing is loaded until the clinical lead signs the release
file's seed in `docs/codes/catalog-approvals.json`.

- **Database (0152):** `ehr.catalog_versions` takes the kind `diagnosis`
  (ACCESS EXCLUSIVE on that small table, and in the same attempt ACCESS
  SHARE on ORD-7's two lists, whose status 0152 replaces; NOWAIT for at
  most 5 seconds, else 55P03 "0152: …", which a dry run retries).
  `ehr.catalog_diagnoses` holds one row per coded entry per release: code,
  WHO's title verbatim, our other names apart, chapter, and whether the
  entry is residual. It is append-only, and, as ORD-7's lists, a release
  that is or has been live takes no new entry (55000
  `CATALOG_VERSION_SEALED`): only a release still loading takes entries. A
  version of another kind (a medicine or lab-test list) takes none either
  (55000). The post-checks pin each trigger's events, that it has no WHEN
  condition, column list or arguments, and the sealed-release function's
  body.
  Instead of the planned `ehr.terminology_icd11`, the list shares ORD-7's
  versions, loader and sign-off. The loader takes 0152's refusals as it
  takes 0149's: a sealed release (55000) or a table check (23514) ends the
  load as a refusal (exit 2) with the database's message, and nothing is
  loaded.
- **The seed** `docs/codes/drafts/icd11-mms-2026-01.json` is built by
  `catalog:build-icd11-seed` from WHO's `SimpleTabulation-ICD-11-MMS-en.zip`
  (2026-01, sha256 `f1356588…`). That is the file
  `ocr-worker/src/reading/diagnosis-list.ts` checked its titles against,
  and all 134 of that list's titles come out the same. The seed's sha256
  is `3662b1d7…`.
  - It holds 17,255 entries. Extension codes and blocks are left out, and
    so are chapter 26 (traditional medicine conditions, 1,120) and section
    V (functioning, 130). Neither is a diagnosis a clinician picks here
    (Ola, clinical owner). The seed lists both with why.
  - Our other names are `DIAGNOSIS_SYNONYMS`' names for coded titles, a
    name in double quotes included ("parkinson's disease" for 8A00.0
    Parkinson disease, which the builder used to drop). Names pointing to
    a block (HTN, "MP+") are not loaded, as this section says.
  - A title with accented letters also has its plain-letter spelling as
    one of our other names, so a search typed without the accents finds
    it (Ola, clinical owner: the same names, in plain letters). The
    2026-01 release has 10: 2B02 Sezary syndrome; 4A43.2 Sjogren
    syndrome, 4A43.20 Primary, 4A43.21 Secondary and 4A43.22 Paediatric
    onset Sjogren syndrome, 4A43.2Y Other specified sjogren syndrome,
    4A43.2Z Sjogren syndrome, unspecified; 4A62 Behcet disease; 5C52.03
    Sjogren-Larsson syndrome; 8A45.42 Demyelination due to Sjogren
    disease. WHO's titles are unchanged.
  - 76 entries have an other name.
- **Search:** `GET /api/v1/ehr/terminology/diagnoses?q=&limit=` as above,
  with ORD-7's rules for `q` (6 words, never raw `to_tsquery`, no Health ID
  or NIN shapes, never logged) and its 429 and cache. Only the active
  release is read, through its own rows: a release kept after a newer one
  went live costs nothing.
  - The code matches too, whole or in parts ("1F40", "1f40.z").
  - Titles and our other names are split into words as `q` is (lower case,
    at anything that is not a letter or a digit), as ORD-7's lists are. So
    a title typed as written is found: `COVID-19`, `T-cell/histiocyte`,
    `glucose-6-phosphate`. Split by the default parser, 20 were not found
    at all, among them RA01 "COVID-19" and the other COVID-19 entries.
  - A word-final 's or ’s is dropped from `q` first, so a name typed with
    it finds the entry named: "Parkinson's disease" is 8A00.0 Parkinson
    disease, first; "Crohn's disease of large intestine" is DD70.3;
    "alzheimer's disease", "bell's palsy", "huntington's disease" and
    "wilson's disease" find theirs (before, the lone s had to start another
    word, so these found nothing). When nothing matched, the search runs
    once more with a final s dropped from each word of 4 or more letters
    ("parkinsons", "alzheimers"), and keeps only the entries where each
    word so shortened is a whole word of the title or of one of our other
    names. So "parkinsons" puts 8A00.0 Parkinson disease first, and "fits"
    finds nothing: fit only starts "Fitting or adjustment of ..." entries,
    which it used to offer. "gallstones" finds what "gallstone" finds.
  - The order: the entry whose code `q` is; then an entry whose title or
    one of our other names is `q` itself, as words ("ra" is FA20
    Rheumatoid arthritis, whose other name is ra, before shorter titles
    starting with ra; "urti" is CA07.0, "prom" JA89); then entries whose
    title or other name starts with `q`; then shorter titles. A title's
    own apostrophe-s is compared as `q`'s is.
  - With the 2026-01 release loaded, each of its 16,883 titles of 2 to 100
    characters, typed as written or in upper case, comes first. The 372
    longer ones, cut to 100 characters, are each in the first 25.
  - The code `q` is: `q` upper-cased and trimmed, with or without its dot
    ("9A03.0" or "9a030"), and found even without the dot. A code copied
    with punctuation around it is still that code: any run of characters
    that are neither letters nor digits is taken off both ends before its
    shape is tested ("NB91.", "NB91,", "(NB91)", "(NB91).", "NB91 .",
    ".NB91", "NB91,."); the code's own dot stays ("(9A03.0)." is 9A03.0).
    A code typed with spaces at its dot ("5C50 5", "5C50. 5", "5C50 .5")
    is that code too, when such a code exists; otherwise its words are
    searched as before. So a parent code such as 9A03 comes before its
    child codes, whose titles are shorter. With the 2026-01 release
    loaded, each of its 17,255 codes searched by itself comes first, in
    each of 16 forms: as written, without its dot, in lower case with and
    without the dot, with a full stop, a comma, a semicolon or a colon
    after it, in brackets, square brackets or double quotes, in brackets
    with a full stop after them, with a space and a full stop after it,
    with a full stop before it, and with spaces or no-break spaces around
    it; and each of its 12,913 dotted codes typed with spaces at the dot,
    in the three forms above. Typed without its dot, a code whose six
    characters have a Health ID's shape (582 codes, such as `2B6B2Y`) is
    refused as a Health ID would be, and the refusal says to type the dot;
    with its dot (`2B6B.2Y`) it is found.
  - `matchedName` is our other name when it is what matched, or when it
    starts with `q` and the title does not. So `q=falciparum` gives 1F40
    first, named "falciparum malaria", as the example above.
  - `typedIcd10` is filled for a `q` shaped like an ICD-10 code, with any
    punctuation around it taken off ("(B50.9)." is B50.9).
  - A `q` with a control character other than tab (U+0000 included) is 400
    `VALIDATION_FAILED` before the database, in all three catalogue
    searches.
  - A schema without 0152, or any database failure, answers 503
    `CATALOG_UNAVAILABLE`, sent as "The service could not complete the
    request." (as every 5xx; the service's own words, "Diagnosis search is
    not available right now.", stay inside it). The catalogue status fills
    `diagnoses: { available, release, fileSha256 }`.
  - Activate an ICD-11 release only once this slice's ehr-api is live: the
    0149-era ehr-api takes the status's diagnosis row for a lab-test row,
    so it would show WHO's notice while it says diagnoses are not
    available.
- **Measured** with the full release loaded on throwaway PostgreSQL 16
  (median of 25 calls inside the server, as the EHR runtime, from the
  sixth call on a connection, when the generic plan is in use; the
  host's 4 CPUs were shared, load average 2.3 to 2.8; this slice's
  search and the one it replaced were called in turn in one session):
  - The load takes under 1 s.
  - A word or a code takes 1–2 ms (`malaria` 1.5 ms, `9A03` 1.3 ms, `NB91`
    at limit 25 1.7 ms).
  - Two-letter `q` take longest: `di` (2,974 entries match) about 49 ms,
    `in` about 73 ms, and the broadest, `of` (6,715), about 115 ms at limit
    10 and 121 ms at 25, with single calls up to about 185 ms.
  - With a second release kept (2027-01 active and 2026-01 kept, as a new
    WHO release leaves the old one), the times are the same, because only
    the active release's rows are read: `of` 121 ms, `in` 74 ms, `di` 49
    ms, `NB91` 1.7 ms. Before, the search read both releases' rows from the
    sixth call on a connection: `of` 194 ms, `in` 119 ms, `di` 76 ms, `NB91`
    2.7 ms.
- **Not in this slice:** recent diagnoses (the next slice, below), and
  diagnoses by name only and `codeStatus`, which alter `ehr.diagnoses` and
  need a lock plan.

### Second slice, first part: recent diagnoses (0153, draft, not live)

Built on 23 Nov 2026 (lane D), on 0152 (#320), as the sizing note on
hid-system#258 (14:18 UTC) set out. The number 0153 is provisional. No
live table is altered.

- **Database (0153):** `ehr.clinician_recent_diagnoses` (membership,
  facility, code system, code, display, last used, count; key membership,
  code system and code). It has no foreign key, so no live table is locked,
  and no patient id. Row-level security is on with no policy and no grant:
  only two SECURITY DEFINER functions use it.
  - `ehr.record_recent_diagnosis(code system, code, display)` reads the
    session's actor, membership and facility (as ehr-api sets them) and
    records only for a membership holding `ehr.diagnosis.write` at that
    facility (`auth.membership_has_permission`), and nothing with no code.
    The same pick again updates its display, time and count. At most 200
    per membership; the oldest drop off. It never waits for another save:
    it first takes the membership's recording lock,
    `pg_try_advisory_xact_lock(7409, hashtext(membership id))` (class key
    7409 for this record only), held to the end of the save's transaction,
    and records nothing while another transaction holds it. No other code
    takes the two-key form: ehr-api's `allergy-reader.ts` takes the one-key
    form on `hashtext` of a text key, and every other advisory lock in the
    repository the one-key form on `hashtextextended` of a text key.
    PostgreSQL keeps the one-key and two-key key spaces apart, so class key
    7409 cannot collide with any of them. So two saves of one clinician
    cannot deadlock on their picks or on the 200-cap trim; the later one
    may skip its record. The lock is keyed on the hash of the membership
    id, not the id, so a save also skips its record while a save of
    another membership whose id has the same `hashtext` value holds it,
    even at another facility (0153's header says so too, lines 63-64:
    "two memberships whose ids share a hash only skip a record now and
    then"). The runtime verifier
    (`verify-prescription-details-runtime.mjs`) checks this with two
    sessions as the EHR runtime: while one save of the doctor's has
    recorded a pick and is still open (holding the recording lock and that
    pick's row), another, with `lock_timeout` 1500 ms, records the same
    pick and then a different one for the same membership; each must come
    back in under 500 ms, record nothing and raise nothing, and once the
    first commits both are kept. The database suite's case 1f only checks
    the function as written (the try-lock call and the early return).
  - `ehr.recent_diagnoses(limit)` gives the session's membership's picks at
    its facility, newest first, and none without the permission. 22023
    `RECENT_DIAGNOSES_INVALID` outside 1-50.
  - EXECUTE on both to the EHR runtime and the schema test runtime only.
- **Recording:** `DiagnosesService.createInTransaction` (the route's and
  EHR-C5's consultation's) calls the record after the insert, in a
  savepoint. It is a best-effort side record. What it guarantees is that
  the record never waits for another save of the same membership (the
  recording lock, above). It can still hold the save up: it reads the
  auth role tables (through `auth.membership_has_permission`), so a DDL
  lock on one of them can hold the save at the record up to ehr-api's
  statement timeout (15 s, `database.service.ts:289`), after which the
  error (57014) is rolled back to the savepoint like any other and the
  save goes on. Any failure of the record, a schema without 0153
  (42883), a deadlock (40P01) or a lock not available (55P03) included, is
  rolled back to the savepoint and the diagnosis saves as before, with a
  warning naming the SQLSTATE and the request's correlation id, as other
  ehr-api warnings do, and nothing of the patient or the member (none for
  42883). Only a serialization failure (40001) in a SERIALIZABLE
  transaction is passed on, so the whole transaction is run again; the
  diagnosis saves are READ COMMITTED. An idempotent replay records nothing.
- **Route:** `GET /api/v1/ehr/terminology/diagnoses/recent?limit=` as
  above. It takes `X-Facility-Id` and no purpose header, and needs
  `ehr.diagnosis.write`. The answer is never kept (the global
  `private, no-store`).
  - The read and its audit row (`ehr.terminology.recent-read`, details
    `{ resultCount }` only) commit in one transaction. A read whose audit
    row cannot be written is refused.
  - A schema without 0153, or any database failure, answers 503
    `CATALOG_UNAVAILABLE`, sent as "The service could not complete the
    request." (as every 5xx, as for the search; the service's own words,
    "Diagnosis search is not available right now.", the search's, give no
    advice and stay inside it: trying again does not help while 0153 is
    not there, and a name alone is not accepted yet). The screen reads the
    status and the code, and shows the empty field as before.
  - A refusal is audited by the interceptor, as for the search.
- **Across an ICD-11 release switch** (Rahman's re-review of #321, minor
  1; Ola, clinical owner, 24 Nov 2026): picks are kept as saved. The read
  (`0153:183-188`) does not look at the active release, and its answer
  carries no release or in-list field. So after a new release goes live,
  a code that release dropped, or a code under its old title, is still
  offered from the recent list with nothing marking it, and picking it
  again raises its count. A diagnosis saved from such a pick is stored as
  typed: a code not in the list is allowed by design (`not_in_list` once
  `codeStatus` is built). Meanwhile the screen shows each pick's
  `display` as saved, the old title included. 0153 is not changed for
  this.
  - **Booked:** the `codeStatus` slice, which alters `ehr.diagnoses`
    anyway, replaces the read, `ehr.recent_diagnoses`, so that it returns
    the active release's current title, with an in-list flag, or leaves
    dropped codes out, and the database suite gains a case for a release
    switch. That slice ships before any second ICD-11 release is loaded.
    - Returning the current title, or leaving dropped codes out, keeps the
      read's columns, so `create or replace` keeps its owner and grants
      and no grant is needed (one owner, the migration owner, owns the
      recent table, `ehr.catalog_versions` and `ehr.catalog_diagnoses`).
      The new definition restates SECURITY DEFINER and its `search_path`,
      which `create or replace` would otherwise drop.
    - An in-list flag is a new column, which `create or replace` refuses
      ("cannot change return type of existing function"). So the read is
      then dropped and made again, with EXECUTE granted again to the EHR
      runtime and the schema test runtime (in that migration and in
      `runtime-grants.sql`) and checked again by its post-checks, or the
      flag goes in a new function.
  - No second ICD-11 release can go live until the clinical lead signs a
    WHO update: nothing is loaded until the lead signs the release file's
    seed in `docs/codes/catalog-approvals.json` (the first slice, above;
    owner decision Q124 A, 19 Nov 2026).
- **0153's header** is left as it is: lines 16-17 still say the table
  "shows no patient", and lines 34-35 that the record "never fails or
  holds up a clinical save". This section says what holds: no patient
  id, a display that may name a patient, and a record that never waits
  for another save of the same membership. The header changes only if
  0153 changes for another reason (0153 is cleared to sign at sha256
  `45faa6a7…`).
- **Not in this slice:** diagnoses by name only and `codeStatus` (with
  the recent read's change for a release switch, above).


### Target

a release after Release B (number given at merge).

Size: **M**: one search table and loader input, the recent table, the
nullable code, and the sensitive-list split. The ICD-11 sensitive ranges
need the lead's review.

## ORD-10 phase 2: Same-class medicine warning by ATC (planned, Release B, needs a migration: no)

Akos items: N-9 (N-9c), P0-5.

Status: planned, not live.

This builds on ORD-10 phase 1, built in wave 1 (live contract,
"ORD-10 phase 1"). It is code shipped alongside Release B. It needs no
migration of its own: it uses ORD-7's `ehr.catalog_medicines.atc_code` and
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

- ORD-7: ATC on formulary items, the rules table and the loader.
- ORD-10 phase 1 (built in wave 1).
- Q131 A (owner decision, 19 Nov 2026): same-medicine and same-class
  warnings only, no interaction checks now.
- Q124 A (owner decision, 19 Nov 2026): Health ID's named clinical lead approves
  the class rules.
- The ATC licence question in ORD-7. Without ATC codes this package has
  nothing to compare.

### Target

Release B, code alongside ORD-7's migration.

Size: **S** for code. The clinical lead's first class-rule file is the real
work.

## ORD-4: Pharmacy accepts a prescription before dispensing (planned, Release B, needs a migration: yes)

Akos items:
- N-1 (the "Accepted" status)
- N-8 (the pharmacy part of "accepted by"; the laboratory keeps "Sample taken" as its first visible step, see Screen notes)

Status: planned, not live. Built in #<PR, to come> (migration 0144, provisional); live when Release B is signed. The contract as built is the section "ORD-4. The pharmacist accepts a prescription before dispensing" in [INTERFACE_CONTRACT.md](INTERFACE_CONTRACT.md), and this section is corrected to match the build (the ORD-4 build spec of 20 Nov 2026). Owner decision Q125 B, 19 Nov 2026: the pharmacy "Accepted" step is wanted.

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

**Database** (migration 0144, number provisional, given in merge order at the Release B cut-off; needs 0001-0137):
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

Today (Release A, 0133, and ORD-4, 0144) a change made after the pharmacy dispensed an item reaches no pharmacy screen. The item stays dispensed (`pharmacyStep: "dispensed"`, ORD-4), and `withdrawn` is never set on a dispensed item (ORD-2). The records that exist are not enough for a notice:

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

Not changed: the dispensing and its reversal, ORD-4's Accept, the order-route routes, the progress call (ORD-3) and its two headers, and ehr-api's code and its own answers (it passes the hand-off's replay through unchanged).

**Work item answers** (the list and a read) gain, on a dispensed item whose prescription changed afterwards **(coordinator decision 1, 20 Nov 2026)**, the field below. A replay of `accept-ehr-prescription` answers it too, but that is not a path the notice takes in practice: any change after the dispensing raises the prescription's version, which the replay's digest covers, so a hand-off after a change answers 409 `IDEMPOTENCY_CONFLICT` before the notice is read; only `@hid/api-client`'s single immediate retry of the same request could meet one.

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

**Items from another facility: a stated limit.** The notice shows only while the pharmacy may read the item: its route allows reads until 14 days after the dispensing, and never more than 45 days after acceptance. Entering the prescription in error after the dispensing ends that access at once. So a pharmacist with no consent grant of their own never sees "entered in error" on such an item: the item leaves their list, a read answers 409 `ORDER_ROUTE_CLOSED` "This prescription from another facility is closed: stop work on it", and the patient is told (`ORDER_ROUTE_CANCELLED`, 0086). A member with a consent grant of their own still sees the item and the notice. Changing this needs a change to 0086's route rules, which Release B does not make.

**The list's order (unchanged).** A dispensed item keeps its place in the done work, ordered by the day it was received, and leaves the list 90 days after that day (Q123 A). A change does not move it up or bring it back. A read by its id still answers it, with the notice.

**The prescriber's side (unchanged)** **(coordinator decision 1, 20 Nov 2026)**. `ownProgress` stays `dispensed` (or `dispensing_reversed`). The progress call, its headers and ehr-api's prescription answers are unchanged, and the PATCH answers no `pharmacyHandoff`, as today. No notice and no outbox event is sent (ORD-11 notifies dispensings and reversals only).

**Database** (migration 0148, number provisional, given in merge order; built on Release B, where 0144 is live; it needs 0001-0137, and 0138-0146 changed nothing it pins or reads):
- One trigger on `ehr.prescriptions`, `prescriptions_pharmacy_change_after_dispensing`: AFTER UPDATE, for each row, only when the prescription was active or on hold before the change, in origin mode (as 0133 D8's). Its function (SECURITY DEFINER, run as the owner, executed by no role) never refuses the change it follows. It reads only 0133's claims (row-level security on and not forced, so the owner is never filtered) and writes one row per prescription version for each dispensed item of the prescription, with the time taken when it runs. Its name sorts after `prescriptions_order_routes_sync` (0086) and D8's trigger, so it runs after the route sync has waited for a dispensing in flight. The migration checks that no trigger on the table sorts after it.
- One table, `pharmacy.prescription_changes_after_dispensing`: the work item, its facility, the prescription version, the status before and after, a SHA-256 fingerprint of the prescription's content before and after, and the time. No actor, no reason, no field value, no prescription id. Key (`work_item_id`, `prescription_version`). Rows are never updated or deleted. Row-level security on, not forced, no policy, no grant: the owner's only, like 0133's claims. The fingerprint is the prescription row without its status, version and two times, so it names no column. A later migration that adds a column with a value in every row adds that column to the fields the fingerprint leaves out, or the first resume after it reads `edited`. A later type change that changes a column's text in the fingerprint (`numeric(12,4)` to `numeric(14,6)` turns `1.0000` into `1.000000`), or a rename or drop of a column that holds values, also makes the first resume after it read `edited` (the safe side).
- One reader, `pharmacy.work_item_changes_after_dispensing(uuid[])` (SECURITY DEFINER, STABLE, at most 200 ids, else 22023 `WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID`): the labels above, only for items the session may read (`pharmacy.work_items`' two read policies, repeated as conditions, so a superuser owner and production's owner answer alike). EXECUTE for `hid_pharmacy_runtime` and `hid_schema_test_runtime`, here and in `runtime-grants.sql`. The labels are set by the reader from the recorded facts, so a later change to the rules applies to rows already recorded, and an edit made during a hold can show at the resume.
- No change to 0133 or 0144, to `pharmacy.work_items`, or to `ehr.prescriptions`' columns, policies or row-level security. No 0148 function body names `ehr.prescriptions`, so 0133's list of owner-run readers of prescriptions stays as it is.
- Locks: ACCESS SHARE on the tables the migration reads (the work items, 0133's claims, and the account, staff, membership, role, permission, facility and organization tables its post-check probe of the reader opens) and their indexes, then, last, SHARE ROW EXCLUSIVE on `ehr.prescriptions` until commit (what CREATE TRIGGER needs). While it is held, every prescription create and change waits until the migration commits; reads, `FOR UPDATE` and the dispensing's `FOR SHARE` do not, and nothing fails. NOWAIT, tried again every 100 ms for at most 50 attempts (5 to 5.5 seconds), and nothing after that waits for a lock; an autovacuum or ANALYZE of `ehr.prescriptions` that is still running after the last attempt stops the file, nothing applied. On Release B with 20,000 prescriptions, work items and claims the file took 32 to 60 ms to commit, of which the hold was 15 to 31 ms, in ten runs with each kind of applier (on the earlier base, 0001-0137 and 0144: 44 to 78 ms and 20 to 26 ms). A post-check probe that meets a busy table stops the file in the same busy wording as the lock step, so the runner's dry run retries it. No backfill.
- Undo by hand only, in the order the migration's header gives: the trigger first, then the reader, the trigger function and the table. Dropping the trigger takes ACCESS EXCLUSIVE on `ehr.prescriptions`, so it is run under a short `lock_timeout` and repeated, or the trigger is disabled first (SHARE ROW EXCLUSIVE) and dropped later. Dropping the table while the trigger stands would make every change of an active or held prescription fail. 0148's undo comes before any step of 0133's undo and does not depend on 0144's.
- Release B images (the live ones) work unchanged on this schema: ehr-api's changes fire the trigger, which cannot refuse them and costs one index probe when nothing was dispensed; Release B's pharmacy-api calls nothing of 0148.

**Rollout.** Either image may be deployed, or rolled back, first, and no header is needed. The list and the read are browser calls and the field is optional, and ehr-api only passes the hand-off's replay through; today's pharmacy-api never calls 0148's reader; the new pharmacy-api answers no notice on a database without 0148; ehr-api does not change. Release B's `@hid/api-client` builds the item from the fields it knows and drops this one.

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
- **Items from another facility through `@hid/api-client`:** the client accepts such items, without the ids they never carry and with their `orderRoute` card, since `2a9aa2f3` (in Release B), so "by <ordering facility>" can be shown through the client. pharmacy-api's client contract spec pins a route-backed notice.

### Depends on

- ORD-2 (0133: D8's trigger is the model; D14's claims say when an item was dispensed; D2's own-work basis), ORD-4 (0144; the step stays `dispensed`).
- 0101 (a dispensing holds the prescription until it commits); sections 21-24 and 0086 (order routes, their access windows and the route sync); Q123 A (the list's window and order).
- Q132 A (owner decision, 19 Nov 2026); coordinator decision 1 (20 Nov 2026).
- ORD-12 (refills, 0152, provisional): "after dispensing" means after the first fill. 0133's claim records the first fill only and refuses a second today (`not_claimed`), so ORD-12 replaces that claim function and keeps the first fill's time. Its refills column: a NOT NULL or defaulted refills column must be left out of the fingerprint; a nullable one needs nothing. ORD-12 adds `refills_allowed` as a nullable column, so the trigger function stays as it is. After any change, 0101's version check refuses the next refill; ORD-12 says what a refill after a change means. 0148 merges first, or is pinned again.
- ORD-11 (no notice for a change), MY-1 (unchanged).

### Target

Release B (lane D). Size **M**:
- one trigger on `ehr.prescriptions`, one table and one reader;
- the list, read and replay field in pharmacy-api, and the type and parser in `@hid/api-client`;
- tests: a database suite for 0148 (every label, both owner kinds, visibility equal to `pharmacy.work_items`', the undo order, and removal cases that each fail when one clause is taken out), 0133's suite's undo case with 0148 undone first, steps in `services/ehr-api/scripts/verify-own-facility-work-runtime.mjs` (an edit and then a hold after the dispensing show on the pharmacist's list, and a second dispensed item that did not change shows nothing; a hand-off item held before any dispensing is not flagged withdrawn; a hand-off item dispensed by a pharmacist without a consent grant and then cancelled shows `cancelled`; a change racing a dispensing is recorded once) and in `services/ehr-api/scripts/verify-order-routes-runtime.mjs` (the outside pharmacy sees `on_hold` with the ordering hospital's name, and an unchanged dispensed item of the same patient on the same list shows nothing; the same race through the route).

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

- A code is required until ORD-7 makes it optional. Use the HID-LAB codes (Wave 0, R-2) for tests with no LOINC code. Once ORD-7 ships, a test may name a catalogue item instead; that shape is ORD-7's.
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
- ORD-7 (Release B) for catalogue picks and name-only tests. Its national list is kept by Health ID's named clinical lead (owner decision Q124 A, 19 Nov 2026).
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

- ORD-6 (one group for the tests), ORD-7 (number given at merge, catalogue picks; national list approved by Health ID's named clinical lead, owner decision Q124 A, 19 Nov 2026), ORD-9 (number given at merge, diagnosis search; ICD-11 list with ICD-10 still accepted, owner decision Q124 A, 19 Nov 2026).
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

# Release D

Release D holds the department first versions of the two-week sprint the owner approved on 25 Nov 2026: every department ships a first working version on Akos's blue design, anything that needs outside approval is built but switched off, every change gets an independent agent review and Rahman's final database check, and real patients use it only after the clinical lead's checklist and the owner's go-live.

This Release D holds the roadmap's department releases, whichever phase they come from (REF-1 below is the Phase 5 referrals department, built early in sprint wave 3). It is not the separate release the ID-8 section mentions for ID-8b, which would take another name if it is needed.

Decisions in Release D sections are marked **(recommended option, not yet answered by the owner)**. The section is built with that option. The owner can still choose the other option; the PR that builds it says which lines change.

On 25 Nov 2026 the owner approved the whole decision sheet (hid-system#332), verbatim: "I approve Q147–Q290 at the recommended options". A line that rests on one of those answers is marked **(owner decision Qnnn A, 25 Nov 2026)**. The owner can still change any of them; the PR that rebuilds it says which lines change.

## REF-1: Referrals between facilities (planned, Release D, needs a migration: yes)

Department: Referrals between facilities (gap map item F1 "cross-facility referrals", health `docs/HEALTH_ID_COMPLETE_FRONTEND_GAP_MAP.md:77`). Roadmap Phase 5, built in sprint wave 3; the printed letter moves to Phase 2 (owner decision Q162 A, 25 Nov 2026), which the switches below allow.

Status: planned, not live. To be built on `claude/sprint-referrals-backend` (migrations 0191-0193, provisional, unsigned; routes in ehr-api and identity-api; `docs/INTERFACE_CONTRACT.md` REF-1). Not live until signed and switched on.

Surveyed before writing (health origin/main b44b0d56; hid-system staging 0cfddcc9, migrations 0001-0153):
- The design is a sample only: the "Referral Network" workspace, `clinical/sample/definitions.ts:233-245` and `frame/sample/catalog.ts:950-990`. Fields Destination facility, Referral reason, Urgency, Selected clinical summary and Consent scope. Statuses draft -> "Send simulated referral" -> sent -> "Simulate recipient acceptance" (Recipient response) -> accepted -> "Complete referral" (Outcome) -> completed. One fictional seed row (`clinical/sample/seed.ts:261-264`, "Fictional Partner Clinic", scope "This summary only").
- Navigation and roles: `frame/pages.ts:103`, `clinical/pages.ts:42` (group "Network & Services", icon "share"), `frame/TopBarParts.tsx:163`, `frame/sampleAccess.ts:43` and `onboarding/roleTemplates.ts:38` (a Medical Director "approve" grant).
- Entry from a visit: `clinical/consult/orders/index.tsx:125,157-163` ("New referral", demo facilities only) and `clinical/consult/EncounterPage.tsx:708`. `docs/BLUE_EHR_PARITY_2026-11-01.md:527` warns that a real doctor can still type the sample's address.
- Live parts to reuse: the cross-facility sending UI `clinical/consult/orders/Routing.tsx` (destination search, attestation, status, withdraw) and `staff/components/OrderDestinationPicker`.
- Backend today: no referral table, route or access code. The nearest working pattern is orders between facilities (P4c, 0086 sections 6.1-6.7 and 0088-0091; `docs/INTERFACE_CONTRACT.md` sections 21-24). The encounter type list has no `referral` value, and none is added. Outreach screening records "Referred" and "Referred to" as free text (0118); that stays as it is and is not part of REF-1.

### What staff get

- **Send a referral from a signed visit.** A doctor or clinician refers the patient from a visit whose note is signed. The referral goes either:
  - to a **facility on Health ID** that is listed to receive referrals, found with the same directory search as orders between facilities; or
  - as a **printed letter** for a facility that is not on Health ID. It is recorded as "Printed, outside Health ID" and nothing is sent anywhere (owner decision Q263 A, 25 Nov 2026).
- **What a referral says.** Required: the reason, the urgency (routine or urgent only, owner decision Q266 A, 25 Nov 2026), the department wanted (one of the 15 facility department codes), and the letter text. Optional: the service or clinic wanted, in the clinician's words.
- **The package.** The clinician ticks which current diagnoses, current medicines, recorded allergies, recent vital signs and released lab results go with it. The server copies what was ticked when the referral is sent, and the copy never changes afterwards (the frozen package).
- **Patient agreement.** The clinician confirms that the patient agreed, with a versioned agreement text, as for orders between facilities (owner decision Q262 A, 25 Nov 2026). There is no approval step before sending (owner decision Q264 A, 25 Nov 2026).
- **Withdraw.** The referring facility can withdraw a referral until it is accepted. A printed letter can be withdrawn too (the record says the letter should not be used).
- **Incoming referrals** (the receiving facility's doctors and clinicians). A list of referrals waiting for an answer, with enough to decide but no name or chart content. **Accept** (with an optional note to the referrer) or **Decline** with a reason and a note.
- **Accepting gives read access to the frozen package only**, until 14 days after completion (owner decision Q261 A, 25 Nov 2026). It never opens the chart.
- **Expected arrivals** (the receiving facility's front desk, clinicians and doctors). Accepted referrals not yet arrived. **Patient arrived** checks the patient into the waiting list (EHR-C7, 0135), after a fresh patient search.
- **Complete with outcome.** The receiving clinician records the outcome and a short feedback note, which goes back to the referring facility (the counter-referral).
- **Status and outcome at the referring facility,** on the visit, on the patient page and in a "Sent referrals" list.
- **Printable letter,** for a printed referral and as a patient copy of any referral.
- **Support lookup** by reference, like support's lookup of orders between facilities, and support's switch to list or unlist a facility for referrals.

Not in this release: emergency transfers with an ambulance (they wait for the Emergency and Ambulance departments, owner decision Q266 A), booking the appointment at the receiving facility (Appointments, a follow-up), access to the full chart for the receiver (owner decision Q261 A), referrals to a named consultant, a Medical Director approval step (owner decision Q264 A; there is no such role, owner decision Q155 A), recording a paper reply to a printed letter (it can be scanned in as a document as today), linking ED-1's and ADT-1's "referred out" to a referral record (a follow-up), support closing an accepted referral early (the control below is the lever until then), staff notices (they come with ORD-11's staff inbox, owner decision Q151 A, 25 Nov 2026), shared or dependant records in the portal, and offline use (online only, with today's paper referral letter as the back-up, owner decision Q161 A, 25 Nov 2026).

### Decisions this section is built on

The owner's answers (25 Nov 2026), each at the recommended option:

| Question | Built as |
|---|---|
| Q261 What the receiving facility reads (Q-REF-1) | **A:** only the package the clinician selected, until completion plus a fixed window. No chart grant |
| Q262 Patient agreement (Q-REF-2) | **A:** the clinician records that the patient agreed; the patient is told in the portal and can withdraw before acceptance |
| Q263 Destinations (Q-REF-3) | **A:** Health ID facilities listed for referrals, plus a printed letter for any other facility |
| Q264 Approval before sending (Q-REF-4) | **A:** none; the treating doctor or clinician sends |
| Q265 On/off switch (Q-REF-5) | **A:** its own control, `cross_facility_referrals_enabled`, seeded off. Lab and pharmacy orders between facilities are untouched |
| Q266 Urgency (Q-REF-6) | **A:** routine and urgent only |
| Q149 Department switch | **A:** when facility setup (gap map F2) ships, the facility's own `referrals` switch must also be on |
| Q151 Staff notices | **A:** none in this release; referrals join ORD-11's staff inbox when it ships |
| Q154 Contract first | **A:** this section, before the build PR |
| Q155 Roles | **A:** no new role; no Medical Director |
| Q157, Q158 Clinical review | **A:** the clinical lead signs the clinical content below; Ola's medicine item is countersigned by the clinical lead |
| Q159 DPO review | **A:** the DPO pack below goes out this week |
| Q160 Go-live gate | **A:** see "Go-live gate" below |
| Q161 Offline | **A:** online only; the paper letter is the back-up |
| Q162 Build order | **A:** the printed letter can go live in Phase 2, before referrals between Health ID facilities |
| Q168 Check-in from a booking | **A:** the same principle for arrivals: a fresh, audited search; the referral never grants access (Q-REF-9) |
| Q181, Q182, Q183 Time, dates, phones | **Q181 A, Q182 A, Q183 B** (Q183's recommended option is B): Lagos time on every screen; "18 Nov 2026" and the 24-hour clock; Nigerian numbers as 0803 123 4567, foreign ones international |

Smaller choices made while writing this section:

| Question | Built with | The other option |
|---|---|---|
| Q-REF-7 A patient with no Health ID app account | **A:** a referral to a Health ID facility needs the patient's active account, as orders between facilities do (0086 V12), so the patient is told and can withdraw. Otherwise the clinician prints a letter **(recommended option, not yet answered by the owner)** | B: allow it on the clinician's attestation alone; the patient cannot see or withdraw it |
| Q-REF-8 What the receiver sees before accepting | **A:** the reason, department and service wanted, urgency, the referring facility and clinician, and the patient's sex and age in whole years. No name, date of birth, Health ID, letter or package **(recommended option, not yet answered by the owner)** | B: nothing about the patient, as the order-route preview |
| Q-REF-9 Arrival check-in | **A:** a fresh direct-care staff search (0132) that names the referral's patient, or a patient who is already this facility's own (0131), then 0135's own check-in. The referral is never a check-in basis and never opens the chart (as Q168 A) **(recommended option, not yet answered by the owner)** | B: the accepted referral is a check-in-only basis, as APPT-1's Q-APPT-6 A |
| Q-REF-10 Time windows | **A:** answer by 7 days (routine) or 24 hours (urgent); arrival within 90 days of acceptance; the package can be read until 14 days after completion, and never more than 120 days after acceptance. Drafts for the clinical lead and the DPO **(recommended option, not yet answered by the owner)** | B: the order-route windows (7 days to answer, 30 to work, 14 after completion, 45 at most) |
| Q-REF-11 Department wanted | **A:** one of the 15 facility department codes (0114, section 43.6) plus an optional free-text service (2-120 characters). No new specialty list **(recommended option, not yet answered by the owner)** | B: a new specialty list, drafted for the clinical lead's sign-off |
| Q-REF-12 What the patient sees | **A:** destination, status and dates, urgency, department and service, the reason, the agreement text, and which kinds of details were shared, with counts. Not the letter or the items **(recommended option, not yet answered by the owner)** | B: also the letter text and the items |
| Q-REF-13 The Health ID on a printed letter | **A:** not printed. The letter carries the name, sex, date of birth and the referral reference **(recommended option, not yet answered by the owner)** | B: the full Health ID |
| Q-REF-14 The receiving front desk | **A:** the front desk sees expected arrivals (name, sex, date of birth, last 4 characters of the Health ID, referring facility, department, urgency), never the reason, letter or package **(recommended option, not yet answered by the owner)** | B: no list; the desk searches and the server finds the referral |
| Q-REF-15 What the control stops | **A:** with `cross_facility_referrals_enabled` off: no new referral to a Health ID facility, no acceptance, no arrival, and no package read by the receiver. Decline, withdraw and complete still work, so nothing is stuck. Printed letters need only the service flag, so they can go live first (Q162 A) **(recommended option, not yet answered by the owner)** | B: the control also stops printed letters |

### How a referral moves

| State | Meaning | Next |
|---|---|---|
| `printed` | a printed letter for a facility outside Health ID | `withdrawn` (by the referring facility) |
| `sent` | waiting for the receiving facility's answer, until `respondBy` | `accepted`, `declined`, `withdrawn` (referring facility or patient) |
| `accepted` | the receiver reads the package; the patient is expected by `arriveBy` | `arrived`, `completed` (outcome "did not attend" only) |
| `arrived` | on the receiving facility's waiting list | `completed` |
| `completed` | outcome and feedback note recorded | none |
| `declined`, `withdrawn` | closed | none |

`effectiveState` adds two states that are computed when read and never stored:
- `expired`: a `sent` referral past `respondBy` (`endedKind` `not_answered`), or an `accepted` referral past `arriveBy` (`endedKind` `not_arrived`). The receiver's read ends.
- `withdrawn` with `endedKind` `visit_entered_in_error`: the referral's visit was marked entered in error (EHR-C8a) after sending. The receiver's read ends at once. The patient's portal keeps the record of the disclosure but shows no content, as order routes do for an order entered in error.

An item of the package whose source was marked entered in error after sending (a diagnosis, allergy, vital-sign reading or lab result) is answered as `enteredInErrorSinceSent: true` with no content.

### Routes

All routes are under `/api/v1`. Staff routes need `X-Facility-Id` and `X-Purpose-Of-Use: direct-care` (anything else: 403 `REFERRAL_NOT_ALLOWED`). Every staff write needs an `Idempotency-Key`; a replay with the same body answers the first answer with `"replayed": true`, another body 409 `IDEMPOTENCY_KEY_REUSED`.

No Health ID or NIN appears in any path or query. Patients are named by UUID, referrals by UUID and by an 8-character `reference` (from the referral's id, as order routes), new arrivals by a search card's `matchRef`. Support's lookup by Health ID is a POST body.

**Switches, all off in production until the go-live gate:**
- The service flag `REFERRALS_ENABLED` (ehr-api and identity-api). Off: every route below answers 503 `REFERRALS_NOT_AVAILABLE` (support's routes 18-20 excepted). A database without 0191 (or, for routes 7-17, without 0192) answers the same.
- The database control `cross_facility_referrals_enabled` (owner decision Q265 A), seeded off, switched by support's audited control command as the other controls. Off: routes 2 (to a Health ID facility), 6, 11 and 14 answer 423 `CROSS_FACILITY_REFERRALS_UNAVAILABLE`, and route 7 answers the receiving side at view level `metadata` (Q-REF-15 A).
- When facility setup (Q149, gap map F2) ships, the facility's own `referrals` switch must also be on.
- Both are on in staging and at the sealed demo and QA facilities.

**The referral card** (every staff answer):

```json
{ "referralId": "uuid", "reference": "3F2A9C1B", "side": "sent", "viewLevel": "full",
  "patient": { "patientId": "uuid", "fullName": "Ngozi Referone", "sex": "female", "dateOfBirth": "1979-04-02",
               "dateOfBirthEstimated": false, "healthIdLast4": "RF21", "sexAtSend": "female", "ageYearsAtSend": 47 },
  "destinationKind": "health_id",
  "referringFacility": { "facilityId": "uuid", "name": "Fictional General Hospital" },
  "receivingFacility": { "facilityId": "uuid", "name": "Fictional Teaching Hospital" },
  "printedFacility": null,
  "encounterId": "uuid", "departmentCode": "cardiology", "serviceWanted": "Cardiology clinic",
  "urgency": "routine", "reason": "New heart murmur with breathlessness on exertion",
  "referrer": { "name": "Dr Ada Example", "licence": { "body": "MDCN", "number": "MDCN/12345" }, "membershipId": "uuid" },
  "state": "accepted", "effectiveState": "accepted", "endedKind": null,
  "sentAt": "2026-12-03T09:10:00.000Z", "respondBy": "2026-12-10T09:10:00.000Z",
  "acceptedAt": "2026-12-04T08:00:00.000Z", "acceptNote": "Please come to the Tuesday clinic.",
  "arriveBy": "2027-03-04T08:00:00.000Z", "arrivedAt": null, "visitQueueEntryId": null,
  "decline": null, "withdrawal": null, "outcome": null, "completedAt": null, "endedAt": null,
  "accessEndsAt": "2027-04-03T08:00:00.000Z",
  "packageSummary": [{ "kind": "diagnoses", "count": 2 }, { "kind": "medicines", "count": 3 }],
  "rowVersion": 2 }
```

- `side`: `sent` (this facility referred) or `received` (this facility was asked).
- `viewLevel`, for `received` only (`sent` is always `full`):
  - `preview`: `sent`, before `respondBy`, control on. `patient` holds only `sexAtSend` and `ageYearsAtSend` (Q-REF-8 A). `encounterId`, `referrer.membershipId` and `packageSummary` are `null`.
  - `full`: effective state `accepted`, `arrived` or `completed`, before `accessEndsAt`, control on. The patient card as above, with `encounterId` and `referrer.membershipId` `null` (another facility's ids).
  - `metadata`: anything else. Reference, both facilities, department, urgency, states and dates only; `patient`, `reason`, `acceptNote`, `decline.note` and `outcome.feedbackNote` are `null`.
- `destinationKind`: `health_id` or `printed`. For `printed`, `receivingFacility` is `null` and `printedFacility` is `{ "name", "town" }`.
- `departmentCode`: section 43.6 codes. `urgency`: `routine` or `urgent`.
- `referrer`: the sending clinician as frozen at sending. `licence` is the newest MDCN licence attestation of the sender's doctor role at that facility (as order routes), or `null` ("Licence not on record").
- `decline`: `null` or `{ "reasonCode", "note", "declinedAt" }`. `reasonCode`: `service_not_offered`, `no_capacity`, `more_information_needed`, `better_elsewhere` or `other`.
- `withdrawal`: `null` or `{ "by": "referring_facility" | "patient", "reasonCode", "note", "withdrawnAt" }`. `reasonCode`: `patient_changed_mind`, `no_longer_needed`, `sent_in_error` or `other` (`null` for the patient).
- `outcome`: `null` or `{ "code", "feedbackNote", "completedAt" }`. `code`: `seen_care_returned` (seen; care goes back to the referring clinician), `seen_care_continues` (seen; care continues here), `admitted`, `referred_onward` or `did_not_attend`.
- `endedKind`: `null`, `not_answered`, `not_arrived` or `visit_entered_in_error`.
- `accessEndsAt`: when the receiver's read of the package ends; `null` before acceptance and for `printed`.
- `packageSummary`: the kinds sent and how many of each (`diagnoses`, `medicines`, `allergies`, `vitals`, `labResults`).
- Staff names of this facility come from the staff names list (SX-9), as on the waiting list. The other facility's clinician is named only by the frozen `referrer.name`.

**The package** (routes 2, 5 and 7, when answered):

```json
{ "frozenAt": "2026-12-03T09:10:00.000Z", "letterText": "Dear colleague, …",
  "sections": {
    "diagnoses": [{ "itemId": "uuid", "enteredInErrorSinceSent": false,
      "content": { "codeSystem": "ICD-11", "code": "MC81", "display": "…", "clinicalStatus": "active",
                   "verificationStatus": "provisional", "onsetAt": null, "recordedAt": "…" } }],
    "medicines": [{ "itemId": "uuid", "enteredInErrorSinceSent": false,
      "content": { "medicationDisplay": "…", "medicationCodeSystem": null, "medicationCode": null, "doseQuantity": "5",
                   "doseUnit": "mg", "routeCode": "oral", "frequency": "…", "instructions": "…", "startsOn": "2026-11-20",
                   "endsOn": null, "status": "active", "prescribedAt": "…" } }],
    "allergies": [{ "itemId": "uuid", "enteredInErrorSinceSent": false,
      "content": { "substance": "…", "reaction": "…", "severity": "severe", "recordedOn": "…", "recordedAtReferringFacility": true } }],
    "vitals": [{ "itemId": "uuid", "enteredInErrorSinceSent": false,
      "content": { "recordedAt": "…", "measures": { "pulseBpm": 96, "systolicMmhg": 150, "diastolicMmhg": 95 } } }],
    "labResults": [{ "itemId": "uuid", "enteredInErrorSinceSent": false,
      "content": { "testName": "…", "testCodeSystem": "HID-LAB", "testCode": "…", "resultType": "numeric",
                   "value": "13.2", "unit": "g/dL", "referenceRange": "12-16", "abnormalFlag": "normal", "releasedAt": "…" } }] } }
```

The content is built by the server from the source rows when the referral is sent, never from the request body. Medicines carry no dispensing progress; lab results carry the released version only.

#### The referring facility

**1. `GET /ehr/referral-attestation?destinationKind=health_id|printed`**: the current agreement text to confirm. `ehr.referral.send`. Answer `{ "version": "referral-health-id-attestation-v1", "text": "I confirm that {patient} agreed …" }`. The screen fills `{patient}`, `{referringFacility}` and `{receivingFacility}` (for a printed letter, the typed facility name).

**2. `POST /ehr/patients/:patientId/encounters/:encounterId/referrals`**: send. `ehr.referral.send` and `ehr.encounter.write`, and the patient's write access as for any visit change (`ehr.context_allows(patient, facility, 'write_records')`: a PIN, an approval or 0131's own-facility opening).

```json
{ "destination": { "kind": "health_id", "facilityId": "uuid" },
  "departmentCode": "cardiology", "serviceWanted": "Cardiology clinic", "urgency": "routine",
  "reason": "New heart murmur with breathlessness on exertion", "letterText": "Dear colleague, …",
  "package": { "diagnosisIds": ["uuid"], "prescriptionIds": ["uuid"], "allergyIds": [], "vitalIds": ["uuid"],
               "labResultIds": ["uuid"] },
  "attestationTextVersion": "referral-health-id-attestation-v1", "patientAgreed": true }
```

| Field | Rule |
|---|---|
| `destination` | `{ "kind": "health_id", "facilityId" }`: a facility the directory finds now (route 6: active, verified, reviewed or governed, a hospital or clinic, listed for referrals, with a member who may receive them, same seal as this facility, not this facility). Or `{ "kind": "printed", "facilityName": 2-120, "town": 0-120 }` |
| `departmentCode` | required, one of the 15 section 43.6 codes |
| `serviceWanted` | optional, 2-120 characters, trimmed, no control characters |
| `urgency` | required, `routine` or `urgent` |
| `reason` | required, 8-300 characters, trimmed, no control characters. The screen says: "A short reason the receiving facility sees before accepting. Do not write the patient's name." |
| `letterText` | required, 20-8000 characters; line breaks allowed, no other control characters |
| `package` | each list optional, unique ids. At most 30 diagnoses, 30 medicines, 30 allergies, 10 vital-sign readings and 20 lab results |
| `attestationTextVersion` | the current version for the destination kind (route 1). An older one: 409 `REFERRAL_ATTESTATION_OUTDATED` |
| `patientAgreed` | must be `true` (400 `REFERRAL_ATTESTATION_REQUIRED`) |

Checks, in this order: the caller; the flag, and for `health_id` also the control; the visit (this patient's, at this facility, `in_progress` or `completed`, not imported paper records, with at least one signed or amended note; 409 `REFERRAL_VISIT_NOT_SIGNED` otherwise); the patient (active, not merged, not an unknown record (ID-7), the facility's seal allows them; 409 `REFERRAL_PATIENT_NOT_IDENTIFIED` for an unknown record); for `health_id` also the patient's active account (Q-REF-7 A, 409 `REFERRAL_PATIENT_APP_REQUIRED`), no deny directive of the patient covering the destination (0086's `identity.patient_denies_order_route`, 409 `REFERRAL_PATIENT_DENIED`), the destination (409 `REFERRAL_DESTINATION_UNAVAILABLE`) and its open-referral limit (409 `REFERRAL_DESTINATION_BUSY`); the limits (50 sends per member per Lagos day, 429 `REFERRAL_SEND_LIMITED`; 5 referrals per visit, 409 `REFERRAL_VISIT_LIMIT`); then each package item.

Package items the server accepts (anything else: 400 `REFERRAL_PACKAGE_INVALID`, the same for every reason):
- **diagnoses**: this patient's, recorded at this facility, `active`, `recurrence` or `relapse`, not `refuted` or `entered_in_error`, in a visit not entered in error (the chart summary's `problems` rule, EHR-C4);
- **medicines**: this patient's prescriptions at this facility, `active` or `on_hold`, not ended before today (Lagos), not in a visit entered in error (the chart summary's `medications` rule);
- **allergies**: this patient's recorded allergies (0117), `active`, from any facility, as the chart shows them;
- **vital signs**: this patient's readings at this facility in the last 30 days, `recorded` (not entered in error, 0142), with their current corrected values;
- **lab results**: released results of lab requests made at this facility for this patient (this facility's own laboratory, or another one through an order route), the newest released version, not entered in error.

Answer `201 { "referral": card, "package": package, "replayed": false }`. A `health_id` referral is `sent` with `respondBy` = sent + 168 hours (routine) or + 24 hours (urgent). A `printed` one is `printed` with no `respondBy`. The patient's inbox gets `REFERRAL_SENT`.

**3. `GET /ehr/referrals/sent[?state=sent,printed,accepted,arrived,completed,declined,withdrawn,expired][&limit=1..200][&cursor=]`**: this facility's sent referrals, sent in the last 90 days, newest first. `ehr.referral.read`. Answer `{ "items": [card], "nextCursor": null }`. Cards here leave out `reason`, `acceptNote`, `decline.note` and `outcome.feedbackNote`; route 7 answers them (to the sender, or a member with the patient's read access).

**4. `POST /ehr/referrals/:referralId/withdraw`**: `{ "expectedRowVersion", "reasonCode", "note"? }`. `ehr.referral.send`, at the referring facility. Only while `sent` (before `respondBy`) or `printed`. `note` 8-500 characters, required for `sent_in_error` and `other`. Answer `{ "referral": card, "replayed": false }`. The patient's inbox gets `REFERRAL_WITHDRAWN`.

**5. `GET /ehr/referrals/:referralId/letter`**: the printable letter. `ehr.referral.send`, at the referring facility, by the sender or a member with the patient's read access. Any state but `withdrawn`. Answer `{ "referral": card, "package": package, "letter": { "referringFacilityAddress", "printedAt" } }`. Each call is one print (audited). The letter shows the patient's name, sex and date of birth and the reference, never the Health ID (Q-REF-13 A). For a `health_id` referral it is headed "Patient copy".

**6. `GET /identity/order-destinations?kind=referral&query=`** (identity-api): the directory search, extended with the kind `referral`. `ehr.referral.send`; the control on (423 otherwise). The same answer as for laboratories and pharmacies, at most 10 facilities, plus `departments` (the facility profile's department codes, informational, possibly empty): `{ "items": [{ "facilityId", "facilityName", "organizationName", "registeredAddress", "newOnHealthId", "departments": ["cardiology"] }] }`. Searches count against the same 60 an hour as the other kinds (429 `ORDER_DESTINATION_SEARCH_LIMITED`).

#### Both facilities

**7. `GET /ehr/referrals/:referralId`**: one referral. `ehr.referral.read` (referring side) or `ehr.referral.receive` (receiving side). Answer `{ "referral": card, "package": package | null, "packageHidden": null | "chart_access_needed" | "not_accepted" | "access_ended", "history": [{ "kind", "at", "side", "byMembershipId", "reasonCode" }] }`.
- Referring side: the package to the sender, or to a member with the patient's read access; otherwise `null` with `chart_access_needed`.
- Receiving side: the package only at view level `full`; otherwise `null` with `not_accepted` or `access_ended`.
- `history` `kind`: `sent`, `printed`, `withdrawn`, `patient_withdrew`, `accepted`, `declined`, `arrived`, `completed`. `byMembershipId` only for this facility's own members. Each answer that holds the package writes `ehr.referral.package-read`.

**8. `GET /ehr/patients/:patientId/referrals[?encounterId=]`**: this patient's referrals sent from or received at this facility, newest first, at most 100: the visit page (with `encounterId`) and the patient page. `ehr.referral.read`, and the patient's read access (`ehr.context_allows(patient, facility, 'read_records')`; 403 `CONSENT_REQUIRED` otherwise). Received ones are listed only once accepted. Answer `{ "items": [card] }`, no package.

#### The receiving facility

**9. `GET /ehr/referrals/incoming`**: referrals sent here and waiting for an answer (before `respondBy`), urgent first, then oldest first, at most 200. `ehr.referral.receive`. Cards at view level `preview` (control on) or `metadata` (control off). Answer `{ "items": [card], "counts": { "waiting": 4, "urgent": 1 }, "hasMore": false, "limit": 200 }`.

**10. `GET /ehr/referrals/received[?state=accepted,arrived,completed,declined,withdrawn,expired][&limit=1..200][&cursor=]`**: referrals this facility answered in the last 90 days, newest first. `ehr.referral.receive`. Answer `{ "items": [card], "nextCursor": null }`.

**11. `POST /ehr/referrals/:referralId/accept`**: `{ "expectedRowVersion", "note"? (0-500) }`. `ehr.referral.receive`. Only while `sent`, before `respondBy`; the control on; the patient's deny directives checked again (409 `REFERRAL_PATIENT_DENIED`); the referring facility still active and verified. Sets `arriveBy` = acceptance + 90 days and `accessEndsAt` = acceptance + 120 days. Answer `{ "referral": card, "package": package, "replayed": false }`. The patient's inbox gets `REFERRAL_ACCEPTED`.

**12. `POST /ehr/referrals/:referralId/decline`**: `{ "expectedRowVersion", "reasonCode", "note": 8-500 }`. `ehr.referral.receive`. Only while `sent` (also after `respondBy`, so a late answer still reaches the referrer). Works with the control off. Answer `{ "referral": card, "replayed": false }`. The patient's inbox gets `REFERRAL_DECLINED`.

**13. `GET /ehr/referrals/expected`**: accepted referrals not yet arrived, before `arriveBy`, urgent first, then by acceptance. `ehr.referral.arrive`. Items `{ "referralId", "reference", "patient": { "patientId", "fullName", "sex", "dateOfBirth", "dateOfBirthEstimated", "healthIdLast4" }, "referringFacilityName", "departmentCode", "serviceWanted", "urgency", "acceptedAt", "arriveBy", "rowVersion" }`. No reason, letter or package (Q-REF-14 A). Answer `{ "items": [...], "hasMore": false, "limit": 200 }`.

**14. `POST /ehr/referrals/:referralId/arrive`**: `{ "expectedRowVersion", "matchRef"? , "patientId"? }`, exactly one (400 `REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT`). `ehr.referral.arrive` and 0135's pair `ehr.encounter.read` and `ehr.encounter.write`. Only while `accepted`, before `arriveBy`; the control on.
- `matchRef`: this member's own direct-care staff search here in the last 10 minutes (0132), which must name the referral's patient. `patientId`: the referral's patient, and already this facility's own (0131). Anything else: 403 `REFERRAL_ARRIVAL_NEEDS_SEARCH`, the same for every reason (Q-REF-9 A).
- The server then calls 0135's own `ehr.visit_queue_check_in` with the same `matchRef` or `patientId`, so the waiting-list row's basis is 0135's (`search` or `own-facility`).
- Answer `200 { "outcome": "checked_in" | "already_on_list", "referral": card, "entry": waiting-list card (EHR-C7), "replayed": false }`. The referral is `arrived` and keeps the waiting-list row's id.
- The arrival never opens the chart. The receiving clinician opens it as today (the patient's PIN or approval, or 0131 once the patient is this facility's own).

**15. `POST /ehr/referrals/:referralId/complete`**: `{ "expectedRowVersion", "outcome", "feedbackNote": 8-2000 }`. `ehr.referral.receive`. From `arrived` with any outcome but `did_not_attend`; from `accepted` (also past `arriveBy`) with `did_not_attend` only (400 `REFERRAL_OUTCOME_INVALID` otherwise). Works with the control off. Sets `accessEndsAt` to the earlier of completion + 14 days and acceptance + 120 days. Answer `{ "referral": card, "replayed": false }`. The feedback note is the counter-referral: the referring facility reads it on routes 7 and 8.

#### The patient (portal)

**16. `GET /ehr/me/referrals`**: the signed-in patient's own referrals from every facility, newest first, at most 100 (a patient session, authorised by Identity as `GET /ehr/me/order-routes`). Items:

```json
{ "referralId": "uuid", "reference": "3F2A9C1B", "referringFacilityName": "Fictional General Hospital",
  "destinationKind": "health_id", "destinationName": "Fictional Teaching Hospital",
  "departmentCode": "cardiology", "serviceWanted": "Cardiology clinic", "urgency": "routine",
  "reason": "New heart murmur with breathlessness on exertion",
  "state": "sent", "effectiveState": "sent", "endedKind": null,
  "sentAt": "…", "respondBy": "…", "acceptedAt": null, "arrivedAt": null, "completedAt": null, "endedAt": null,
  "sharedSections": [{ "kind": "diagnoses", "count": 2 }], "attestation": { "version": "…", "text": "…" },
  "canWithdraw": true, "rowVersion": 1, "enteredInError": false }
```

No staff ids, no letter, no items and no outcome note (Q-REF-12 A). `enteredInError: true` (the visit was entered in error) keeps reference, facilities, states and dates, and answers `null` for the department, service, reason, sections and attestation. A staff session answers 403 `PATIENT_SESSION_REQUIRED`. A shared or dependant record is not shown in this release.

**17. `POST /ehr/me/referrals/:referralId/withdraw`**: `{ "expectedRowVersion" }`. Only while `sent` and before `respondBy` (409 `REFERRAL_NOT_PENDING` otherwise, also for a printed letter). Works with the control off. Answer `{ "rowVersion", "state", "effectiveState" }`. The referring and receiving facilities see "Withdrawn by the patient".

#### Support (identity-api, platform administrators)

**18. `GET /admin/referrals?reference=` and `POST /admin/referrals/search` `{ "reference"? , "healthId"? }`**: `platform.admin.access` and `platform.principal.read`, as support's lookup of orders between facilities (a Health ID only in the POST body). Items `{ "referralId", "reference", "destinationKind", "referringFacility", "receivingFacility", "state", "effectiveState", "urgency", "sentAt", "respondBy", "acceptedAt", "arrivedAt", "completedAt", "endedAt", "endedKind", "accessEndsAt" }`, at most 50. No patient name, reason, letter, package or note.

**19. `GET /admin/facilities/:facilityId/referral-destination`**: `platform.admin.access` and `platform.facility.read`. Answer `{ "facilityId", "listed": { "value", "byDefault", "reason", "setAt" }, "eligibleNow": true }`. `eligibleNow` says whether the directory would find it now.

**20. `POST /admin/facilities/:facilityId/referral-destination`**: `{ "listed": true | false, "reason": 8-500 }`. `platform.admin.access`, `platform.facility.manage` and `platform.facility.unlock`, as the order-destination lever. Answer as route 19. Unlisting stops new referrals to the facility; referrals already sent there can still be answered until `respondBy`.

### Errors

| HTTP | Code | Message |
|---|---|---|
| 400 | `VALIDATION_FAILED` | "Check the highlighted fields." (unknown field, length outside the rules, unknown code) |
| 400 | `REFERRAL_DESTINATION_REQUIRED` | "Choose a facility on Health ID, or print a letter for a facility that is not on Health ID." |
| 400 | `REFERRAL_PACKAGE_INVALID` | "Some of the details you ticked can no longer be sent. Reload the visit and tick them again." |
| 400 | `REFERRAL_ATTESTATION_REQUIRED` | "Confirm that the patient agreed before sending." |
| 400 | `REFERRAL_REASON_REQUIRED` | "Say why in at least 8 characters." (decline; withdraw sent in error or other) |
| 400 | `REFERRAL_OUTCOME_INVALID` | "Choose 'Did not attend' only before the patient arrives, and another outcome only after." |
| 400 | `REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT` | "Choose one patient: from a search result or from this facility's patients." |
| 400 | `REFERRAL_VISIT_INVALID` | "Choose a visit of this patient at this facility." |
| 400 | `PURPOSE_OF_USE_REQUIRED`, `IDEMPOTENCY_KEY_REQUIRED` | as EHR-C7 and ID-6 |
| 403 | `REFERRAL_NOT_ALLOWED` | "Only doctors and clinicians can send, answer or read referrals." |
| 403 | `REFERRAL_ARRIVAL_NOT_ALLOWED` | "Only the front desk, clinicians and doctors of this facility can mark a referred patient as arrived." |
| 403 | `REFERRAL_ARRIVAL_NEEDS_SEARCH` | "Search for the patient named on the referral, then mark them arrived. A search result can be used for 10 minutes." |
| 403 | `CONSENT_REQUIRED` | as today (routes 2 and 8: no access to this patient's record) |
| 403 | `PATIENT_SESSION_REQUIRED` | as today (routes 16 and 17) |
| 404 | `REFERRAL_NOT_FOUND` | "No such referral." (also another facility's, and a received one a member may not see) |
| 409 | `REFERRAL_VISIT_NOT_SIGNED` | "Sign the visit's note first, then send the referral." |
| 409 | `REFERRAL_PATIENT_NOT_IDENTIFIED` | "Identify the patient first (verify the NIN or merge the record), then refer them." |
| 409 | `REFERRAL_PATIENT_APP_REQUIRED` | "This patient has no Health ID app account, so they could not see or withdraw the referral. Print a referral letter instead." |
| 409 | `REFERRAL_PATIENT_DENIED` | "The patient has asked that their records are not shared with this facility." |
| 409 | `REFERRAL_DESTINATION_UNAVAILABLE` | "This facility is not taking referrals on Health ID now. Choose another, or print a letter." |
| 409 | `REFERRAL_DESTINATION_BUSY` | "This facility has too many referrals waiting for an answer. Try again later, or choose another." |
| 409 | `REFERRAL_VISIT_LIMIT` | "This visit already has 5 referrals." |
| 409 | `REFERRAL_ATTESTATION_OUTDATED` | "The agreement wording has changed. Read it again and confirm." |
| 409 | `REFERRAL_NOT_PENDING` | "This referral was already answered or withdrawn. Reload it." |
| 409 | `REFERRAL_EXPIRED` | "The time for this step has passed. The referring facility can send a new referral." |
| 409 | `REFERRAL_NOT_ACCEPTED` | "This referral has not been accepted yet. Ask a doctor or clinician to accept it first." |
| 409 | `REFERRAL_NOT_ARRIVED` | "Mark the patient as arrived first, or record 'Did not attend'." |
| 409 | `REFERRAL_CLOSED` | "This referral is closed." |
| 409 | `IDEMPOTENCY_KEY_REUSED` | as ID-6 |
| 412 | `REFERRAL_VERSION_CONFLICT` | "Someone else changed this referral. Reload it and try again." |
| 423 | `CROSS_FACILITY_REFERRALS_UNAVAILABLE` | "Referrals between facilities on Health ID are switched off for now. You can print a referral letter instead." |
| 429 | `REFERRAL_SEND_LIMITED` | "You have sent the most referrals allowed today. Try again tomorrow." |
| 429 | `ORDER_DESTINATION_SEARCH_LIMITED` | as today (route 6) |
| 503 | `REFERRALS_NOT_AVAILABLE` | "Referrals are not available yet." (flag off, or a database without the file) |

Staff screens show the message and never the word "permission".

### Roles and access codes

Four new codes (0193). Every route also needs what it names above (`ehr.encounter.write` to send; 0135's pair to mark arrival).

| Backend role | `ehr.referral.read` | `ehr.referral.send` | `ehr.referral.receive` | `ehr.referral.arrive` | Design role it stands for |
|---|---|---|---|---|---|
| `doctor` | yes | yes | yes | yes | Doctor, Consultant, Medical Director (the design's "approve" is dropped, Q264 A) |
| `clinician` | yes | yes | yes | yes | Doctor's clinical grant |
| `receptionist` | no | no | no | yes | Receptionist (arrival only, as the survey) |
| `nurse` | no | no | no | no | Nurse (checks walk-ins in on the waiting list as today) |
| `admin`, `org_admin`, `lab`, `pharmacist`, others | no | no | no | no | — |

Nine role rows. SX-1 (`services/identity-api/src/auth/facility-modules.ts`) gains the area `referrals`, "Referrals between facilities": shown with `ehr.referral.arrive`, used in full with `ehr.referral.read`, `ehr.referral.send` and `ehr.referral.receive` (front desk: view; clinicians and doctors: full). `services/identity-api/test/role-matrix.json` changes in the same pull request.

### Database design

Three migrations, **0191, 0192 and 0193, provisional** (sprint wave 3's booking; numbers are given at merge in release order). Each needs the owner's verbatim signature, Rahman's final database check and an independent agent review.

Every file follows 0147, 0150, 0151 and the wave 1 review:
- the whole file is one `do` block, so nothing applies if any part raises;
- every table it locks is locked first, NOWAIT, tried 50 times 100 ms apart, including tables that functions called during the file read (for example `identity.sealed_demo_members` and `identity.sealed_qa_members` for 0193's post-check counts). If this transaction already holds an earlier file's blocking locks, one try and no sleep. A busy refusal raises 55P03 beginning "0191: " (or "0192: ", "0193: ") and ending "nothing was applied; run the release again at a quieter time";
- preconditions are catalog reads that raise 55000 and apply nothing. They need markers only of the earlier files whose objects the file uses, and the md5 of each function body it calls or replaces. They tolerate other lanes' additions: an access code, a role row, a control key or a CHECK value another lane added is kept, so the file applies in any release order with APPT-1, BILL-1, ED-1, ADT-1, NUR-1 and the other wave 3 departments;
- running the file again where it is applied raises "0191: already applied" (exact detection: every object this file makes, as made) and changes nothing; any half state raises "0191: the schema is not in the reviewed state";
- post-checks in 0148's and 0152's form: table and function owners; grants (no grantee but the owner and the named runtime); each function's SECURITY DEFINER, volatility, owner and exact `search_path`; pinned bodies by md5; every trigger by `tgtype`, `tgqual`, `tgattr`, `tgnargs`, `tgfoid` and `tgenabled`; every CHECK by its definition;
- audit rows the file writes are written as the system actor;
- each file adds its block to `services/ehr-api/database/runtime-grants.sql` (the staging file followed by the REF-1 block) and its entry to the unsigned declaration in `config/production-schema-compatibility.json`.

Rules for every new object (the wave 1 review):
- New tables have row-level security **enabled and forced**, with four permissive policies for the table owner only, so the guard and append-only triggers run for every role; no policy and no privilege for any runtime role. Only the functions read or write them.
- Every SECURITY DEFINER function has `SET search_path = pg_catalog, pg_temp`, names every table and function with its schema, and creates and reads no temporary table, so nothing a runtime role makes in `pg_temp` can stand in for an object the owner uses.
- Functions are owned like 0135's (the owner of `identity.has_active_consent_grant`). EXECUTE: `hid_ehr_runtime` for the ehr functions of the routes, `hid_identity_runtime` for routes 6 and 18-20; helpers are executable by no role. The lab helper below is owned by the owner of `lab.results`.
- No sequence: every key is a UUID, so there is no identity sequence and no sequence grant.
- Append-only tables have a BEFORE UPDATE OR DELETE row trigger and a BEFORE TRUNCATE statement trigger, both `platform.reject_mutation()`. `ehr.referrals` has its own guard trigger and refuses DELETE and TRUNCATE.
- Each function checks the caller: an active membership not held by the cutover at the session facility, the referral code, the purpose (direct care), and the facility's seal (a sealed demo or QA facility refers only its own sealed patients, only to a facility of the same seal; a real facility never finds a sealed one).
- Without 0193 no role holds a referral code, so every staff function refuses. With the control off, nothing crosses to another facility. That is the database half of "built but switched off".

**0191 Referrals: the record, the frozen package, the control and the referring facility's steps.** Needs 0086 (order-route helpers), 0114 (department codes), 0117 (recorded allergies), 0131, 0135 (`ehr.visit_queue`, for the foreign key), 0142 (vital status), 0145 (unknown records) and 0021 (lab result releases).
- `ehr.referral_attestation_texts`: `version` (`referral-health-id-attestation-vN` or `referral-printed-attestation-vN`), `destination_kind`, `text` (20-1500, must hold `{patient}` and `{receivingFacility}`), `created_at`. Append-only. Seeded with v1 of each kind (drafts for the DPO):
  - Health ID: "I confirm that {patient} agreed that {referringFacility} refers them to {receivingFacility}. I told them that {receivingFacility} sees the reason, the urgency, the service asked for and their sex and age to decide whether to accept; that once it accepts, it sees their name, sex, date of birth, the last characters of their Health ID, this letter and the details I selected, until 14 days after the referral is completed; and that the Health ID app shows them where they were referred and lets them withdraw it until {receivingFacility} accepts it."
  - Printed: "I confirm that {patient} agreed to take a printed referral letter to {receivingFacility}, which is not on Health ID, with the details I selected. I told them that the letter is theirs to carry and that it cannot be called back once printed."
- `ehr.referrals`, one row per referral:
  - who and where: `patient_id`, `referring_organization_id`, `referring_facility_id`, `source_encounter_id` (foreign key to `ehr.encounters (id, patient_id, facility_id)`), `sent_by_membership_id` and `sent_by_account_id` (foreign key to the membership's `(id, facility_id, account_id)`; no foreign key to `auth.accounts`, so no lock on it), `referrer_name`, `referrer_licence_body` (`MDCN` or null), `referrer_licence_number`;
  - destination: `destination_kind` (`health_id`, `printed`); `receiving_organization_id` and `receiving_facility_id` (for `health_id`; CHECK not the referring facility); `printed_facility_name` (2-120) and `printed_facility_town` (0-120) (for `printed`);
  - content: `department_code` (checked by `identity.facility_department_codes()`), `service_wanted` (2-120), `urgency` (`routine`, `urgent`), `reason` (8-300), `letter_text` (20-8000), `patient_sex_at_send`, `patient_age_years_at_send` (0-130), `package_item_count`;
  - agreement: `patient_agreement` (= `clinician_attested`), `attestation_text_version` (foreign key with the kind), `attested_receiving_facility_name`;
  - progress: `state` (`printed`, `sent`, `accepted`, `arrived`, `completed`, `declined`, `withdrawn`), `sent_at`, `respond_by`; `accepted_at`, `accepted_by_membership_id`, `accept_note` (0-500), `arrive_by`; `arrived_at`, `arrived_by_membership_id`, `visit_queue_entry_id` (foreign key to `ehr.visit_queue`), `arrival_basis` (`search`, `own_facility`); `completed_at`, `completed_by_membership_id`, `outcome_code`, `feedback_note` (8-2000); `declined_at`, `declined_by_membership_id`, `decline_reason_code`, `decline_note` (8-500); `withdrawn_at`, `withdrawn_by` (`referring_facility`, `patient`), `withdrawn_by_membership_id`, `withdraw_reason_code`, `withdraw_note`; `access_ends_at`; `updated_at`, `row_version`;
  - receiving members by foreign key to the membership's `(id, facility_id, account_id)` with `receiving_facility_id`;
  - CHECKs: the destination shape per kind; `respond_by` = `sent_at` + 168 hours (routine) or + 24 hours (urgent) for `health_id`, null for `printed`; each state's columns set exactly when reached (as order routes' CHECKs); `arrive_by` = `accepted_at` + 90 days; `access_ends_at` within `accepted_at` + 120 days; `did_not_attend` only without `arrived_at`;
  - `reference` char(8), generated from the id as order routes;
  - indexes: (receiving_facility_id, respond_by) where `sent`; (receiving_facility_id, arrive_by) where `accepted`; (receiving_facility_id, state, accepted_at) where accepted, arrived or completed; (referring_facility_id, sent_at desc); (patient_id, sent_at desc); (source_encounter_id); (reference); (sent_by_membership_id, sent_at).
  - The guard trigger `ehr.referral_guard()` (BEFORE UPDATE): no frozen column changes (patient, facilities, visit, sender, destination, content, agreement, `sent_at`, `respond_by`); the state moves only along "How a referral moves"; each step's columns are set once; `row_version` goes up by one. BEFORE DELETE and BEFORE TRUNCATE refuse.
- `ehr.referral_events`: one row per step (`sent`, `printed`, `withdrawn`, `patient_withdrew`, `accepted`, `declined`, `arrived`, `completed`), with `event_version` (unique per referral), `side` (`referring`, `receiving`, `patient`), the actor's membership (or the patient's account), `reason_code`, `state_after`, the `Idempotency-Key` with the request's SHA-256 (unique per membership and key), the correlation id and when. Append-only.
- `ehr.referral_package_items`: `referral_id`, `position`, `item_kind` (`diagnosis`, `medicine`, `allergy`, `vital`, `lab_result`), `source_id`, `source_version`, `content` (a JSON object built by the server, at most 4 KB), `created_at`. Unique (referral, kind, source). Append-only; an insert trigger refuses any item beyond the referral's `package_item_count`, so nothing can be added after sending.
- `identity.referral_destination_settings`: support's listing lever (as 0086's T7): `facility_id`, `organization_id`, `listed`, `reason` (8-500), `set_by_account_id`, `set_at`, `correlation_id`. Append-only; the newest row decides. With no row, the default is 0086 H3's: a governed facility is listed, a self-signed-up one only when support's review recorded a real check.
- The control `cross_facility_referrals_enabled`, seeded **off**:
  - The `platform.control_settings` key CHECK and `platform.control_enabled` carry every key they hold now plus this one (0086's rule). The precondition reads the CHECK's keys, which must include 0115's eleven, and requires `platform.control_enabled`'s body to be 0115's body over exactly those keys. So a key another lane added first (for example APPT-1's `appointment_sms_reminders_enabled`) is kept, and nothing else is accepted.
  - The post-check compares the CHECK and the body with the same template over the keys found plus the new one, and that the new row is off.
  - identity-api's control command (`admin-command.dto.ts`) gains the key so support can switch it, audited, as the others.
- Functions (EXECUTE `hid_ehr_runtime`): `ehr.referral_attestation_text`, `ehr.referral_send`, `ehr.referral_sent_list`, `ehr.referral_withdraw`, `ehr.referral_letter`.
- Functions (EXECUTE `hid_identity_runtime`): `identity.search_referral_destinations` (0086's `identity.search_order_destinations` is not replaced; identity-api calls this one for `kind=referral`), `identity.admin_find_referrals`, `identity.admin_referral_destination`, `identity.admin_set_referral_destination`.
- Helpers (no role may execute them): `ehr.referral_limits()` (immutable: 50 sends per member per day, 5 per visit, 500 waiting per destination, 168 and 24 hours to answer, 90 days to arrive, 14 days after completion, 120 days at most), `ehr.referral_caller`, `ehr.referral_effective_state`, `ehr.referral_freeze_package`, `ehr.referral_cards`, `ehr.referral_audit`, `ehr.referral_idempotency`, `ehr.referral_notify_patient`, `identity.referral_destination_listed`, `identity.referral_destination_eligible` (0086 H4's rules for a hospital or clinic, holding `ehr.referral.receive`), and `lab.referral_result_snapshots(patient, facility, result ids)`, owned by the owner of `lab.results`, which answers the released, not entered-in-error versions of results of lab requests made at that facility.
- Calls, md5-pinned: 0086's `ehr.order_route_staff_actor`, `identity.patient_denies_order_route`, `identity.order_route_registered_address`, `identity.lock_self_service_application`, `identity.self_service_on_probation` and `identity.organization_self_service_state`; 0005's `ehr.context_allows`; 0131 and 0145's `identity.own_facility_basis`; 0037's `notification.enqueue_patient_inbox_item`; the sealed tenant functions of 0098 and 0123.
- Locks (expected; measured with `pg_locks` before commit and pinned when the file is written): SHARE ROW EXCLUSIVE on `identity.patients`, `identity.facilities`, `identity.staff_facility_memberships`, `ehr.encounters` and `ehr.visit_queue` (foreign keys of new, empty tables); ACCESS EXCLUSIVE on `platform.control_settings` (the CHECK swap and the seed row); ACCESS SHARE on `auth.permissions` and `auth.role_permissions` (read by the preconditions). This file writes no audit row.
- Old images on this schema: nothing calls the new functions. `platform.control_enabled` answers exactly as before for every existing key. Today's identity-api refuses `kind=referral` (400), and its control command does not know the new key, which is seeded off anyway.

**0192 Referrals: the receiving facility, the time-limited read, arrival, the counter-referral and the patient's view.** Needs 0191, 0132 (`identity.resolve_patient_search_ref`), 0131/0145 (`identity.own_facility_basis`) and 0135 (`ehr.visit_queue_check_in`, md5-pinned, called and not replaced).
- Functions (EXECUTE `hid_ehr_runtime`): `ehr.referral_read` (both sides, by view level), `ehr.referral_patient_list` (route 8), `ehr.referral_incoming_list`, `ehr.referral_received_list`, `ehr.referral_accept`, `ehr.referral_decline`, `ehr.referral_expected_list`, `ehr.referral_arrive`, `ehr.referral_complete`, `ehr.referral_my_list` and `ehr.referral_my_withdraw` (patient session, 0086's `ehr.order_route_patient()`).
- The receiver's read: `ehr.referral_read` answers the package to the receiving facility only when the referral's effective state is `accepted`, `arrived` or `completed`, `clock_timestamp()` is before `access_ends_at`, the control is on, and the caller holds `ehr.referral.receive` there; and never when the visit was entered in error. No policy on a clinical table changes: the receiver reads the frozen copy only, never `ehr.diagnoses`, `ehr.prescriptions` or any other chart table (Q261 A).
- `ehr.referral_arrive` locks the referral `FOR UPDATE`, resolves the patient (0132 with purpose `direct-care`, or 0131), compares it with the referral's patient, then calls `ehr.visit_queue_check_in` under 0135's own advisory lock and one-open-row index, and stores the row's id and basis.
- Every write locks the referral row `FOR UPDATE`, checks `row_version`, writes the event, then the row; a replay is found by the event's idempotency key first.
- Locks (expected): ACCESS SHARE on `ehr.referrals`, `ehr.referral_events`, `ehr.referral_package_items` and `ehr.visit_queue` (so no DDL can change them while the file applies; reads and writes go on); no other table. This file writes no audit row.
- Old images: nothing calls the new functions.

**0193 Referrals: access codes.**
- `auth.permissions` gains `ehr.referral.read`, `ehr.referral.send`, `ehr.referral.receive` and `ehr.referral.arrive`.
- `auth.role_permissions` gains nine rows (the role table above). One audit row per row added (`auth.role-permission.add`, reason "REF-1 Referrals between facilities (Release D, owner decisions Q261-Q266 A)").
- Preconditions: the roles `doctor`, `clinician` and `receptionist` exist, and the role table holds the codes this file relies on (`ehr.encounter.read`, `ehr.encounter.write`), whatever other codes other lanes added. Already applied: exactly these four codes and nine rows. A half state (some of them) is refused.
- The post-check prints how many real (not sealed) staff gain each code.
- Kept as its own file so Rahman can review who gets referrals apart from the tables, as 0169. It can be signed after 0191 and 0192 if the role table changes.
- Locks: SHARE ROW EXCLUSIVE on `auth.role_permissions`; ROW EXCLUSIVE on `auth.permissions` and `audit.events`; ROW SHARE on `auth.roles`, `auth.accounts`, `identity.staff_facility_memberships`, `identity.organizations`, `identity.facilities` and `identity.patients` (the audit rows' foreign keys); ACCESS SHARE on `auth.account_roles`, `identity.sealed_demo_members` and `identity.sealed_qa_members` (the post-check counts).

### Audit

Every route writes its rows in the request's transaction, refusals included, as 0135 does.

- **Referring facility:** `ehr.referral.send` (destination kind, urgency, department, the count per package kind, outcome or refusal kind), `ehr.referral.withdraw` (reason code), `ehr.referral.letter-print` (one per print), `ehr.referral.sent-list` (+ one `ehr.referral.sent-list.shown` row per patient shown).
- **Both sides:** `ehr.referral.read` (side, view level) and `ehr.referral.package-read` (each answer that holds the package, with the count per kind), `ehr.referral.patient-list` (the patient page and the visit).
- **Receiving facility:** `ehr.referral.incoming-list` (+ `.shown` per referral, naming the patient for the patient's access history although the screen shows no name), `ehr.referral.received-list` (+ `.shown`), `ehr.referral.accept`, `ehr.referral.decline` (reason code), `ehr.referral.expected-list` (+ `.shown`), `ehr.referral.arrive` (basis, outcome; plus 0135's own `ehr.visit-queue.check-in`), `ehr.referral.complete` (outcome code).
- **Patient:** `ehr.referral.patient-read` (route 16) and `ehr.referral.patient-withdraw`.
- **Support:** `admin.referrals.find`, `admin.referral-destination.read` and `admin.referral-destination.set` (the platform audit row of the command).
- **Directory:** identity-api's `identity.order-destinations.search` row, as today (the route, never the query).
- Rows hold ids, the kind of step, the outcome or refusal kind, codes and counts. **No row ever holds a name, date of birth, Health ID, reason, letter text, note, package content or a typed facility name.**

### Notifications

| Code | When | Push | Email | SMS |
|---|---|---|---|---|
| `REFERRAL_SENT` | a referral to a Health ID facility is sent, or a letter is printed | yes (0097's poll) | no | no |
| `REFERRAL_ACCEPTED` | the receiving facility accepts | yes | no | no |
| `REFERRAL_DECLINED` | the receiving facility declines | yes | no | no |
| `REFERRAL_WITHDRAWN` | the referring facility or the patient withdraws | yes | no | no |

- The inbox item (0037) has `resourceType` `referral`, the referral's id, and metadata `{ "referralId", "referringFacilityName", "destinationName", "printed" }` only: no department, reason or urgency.
- A patient with no account gets nothing, as 0037 already does (only printed letters reach such a patient, Q-REF-7 A).
- No staff notices in this release (owner decision Q151 A): the Incoming tab shows the waiting count, and the referring facility sees answers in "Sent referrals". Referrals join ORD-11's staff inbox when it ships.

### What patients see

- The portal's referral list (route 16): where they were referred and from where, the department and service, urgency, the reason, the status and dates, the agreement text the clinician confirmed, and which kinds of details were shared with how many of each (Q-REF-12 A). "Withdraw" while the referral waits for an answer (route 17).
- The four inbox notices above.
- Their access history (today's audit-based list) shows the referral's reads by the receiving facility.
- A printed letter is in the patient's hands. It names no Health ID (Q-REF-13 A).
- Nothing of the receiver's feedback note or the letter text is in the portal in this release.

### Website screens (Lekan; mapped to Akos's existing sample screens)

| Akos sample (health `apps/patient-web/src/ehr-blue/`) | Live screen | Calls |
|---|---|---|
| `clinical/sample/SampleList.tsx` with `definitions.ts:233-245` (Referral Network list) | "Referrals" page with tabs: Sent, Incoming (count badge), Received, Expected arrivals; each tab only for the codes it needs | routes 3, 9, 10, 13 |
| `clinical/sample/SampleCreate.tsx` (Destination facility, Referral reason, Urgency, Selected clinical summary, Consent scope) | "New referral" from the visit: destination (`DestinationPicker` with kind `referral`, showing each facility's departments) or "Facility not on Health ID: print a letter" (name, town); Department wanted; Service wanted; Urgency (Routine, Urgent); Reason; Letter; the tick list built from the chart summary (EHR-C4) under "Current diagnoses", "Current medicines", "Allergies", "Vital signs (last 30 days)", "Released lab results"; the agreement checkbox. "Consent scope" becomes the fixed sentence "Only the details ticked here are shared" (Q261 A) | routes 1, 2, 6; EHR-C4 |
| `definitions.ts:240` ("Send simulated referral") | "Send referral" or "Save and print letter" | route 2, then 5 |
| `definitions.ts:241` ("Simulate recipient acceptance", Recipient response) | Incoming referral page: the preview, then "Accept" (optional note) or "Decline" (reason and note) | routes 7, 11, 12 |
| `definitions.ts:242` ("Complete referral", Outcome) | "Complete referral": outcome and feedback note; "Did not attend" before arrival | route 15 |
| `clinical/sample/SampleDetail.tsx` | Referral page with the card, the package (by view level), history, Withdraw and Print | routes 4, 5, 7 |
| (no sample) | Expected arrivals and "Patient arrived" (search first, then confirm) | routes 13, 14; 0132 search |
| `clinical/consult/orders/index.tsx:157-163` ("New referral", demo only) | Offered at every facility to holders of `ehr.referral.send` while the flag is on | route 2 |
| `clinical/consult/EncounterPage.tsx:708` | The visit's referrals with status and outcome | route 8 with `encounterId` |
| patient page | "Referrals" card | route 8 |
| (no sample) | Printable letter page (A4, the facility's name and address, the reference, Lagos dates) | route 5 |
| portal `routes/Portal` (AccessPage, beside orders sent to other facilities) and NotificationsPage | "Referrals" list with Withdraw; text for the four notice codes | routes 16, 17 |
| admin console `src/admin/OrderRoutes.tsx` | Referral lookup and the listing lever | routes 18-20 |
| `frame/pages.ts:103`, `clinical/pages.ts:42`, `frame/TopBarParts.tsx:163` | Navigation status `sample` becomes live, shown with `ehr.referral.arrive` or `ehr.referral.read` | — |
| `frame/sampleAccess.ts:43`, `onboarding/roleTemplates.ts:38` | Live grants from the role table above; the Medical Director "approve" grant goes (Q264 A) | — |
| `clinical/sample/seed.ts:261-264` | Removed from the live page; demo facilities show their sealed demo patients | — |

Rules for the screens:
- Every date, time and phone through `@hid/ui/display` (Lagos time, "18 Nov 2026", 24-hour clock). "NIN Verified" / "NIN Not Verified" where a patient card shows NIN status.
- Never put a Health ID in a URL. Referral pages carry the referral's UUID only.
- No "permission" in staff text. Urgent referrals use the critical tone; no timers until the clinical lead names targets.
- `packages/contracts/src/registry.ts` entries go from `proposed` to `served` only when this ships. The public website's partner referral programme (`apps/public-web` "referral") is unrelated; the new client names use "facility referral" to keep them apart.
- **Before this ships:** keep the sample at demo facilities only, with its banner, and send nothing.

### Tests

- **Database** (throwaway local PostgreSQL, fictional patients only, migrations run as a NOSUPERUSER NOBYPASSRLS migrator), in `services/ehr-api/test/database/referrals.integration.sql` and `referrals-migrations.integration.sql`:
  - send to each destination kind; every refusal in route 2's order; each package kind's eligibility (another patient's, another facility's diagnosis or medicine, a refuted diagnosis, an ended medicine, a vital reading entered in error, an unreleased or entered-in-error lab result, all `REFERRAL_PACKAGE_INVALID`); the package frozen (a later change or entered-in-error of a source shows `enteredInErrorSinceSent`, never new values);
  - the guard: no frozen column changes, no step out of order, no package item added after sending, no delete or truncate of any REF-1 table;
  - the receiver's view levels: preview without name or chart content; full only while accepted and before `access_ends_at` with the control on; metadata after; and the visit entered in error ending the read at once;
  - accept, decline, expiry (`not_answered`, `not_arrived`), withdraw by the referring facility and by the patient, the patient's withdraw racing an acceptance (one wins);
  - arrival: a `matchRef` for another patient, another member's or an old one, an emergency search's, all `REFERRAL_ARRIVAL_NEEDS_SEARCH`; a patient already on the waiting list (`already_on_list`); the waiting-list row's basis is 0135's;
  - complete: each outcome from the right state; access ends at completion + 14 days, capped at 120 days;
  - deny directives at send and at acceptance; unknown records refused; a patient with no account refused for `health_id` and allowed for `printed`;
  - sealed demo and QA isolation in both directions; a member of a third facility sees nothing;
  - version conflicts, idempotent replays, every refusal's audit row, and no name, Health ID, reason, letter, note or content in any audit row or notice metadata;
  - the control off: route 2 to a Health ID facility, accept, arrive and the package read refused; decline, withdraw and complete still work; printed letters unaffected.
- **Migration:** each file with a lock held by another session gives its "busy" refusal and nothing applied; a second run gives "already applied"; a half state is refused; 0191 with a control key another lane added first (kept) and with an unknown control body (refused); 0193 with extra codes and role rows from another lane (kept); post-checks pass; a changed pinned body is refused.
- **Live verifiers:** `scripts/tuf-staging-migration-rehearsal.mjs` with `HID_REHEARSAL_LIVE_TREE` and `HID_REHEARSAL_LIVE_POINTS` at the three files' numbers. All live runtime verifiers pass after each file.
- **New runtime verifier:** `services/ehr-api/scripts/verify-referrals-runtime.mjs` (send each kind, withdraw, accept, decline, read at each level, arrive, complete, the patient's list and withdraw), added to the rehearsal.
- **Services:** ehr-api controller and service specs (flag off: `REFERRALS_NOT_AVAILABLE`; control off: 423), identity-api specs for `kind=referral`, support's routes and the control command; `role-matrix.json`; the SX-1 area spec.
- **Release tests:** on the sprint branch, release tests 45, 53 and 99 (and similar) fail with "missing migration prefix" because of the numbering gap before 0191. That is expected and reported, not worked around.
- **Website:** new referral (both kinds), incoming, accept, decline, arrival, complete, letter and portal tests with the device zone set away from Lagos; no Health ID in any URL; no "permission" in staff text.

### Depends on

- Orders between facilities: 0086's helpers and directory, and support's admin console patterns (sections 21-24). 0088-0091's wrong-patient, late-correction and cannot-complete machinery is not used: a referral carries no work item or result. Its safeguards are the fresh search at arrival, decline, "Did not attend" and the visit-entered-in-error ending.
- EHR-C4 (the chart summary the tick list is built from), EHR-C5 (signed notes), EHR-C7 / 0135 (waiting list), 0131 and 0132 (own facility, staff search), ID-7 / 0145 (unknown records refused), EHR-C8a (visit entered in error) and EHR-C8b / 0142, 0117 (allergies), 0021 (lab result releases), 0037 and 0097 (inbox and push), SX-9 (names), 0114 (department codes and facility profiles).
- ID-8 (merge), when built, must move referrals with the patient record.
- Q149 facility setup (gap map F2): when it ships, the facility's `referrals` switch must be on as well as the flag and the control.
- It unblocks: ORD-11's staff inbox entries for referrals (Q151 A), Appointments booking at the receiving facility, and linking ED-1's and ADT-1's "referred out" to a referral.

### Go-live gate (owner decision Q160 A, 25 Nov 2026)

Real patients use referrals only after: the clinical lead's checklist below; the DPO's review below; a hazard log; a test with real clinicians at Demo Hospital (send, receive, arrive and complete between two demo facilities); a short staff guide; a written paper back-up (today's paper referral letter); and the switches turned on with the owner's AWS access. The printed letter can pass the gate first (Q162 A): flag on, control off.

### Clinical lead checklist (before real patients)

All of these ship as drafts awaiting sign-off (owner decision Q124 A; Q157 A):
- **The minimum content of a referral letter:** reason, urgency, department and service wanted, letter text, the referring clinician's name and licence, the package sections, and the printed layout.
- **Urgency definitions and respond-by times:** what "routine" and "urgent" mean, 7 days and 24 hours to answer, 90 days to arrive, and that emergencies are not referrals here (they go through the Emergency department and a phone call).
- **What goes in the package:** the five kinds, their rules (current diagnoses, current medicines, recorded allergies from any facility, vital signs from the last 30 days, released lab results) and the per-kind limits.
- **Medicines in the package:** Ola as clinical owner for medicines, countersigned by the clinical lead (Q158 A).
- **The decline reasons** (`service_not_offered`, `no_capacity`, `more_information_needed`, `better_elsewhere`, `other`) and their screen words.
- **The outcome list** (`seen_care_returned`, `seen_care_continues`, `admitted`, `referred_onward`, `did_not_attend`) and what a feedback note must say.
- **Department wanted:** whether the 15 facility department codes plus free text are enough (Q-REF-11), or a specialty list is needed (it would be drafted for sign-off).

### DPO items

- **Disclosure to another facility (Q261 A):** the frozen package only, and the preview before acceptance (reason, department, urgency, sex and age in years, Q-REF-8).
- **The agreement wording:** both v1 texts above, and that a Health ID referral needs the patient's app account (Q-REF-7).
- **The read window:** until 14 days after completion, never more than 120 days after acceptance; 90 days to arrive (Q-REF-10).
- **The receiving front desk** sees the names of accepted referrals before the patient arrives (Q-REF-14).
- **The printed letter:** who may print it (holders of `ehr.referral.send` at the referring facility, every print audited), what it shows (no Health ID, Q-REF-13), and the patient copy.
- **What the patient sees** in the portal (Q-REF-12), and allergies recorded at other facilities going into a package.
- **Retention:** referrals, their packages, events and letters are part of the record. Declined, withdrawn and expired ones are kept, never deleted.

### Target

Release D, sprint wave 3 (from 25 Nov 2026). Size **L**.
- Backend: 0191-0193, ehr-api routes (`src/ehr/referrals/`), identity-api's directory kind, support routes and control key, the SX-1 area and the role matrix.
- Website: the wave 3 website lane, then Lekan's review.
- Review: Rahman (database, identity and security, release cut), Ola (orders between facilities and medicines), an independent agent review per change, and the owner's verbatim signature on each migration.
- Go-live: `REFERRALS_ENABLED` and `cross_facility_referrals_enabled` on only after the go-live gate above.

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
