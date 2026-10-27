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
| main 0066 items 2-4 (3490809 / eb9b1ca) | A patient can revoke access they gave (an approved request or Access PIN use) from the Access page; emergency (break-glass) and workforce access cannot be revoked there. The access history labels emergency access and which grants the patient can revoke, and a deleted login gets no new inbox items. It differs from `main` as listed below the table | 0087, runtime-grants.sql |
| — | This branch only (item 3, owner decisions of 2026-10-26): a laboratory or pharmacy that accepted an order from another facility for someone who was not its patient ends it from its work list. Its access ends and every result it sent back is marked entered in error, or its dispensing reversed, in one transaction; the patient gets an inbox notice; support reviews every report; the ordering facility sees such orders on its Overview for 30 days. Described below the table | 0088, runtime-grants.sql |
| — | This branch only (item 4, owner decisions of 2026-10-26): the Lab and Pharmacy work lists and Incoming say whether the facility receives orders from other facilities now and whether any wait or are held there; support's order lookup says when the receiving facility's access ends and whether Close would act now; support's facility summary says what the facility is as a destination. Read-only: nothing is written and no audit row is added. Described below the table | 0089, runtime-grants.sql |
| — | This branch only (D17, owner decisions of 2026-10-26): a laboratory or pharmacy that finds out after an order ended, or its window lapsed, that it accepted the order for someone who was not its patient finds it by its reference and withdraws what it recorded on it, until 180 days after acceptance, at most 5 a member and 20 a facility in 24 hours. Every result it recorded is marked entered in error (or its dispensing reversed) as item 3 does; its access to the patient's records is never reopened; the patient, the ordering facility and support are told; support cannot mark such a report reviewed without the DPO referral (and the call to the ordering facility) where something had come back. Described below the table | 0090, runtime-grants.sql |
| — | This branch only (D18, owner decisions D18-1 to D18-15 of 2026-10-27): a laboratory or pharmacy that accepted an order from another facility and cannot complete it ends it itself with one fixed reason ("We can't complete this order"), stating that the person was the order's patient. The order ends `cancelled` / `receiving_unable`; nothing more can be recorded on it; the facility keeps reading it for 7 days only if it had opened an accession; the clinic sees why, the patient gets a "couldn't complete" notice, support sees per-facility counts; at most 20 a staff member (counted by account, at every facility) and 50 a facility in 24 hours. A checked result must be released first and a possibly critical value phoned first. Described below the table | 0091, runtime-grants.sql |

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
  and Identity checks it before any write. The table has no INSERT policy, so
  the seed reads the table's FORCE row-level security setting and, only if it
  is on, lifts it for its own insert and restores it, as `main`'s 0098 does; a
  table without FORCE is left without it (review fix R8: turning FORCE on
  where an operator had lifted it would make every accountless control read
  fail under an owner that does not bypass row-level security, closing every
  portal). `services/ehr-api/scripts/test-staging-schema-upgrade.mjs` checks
  that a release changes no existing table's row-level security or FORCE
  setting, also from a baseline with FORCE lifted on `platform.control_settings`,
  where the Identity runtime must still read the controls. The control is read
  from Identity's accountless context
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
  tables"; 0086 refused to run if the live body pruned anything else), and a
  later replacement of `platform.consume_qoreid_quota` must keep 0086's
  refusal of an unreviewed self-signed-up organization's `existing_cac`
  lookup (R7; 0086 refused to run unless the live body was 0049's).
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
- A7 with C8, and review fixes R4 and R5: the public application quota is
  charged once per start, in its own committed transaction before the submit,
  and not again when the same start sends the email code. So a start the
  submit refuses (409 `PROVIDER_ENROLLMENT_REQUIRES_REVIEW`) also costs one of
  the 10 an hour and 30 a day. It is keyed by the client network (an IPv4
  address or an IPv6 /64, the CAC lookup's key), not the raw address, so
  rotating IPv6 addresses inside one allocation resets neither quota. Owner
  re-decision available: #81's 409 `PROVIDER_ENROLLMENT_REQUIRES_REVIEW` tells
  any caller who passes Turnstile whether a CAC and product already has a
  governed or self-service application or is registered (the governed public
  intake answers the same `{accepted}` whatever exists); the quota now bounds
  such probes, and a uniform answer with no code sent is the alternative.
- R5: at most 10 emailed codes a day reach one administrator email across
  every self-service application (`identity.begin_self_service_provider_enrollment`,
  on top of 0056's 60 seconds, 5 an hour and 15 a day per application). Past
  any of these limits start sends nothing and says so (R14 below).
- R17 (second review): 0056's `identity.begin_organization_profile_completion`
  sent a code for any open, verified application of a CAC number, product and
  email, whatever its approval mode, and the public self-service lookup now
  verifies applications whose email the submitter chose, so the governed
  completion route (`POST /api/v1/identity/organization-applications/completion/start`,
  on the public site) and a rolled-back Identity could send codes for
  self-service applications outside R5's 10 a day per email (15 a day per
  application instead) and without R6's stored details. 0086 moves 0056's body
  into the owner-only `identity.issue_organization_profile_completion_code`,
  which sends only for the approval mode its caller names, and replaces the
  governed command (its signature, owner and grants kept; 0086 refuses to run
  unless the live body is 0056's) so that it sends only for governed
  (`admin_review`) applications, answering NULL for a self-service one exactly
  as for none; the self-service command calls the helper for self-service
  ones. The governed route's answer stays uniform, so nothing new is
  disclosed. A later replacement of the governed command must keep this.
  Not changed: the governed route's public application quota stays keyed by
  the raw address, as on `main` (it no longer reaches self-service
  applications).
- R6: the administrator name and organization type the activated account,
  staff record and application keep are those sent with the request whose
  emailed code opened the activating session (stored on its challenge), not
  those of whichever request opened the application; `main` keeps the
  first submitter's.
- A8 with C9 (owner, Q3), and review fix R3: an unactivated self-service
  application lapses 24 hours after it was submitted. The next submit for its
  CAC and product by another email, on the self-service or the governed path
  (the stale application's own email resumes it instead, without renewing
  it, so a squatter cannot extend its hold), rejects it (reviewed_at,
  the reason "Self-service application lapsed: not activated within 24 hours of
  submission", no reviewer, row_version bumped), invalidates its email codes and
  completion sessions, audits `identity.organization.self-service.lapse` and
  opens a new application. An activated application and a governed application
  never lapse. `main` never expires these rows. The governed submit still
  returns a fresh (under 24 hours) self-service application for the same CAC
  and product, as before (follow-up below). R3: the application keeps the keyed
  digest of the network that opened it. R15 (second review) replaced the first
  review's 7-day refusal after any closure, which locked real applicants out:
  the submit lapsed the stale application and then refused itself because of
  that same lapse, so the failed submit rolled the lapse back and an
  applicant who had mistyped the email could never start again from the
  office network, and support's rejection only started the 7 days. Now:
  - a lapse refuses no one. Instead a hold is not renewed: a new application
    whose email or network already had a self-service application for the
    CAC and product closed in the last 7 days (lapsed, including the one this
    submit has just lapsed, closed by the system or by support) is opened
    without a hold (`self_service_without_hold`): anyone else's submit lapses
    it at once (reason "Self-service application lapsed: opened without a
    hold and replaced by another sign-up"), though its own email can still
    finish it. A squatter that resubmits from its own network with a new email
    therefore gains nothing, while a mistyped email corrected from the same
    network after 24 hours is accepted;
  - only support sets a refusal: a rejection or release refuses the closed
    application's email and network for 7 days
    (`self_service_refusal_ends_at`; 409 `PROVIDER_ENROLLMENT_REQUIRES_REVIEW`,
    as any conflict) unless support lets the applicant retry (`allowRetry`),
    and support can waive a refusal in force for a CAC number and product
    (`identity.admin_waive_self_service_refusals`, `POST
    /api/v1/admin/self-service-applications/waive-refusal`, audited
    `admin.self-service-application.refusal-waive`);
  - the activation pre-check's `email_registered` closes the application (no
    reviewer, the reason "Self-service application closed: its administrator
    email already belongs to an account", no refusal, its other codes and
    sessions ended, audited `identity.organization.self-service.close`), so
    the applicant can start again at once with another email.
  Residual: a stranger who lapses a real applicant's stale application holds
  the CAC for 24 hours (the documented squat); after that the applicant's own
  email and network are accepted, without a hold, so an active stranger can
  keep lapsing it, each time paying a Turnstile solve and a public
  application quota unit; support's rejection (refusing the stranger's email
  and network) is the remedy.
- A9 with review fix R1: before hashing the password, activation runs
  `identity.prepare_self_service_provider_activation` in its own committed
  transaction. It refuses a token that names no live session (401), charges
  one of the session's 5 attempts (the 6th ends it, 401), and answers an
  activation that can never succeed (email already registered 409
  `PROVIDER_EMAIL_ALREADY_REGISTERED`, which also closes the application, R15;
  CAC bound, legal name used or the application not a ready self-service one,
  409 `ORGANIZATION_REVIEW_REQUIRED`) at once, ending the session. So a session costs at most 5 argon2id hashes,
  and an activation certain to fail costs none. It reads the control after
  locking the session.
- A10: activation sets the account's `email_verified_at` and
  `password_changed_at`.
- A11: submit takes the governed submit's lock key `org-application:` and
  activation the governed approval's `org-cac:`, so the two paths serialize on
  one CAC (`main` uses `self-service-org-` keys).
- A12 with review fix R10: `GET /api/v1/identity/provider-enrollments/availability`
  answers `{ open: true }`, `{ open: false, reason: 'closed' }` when sign-up is
  switched off or not configured, and `{ open: false, reason: 'unavailable' }`
  on any fault, never an error, so the page can say "try again shortly" rather
  than "not open" during an outage.
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
  pharmacy administrator gets the provider portal, and since P4b (below) it
  invites its staff after support's review. A second product for an already registered CAC goes to admin review
  (owner, Q8), and one email cannot be both a patient account and a facility
  administrator (409, owner, Q7).
- Support's review (owner, Q1, "alert + daily review"): three review columns on
  the application (`self_service_reviewed_at`, `self_service_reviewed_by_account_id`,
  `self_service_review_note`, all set together, only on an approved
  self-service application) and two commands,
  `identity.admin_list_self_service_facilities` (`platform.identity-review.read`)
  and `identity.admin_review_self_service_facility` (`platform.facility.manage`,
  and since P4b also `platform.facility.unlock`; the review now records the
  administrator's role and evidence and unlocks the facility, below),
  served as `GET /api/v1/admin/self-service-facilities` and
  `POST /api/v1/admin/self-service-facilities/:applicationId/review`. Unlike
  the governed application commands they need no facility membership, so a
  standalone platform administrator can use them, as 0064's commands; the
  review is audited as the platform administrator
  (`admin.self-service-facility.review`). Suspending the facility and
  disabling the account use the existing commands. The unreviewed list is
  oldest activation first, so none is hidden behind 200 newer ones (R12); the
  reviewed and all lists are newest first. `main` has no review.
- R2: support's release of a fraudulent sign-up,
  `identity.admin_release_self_service_facility` (`platform.facility.manage`),
  served as `POST /api/v1/admin/self-service-facilities/:applicationId/release`
  (`If-Match`, `{ reason }`). Suspend and disable stop an impostor but leave
  the CAC bound, the product registered, the application approved and the
  organization holding the company's legal name, so the real company could
  neither sign up nor be approved by review. Once every facility of the
  organization is inactive and the administrator's account is disabled
  (otherwise 409 `SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION`), the
  release closes the application, removes the CAC binding, suspends the
  products, deactivates the organization and renames it "Released self
  sign-up <id>" (out of the legal-name checks), revokes the facility roles and
  memberships, deactivates the staff record and audits
  `admin.self-service-facility.release`; the list shows it as handled.
- R3: support's list of open self-service applications,
  `identity.admin_list_open_self_service_applications` (`GET
  /api/v1/admin/self-service-applications`) and its rejection,
  `identity.admin_reject_self_service_application` (`POST
  /api/v1/admin/self-service-applications/:applicationId/reject`, `{ reason,
  allowRetry? }`), both without a facility membership. R16 (second review):
  the list was oldest first, at most 200, with no total, and every start with
  a made-up CAC number leaves an open row that nothing lapses, so about 200
  junk rows hid a live squat. It now lists the applications that hold a CAC
  now first (`holdsCac`), verified ones first within each group, then the
  newest, with `total` (all matching open rows), and support can search one
  exact CAC number (`POST /api/v1/admin/self-service-applications/search`,
  `{ cacRegistrationNumber }`, in the body to keep it out of access logs, as
  the principal search). Not done: closing never-verified rows outside a
  submit.
- R7 (CRITIC C13): an organization that signed itself up makes no
  organization CAC lookup (`POST /api/v1/identity/organizations/verification/cac/:context`,
  403 `PERMISSION_DENIED`, nothing charged) until support has reviewed it, so
  an unreviewed facility cannot spend paid lookups outside the 200-a-day cap.
  0086 replaces `platform.consume_qoreid_quota` with 0049's body plus that
  refusal.
- A mistyped CAC number can register another company. QoreID's lookup proves
  that the number belongs to a real, active company, not that the applicant
  works there, and the emailed code proves only the applicant's own mailbox.
  An applicant who mistypes a digit and lands on another company's number
  would, at activation, register that company under its verified legal name,
  with the applicant as its administrator and the CAC number bound to it, so
  the company itself could then neither sign up nor be approved by review.
  `main` has the same exposure and shows nothing before the account is made.
  This branch mitigates it three ways: the confirmation read (R13 below), so
  the password step says "You're registering <verified legal name>, CAC number
  <as entered>" and offers "This isn't my organization" before any account
  exists; support's daily review of every activated self sign-up (owner
  guard), whose console tells support to treat a legal name that is not the
  administrator's own organization as a wrong sign-up; and support's release
  (R2), which frees the CAC number and the legal name once the facility is
  suspended and the account disabled. The administrator email is not freed
  (below).
- R13 (the website's second contract): `GET
  /api/v1/identity/provider-enrollments/profile` answers, for the enrollment
  cookie that verify set, `{ organizationName, registrationNumber,
  productCode, organizationType, administratorName, administratorEmail }`:
  the verified legal name the activation will register, the CAC number as
  entered, and the product, organization type and administrator the account
  will keep (R6: those of the code that opened the session). It is served by
  a new read-only command, `identity.current_self_service_provider_enrollment(char)`,
  which needs the control, locks nothing, charges no activation attempt and
  ends no session. 0056's `identity.current_organization_profile_completion`
  was not reused: it has no administrator name, email or type, it answers
  the governed review profile's name rather than the one the activation
  registers, and it answers a governed application's session too. The route
  checks the signed-in browser (409) and the gate (423) as the others do; no
  live session of a ready self-service application answers 401
  `ORGANIZATION_COMPLETION_SESSION_INVALID`. It takes no Origin header,
  because browsers send none on a same-origin GET: the cookie is the guard
  (HttpOnly, SameSite=Strict, host-only and scoped to
  `/api/v1/identity/provider-enrollments`), CORS lets only HID's own origins
  read the answer, and a disallowed Origin is refused before any route runs,
  as 0056's own `GET …/completion/profile` already relies on. `main` has no
  such read.
- R14 (the website's second contract): start says when it sent no code.
  `begin_self_service_provider_enrollment` returns null both when a limit
  holds the code back and when the application is no longer open, and start
  used to answer `{ accepted, challengeId, expiresInSeconds: 600,
  resendAfterSeconds: 60 }` either way, with a challenge that did not exist,
  so the page said a code was sent when none was and the code that was in
  force could no longer be entered. Start now runs the new read-only
  `identity.self_service_provider_code_state(text,text,text)` in the same
  transaction and answers 200 `{ accepted: true, codeSent, challengeId?,
  expiresInSeconds?, resendAfterSeconds }`: `codeSent: false` names the code
  still in force (the newest that can still be entered, as the recovery
  start's cooldown names its earlier challenge), when there is one, and the
  seconds until a start can send a new one under 0056's 60 seconds, 5 an hour
  and 15 a day and R5's 10 a day per email; after a sent code
  `resendAfterSeconds` is that same wait (60 normally, up to an hour after the
  5th code of an hour). An application that closed since start read it (it
  was activated, lapsed or rejected meanwhile) answers 409
  `PROVIDER_ENROLLMENT_REQUIRES_REVIEW`, as a retry would. The shape is a 200
  with a field, not a 429, because the start was accepted and charged, the
  answer carries the code in force, and this branch's problem details carry
  no extension members or `Retry-After`. It is additive: a page that ignores
  `codeSent` still verifies the code in force. Telling the caller that no code
  went out reveals nothing new: start has already confirmed the application to
  this caller, and R5's wait can only say that the email received 10
  self-service codes in a day. The governed completion's start keeps its
  uniform answer. `main` answers as this branch used to.
- A released wrong sign-up keeps its administrator email (a decision, not
  built): the disabled account keeps the address and the deactivated staff
  record keeps it too (`staff_email_ci_uq` covers every staff row), and both
  activation and governed approval refuse an email held by any account that is
  not deleted or by any staff record. A command that frees it was evaluated
  and not built, because it is not both small and safe: (1) it may touch only
  an account that did nothing beyond activating, and that cannot be
  established from a few tables: an account and its facility are referenced
  by 101 foreign keys to `auth.accounts` and 53 to `identity.facilities` across
  the identity, auth, audit, EHR, lab, pharmacy, OCR, outreach, notification,
  migration and platform schemas, so a check that misses one would detach an account from
  records it wrote; (2) freeing needs two changes no command makes today:
  rewriting the staff record's email (NOT NULL, unique across all staff rows)
  and removing the account's email or setting it to `deleted`, a status no
  admin command sets and whose handling by sign-in, recovery and the principal
  lists is unverified; (3) undoing it means restoring an address someone may
  have used since. Support's procedure instead: confirm with the organization
  that the sign-up named the wrong company; suspend the facility
  (`POST /admin/facilities/:id/status`), disable the account
  (`POST /admin/principals/:id/status`) and revoke its sessions
  (`POST /admin/principals/:id/sessions/revoke`); release it
  (`POST /admin/self-service-facilities/:applicationId/release`), which frees
  the CAC number and the legal name at once; then the administrator signs up
  the right organization with the correct CAC number and another email address
  they control (another mailbox of the organization). The released email's
  7-day refusal (R3) applies to the released CAC number and product only, not
  to a correct CAC number; where the release concerns the right company
  signed up with the wrong email, support releases it with `allowRetry`, so
  the company's network is not refused (R15), or waives the refusal later.
  If an organization must use that same email, that is an owner decision and
  a reviewed one-off database change, not a support action.
- Round-1 review fixes, each absent on `main` and recorded above: R1 the
  activation pre-check and its 5-attempt budget (A9); R2 support's release; R3
  the own-email resume, the submitting network, the 7-day refusal and support's
  open-application list and rejection (A8 and R3); R4 the public application
  quota charged before the submit (A7); R5 10 codes a day per email; R6 the
  proving code's administrator details; R7 no organization CAC lookup before
  support's review; R8 the seed keeps FORCE as it finds it (A1); R9 the
  declaration's text (no behaviour); R10 availability's `reason` (A12); R11
  the verifier drives the database's own gate (verifier bullet below); R12
  the unreviewed list oldest first (support's review). The integration step's
  fix is also this branch's only: support's review command answers only its
  23505 as `SELF_SERVICE_FACILITY_ALREADY_REVIEWED`, and any other integrity
  refusal (23514) as 503 `SELF_SERVICE_FACILITY_UNAVAILABLE` (`main` has no
  review command). R13 and R14 above come from the website's second contract.
  The second review's fixes, also absent on `main`: R15 a lapse refuses no
  one, a renewal from the same email or network holds nothing, support's
  rejection or release refuses for 7 days unless it lets the applicant retry,
  support's waiver, and the registered email closing its application (A8);
  R16 the open list ranked, counted and searched (R3); R17 the governed code
  command serving governed applications only (R5).
- The ported database suites run from `services/ehr-api/test/database/`
  (`provider-self-enrollment`, `provider-self-service-cac-quota`,
  `provider-self-service-control`, `provider-self-service-lapse`,
  `self-service-facility-review` and `provider-self-service-rollback`, which
  runs the previous Identity's own SQL on the new schema), with the review
  fixes' `provider-self-service-activation`, `self-service-facility-release`
  and `self-service-open-applications`, and R13's and R14's
  `provider-self-service-confirmation`.
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
  held session. It also proves the review fixes: the database's own gate
  through Identity (a start parked on the public application quota, and an
  activation parked on its session's row, while the control is closed, answer
  423 from the database's refusal with nothing written; R11), the activation
  pre-check and its 5-attempt budget, the details of the code that proved the
  mailbox, the charge of a refused start and the IPv6 /64 key, the squatter's
  own resume and network, support's release followed by the real company's
  sign-up, the open-application list and rejection, and availability's
  reason; and R13 and R14: the confirmation read with no Origin (its 401s,
  409, 423 and the proving code's details, nothing charged), and start's
  `codeSent: false` within the 60 seconds (naming the code just sent, which
  then verifies), after the code was used (no code named), at the hour's
  limit (naming the 5th code, which verifies) and at the email's 10 a day,
  with nothing delivered, and 409 for an application support rejected while
  its start waited. For the second review it proves: the registered email's
  application closed and a new email accepted at once from the same network;
  the governed completion route (on the public site's origin) answering its
  uniform 200 with nothing delivered or stored for a self-service
  application; the squatter's renewal from its own network accepted without a
  hold and lapsed at once by the real company, which gets the hold; the open
  list ranked with its total and the CAC number search; the waiver (403, 400,
  200, then 404) followed by the office's sign-up; and a retry rejection
  followed by the corrected email from the same network. Unlike `main`'s, it can also run against a disposable copy of a
  database on a loopback test cluster (`HID_PROVIDER_RUNTIME_LOCAL_CLUSTER=loopback`,
  `NODE_ENV=test`), which proves the same flow on a database built in
  production's order.
- `POST /auth/login` and the activation set the session cookies through one
  helper, `setSessionCookies` (`AuthController.setCookies` is a pure extraction
  of it, C18), so the two cannot drift.
- R15 to R17 are proved by `self-service-open-applications` (the typo
  corrected from the same network, the squatter's renewal, the stranger's
  lapse, the retry rejection, the waiver, and 210 stale rows beside one live
  squat), `self-service-facility-release` (the release's refusal and its
  `allowRetry`), `provider-self-service-activation` and
  `provider-self-enrollment` (the registered email's closure),
  `provider-self-enrollment` and `provider-self-service-rollback` (the
  governed command, and the previous Identity's completion start, send
  nothing for a self-service application, with the control on and off), and
  by the verifier (below).
- Follow-ups, each its own decision: the governed submit still attaches a
  governed applicant to a fresh self-service application for the same CAC and
  product, and the admin application list does not show `approval_mode`; the
  governed admin commands still need a facility membership (`0046`), so a
  governed public application can hold a CAC and product until an
  administrator with a membership rejects it; staff MFA, once ported, must
  say what it does to these administrators and to the staff they invite;
  once support has reviewed a self-signed-up organization, its
  administrator's organization CAC check is charged to that account's 0049
  quota (5 an hour, 15 a day, 10 a day per organization), outside the
  200-a-day self sign-up cap; and a released sign-up's account keeps its
  email (the decision and support's procedure are above). A self-signed-up
  facility is no longer limited to one user: its administrator invites staff
  after support's review (P4b, below).
- The website already has what this branch's backend answers for P4 (health
  at `8d40891`, P4's website build): the console's release and
  open-application pages, with the reject and release forms' `allowRetry`,
  the waiver, the CAC number search and the total; the sign-up page's use of
  availability's reason and start's `codeSent`; and the copy R15 and R16
  call for: the `PROVIDER_EMAIL_ALREADY_REGISTERED` panel (the sign-up is
  closed; start again with another email), the
  `PROVIDER_ENROLLMENT_REQUIRES_REVIEW` text (a refusal follows only
  support's rejection or release), the kept details' 24-hour note, and the
  open-applications panel's `holdsCac` and `lapsesAt` (equal to the
  submission time for an application opened without a hold). Nothing further
  is needed on the website for P4's backend.

Full access after support's review, and facility staff invitations (P4b, in
0086's section 5, which follows P4's sections and precedes the grants and the
control section, still last). `main` has neither: it reviews every clinician
independently (its 0087-0098) and its self-signed-up administrator holds
`org_admin` at once. Owner decisions of 2026-10-25 (P4b's Q1-Q7) are marked
"owner". The Identity, notification-api and website parts are recorded by
their builds; the items Identity carries are listed here too.

- R18 (P4 leftover), "This isn't my organization":
  `identity.withdraw_self_service_provider_enrollment(char)` (Identity's
  accountless `system:auth` context; `POST
  /api/v1/identity/provider-enrollments/withdraw` with the enrollment cookie).
  From a live completion session of an open self-service application it
  closes the application (rejected, no reviewer, the reason "Self-service
  application withdrawn by its applicant", no refusal), ends every code and
  session of it and audits `identity.organization.self-service.withdraw`
  (system; `{productCode, previousStatus}`), answering `withdrawn`; no live
  session answers `session_invalid` and changes nothing, and a session whose
  application is no longer open answers `session_invalid` and is ended. It
  reads the control after locking the session (55000 with the control off)
  and sets no 7-day refusal: like any closure, a new application of that
  email or network for the same CAC number and product within 7 days opens
  without a hold (R15), so a squatter cannot renew a hold by withdrawing.
  Suite: `provider-self-service-withdrawal`.
- The restricted role. Activation grants `org_admin_awaiting_review` (new;
  `workforce.manage`, `audit.read` and the four outreach registration and
  campaign permissions, each one `org_admin` already holds) instead of
  `org_admin`, after recording the approval; the membership stays named
  `org_admin`. A self-signed-up organization is pending (activated, not yet
  reviewed), reviewed, or released (`identity.organization_self_service_state`,
  read by Identity's staff context as `facility.selfService`; governed and
  legacy organizations have no row and are unaffected).
- The review gate: a trigger on `auth.account_roles`
  (`account_roles_review_gate`, before insert or update of the role, scope,
  facility, membership or revocation) refuses any facility role but the
  restricted one at a pending organization (P0001 `FACILITY_REVIEW_PENDING`),
  any facility role at a released one (`FACILITY_RELEASED`), and the
  restricted role anywhere else (`FACILITY_REVIEW_ROLE_INVALID`). It also
  refuses the owner and every runtime, so no other path (a governed second
  product's approval, owner SQL) can hand a pending facility clinical access.
- Before review the administrator may record its own licence
  (`identity.record_self_service_administrator_licence`, audited
  `identity.facility-administrator-licence.record`); the facility sees only a
  number hint (its last four letters or digits). Every staff write before
  review answers `FACILITY_REVIEW_PENDING`.
- Support's review unlocks (`identity.admin_review_self_service_facility`,
  now seven arguments): it needs `platform.facility.unlock` (new; granted to
  `platform_admin`, `platform_super_admin` and `facility_review_admin`, so
  `identity_review_admin` + `facility_review_admin` make a least-privilege
  reviewer) besides `platform.admin.access`, `platform.facility.manage` and
  the healthcare-operations purpose; it records the administrator's role
  (`none`, or the role the organization type and product allow, §3.6 of the
  P4b spec: doctor at a clinic or hospital, `lab` at a laboratory, pharmacist
  at a pharmacy, none for `other`), the verification method and, for a
  clinical role, a licence of the matching body (owner Q2: a licence is
  required unless support grants none); it revokes the restricted role,
  grants `org_admin` (and the clinical role, with a `platform_review`
  attestation), bumps the membership's version, signs the administrator out
  everywhere (`facility_reviewed`) and audits
  `admin.self-service-facility.review` (platform; role, method, licence body,
  membership and sessions revoked) and `identity.facility-access.unlock`
  (system, the facility). A suspended facility, a disabled account or a
  missing membership answers 23514 with nothing written.
- After review support can change the administrator's role
  (`identity.admin_set_self_service_administrator_role`, the same evidence,
  sessions revoked `facility_access_changed`, audited
  `admin.self-service-facility.administrator-role`, whose details keep the
  change's verification method (the application keeps the review's), and
  `identity.facility-access.change`) and end the first 30 days early
  (`identity.admin_end_self_service_probation`,
  `admin.self-service-facility.probation-end`).
- The first 30 days after review (owner): at most 5 break-glass grants per
  facility in a rolling 24 hours (trigger `consent_grants_self_service_probation`
  on `identity.consent_grants`, created in 0086 section 6.7 under its NOWAIT
  lock and serialized per facility by an advisory lock, P0001
  `EMERGENCY_PROBATION_LIMIT`; Identity
  answers 429 `EMERGENCY_PROBATION_LIMITED`, and a rolled-back Identity its
  429 `EMERGENCY_RATE_LIMITED`), and invitations limited to 10 a day and 20
  emails a day (30 and 60 after). A replayed break-glass reuses its grant and
  is never refused.
- Staff invitations (`staff_invitations_enabled`, new, seeded off; owner Q1:
  one release with P4): three tables (`identity.staff_invitations`,
  `identity.staff_invitation_sends`, `identity.staff_licence_attestations`)
  and `identity.staff_attestation_texts`, all with forced row-level security,
  no runtime privilege and no-mutation or guarded-column triggers. A reviewed
  self-signed-up facility's administrator invites by name, email and role
  (the roles its type allows, with a licence and the facility's attestation
  for a clinical role: the facility vouches for its clinicians, where `main`
  reviews each independently); secrets are stored only as keyed hashes
  Identity computes (a link token, a typed code bound to the email, an open
  session); limits per facility (100 pending; 30 invitations and 60 emails a
  day), per recipient (3 invitations and 8 emails in 30 days from one
  facility; 5 emails a day across facilities, beyond which the email is
  silently not sent) and per
  invitation (5 sends, 60 seconds between them, valid 7 days); 10 sends
  that failed definitively in 24 hours pause the facility's invitations. Commands: create (idempotent per inviter, facility
  and key), record the delivery, resend, revoke, list, the page's state; open
  (link or typed code; 10 wrong tokens lock an invitation, 5 wrong codes stop
  typed mode until a resend), prepare (5 attempts), accept with a password
  (`new` creates the account, staff record and membership; `dormant_staff`
  resets the password, bumps the token version, revokes every session and
  reuses the ended membership), and the signed-in preview and accept for
  existing staff on their own host (no facility, no permission; one staff
  audit row at the inviting facility on success and none on a refusal). A
  patient account, a platform account, an inactive or unverified staff record
  and an account that cannot sign in are refused. `identity.staff.license_number`
  is never written; the licence lives in the attestation, and the facility
  and the invitee see only its hint. Support reads a facility's staff and
  finds an invitation by the reference in the email
  (`identity.admin_list_facility_staff`, `identity.admin_find_staff_invitations`,
  `platform.principal.read`).
- Staff management: the administrator lists its own facility's members,
  ends a membership (roles revoked, pending access requests expired, active
  consent grants revoked with one `identity.consent-grant.close` row each,
  not the administrator's own or another administrator's) and changes a
  member's role (with a new attestation). Each is audited at the facility.
- Release (R2) now also revokes the organization's pending invitations, ends
  its memberships before revoking their roles, revokes their active consent
  grants (one system `identity.consent-grant.close` row each, V2), expires
  pending access requests and revokes the sessions of accounts left with no
  active membership; the counts are in the release's audit details.
- One lock order for every P4b writer and both triggers: the organization's
  self-service application row first (release FOR UPDATE, support's review
  and changes FOR NO KEY UPDATE, staff commands and the gate FOR SHARE), then
  facility and membership rows, then the advisory locks
  `staff-invitations:<facility>`, `staff-invitation-recipient:<email>` and
  `account-email:<email>`, then account rows. A two-connection harness
  (outside the release's suites, which roll back) shows an accept or prepare
  waiting behind a release answer withdrawn or invalid, a role change and a
  release in either order leave no role on an ended membership, and a review
  and an account disable in either order grant nothing to a disabled account,
  with no deadlock.
- Identity's P4b items (its build records the detail): the staff context's
  `facility.selfService` (`{ review: 'pending'|'reviewed', organizationType }`,
  only at a self-signed-up facility; the previous membership query is
  wrapped unchanged, with one definer state read per membership row);
  password re-entry for invite, role change and removal (the sign-in check
  and lockout, against the session's own account; 403
  `STAFF_REAUTHENTICATION_FAILED`, counted as a failed sign-in); the
  recovery hold (403 `STAFF_RECENT_RECOVERY_HOLD`) on invite, resend and role
  change within 24 hours of an OTP recovery, not on removal or revocation (a
  future hold on other staff commands takes the same marker); the
  invitation email through notification-api's fixed template, with no
  person's name, the facility name dropped when it looks like a domain and
  the origin from the deployment; Turnstile action `staff-invitation` on
  `app.` and `staging.` only; 429 `EMERGENCY_PROBATION_LIMITED`;
  emergency-contact alerts drop a domain-like clinician name everywhere
  (V1); the withdrawal route. The website treats a 404 from any new route as
  "not available yet". Routes: support's review now answers `grantedRole`
  and `sessionsRevoked` and needs `platform.facility.unlock`; new
  `POST /api/v1/admin/self-service-facilities/:id/administrator-role` and
  `.../end-probation` (If-Match); the staff routes `GET
  /api/v1/identity/facility-staff`, `POST .../facility-staff/administrator-licence`,
  `POST .../staff-invitations` (Idempotency-Key), `.../:id/resend`,
  `.../:id/revoke`, `POST .../facility-staff/:membershipId/end` and
  `.../role` (`workforce.manage`, the body's `expectedVersion`); the
  signed-in `POST .../staff-invitations/signed-in/preview` and `.../accept`
  (no facility header, no permission, no interceptor row: a refusal writes
  no facility audit row, only the guard's facility-less denial for a bad
  Origin or CSRF token, as on every route); the public `POST
  .../staff-invitations/open` and `.../accept` (the `hid_staff_invitation`
  cookie; no session is issued); support's `GET /api/v1/admin/facilities/:id/staff`
  and `GET /api/v1/admin/staff-invitations?reference=` (`platform.principal.read`,
  audited on success). notification-api gains `POST
  /api/v1/notifications/staff-invitation` (fixed fields, email only); an
  older notification-api answers 404, which Identity records as a
  definitive failure, so invitations are switched on only after the
  all-13 release. Its typed-code sentence reads "go to {page} and enter this
  email address and the code", without the spec's 'choose "I have a code"':
  the page opened without a link shows the code form at once and has no such
  button (found by the integration build's comparison with the website).
  Identity's choices the spec left open: a replayed invite answers
  `deliveryOutcome: 'unknown'` (the command keeps no outcome for a replay); a resend reads the invitee's email from the facility's own list
  (pending plus 30 days), so an invitation that expired more than 30 days
  ago answers 404; the attestation version is the constant
  `facility-staff-attestation-v1` (a new text needs an Identity change); a
  401 from notification-api is `unknown`, not a definitive failure, so it
  never counts towards the delivery pause; a receptionist's licence fields
  may be absent or null; support's staff read answers flat rows with
  `attestedByAccountId` and `attestedByName`, and 404
  `ADMIN_FACILITY_NOT_FOUND` for an unknown facility; the new Identity calls
  `identity.organization_self_service_state` on every staff request, so it
  needs 0086 (the release applies migrations before services).
- Deviations from `main` (besides the owner's, below): the licence bodies
  MLSCN and PCN, whose number formats no repository states (the pattern is
  the general one); no licence expiry is collected; duplicate licence
  numbers are not refused (support sees `sameLicenceElsewhere`). "Governed
  clinician provisioning" stays on the not-ported list.
- Limitations: one administrator per facility (no invitable role manages
  staff; support changes the administrator's clinical access); no staff MFA;
  a laboratory's work comes only from tests ordered at the same facility and
  a pharmacy sees only prescriptions written there, until cross-facility
  orders (P4c); a governed second product for a self-signed-up company needs
  support's review of the sign-up first (the governed approval reuses the
  organization only through an active `org_admin` row).
- Locks until commit (measured with `pg_locks` on a copy of the 0085
  production-order database, four runs): besides P4's, SHARE ROW EXCLUSIVE
  (writes wait, reads do not) on `auth.account_roles` and
  `identity.consent_grants` (the triggers), `auth.roles`, `identity.facilities`,
  `identity.staff` and `identity.staff_facility_memberships` (foreign keys of
  the new tables); no new ACCESS EXCLUSIVE on an existing table. The whole
  migration took 138-169 ms on an empty database in eight runs (P4's alone
  53-80 ms), its control section 3.1-5.4 ms.
- Preflights before signing (read-only; P4's P1, P2, C2, R8 and R17 still
  apply): PF1 `select count(*) from auth.roles where code =
  'org_admin_awaiting_review'` and `select count(*) from auth.permissions where
  code = 'platform.facility.unlock'` must both be 0 (0086 inserts them without
  ON CONFLICT, so an existing row stops the release); PF2 `select tgname from
  pg_trigger where tgrelid in ('auth.account_roles'::regclass,
  'identity.consent_grants'::regclass) and not tgisinternal` shows neither
  `account_roles_review_gate` nor `consent_grants_self_service_probation`;
  PF3 `select a.email, r.role_code from auth.account_roles r join
  auth.accounts a on a.id = r.account_id where r.scope_type = 'platform' and
  r.revoked_at is null`: each support reviewer holds `platform_admin`,
  `platform_super_admin`, or `identity_review_admin` + `facility_review_admin`
  (remedy: grant the last two, never `platform_admin` for this purpose); PF4
  capture one governed staff member's `GET /api/v1/auth/session` facility
  block, to compare after the release; PF5 the migration login owns, or holds
  TRIGGER and REFERENCES on, `auth.account_roles`, `auth.roles`,
  `auth.role_permissions`, `auth.permissions`, `auth.accounts`,
  `identity.staff`, `identity.staff_facility_memberships`,
  `identity.facilities`, `identity.organizations`,
  `identity.organization_applications` and `identity.consent_grants`
  (`select c.oid::regclass, pg_get_userbyid(c.relowner) from pg_class c where
  c.oid in (...)`); PF6 `select account_id, facility_id, count(*) from
  identity.staff_facility_memberships where active group by 1, 2 having
  count(*) > 1`, for the record (`main`'s N5; nothing in P4b depends on it).
- Rollback: switch `staff_invitations_enabled` and
  `provider_self_service_enabled` off first (the previous console accepts only
  the six old keys). The previous Identity (57a94db) works on the new schema:
  it calls no new command; it resolves restricted, reviewed and invited
  members' permissions from their role rows as before; it can no longer give
  an unreviewed self-signed-up administrator an organization CAC lookup (no
  `organization.manage`, 42501 `QOREID_QUOTA_PERMISSION_DENIED`, its 403);
  the probation trigger keeps capping break-glass (its 429). The rollback
  suite runs its own SQL, including its staff-context query and a governed
  approval.
- Deviations from `main`, each the owner's: facility vouching instead of an
  independent clinician review; the administrator's clinical role resting on
  support's review and a recorded licence (Q2); invited clinicians reach
  patient records with a password only (staff MFA deferred); Outreach intake
  before review; `facility_review_admin` gains `platform.facility.unlock`.
- Follow-ups: NIN enablement needs a re-review of self-service access
  (`identity.registration.write`, held by `org_admin`, nurses and
  receptionists, engages the policy that reads every patient row); cross-facility
  lab orders and prescriptions are the next change (P4c), and a stand-alone
  laboratory's or pharmacy's workspace has no orders until then; invitation
  data retention (a purge of invitee names and emails after 90 days, S22e)
  is a separate change; registry checks of licences are not built.
- Runtime verifier (`services/identity-api/scripts/verify-provider-enrollment-runtime.mjs`,
  in the migration rehearsal): P4's flow with the restricted role and the
  new review, then a P4b section run as the Identity runtime over HTTP: the
  applicant's withdrawal; the pending administrator's six permissions and
  refusals (patient lookup, registration, break-glass, consent, invite); the
  review gate against the runtime role directly (no table privilege), the
  owner and a definer writer called as the runtime role, at a pending and a
  released organization; the own licence; review refusals and the unlock
  with sign-out for a hospital (doctor), laboratory (lab), pharmacy
  (pharmacist), an `other` sign-up (no clinical access, then a doctor by
  support's administrator-role change) and a least-privilege reviewer; the
  first 30 days' emergency cap and its early end; invitations closed and
  opened, the email checked by a local stub of notification-api's route
  with that route's own DTO and template; open by link and typed code with
  their counters, supersession and network limit; accept as a new account
  and sign-in on the role's host; existing staff signed in (link and typed);
  a patient's or a platform account's email; an account appearing or
  changing meanwhile; removal, dormant re-acceptance and role change; expiry
  and revocation; the recipient, cross-facility, first-30-days and
  delivery-pause limits and the recovery hold; a governed facility
  unchanged; release after review; support's reads; an audit scan; and the
  staff context's cost.
- Tests (`services/ehr-api/test/database/`, rollback-only): new
  `self-service-review-unlock`, `staff-invitations`,
  `staff-invitation-acceptance`, `facility-staff-management`,
  `staff-invitation-concurrency` (serial orders; the two-connection races are
  run by the build's harness), `p4b-privileges` (grants, definer and
  search_path, no table privilege, forced row-level security, triggers
  enabled, the audit leak scan, support's reads) and
  `provider-self-service-withdrawal`; P4's `provider-self-enrollment`,
  `provider-self-service-activation`, `provider-self-service-control`,
  `self-service-facility-release`, `self-service-facility-review` and
  `provider-self-service-rollback` changed for the restricted role, the new
  review and the eighth control key.

Cross-facility lab requests and prescriptions (P4c, in 0086's section 6,
after P4b's section 5; the grants became section 7 and the controls section 8,
still last). `main` has no cross-facility order routing, so every item here is
new on this branch except the patient-inbox grant, a port of `main`'s grant.
Owner decisions of 2026-10-25 (the fifth and sixth sets) are marked "owner".
The ehr-api, lab-api, pharmacy-api, identity-api and website parts are
recorded by their builds.

- The route (`ehr.order_routes`, with `ehr.order_route_events`,
  `ehr.order_route_accept_attempts`, `ehr.order_route_attestation_texts`,
  `lab.order_route_result_reports`, `pharmacy.order_route_dispensing_reports`
  and `identity.order_route_destination_settings`): uuid keys, forced
  row-level security with four permissive policies, no runtime privilege,
  append-only events and reports. A route is `sent` at once with
  `respond_by = created_at + 7 days`, then `accepted`, `completed`,
  `declined`, `withdrawn`, `expired` (stored by the next command that touches
  it) or `cancelled`; at most one live route per order and five per order;
  never again once a route of the order was accepted. The guard
  (`ehr.guard_order_route_mutation`) keeps the header, the snapshot and the
  attestation immutable, sets each transition column once, allows only the
  state table's transitions and windows, and requires an event of the new
  version with the same state and windows (P5); a deferred check requires
  event 1 at commit, run as the owner (the committing role is the EHR
  runtime, which reads no route table; found by the race harness, which
  commits as the runtimes).
- The clinician's attestation (owner Q2): the send carries the current
  attestation text version of the kind (`ehr.order_route_attestation_text`,
  two texts seeded), names the receiving facility, and is stored with the
  sender's name, the facility's name and `patient_agreement
  'clinician_attested'`; an older version is refused
  (`ORDER_ROUTE_ATTESTATION_OUTDATED`).
- Send (`ehr.send_order_route`, the EHR runtime): staff context with
  `direct-care` (no emergency, no break-glass), `ehr.order-route.send` (new;
  doctor and clinician) and the kind's write permission, the patient's write
  consent at the ordering facility, `cross_facility_orders_enabled` on, the
  order the patient's in that encounter at this facility (a draft is
  activated, recorded by the EHR's own versioning), an eligible destination,
  no deny directive, the patient's active account (V12, or the notice could
  not reach them), the limits (100 sends per member and 200 per facility pair
  a day, 500 open per destination); the order is snapshotted with the
  orderer's licence from a facility attestation whose doctor grant is still
  in force. The receiving facility gets a `system` row without the patient,
  the patient the inbox item `ORDER_ROUTE_SENT`. The orderer's withdrawal
  (`ehr.withdraw_order_route`) needs no consent grant and answers the
  route's patient, which the EHR checks against the path before its audit
  row names a patient (a mismatch answers 404 and rolls the withdrawal back).
- Eligibility (`identity.order_route_destination_eligible`, checked in the
  directory, at send and at acceptance after locking the receiving
  organization's application): an active, verified facility of an active
  organization that is reviewed (self-service) or governed; an active
  laboratory or pharmacy product at that facility from an approved
  application; listed (support's latest setting, else governed, else a
  self-service review by CAC contact, officer match, register or in person);
  a member holding `lab.order-route.receive` or
  `pharmacy.order-route.receive` (new; lab and pharmacist); not the ordering
  facility. The directory (`identity.search_order_destinations`, the Identity
  runtime) answers at most ten, with the registered address and
  `newOnHealthId`.
- Receive (`lab.*`/`pharmacy.*_order_route*`, the Lab and Pharmacy
  runtimes): Incoming shows no patient, clinical information, instructions,
  licence number or source ids; acceptance matches the Health ID or the date
  of birth, optionally with the order's reference (which the patient sees in
  the app), and counts mismatches: five that name the order (a Health ID, or
  a date of birth with its reference) or 20 in all lock that order there
  with a row at the ordering facility and the patient's notice, and 20 a day
  stop the member; a date of birth without the reference names no order (the
  counter may have picked another patient's row of several), so it counts
  only towards the member's day and the order's 20 and tells no one until a
  lock; a reference that is not the order's is refused
  (`ORDER_ROUTE_REFERENCE_MISMATCH`) and counted nowhere; the patient's deny
  directive is checked again at acceptance;
  refuses a suspended ordering facility (V10), creates the work item bound to
  the route and answers the patient card; a same-facility hand-off that took
  the order first makes the acceptance withdraw the route (`order_in_work`,
  R10); decline takes a reason code.
- Route access: the work lists' policies became strict
  (`lab.work_item_allows`/`pharmacy.work_item_allows`: the session facility
  and the member's consent or this row's route), and `lab.context_allows`/
  `pharmacy.context_allows` gained one branch, a live route of that kind for
  that patient at that facility for a member with the receive permission.
  Residual (the owner signs it): the chain-table branch is per patient at the
  facility, not per order (SPEC-FINAL 4.3).
- Windows: work for 30 days after acceptance; after the first result or
  dispensing both end at `least(completed + 14 days, accepted + 45 days)`
  and later reports never move them; a cancellation ends writes now and reads
  7 days later (entered in error, release and support end both now).
- Returns, in the receiving facility's transaction: a released result
  version, an invalidation, a dispensing and a reversal each file a report,
  the first completes the route, and the ordering facility gets a `system`
  row with the patient. A release on a cancelled route, or on an accepted one
  past its window, and a dispensing outside the window are refused
  (`ORDER_ROUTE_CLOSED`); an invalidation and a reversal never are.
- The mirror (`ehr.sync_order_routes_on_order_change`, after update of a lab
  request or prescription): a sent route is withdrawn; an accepted lab
  request is cancelled when it leaves `active` (an edit while active is an
  event, the receiver keeps what it accepted); an accepted prescription is
  cancelled by any change; a completed route records the change, and entered
  in error ends its access and tells the patient (`ORDER_ROUTE_CANCELLED`).
- Release and support: releasing a self-signed-up organization closes its
  live routes both ways (a trigger on `self_service_released_at`), with a
  `system` row at each counterpart, the patients' notices and one platform
  row `admin.self-service-facility.release-order-routes` with the counts;
  support finds a route by reference or Health ID, reads its summary, closes
  it (`admin.order-route.close`, needs `platform.facility.manage`) and lists
  or unlists a destination (`admin.order-route-destination.set`).
- The patient (owner Q2): the portal lists the orders sent for them with
  every field that crossed and the attestation, and Stop withdraws a sent
  route; an order marked entered in error (closed so, or its lab request or
  prescription now `entered_in_error`, which the record view already hides)
  stays listed as the record of what went where but answers no content beyond
  its reference, no attestation text and no attesting clinician, with
  `enteredInError` true (it may be another patient's, written in this chart
  by mistake); notices `ORDER_ROUTE_SENT`, `_WITHDRAWN`, `_ACCEPTED`, `_DECLINED`,
  `_ACCEPT_LOCKED` and `_CANCELLED` carry only the route, kind and facility
  names.
- The patient inbox grant, a port of `main`'s
  (`eb9b1ca:services/ehr-api/database/runtime-grants.sql:1664-1665`):
  `identity.list_my_notification_inbox(integer)` and
  `identity.mark_my_notification_read(uuid)` (0037) were revoked from PUBLIC
  and granted to no role here, so Identity's `GET
  /api/v1/identity/me/notifications` and its mark-read failed with 42501 in
  production. 0086 section 7 and `runtime-grants.sql` grant both to
  `hid_identity_runtime` (`main` also names `hid_schema_test_runtime`; here
  the suite runs as the API runtime, so it is not needed).
- Controls: `cross_facility_orders_enabled` (seeded off; sends, the
  directory and acceptance) and `cross_facility_route_access_enabled`
  (seeded on; work on accepted routes, switched off only to stop it
  everywhere). Every later control migration must carry all four keys of
  0086 in its CHECK and in `platform.control_enabled`. V11's rule: of the
  running services (57a94db) only Identity's emergency activation reads a
  control inside a transaction (`platform.require_control_enabled`, then an
  insert into `identity.consent_grants`); the guards and the EHR read with a
  pool statement. 0086 therefore takes `platform.control_settings` (ACCESS
  EXCLUSIVE) and `identity.consent_grants` (SHARE ROW EXCLUSIVE, for P4b's
  probation trigger, now created right after) in 6.7's one NOWAIT attempt
  with the nine clinical tables, and nothing after 6.7 waits for a lock. The
  first build created that trigger in section 5 and waited for
  `platform.control_settings` in the control section while holding the nine
  and `consent_grants`: an activation started in between deadlocked with the
  migration (40P01; either side could be the victim, so the clinician's
  activation could fail or the release stop), and every control read queued
  behind the waiting lock until the deadlock was detected (about 1 s). The
  build's race harness reproduced it in 6 of 6 runs and shows none since.
  P4c's own commands also read controls inside clinical transactions, so a
  later migration that locks `platform.control_settings` while holding
  clinical locks or a lock on `identity.consent_grants` must take it in the
  same NOWAIT attempt.
- Locks: nothing before section 6.7 locks the nine clinical tables
  (`lab.work_items`, `pharmacy.work_items`, `ehr.lab_requests`,
  `ehr.encounters`, `ehr.prescriptions`, `lab.result_releases`,
  `lab.result_invalidations`, `pharmacy.dispensings`,
  `pharmacy.dispensing_reversals`), `platform.control_settings` or
  `identity.consent_grants`; 6.7 takes the nine and
  `platform.control_settings` ACCESS EXCLUSIVE and `identity.consent_grants`
  SHARE ROW EXCLUSIVE at once with NOWAIT, retrying every 100 ms, so every
  authenticated request's control read waits from 6.7 to commit (not behind
  a waiting lock), and stops the release with
  nothing applied after 50 attempts (55P03, "the clinical order tables
  stayed busy for 5 seconds; run the release again at a quieter time").
  Measured on PostgreSQL 16 (the schema declaration's evidence): about 40 ms
  from 6.7 to commit on an empty database and about 200 ms with 50,000 work
  items in each list; under 20 to 300 transactions a second on the nine
  tables the release applied in 0.5 to 1.0 s with no failed transaction;
  under saturating traffic it stopped with 55P03 and applied nothing, and ran
  again cleanly once the traffic stopped.
- Rollback: switch `cross_facility_orders_enabled` off first (with P4's and
  P4b's two; the previous console accepts only the six old keys), and
  `cross_facility_route_access_enabled` too if the reason is route access.
  The previous services (57a94db) call no new function; their same-facility
  writes carry no route and pass the unchanged branches; the previous Lab and
  Pharmacy list route-backed items but authorize each through Identity, so
  routed work pauses until the images return. The rollback suite runs the
  previous EHR's lab request create and update, the previous Lab's and
  Pharmacy's acceptance, list and per-item read, and the previous Identity's
  control list (ten keys) on the new schema.
- Tests (`services/ehr-api/test/database/`, rollback-only): new
  `order-routes-send`, `order-routes-receive`, `order-routes-patient`,
  `order-routes-lifecycle`, `order-routes-returns`,
  `order-routes-concurrency` (serial orders; the two-connection races, the
  final block against a dispensing in flight and their deadlocking mutants
  run in the build's harness), `order-routes-privileges` and
  `patient-notification-inbox-runtime`; `provider-self-service-control` and
  `provider-self-service-rollback` changed for the ten keys and the previous
  EHR, Lab and Pharmacy SQL.

The services' part of P4c (all new; routes under `/api/v1`, errors
`application/problem+json` keyed on `code`, every id a v4 UUID):

- ehr-api: `POST`/`GET patients/:patientId/encounters/:encounterId/lab-requests/:requestId/order-routes`
  and `POST …/order-routes/:routeId/withdraw`, the same three under
  `prescriptions/:prescriptionId`, `GET order-route-attestation?kind=`,
  `GET me/order-routes` and `POST me/order-routes/:routeId/withdraw` (the
  patient's Stop, the only patient write). Send and an order's routes run in
  the clinical repository (Identity's write or read consent, the staff audit
  row with the patient; the send's row carries the attestation version and
  `patientAgreement`); withdraw and the attestation text are plain staff
  transactions with their own rows; the patient's routes are patient-self
  transactions. Every staff order-route route answers 403 `PERMISSION_DENIED`
  unless the purpose is `direct-care`. The lab-request and prescription lists
  and reads gain `orderRoute` (C4, only under `direct-care`) and
  `crossFacilityOrders` (a pool read after the transaction, false on any
  error); the lab request's row lock is `for no key update`; an update of a
  routed request never hands it to this facility's Lab (`labHandoff
  {state:'not_sent', code:'ORDER_ROUTED'}`); `sendToLab` and the
  pharmacist's hand-off answer 409 `LAB_REQUEST_ROUTED` /
  `PRESCRIPTION_ROUTED`. An order counts as routed while its latest route is
  live or was ever accepted (one work item per order, ever).
- lab-api and pharmacy-api: `GET order-routes?view=incoming|recent`
  (default `incoming`; a `healthId` query parameter is refused 400
  `HEALTH_ID_NOT_ACCEPTED_IN_URL`, see below),
  `POST order-routes/search` (`{ view?, healthId }`, the Health ID in the
  body), `GET order-routes/:routeId`, `POST …/accept`
  (`Idempotency-Key`; the Health ID upper-cased and trimmed, or a calendar
  date, and an optional `reference` (the order's 8 characters); pharmacy adds
  a reason of 8-500) and `POST …/decline`, for
  `lab.order-route.receive` / `pharmacy.order-route.receive`, READ COMMITTED.
  A mismatch, the lock and `order_in_work` commit with their audit row and
  are answered after the commit (409, with `attemptsLeft` as a problem
  member). Every per-item route asks the database about the resource it acts
  on (`lab.order_route_access_for` / `pharmacy.order_route_access_for`):
  `allowed` goes on with `basis: 'order-route'` in its audit row, `closed` is
  409 `ORDER_ROUTE_CLOSED`, `paused` 423 `CROSS_FACILITY_ORDERS_UNAVAILABLE`,
  `none` asks Identity as before. Route-backed work rows carry the route card
  and, while the route allows a read, the patient's name, sex, date of birth
  and Health ID's last 4, and never the other facility's order, prescription
  or encounter id; a work list that shows a patient's identity writes one
  audit row per patient shown (`lab.work-item.list` /
  `pharmacy.work-item.list`, naming the patient, with the work item and route
  ids and `basis: 'order-route'`). A Lab release refused by the return trigger is 409
  `ORDER_ROUTE_CLOSED`; a refused dispensing on a route-backed item is 409
  `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE`.
- identity-api: `GET identity/order-destinations?kind=laboratory|pharmacy&query=`
  (`ehr.order-route.send`, run under `direct-care`; 60 searches per
  membership an hour in an `account` bucket keyed by an HMAC of the
  membership with the OTP key, counted in its own transaction before the
  search; the audit row names the kind and the count, never the query);
  support's `GET admin/facilities/:facilityId/order-route-summary`,
  `POST admin/facilities/:facilityId/order-destination`,
  `GET admin/order-routes?reference=` (by reference only; a `healthId`
  query parameter is refused 400 `HEALTH_ID_NOT_ACCEPTED_IN_URL`, see
  below), `POST admin/order-routes/search` (`{ reference }` or
  `{ healthId }`, same permissions and audit action) and
  `POST admin/order-routes/:routeId/close` (`If-Match`), `@FacilityOptional`,
  reads audited on success and failure, writes on failure only (their
  platform rows come from the commands); `POST admin/controls` accepts the
  two new keys; the sign-up availability's open answer gains
  `crossFacilityOrders`, read on its own so an unknown key never closes
  sign-up. The patient inbox routes need no code change.
- Choices recorded from the services' build (services report D1-D19):
  validation of the directory, the lookup, the identifiers and the
  attestation kind answers the spec's own codes rather than
  `VALIDATION_FAILED`; a send replay answers the receiver's availability as
  unknown (null); the withdraw answer carries only what the withdrawal
  returns; the patient's content includes what crossed about the orderer;
  `date` values are read by their calendar fields so no process time zone
  moves them; a unique violation or deadlock on a send answers 503
  `ORDER_ROUTE_UNAVAILABLE` (a retry answers the real state).
- Found by the review and fixed (P4c's backend fix):
  - Health IDs in GET query strings (Lab and Pharmacy "Find by Health ID",
    support's lookup) reached the gateway's access log, whose stock `main`
    format keeps the request line with its query (CODEX §26). The gateway now
    logs `$request_method $uri $server_protocol`, never the query string,
    for every route; and each lookup has a POST that takes the Health ID in
    its body. The website and the admin console now call the POSTs, so the
    three GETs (`lab/order-routes`, `pharmacy/order-routes`,
    `admin/order-routes`) refuse a `healthId` query parameter, in any form
    and with any value (empty included): 400 problem+json, code
    `HEALTH_ID_NOT_ACCEPTED_IN_URL`, a fixed detail naming the matching
    `POST …/search` and never the value. Each service refuses it in a
    route-scoped middleware (`health-id-in-url.ts`, imported by the route's
    module), so the refusal comes before the guard (no Identity call, no
    session or control read), the audit interceptor and validation: no
    database query, no audit row, no log line. The GETs' query DTOs no
    longer have the field, so every other unknown key is still refused
    `VALIDATION_FAILED`; the lists and support's lookup by reference answer
    as before, and the POSTs are unchanged. The order-routes runtime
    verifier asserts the three refusals end to end.
  - A change of the self-signed-up administrator's own access
    (`identity.admin_set_self_service_administrator_role`) also overwrote
    `self_service_verification_method`, which P4c's default listing reads, so
    it listed or unlisted the facility for orders without any listing record.
    The change's method is now kept in its audit row only.
- Found by the integration's end-to-end run and fixed:
  - A route-backed work item that the strict policy hides (its route paused
    by `cross_facility_route_access_enabled`, or closed) answered 404 on
    `GET work-items/:id`, Lab's accession and Pharmacy's dispensing; these
    now ask the database about the hidden item and answer 423
    `CROSS_FACILITY_ORDERS_UNAVAILABLE` or 409 `ORDER_ROUTE_CLOSED`, as the
    route contract says. A chain row (an accession, specimen, execution,
    result or dispensing) is found only through rows the session can read, so
    while route access is off it is refused (403 or 404), not "paused".
  - A port of `main`'s binding (not P4c, but every cross-facility order
    needs it): a patient's own decisions on access requests
    (`GET /api/v1/identity/me/access-requests`, `POST
    …/access-requests/:requestId/approve` and `…/deny`) took the staff
    request context, so the patient app (which sends no purpose header)
    got 400 `PURPOSE_OF_USE_REQUIRED`, and with the header 500 (a patient
    has no facility): no patient could see, approve or deny a clinician's
    request, so no write grant could be created through the app. They are
    now patient-only and bound to the patient session (`main` does the
    same). `main`'s two checks on approval are ported too (the review found
    the approval live without them, and a write grant is what lets a
    clinician send the patient's order to another facility): an approval is
    refused for 24 hours after an OTP account recovery (403
    `PATIENT_RECENT_RECOVERY_HOLD`, checked first) and from a session family
    first issued more than 10 minutes ago (403
    `PATIENT_RECENT_AUTH_REQUIRED`, "For your security, sign out, sign in
    again, and approve within 10 minutes."), in the approval's transaction;
    the denial and the list stay unguarded. As in `main`, setting an Access
    PIN is held for 24 hours after a recovery as well (revoking it is not).
- The runtime verifier `services/ehr-api/scripts/verify-order-routes-runtime.mjs`
  (run by the TUF rehearsal after the provider verifier) boots Identity,
  EHR, Lab and Pharmacy from their own code, each as its exact runtime role,
  and drives P4c end to end over HTTP with fixtures from P4's sign-up, P4b's
  review and invitations and the patient's approval in the app.

Patient grant revocation differs from `main` (0066 items 2-4, 3490809 and
eb9b1ca) in these ways. The choices are the recommended defaults of the
item's spec (D1-D14), which the owner confirmed in chat on 2026-10-26 when
signing 0087's declaration; those that keep `main`'s behaviour say so.

- One migration, 0087, holds the three items (this branch's 0066 is
  `0066_patient_chat_history.sql`): `identity.revoke_my_consent_grant`, the
  access history's labels and the deleted-login inbox rule. Item 1 is not
  ported (below).
- D1: the database labels each history item `revocableByPatient`, not
  `main`'s `patientRevocable`, and Identity's history route publishes it as
  `patientRevocable` (a boolean, never true for break-glass) without the
  database key. A release migrates, then rolls identity-api, so with
  `main`'s key in SQL the website would show Revoke from the migration's
  commit until Identity rolled, and for good after a backend rollback, and a
  click would show "Cannot POST …". Here the button shows only where the
  route is served, except during the minutes of an identity-api rollout or
  rollback, when ECS runs old and new tasks side by side; a retry after the
  rollout succeeds, because a repeat replays.
- Break-glass is also recognised by scope (`scope = 'break_glass'`), as
  `identity.has_active_consent_grant` (0012) does, in the command and in both
  labels. It matters only for legacy-imported rows, whose flag and scope need
  not agree.
- D13: the audit row's reason is the fixed 'Revoked by the patient'
  (`main`: the patient's own words). The facility's audit readers
  (`audit.list_facility_events`) and support's platform audit see that the
  patient revoked, not why. The patient's trimmed words stay on the grant
  row (`consent_grants.revoked_reason`), which no service reads.
- D14: the history's limit of 50 picks the grants the patient can revoke
  first, then the newest, and lists the chosen items newest first (`main`:
  the newest 50), so newer rows, such as a burst of break-glass use, cannot
  push a revocable grant out of reach. With 50 grants or fewer the list is
  0030's, in 0030's order.
- Preconditions: 0087 refuses to run if `revoke_my_consent_grant` already
  exists; if the two bodies it replaces (0030's history, md5
  `ca6c848749f55e08a5f7a0a60c838293`, and 0037's enqueue,
  `662353fa2a411879e4e8d869d54827d5`) or the four it relies on
  (`identity.patient_self_session`, 0033's PIN set and removal and 0075's
  `identity.access_patient_with_pin`) differ; if `identity.consent_grants`
  lacks one of the four CHECKs the rule reads; or if that table has any user
  trigger other than 0086's BEFORE INSERT probation trigger.
- Locks: 0087's only table lock is a momentary ACCESS SHARE on
  `identity.consent_grants`, taken by `pg_get_constraintdef` in the CHECK
  precondition and by the PL/pgSQL validator resolving the revoke's
  `%rowtype`, each released at once. It conflicts only with ACCESS EXCLUSIVE
  (most DDL, VACUUM FULL, a vacuum truncating the table), so no request waits
  for it; if another session holds ACCESS EXCLUSIVE there, the runner's 5 s
  `lock_timeout` stops the dry run or the apply with nothing applied. 0087
  never locks `platform.control_settings`, so 0086's NOWAIT rule does not
  apply.
- D2, as on `main`: revoking needs no recent sign-in and is never held after
  an account recovery, because it only removes access. So someone holding a
  live patient session can also end the patient's grants, and after the real
  patient recovers the account they cannot approve a new request for 24
  hours (the approval's recovery hold).
- D5: the refusals use `main`'s codes with a `detail` written for the
  patient, which the website shows as it is (`main`'s details are
  technical): 409 `CONSENT_COMMAND_CONFLICT` for break-glass, workforce or an
  ended grant, 404 `CONSENT_RESOURCE_NOT_FOUND`, 403 `CONSENT_COMMAND_DENIED`
  for a session that is no longer live, and 400 for a short reason.
- D12, as on `main`: revoking a PIN-based grant leaves the Access PIN valid,
  so a facility that still knows it can use it again and gets a new grant at
  once. The website's revoke form is to say so. A lasting fix (refusing that
  facility until the PIN changes) would replace 0075's body and is a later
  change.
- D3, D4, D7, D8 and D9, as on `main`: a patient may revoke a
  patient-approved or PIN-derived grant (a legacy-imported grant naming the
  patient as grantor included), never a break-glass or workforce grant;
  order routes sent under a grant the patient revokes are left alone (the
  patient can Stop each until it is accepted, and an order sent at the same
  moment as the revocation may still go out); only a `deleted` login gets no
  new inbox items; and neither the clinician nor the patient's inbox is told
  of a revocation.
- D6: the website's emergency-access sentence loses "and reviewed" ("It is
  time-limited and audited; it cannot be revoked here.") in a website
  release before 0087, because no break-glass review exists here and 0087 is
  what makes the sentence show.
- Tests: `services/ehr-api/test/database/patient-grant-revocation.integration.sql`
  (rollback-only), Identity's HTTP, service and route specs, and a block in
  `services/identity-api/scripts/verify-emergency-contacts-runtime.mjs`,
  which now serves the access history. Only the container database
  acceptance runs the new suite (its loop over `services/ehr-api/test/database/`),
  and no CI job runs that script or the staging schema upgrade
  (`services/ehr-api/scripts/test-staging-schema-upgrade.mjs`). CI covers 0087
  by applying it (the TUF rehearsal's fresh install and upgrade, and the
  image build's migration job), by the ledger and release gates, by
  Identity's jest suites and by the verifier block, which the rehearsal
  runs. The SQL-level checks of the refusals, the limit, the audit row, the
  advisory key and the inbox rule are therefore manual gates before signing
  (Still open, below).

The wrong-patient report (item 3, this branch only; SPEC-FINAL in the
item's build notes). The owner approved it on 2026-10-26 with these
decisions, all built as decided:

- D1: the receiver has its own remedy. D3: one transaction ends the route's
  access and withdraws everything that went back (each result version marked
  entered in error at A, a dispensing reversed); it cannot half-happen.
- D2: usable while the receiver may still work on the order: up to 30 days
  after acceptance, or 14 days after the first return (45 at most), and not
  once anyone else ended it (the clinician's change, support's close, its
  time). Otherwise 409 `ORDER_ROUTE_ALREADY_ENDED`; before acceptance 409
  `ORDER_ROUTE_NOT_ACCEPTED` (decline instead).
- D4: any member at B who may receive that kind of order
  (`lab.order-route.receive` / `pharmacy.order-route.receive`); withdrawing a
  result needs `lab.result.entered-in-error`, reversing a dispensing
  `pharmacy.dispensing.reverse` (403
  `ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED`, problem member `permission`).
  D4b: no second confirmer.
- D5: the order cannot be received again; the clinician writes a new one
  (a resend answers 409 `ORDER_ROUTE_ORDER_IN_WORK`).
- D6: one of four reasons (`wrong_order_chosen`, `someone_elses_details`,
  `suspected_misuse`, `other`) and a note for support of 8-500 characters.
  D7: the note reaches support's list only (no audit row, log line, ordering
  facility or patient); support may replace it once, at review, with
  "Removed by Health ID support at review."
- D8: the patient gets a new inbox notice, `ORDER_ROUTE_WRONG_PATIENT`, with
  its own title on the website. D9: in-app only, no email (no
  notification-worker, AWS rule or Novu change). D13: the patient's sent order
  is kept in full.
- D10, the alternative (a): the order screen, the two phone calls (B's success
  message tells B to phone; support phones when something had gone back) and
  a card on the ordering facility's Overview listing such orders for 30 days.
  The card's read (`GET /api/v1/ehr/order-routes/wrong-patient`, designed in
  this build, privacy first): bound to the live staff session, the facility
  and `direct-care` like the other order-route reads (the guard re-checks the
  session with Identity; the database binds subject, membership and facility,
  42501 otherwise); a member sees an order in full (reference, kind, receiving
  facility, patient's name, when it ended, what was withdrawn, the link to the
  order) only if they sent it, as D10 says, whether or not they may still
  open the patient's record (the report usually comes days after the order,
  when the grant it was sent under has expired, and the sender must know
  whose care to review; the record itself still opens only through the
  governed lookup); every colleague's such order of the facility counts, with
  its reference and no patient;
  a member without `ehr.order-route.send` is refused 403 by the guard (the
  database answers the empty card). Read-only, no acknowledgement. Audited in
  the read's transaction: one `ehr.order-route.wrong-patient-overview` row
  (no patient, `{ itemCount, otherCount }`) and one
  `ehr.order-route.wrong-patient-overview.item` row per order shown in full,
  naming its patient; never a name in details.
- D11: support's "Wrong-patient reports" list (`GET
  admin/wrong-patient-reports?status=unreviewed|recent&facilityId=`,
  `platform.facility.read`), flagged first; "Mark reviewed" (`POST
  admin/wrong-patient-reports/:reportId/review`, `platform.facility.manage`,
  `If-Match`, once; one or more actions or "no further action" alone, and a
  note); the admin Overview tile counts the unreviewed list. D12: no
  automatic limits; the list shows 30-day counts per facility and per
  accepting member. D14: support refers to the DPO, the same day, every
  suspected-misuse report and every report where something had gone back
  (the flags `suspected_misuse` and `something_came_back`).
- D15: the website ships first, then the backend with the owner's signature
  on 0088. Until then the website is dormant: it shows the new action and the
  new guidance only once this backend has said it serves the report. The
  Lab and Pharmacy work lists' cards carry a numeric `orderRoute.version`
  (only 0088's cards do); the EHR's lab-request and prescription lists and
  support's order-route lookup answer `wrongPatientReports: true`; and every
  new route answers 404 `NOT_FOUND` on 595c044's and 7246d0e's services
  (checked at integration). Before that the Accepted panel asks only for the
  check that the person is the patient, with no button; the clinician's
  change warning and support's Close form keep their earlier words, so nobody
  is sent to a facility that cannot end the order, nor away from the
  clinician's change and support's Close, the only remedies on today's
  backend; and support's console stops listing the reports page once a read
  answers 404. The patient's new card line (tell the facility or Health ID
  support) shows on both, since support can close the order on either.
  D16: the wording is the spec's §9 drafts. D17: late correction is not in this build (the next
  item); support and clinicians follow §9.5's guidance meanwhile. D18: no
  "can't complete" action; the form says not to use this for that, "other"
  reads "The person was not the patient for another reason", and support's
  list flags `other_reason_nothing_recorded`. D19: the clinician sees
  "another person's result, withdrawn by {lab} on {date}" with the value
  hidden behind "Show the withdrawn value" (the website hides it; the order's
  route view still carries the released row's value beside the
  `entered_in_error` row, which has none).

The services' part (routes under `/api/v1`; INTERFACE_CONTRACT §21):

- lab-api and pharmacy-api: `POST order-routes/:routeId/wrong-patient`
  (`Idempotency-Key`; body `{ expectedVersion, reason, note }`; the note is
  trimmed and digested with the route, version and reason), one READ
  COMMITTED transaction run once; the service writes its own row
  (`lab.order-route.wrong-patient` / `pharmacy.order-route.wrong-patient`,
  the patient from the command, details without the note) and Lab's
  interceptor writes `api.lab.order-route.wrong-patient.request` without a
  body (pharmacy-api has no audit interceptor, as for accept and decline).
  A concurrent route write or deadlock (40001, 40P01) answers 409
  `ORDER_ROUTE_CHANGED_CONCURRENTLY` for this command only. The work lists'
  `orderRoute` card gains `version` (a number) and `endedKind`.
- identity-api: support's list and review above; the list is audited by the
  interceptor (`admin.wrong-patient-reports.list`), the review by the
  command's platform row (`admin.wrong-patient-report.review`, the review note
  as its reason; the interceptor writes failures only).
- ehr-api: the Overview read above; `endedKind: 'wrong_patient'` passes
  through the order's route views, the order lists' `orderRoute` and the
  patient's routes with no code change.
- Tests: the database suites `order-routes-wrong-patient` and
  `order-routes-wrong-patient-overview` (and the extended order-route
  suites); jest and HTTP specs in the four services
  (`lab-order-route-wrong-patient.spec.ts`,
  `pharmacy-order-route-wrong-patient.spec.ts`, Identity's
  `order-routes.http.spec.ts`, EHR's `order-route-wrong-patient.spec.ts`);
  and the order-routes runtime verifier's wrong-patient block (a lab order
  with a released result withdrawn, one with nothing returned, one past its
  window, a dispensed prescription reversed; the refusals; the patient's
  notice and record; the ordering facility's view and Overview card for the
  sender, a colleague and another facility; support's list and review; no
  note in any audit row, inbox item or service log).

The contract fields (item 4, this branch only; SPEC-FINAL in the item's
build notes): the three facts B1-B3 that the P4c website fix was owed, so the
website stops guessing them. The owner approved it on 2026-10-26 with these
decisions, built as decided:

- D1: `receives` (and `routesHere`, below) only to a member holding the
  kind's receive permission (`lab.order-route.receive` /
  `pharmacy.order-route.receive`); left out for everyone else (the database
  answers them NULL, and the service does not ask).
- D2: a stand-alone laboratory or pharmacy that does not receive is told so
  without a reason: "Health ID clinicians at other facilities can't send
  {facility} lab requests at the moment. If you expect them, ask Health ID
  support." (and "prescriptions" for a pharmacy). The website's words; the
  backend answers only the boolean, never why.
- D3: the website remembers the flag for 10 minutes per membership, facility
  and service, so the Overview skips its Incoming read at a governed facility
  that does not receive. No Identity change.
- D4, the alternative: 0089 also answers `routesHere: { waiting, held }` on
  the same answers. `waiting`: an order of the kind was sent to this facility
  and is before its respond-by (what Incoming lists). `held`: one is
  accepted, completed or cancelled with `access_ends_at` still ahead (what
  route access may read). Booleans only, with no patient, count or reference;
  bound to the session like `receives`; read through
  `ehr.order_routes_receiving_idx`, `held` among the routes sent in the last
  1272 hours (no route can be held longer) and planned per call for its own
  facility. Both stay true at a facility that support unlisted or whose
  product is suspended, so the website shows and lets it decline orders
  already sent to it, and shows the paused notice for its accepted work, at
  every facility.
- D5: support's lookup answers both `accessEndsAt` (the exact stored time,
  as `acceptedAt` and `endedAt` are; for a completed lab request it tells
  support when the first result came back, plus 14 days) and `closable`.
- D6: `destination` sits beside `listed`, not inside it. D7: no verification
  method and no "listable" flag. D8: support's listing command is unchanged.
  D9: no "found now" on the summary.
- D10: 0089's declaration was left unsigned in the build; the owner,
  D-Eminence, signed it in chat on 2026-10-26 (see Still open).

What mirrors what (a later migration that changes one changes the other with
it; 0089 pins each body by md5, and the suite's consistency checks catch
drift after it): `closable` mirrors support's Close
(`identity.admin_close_order_route`, md5 `e0ea834d…`); `destination` mirrors
steps 2 and 3 of `identity.order_route_destination_eligible` (md5
`6b274d9b…`); `held`'s 1272-hour bound relies on
`ehr.accept_receiving_order_route` (md5 `1d4a77de…`) refusing at the
respond-by, and on `order_routes_respond_by_ck` and
`order_routes_acceptance_ck`, which 0089 compares with 0086's definitions
before it applies (a CHECK of either name with another definition, or not
validated, stops the release; the contract-fields suite checks them again
after it).

The services' part (routes under `/api/v1`; INTERFACE_CONTRACT §22):

- lab-api and pharmacy-api: the work lists and Incoming (GET and the search
  POST) read `select lab.order_route_receives_here() as receives,
  lab.order_routes_here() as routes_here` (the Pharmacy twins) once, in the
  list's own READ COMMITTED transaction, after its audit rows, in a savepoint,
  and only for a member holding the receive permission. A failure (a schema
  without 0089, a facility no longer active) rolls back to the savepoint,
  logs the SQLSTATE and the correlation id only, and leaves both fields out;
  the list still answers. Each field is answered only when the database gave
  it as a boolean, never a made-up `false`. No audit row changes. Incoming's
  423 while route access is off reads nothing; the work list says it then.
- identity-api: support's lookup reads every column of
  `identity.admin_find_order_routes` and maps `accessEndsAt` and `closable`
  only when the schema answers them, so it works with or without 0089 (or
  with a later migration that restores 0086's lookup). The summary passes
  `destination` through unchanged, as earlier Identity images do, so it is
  answered as soon as 0089 is applied.
- ehr-api: no runtime change; the order-routes runtime verifier checks the
  fields (scripts only).
- Tests: the database suite `order-routes-contract-fields` and the extended
  privileges and lifecycle suites; the Lab and Pharmacy list specs and HTTP
  specs; Identity's `order-routes.http.spec.ts`; and the order-routes
  runtime verifier: the laboratory, the pharmacy and the hospital's own
  staff; the laboratory checked as Other, listed and unlisted; the pending
  laboratory (no field); route access off; support's lookup before
  acceptance, after Close, and inside and past a completed order's access;
  a laboratory unlisted after orders were sent to it (it still sees, and
  declines, the waiting one and holds the accepted one); a released
  sign-up's destination; and no audit row carrying the fields.

The late correction (D17, this branch only; SPEC-FINAL in the item's build
notes): when a laboratory or pharmacy (B) finds out late that it accepted an
order for the wrong person, item 3's report no longer works once its window
has closed or the order ended another way. D17 adds "Correct an order that
has ended". The owner approved it on 2026-10-26, taking every recommended
default, built as decided:

- D17-1: one member of B who may receive that kind of order
  (`lab.order-route.receive` / `pharmacy.order-route.receive`), and may mark
  results entered in error (`lab.result.entered-in-error`) or reverse
  dispensings (`pharmacy.dispensing.reverse`) when something must be
  withdrawn, withdraws at once; support reviews every such report within one
  business day. No second member.
- D17-2: until 180 days after B accepted the order, set in one database
  function (`ehr.order_route_correctable_until`; the order summary inlines the
  same expression and a suite check keeps them equal). Past it: 409
  `ORDER_ROUTE_CORRECTION_TOO_LATE`.
- D17-3: when B cannot act (it left Health ID, does not respond, or the
  deadline passed), support's stop-gap, reworded: the clinician notes in the
  record, without repeating the value, that the result was not the patient's;
  support refers it to the DPO the same day. No support withdrawal. Once B's
  organization was released (its memberships ended, for good), every reader
  answers the order `receiver_released` with no deadline (also an order that
  had ended another way before the release), so no screen promises a
  withdrawal B can no longer make, and the command refuses it.
- D17-4: the ordering facility (A) sees item 3's red warning with the other
  person's values hidden, plus the sentence that anything it recorded from
  the value (a note, a diagnosis, a prescription) still shows until it
  amends it or marks it entered in error (the website's words; the backend
  answers `wrongPatient: { reportedAt, late }`).
- D17-5: guidance only for A: phone B with the reference, with evidence; an
  unexpected result is not a reason (the website's words).
- D17-6: support refers to the DPO the same day every late report where
  something had gone back and every "suspected misuse" one. The console, and
  the database behind it, refuse to mark such a report reviewed without
  "Referred to the DPO", and, where something had gone back and the
  ordering facility is still on Health ID, without "Ordering facility told":
  400 `WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED`, problem member `required`
  (C27, and a CHECK on the report table as the backstop).
- D17-7: the patient is told in the app's inbox only:
  `ORDER_ROUTE_WRONG_PATIENT` when the order ended now,
  `ORDER_ROUTE_WRONG_PATIENT_CORRECTED` when it had ended before. No email.
- D17-8: B finds the order by its exact 8-character reference only
  (`POST …/order-routes/correctable`, the reference in the body); for an
  order it may still correct it also sees the test or medicine, who at B
  accepted it and how identity was checked, and what went back and when.
  Never the patient. A reference no order accepted there carries answers 200
  with no items, never 404.
- D17-9: at most 5 late corrections per member and 20 per facility in any 24
  hours, exact (a transaction advisory lock per receiving facility, and the
  command refuses any caller whose transaction is not READ COMMITTED, where
  the count after the lock could miss what an earlier holder committed); the
  refusal (429 `ORDER_ROUTE_CORRECTION_LIMIT`) says from when another is
  possible (problem member `retryAfter`); support cannot lift it.
- D17-10: an order whose time simply ran out is ended "accepted for the wrong
  person" now (`wrong_patient`), so every item 3 screen works unchanged; an
  order that had ended another way keeps that ending.
- D17-11: the website ships first and stays dormant until this backend says
  it serves D17 (`lateCorrection: true` on the Lab and Pharmacy work lists,
  the EHR's lab-request and prescription lists, the ordering facility's
  Overview, support's lookup and reports list; a `correctableUntil` key on a
  route; any answer from the lookup); then this backend.
- D17-12: 0090's declaration was left unsigned in the build; the owner,
  D-Eminence, signed it in chat on 2026-10-26 (see Still open).
- D17-13: the ordering facility's Overview is unchanged: only the clinician
  who sent the order sees the full item; colleagues see the reference.

How it is made safe (0090): the command (`ehr.correct_wrong_patient_order_route`,
owner-only, through `lab.`/`pharmacy.correct_wrong_patient_order_route`)
writes one row of `ehr.order_route_correction_capabilities` (forced
row-level security, no grant to any role), keyed by its own transaction id,
for the route's facility, patient, kind and the member; the receiving access
rule (H6) honours it only inside that transaction
(`pg_current_xact_id_if_assigned()`), behind the control and the receive
permission; the command deletes it before it returns. H7 and item 3's
command are unchanged byte for byte. The command runs only in a READ
COMMITTED transaction (25000 `ORDER_ROUTE_CORRECTION_READ_COMMITTED_REQUIRED`
otherwise, before it reads anything), as both services call it.

The services' part (routes under `/api/v1`; INTERFACE_CONTRACT §23):

- lab-api and pharmacy-api: `POST order-routes/correctable` (body
  `{ reference }`, 1-16 characters; trimmed, upper-cased and checked, 400
  `ORDER_ROUTE_INVALID`) reads `lab.find_correctable_order_routes` (the
  Pharmacy twin) in a READ COMMITTED transaction, answers each order field by
  field (`details` only while open or correctable, never the patient) with
  `lateCorrection: true`, and writes one row per lookup
  (`lab.order-route.correctable` / `pharmacy.order-route.correctable`, no
  patient, `{ found, states, routeIds }`, never the reference).
  `POST order-routes/:routeId/wrong-patient-correction` (`Idempotency-Key`;
  body `{ expectedVersion, reason, discoveredBy, discoveredOn, note }`, all
  required; `discoveredOn` a calendar date, the note trimmed and digested with
  the rest) runs the command once in a READ COMMITTED transaction and writes
  B's own row (`lab.order-route.wrong-patient-correction` /
  `pharmacy.…`, the patient from the command, how and when B found out, the
  counts, `late: true`, never the note); Lab's interceptor writes the
  `….request` rows without a body (pharmacy-api has no interceptor, as for
  item 3). The new refusals: 409 `ORDER_ROUTE_STILL_OPEN` (use item 3's
  report), `ORDER_ROUTE_ALREADY_REPORTED`, `ORDER_ROUTE_CORRECTION_TOO_LATE`;
  429 `ORDER_ROUTE_CORRECTION_LIMIT` with `retryAfter`; a concurrent route
  write or deadlock 409 `ORDER_ROUTE_CHANGED_CONCURRENTLY` (this command
  only). The work lists add `lateCorrection: true` for a member holding the
  receive permission. Item 3's report, the cards and the work lists' rows
  are unchanged.
- ehr-api: the order summary (`orderRoute` on the lists and reads, the
  order's route views) and the patient's routes pass `wrongPatient` and
  `correctableUntil` on when the database answers them; the Overview's items
  pass `reportedAt`, `late` and `endedKindBefore` on, and its answer and the
  two lists add `lateCorrection: true`.
- identity-api: support's lookup passes `correction`, `correctableUntil` and
  `wrongPatient` on, and the reports list the seven late facts
  (`late`, `endedKindBefore`, `discoveredBy`, `discoveredOn`,
  `reporterLateReportsLast30Days`, `orderingSenderActive`,
  `requiredActions`), each when the schema answers it; both answers add
  `lateCorrection: true`. The review answers the new refusal with problem
  member `required`; Identity's problem details gain extension members for
  it (as Lab's and Pharmacy's already have).
- notification-worker, event-dispatcher (only a test added: the two outbox
  rows are item 3's shapes), the gateway, AWS and the Novu set-up are
  unchanged.
- Tests: the database suite `order-routes-late-correction` and the extended
  order-route suites; jest and HTTP specs (`lab-order-route-late-correction.spec.ts`,
  `pharmacy-order-route-late-correction.spec.ts`, EHR's
  `order-route-late-correction.spec.ts`, Identity's `order-routes.http.spec.ts`
  and `problem.spec.ts`, the event-dispatcher's contract spec, and the exact
  shapes that gained a field); and the order-routes runtime verifier's late
  correction block (an order support closed, item 3's lapsed order and a
  lapsed completed one, an order past its 180 days, a closed prescription;
  the lookup before and after; the refusals; the deadline on the four
  readers; the patient's notice and record; the Overview; support's flags,
  required actions and refused review; the member and facility limits with
  their exact `retryAfter`; the capability table empty, its statistics,
  and no runtime able to read, write or use it; no note in any audit row or
  log).

"We can't complete this order" (D18, this branch only; SPEC-FINAL in the
item's build notes; hid-system 0091 on `staging-novu-ci-20261005`, not
`main`'s 0091): a laboratory or pharmacy (B) that accepted an order from a
clinic (A) for a patient (P) and then cannot do it had no way to say so: the
order sat "accepted" for 30 days and lapsed, or B misused the wrong-patient
report. D18 adds a third action on the order's work row. The owner approved
it on 2026-10-27, taking every recommended default, built as decided:

- D18-1: only on an order B accepted, inside its 30-day work window, not
  ended (nor reported as accepted for the wrong person), with nothing
  returned yet. Otherwise 409 `ORDER_ROUTE_NOT_ACCEPTED`,
  `ORDER_ROUTE_ALREADY_ENDED` or `ORDER_ROUTE_ALREADY_RETURNED`.
- D18-2: B keeps reading the order for 7 more days only if it had recorded
  something on it (a laboratory that had opened an accession); otherwise not
  at all from the ending (always so for a pharmacy). No one, support
  included, can shorten the 7 days. B can record nothing more.
- D18-3: a new patient inbox notice, `ORDER_ROUTE_NOT_COMPLETED`
  ("{B} couldn't complete your {test request | prescription}: see it in
  Access and consent"; the website holds the words and ships first). A
  patient without an active account gets nothing, as for every order notice.
- D18-4: the patient does not see the reason; the card says B couldn't
  complete it and to contact the clinic.
- D18-5: 9 laboratory reasons (`test_not_offered`, `supplies_unavailable`,
  `equipment_unavailable`, `sample_unusable`, `sample_not_obtained`,
  `cannot_meet_priority`, `patient_declined`, `patient_did_not_return`,
  `other`) and 8 pharmacy reasons (`out_of_stock`, `medicine_unavailable`,
  `needs_prescriber_review`, `controlled_requirements`,
  `cannot_meet_priority`, `patient_declined`, `patient_did_not_return`,
  `other`); none about identity or money. The command, its endings table, the
  two DTOs and a shared fixture hold the same lists (tested equal).
- D18-6: no free text.
- D18-7: at most 20 endings per staff member and 50 per facility in any 24
  hours, exact (transaction advisory locks per ending account and per
  receiving facility, in that order; the command runs only READ COMMITTED),
  never lifted. The member's limit counts their account, at every facility
  where it holds the receive permission, so a stolen account ends at most
  20 a day wherever it belongs: 429
  `ORDER_ROUTE_CANNOT_COMPLETE_LIMIT` with `retryAfter`. Past the limit B
  phones A to cancel the order, or support closes it (C22) after checking
  who is calling.
- D18-8: A is told on the order's screen (the reason, the next step, whether
  a sample was taken and whether a result was recorded but not released);
  for urgent, as-soon-as-possible or stat lab requests, any "can't do it in
  time", a pharmacy's "needs the prescriber's review" or "controlled medicine
  paperwork", B's staff must tick "We will phone {clinic} about this now"
  (the website's form). No Overview card.
- D18-9: no re-send of the same order (`ORDER_ROUTE_ORDER_IN_WORK`); the
  clinician writes a new order, and the screen says so.
- D18-10: anyone at B with the kind's receive permission
  (`lab.order-route.receive` / `pharmacy.order-route.receive`).
- D18-11: support sees, on each facility's order panel, how many orders it
  ended this way in the last 30 days, how many within an hour of accepting
  with nothing recorded, how many 7 days or more after accepting, how many
  were later reported as accepted for the wrong person, and the reasons. No
  view across facilities.
- D18-12: a wrong-patient report made after such an ending is reviewed like
  any late report where nothing came back: it is flagged
  (`late_correction`) and so listed first among support's unreviewed
  reports, with `endedKindBefore: 'receiving_unable'` naming the earlier
  ending.
- D18-13: website first (dormant until this backend says it serves D18:
  `cannotComplete: true` on the Lab and Pharmacy work lists, support's
  lookup and facility summary), then this backend.
- D18-14: 0091's declaration stays unsigned (`reviewed_by` empty) in the
  build; the owner signs after SPEC-FINAL §11.2's checks, once production's
  order count is read, with the migration choosing its CHECK-change form by
  table size (validated up to about 200,000 routes, NOT VALID above).
- D18-15: refused while a checked (verified) result waits to be released
  (409 `ORDER_ROUTE_RESULT_READY`: B releases it, or corrects it or marks it
  entered in error first); a possibly critical value needs "We have phoned
  {clinic} about the possibly critical value" (`criticalValueTold: true`,
  else 409 `ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD`); A is told "A result was
  recorded there but not released" (`resultRecorded`).

Never a way round a wrong-patient report: B must state that the person was
the order's patient (`confirmedPatient: true` is required by the API), no
reason is about identity, nothing that came back can be filed away (a
completed order is refused, a checked result must be released first), and
afterwards D17's late correction (C29) still corrects such an order, also
after B's reading ended: 0091 widens the report table's `late_ck` to admit
`receiving_unable`, which would otherwise make that correction fail. Once a
report exists, A's summary drops `notCompleted`, so B's earlier reason is no
longer shown as a fact about P.

How it is built (0091): `ehr.cannot_complete_order_route` (owner-only,
through `lab.`/`pharmacy.cannot_complete_order_route`, the Pharmacy's passing
no critical value) ends the route through 0086's closer (H14) with the new
kind `receiving_unable` (the two route CHECKs widened), writes one row of
`ehr.order_route_unable_endings` (forced row-level security, no grant to any
role, immutable), the two system rows `ehr.order-route.not-completed` and the
notice; the order summary gains `notCompleted`; support's counts come from
`identity.admin_order_route_not_completed`, which Identity merges into the
facility summary (C20 itself is unchanged, since `a3b1822`'s verifier asserts
its exact keys). Item 3's command, D17's correction and lookup, H6 and H7 are
unchanged byte for byte.

The services' part (routes under `/api/v1`; INTERFACE_CONTRACT §24):

- lab-api and pharmacy-api: `POST order-routes/:routeId/cannot-complete`
  (`Idempotency-Key`; body `{ expectedVersion, reason, confirmedPatient:
  true, criticalValueTold? }`, the reason from the kind's list,
  `criticalValueTold` Lab only, unknown fields refused) runs the wrapper once
  in a READ COMMITTED transaction (six arguments at the Lab, five at the
  Pharmacy; the digest of `{ routeId, expectedVersion, reason,
  criticalValueTold }`, the Pharmacy's without `criticalValueTold`) and
  writes B's own row (`lab.order-route.cannot-complete` / `pharmacy.…`, the
  patient from the command, the reason, the counts, `criticalValueTold`,
  `confirmedPatient: true`, `replayed`) in the same transaction; Lab's
  interceptor writes the `….request` row without a body (pharmacy-api has no
  interceptor). It answers `{ route, reason, readUntil, specimensCollected,
  resultsRecorded, criticalCandidates, replayed }`, never the patient or the
  ending's id. The new refusals: 409 `ORDER_ROUTE_ALREADY_RETURNED`,
  `ORDER_ROUTE_RESULT_READY` and `ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD` (Lab);
  429 `ORDER_ROUTE_CANNOT_COMPLETE_LIMIT` with `retryAfter`; a serialization
  failure or deadlock 409 `ORDER_ROUTE_CHANGED_CONCURRENTLY` (this command
  only); 25000 and anything unexpected 503. The work lists add
  `cannotComplete: true` for a member holding the receive permission.
- ehr-api: the order summary passes `notCompleted` (`{ reason, sampleTaken,
  resultRecorded }` or null) on when the database answers it. The patient's
  routes (C5) and the Overview (C28) are unchanged.
- identity-api: the facility summary adds `notCompleted` (the five counts,
  each checked a non-negative integer) and `cannotComplete: true`, read with
  C32 in C20's read-only transaction in a savepoint, both left out (and the
  SQLSTATE alone logged) on any failure; support's lookup adds
  `cannotComplete: true`; the reports list passes C26's rows, flags and
  order through unchanged (D18-12).
- The patient's notice goes through the existing path: the command enqueues
  the inbox item (`notification.enqueue_patient_inbox_item`, H12), as for
  every order notice; no outbox row, no email.
- notification-worker, event-dispatcher, the gateway, AWS and the Novu
  set-up are unchanged.
- Tests: the database suite `order-routes-cannot-complete` and the extended
  order-route suites; jest and HTTP specs (`lab-order-route-cannot-complete.spec.ts`,
  `pharmacy-order-route-cannot-complete.spec.ts`, EHR's
  `order-route-not-completed.spec.ts`, Identity's `order-routes.http.spec.ts`,
  and the exact shapes that gained a field); and the order-routes runtime
  verifier's "can't complete" block (an ending at a laboratory and at a
  pharmacy, every refusal over HTTP, the reads afterwards, the patient's
  notice, the clinician's view, support's counts, and D17's late correction
  after the ending).

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
- `main`'s `0066_patient_access_safety.sql` item 1 and its restatement of
  0035: the session-bound access-request wrappers
  (`list_my_patient_access_requests`, `approve_my_access_request`,
  `deny_my_access_request`, with their grants; here Identity calls the 0035
  commands, which bind to the signed-in account's patient), and its repeat of
  the 0035 decision commands, whose repair is already here as 0072. Item 1
  would be its own change. Items 2-4 (the patient's revocation of a grant
  they gave, the access history's labels and no new inbox items for a
  deleted login) are ported above as 0087, and P4c took its inbox grant.
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
- Patient grant revocation (main 0066 items 2-4) is ported, as 0087, at the
  owner's request. On 2026-10-26 the owner confirmed the spec's recommended
  defaults D1-D14 (each is described under "Patient grant revocation
  differs from `main`" in Ported above) and signed 0087's declaration, with the website copy release
  (the corrected emergency-access sentence and the revoke form's PIN note)
  going first.
- The wrong-patient report (item 3) is built at the owner's request
  (2026-10-26) with the decisions D1-D19 described under "The wrong-patient
  report" in Ported above, D10 taking the alternative (a): the order screen,
  the two phone calls and a card on the ordering facility's Overview for 30
  days, read-only, showing a member full rows only for orders they sent.
- The contract fields (item 4) are built at the owner's request (2026-10-26)
  with the decisions D1-D10 described under "The contract fields" in Ported
  above, D4 taking the alternative (`routesHere`); the owner signed 0089's
  declaration in chat on 2026-10-26.
- The late correction (D17) is built at the owner's request (2026-10-26) with
  every recommended default, D17-1 to D17-13, described under "The late
  correction" in Ported above: one member of the laboratory or pharmacy
  withdraws at once and support reviews; 180 days after acceptance; support's
  stop-gap reworded, no support withdrawal; item 3's red warning plus the
  sentence about what the clinic recorded; guidance only for the clinic;
  the DPO referral enforced by the console; inbox only; lookup by exact
  reference with the laboratory's own facts, never the patient; 5 a member
  and 20 a facility in 24 hours, exact; a lapsed order ended
  `wrong_patient`; website first; 0090's declaration signed by the owner in
  chat on 2026-10-26; the Overview unchanged.
- "We can't complete this order" (D18) is built at the owner's request
  (2026-10-27) with every recommended default, D18-1 to D18-15, described
  under "We can't complete this order" in Ported above: accepted orders only,
  inside the 30-day window, nothing returned; B keeps reading 7 days only if
  it recorded something; a new "couldn't complete" patient notice; no reason
  to the patient; 9 laboratory and 8 pharmacy reasons; no free text; 20 per
  member and 50 per facility per 24 hours, never lifted; the order screen
  plus a required "we will phone" tick in the urgent and safety cases, no
  Overview card; no re-send, a new order; anyone with the receive
  permission; per-facility counts for support; a later wrong-patient report
  flagged and sorted first; website first, dormant; 0091's declaration left
  unsigned in the build; refused while a checked result waits for release, a
  critical-value tick, the clinician told a result was recorded.

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
- Patient features held behind controls: account deletion. (Hospital
  self-activation is ported above as facility self sign-up, behind
  `provider_self_service_enabled`; revoking access is ported above as 0087.)
  When account deletion is ported: support's emergency-contact opt-out counts
  a patient as told even when the inbox skips a deleted login (0084's
  `patients_told`).
- Facility self sign-up (ported above, switched off): the owner signs the 0086
  declaration, after the read-only preflights (no closed organization
  application without a review reason, reviewer or review time, which 0086
  refuses; one reviewer check and one control-key check; the owner of
  `platform.control_settings` and `platform.control_enabled`; and
  `platform.control_settings`'s row-level security and FORCE settings with its
  owner's `rolsuper` and `rolbypassrls`: stop and find out why if row-level
  security and FORCE are both on and the owner has neither, since production's
  accountless control reads could not then work as they do; and the md5 of the
  live sources of `platform.consume_qoreid_quota` and
  `identity.begin_organization_profile_completion`, which 0086 requires to be
  0049's `dca2fbb737f2c747148eacc7d6e66c5f` and 0056's
  `6c94f9fca935f41a1bbcc313d9447d04`, else its dry run stops the release with
  nothing changed), then opens the control with the audited admin command.
- Emergency contacts (ported above, switched off): storing contacts' names and
  destinations, the alert wording, production delivery and the pilot accounts.
  Alerts also need an active `emergency` purpose of use, which 0085 seeds;
  without it break-glass is refused.
- Duplicate active memberships for one account and facility: the read-only
  query decides whether one-membership enforcement can ship.
- The wrong-patient report (item 3, 0088): signed by the owner, D-Eminence,
  in chat on 2026-10-26, after the container database acceptance (a fresh
  install applying all 89 migrations and every `test/database` suite, then
  no pending migration) and the staging schema upgrade passed. The owner
  confirmed that the sending clinician keeps seeing the patient's name on
  the Overview card after their grant ends (D10 as written; every such
  view is audited). Release order: the website release carrying the
  dormant screens, pinned to item 2's release, then this backend release,
  diffed from item 2's released commit (0087 must be live first: the
  declaration names only 0088 and `runtime-grants.sql`); with the default
  `changed` selection it rebuilds all 13 components, because
  `scripts/verify-migration-ledger.mjs` changes, as 0087's release does.
  The website's pins are re-pinned after this release. Late correction
  (D17), the patient email (D9) and "can't complete" (D18) are not in this
  build.
- The contract fields (item 4, 0089): signed by the owner, D-Eminence, in
  chat on 2026-10-26, after the container database acceptance (a fresh
  install applying all 90 migrations and every `test/database` suite, then
  no pending migration), the staging schema upgrade and an adversarial
  review passed. 0088 is live (item 3's release, bd8676e; the declaration
  names only 0089 and `runtime-grants.sql`). Release order, as the owner
  chose: this backend first (0089 with `runtime-grants.sql`, then lab-api,
  pharmacy-api and identity-api built from the same commit), then the
  website with health's re-pin to this release, which the owner approved
  in the same message; either order is safe, since every field is
  optional. The release tooling
  (`scripts/production-backend-build.mjs`) counts the verifier under
  `services/ehr-api/scripts/` toward both the ehr-api and the migration
  images; with the default `changed` selection, the diff from item 3's
  released commit rebuilds all 13 components anyway, because
  `scripts/verify-migration-ledger.mjs` changes, as for 0087 and 0088. A follow-up for the owner: an index on
  `identity.staff_facility_memberships (facility_id)` for active memberships,
  if `receives` is slow in production (3-4 ms a call, p95 up to 6.5 ms, with
  10,000 memberships); not in 0089, because it would lock the table.
- The late correction (D17, 0090): signed by the owner, D-Eminence, in chat
  on 2026-10-26 (D17-12), after the gates of SPEC-FINAL §11.2 passed: the
  container database acceptance (its database stages), the staging schema
  upgrade, the suites, the race harness, the copies, the old images'
  verifiers and the migration checks. Of the two owner steps:
  - Production's owners were not read beforehand: the owner chose to rely
    on section 0, which stops the release with nothing applied if a role it
    names lacks a privilege it needs. The runner prints 0090's NOTICE
    ("0090: owners checked: …") in the release's log, in the dry run and in
    the apply; it is read after the release and recorded here.
  - The measured costs were accepted by the owner as they are (SPEC-FINAL
    §7's budgets in brackets). Measured on an owner copy with 20,000 lapsed lab routes,
    40,000 denied results and 100,000 bulk routes, 0089's bodies against
    0090's, interleaved, on the local PostgreSQL 16 cluster:
    - the order summary: +4.9 to +10.3 µs per route while the receiving
      facility is a destination, +11.9 µs once it is not (+5 µs);
    - C4, the summaries of one list of 200 orders: +2.9 to +3.5 ms, from
      about 15 ms (+2 ms);
    - H6 through the policy path, with a transaction id: +10.2 to +11.8 µs
      per denied row as T9's state varies (median of 18 rounds +10.5 µs, 4
      rounds above +12), and +12.9 µs with T9 never analyzed, as 0090
      creates it (the review's measurement); the whole denied-row query
      +0.3 % to +2.4 % (+12 µs, 2 %);
    - the patient's list (C5): +1.1 to +1.8 µs per row; support's find
      (C21): +7 to +9 µs per row.
  Release order (D17-11): item 4 is live (the declaration
  names only 0090 and `runtime-grants.sql`); the website first (dormant until
  this backend says it serves D17), then this backend: `database-migration`
  (0090 with `runtime-grants.sql`, dry run then apply), then lab-api,
  pharmacy-api, ehr-api and identity-api from the same commit; the default
  `changed` selection rebuilds all 13 components, because
  `scripts/verify-migration-ledger.mjs` changes, as for 0087-0089. D17 is
  switched off only by rolling those four services back together. Support's
  runbook: a laboratory or pharmacy that reports a batch mix-up larger than
  the limits is told when more are possible; support phones each ordering
  facility on the list it gives and asks the engineering on-call for a
  hotfix only if the limits must be raised. Follow-ups, not in this build:
  a support-granted permit past the deadline, a two-person support
  withdrawal, a second member at the laboratory, the patient email, the
  Overview for a sender who has left, and a support allowance for the limits.
  Rollback and mixed images were run end to end (integration): 22cd47f's
  and aba7c16's services pass their own order-routes runtime verifier on
  0089 (their lists carry no new field and support's lookup keeps its 13
  columns; the summary already carries `destination`), and item 4's
  services pass 22cd47f's on 0088 (no field, no 503). The website was fed
  the answers of each (aba7c16 on 0087, 22cd47f on 0088 and 0089, item 4 on
  0088 and 0089): it keeps today's pages wherever a field is absent and
  uses each one wherever it is answered.
- "We can't complete this order" (D18, 0091): **not signed**. 0091's
  declaration in `config/production-schema-compatibility.json` names 0091
  and `runtime-grants.sql` with `reviewed_by` empty (D18-14), so the release
  core refuses it (`REVIEWED_BACKWARD_COMPATIBILITY_REQUIRED`) until the
  owner signs. Before signing (SPEC-FINAL §11.2): the gates of §10 (suites on
  fresh copies, mutants, race harness, performance, lock and load gates warm
  and cold, old images, negative copies, refusing preconditions, staging
  rehearsal, container acceptance); on production, the header's read-only
  query (the owners, and `reltuples, relpages` of `ehr.order_routes`, a
  catalog read), then the expected pause at that size, twice, and the CHECK
  form 0091 will choose (validated up to about 200,000 routes, NOT VALID
  above), written into the declaration. The measured costs are put before
  the owner as they are: the order summary about +6 to +9 µs per ordinary
  route against a +4 µs budget and +13 to +15 µs per route ended this way
  against +8 µs, on a machine about 1.7 times slower than the design's.
  Release order (D18-13): the website first (dormant until this backend says
  it serves D18), then this backend at a quiet hour: `database-migration`
  (0091 with `runtime-grants.sql`, dry run then apply; a 55P03 "stayed busy
  for 5 seconds" stops it with nothing applied: run it again later), then
  lab-api, pharmacy-api, ehr-api and identity-api from the same commit; the
  default `changed` selection rebuilds all 13 components, because
  `scripts/verify-migration-ledger.mjs` changes, as for 0087-0090. D18 is
  switched off only by rolling those four services back together; orders
  already ended this way keep reading correctly, and D17's correction still
  corrects them. Support's runbook: a laboratory or pharmacy that reaches the
  daily limit in a real batch failure phones support; support confirms who
  is calling, closes each overflow order it names with Close and the reason
  "Receiving facility couldn't complete it: over the daily limit", and phones
  the ordering facilities if B cannot; the limits are not lifted.
  Follow-ups, not in this build: "Copy into a new order" at the clinic, an
  Overview card for declines, lapses and "can't complete", a support view
  across facilities, re-collection and part supply on one order, B's work
  cards carrying the wrong-patient report, and a test and medicine catalogue
  per destination.

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
