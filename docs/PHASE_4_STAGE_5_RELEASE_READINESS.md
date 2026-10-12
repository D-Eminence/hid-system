# Phase 4 Stage 5: platform administration release readiness

This is the combined release checklist for the platform administration work
of Phase 4, the governed-access slice that followed it, the Stage 6 OCR
audit and queue-metrics slice, Stage 7 (MFA lock order and fail-closed OCR
validation guards), Stage 8 (fail-closed session guards and OCR worker
leases), the delegated cookie-read fix (D-Eminence/hid-system#38), the
sign-out and client-kind change (D-Eminence/hid-system#39) and the EHR clinical
list paging fix (D-Eminence/hid-system#40). It covers Identity, the EHR, Lab,
Pharmacy and OCR APIs, the OCR worker, and the database in this repository, and
in Health-id the admin console (`apps/patient-web/src/admin`) and the provider
portal's governed-access pages
(`apps/patient-web/src/staff`). It records what was
verified locally and what an operator must still do. **Nothing here has been
deployed, and no staging or production database has been migrated.** Every
"verified" below means a local synthetic environment unless it says otherwise.

## 1. What is being released

| Component | Source | Contents |
| --- | --- | --- |
| Database | `services/ehr-api/database/migrations` through `0078_patient_access_pin_actor_window.sql` | Phase 1–4 schema. The platform admin migrations are 0067–0072. Stage 5 adds no migration; Stage 5B adds 0073, governed access adds 0074, Stage 6 adds 0075, Stage 7 adds 0076, Stage 8 adds 0077 and the patient PIN actor-window fix adds 0078 (branch `fix/patient-pin-actor-lockout`, not yet a PR; §2). |
| Runtime grants | `services/ehr-api/database/runtime-grants.sql`, applied by the role bootstrap | Governed access grants the Identity runtime the clinician's access-request list. Stage 6 adds the technical role `hid_ocr_queue_metrics`, its policy, and the OCR worker's grant on the queue metrics command. Stage 8 grants the Outreach runtime `auth.account_id_for_subject(text)` (§2). |
| Identity API | `services/identity-api` on `main` (Stage 2A, 4A, 5, 5B, governed access and 7), D-Eminence/hid-system#38 and D-Eminence/hid-system#39 | Platform MFA sessions, step-up, two-person approval and the Stage 4A admin contracts. Stage 5 adds the two fixes in §2; Stage 5B adds the revocation lock; governed access adds the access-request outcome fields; Stage 7 locks the account first in every MFA transaction; #38 lets the patient authorization check accept a workload-reported browser read without Origin and CSRF; #39 lets sign-out end a sign-in by its refresh cookie and refuses a named app the other kind of sign-in while refresh could renew it (§2). |
| EHR and Lab APIs | `services/ehr-api`, `services/lab-api` and `packages/api-client` (D-Eminence/hid-system#38) | Report the method of the request they serve to Identity's patient authorization check (§2). |
| EHR API | `services/ehr-api` (EHR clinical list paging, D-Eminence/hid-system#40) | The six newest-first clinical lists page at the sort key's microsecond precision; cursors from earlier builds are refused (§2). |
| Pharmacy API | `services/pharmacy-api`, and D-Eminence/hid-system#38 | Stage 5 CORS header fix; #38 reports the method of the request it serves (§2). |
| OCR API | `services/ocr-api` (Stage 6), and D-Eminence/hid-system#38 | Patient-linked audit events for OCR evidence reads; #38 reports the method of the request it serves (§2). |
| OCR worker | `services/ocr-worker` (Stage 6) | Queue depth and age through the new aggregate command (§2). |
| Admin console | Health-id `main` (Stage 4B and the Stage 5 fix) | The console for the contracts above. |
| Provider portal | Health-id `main` (governed access, D-Eminence/Health-id#18 and D-Eminence/Health-id#19) | The clinician's access requests with their outcomes, closing a grant, and write gating on the clinical page. |

## 2. Stage 5 changes

- **Refresh-token revocation reason** (`token.service.ts`):
  - Only a rotated refresh token presented again is treated as reuse. Its family is revoked and `reuse_detected` is recorded, as before.
  - A token whose session ended any other way is refused. This covers sign-out, expiry, an administrator's revocation (revoke-all or a family revoke, including one marked compromised), a self-revocation, and an earlier reuse in the family. The refusal is recorded as a `refresh` session event with outcome `denied` and details `{ reason: 'session_ended', revocation_reason, session_kind }`. It is no longer recorded as reuse, and the family is not revoked again.
  - The same rule applies when a session ends while its refresh is in flight. A sign-out, expiry or revocation that commits first is reported as that end. Only a concurrent rotation of the same token counts as reuse.
  - Unchanged: a token whose account changed token version (suspension, platform MFA reset, password recovery, deletion) is not found by the refresh lookup at all. It is refused without a session event, as before. Platform tokens are answered `PLATFORM_SESSION_REVOKED`.
  - Answers are unchanged: platform `401 PLATFORM_SESSION_EXPIRED` (expired) or `PLATFORM_SESSION_REVOKED`, and generic `401 AUTHENTICATION_REQUIRED` for staff and patients. Only the problem `detail` changes, from "Refresh token reuse detected" to "Refresh session ended".
  - Before this fix, the console's normal refresh after an administrator revoked a session recorded `reuse_detected` twice per revocation. That made real token theft harder to spot.
- **CORS**:
  - Identity now allows `PATCH` (organization profile completion, `/identity/organization-applications/completion/profile`) and `DELETE` (patient access PIN, `/identity/me/access-pin`).
  - Pharmacy allows the `x-csrf-token` header that its cookie sessions send.
  - Origins, credentials and every other header are unchanged. No other service had a route whose method or header was missing. EHR's `PATCH` routes were already covered. Lab still lists `PATCH` without a route; that is left as is.
  - Same-origin `/api/v1` routing, the production design, never needed these. They matter only to a cross-origin deployment.
- **Session revocation serialization (Stage 5B, migration 0073)**: an administrator's family revocation (including one marked compromised), revoke-all, an administrator revoking one of their own sessions, and the family revocation after refresh-token reuse could each miss the session that a refresh in flight was creating. That session stayed live until it expired, even after a "compromised" revocation. Each of these revocations now takes the account row lock (`FOR UPDATE`) before revoking. The two admin commands lock the acting administrator's row with the target's, in account order: their idempotency row references the actor's account, so locking only the target would let two administrators revoking each other's sessions at the same moment deadlock. It waits for a refresh in flight to commit, then revokes the session that refresh created. A refresh that starts after the lock waits, then finds its session revoked and is refused. The admin commands `auth.admin_revoke_account_sessions` and `auth.admin_revoke_session_family` keep their signatures, permissions, checks, idempotency and results. The Identity API's own revocations call the new `auth.lock_account_sessions(uuid)`, which is granted to the Identity runtime only. These are refresh-token reuse, an administrator revoking their own session, sign-out and expiry. Sign-out and expiry end one session, but they take the lock first too. Every path that revokes sessions then locks the account row before any session row, so no two of them can deadlock. Without this, a sign-out during an administrator's revocation of the same account could deadlock. Account actions that change the token version (suspension, MFA reset, password recovery, deletion) already invalidated such a session and already locked the account first; they are unchanged. A sign-out now ends the whole sign-in, that is, the presented session's family. Before, a sign-out whose session another tab had just refreshed ended nothing, recorded a successful sign-out, and left the new session live.
- **Admin console (Health-id)**: after **Revoke all sessions**, the confirmation stays visible. Before, the reload reported no sessions and the form, with its confirmation, disappeared. This was found by the browser run in §8.
- **Governed access: the clinician's access-request list** (D-Eminence/hid-system#26, no migration). `GET /identity/access-requests` calls `identity.list_my_staff_access_requests(text)`, but the runtime grants never gave the Identity runtime `EXECUTE` on it. Every clinician's list was refused (`403`). The role bootstrap now grants it, and `runtime-roles.integration.sql` asserts the grant. `runtime-function-grants.spec.ts` checks, without a database, that every database function the Identity source calls is granted to its runtime.
- **Governed access: access-request outcomes** (D-Eminence/hid-system#28, migration 0074). An approved request stayed `approved` after its grant expired, was revoked by the patient or was closed by the clinician. The list now also returns, from the latest grant made from each request, `consentGrantId`, `grantExpiresAt`, `authorizationMethod` and `effectiveStatus`. For an approval with a grant, `effectiveStatus` reports whichever ended the grant first: `active`, `expired`, `closed` (by the requesting clinician) or `revoked` (by anyone else). Otherwise it is the request status. The `status` filter matches either the request status or the outcome, and also accepts `active` and `closed`. The function's arguments, caller checks, order and 100-row limit are unchanged.
- **OCR audit, queue metrics and outbox inserts (Stage 6, migration 0075)**:
  - **Read audit:** the OCR job lookup by document, the validation list and the publication list now write a patient-linked audit event (`ocr.job.find`, `ocr.validation.list`, `ocr.publication.list`) in the read transaction, after authorization; a failed audit write fails the read. Every OCR API job event, including the existing reads and writes, now names the source document's patient, which authorization resolves. Before, it used the job's own `patient_id`, which stays null for a job created without one, so those events were not linked to any patient. Details carry identifiers and counts only.
  - **Queue metrics:** the worker read `ocr.jobs` directly, which `hid_ocr_worker` may not do. Every read was refused, so `ocr.job.claimed` never carried `queueDepth` or `oldestQueueAgeSeconds`, and `OcrQueueAgeAlarm` and the QueueDepth signal had no data. The worker now calls `ocr.worker_queue_metrics()`, which returns only those two aggregates, with the same definitions. Its owner, the new non-login role `hid_ocr_queue_metrics`, reads only `ocr.jobs.status` and `queued_at` through one exact policy. The worker still has no table privileges.
  - **Outbox inserts:** `ocr.outbox_events` had only `SELECT` policies under `FORCE ROW LEVEL SECURITY`, so the OCR API runtime could not append outbox events. Patient confirmation and every publication request, success and failure failed with `new row violates row-level security policy`. 0075 adds a same-facility insert policy. The confirmation event is keyed by the job version, which a confirmation does not change, so a second confirmation of the same job version is now refused with `409 OCR_PATIENT_ALREADY_CONFIRMED`. Without that check it would fail on the outbox unique key with a `500`.
- **MFA lock order (Stage 7A, migration 0076)**: approving a platform MFA reset (`auth.admin_decide_approval`, 0070) locks the target's account row `FOR UPDATE`, then revokes its factors, recovery codes and sessions. Every MFA transaction of that account first locked its challenge and factor, or its session assurance and factor, or wrote a recovery code. It reached the account row only through the `FOR KEY SHARE` that its session event, session, recovery code or factor insert takes. The two could deadlock, and PostgreSQL then cancelled one. Reproduced locally for TOTP and recovery-code sign-in, step-up, recovery-code regeneration, enrolment activation and enrolment restart: each MFA request failed with `500` (§8). Every MFA transaction now calls the new `auth.lock_account_for_mfa(uuid)` (0076, granted to the Identity runtime only) before any other lock or write. That covers the password step, both sign-in methods, enrolment start and activation, step-up and regeneration. The order is then: the account; the challenge (sign-in and enrolment) or the session assurance (step-up); the factor and the recovery codes; then sessions and events. A challenge is found without a lock only to learn its account, then read again, locked, for that account. A request that waited for a reset is refused cleanly: `401 MFA_CHALLENGE_INVALID` for a sign-in or enrolment, `403 PLATFORM_SESSION_REQUIRED` for a step-up or regeneration. The helper takes `FOR NO KEY UPDATE`. It conflicts with the reset's and every revocation's `FOR UPDATE` and with itself, so MFA transactions of one account run one at a time, but not with the `FOR KEY SHARE` that refresh rotations and staff sign-ins take when they insert a session or a session event. Two other modes were rejected after the adversarial reviews, each reproduced locally (§8):
  - `FOR UPDATE`, the first version, which reused the revocation helper `auth.lock_account_sessions` (0073), made MFA transactions also wait for refresh rotations and staff sign-ins of the account. A step-up or regeneration that raced a refresh of its own sign-in waited, then found its session rotated and was refused `403 PLATFORM_SESSION_REQUIRED`, which ends the console session. The password step deadlocked with a staff sign-in of the same administrator through the principal's login-attempt row (`500`).
  - `FOR KEY SHARE`, the second version, does not conflict with itself, so MFA transactions of one account ran together. Each checked the second-factor failure limit before any of them had committed a failure: six parallel step-ups with a wrong code were all tested, where the limit allows five failures and then refuses (`429 MFA_RATE_LIMITED`), so one block window allowed about as many guesses as the Identity API has database connections. Two parallel password steps each left a challenge open, which also let an enrolment start overlap an activation. `main` before Stage 7 had no account lock and the same two gaps.

  With `FOR NO KEY UPDATE` none of these happens (§8). Platform session issue also resolves the administrator on the locked transaction's own connection, so the lock holder never needs a second pool connection (ADR-040).
- **Fail-closed OCR validation guards (Stage 7B, migration 0076)**: `ocr.validate_patient_confirmation` and `ocr.validate_validation_insert` compared with `<>`, which is NULL when either side is NULL, and a NULL condition did not raise. So a confirmation was accepted for any patient when the guard could not read the source document (missing, or hidden by row-level security from a non-bypass owner, P8), and a validation was accepted when the guard could not read the extraction or the session had no account or membership. Both now refuse a missing job, source patient, extraction, account or membership, and compare with `IS DISTINCT FROM`; the explicit `IS NULL` refusals are redundant in outcome only because every compared column of the new row is `NOT NULL`: `IS DISTINCT FROM` refuses a NULL against a value, but not a NULL against a NULL, which the `NOT NULL` constraint then refuses (`23502`, not the guard's `23514`). The confirmation guard also binds `confirmed_by` and `confirmed_by_membership_id` to the session, as the validation guard does for the reviewer; before, any session in the facility could attribute a confirmation to another member. Error codes and messages are unchanged, and the OCR API always writes the session's own account and membership, so its confirmations and validations pass as before. CREATE OR REPLACE keeps each function's owner and ACL; `SECURITY DEFINER`, `search_path` and volatility are restated exactly.
- **Fail-closed session guards and OCR worker leases (Stage 8, migration 0077)**. No service changes. Apart from lease renewal now succeeding, and a worker's failure of a job whose lease has expired now being refused (§3), the database refuses what it accepted before only for callers the services never are:
  - **OCR worker leases:** `ocr.complete_worker_job` and `ocr.fail_worker_job` compared the claim token with `<>`, so a NULL token passed the lease check: any session of the OCR worker subject, which every worker replica shares, could complete or fail a job another replica held. Both now refuse a NULL token (`55000`), as `ocr.renew_worker_claim` did, and `fail_worker_job` also refuses an expired lease. Missing result or failure metadata (content hash, payload, provenance, error code, retry flag, retry delay) is refused as invalid (`22023`); before, a NULL hash replayed a stored extraction and a NULL retry flag failed a job for good.
  - **OCR lease renewal:** the job trigger allowed no `processing` to `processing` update, so every `ocr.renew_worker_claim` was refused and the worker logged `ocr.job.lease_renewal_failed` every third of a lease. A job that ran longer than its lease (300 s by default) could not complete and was recovered and run again. Renewal now succeeds: an active lease may move later, at most an hour ahead, with the next version, and nothing else may change. A renewal records no status event.
  - **OCR job source evidence:** the job trigger compared the latest scan with `<>`, so a document with no scan event passed. An insert, a change of source, or the start of processing now needs an exact clean scan. Jobs created earlier without a scan event can still be failed, retried, renewed and validated; run P9 before the release to see whether any exist. The OCR API already refused such a source, and the worker never claimed one.
  - **Taking an OCR job out of play:** failing, cancelling or requeueing a job no longer re-reads its source evidence. Before, a job whose document was withdrawn (`entered_in_error`) or rescanned as not clean while it was processing could be neither completed nor failed, and the lease recovery in `ocr.claim_worker_job` then raised for every claim of its provider: OCR stopped for that provider until an operator repaired the data. Reproduced locally on 0076; a clinician marking a document entered in error during OCR was enough. Completing or validating such a job is still refused, and a requeued one is still claimed only with clean evidence.
  - **OCR publication requester:** a publication request may only name the session's own account and membership as requester (the attribution gap 0076 closed for confirmations).
  - **Lab, Pharmacy and Outreach guards:** the 13 guards that compared a row with the session's account or membership using `<>` (five Lab, five Pharmacy, three Outreach) refuse a missing session account, membership or facility, and Outreach a purpose other than direct care, with their existing codes and messages. Forced row-level security already refused such writes for the runtime roles; a session that bypasses it (a superuser, or an owner without `FORCE ROW LEVEL SECURITY`) could write rows attributed to any member with no context. The Lab OCR-import guard also refuses another facility's OCR evidence when its owner cannot read it (P8).
  - **Outreach runtime grant:** Outreach policies call `platform.current_account_id()` as the runtime, which calls `auth.account_id_for_subject(text)`, revoked from PUBLIC. The Outreach runtime had no `EXECUTE` on it, so every Outreach write failed with `42501` since the baseline. The bootstrap now grants it; `runtime-roles.integration.sql` and the Outreach API spec `runtime-function-grants.spec.ts` check it. Campaign-linked registration still fails on a separate defect (§4.2).
- **Delegated cookie reads (D-Eminence/hid-system#38, no migration)**. EHR, Lab, OCR and Pharmacy authorize each patient-scoped request through `POST /identity/service/authorization/check`, forwarding the browser's cookie. Identity's `SecurityGuard` treated that POST as a browser write and required `Origin` and `X-CSRF-Token`, which a same-origin browser `GET` does not send, so every delegated read from a cookie session was refused `403 ORIGIN_DENIED`. Reproduced locally over HTTP for a doctor's cookie-only `GET /ehr/patients/:id/encounters`; Lab, OCR and Pharmacy reads take the same path.
  - **Services:** each `requireRequestContext` now records `request.method` as `requestMethod`, and `@hid/api-client` sends it to Identity as `X-HID-Original-Method` (upper-cased, only when it is 1–16 letters). Only the patient authorization call passes it.
  - **Identity:** the new `@DelegatedBrowserRequest()` (`common/decorators.ts`) marks `service/authorization/check` only. On that route `SecurityGuard.delegatedSafeBrowserRequest` skips the cookie Origin and CSRF check when the reported method is exactly `GET`, `HEAD` or `OPTIONS` and the request authenticates through `WorkloadAuthService.authenticateService` as any approved caller (`ehr-api`, `lab-api`, `pharmacy-api`, `ocr-api`, `outreach-api`). Identity cannot check the reported method itself; it relies on the authenticated workload (§9; ADR-043).
  - **Unchanged:** a reported write, a missing, lower-case or unknown method, a wrong or missing workload token and an unapproved caller name all keep the check (`ORIGIN_DENIED`, or `CSRF_VALIDATION_FAILED` with an allowed Origin and no CSRF). Every other route keeps it, including `POST /auth/service-session`, through which the four services still revalidate a real cookie write's Origin and CSRF before acting. Bearer transport, facility, permission, workload authentication in the handler and the patient decision are unchanged. Outreach's own Identity routes (`POST /identity/outreach/authorize` and `POST /identity/outreach/patient-authorization`) are not marked. Its one patient authorization call, for the link-existing write (`IdentityService.authorizeExistingPatient`), goes to the marked route but sends no method, so the check still applies.
- **EHR clinical list paging (D-Eminence/hid-system#40, no migration)**. The six newest-first clinical lists (`GET /ehr/patients/:id/encounters`, and an encounter's `clinical-notes`, `diagnoses`, `lab-requests`, `prescriptions` and `vitals`) page with a keyset cursor on (sort key, `id`). The keys are `timestamptz` columns with microseconds: `created_at` defaults to `clock_timestamp()`, and `started_at` and `recorded_at` keep any fraction the client sends. The cursor was built from the row's JavaScript `Date`, which node-postgres gives only milliseconds, so the next page's bound fell to the start of the last row's millisecond. Rows that sort after the last row shown within its millisecond (earlier in that millisecond, or tied with a lower `id`) were never listed, most likely rows created in bulk or by import (Health-id `docs/OPEN-QUESTIONS.md`, "Timeline pages skip rows within a millisecond").
  - Each list now also selects its key as microsecond text (`to_char(key at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`), and the cursor carries that text, never the `Date`. The text has a five- or six-digit year after 9999, which `started_at` and `recorded_at` can hold because they take any instant the client sends; the cursor accepts those years, up to 294276, the last a `timestamptz` holds.
  - The cursor is now version 1, bound to its list, its patient and, for the five encounter lists, its encounter, and accepted only in the exact form issued, as Identity's admin cursors are. A well-formed cursor (16–512 base64url characters) in any other form, including every cursor in the earlier millisecond format, is `400 INVALID_CURSOR`. A `cursor` that is not well formed is still `400 VALIDATION_FAILED`.
  - The response shape `{ items, nextCursor }`, `limit` (1–100, default 50) and the queries' predicates, order and parameters are unchanged (`INTERFACE_CONTRACT.md` §11, `DATABASE.md`).
- **Provider portal (Health-id)**:
  - D-Eminence/Health-id#18 reads the list above, closes a grant, and enables clinical writes only when `POST /identity/consent-status` allows them.
  - D-Eminence/Health-id#19 shows each approval's outcome and expiry, offers **Close access** for an active grant, and adds the outcome filters. The new fields and filters appear only when Identity reports them.
- **Sign-out by refresh cookie, and refresh and sign-out of the calling app's sign-in only** (D-Eminence/hid-system#39; Identity only, no migration or grant change). The contract is in `INTERFACE_CONTRACT.md` ("Auth session contract") and the decision in ADR-044.
  - **Idle sign-out:** `POST /auth/logout` needed a live access token. The access cookie lasts 15 minutes and the refresh cookie 8 hours (defaults), so a browser left idle could not sign out: the guard answered `401` before the handler ran, the cookies were not cleared, and the sign-in stayed refreshable until its refresh window ended. Sign-out now authenticates itself. A live access token ends its own sign-in, as a bearer token or as the cookie with an allowed `Origin` and its CSRF token. Without one, the refresh cookie ends its sign-in when the request carries the CSRF token derived from that refresh token. A live access token always decides, so another account's refresh cookie riding along is never ended. A cookie sign-out without an allowed `Origin` is `403 ORIGIN_DENIED` and changes nothing; every other outcome except `SESSION_CLIENT_MISMATCH` clears the cookies. Platform maintenance and a disabled portal no longer block sign-out.
  - **Client kind:** the staff and patient portals share the session cookies on one origin, so a stale tab of one could rotate the other's sign-in by refreshing, or end it by signing out. `POST /auth/refresh` and a cookie `POST /auth/logout` read `X-HID-Client` (`staff-web` or `patient-web`). After the Origin and CSRF checks, a sign-in of the other kind that refresh could renew now is refused with `403 SESSION_CLIENT_MISMATCH`: nothing is rotated or ended and the cookies are kept (below for any other). A bearer sign-out ignores the header, and an app that does not name itself behaves as before. Identity's CORS allow-list now admits `x-hid-client`.
  - **Lookups:** the kind is answered only for a sign-in refresh could renew now: the account is active, not disabled and on its token version, the absolute end has not passed, and the token's session is live or was rotated within the last 60 seconds into one that is. On refresh, any other token goes on to rotation; an older rotated token is reuse, which ends the sign-in. Sign-out by refresh cookie reads the sign-in under the account lock and ends whatever is left of it (the session unrevoked, or rotated into one that is), whatever its expiry or the account's state, so a sign-out during a timed suspension leaves nothing to renew when it lapses. A sign-in it may not name is ended whichever app asks, without naming its kind, so an old rotated token tells nobody whether, or as which app, its sign-in is live. Every sign-out ends only sessions still unrevoked under the account lock, and records and audits only when it ended one, so a replayed cookie or two tabs signing out at once, by either path, record one sign-out.

## 3. Compatibility

| Identity build | Stage 3 console (Health-id `d5ce01c`) | Stage 4B console (`a180cea`) and later |
| --- | --- | --- |
| Before Stage 2A (no migration 0069; no platform MFA sign-in) | Not usable: platform sign-in needs Stage 2A. | Not usable for the same reason. Admin sign-in fails until Stage 2A Identity is deployed. |
| Stage 2A to Stage 3 (0069–0071) | Supported (the earlier release) | Works with less. Approvals list one capped page and the target audit filter returns `400`. Authenticator enrolment shows "Not reported" and the session-end notice is generic. See the Health-id Stage 4B release note. |
| Stage 4A (`deb6fba`) and later, including Stage 5 | **Not supported.** The console does not handle `STEP_UP_EXPIRED`, so every high-risk action is refused once the first step-up is five minutes old. | Supported, and verified end to end (§8). |

Stage 5 changes no request or response contract the console uses, so Stage 4B
and Stage 5 consoles both work with Stage 4A and Stage 5 Identity.

**Rule:** never run Identity at Stage 4A or later with a console older than Stage 4B.

**OCR (Stage 6):**
- The Stage 6 OCR API needs no schema change: its new audit events use the existing `audit.events` contract. It can be deployed before or after 0075.
- The outbox insert policy takes effect for every OCR API build as soon as 0075 is applied.
- A Stage 6 worker that runs before 0075 and the bootstrap cannot execute `ocr.worker_queue_metrics()`. It logs `ocr.queue.metrics_unavailable` and claims jobs exactly as earlier workers do. Earlier workers keep reading `ocr.jobs` directly after 0075 and keep logging that warning.

**Stage 7:**
- The Stage 7 Identity calls `auth.lock_account_for_mfa(uuid)`, so it must not start before 0076 and the role bootstrap: without them every platform MFA transaction (sign-in, enrolment, step-up, regeneration) fails with a database error (`5xx`). Earlier Identity builds do not call it. Stage 7 changes no request or response contract.
- 0076 works with every OCR API build: each writes the session's own account and membership, so its confirmations and validations pass when the compared values are present. Under a schema owner that cannot read the source document (P8), every confirmation is now refused by the database (`23514`), which the OCR API answers with `500`, instead of being accepted for any patient.

**Stage 8:**
- 0077 needs no service change and works with every build. The OCR worker always sends its claim token and the OCR API always names the session's member, so their writes pass as before. A worker's lease renewals now succeed. A worker that fails a job after its lease expired is now refused (`55000`) and logs `ocr.job.failure_persistence_failed`; the next claim's lease recovery takes the job over, as it already did for completions.
- The Lab, Pharmacy and Outreach APIs always set the full session, so their writes pass as before. A maintenance write to those tables from a superuser or migration session without a staff context is now refused; set a real staff context, or change the data under change control.
- The Outreach API can write only after the bootstrap's new grant (§5). Earlier, every Outreach write failed (`5xx`).

**Delegated cookie reads (D-Eminence/hid-system#38):**
- No schema, grant or browser contract change; Health-id needs no change.
- Same-origin cookie reads through a service work only once both that service and Identity run #38. Either side alone behaves exactly as before: an earlier Identity ignores `X-HID-Original-Method`, and an earlier service does not send it, so the read is still refused `403 ORIGIN_DENIED`. OCR's cookie reads (a job, find-by-document, extractions, validations and publications) also need EHR with #38, because OCR reads each job's source document through EHR's `GET /ehr/internal/ocr/documents/:id/source`, which EHR authorizes with the forwarded cookie. Deploy in any order; OCR reads work once OCR, EHR and Identity all run #38.
- Writes, bearer requests and Outreach behave the same with any combination of builds.

**EHR clinical list paging:**
- No schema, grant or response-shape change.
- The new EHR build refuses every cursor an earlier build issued, and an earlier build refuses the new cursors, both with `400 INVALID_CURSOR`. A browser that holds a cursor across the deploy, or meets both builds during a rolling deploy, gets that refusal on its next paged request.
- Health-id's clinical record (`apps/patient-web/src/staff/routes/Clinical.tsx` on Health-id `main`) then reloads the first page of that list and says that it restarted; it needs no change. The in-repo EHR app (`apps/ehr`) requests only first pages (`limit=50`, no cursor).

**Governed access:**
- The provider portal of D-Eminence/Health-id#19 works with any Identity build that serves the access-request list. It shows outcomes and offers the outcome filters only when Identity reports `effectiveStatus`. Otherwise it shows the request status, as before.
- An Identity build with the 0074 mapping selects the new columns by name, so it fails on the list (`5xx`) until 0074 is applied.
- Earlier Identity builds keep working after 0074 and the bootstrap. They ignore the new columns, and their request validation refuses the `active` and `closed` filters (`400`). The portal offers those filters only to an Identity that reports outcomes.

**Sign-out and client kind (D-Eminence/hid-system#39, if released):**
- It needs no migration or grant beyond what Stage 5B already needs (0073 and the bootstrap's `auth.lock_account_sessions` grant): the new lookups read `auth.sessions` and `auth.accounts`, which the Identity runtime already reads.
- Health-id `main` sends no `X-HID-Client`. All its hid-system clients use cookie mode, where `packages/http/src/client.ts` omits the header. Its portals already handle the idle `401`: the patient portal refreshes and signs out again only for the same patient (`apps/patient-web/src/session.tsx`, `signOut`), and the provider portal restores its session and retries (`apps/patient-web/src/staff/api.ts`, `signOutStaffSession`). With #39 the first sign-out ends the sign-in by refresh cookie, without that refresh. Because no header is sent, it ends whichever staff or patient sign-in the refresh cookie holds, including the other portal's or another account's. The patient portal's same-patient check does not apply on that path. The kind check stays inert until a portal sends the header (D-Eminence/Health-id#35, which did, was closed unmerged). `packages/identity-browser-client` sends none either.
- A portal that sends `X-HID-Client` works with earlier Identity builds on the same origin, which ignore the header. Their CORS allow-list lacks it, so a cross-origin request carrying it would fail its preflight.

## 4. Prerequisites and pre-release checks

| # | Check | Owner | How |
| --- | --- | --- | --- |
| P1 | The production migration ledger's last applied version is known. | Database operator | `npm run db:plan` as the migration administrator, as in `MIGRATION_RUNBOOK.md` §6. It applies nothing, but its ledger bootstrap statements need the administrator's privileges, so it cannot run with read-only credentials. The local rehearsal covers 0028 → 0077 (0028 → 0078 with the PIN actor-window branch); any other starting point needs its own rehearsal. |
| P2 | A restorable backup of the target database exists and its restore was tested. | Database operator | Snapshot or `pg_dump` taken immediately before the window. The rehearsal checks backup and restore integrity, but the real restore must be proven on staging. |
| P3 | `MFA_SECRET_KEY_B64` is provisioned for Identity: 32 random bytes, base64, from the secret store. `MFA_KEY_VERSION` is set. | Security owner and infrastructure owner | **The infrastructure code does not do this yet.** `infra/aws/src/hid-regional-stack.ts` maps no `MFA_SECRET_KEY_B64` from the Identity secret and sets no `MFA_KEY_VERSION`, which then defaults to `local-v1`. Stage 2A recorded this as an infrastructure task. An infrastructure change must add both before step 6. Without the key, platform sign-in fails closed with `503 MFA_UNAVAILABLE`, and a malformed key stops Identity at start-up. Never reuse a staging key in production. The key and `MFA_KEY_VERSION` are fixed when the first authenticator is enrolled: changing either later invalidates every enrolled authenticator unless a re-encryption release exists. |
| P4 | Identity `CORS_ORIGINS` lists only the exact HTTPS console origins, with no paths. | Platform operator | Enforced at start-up in production. With same-origin `/api/v1`, CORS is not used by the console. |
| P5 | The sizes of `audit.events`, `auth.sessions`, `auth.session_events` and `identity.consent_grants` are known, for the lock windows of 0067, 0069, 0072 and 0074. | Database operator | `select count(*)` and `pg_total_relation_size(...)` for each table on a recent snapshot. See §5. |
| P6 | Two Super Admins can sign in and confirm. | Security owner | Two-person approval needs a second Super Admin. Facility suspension needs at least one reachable Super Admin (0072). On a first deployment of Stage 2A (no platform sign-in yet), check this after step 6, when the Super Admins enrol their authenticators. |
| P7 | The staging acceptance in §7 passed on the exact builds being released. | Release owner | Evidence attached to the release record. |
| P8 | The role that owns the schema objects (the migration administrator) is a superuser, or is otherwise allowed to own functions that `SET plpgsql.variable_conflict` and bypasses `FORCE ROW LEVEL SECURITY`. | Database operator | Document scanning, the OCR pipeline and Outreach campaign registration depend on it, because their security-definer commands and triggers read row-level-secured tables as their owner. The rehearsal migrates as a superuser, and its non-superuser owner check runs only the additional suites, which do not cover these paths. Run locally on a copy with every function and table owned by a `NOSUPERUSER NOBYPASSRLS` role (§8), `schema.integration.sql` failed in turn at each of these, and passed in full once all of them were returned to a superuser owner:<br>• `ehr.append_document_scan_event` (`Document not found`);<br>• the `ocr.record_job_event` trigger (row-level security on `ocr.job_events`);<br>• `ocr.claim_worker_job` (`permission denied to set parameter "plpgsql.variable_conflict"`, set by 0015);<br>• `ocr.validate_job_write`, `ocr.complete_worker_job`, `ocr.validate_extraction_insert` and `ocr.fail_worker_job`;<br>• `ocr.validate_patient_confirmation`, whose wrong-patient check failed open because it compares with a document it cannot see. Under such an owner this path is unreachable, because claims already fail. Since 0076 the guard fails closed instead: under such an owner every confirmation is refused;<br>• `lab.validate_imported_evidence`, whose OCR publication branch accepted another facility's validation and publication because it could not read them (reproduced locally). Since 0077 it refuses them; a Lab import of the session facility's own OCR evidence still passes;<br>• `outreach.validate_registration_campaign_write` (`Exact Outreach campaign membership is required`).<br>The list covers what `schema.integration.sql` exercises; other definer paths may share the dependency. Before the release, confirm the owner's attributes as the migration administrator (`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`). The role bootstrap itself also needs a superuser today: it re-asserts `NOSUPERUSER … NOBYPASSRLS` with `ALTER ROLE` on every run, which PostgreSQL 16 allows only to a superuser, even when nothing changes (verified locally, §4.1). On a managed service whose administrator is not a superuser, such as Amazon RDS, 0015 does not apply as it stands: a non-superuser migration administrator is refused `SET plpgsql.variable_conflict` (`permission denied to set parameter`) unless it holds `GRANT SET ON PARAMETER plpgsql.variable_conflict` (verified locally, §4.1). The grant must stay in place afterwards: `ocr.claim_worker_job` applies 0015's setting as its owner on every call, so every OCR claim fails once it is revoked (verified locally). Arrange that grant before the staging rehearsal (S1), and confirm there that 0015 applies and that an OCR claim succeeds (S4b); a patient confirmation needs the §4.2 OCR fix first. The alternative is dedicated technical owners for these commands, proposed in §4.1 and ADR-041; it is not implemented. The new `ocr.worker_queue_metrics()` depends on none of this. |
| P9 | No OCR job's source document lacks an exact clean scan, or each one found is accounted for. | Database operator | Before applying 0077, run the read-only check below on staging and then production as the migration administrator; it writes nothing, and `row_security = off` makes it fail instead of reporting zeros if the role cannot see every row. The worker never claims a job it lists, and after 0077 such a job cannot be started either. One whose `latest_scan_event` is `<none>` can still be failed, retried and validated; one with a scan that is not clean cannot be completed or validated. Either kind can be cancelled after 0077 (before it, only a `<none>` job could). The OCR API has no cancel route: cancel with a reviewed direct update under change control (`status = 'cancelled'`, `row_version = row_version + 1`), or record why a job stays. A queued job left in place keeps counting in `oldestQueueAgeSeconds`, so `OcrQueueAgeAlarm` keeps firing. Verified locally on synthetic data: it lists every job of a document without a scan event. |

P9 check (read-only):

```sql
begin transaction isolation level repeatable read read only;
set local statement_timeout = '120s';
set local lock_timeout = '5s';
set local row_security = off;
with latest_scan as (
  select distinct on (scan.document_id) scan.document_id, scan.event_type, scan.object_version_id,
         scan.object_sha256_hex, scan.binding_migration_hold_reason
    from ehr.document_scan_events scan
   order by scan.document_id, scan.created_at desc, scan.id desc)
select job.id as job_id, job.facility_id, job.document_id, job.status, job.attempt_count,
       coalesce(latest_scan.event_type, '<none>') as latest_scan_event, job.created_at, job.updated_at
  from ocr.jobs job left join latest_scan on latest_scan.document_id = job.document_id
 where latest_scan.document_id is null
    or latest_scan.event_type <> 'clean'
    or latest_scan.object_version_id is distinct from job.source_object_version_id
    or latest_scan.object_sha256_hex is distinct from job.source_sha256_hex
    or latest_scan.binding_migration_hold_reason is not null
 order by job.status, job.created_at, job.id
 limit 500;
rollback;
```

### 4.1 P8 follow-up: dedicated technical owners (proposal, Stage 7C)

This is a design proposal only, recorded in full in ADR-041. No ownership,
grant or policy has been changed. It would remove the run-time superuser
requirement of P8 for the functions listed, using the pattern of
`hid_ocr_queue_metrics` (0075) and `hid_event_delivery_commands`.

- **Functions and owners.** Five non-login, non-inherited, non-bypass roles:
  - `hid_ocr_worker_commands` owns the four worker commands (claim, renew,
    complete, fail), and the test-only wrappers `ocr.claim_next_job`,
    `ocr.record_extraction` and `ocr.fail_job` that call them;
  - `hid_ocr_job_guard` owns the five OCR insert and job guards
    (`validate_job_write`, `validate_extraction_insert`,
    `validate_validation_insert`, `validate_patient_confirmation`,
    `validate_publication_write`);
  - `hid_ocr_job_events` owns `record_job_event`;
  - `hid_document_scan_commands` owns `ehr.append_document_scan_event`;
  - `hid_outreach_campaign_guard` owns
    `outreach.validate_registration_campaign_write`.

  `ocr.worker_queue_metrics()` is already done. These are not all the
  definer functions involved: of the 175 that the migration administrator
  owns, 65 name a table with `FORCE ROW LEVEL SECURITY` and 101 name any table
  with row-level security, most outside these schemas. The other 36 name only
  identity tables with row-level security but no `FORCE` (`identity.patients`,
  `patient_identifiers`, `access_requests`, `consent_grants`,
  `consent_directives`, `consent_directive_versions`), whose policies do not
  apply to their owner but would apply to a technical owner. Each must
  pass `schema.integration.sql` and the runtime verifiers under the
  non-superuser owner before the requirement is dropped, or get a technical
  owner too.
- **Minimum privileges.**
  - Each role gets `USAGE` on its schemas, grants for the columns its
    functions read, insert or update, and `EXECUTE` on the helpers it calls.
  - The guards read whole rows (`select *`) of `ocr.jobs`, `ocr.validations`
    and `ocr.patient_confirmations`, so they need every column of those
    tables, unless the implementing migration rewrites those reads.
  - A row lock needs `UPDATE` on at least one column.
  - No role owns a relation, and no runtime role is granted a technical role.
- **Row-level security.**
  - Each role gets exact cross-facility policies `TO <role> USING (true)`,
    which is what today's superuser owner sees. The worker, the scanner and
    the job triggers inside worker transactions name no facility.
  - Locking roles get a `FOR UPDATE` policy.
  - A lock-only role also gets a restrictive `FOR UPDATE … WITH CHECK (false)`
    policy. A permissive one would not stop an update that an existing `PUBLIC`
    update policy admits.
  - `ocr.job_events` gets its first insert policy, for `hid_ocr_job_events`
    only.
- **`plpgsql.variable_conflict`.** A new migration replaces
  `ocr.claim_worker_job` with `#variable_conflict use_column` on the first
  line of its body and no 0015 setting. Verified locally on PostgreSQL 16.15:
  - a non-superuser-owned definer that applies 0015's `SET` fails with
    `permission denied to set parameter "plpgsql.variable_conflict"`;
  - the in-body option works under such an owner;
  - a non-superuser can replace the function this way, but cannot
    `ALTER FUNCTION … RESET` the setting.

  This does not let a non-superuser apply 0015 itself, which is also refused
  to it. A database migrated from 0001 by a non-superuser administrator, as on
  RDS, stops at 0015 unless that administrator holds `SET` on the parameter
  (`GRANT SET ON PARAMETER`, PostgreSQL 15 and later). The grant must then
  stay: `ocr.claim_worker_job` applies 0015's setting as its owner on every
  call, so OCR claims fail once it is revoked, until the in-body replacement
  ships. A superuser must grant it, or the RDS master if RDS allows it, which
  is unverified. This part of P8 stays open.
- **No superuser schema owner** (each point verified locally with a
  `NOSUPERUSER CREATEROLE` administrator):
  - the bootstrap must create roles with their attributes and check them, not
    `ALTER ROLE … NOSUPERUSER`;
  - transferring a function needs `SET` on the technical role, and `CREATE` on
    the schema for that role, granted and revoked around the transfer;
  - a later `CREATE OR REPLACE` of a technical-owned function runs as the
    technical role (`SET ROLE`), again with `CREATE` granted for that
    statement only.
  - An `INHERIT` membership would also work, but every technical policy would
    then apply to the migration administrator and to the definer functions it
    still owns. `runtime-roles.integration.sql` would allow exactly the
    administrator's `SET`-only memberships.
- **Migration, rollback, compatibility.**
  - Order: one behaviour-neutral migration (the claim body; explicit columns
    in the scanner command and, if chosen, in the guards), then the bootstrap.
  - No API, worker or contract change.
  - Rollback: return ownership to the migration owner and drop the technical
    policies.
  - The rehearsal's non-superuser owner check would also run
    `schema.integration.sql` and assert each owner. S1 repeats it on RDS.

### 4.2 Release blockers found in Stage 8 (not fixed)

**Runtime roles cannot run their own locking statements.** `SELECT ... FOR UPDATE` and `FOR SHARE` need `UPDATE` privilege on each locked table, and the runtime roles have only `SELECT` and `INSERT` on most evidence tables. Run on a local 0076 database as each service's runtime role, these statements fail with `42501 permission denied for table ...` before any row is read, so the whole command fails (`5xx`):
- Pharmacy (`pharmacy.service.ts`): the acceptance replay (`work_items`, line 75), dispensing (`work_items` and `dispensings`, lines 144 and 152), reversal (`dispensings` and `dispensing_reversals`, lines 196 and 204) and OCR import (`imported_medication_evidence`, line 236). Every Pharmacy write command fails.
- Lab: the import replay (`lab-imports.service.ts:66`, `imported_evidence`), EHR-order acceptance (`lab-work-items.service.ts:40`, `work_items`) and accession (`lab-accessions.service.ts:41`, `accessions`).
- OCR API (`ocr.service.ts`): the validation replay (line 254, which locks `validations` with `jobs`), the confirmation replay (line 343, `patient_confirmations`) and the validation lock of a publication request (`createPublication`, line 386, through `findValidation` at line 558). OCR validation, patient confirmation and publication requests fail, so S4b cannot pass.
- Outreach: campaign-linked registration (`outreach.service.ts:266`, `FOR SHARE` of `campaign_members`).
- Identity: `loadCaseForUpdate` (`nin-registration.service.ts:557`) takes `FOR UPDATE` on a query with `LEFT JOIN identity.patients`, which PostgreSQL refuses for any role (`FOR UPDATE cannot be applied to the nullable side of an outer join`). Both NIN registration review paths that call it fail.

Unit tests mock the database and no runtime verifier exercises these commands, which is why they were not caught; the defects date from the baseline. A column-level `UPDATE` grant alone does not help: without an `UPDATE` policy, row-level security then hides every row from the lock. Most of these locks protect insert-only rows, which no transaction updates, so the likely fix is to drop them (or name only the mutable table with `FOR UPDATE OF`) and rely on the unique constraints and the serializable transactions already used, path by path, with runtime-role tests of each command. That is a service change across five services and is left to its own stage.

## 5. Migration order and lock windows

1. Apply migrations in ledger order with `npm run db:migrate`. Every migration runs in one transaction with `lock_timeout 5s` and `statement_timeout 120s` (each statement), and a failed migration rolls back completely. Never edit an applied migration; checksums are verified.
2. **0067** adds `access_scope` with a `CHECK` to `audit.events`, then replaces three checks and validates them. This runs in one transaction under an `ACCESS EXCLUSIVE` lock, held to commit, with full-table validation scans. **Reads and writes of `audit.events` are blocked for the whole migration**, which stops nearly every audited request.
3. **0069** drops and re-adds validated `CHECK` constraints on `auth.sessions` and `auth.session_events` under `ACCESS EXCLUSIVE`. Sign-in, refresh and session checks wait while it scans.
4. **0072 builds `audit_resource_uuid_sequence_idx` without `CONCURRENTLY`.** This is possible only inside the runner's transaction. The build holds a `SHARE` lock on `audit.events`:
   - every audited write waits until the build finishes, and that includes most authenticated requests;
   - reads continue.
5. Each of these statements must finish within 120 s, or its migration rolls back and nothing changes. The 5 s `lock_timeout` also fails a migration that cannot get its lock, so stop traffic to Identity, or keep it low, during the window. Measured locally for 0072 only (Stage 5, PostgreSQL 16, synthetic rows, development container, not production hardware): over 1,000,000 audit rows (414 MB, two thirds with a UUID target), the index statement ran in 1.1 s under the runner's settings and produced a 35 MB index. 0067, 0069 and 0074 (step 7) were not measured. Measure all four in the staging rehearsal (S1), scale by the P5 sizes with a wide margin for production I/O, and size the window on the combined cost.
6. **0073** replaces two functions and adds one. It takes no table lock and needs no window. At run time, each session revocation, sign-out and expiry holds its account row lock until it commits, usually milliseconds. Sign-ins, refreshes and sign-outs of that one account wait for that long. Once every Identity instance runs Stage 5B, every path that revokes sessions takes the account row before any session row, so they cannot deadlock with each other. Pre-existing, and unchanged: two administrators changing each other's accounts at the same moment (status, platform role) can deadlock, because each command locks its target and then references its actor. A session revocation can join that cycle when the target's account id sorts before the actor's. PostgreSQL cancels one command, which fails and can be retried; nothing is half applied.
7. **0074** has two effects:
   - It builds `consent_grants_request_idx` without `CONCURRENTLY`, under a `SHARE` lock on `identity.consent_grants`. New grants wait until the build finishes, that is, a patient's approval and a clinician's PIN access. Reads continue. Not measured; measure it with the others in S1.
   - It drops and recreates `identity.list_my_staff_access_requests(text)`, because its result type changes.
8. **0075** creates `ocr.worker_queue_metrics()` (no table lock) and the policy `ocr_outbox_staff_insert`. `CREATE POLICY` takes an `ACCESS EXCLUSIVE` lock on `ocr.outbox_events` for the catalog change only. It waits for in-flight OCR transactions on that table within the 5 s lock timeout. The bootstrap likewise recreates `ocr_jobs_queue_metrics_read` on `ocr.jobs` under a brief `ACCESS EXCLUSIVE` lock, as it already does for the outbox delivery policies.
9. **0076** replaces the trigger functions `ocr.validate_patient_confirmation()` and `ocr.validate_validation_insert()` (`CREATE OR REPLACE`) and creates `auth.lock_account_for_mfa(uuid)`. It takes no table lock and needs no window; an OCR confirmation or validation in flight keeps the definition it started with.
10. **0077** replaces 18 functions (`CREATE OR REPLACE`): two OCR worker commands, the OCR job, job-event and publication triggers, and the Lab, Pharmacy and Outreach guards. It takes no table lock and needs no window. Run P9 first.
11. **0078** (branch `fix/patient-pin-actor-lockout`) replaces `identity.access_patient_with_pin(text, text, integer)` (`CREATE OR REPLACE`). It takes no table lock, needs no window, no bootstrap and no service change. A PIN check in flight keeps the definition it started with. From then on a correct PIN no longer clears the actor's failure window, so a clinician who mistypes PINs for several patients within 15 minutes can reach the 15-minute actor lock (`DATABASE.md`, "Patient access PIN actor window (0078)"). Open D-Eminence/hid-system#34 also adds a migration numbered 0078; whichever merges second renumbers its file to 0079 and re-registers it.
12. If any estimate approaches 120 s, stop and re-plan before the release. 0072 cannot be edited or worked around in place: an index built beforehand under the same name makes 0072 fail. Do not raise the timeouts ad hoc.
13. **Immediately after the migrations, run `npm run db:bootstrap`, then `npm run db:verify-roles`.**
   - 0072 drops and recreates `audit.list_platform_events` with eleven arguments. Until the bootstrap grants `EXECUTE` on the new signature, any running Identity is refused on the platform audit list.
   - The bootstrap grants `EXECUTE` on `identity.list_my_staff_access_requests(text)` to the Identity runtime (D-Eminence/hid-system#26). Before that grant existed, the clinician list was refused (`403`) everywhere. 0074 recreates the function, so after 0074 the list is refused for every Identity build until the bootstrap runs.
   - The bootstrap grants `EXECUTE` on `auth.lock_account_sessions(uuid)` (0073) to the Identity runtime. A Stage 5B Identity running before this, or before 0073, fails with a database error (`5xx`) on every sign-out, every refresh of an expired session, an administrator's own-session revocation and refresh-token reuse; a reused family is then not revoked. Earlier Identity builds do not call it.
   - Between this step and step 6, and during a rolling Identity deploy, an earlier Identity runs against 0073. Its sign-out, expired refresh, refresh-reuse revocation and own-session revocation lock session rows before the account row, so each can deadlock with an administrator's revocation of the same account at the same moment. PostgreSQL cancels one of the two, which fails with an error and can be retried (§9). Keep that interval short.
   - The bootstrap creates `hid_ocr_queue_metrics`, makes it the owner of `ocr.worker_queue_metrics()`, creates its policy and grants the OCR worker `EXECUTE` (0075). Until then a Stage 6 worker logs `ocr.queue.metrics_unavailable`, as every worker does today.
   - The bootstrap grants `EXECUTE` on `auth.lock_account_for_mfa(uuid)` (0076) to the Identity runtime. A Stage 7 Identity running before this, or before 0076, fails every platform MFA transaction with a database error (`5xx`). Earlier Identity builds do not call it.
   - The bootstrap grants `EXECUTE` on `auth.account_id_for_subject(text)` to the Outreach runtime (Stage 8). Until then every Outreach write fails with `42501`, as it always has.
   - The bootstrap also runs the runtime-role assertions.

## 6. Deployment order

1. Pass the pre-release checks P1–P9, and resolve or accept the blockers in §4.2 for each component being released.
2. Deploy the **admin console** (Health-id `main`). If the running Identity is Stage 2A or later, it keeps working with it (§3). If it is older, admin sign-in fails until step 6 whichever console runs; deploy the console with Identity instead.
3. Take the backup (P2).
4. Apply the **migrations** (§5).
5. Run the **role bootstrap** and verify it (§5).
6. Deploy **Identity**, with `MFA_SECRET_KEY_B64`, `MFA_KEY_VERSION` and `CORS_ORIGINS`. This needs the infrastructure change in P3. A Stage 5B or later Identity must not start before steps 4 and 5 (0073 and its grant), a Stage 7 Identity not before 0076 and its grant, and an Identity with the governed-access outcome mapping must not start before 0074 and the bootstrap.
7. Deploy the **Pharmacy API**. This is independent of the other steps.
8. Deploy the **OCR API** and the **OCR worker** (Stage 6). The API is independent of the other steps. The worker reports queue metrics once steps 4 and 5 (0075 and its grant) are done.
9. Deploy the **EHR API**, with the clinical list paging fix and D-Eminence/hid-system#38, and the **Lab API** with #38, alongside the Pharmacy and OCR APIs of steps 7 and 8. Both are independent of the other steps and need no migration or bootstrap (§3). With #38 they report the method of the request they serve; a service's same-origin cookie reads work once it and Identity both run #38, and OCR's once EHR does too (§3).
10. Run the smoke checks:
    - a Super Admin signs in with TOTP;
    - a high-risk action asks for step-up;
    - `GET /admin/audit/events?resourceType=facility` answers `200`;
    - `GET /admin/approvals` returns `{ items, nextCursor }`;
    - a clinician's `GET /identity/access-requests` answers `200`, and each item has `effectiveStatus`;
    - with #38: a clinician's same-origin cookie `GET /ehr/patients/:id/encounters`, for a patient whose grant is active, answers `200` and not `403 ORIGIN_DENIED`; a cookie write with an allowed `Origin` and no `X-CSRF-Token` is still refused `403 CSRF_VALIDATION_FAILED`;
    - with the EHR paging fix, as a clinician with active access to a patient who has at least two encounters in the facility, sending `X-Facility-ID` and `X-Purpose-Of-Use: direct-care`: `GET /ehr/patients/:id/encounters?limit=1` returns a `nextCursor`, and the same request with that `cursor` returns the next encounter. The same cursor sent with another patient's ID answers `400 INVALID_CURSOR`; EHR checks the cursor before it asks Identity to authorize the read, so this needs no access to that patient;
    - CloudWatch shows no `MFA_UNAVAILABLE`;
    - once the OCR worker has claimed a job, its `ocr.job.claimed` logs carry `queueDepth` and `oldestQueueAgeSeconds`, and no `ocr.queue.metrics_unavailable` follows a claim. A worker logs neither while it claims nothing;
    - if the Outreach API is deployed: a registration without a campaign (`POST /outreach/registration-cases`) answers `2xx` and PostgreSQL logs no `permission denied for function account_id_for_subject`. A campaign-linked registration still fails until the §4.2 Outreach fix.

## 7. Staging acceptance

These must all pass before production; record evidence for each. None of them
has been run, because no staging environment exists yet (Health-id
`docs/OPEN-QUESTIONS.md`).

| # | Test | Evidence |
| --- | --- | --- |
| S1 | Migration rehearsal on a restored staging snapshot. Restore it into an isolated database, then, as the migration administrator, run `db:plan`, `db:dry-run`, `db:migrate`, `db:bootstrap` and `db:verify-roles`. Run the SQL suites and the restore check of `docs/TUF-STAGING-MIGRATION.md`, timing 0067, 0069, 0072, 0074 and 0075. `scripts/tuf-staging-migration-rehearsal.mjs` is local and synthetic only: it builds its own cluster and cannot use a snapshot. | Command output, timings and restore result. |
| S2 | `db:verify-roles` on staging. | Command output. |
| S3 | The Identity runtime verifiers against staging Identity, especially `verify-platform-security-runtime.mjs`, `verify-platform-admin-runtime.mjs` and `verify-patient-safety-runtime.mjs`. | Verifier JSON. |
| S4 | The browser checks of §8, by hand with real authenticators, on the staging console and API. Check 3 needs a confirmation older than five minutes: wait it out, or use a second session. | Screenshots and notes for each check. |
| S4a | The governed-access loop in the staging provider and patient portals: a clinician requests access, the patient approves, the clinician sees **Access active** with its expiry, writes a clinical record, closes access (**Closed by you**, writes disabled), then requests again and the patient revokes (**Access revoked**). No browser run of these pages has been done; only component tests and the HTTP verifier (§8). | Screenshots and notes. |
| S4b | The OCR pipeline on staging: create a job, let the worker extract it, validate, confirm the patient and publish. Validation and confirmation fail until the §4.2 OCR defect is fixed. With a provider slower than a third of the lease, the worker must log no `ocr.job.lease_renewal_failed` (0077). A confirmation of the correct patient that fails with `500`, while PostgreSQL logs `Patient confirmation does not match the canonical OCR source patient`, means the schema owner cannot read the source document (P8, 0076). Confirm the outbox events, the patient-linked audit rows for `ocr.job.find`, `ocr.validation.list` and `ocr.publication.list`, the worker's `queueDepth` and `oldestQueueAgeSeconds`, and `OcrQueueAgeAlarm` datapoints. No OCR HTTP or worker run against a database has been done; the evidence is the unit, SQL and compiled-worker checks in §8. | Logs, audit rows and alarm history. |
| S4c | If the Outreach API is deployed: after the bootstrap, a registration without a campaign, a link to an existing patient and a campaign create succeed (0077 grant). A campaign-linked registration fails until the §4.2 Outreach fix. | Responses and logs. |
| S4d | Delegated cookie reads (#38), from the staging Health-id apps signed in with cookie sessions: patient-scoped reads through EHR, Lab, OCR and Pharmacy answer `200`, not `403 ORIGIN_DENIED`. A cookie write without CSRF is still refused. `verify-delegated-cookie-read-runtime.mjs` cannot be pointed at staging: it accepts only the rehearsal's own synthetic database. Only the EHR path has been exercised over HTTP, locally (§8). | Responses and notes. |
| S4e | If D-Eminence/hid-system#39 is released: in the staging patient and provider portals, sign out after the access cookie has expired (15 minutes idle by default). Keep the tab visible, make no other request, and in the provider portal sign out with the workspace's **Sign out** button, not from the lock screen. Any other request after the idle period, the provider portal's check when a tab hidden for a minute or more returns, and a sign-out from the lock screen each refresh the sign-in first; the sign-out then goes through the live access cookie and is not marked `presented: refresh_token`. Sign-out answers `204` and clears the three cookies, the old refresh cookie then refreshes `401`, and one `logout` session event marked `presented: refresh_token` is recorded. Then, with a scripted request carrying a portal's cookies (no portal sends the header yet), refresh and sign out naming the other portal in `X-HID-Client`: `403 SESSION_CLIENT_MISMATCH`, no cookie set, and the sign-in still refreshes. No staging run has been done; the evidence is local (§8). | Responses and session events. |
| S4f | The EHR clinical list paging fix on staging (§2), with the headers of the §6 smoke check. Before the deploy, open the second page of a patient's encounters in Health-id's clinical record (Health-id reads 50 to a page, so the patient needs more than 50 encounters in the facility). After the deploy, press **Refresh encounters**: the first page must load with the restart notice (`RESTARTED`, `apps/patient-web/src/staff/routes/Clinical.tsx` on Health-id `main`). Then create encounters for one patient through the API whose `startedAt` values share a millisecond (for example `.123456`, and `.123400` twice), page `GET /ehr/patients/:id/encounters?limit=1` to the end, and check that each encounter is listed once. The before-and-after part needs an earlier EHR and Identity that already serve Health-id's same-origin cookie reads (D-Eminence/hid-system#38, S4d): without #38 the clinical record's first read is refused `403 ORIGIN_DENIED`, so no second page can be held across the deploy, and only the shared-millisecond check applies. No HTTP or browser run of EHR paging has been done; the evidence is the unit specs and the SQL suite in §8. | Responses, screenshots and notes. |
| S5 | Cross-origin preflights, only if staging serves the console from another origin. | `OPTIONS` responses. |
| S6 | Rollback drill: redeploy the previous Identity build against the migrated staging database and sign in. | Notes. |

## 8. Evidence gathered locally (Stage 5)

All of this was run on 2026-10-09 against local synthetic data. It was run as
the non-root `postgres` user, on a new local cluster
(`/tmp/hid-tuf-migration.stage5`, migrated 0001 → 0072 and role-bootstrapped).
No other local cluster was touched. Later stages say which cluster they used.

- **Unit tests:**
  - Identity 702/702. The new and updated tests (`refresh-revocation-reason.spec.ts`, `platform-session-end.spec.ts`, `config/cors.spec.ts`, `admin-contracts.spec.ts`) fail 36 of 103 against the `deb6fba` token service and CORS options. The 8 tests of a session ending during a refresh also fail on the first Stage 5 commit (`04b4903`), whose conflict path still recorded reuse.
  - Pharmacy 22/22. The new `config/cors.spec.ts` fails against the old header list.
- **Runtime verifier:** `verify-platform-security-runtime.mjs` passes. Its new checks fail on `deb6fba`:
  - "a signed-out refresh token is not reuse": 2 `reuse_detected` events instead of 0;
  - "CORS does not allow DELETE".
- **Browser:** `services/identity-api/scripts/admin-console-e2e` serves this Identity API on a disposable database copy. Chromium (Playwright 1.56.1, headless) drives the built Health-id console through its `vite preview` same-origin proxy. Twelve checks:
  1. platform sign-in, with first-time authenticator enrolment, sign-out, then password and TOTP;
  2. `STEP_UP_REQUIRED` on facility suspension, then the change listed under the facility's platform changes;
  3. `STEP_UP_EXPIRED`, with the "more than 5 minutes" note, on facility restoration; both changes stay listed after a reload;
  4. approvals cursor paging: 55 rows over 2 pages, newest first, no duplicates;
  5. demo-request cursor paging for one filter, restarting when the filter changes;
  6. an MFA reset is offered only where `mfaEnrolled` is true;
  7. revoked-session notice in session, after another Super Admin revokes all sessions;
  8. revoked-session notice after a reload;
  9. expired-session notice in session;
  10. expired-session notice after a reload;
  11. no `reuse_detected` recorded for those ended sessions;
  12. no browser errors.

  Results:
  - **Stage 5 backend and console:** 12/12, on four separate fresh-database runs. The last run used the final code with the stricter check 12, which fails on any response other than the expected `401` and `403`.
  - **Health-id `main` (`a180cea`) console:** check 7 fails, because the revoke-all confirmation disappears (§2).
  - **Refresh logic of `deb6fba`:** check 11 fails with 2 `reuse_detected` events.
- **Stage 5B (0073), same cluster, migrated 0001 → 0073:**
  - `verify-platform-security-runtime.mjs` races each revocation against a second connection. That connection holds a refresh rotation open, as `TokenService.refresh` makes it: the new session inserted and the old one marked rotated, not yet committed. The connection commits only once the revocation is waiting on it. The four revocations are a compromised-family revoke, revoke-all, an own-session revoke and a refresh-token reuse.
  - The verifier also holds an administrator's revocation open while a sign-out, and then an expired refresh, run against the same account. It also holds a refresh open while the same sign-in signs out.
  - Results by build (each case recorded separately):

    | Schema | Identity | Session from the rotation in flight | Sign-out / expiry during a revocation | Sign-out during a refresh of the same sign-in |
    | --- | --- | --- | --- | --- |
    | 0072 | Stage 5 (`6ec5037`) | live after all four revocations | not applicable | not run |
    | 0073 | Stage 5 | revoked by the two admin commands; live after the own-session and reuse revocations | deadlock; the request fails (`503` and `500`) | new session live |
    | 0073 | Stage 5B | revoked by all four | `204` and `401`; the revocation completes | new session revoked (`logout`) |

  - `session-revocation-lock.spec.ts`: 9/9 pass. Each fails against the Stage 5 token and platform-security services.
  - `session-revocation-serialization.integration.sql` checks the catalog contract: the helper is security definer, `PUBLIC` cannot execute it, and both admin commands lock the target and actor rows, in account order, before their `UPDATE`. `runtime-roles.integration.sql` checks the helper's grant.
- **Governed access (D-Eminence/hid-system#26 and D-Eminence/hid-system#28):**
  - Rehearsal: `scripts/tuf-staging-migration-rehearsal.mjs` was run as `postgres` on `4a1ec18`, which has the same tree as `main` after D-Eminence/hid-system#28. It covered:
    - 0028 → 0074, with the dry run unchanged;
    - 438 foreign keys and 0 orphans;
    - 24 SQL suites, also under the non-superuser definer owner;
    - every runtime HTTP verifier;
    - backup and restore integrity.
  - `verify-patient-safety-runtime.mjs` runs over HTTP with the exact runtime role. The clinician's list:
    - reports the active grant and its expiry after the patient approves, and `?status=active` finds it;
    - reports `revoked` after the patient revokes, `?status=revoked` finds it, and `?status=active` no longer does.

    With the earlier Identity mapping it fails at the first of these checks. Without the D-Eminence/hid-system#26 grant, the list answers `403`.
  - `staff-access-request-outcome.integration.sql` covers:
    - every outcome, including grants that the patient or the clinician revoked only after they lapsed;
    - each filter value;
    - isolation from a colleague's requests;
    - a member without `identity.consent.write`.

    It fails against the first version of 0074.
  - `runtime-function-grants.spec.ts` names the ungranted function on the code before D-Eminence/hid-system#26.
  - Workspace gates passed (Identity 713/713).
  - Health-id: 399/399 tests and both builds passed. `GovernedAccess.test.tsx` has 12 tests, 4 of which fail on the first version of D-Eminence/Health-id#19.
  - **No browser run** of the provider or patient portal pages (S4a).
- **Stage 6 (0075):** on the local cluster `/tmp/hid-tuf-migration.stage6`, migrated 0001 → 0075 and role-bootstrapped (twice, to check the bootstrap is repeatable), and in the synthetic rehearsal of the branch. The rehearsal ran 0028 → 0075 with 25 additional suites, also under the non-superuser definer owner, plus every runtime verifier and the restore check.
  - `ocr-read-audit.spec.ts` has 21 tests:
    - for each of the three reads: the event, its patient (the source document's, while the job's own `patient_id` is null), its details, one transaction shared with the read, ordering after authorization, failing closed when the audit write fails, and no event when unauthorized or when no job exists;
    - every other OCR API job event names the canonical patient: read, extractions, retry, create, reuse, validation, confirmation, publication request, success and failure;
    - a second confirmation of the same job version gets `409`.

    16 of the 21 fail against the `main` OCR service; the other 5 check refusals that `main` already gets right. A mutant that writes the read event in a second transaction fails the transaction check.
  - `ocr-queue-metrics-and-outbox.integration.sql` checks:
    - the worker's aggregate equals a superuser count across two facilities, from a session naming a different facility;
    - the worker cannot read `ocr.jobs`;
    - six other roles cannot execute the command, and no other non-superuser role that does not inherit the worker holds `EXECUTE`;
    - the owner can read no column but `status` and `queued_at`;
    - visibility comes only from the exact policy;
    - `hid_ocr_api_runtime` appends outbox events for its facility, and another facility is refused.

    It passes on the branch and fails on `main` (`function ocr.worker_queue_metrics() does not exist`). Ten mutants each fail `runtime-roles.integration.sql`, and eight of them also fail the suite:
    - no outbox insert policy;
    - no metrics policy;
    - a superuser function owner;
    - worker `SELECT` on `ocr.jobs`;
    - OCR runtime `EXECUTE`;
    - full-table `SELECT` for the owner;
    - owner `SELECT` on `document_id`;
    - migration administrator `EXECUTE`;
    - owner `UPDATE (status)`, caught by `runtime-roles` only;
    - the owner made a member of `hid_ocr_runtime`, caught by `runtime-roles` only.
  - Worker: `repository.spec.ts` and `database-privileges.spec.ts` check that the worker reads only through commands that `hid_ocr_worker` can execute. 3 of 4 fail on `main`.
  - The compiled worker repository was run as a login that inherits `hid_ocr_worker`. It returned `{"queueDepth":2,"oldestQueueAgeSeconds":7211}` for two facilities. `main`'s query as the same login failed with `42501 permission denied for table jobs`.
  - On a copy whose functions and tables are all owned by a `NOSUPERUSER NOBYPASSRLS` role (P8), the new suite passes. `schema.integration.sql` fails at each function listed in P8, one by one, and passes once those functions are returned to a superuser owner.
- **Stage 7 (0076):** on the new local cluster `/tmp/hid-tuf-migration.stage7`, run as `postgres`. One database was migrated 0001 → 0076 from the branch, and one 0001 → 0075 from `main` (`dafe147`). Each had a copy with every schema, table and function owned by a `NOSUPERUSER NOBYPASSRLS` role, as in the rehearsal's owner check.
  - **Rehearsal and acceptance:** `scripts/tuf-staging-migration-rehearsal.mjs` ran as `postgres` on `91f3798`, the last code change of the branch (later commits change docs only), with a clean worktree. It covered:
    - 0028 → 0076, with the dry run unchanged;
    - 438 foreign keys and 0 orphans;
    - 27 additional suites, also under the non-superuser definer owner;
    - every runtime HTTP verifier, including the MFA races below;
    - backup and restore integrity.

    `scripts/run-container-database-acceptance.sh` passed for 0001–0076, including both new suites.
  - **Workspace gates passed:** build, tests, verify, release tests, release contracts, the EHR app tests and `git diff --check`. Identity has 724 tests, the OCR API 51 and the OCR worker 17.
  - **MFA lock order:**
    - `mfa-lock-order.spec.ts` has 11 tests: one per MFA transaction (the account lock comes first, in the same transaction, and is never the `FOR UPDATE` revocation lock), the challenge locked only after the account and for that account, a challenge refused by its re-read after the account lock, and platform session issue without a second pool connection. All 11 fail against the `main` services (`dafe147`) and against the first version (`f3300e0`), which used `auth.lock_account_sessions`; 10 fail against `399d4c5`, which also used it but already resolved the administrator on the transaction. With the account lock removed from the challenge path only, 7 fail, including the refusal test. The lock mode itself is a database property, checked by the suite and the races below.
    - `verify-platform-security-runtime.mjs` races an approved MFA reset against six MFA requests of its target: TOTP and recovery-code sign-in, step-up, recovery-code regeneration, enrolment activation, and enrolment started again over a pending factor. A second connection runs the real `auth.admin_decide_approval`, holding the target's account row as 0070 does until the request waits. While the request waits, it checks with `NOWAIT` which authenticator rows the request holds.
    - On `main`, every request held its factor while it waited. Sign-in and enrolment requests also held their challenge, step-up held its session assurance, and recovery-code sign-in and regeneration held their recovery codes. PostgreSQL detected six deadlocks (`pg_stat_database.deadlocks` +6, six `deadlock detected` reports in the server log), cancelled each MFA request (`500`) and committed the approval.
    - On the branch, each request waits holding no authenticator row, and the approval commits. The request is then refused (`401 MFA_CHALLENGE_INVALID` for sign-in and enrolment, `403 PLATFORM_SESSION_REQUIRED` for step-up and regeneration). It records no deadlock, leaves no live session, and never spends the recovery code.
    - The verifier also runs a step-up and a regeneration while a refresh of the same sign-in is in flight, and the platform password step while a staff sign-in of the same administrator holds the principal's login-attempt row.
      - On the branch, neither MFA request waits for the refresh and both answer `200`. The password step waits for the staff sign-in, which commits, and then answers `200`.
      - Against the first version (`FOR UPDATE`): both MFA requests waited, then answered `403 PLATFORM_SESSION_REQUIRED`. The password step deadlocked with the staff sign-in and answered `500`, while the staff sign-in committed. The server log shows the `deadlock detected` report between `delete from auth.login_attempts` and the staff `insert into auth.session_events`.
    - The verifier then checks that MFA transactions of one account run one at a time. A second connection holds the account lock until every request waits on it.
      - Six parallel step-ups with a wrong code: on the branch all six wait, then five answer `401 MFA_INVALID_CODE` and the sixth `429 MFA_RATE_LIMITED` (five `step_up_failed` events, one `mfa_rate_limited`). Against the second version (`FOR KEY SHARE`), all six codes were tested and refused as invalid: six failures, no rate limit.
      - Two parallel password steps, while the second connection also holds the principal's login-attempt row as a staff sign-in in flight does: on the branch both wait, the second supersedes the first's challenge, and one challenge stays open. Against `FOR KEY SHARE`, both waited only on the login-attempt row, ran together once it was released, and left two challenges open.
      - No deadlock is recorded.
    - `mfa-account-lock.integration.sql` checks the exact function body. It fails on the `FOR KEY SHARE` version and on bodies taking `FOR KEY SHARE`, `FOR UPDATE`, `FOR NO KEY UPDATE SKIP LOCKED`, `FOR NO KEY UPDATE NOWAIT`, the lock inside `IF false` only, or no lock clause. `runtime-roles.integration.sql` fails when `EXECUTE` is also granted to `hid_api_runtime`, `hid_notification_worker`, `hid_ocr_queue_metrics` or `PUBLIC`; the earlier check, over a fixed list of roles, missed the first three.
  - **OCR guards:** `ocr-validation-guards.integration.sql` runs 23 cases.
    - On 0075 it fails with 10 wrong outcomes:
      - two confirmations whose source document is missing;
      - confirmations with no session account or membership, or with another member's account or membership;
      - validations whose extraction is missing, with no session account (empty or unknown subject) or no membership.
    - Under the non-superuser owner, 0075 also accepts the wrong patient and the right patient (12), because the guard cannot read the source document.
    - On 0076 it passes in both. `schema.integration.sql`, the 27 additional suites (including `mfa-account-lock.integration.sql`) and the role assertions pass on 0076; the additional suites also pass under the non-superuser owner.
    - Mutation check: each of the 12 comparison predicates of the two guards, removed in turn, makes the suite fail at the case named for it. That covers facility, source patient, job patient, version, account, membership, status and extraction. Removing an explicit `IS NULL` refusal alone changes no outcome: the `IS DISTINCT FROM` comparison that follows refuses a NULL session value against the supplied one, and a NULL supplied value is refused by the column's `NOT NULL` constraint.
    - The functions keep their owner, ACL, `SECURITY DEFINER` and `search_path`.
  - **P8 proposal probes**, on throwaway databases and roles that were dropped afterwards (PostgreSQL 16.15), for §4.1 and ADR-041. They confirmed:
    - the `plpgsql.variable_conflict` behaviour under a non-superuser owner;
    - the in-body option;
    - the non-superuser bootstrap limits on `ALTER ROLE`, ownership transfer and later `CREATE OR REPLACE`.

    A rolled-back probe confirmed that `ocr.validate_job_write` (on 0076) accepts a job whose document has no scan event (§9).
- **Stage 8 (0077):** on the local cluster `/tmp/hid-tuf-migration.stage7b`, run as `postgres`, with throwaway copies of one database migrated 0001 → 0076 from `main` (`158f68c`) and one 0001 → 0077 from the branch, and owner-check copies whose schemas, tables and functions belong to a `NOSUPERUSER NOBYPASSRLS` role, as in the rehearsal.
  - **Rehearsal and acceptance:** `scripts/tuf-staging-migration-rehearsal.mjs` ran as `postgres` on `f8bfbd7` with a clean worktree: 0028 → 0077 with the dry run unchanged, 438 foreign keys and 0 orphans, 32 additional suites (including the five new ones) under the migration owner and again under the non-superuser owner, every runtime HTTP verifier, and backup and restore integrity. `/etc/gitconfig` was restored byte for byte afterwards. `scripts/run-container-database-acceptance.sh` passed for 0001–0077 as `postgres`, including the five new suites.
  - **Workspace gates passed** on `84520c0` (later commits change docs only): build, tests (Identity 724, Outreach API 23), verify, release tests, release contracts, the EHR app tests and `git diff --check`. Every SQL suite (33) and the role assertions pass on 0077.
  - **Failing first:** on 0076 the five new suites fail with 17 (OCR worker lease, 41 cases), 12 (OCR job source and publication, 30), 60 (Lab, 86), 58 (Pharmacy, 84) and 67 (Outreach, 121) wrong outcomes; on 0077 they pass, twice on one copy, and under the non-superuser owner. Restoring any replaced Lab, Pharmacy or Outreach function to its earlier body, or dropping a suite's runtime role switch, makes its suite fail; 11 of 12 single-point mutants of the OCR functions are caught (the survivor is equivalent). `runtime-roles.integration.sql` and the Outreach API's `runtime-function-grants.spec.ts` fail on `main`'s grants.
  - **Reproduced on 0076:** a NULL claim token completed and failed another replica's job; every lease renewal was refused; a superuser session with no context wrote Lab, Pharmacy and Outreach rows attributed to another member; under the non-superuser owner a Lab import bound another facility's OCR validation and publication; a document marked entered in error during OCR made `ocr.claim_worker_job` raise for its provider; every Outreach write failed with `42501` as the Outreach runtime. The §4.2 locking statements failed as each service's runtime role, and the three §9 lock-order hazards (and the facility-suspension one) deadlocked with two connections.
  - **Read-only data check:** no local database holds an OCR job without an exact clean scan of its source; the P9 query lists such jobs on synthetic data.
  - **Adversarial review:** five independent reviewers (semantics, security, tests, docs, registration) and one verifier per finding. Every confirmed finding is fixed here or recorded above: the unbounded lease renewal, the out-of-play exemption, the same-status job event, the untested renewal and metadata rules, P9's cancel instructions and the counts.
- **Delegated cookie reads (D-Eminence/hid-system#38)**, as recorded in that PR (the PR and its commit are dated 2026-10-11); local and synthetic only. The with-fix rehearsal used its own temporary Unix-socket cluster, which it creates and removes on each run (`docs/TUF-STAGING-MIGRATION.md`); the failing-first run used a disposable clone of the repository, per the PR, which does not name the cluster of its verifier run:
  - **HTTP verifier:** `services/ehr-api/scripts/verify-delegated-cookie-read-runtime.mjs`, run by `scripts/tuf-staging-migration-rehearsal.mjs` as `checks.delegated_cookie_read_runtime`. It runs only inside the rehearsal (`NODE_ENV=test`, `PGHOST` a `/tmp/hid-tuf-migration.*` socket, `PGDATABASE=hid_rehearsal`) and works on a disposable copy of that database, which it drops. It runs Identity in a child process as `hid_identity_api_runtime` and EHR as `hid_ehr_api_runtime`, and generates the EHR local workload secret per run. It checks that:
    - after the patient approves the doctor's request, the doctor's same-origin cookie `GET /ehr/patients/:id/encounters`, with no Origin and no CSRF, is authorized through Identity and returns the encounter; the same read with an allowed Origin also passes;
    - EHR cookie writes are refused `403 CSRF_VALIDATION_FAILED` without CSRF and `403 ORIGIN_DENIED` without Origin;
    - called directly, Identity's check answers `201` with `allowed: true` for the EHR workload reporting `GET`, and `403` for a wrong or missing workload token (`ORIGIN_DENIED`), a reported `POST` with Origin and no CSRF (`CSRF_VALIDATION_FAILED`) and no reported method (`ORIGIN_DENIED`);
    - the patient's own `GET /ehr/me/records` still reads through the self-authorization path.
  - **Unit:** Identity `delegated-browser-request.spec.ts` (14 tests, against the real handlers' decorator metadata; a reported `GET`, `HEAD` or `OPTIONS` is accepted, and only `service/authorization/check` in Identity's source carries `@DelegatedBrowserRequest()`) and `delegated-browser-method.spec.ts` in EHR, Lab, OCR and Pharmacy (2 each).
  - **Failing first:** with the tests only, on `c28d04c` (request path identical to `main`), the Identity spec did not compile, each client spec failed 2/2 and the verifier got `403 ORIGIN_DENIED`.
  - **With the fix,** on `cff3b16` (#38 merged with `main` `7674b9a`, which carries #37): the eight commands of `release/scripts/run-workspace-gates.mjs` (build, test, verify, release tests, release contracts, EHR app tests, migration rehearsal, `git diff --check`), run directly as a non-root user because that script runs only in GitHub Actions, all passed, with Identity 738, EHR 59, Lab 46, Pharmacy 24 and OCR 53 tests. The rehearsal evidence (`status: passed`, `source_sha` `cff3b16`, sha256 `b88d7699699f8ea0a5506f8e4c7a366a8169993c49a93533528afb99c659d8bc`) records `delegated_cookie_read_runtime` passed. (The PR's earlier figures, 738/59/77/55/33, came from `c28d04c` with the PR's code applied, the tree of the failing-first run.)
  - Lab, OCR and Pharmacy have unit coverage only; no HTTP run covers their delegated reads.
- **Sign-out and client kind (D-Eminence/hid-system#39), local and synthetic only:**
  - **Unit tests:** `session-sign-out.spec.ts` (both sign-out paths and both refresh directions; CSRF before the kind on both sign-out paths and on refresh; the bearer path; a staff actor without a kind; a non-renewable sign-in of the other kind ended and audited as its own kind; a sign-out that ended nothing is not audited), `refresh-sign-out-sql.spec.ts` (the account lock, then the read, the end and the event; a WHERE with no account, expiry or grace condition; the `renewable` flag and the refusal before anything ends; nothing recorded when a concurrent sign-out got there first; the kind lookup's 60-second bound), `session-revocation-lock.spec.ts` (a sign-out ends only the family's unrevoked sessions) and the two `config/cors.spec.ts` preflights. Identity passed 62 suites, 765 tests, and `tsc --noEmit`, on `1cfbb2b`.
  - **Failing first:** the `908939d` commit records its cases as failing on `38576cb`. Three `refresh-sign-out-sql.spec.ts` cases fail against `908939d`'s `token.service.ts`, and seven cases of that spec and `session-revocation-lock.spec.ts`, plus the not-audited case of `session-sign-out.spec.ts`, fail against `7fcb8a5`'s. Moving the kind check above the CSRF check on the live-access-cookie path fails the CSRF-before-kind case.
  - **Edge Worker:** `infra/cloudflare/test/frontend-worker.test.mjs` asserts that every deployment host forwards `X-HID-Client`, `X-CSRF-Token` and the cookies on `/api/v1/auth/refresh` and `/api/v1/auth/logout`; the Worker itself is unchanged. The file passed, 52 tests, on `908939d`, run for this record.
  - **HTTP verifier:** `services/identity-api/scripts/verify-session-sign-out-runtime.mjs` runs inside the local rehearsal as `hid_identity_api_runtime` and is recorded as `session_sign_out_runtime`. Its 13 checks cover sign-out by refresh cookie, the access-cookie fallback, a live access cookie deciding, CSRF and Origin refusals, `SESSION_CLIENT_MISMATCH` on refresh and sign-out in both directions, a replayed rotated cookie, the 60-second window and reuse after it on refresh and on sign-out, a temporarily disabled account on refresh and on sign-out, and two sign-outs at once by either path, held at the account lock until both wait there.
    - Run against `908939d`'s `token.service.ts`, it failed at check 11: a rotated token aged past the window, sent with the other app's name, got `403 SESSION_CLIENT_MISMATCH` naming the staff application instead of `204`. With check 11 removed, it failed at check 12: a sign-out during a timed suspension left the sign-in live.
    - Run against `7fcb8a5`'s sign-out code, it failed at check 13: two sign-outs at once by live access cookie recorded two sign-out events.
  - **Gates on `1cfbb2b`:** the eight commands of `release/scripts/run-workspace-gates.mjs` (build, test, verify, release tests, release contracts, EHR app tests, migration rehearsal, `git diff --check`), run directly as a non-root user because that script runs only in GitHub Actions, all passed. The rehearsal evidence (`status: passed`, `source_sha` `1cfbb2b`, sha256 `86d02c058282211facd681da1aec4fb5c37ab063e7ab9a06a6a7b6fb407a433d`) records `session_sign_out_runtime` passed with 13 checks, and `platform_security_runtime`, whose sign-out races depend on the same revocation, passed.
- **EHR clinical list paging** (D-Eminence/hid-system#40, commits `0a9668e` and `0383902` on `main` `54f79d2`), local and synthetic only:
  - **Unit:** `services/ehr-api/src/ehr/shared/clinical-context.spec.ts` covers the microsecond position, rows tied on the sort key split by `id`, round trips (including `0001-01-01`, leap days, `9999-12-31` and five- and six-digit years up to 294276), binding to the list, patient and encounter, refusal of 23 variants (among them the earlier `{ sortAt, id }` format, a millisecond timestamp, 30 February, 29 February 2100, a five-digit year with a leading zero, a year after 294276, hour 24, a leap second, an upper-case id, an extra field, reordered fields and padding), that the items keep the named column types of a pg row, and that no millisecond cursor is ever issued. `timeline-paging.service.spec.ts` checks, for each of the six lists, that the SQL selects the key as text, the cursor carries its microseconds and the next page binds them. On the branch both pass (2 suites, 28 tests). On `main` before this change (`54f79d2`) both fail to compile, because `decodeTimelineCursor` and `timelinePage` there take no list scope.
  - **SQL:** `ehr-timeline-cursor.integration.sql` (rollback-only; `DATABASE.md`) runs with the rehearsal's additional suites and in `scripts/run-container-database-acceptance.sh`.
  - **Gates and rehearsal on `0383902`:** the eight commands of `release/scripts/run-workspace-gates.mjs` (build, test, verify, release tests, release contracts, EHR app tests, migration rehearsal, `git diff --check`), run directly as a non-root user because that script runs only in GitHub Actions, all passed. The rehearsal evidence (`status: passed`, `source_sha` `0383902`, sha256 `1aaf85d66c6a194409ca313b123718f0c2f07ce8708f1410b88f03db3d55e13a`) lists `ehr-timeline-cursor.integration.sql` in `checks.additional_schema_suites`; it ran on the rehearsal database, the non-superuser-owner copy and the restored database, each with exit 0. The container acceptance was not run.
  - Over HTTP against a database, only the delegated cookie-read verifier (#38) reads an EHR list, the first page of a patient's encounters, as `hid_ehr_api_runtime`; no HTTP or browser run follows a cursor (§7 S4f).
- **Not run:** staging or production anything (§7). The browser run uses the backend's own TOTP clock seam to issue codes, not a real authenticator app.

To reproduce, run as the owner of a local cluster migrated to 0073 and role-bootstrapped (Stage 5B Identity calls `auth.lock_account_sessions` on sign-out and expiry; a cluster left at 0072 needs `db:migrate` and `db:bootstrap` again) (`services/ehr-api` `db:migrate` and `db:bootstrap`). The harness defaults to the database `hid_rehearsal`, the superuser `hid_rehearsal_admin` and ports 4010 and 4011. Change them with `HID_E2E_TEMPLATE_DB`, `HID_E2E_DB_SUPERUSER`, `HID_E2E_API_PORT` and `HID_E2E_CONTROL_PORT`; see the script headers. Stop `server.mjs` with Ctrl-C or SIGTERM, which drops its database copy.

1. Build the console from Health-id:

   ```bash
   VITE_HID_ENVIRONMENT=local VITE_HID_API_BASE_URL=http://127.0.0.1:3200 VITE_HID_APP_ORIGIN=http://127.0.0.1:3200 \
     npx vite build --outDir "$OUT"
   ```

2. Serve it, also from Health-id:

   ```bash
   HID_LOCAL_GATEWAY_ORIGIN=http://127.0.0.1:4010 npx vite preview --configLoader runner --outDir "$OUT" --host 127.0.0.1
   ```

3. Start the API from this repository:

   ```bash
   HID_E2E_SOCKET=<socket dir> HID_E2E_WORKDIR=<dir> node services/identity-api/scripts/admin-console-e2e/server.mjs
   ```

4. Run the checks, with the same variables plus `HID_E2E_PLAYWRIGHT=<path to playwright/index.mjs>`:

   ```bash
   node services/identity-api/scripts/admin-console-e2e/flows.mjs
   ```

   The evidence is written to `<dir>/evidence.json`.

## 9. Rollback and recovery

- **Migrations are forward-only.** There are no down migrations. Recovery from a failed migration needs no action, because the transaction rolls back. Recovery from a wrong but successful migration is a restore from P2. Practise it in staging (S6) before relying on it.
- **Identity after 0072:**
  - The previous Stage 4A build runs unchanged, because Stage 5 has no schema change.
  - A pre-4A build also runs. Its nine-argument audit call resolves to the new function through the defaulted arguments; `platform-admin-contracts.integration.sql` checks this.
  - **Do not roll the console back below Stage 4B while Identity is at Stage 4A or later (§3).**
- **Identity after 0073:** Stage 5 and earlier builds run unchanged. The two admin commands keep their contracts, and only Stage 5B calls the new helper. Rolling Identity back to Stage 5 removes the lock from the reuse, own-session, sign-out and expiry paths. The two admin revocations keep it, because it is in the database. With that combination, any of those four paths at the same moment as an administrator's revocation of the same account can deadlock. PostgreSQL then cancels one of the two. Either the sign-out or refresh fails with a `5xx` (reproduced locally, §8), or the administrator's revocation fails and must be retried. Prefer rolling forward.
- **Identity after 0074:** once the bootstrap has run, earlier builds keep working (§3); roll Identity back freely. The new index and the new result columns stay. Rolling back the Health-id portal only hides the outcomes.
- **Identity after Stage 7:** roll back freely; 0076's helper stays and earlier builds do not call it. A Stage 6 or earlier Identity brings back the deadlock between an approved MFA reset and an MFA transaction of the same account (§2): PostgreSQL then cancels one, and either the MFA request fails with a `5xx` or the approval fails and must be retried. It also lets parallel second-factor attempts of one account exceed the failure limit again.
- **0076:** forward-only like every migration. To restore the earlier guard bodies, a new migration would have to recreate them; that would accept a confirmation for any patient again under a non-bypass owner, and validations from sessions without an account or membership. No OCR build depends on the earlier behaviour. The Stage 7 Identity needs `auth.lock_account_for_mfa`.
- **0077:** forward-only. Restoring the earlier bodies would need a new migration and would bring back the NULL claim token, the refused lease renewals, jobs for unscanned documents, publications attributed to any member and the NULL-session gaps of the Lab, Pharmacy and Outreach guards. No service build depends on the earlier behaviour. Revoking the Outreach grant would stop every Outreach write again.
- **0078:** forward-only. Restoring the 0033 body would need a new migration and would bring back the bypass: a correct PIN for one patient would again clear the actor's failures at others. No service build depends on either behaviour.
- **OCR after 0075:** roll the OCR API and worker back freely. Earlier workers lose the metrics again; earlier APIs write the earlier, possibly unlinked, events. The function, the role and both policies stay. Removing the outbox insert policy would stop patient confirmation and publication again.
- **Delegated cookie reads (#38):** code only, no persisted state. Rolling back Identity brings back the `403 ORIGIN_DENIED` refusal for the same-origin cookie reads of all four services (EHR, Lab, OCR and Pharmacy). Rolling back EHR brings it back for EHR's and OCR's cookie reads (OCR reads each job's source document through EHR); rolling back Lab, OCR or Pharmacy brings it back for that service only (§3). Nothing else of #38 changes; an EHR API rolled back past the paging fix also loses that fix (next entry).
- **EHR clinical list paging:** code only, no persisted state. Rolling the EHR API back brings back the rows skipped within a millisecond. Cursors issued by either build are refused by the other with `400 INVALID_CURSOR`, after which Health-id reloads the first page (§3).
- **Refresh-event change:** this is code only. Rolling back Identity brings back the old misclassification and nothing else. Existing `refresh`/`denied` events remain valid rows.
- **Sign-out and client kind (#39):** code only. Rolling Identity back brings back the idle sign-out that answers `401` and leaves the sign-in live, and removes the client-kind check and the `x-hid-client` CORS entry. `logout` events marked `presented: refresh_token` remain valid rows.
- **MFA key:** if `MFA_SECRET_KEY_B64` is lost, every enrolled authenticator must be re-enrolled. Store it with the same care as the field-encryption keys.
- **Lockout:** if every Super Admin is locked out (lost authenticators and recovery codes), recovery needs the documented break-glass procedure. That procedure is not built yet; see the product decisions in `PHASE_4_STAGE_4A_ADMIN_CONTRACTS.md` §9. Keep two independent Super Admins with stored recovery codes.

**Known limits of Stage 6:**
- Queue metrics are emitted with each claim. A worker that claims nothing (stopped, stalled, wrong provider, ineligible documents) emits none, and `treatMissingData` is `NOT_BREACHING`. So `OcrQueueAgeAlarm` cannot detect a stopped worker, and `OcrDrainRateAlarm` cannot breach. Fixing this needs two changes, both out of scope here:
  - an OCR worker change to log a separate, periodic queue-metrics event from `ocr.worker_queue_metrics()` (it cannot reuse `ocr.job.claimed`, whose `claimedJobs` feeds the throughput metric);
  - matching metric filters in `infra/aws`.
- The OCR worker's own database audit events (`ocr.worker.claim`, `ocr.worker.complete`, `ocr.worker.fail`, `ocr.worker.lease_recovered`) still carry `ocr.jobs.patient_id`, so for a job created without a patient they remain unlinked.
- The age is time since the earliest `queued_at`, as before. A job retried by the worker keeps its first `queued_at`, so the age includes earlier attempts and back-off.
- Replays of idempotent OCR writes return the stored result without a new read event; the original write event remains.

**Lock-order hazards:** the MFA reset hazard recorded here until Stage 6 is fixed by Stage 7A (§2). These pre-existing hazards remain; none involves an MFA authenticator. In each, PostgreSQL cancels one command, which fails and can be retried; nothing is half applied:
- two administrators acting on each other's accounts at the same moment. A status change, a platform role change, an approval request or an approval decision locks its target's account row and then references its actor's (the idempotency row, `requested_by`, `decided_by`, `revoked_by`, the audit event). A session revocation joins the cycle when the target's account id sorts before the actor's (§5, step 6);
- a new approval request and a decision on an earlier request for the same target and action, exactly as that earlier request expires;
- an OTP password-recovery resend and the completion of the same recovery: the resend locks the open challenge and then inserts a new one (a `FOR KEY SHARE` on the account), while `auth.complete_recovery_otp` locks the account and then that challenge. It needs the resend cooldown to have passed while the challenge is still open.

Each would be fixed the same way: lock every account involved, in account order, before anything else. Stage 8 reproduced all three locally as real deadlocks (`40P01`, `pg_stat_database.deadlocks` +1 each), running the Identity API's own transactions as a login of the Identity runtime on a 0076 copy:
- two Super Admins disabling, or granting roles to, each other; an approval of an MFA reset of B while B requests one for A; and a revocation of A's sessions by B while A disables B. Sent in the same event-loop tick, two role changes deadlocked in 78 of 200 runs; 0.5–1 ms apart, in 1–2 of 100; 2 ms apart, never. The cancelled side gets `503 ADMIN_COMMAND_UNAVAILABLE`, wrote nothing (no idempotency or audit row) and can be retried with the same key. Which side is cancelled depends on timing: in two runs it was a Super Admin's revocation of a compromised administrator's sessions, which then stayed live until retried;
- a decision landing within milliseconds of its request's expiry while a new request for the same target and action arrives: either side may be cancelled; an expired request never executes;
- an OTP recovery resend between the completion's account lock and its challenge lock: the cancelled side answers `500` instead of `403` or `202`;
- a fourth hazard, not listed before: a Super Admin suspending or rejecting a verified facility (`identity.admin_transition_facility`, 0072, which takes the last-Super-Admin advisory lock and then references its actor's account) while another disables that Super Admin or revokes their Super Admin role (which lock the target account and then take the same advisory lock). Reproduced: the disable was cancelled and left nothing.

A prototype on a copy (the 0073 ordered account lock in `auth.admin_transition_account`, `auth.admin_change_platform_role`, `auth.admin_request_approval` and `auth.admin_decide_approval`, the latter reading the request's target unlocked first, and `auth.lock_account_for_mfa` in `OtpService.start`) removed those deadlocks, 0 of 200 in the same-tick test, and the existing suites passed. An independent check then found that it does not fix the facility hazard and opens a new cycle: two concurrent requests of one administrator, one suspending a facility and one disabling another Super Admin, deadlock with each other (reproduced; they do not on the current code). It is not in Stage 8: each hazard is fail-safe and needs two administrators or a recovering user acting within about a millisecond, while the fix rewrites the two-person approval and last-Super-Admin commands and needs two-connection race tests. A command that waited for its actor to be disabled or signed out also proceeds or fails on the audit trigger (`503`) instead of `403`; re-checking the actor's permission after the lock belongs with that change.

**Known limits of Stage 7B**, all closed by 0077 (§2): the OCR job trigger's scan comparison for inserts, source changes and starts of processing, the NULL claim token of the OCR worker commands, the Lab OCR-import guard's unchecked lookups, the thirteen Lab, Pharmacy and Outreach guards that compared the session with `<>`, and the unbound OCR publication requester. For the twelve guards whose coverage had not been checked, row-level security refuses a NULL session for the runtime roles (reproduced locally); the guards themselves now refuse it too.

**Known limits of Stage 8:**
- Twelve Identity definer functions gate on `platform.current_actor_subject() <> 'system:auth'`, which passes when the session has no subject, and two compare a stored enrollment token HMAC with `<>` against the caller's, which passes for a NULL argument (`identity.activate_public_patient_enrollment`, `auth.bind_google_onboarding_capability`). Only the Identity runtime can execute them, it may set `system:auth` itself, and the Identity API always passes a computed HMAC; defence in depth for a later stage.
- 0077 makes the guards refuse a missing value only where they already compared it. So, under a session that bypasses row-level security: the Pharmacy work-item event guard still does not compare the facility; the Outreach event guard compares neither the facility nor the purpose; the Outreach campaign guard never compares the purpose, and its update branch compares only the facility, so a campaign's status can change with no account in the session. The event's actor must still be its work item's accepter (Pharmacy) or the session's account (Outreach). For the runtime roles, row-level security requires all of them.
- Seven Lab triggers compare only the facility with `platform.current_facility_id()` using `<>` (`validate_specimen_parent`, `validate_specimen_transition`, `validate_accession_child`, `validate_execution_transition`, `validate_result_insert`, `validate_result_head_update`, `validate_execution_child`). Row-level security requires the session facility for the Lab runtime.
- The Lab, Pharmacy, OCR, notification and event runtimes cannot call `platform.current_account_id()` directly (no `USAGE` on schema `auth`). No policy, invoker trigger or service of theirs does; a future one would need the grant and the schema usage.

Each is a follow-up.

**Known limits of the delegated cookie-read fix (#38):**
- Identity cannot check the reported method. Any approved workload caller with valid credentials can have the cookie Origin and CSRF check skipped on the patient authorization check by reporting `GET`, `HEAD` or `OPTIONS`. A real browser write is still checked first: EHR, Lab, OCR and Pharmacy revalidate the session through `POST /auth/service-session` (Outreach checks writes in `outreach-security.guard.ts` and through `POST /identity/outreach/authorize`, neither of which is marked). The reported method is the method of the request the service is serving: for a service hop that forwards the user's cookie, such as OCR's `GET /api/v1/ehr/internal/ocr/documents/:documentId/source` during job creation, EHR reports that hop's `GET`, after OCR has already revalidated the originating browser write.
- Outreach's own guard (`outreach-security.guard.ts`) requires an allowed Origin and an `X-CSRF-Token` on every cookie request, `GET` included, and refuses it otherwise with `403 CSRF_VALIDATION_FAILED`. A same-origin browser `GET` carries no Origin, and neither the Cloudflare frontend worker (`infra/cloudflare/src/frontend-worker.mjs`) nor the gateway (`gateway/proxy-headers.conf`) adds one. Health-id also sends `X-CSRF-Token` only on writes (Health-id `packages/http/src/client.ts`). Same-origin cookie reads from Outreach are therefore likely refused; this is from reading the code and was not reproduced. It is a separate follow-up.
- The HTTP verifier covers EHR only (§8).

## 10. Operator actions, not performed here

These are documented for the operators and were not done in this stage:
- deploying anything;
- running migrations or the role bootstrap against staging or production;
- provisioning `MFA_SECRET_KEY_B64`;
- changing AWS, DNS, Cloudflare, Supabase, IAM or Softbridge;
- creating the staging environment needed for §7;
- the read-only OCR scan evidence check P9 on staging and production.
