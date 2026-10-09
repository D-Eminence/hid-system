# Phase 4 Stage 5: platform administration release readiness

This is the combined release checklist for the platform administration work
of Phase 4, the governed-access slice that followed it, the Stage 6 OCR
audit and queue-metrics slice, and Stage 7 (MFA lock order and fail-closed OCR
validation guards). It covers Identity, the OCR API and worker, and
the database in this repository, and in Health-id the admin console
(`apps/patient-web/src/admin`) and the provider portal's governed-access pages
(`apps/patient-web/src/staff`). It records what was
verified locally and what an operator must still do. **Nothing here has been
deployed, and no staging or production database has been migrated.** Every
"verified" below means a local synthetic environment unless it says otherwise.

## 1. What is being released

| Component | Source | Contents |
| --- | --- | --- |
| Database | `services/ehr-api/database/migrations` through `0076_mfa_account_lock_and_fail_closed_ocr_guards.sql` | Phase 1–4 schema. The platform admin migrations are 0067–0072. Stage 5 adds no migration; Stage 5B adds 0073, governed access adds 0074, Stage 6 adds 0075 and Stage 7 adds 0076 (§2). |
| Runtime grants | `services/ehr-api/database/runtime-grants.sql`, applied by the role bootstrap | Governed access grants the Identity runtime the clinician's access-request list. Stage 6 adds the technical role `hid_ocr_queue_metrics`, its policy, and the OCR worker's grant on the queue metrics command (§2). |
| Identity API | `services/identity-api` on `main` (Stage 2A, 4A, 5, 5B, governed access and 7) | Platform MFA sessions, step-up, two-person approval and the Stage 4A admin contracts. Stage 5 adds the two fixes in §2; Stage 5B adds the revocation lock; governed access adds the access-request outcome fields; Stage 7 locks the account first in every MFA transaction (§2). |
| Pharmacy API | `services/pharmacy-api` | Stage 5 CORS header fix (§2). |
| OCR API | `services/ocr-api` (Stage 6) | Patient-linked audit events for OCR evidence reads (§2). |
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
- **MFA lock order (Stage 7A, migration 0076)**: approving a platform MFA reset (`auth.admin_decide_approval`, 0070) locks the target's account row `FOR UPDATE`, then revokes its factors, recovery codes and sessions. Every MFA transaction of that account first locked its challenge and factor, or its session assurance and factor, or wrote a recovery code. It reached the account row only through the `FOR KEY SHARE` that its session event, session, recovery code or factor insert takes. The two could deadlock, and PostgreSQL then cancelled one. Reproduced locally for TOTP and recovery-code sign-in, step-up, recovery-code regeneration, enrolment activation and enrolment restart: each MFA request failed with `500` (§8). Every MFA transaction now calls the new `auth.lock_account_for_mfa(uuid)` (0076, granted to the Identity runtime only) before any other lock or write. That covers the password step, both sign-in methods, enrolment start and activation, step-up and regeneration. The order is then: the account; the challenge (sign-in and enrolment) or the session assurance (step-up); the factor and the recovery codes; then sessions and events. A challenge is found without a lock only to learn its account, then read again, locked, for that account. A request that waited for a reset is refused cleanly: `401 MFA_CHALLENGE_INVALID` for a sign-in or enrolment, `403 PLATFORM_SESSION_REQUIRED` for a step-up or regeneration. The helper takes `FOR KEY SHARE`, the weakest lock that conflicts with the reset's and every revocation's `FOR UPDATE`. A first version reused the revocation helper `auth.lock_account_sessions` (0073, `FOR UPDATE`), which the adversarial review showed made MFA transactions also wait for refresh rotations and staff sign-ins of the account. Reproduced locally:
  - a step-up or regeneration that raced a refresh of its own sign-in waited, then found its session rotated and was refused `403 PLATFORM_SESSION_REQUIRED`, which ends the console session;
  - the password step deadlocked with a staff sign-in of the same administrator through the principal's login-attempt row (`500`).

  With `FOR KEY SHARE` neither happens (§8). Platform session issue also resolves the administrator on the locked transaction's own connection, so the lock holder never needs a second pool connection (ADR-040).
- **Fail-closed OCR validation guards (Stage 7B, migration 0076)**: `ocr.validate_patient_confirmation` and `ocr.validate_validation_insert` compared with `<>`, which is NULL when either side is NULL, and a NULL condition did not raise. So a confirmation was accepted for any patient when the guard could not read the source document (missing, or hidden by row-level security from a non-bypass owner, P8), and a validation was accepted when the guard could not read the extraction or the session had no account or membership. Both now refuse a missing job, source patient, extraction, account or membership, and compare with `IS DISTINCT FROM`, which already refuses a NULL operand; the explicit `IS NULL` refusals state the intent. The confirmation guard also binds `confirmed_by` and `confirmed_by_membership_id` to the session, as the validation guard does for the reviewer; before, any session in the facility could attribute a confirmation to another member. Error codes and messages are unchanged, and the OCR API always writes the session's own account and membership, so its confirmations and validations pass as before. CREATE OR REPLACE keeps each function's owner and ACL; `SECURITY DEFINER`, `search_path` and volatility are restated exactly.
- **Provider portal (Health-id)**:
  - D-Eminence/Health-id#18 reads the list above, closes a grant, and enables clinical writes only when `POST /identity/consent-status` allows them.
  - D-Eminence/Health-id#19 shows each approval's outcome and expiry, offers **Close access** for an active grant, and adds the outcome filters. The new fields and filters appear only when Identity reports them.

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

**Governed access:**
- The provider portal of D-Eminence/Health-id#19 works with any Identity build that serves the access-request list. It shows outcomes and offers the outcome filters only when Identity reports `effectiveStatus`. Otherwise it shows the request status, as before.
- An Identity build with the 0074 mapping selects the new columns by name, so it fails on the list (`5xx`) until 0074 is applied.
- Earlier Identity builds keep working after 0074 and the bootstrap. They ignore the new columns, and their request validation refuses the `active` and `closed` filters (`400`). The portal offers those filters only to an Identity that reports outcomes.

## 4. Prerequisites and pre-release checks

| # | Check | Owner | How |
| --- | --- | --- | --- |
| P1 | The production migration ledger's last applied version is known. | Database operator | `npm run db:plan` as the migration administrator, as in `MIGRATION_RUNBOOK.md` §6. It applies nothing, but its ledger bootstrap statements need the administrator's privileges, so it cannot run with read-only credentials. The local rehearsal covers 0028 → 0076; any other starting point needs its own rehearsal. |
| P2 | A restorable backup of the target database exists and its restore was tested. | Database operator | Snapshot or `pg_dump` taken immediately before the window. The rehearsal checks backup and restore integrity, but the real restore must be proven on staging. |
| P3 | `MFA_SECRET_KEY_B64` is provisioned for Identity: 32 random bytes, base64, from the secret store. `MFA_KEY_VERSION` is set. | Security owner and infrastructure owner | **The infrastructure code does not do this yet.** `infra/aws/src/hid-regional-stack.ts` maps no `MFA_SECRET_KEY_B64` from the Identity secret and sets no `MFA_KEY_VERSION`, which then defaults to `local-v1`. Stage 2A recorded this as an infrastructure task. An infrastructure change must add both before step 6. Without the key, platform sign-in fails closed with `503 MFA_UNAVAILABLE`, and a malformed key stops Identity at start-up. Never reuse a staging key in production. The key and `MFA_KEY_VERSION` are fixed when the first authenticator is enrolled: changing either later invalidates every enrolled authenticator unless a re-encryption release exists. |
| P4 | Identity `CORS_ORIGINS` lists only the exact HTTPS console origins, with no paths. | Platform operator | Enforced at start-up in production. With same-origin `/api/v1`, CORS is not used by the console. |
| P5 | The sizes of `audit.events`, `auth.sessions`, `auth.session_events` and `identity.consent_grants` are known, for the lock windows of 0067, 0069, 0072 and 0074. | Database operator | `select count(*)` and `pg_total_relation_size(...)` for each table on a recent snapshot. See §5. |
| P6 | Two Super Admins can sign in and confirm. | Security owner | Two-person approval needs a second Super Admin. Facility suspension needs at least one reachable Super Admin (0072). On a first deployment of Stage 2A (no platform sign-in yet), check this after step 6, when the Super Admins enrol their authenticators. |
| P7 | The staging acceptance in §7 passed on the exact builds being released. | Release owner | Evidence attached to the release record. |
| P8 | The role that owns the schema objects (the migration administrator) is a superuser, or is otherwise allowed to own functions that `SET plpgsql.variable_conflict` and bypasses `FORCE ROW LEVEL SECURITY`. | Database operator | Document scanning, the OCR pipeline and Outreach campaign registration depend on it, because their security-definer commands and triggers read row-level-secured tables as their owner. The rehearsal migrates as a superuser, and its non-superuser owner check runs only the additional suites, which do not cover these paths. Run locally on a copy with every function and table owned by a `NOSUPERUSER NOBYPASSRLS` role (§8), `schema.integration.sql` failed in turn at each of these, and passed in full once all of them were returned to a superuser owner:<br>• `ehr.append_document_scan_event` (`Document not found`);<br>• the `ocr.record_job_event` trigger (row-level security on `ocr.job_events`);<br>• `ocr.claim_worker_job` (`permission denied to set parameter "plpgsql.variable_conflict"`, set by 0015);<br>• `ocr.validate_job_write`, `ocr.complete_worker_job`, `ocr.validate_extraction_insert` and `ocr.fail_worker_job`;<br>• `ocr.validate_patient_confirmation`, whose wrong-patient check failed open because it compares with a document it cannot see. Under such an owner this path is unreachable, because claims already fail. Since 0076 the guard fails closed instead: under such an owner every confirmation is refused;<br>• `outreach.validate_registration_campaign_write` (`Exact Outreach campaign membership is required`).<br>The list covers what `schema.integration.sql` exercises; other definer paths may share the dependency. Before the release, confirm the owner's attributes as the migration administrator (`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`). The role bootstrap itself also needs a superuser today: it re-asserts `NOSUPERUSER … NOBYPASSRLS` with `ALTER ROLE` on every run, which PostgreSQL 16 allows only to a superuser, even when nothing changes (verified locally, §4.1). On a managed service whose administrator is not a superuser, such as Amazon RDS, also confirm in the staging rehearsal (S1) that 0015 applies and that an OCR claim and a patient confirmation succeed (S4b). The alternative is dedicated technical owners for these commands, proposed in §4.1 and ADR-041; it is not implemented. The new `ocr.worker_queue_metrics()` depends on none of this. |

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
  definer functions involved: 65 of the 175 that the migration administrator
  owns name a row-level-secured table, most outside these schemas. Each must
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
  for the run (`GRANT SET ON PARAMETER`, PostgreSQL 15 and later). A superuser
  must grant it, or the RDS master if RDS allows it, which is unverified. This
  part of P8 stays open.
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
10. If any estimate approaches 120 s, stop and re-plan before the release. 0072 cannot be edited or worked around in place: an index built beforehand under the same name makes 0072 fail. Do not raise the timeouts ad hoc.
11. **Immediately after the migrations, run `npm run db:bootstrap`, then `npm run db:verify-roles`.**
   - 0072 drops and recreates `audit.list_platform_events` with eleven arguments. Until the bootstrap grants `EXECUTE` on the new signature, any running Identity is refused on the platform audit list.
   - The bootstrap grants `EXECUTE` on `identity.list_my_staff_access_requests(text)` to the Identity runtime (D-Eminence/hid-system#26). Before that grant existed, the clinician list was refused (`403`) everywhere. 0074 recreates the function, so after 0074 the list is refused for every Identity build until the bootstrap runs.
   - The bootstrap grants `EXECUTE` on `auth.lock_account_sessions(uuid)` (0073) to the Identity runtime. A Stage 5B Identity running before this, or before 0073, fails with a database error (`5xx`) on every sign-out, every refresh of an expired session, an administrator's own-session revocation and refresh-token reuse; a reused family is then not revoked. Earlier Identity builds do not call it.
   - Between this step and step 6, and during a rolling Identity deploy, an earlier Identity runs against 0073. Its sign-out, expired refresh, refresh-reuse revocation and own-session revocation lock session rows before the account row, so each can deadlock with an administrator's revocation of the same account at the same moment. PostgreSQL cancels one of the two, which fails with an error and can be retried (§9). Keep that interval short.
   - The bootstrap creates `hid_ocr_queue_metrics`, makes it the owner of `ocr.worker_queue_metrics()`, creates its policy and grants the OCR worker `EXECUTE` (0075). Until then a Stage 6 worker logs `ocr.queue.metrics_unavailable`, as every worker does today.
   - The bootstrap grants `EXECUTE` on `auth.lock_account_for_mfa(uuid)` (0076) to the Identity runtime. A Stage 7 Identity running before this, or before 0076, fails every platform MFA transaction with a database error (`5xx`). Earlier Identity builds do not call it.
   - The bootstrap also runs the runtime-role assertions.

## 6. Deployment order

1. Pass the pre-release checks P1–P8.
2. Deploy the **admin console** (Health-id `main`). If the running Identity is Stage 2A or later, it keeps working with it (§3). If it is older, admin sign-in fails until step 6 whichever console runs; deploy the console with Identity instead.
3. Take the backup (P2).
4. Apply the **migrations** (§5).
5. Run the **role bootstrap** and verify it (§5).
6. Deploy **Identity**, with `MFA_SECRET_KEY_B64`, `MFA_KEY_VERSION` and `CORS_ORIGINS`. This needs the infrastructure change in P3. A Stage 5B or later Identity must not start before steps 4 and 5 (0073 and its grant), a Stage 7 Identity not before 0076 and its grant, and an Identity with the governed-access outcome mapping must not start before 0074 and the bootstrap.
7. Deploy the **Pharmacy API**. This is independent of the other steps.
8. Deploy the **OCR API** and the **OCR worker** (Stage 6). The API is independent of the other steps. The worker reports queue metrics once steps 4 and 5 (0075 and its grant) are done.
9. Run the smoke checks:
   - a Super Admin signs in with TOTP;
   - a high-risk action asks for step-up;
   - `GET /admin/audit/events?resourceType=facility` answers `200`;
   - `GET /admin/approvals` returns `{ items, nextCursor }`;
   - a clinician's `GET /identity/access-requests` answers `200`, and each item has `effectiveStatus`;
   - CloudWatch shows no `MFA_UNAVAILABLE`;
   - once the OCR worker has claimed a job, its `ocr.job.claimed` logs carry `queueDepth` and `oldestQueueAgeSeconds`, and no `ocr.queue.metrics_unavailable` follows a claim. A worker logs neither while it claims nothing.

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
| S4b | The OCR pipeline on staging: create a job, let the worker extract it, validate, confirm the patient and publish. A confirmation of the correct patient that fails with `500`, while PostgreSQL logs `Patient confirmation does not match the canonical OCR source patient`, means the schema owner cannot read the source document (P8, 0076). Confirm the outbox events, the patient-linked audit rows for `ocr.job.find`, `ocr.validation.list` and `ocr.publication.list`, the worker's `queueDepth` and `oldestQueueAgeSeconds`, and `OcrQueueAgeAlarm` datapoints. No OCR HTTP or worker run against a database has been done; the evidence is the unit, SQL and compiled-worker checks in §8. | Logs, audit rows and alarm history. |
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
- **Stage 7 (0076):** on the new local cluster `/tmp/hid-tuf-migration.stage7`, run as `postgres`. One database was migrated 0001 → 0076 from the branch, and one 0001 → 0075 from `main` (`dafe147`). Each had a copy with every schema, table and function owned by a `NOSUPERUSER NOBYPASSRLS` role, as in the rehearsal's owner check. REHEARSAL_PLACEHOLDER
  - **MFA lock order:**
    - `mfa-lock-order.spec.ts` has 11 tests: one per MFA transaction (the account lock comes first, in the same transaction, and is never the `FOR UPDATE` revocation lock), the challenge locked only after the account and for that account, a challenge refused once the lock is held, and platform session issue without a second pool connection. 10 fail against the `main` services; 9 fail against the first version, which used `auth.lock_account_sessions`.
    - `verify-platform-security-runtime.mjs` races an approved MFA reset against six MFA requests of its target: TOTP and recovery-code sign-in, step-up, recovery-code regeneration, enrolment activation, and enrolment started again over a pending factor. A second connection runs the real `auth.admin_decide_approval`, holding the target's account row as 0070 does until the request waits. While the request waits, it checks with `NOWAIT` which authenticator rows the request holds.
    - On `main`, every request held its factor while it waited. Sign-in and enrolment requests also held their challenge, step-up held its session assurance, and recovery-code sign-in and regeneration held their recovery codes. PostgreSQL detected six deadlocks (`pg_stat_database.deadlocks` +6, six `deadlock detected` reports in the server log), cancelled each MFA request (`500`) and committed the approval.
    - On the branch, each request waits holding no authenticator row, and the approval commits. The request is then refused (`401 MFA_CHALLENGE_INVALID` for sign-in and enrolment, `403 PLATFORM_SESSION_REQUIRED` for step-up and regeneration). It records no deadlock, leaves no live session, and never spends the recovery code.
    - The verifier also runs a step-up and a regeneration while a refresh of the same sign-in is in flight, and the platform password step while a staff sign-in of the same administrator holds the principal's login-attempt row.
      - On the branch, neither MFA request waits for the refresh and both answer `200`. The password step waits for the staff sign-in, which commits, and then answers `200`.
      - Against the first version (`FOR UPDATE`): both MFA requests waited, then answered `403 PLATFORM_SESSION_REQUIRED`. The password step deadlocked with the staff sign-in and answered `500`, while the staff sign-in committed. The server log shows the `deadlock detected` report between `delete from auth.login_attempts` and the staff `insert into auth.session_events`.
  - **OCR guards:** `ocr-validation-guards.integration.sql` runs 23 cases.
    - On 0075 it fails with 10 wrong outcomes:
      - two confirmations whose source document is missing;
      - confirmations with no session account or membership, or with another member's account or membership;
      - validations whose extraction is missing, with no session account (empty or unknown subject) or no membership.
    - Under the non-superuser owner, 0075 also accepts the wrong patient and the right patient (12), because the guard cannot read the source document.
    - On 0076 it passes in both. `schema.integration.sql`, the 27 additional suites (including `mfa-account-lock.integration.sql`) and the role assertions pass on 0076; the additional suites also pass under the non-superuser owner.
    - Mutation check: each of the 12 comparison predicates of the two guards, removed in turn, makes the suite fail at the case named for it. That covers facility, source patient, job patient, version, account, membership, status and extraction. Removing an explicit `IS NULL` refusal alone changes no outcome, because the `IS DISTINCT FROM` comparison that follows refuses the NULL operand too.
    - The functions keep their owner, ACL, `SECURITY DEFINER` and `search_path`.
  - **P8 proposal probes**, on throwaway databases and roles that were dropped afterwards (PostgreSQL 16.15), for §4.1 and ADR-041. They confirmed:
    - the `plpgsql.variable_conflict` behaviour under a non-superuser owner;
    - the in-body option;
    - the non-superuser bootstrap limits on `ALTER ROLE`, ownership transfer and later `CREATE OR REPLACE`.

    A rolled-back probe confirmed that `ocr.validate_job_write` accepts a job whose document has no scan event (§9).
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
- **Identity after Stage 7:** roll back freely; 0076's helper stays and earlier builds do not call it. A Stage 6 or earlier Identity brings back the deadlock between an approved MFA reset and an MFA transaction of the same account (§2): PostgreSQL then cancels one, and either the MFA request fails with a `5xx` or the approval fails and must be retried.
- **0076:** forward-only like every migration. To restore the earlier guard bodies, a new migration would have to recreate them; that would accept a confirmation for any patient again under a non-bypass owner, and validations from sessions without an account or membership. No OCR build depends on the earlier behaviour. The Stage 7 Identity needs `auth.lock_account_for_mfa`.
- **OCR after 0075:** roll the OCR API and worker back freely. Earlier workers lose the metrics again; earlier APIs write the earlier, possibly unlinked, events. The function, the role and both policies stay. Removing the outbox insert policy would stop patient confirmation and publication again.
- **Refresh-event change:** this is code only. Rolling back Identity brings back the old misclassification and nothing else. Existing `refresh`/`denied` events remain valid rows.
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

Each would be fixed the same way: lock every account involved, in account order, before anything else. That is a follow-up.

**Known limits of Stage 7B:** 0076 applies the fail-closed rule (ADR-040) to the two guards above only. Comparisons of the same kind remain elsewhere, each defence in depth today:
- `ocr.validate_job_write` compares the source document's latest scan in the same way, so a source with no scan event is not refused by the trigger. Confirmed locally on a rolled-back copy. The OCR API refuses a source that is not clean before it inserts a job. The trigger also runs on every job update, so hardening it needs a check of existing jobs and their scans first.
- `ocr.complete_worker_job` and `ocr.fail_worker_job` (0014) check `job_row.claim_token <> requested_claim_token`, so a NULL claim token passes the lease check: a session acting as the shared OCR worker subject could complete or fail a job that another worker replica holds. The shipped worker always sends its token. `ocr.renew_worker_claim` refuses a NULL token.
- `lab.validate_imported_evidence` (0017) compares the OCR job, extraction, validation and publication it imports with `<>` and does not check they were found. Row-level security on `lab.imported_evidence` refuses a session without an account or membership, so the session comparisons cannot be bypassed that way.
- `ocr.validate_publication_write` (0016) does not bind `requested_by` and its membership to the session, the attribution gap 0076 closes for confirmations.

Each is a follow-up.

## 10. Operator actions, not performed here

These are documented for the operators and were not done in this stage:
- deploying anything;
- running migrations or the role bootstrap against staging or production;
- provisioning `MFA_SECRET_KEY_B64`;
- changing AWS, DNS, Cloudflare, Supabase, IAM or Softbridge;
- creating the staging environment needed for §7.
