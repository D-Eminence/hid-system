# Fixes ported from main to the production Novu branch

`staging-novu-ci-20261005` serves production. `main` recorded that branch as
merged (`7c88f0b`, "main supersedes it") without keeping its files, so Git
treats it as part of `main` and `git merge main` here would replace this
branch's applied migrations 0061–0072 with `main`'s different files of the same
numbers. Fixes therefore come over one pull request at a time, onto this
branch's own code, and every schema change is a new migration numbered after
0072.

Production admits only new migration files under `services/ehr-api/database/`,
plus `runtime-grants.sql` (below), each declared with its SHA-256 in
`config/production-schema-compatibility.json` and a named reviewer
(`scripts/production_deployment_core.py`, `schema_contract`). So these ports
leave every other existing file there unchanged: database suites ported from
`main` run from `services/ehr-api/test/database/`, which the container database
acceptance script runs after the suites in `services/ehr-api/database/tests/`.

## Ported

| main | What it fixes here | Migration here |
| --- | --- | --- |
| #40 | EHR clinical lists page at the sort key's full microsecond precision | — |
| #44 | EHR sends Lab the order's exact microsecond `created_at` as `requestedAt`; 0018 already compares them exactly | — |
| #51 | A Lab result history read without `lab.execution.read` returns released revisions only; adds `GET /lab/ehr-orders/:id/released-results` | — |
| #53 | Lab, Pharmacy and EHR reuse one remote JWKS set per process | — |
| #34 | Fourteen row locks in Identity, Lab, OCR, Outreach and Pharmacy needed UPDATE privileges their runtime roles lack (42501); SERIALIZABLE retry per service | 0073 (main 0078) |
| #33 (grant) | Every Outreach runtime write failed: its RLS policies call `auth.account_id_for_subject`, which the runtime could not execute | 0074, runtime-grants.sql |
| #56 | EHR can send a saved active lab request to Lab again; Lab answers acceptance refusals 4xx | — |
| #59 | Only the account that created a document upload intent completes it | — |
| #60 | A missing purpose of use is 400, not 500; an owning service refusing OCR's workload identity is 503 | — |
| #35, #36 | OCR stores transient publication failures as retryable, flags the last attempt, refuses unpublishable validations; the OCR app creates Textract jobs | — |
| #46 | EHR and OCR answer and audit a refusal made before a facility is bound instead of 503 | — |
| #38 | EHR, OCR, Lab and Pharmacy cookie GETs pass Identity's delegated check without a CSRF token | — |
| #43 | Outreach cookie reads pass without CSRF; Identity authorizes `outreach.campaign.read`; campaign writes stay refused | — |
| #45 | A correct patient PIN no longer clears the staff member's PIN failure window | 0075 (main 0079) |
| #55 | Recovery starts answer alike whether or not the account exists; wrong recovery codes share one budget per account | 0076 (main 0081), runtime-grants.sql |
| #61 | Wrong public-enrollment contact codes share one budget per recipient | — |
| #33 | Lab, Pharmacy, OCR and Outreach write guards fail closed on an unresolved session; OCR worker leases | 0077 (main 0077) |
| #31 | Lab authorizes the patient before listing a specimen's executions | — |
| #18 | The admin console's Platform controls page: the Identity runtime may run both control commands, and `platform.admin_set_control` no longer fails with 42702; its refusals answer 409/403/400 | 0078 (main 0071), runtime-grants.sql |
| #18 | The admin console's Audit page: `audit.list_platform_events` returns `patient_id` in its declared column instead of failing with 42804 | 0079 (main 0067) |
| #88 | CAC sign-up reads the Java-printed registration date that QoreID's CAC Basic v2 returns in production | — |
| #88 | Termii receives the SMS recipient as international digits without `+`, as its API documents | — |
| #76 A24 (search only) | `POST /admin/principals/search` takes the user search (a name or an email address) in its body, so request-line access logs do not keep it; `GET /admin/principals` stays. The production admin console's Users & roles search uses it. Not ported: main's `@HighRiskAction` policy and the export's POST form (this branch has no `platform.principal.export`) | — |
| — | This branch only: OCR publication answers 503 `OCR_PUBLICATION_PAUSED` until `OCR_PUBLICATION_ENABLED=true` on ocr-api. It ships before the migration that lets publication commit, so no running ocr-api (during a rollout or after a rollback) can publish before the owner decides | — |
| #32 (7B) | The OCR patient-confirmation and validation guards refuse a missing source, extraction, account or membership, and bind the confirming account and membership to the session | 0080 (main 0076) |
| #30 | OCR patient confirmation and publication can write their outbox events (every one failed with 42501); a repeated confirmation answers 409 `OCR_PATIENT_ALREADY_CONFIRMED` | 0081 (main 0075) |
| #30 | The OCR worker reports queue depth and age through `ocr.worker_queue_metrics()`, owned like `ocr.claim_worker_job` (main's dedicated owner role is not ported) | 0082 (main 0075), runtime-grants.sql |
| #30 | Every OCR audit event names the source document's patient; finding a job, listing validations and listing publications are audited | — |
| #75 (PSELF-RLS) | Patient-self reads, index writes and chat history are bound to the patient's own live session; a context naming another patient or a revoked, expired or made-up session reads nothing. The session check is inline (main's nested call costs about 500 µs per row) | 0083 (main 0091 section 3) |
| #69 (PSEARCH-1, create answer) | Creating an access request no longer returns the patient id to the clinician before the patient consents. The staff request list (`GET /identity/access-requests`) still names the patient of a pending request; withholding it there needs main's 0086 list function, not ported | — |
| #76 (LOGIN-DETAIL-ORACLE) | Every credential refusal at sign-in answers 401 "Invalid credentials", so the detail never confirms a correct password; a Google refusal while issuing the session is 401 `GOOGLE_SIGN_IN_DENIED`, audited as denied | — |
| #76 (A18) | A delegated browser read cannot authorize `write_records` (403 `CSRF_VALIDATION_FAILED`) | — |
| #79 (TS-2, TS-3, TS-8) | Turnstile retries Siteverify once (same idempotency key), answers its configuration errors as 503 `TURNSTILE_UNAVAILABLE`, logs one safe line per refusal, and a missing token answers 400 `TURNSTILE_REQUIRED` on enrollment, organization application and completion, and demo requests | — |
| #41 | Staff password recovery: Identity accepts `staff-reset` on the production portal (app.), where /provider/recover is served; www only redirects to the public site. health sends staff recovery to app. (D-Eminence/health, "Send staff password recovery to the portal"). The portal's own staff sign-in (`staff-login` on app.) stays refused, as on main: an owner decision | — |
| #68 (ENR-4, FE-4) | Public enrollment checks the QoreID gate (QoreID and NIN-only enrollment on, QoreID not paused at runtime) before it reads the registry, so while the gate is closed a registered, a pending and an unknown NIN get the same 503 and no rate bucket is charged. Availability answers `{ open: false }`, not 503, when QoreID is paused or the enrollment keys are missing. `main`'s boot-time refusal of NIN-only enrollment in production is not ported | — |
| #84 (adapter) | A QoreID NIN record with no usable phone, a null photo or a partial residence enrolls; what is unusable is left out instead of answering 502. Such records were refused only by this parsing, so more NINs can now enroll without the NIN holder proof, which is not ported (owner decision) | — |
| #84 (signed-in NIN binding) | `POST /identity/me/verification/nin` binds a NIN on a name and date-of-birth match, without proof of holding it. It now answers 503 `QOREID_PATIENT_NIN_BINDING_DISABLED` before any lookup, quota charge or evidence write unless `QOREID_PATIENT_SELF_NIN_BINDING_ENABLED=true`. No production screen calls it. `main`'s production refusal of the flag is not ported: turning it on is the owner's decision | — |
| #86 (Integrations page) | The admin Integrations page shows NIN enrollment open only with its gate, the enrollment keys and a ready enrollment database, and existing-patient NIN binding only with its own flag | — |
| #50 (enrollment) | Activation is budgeted per enrollment (`OTP_RATE_MAX_REQUESTS` × 3 per window, then 429 `ENROLLMENT_RATE_LIMITED`) once the cookie has proved it. A replay of an active enrollment never hashes the presented password; the placeholder hash the command needs is computed once per process | — |
| — | This branch only (owner decision): a public enrollment's start answers `recordName`, the full name on the NIN record (first, middle and last), so the person can check that the NIN they typed is theirs; health shows it under "NIN verified". `GET /identity/patient-enrollments/current` answers it too, for a reload, but only within 15 minutes of the enrollment's first start (a same-key resume does not extend it) and never after activation, so a shared device does not show it to the next person for the enrollment's whole 24 hours. It is never logged and is stored only in the encrypted profile | — |
| #68 (N2(b), service half) | The enrollment cookie shows the new HID (`GET /current`, an activation replay) for 15 minutes after activation only, then answers 404 as an unknown enrollment. Before, a shared device showed it to the next person for up to 24 hours. A start with the key of an activated enrollment answers 409 `IDEMPOTENCY_KEY_REUSED`, as on `main`, so the page says the registration was completed. Not ported: `main`'s 0085 check of the same in the activation command (the service refuses before it calls the command), and `main`'s expiry of the cookie in the activation response, so a reload within the 15 minutes still shows the HID, which a patient who verified only a phone needs to sign in and to recover the account | — |
| #16 (emergency contacts, with e1757ba) | A patient keeps up to five emergency contacts, each stored encrypted and verified by a code the contact reads back; when a clinician uses break-glass, each verified contact with alerts on gets one alert. It shipped switched off and is switched on through the code defaults after the owner's approval of 2026-10-24 (D1). Switched off, adding a contact and sending a code answer 409 `EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE` and no message can be sent. It differs from `main` as listed below the table | 0084 (main 0065), runtime-grants.sql |
| main 0097 section 2 with #18 0c4de59 and 17abba5 (plan waves W14, Identity part, and W30) | Staff can use break-glass in production (owner decision of 2026-10-24, below). 0085 seeds the active `emergency` purpose of use `identity.activate_break_glass` requires, as `main`'s 0097 does (ON CONFLICT DO NOTHING: an operator's row, active or not, is kept as it is). Identity runs `platform.require_control_enabled('break_glass_enabled')` inside the activation transaction, before the command: the control off answers 423 `BREAK_GLASS_DISABLED` and writes nothing, an unreadable control 503 `PLATFORM_CONTROL_UNAVAILABLE`, and a missing or deactivated `emergency` purpose also 423 `BREAK_GLASS_DISABLED` (it was 400 `INVALID_CONSENT_COMMAND`). Every other 55000 stays 409 and every other 22023 stays 400. It differs from `main` as listed below the table | 0085 (main 0097) |
| #81, main 0061–0063 with db49a0d, 46a173f and 08c906f, and P71's activation (plan wave P4) | Facility self sign-up (owner decision D14): a hospital, laboratory or pharmacy signs itself up through "Setup Your Facility" with a CAC lookup, an email code and a password, without an administrator approving it first, and support reviews every new facility within a business day (owner decision of 2026-10-24). It shipped closed: the platform control `provider_self_service_enabled` is seeded off and is opened with the audited admin command. Administrators finish with a password and get a staff session, as P71 did; staff MFA is not ported (owner decision 2). #81's answers are kept. It differs from `main` as listed below the table | 0086 (main 0061–0063), runtime-grants.sql |

Emergency contacts differ from `main` (#16 and e1757ba) in these ways. Owner
decisions of 2026-10-23 are marked "owner".

- D1: `EMERGENCY_CONTACT_DELIVERY_ENABLED` (Identity and notification-api)
  has no production refusal; `main` refuses it in production, so turning it on
  would crash-loop both services. D-Eminence approved production delivery for
  every patient on 2026-10-24 (contacts' details stored encrypted) and asked for
  it without an infrastructure apply. Production's task definitions set none of
  these keys, so the code defaults decide, and they are switched on in two
  releases because a release updates identity-api before notification-api:
  first notification-api's default becomes true (Identity still answers
  "delivery off"), then Identity's, with its dispatch interval
  `PATIENT_LIFECYCLE_SWEEP_SECONDS` at 60 s (O9). Only an explicit `false`
  switches a service off: `dev`'s Terraform leaves the key out when its switch
  is off, which now means on, so until it writes `"false"` the off switch is a
  release that flips Identity's default back (Identity first, then
  notification-api).
- D2: while delivery is off, or the account is outside
  `EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS` (D6), adding a contact and sending a
  code answer 409 `EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE`. Listing, editing and
  removing keep working. On `main` adding is allowed and the code answers 503;
  the gateway replaces every upstream 502, 503 and 504.
- D3: a code that cannot be delivered answers 422
  `EMERGENCY_CONTACT_VERIFICATION_UNDELIVERABLE` (`main`: 502).
- D4: `GET /identity/me/emergency-contacts/availability` answers
  `{ delivery, channels }` so the card can tell whether the feature is on.
- D5 (owner): `EMERGENCY_CONTACT_CHANNELS`, default `email`. Production's
  `email-brevo` cannot send SMS, so SMS comes next.
- D6: `EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS` limits adding contacts and sending
  codes to the listed accounts while it is set.
- D7 (owner): the alert gives the patient's full name, the last four characters
  of the Health ID ("Health ID ending EF23", never the whole HID, which is a
  sign-in identifier), the clinician's name, the facility, the facility's alert
  phone or else Health ID support, the fixed reason "for emergency care" (never
  the reason the clinician typed), the time in WAT, and how to stop the alerts.
  `main` sends the first name, the facility and the time.
- D8 (owner): a facility's alert phone is kept in `identity.facility_alert_phones`,
  set by `identity.admin_set_facility_alert_phone` through
  `POST /admin/facilities/:facilityId/alert-phone` (`platform.facility.manage`).
  A bad phone answers 400 `ADMIN_INVALID_FACILITY_PHONE`. It is a side table
  because a new checked column would lock `identity.facilities` exclusively.
- D9: notification-api's alert route answers 503 while its flag is off (`main`:
  403), so a flag mismatch between the services retries the alert instead of
  closing it. The code purpose keeps 403.
- D10: the Identity sweeper only dispatches alerts. Account deletion is not
  ported.
- D11: editing, removing and starting a verification lock the contact
  `FOR NO KEY UPDATE` (`main`: `FOR UPDATE`), so a patient's own edit never
  makes break-glass wait on the alert intent's foreign key.
- D12: the trigger's failure audit is guarded, so an audit outage that affects
  only these rows still lets break-glass commit (on `main` it aborted
  break-glass). A grant the trigger cannot see is audited as `intent-failed`
  with `grant_unavailable` instead of being skipped silently.
- D13: both messages say "Health ID" (`main`: "HID").
- D14: the alert call times out after 12 s. The code call stays at 5 s.
- One migration, 0084, holds what the plan split into two: the dry run takes
  every lock together anyway, and a release that applied only the first of two
  files could not be retried. The trigger is its last statement.
  Its first statement takes the SHARE ROW EXCLUSIVE locks on facilities,
  accounts, patients, consent grants and the outbox, in that order (the order
  organization approval, registration, NIN registration and break-glass write
  them), so none of them can deadlock with it.
- Erase on removal (owner): removing a contact, and support's opt-out, set its
  ciphertext, key version and destination HMAC to null in the same update and
  close its pending alerts unsent (`contact_deactivated`). A notice leased at
  removal is closed by its outcome or by the next claim. Only a record that
  the contact existed is kept. `main` keeps the encrypted name and destination.
  The removal reasons also allow `account_deleted`, for a later account deletion.
- Opt-out through Health ID support (owner): `identity.admin_opt_out_emergency_contact`
  through `POST /admin/emergency-contacts/opt-out`, with the new permission
  `platform.emergency-contact.manage` (support_admin and every role that holds
  `platform.principal.manage`), removes every contact with that channel and
  destination, for every patient, and tells each patient in the inbox
  (`EMERGENCY_CONTACT_OPTED_OUT`, without the contact's name or address).
  Support sees only the counts, and the audit row never holds the destination.
  `main` has no opt-out.
- The delivery claim returns the Health ID's last four characters, the
  clinician and the facility phone through left joins, so a missing staff row
  or phone never stops an alert. A notice whose patient it cannot see is closed
  and audited (`patient_unavailable`) instead of being retried until its
  attempts run out.
- Identity claims 5 alerts at a time with a 120 s lease, up to 5 batches per
  tick, and refuses an alert timeout above 20 s, so a lease never expires while
  its batch is still being sent (on `main`, 10 alerts with a 60 s lease could be
  sent twice). The claim's limit counts only the alerts it leases, so the
  notices it closes on the way cut a batch short only when one call meets more
  than 500 of them (on `main` each took a slot).
- The trigger has `WHEN (new.event_type = 'EmergencyAccessActivated')`, so other
  outbox events never call it. Its system audit rows name no facility and carry
  channels and counts only, so a facility's audit read does not learn a
  patient's contacts.
- The ported database suite runs from
  `services/ehr-api/test/database/emergency-contacts.integration.sql` (container
  acceptance), and `services/identity-api/scripts/verify-emergency-contacts-runtime.mjs`
  runs in the migration rehearsal.
- `EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS` accepts any UUID version, so an account
  id that is not version 4 cannot stop Identity at boot.
- The alert's date spells the month from a fixed table ("Sep", not Node's
  "Sept"), and a `+234` number with ten digits after it is shown as
  `+234 XXX XXX XXXX`; any other number is shown as given.
- `POST /admin/facilities/:facilityId/alert-phone` answers 201, as the facility
  status command does. An idempotent replay of either new admin command writes
  no second audit row.
- The opt-out's idempotency digest is taken over the destination HMAC, never the
  destination, and its audit row carries a fixed reason, since support's typed
  reason may quote the destination.
- `main`'s workload-token handling for notification calls is ported: a code is
  not sent without a valid token, and an alert is retried.
- notification-api does not deduplicate by idempotency key (as on `main`): an
  alert whose outcome was unknown (a timeout, say) is sent again on retry. The
  lease keeps two Identity tasks from sending the same one.

Break-glass in production differs from `main` (0097, 0c4de59, 17abba5) in
these ways, all from the owner's decision to enable it now:

- 0085 is only 0097's section 2, the `emergency` row. 0097's section 1
  (granting `identity.break-glass.write` again to doctor, clinician and nurse)
  is not needed: 0091's withdrawal was never ported, so 0010's grant to those
  three roles stands. 0097's section 0 (refusing to run while
  `break_glass_enabled` is on) and `main`'s control starting off (0091) are not
  ported: the control stays as 0039 seeded it (on) or as an administrator set
  it, so break-glass works as soon as 0085 and this Identity are deployed,
  unless an administrator has turned the control off.
- Staff break-glass works without staff MFA (`main`'s D9 and its P11 operator
  step require it), and `main`'s other launch limits are accepted as they are:
  cross-facility imported records and the N3 document routes.
- The EHR break-glass route (`services/ehr-api/src/consent/consent.service.ts`)
  is not changed: it checks the control before its transaction and answers 423
  `PLATFORM_CONTROL_DISABLED` while it is off, and a missing `emergency`
  purpose still 400 `INVALID_CONSENT_COMMAND`. The staff UI calls Identity's
  route.
- The staff UI (health) maps 400 `INVALID_CONSENT_COMMAND` to "Emergency access
  may not be enabled" and has no 423 mapping; a 423 shows the problem's detail
  ("Emergency access is currently disabled by the platform administrator" or
  "Emergency access is not enabled on this platform").
- `platform.require_control_enabled` is SECURITY DEFINER and granted to
  PUBLIC, so a staff session without `platform.control.read` passes it while
  the function's owner can read `platform.control_settings`, as Identity's
  guard's portal check on every staff request needs too. Under an owner that
  does not bypass row-level security a staff context gets 503
  `PLATFORM_CONTROL_UNAVAILABLE` from both
  (`services/ehr-api/test/database/break-glass-launch.integration.sql`);
  production's control reads work (#63 under "Not ported").

Facility self sign-up differs from `main` (0061–0063, db49a0d, 46a173f,
08c906f, #81 and P71's activation) in these ways. Owner decisions of
2026-10-23 and 2026-10-24 are marked "owner".

- One migration, 0086, holds main's three and this branch's additions; its
  control section is its last statements, so the ACCESS EXCLUSIVE lock on
  `platform.control_settings` is held only for the CHECK swap, the seed and the
  `control_enabled` replace, and a release that cannot take that lock leaves
  nothing applied (the plan's separate control migration would have left the
  self-service commands requiring a key `control_enabled` rejects).
- A1: `provider_self_service_enabled`, seeded off. `identity.submit_self_service_organization_application`
  and the activation wrapper `identity.activate_self_service_provider_enrollment`
  require it (55000 `PLATFORM_CONTROL_DISABLED:provider_self_service_enabled`),
  and Identity checks it before any write. The seed lifts FORCE row-level
  security for its own insert only, as `main`'s 0098 does (the table has no
  INSERT policy). The control is read from Identity's accountless context
  exactly as the security guard's portal check reads it, so it needs the same
  owner that can read the table; under a NOBYPASSRLS owner the gate stays
  closed (55000 `PLATFORM_CONTROL_UNAVAILABLE`).
- Every later migration that changes the `control_key` CHECK or
  `platform.control_enabled` must carry `provider_self_service_enabled` with
  the six others: 0086 refused to run unless both named exactly the six live
  keys, and a later copy of `main`'s 0098 or another control wave without it
  would make the self sign-up gate raise 22023 (closed). Likewise a later
  replacement of `platform.prune_verification_quotas` must keep 0086's two
  counter tables (A4 here is "the 0049 body live at merge, plus 0086's
  tables"; 0086 refused to run if the live body pruned anything else).
- A4: the prune keeps 0049's body and adds 0086's tables; `main`'s 0085 body
  is not ported (it deletes from a table this branch does not have).
- A5: the runtime grants are made in 0086 as well as in `runtime-grants.sql`,
  since a release never applies that file.
- A6 (owner, Q2): a platform-wide daily cap on accountless CAC lookups, the
  third argument of `platform.consume_self_service_cac_quota(uuid,char,integer)`
  (1–100000, else 22023), with its own counter table, charged last so a network
  or application denial never spends it, and audited as `platform_day`.
  Identity reads `PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP` (1–100000, code
  default 200); an invalid value closes the gate instead of stopping Identity.
  `main`'s two-argument command does not exist here.
- A7 with C8: the public application quota is charged once, in the submit
  transaction, and not again when the same start sends the email code.
- A8 with C9 (owner, Q3): an unactivated self-service application lapses 24
  hours after it was submitted. The next submit for its CAC and product, by
  any email, on the self-service or the governed path, rejects it (reviewed_at,
  the reason "Self-service application lapsed: not activated within 24 hours of
  submission", no reviewer, row_version bumped), invalidates its email codes and
  completion sessions, audits `identity.organization.self-service.lapse` and
  opens a new application. An activated application and a governed application
  never lapse. `main` never expires these rows. The governed submit still
  returns a fresh (under 24 hours) self-service application for the same CAC
  and product, as before (follow-up below).
- A9: activation checks the completion session with
  `identity.current_organization_profile_completion` before hashing the
  password.
- A10: activation sets the account's `email_verified_at` and
  `password_changed_at`.
- A11: submit takes the governed submit's lock key `org-application:` and
  activation the governed approval's `org-cac:`, so the two paths serialize on
  one CAC (`main` uses `self-service-org-` keys).
- A12: `GET /api/v1/identity/provider-enrollments/availability` answers
  `{ open }`, and `{ open: false }` on any error.
- A13: the gate also requires `provider_portal_enabled` on and
  `maintenance_mode` off, which the security guard does not enforce on public
  routes.
- The gate answers 423 `PROVIDER_ENROLLMENT_UNAVAILABLE` on every route (C1:
  the gateway turns every 5xx into 503 `UPSTREAM_UNAVAILABLE`), and 55000
  `PLATFORM_CONTROL_DISABLED:provider_self_service_enabled` and the gate's
  22023 answer the same 423. Other upstream failures keep `main`'s 5xx codes.
- Turnstile accepts `provider-enrollment` on production `app.` and staging
  `staging.` only (`main`: www and staging).
- Activation is P71's (owner, decision 2): `AuthService.login(..., 'staff')`,
  the three session cookies and `x-csrf-token`, answering `actor`; no MFA, and
  `hid_enrollment` is not cleared (this branch's decision under #50).
- All four products may sign themselves up (owner, Q5); a laboratory or
  pharmacy administrator gets the provider portal only until staff management
  exists. A second product for an already registered CAC goes to admin review
  (owner, Q8), and one email cannot be both a patient account and a facility
  administrator (409, owner, Q7).
- Support's review (owner, Q1, "alert + daily review"): three review columns on
  the application (`self_service_reviewed_at`, `self_service_reviewed_by_account_id`,
  `self_service_review_note`, all set together, only on an approved
  self-service application) and two commands,
  `identity.admin_list_self_service_facilities` (`platform.identity-review.read`)
  and `identity.admin_review_self_service_facility` (`platform.facility.manage`),
  served as `GET /api/v1/admin/self-service-facilities` and
  `POST /api/v1/admin/self-service-facilities/:applicationId/review`. Unlike
  the governed application commands they need no facility membership, so a
  standalone platform administrator can use them, as 0064's commands; the
  review is audited as the platform administrator
  (`admin.self-service-facility.review`). Suspending the facility and
  disabling the account use the existing commands. `main` has no review.
- The ported database suites run from `services/ehr-api/test/database/`
  (`provider-self-enrollment`, `provider-self-service-cac-quota`,
  `provider-self-service-control`, `provider-self-service-lapse`,
  `self-service-facility-review` and `provider-self-service-rollback`, which
  runs the previous Identity's own SQL on the new schema).
- `services/identity-api/scripts/verify-provider-enrollment-runtime.mjs` (main's
  verifier rewritten for this branch) runs in the migration rehearsal as
  `hid_identity_api_runtime`, with local stubs for Siteverify, QoreID and
  notification delivery, on production's hosts (`app.`, `ehr.`, `admin.`). It
  proves: the shipped gate answers 423 on all three routes and availability is
  false; a standalone platform administrator opens the control; the provider
  portal off or maintenance on closes it again; start, the emailed code, verify
  and activate, then `GET /auth/session`, `POST /auth/facility` and a fresh
  password sign-in on `ehr.`; a second sitting resumes without a QoreID lookup;
  #81's answers; the lapse after 24 hours frees the CAC; the 200-a-day platform
  cap refuses the 201st lookup; support's list and review as a standalone
  administrator, with its version conflict; and closing the control refuses a
  held session. Unlike `main`'s, it can also run against a disposable copy of a
  database on a loopback test cluster (`HID_PROVIDER_RUNTIME_LOCAL_CLUSTER=loopback`,
  `NODE_ENV=test`), which proves the same flow on a database built in
  production's order.
- `POST /auth/login` and the activation set the session cookies through one
  helper, `setSessionCookies` (`AuthController.setCookies` is a pure extraction
  of it, C18), so the two cannot drift.
- Follow-ups, each its own decision: the governed submit still attaches a
  governed applicant to a fresh self-service application for the same CAC and
  product, and the admin application list does not show `approval_mode`; the
  governed admin commands still need a facility membership (`0046`); no
  command releases a bound CAC after a fraud finding; a self-signed-up
  facility has one user; staff MFA, once ported, must say what it does to
  these administrators; and an activated administrator holds
  `organization.manage`, so it can also run the existing organization CAC
  check (`POST /api/v1/identity/organizations/verification/cac/:context`),
  which is charged to that account's 0049 quota (5 an hour, 15 a day, 10 a day
  per organization) and not to the 200-a-day self sign-up cap (CRITIC C13).

## Not ported, and why

- Already on this branch: #26 (0071 grants the list), #58 (0071 seeds `direct-care`).
- Does not apply: #52. This branch's record summary reads only encounters,
  notes and imported records, and imported attachments are scan-gated.
- Needs `main`'s Phase 4 platform administration (0061–0072 on `main`), which
  this branch replaces with its own (0064): the rest of #18 (its control and
  audit repairs are ported above), #24, #32 7A (its OCR guards are ported
  above), #49, #76 A24 (its search is ported above), #80 A20, and the platform branches of #25, #27 and
  #39 (`admin_revoke_session_family`, `PlatformSecurityService`,
  `platformSessionEnded`). Platform administrator MFA would bring them back as
  its own change.
- Would lock out people production serves: #76 A10 (403
  `NO_ACTIVE_FACILITY_MEMBERSHIP` at the password step) and A16 (only a
  platform session is exempt from runtime controls), because this branch's
  administrators sign in as staff sessions without a membership, and A16 would
  lock out the administrator who must switch maintenance off. #79 TS-6 (refuse
  `admin-login` on `POST /auth/login`): the production admin console signs in
  there with that action.
- Would stop services production runs: #66 INFRA-COUNT, NOTIF-PROD
  (`otp-email-sms` required), REC-GOOGLE (empty Google client IDs) and the
  refusal of `HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED`, #68's boot-time NIN-only
  refusal and #84's production refusal of the binding flag. Production runs one
  task per service, `email-brevo`, Google sign-in and NIN-only enrollment, so
  each refusal would crash-loop a service or switch off a live sign-in.
- #65: the Dockerfile default `HID_ENABLED_API_ROUTES=identity,ehr` would take
  the Lab, Pharmacy, Migrate and Outreach portals down. The client address
  header and its per-request resolution already exist here and in health, as
  `X-Hid-Client-IP`, so the Worker's switch to `X-Real-IP` is not needed.
- #63 0083, `hid_platform_control_reader` and 0098's owner swap: this branch's
  `rds-compat/0015` already gives the function its local `variable_conflict`,
  and production's control reads work without the reader role.
- #88's CDK changes in `infra/aws` (exec-form health checks, the migration
  task's `--plan` and `DATABASE_ADMIN_URL`, Identity budget synthesis inputs),
  and #72 and #49 as implemented in CDK: CDK is not the production source (see
  Infrastructure below). #88's `db:provision` and the `PLATFORM_ADMIN_EMAILS`
  bootstrap: production's logins and administrators exist, and the bootstrap
  depends on `main`'s platform model.
- #93 (Terraform copied into this repository): `dev` holds the Terraform that
  runs production and is newer. A copy here would be a second, stale source.
- #92 Meta WhatsApp webhook: WhatsApp is not a production channel and
  notification-api is not publicly routed, so it would be inert code that
  redeploys notification-api.
- #29, #57, #62, #77 and #78 documents (and #57's comment-only lab-api edits):
  they describe `main`'s own chain and decisions, and the comment edits would
  redeploy lab-api for nothing.
- #18 a486a23/dfb87dd (every section in `GET /ehr/me/records`): superseded by
  #91's per-category release, which is to be ported switched off.
- `main`'s 0091 section 1 (launch controls switched off by migration): it lifts
  FORCE RLS on `platform.control_settings`, records no control event and
  changes live behaviour at deploy. A control is switched off with the audited
  admin command instead. 0084 section 1 and 0091 section 2 (withdrawing the
  Lab, Pharmacy, OCR, Outreach, break-glass, document-write and lab-order
  permissions): production serves these portals, and staff chat reads Lab
  results. Their fixes are ported instead.
- #50's expiry of the enrollment cookie at every sign-in, refresh and
  sign-out: here a second start for a NIN is refused while its first
  enrollment is pending (on `main` each start key makes its own, since #84 and
  #85), so expiring the cookie before activation could lock that NIN out of
  enrollment for up to 24 hours. After activation, #68's 15-minute window
  (above) covers what it protects. health's enrollment copy says that a
  sign-in or sign-out in the browser ends an enrollment; here it does not,
  before this port or after it.
- Rewrites Identity's sign-in, refresh and sign-out on `main`'s token service:
  #39, #42, the rest of #50, and #76 apart from the items ported above. Port
  each onto this branch's token service as its own change.
- Edits a suite in `services/ehr-api/database/tests/`, which production
  refuses: #48 as `main` made it (0080 also restates `main`'s 0077 bodies). A
  port orders its guards so the suite needs no edit.
- The other launch features and their infrastructure (#63–#98) are not ported
  yet. Each waits on the owner decision recorded below, where it needs one.

## Owner decisions

Decided by the owner, D-Eminence:

- Production stays in automatic mode (`PRODUCTION_APPROVAL_MODE=automatic`):
  a merge into this branch deploys the backend, and a merge into health `main`
  deploys the frontend. Each is merged only on green CI and watched until the
  release reads back.
- Each migration wave is signed on its own (`reviewed_by` and SHA-256 in
  `config/production-schema-compatibility.json`), after its container
  acceptance and rehearsal. Nothing is signed ahead: a held wave changes the
  numbers and hashes after it.
- health is re-pinned after every backend release, and the owner signs each pin
  (below).
- OCR patient confirmation is live; publication stays paused
  (`OCR_PUBLICATION_ENABLED` is not `true`) until a synthetic-patient test.
- Break-glass is enabled in production now (2026-10-24, "Enable break-glass
  now"): 0085 seeds the `emergency` purpose and Identity enforces
  `break_glass_enabled`, which the release does not change (0039 seeded it
  on). The owner accepted that staff have no MFA (`main` requires it, D9) and
  `main`'s other launch limits (cross-facility imported records; the N3
  document routes).
- Staff password recovery runs on the portal (#41, ported above), and staff
  sign-in on the portal sends staff to ehr.
- Facility self sign-up (D14, 2026-10-23, and 2026-10-24): hospitals,
  laboratories and pharmacies sign themselves up, finishing with a password
  (no authenticator); every new facility appears for support, who review it
  within a business day and suspend the facility and disable the account if it
  looks wrong; all four products; 200 CAC lookups a day across all sign-ups;
  unactivated applications lapse after 24 hours; the control ships off and is
  switched on right after the deploy and its closed-state checks, with no pilot.

Still open, with what each one holds back:

- The live task definitions (read only): `QOREID_NIN_ONLY_ENROLLMENT_ENABLED`,
  `CORS_ORIGINS`, no static AWS keys, no
  `NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN`, and whether
  `NIN_ENCRYPTION_KEY_B64` and `OTP_HMAC_KEY_B64` are set; also whether
  `audit.events` shows use of `POST /identity/me/verification/nin`. Holds the
  database role guard, NIN holder proof and emergency contacts. The enrollment
  port did not wait for it: without the keys a start already refused and
  availability now says closed, and no production screen calls the NIN
  binding route it switches off.
- #48: accepted, undispensed pharmacy work whose prescription has since changed
  becomes undispensable at once. Needs the read-only count first.
- Accounts disabled before the admin transition fix, with no recorded prior
  status: re-enabled as `pending_reset` (`main`'s rule) or backfilled. Needs
  the count first.
- Break-glass (enabled, above): before merging, read `GET /admin/controls`
  and confirm that `break_glass_enabled` is on; if it is off, the release waits
  for the owner. 0085 commits before the new Identity serves, and the previous
  Identity, which does not check the control, serves break-glass during the
  rollout and after any rollback to it (the schema stays), so with the control
  off staff could still use break-glass in those windows. After the deploy,
  confirm that 0085 left an active `emergency` row (the read-only query in
  0085's header); an operator's earlier inactive row is kept and keeps
  break-glass refused.
- D7: patients see signed notes only once their encounter is completed.
- Patients see the requesting clinician's name and role, and get an inbox
  notice on every Access-PIN use.
- Encounter rules: refusing records on cancelled encounters, the
  completed-encounter order rule, `ehr.vitals.status` as a column, and when to
  enable the retraction cascade.
- Record release per category, and the patient-chat policy.
- Enabling the recovery and sign-in flags, clinician search budgets and uniform
  refusals, the public enrollment protections, the facility selection mode, and
  each enforcement flip after its report window.
- Edge and gateway policy: the WAF clinical exemption list, per-network
  thresholds, report-only CSP and its endpoint, and rotating the Cloudflare
  origin secret.
- Platform administrator MFA, two-person approval, governed clinician
  provisioning, staff MFA and clinician sign-up.
- Patient features held behind controls: revoking access and account
  deletion. (Hospital self-activation is ported above as facility self sign-up,
  behind `provider_self_service_enabled`.)
- Facility self sign-up (ported above, switched off): the owner signs the 0086
  declaration, after the read-only preflights (no closed organization
  application without a review reason, reviewer or review time, which 0086
  refuses; one reviewer check and one control-key check; the owner of
  `platform.control_settings` and `platform.control_enabled`), then opens the
  control with the audited admin command.
- Emergency contacts (ported above, switched off): storing contacts' names and
  destinations, the alert wording, production delivery and the pilot accounts.
  Alerts also need an active `emergency` purpose of use, which 0085 seeds;
  without it break-glass is refused.
- Duplicate active memberships for one account and facility: the read-only
  query decides whether one-membership enforcement can ship.

A default-off switch is turned on through `dev`'s Terraform for a tunable, or
by a later commit for a one-way enforcement flip; a database control through
the audited admin command. Never edit an ECS task definition by hand: the next
release stops with `LIVE_BASELINE_DIFFERS_FROM_INDEX`.

## Frontend pin after each backend release

health's production release (`config/production-release-dependencies.json` in
D-Eminence/health) names the backend commit each of its eight services was
built against, with a reviewer. It releases, and rolls back, only while the
production release index shows that commit as each service's `source_commit`;
otherwise it refuses with `REQUIRED_BACKEND_NOT_DEPLOYED`. A backend release
sets `source_commit` only for the components it deployed, and a push here
deploys (`selectComponents` in `scripts/production-backend-build.mjs`):

- every one of the 13 components, for any change under `packages/`, `scripts/`
  or `.github/workflows/production-backend-*`, or to
  `security/production-runtime-assessment.json`. Every migration wave adds its
  file to `scripts/verify-migration-ledger.mjs`, so it deploys them all;
- the service, for a change under `services/<service>/`, plus
  `database-migration` under `services/ehr-api/database/` or
  `services/ehr-api/scripts/`;
- the gateway, for a change under `gateway/`;
- nothing, for a change only under `docs/` or `infra/`, which the workflow does
  not watch.

So after every backend release, health is re-pinned to the commits it
deployed, signed by the owner, before the next frontend release. Until then
health can neither release nor roll back.

## Infrastructure

Production AWS (account `659225405023`, `eu-west-1`) is the Terraform on this
repository's `dev` branch: `infra/terraform`, which converted the regional CDK
design, with state key `health-identity/production/terraform.tfstate`. Its
changes go through `infra/terraform/scripts/production_release_infrastructure.py`,
which holds the release lease and re-baselines the release index; the operator
guide is `infra/DEVOPS_HANDOVER.md` there. The old staging stack was promoted
to production, so some production names still say staging, and there is no
separate staging stack.

A release from this branch changes only the image of each component's primary
container in its live task definition (`task_payload` in
`scripts/production_deployment_core.py`). Infrastructure changes, alarms, WAF
rules and environment switches among them, are made in `dev`'s Terraform, not
here. `infra/aws` (CDK) is not the production source, and
`infra/cloudflare`'s application and redirect Workers are not the production
frontend, which health releases; each says so in its README.

## Grants and the role bootstrap

0074 and 0076 grant to roles that already exist, which repairs production: a
release runs only `scripts/apply-migrations.mjs`. `runtime-grants.sql` revokes
every runtime grant before it applies its own, so it carries the same three
grants too, or a later role bootstrap, and every new installation (the
container acceptance and the CI migration rehearsal bootstrap after the
migrations), would remove them.

The production release used to refuse any change under
`services/ehr-api/database/` other than a new migration. It now also accepts a
modified `runtime-grants.sql` when the compatibility declaration lists it with
its SHA-256 next to at least one new migration
(`scripts/production_deployment_core.py`, `RUNTIME_GRANTS`). The release still
never applies that file, and its pending-migration check compares the plan with
the declared migrations only. Every other file there, database test suites
included, is still refused.

## Release recovery after the first deploy attempts

Both deploys of 568967b stopped at the approval step, before cloud credentials.
GitHub Actions was degraded, and its jobs API still showed finished jobs as
queued or in progress. The follow-up changes the release so this cannot block
it again, and so the reviewed migrations still deploy from a later commit:

- The approval step waits up to 20 minutes for every required job to show a
  conclusion. Any concluded job that is not a success still fails at once. The
  second check inside the deploy waits only 2 minutes.
- When a release's diff has no schema change but it includes the migration
  image, it carries the reviewed declaration in
  `config/production-schema-compatibility.json` forward. Migrations run only if
  production's pending set equals the declared files, by name and SHA-256, as
  printed by the migration plan. So 0073–0077 deploy from a commit after
  568967b, and a release that failed before migrating can be retried.
- Declared migration paths must be `migrations/NNNN_name.sql` with no
  subdirectories, and the plan is read only once all its lines have arrived.
