# Staging migration, backup/restore and rollback rehearsal

This is a staging-only extension of [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md).
Local synthetic evidence is never a deployed staging-copy acceptance record.
Production migration/cutover preparation stays locked until full staging
acceptance. No production patient dataset is authorized for this rehearsal.

## Executable local rehearsal

```sh
node scripts/tuf-staging-migration-rehearsal.mjs --evidence-dir /tmp/NEW_HID_REHEARSAL_EVIDENCE
```

Prerequisites: non-root Linux user, PostgreSQL 16 server/client tools on the
same host (`pg_config --bindir`), installed `services/ehr-api`, `services/identity-api` and `services/outreach-api` dependencies,
and the checked-in migration ledger. The command accepts no database URL or
cloud mode. It creates a private temporary Unix-socket-only PostgreSQL cluster
with host connections rejected, uses public synthetic fixture vectors, and
stops/removes only its own temporary cluster. The new evidence directory is
never reused. Caller cloud/database credentials are not passed to child tools.

The executable covers:

1. Verify every immutable migration hash `0001`–`0034`; apply a transactional
   schema dry run and assert its objects rolled back; apply the real schema,
   bootstrap runtime roles, assert zero pending on rerun, and run the real
   rollback-only schema/RLS, OTP, patient self-service, enrollment, emergency,
   patient-PIN, cutover-staging-integrity, and QoreID-evidence integration suites.
   After `schema.integration.sql`, the script runs every other
   `*.integration.sql` in `services/ehr-api/database/tests` except
   `runtime-roles.integration.sql`, in name order, and records their names in
   `checks.additional_schema_suites`; it runs them again on the
   non-superuser-owner copy below and on the restored database (item 5). They
   include `ehr-timeline-cursor.integration.sql`, which checks that the
   microsecond text form the EHR list cursors carry casts back to the same
   instant under four session time zones, and that the clinical-notes list
   predicate and order with that bound return the rows sharing the last row's
   millisecond that a millisecond bound leaves out
   ([DATABASE.md](DATABASE.md)). Execute the real OTP service against the exact Identity
   role, including concurrent completion/rate-limit and account-disable tests,
   the uniform recovery start cooldown (0081) and the per-account recovery code
   budget; notification delivery uses an in-process test double. Its result is recorded
   under `evidence.checks` as `otp_runtime`. The exact-role HTTP verifiers
   follow, recorded under `evidence.checks` in run order: `patient_runtime`,
   `patient_enrollment_runtime`, `patient_safety_runtime`,
   `delegated_cookie_read_runtime`, `outreach_cookie_read_runtime`,
   `provider_enrollment_runtime`, `platform_admin_runtime`,
   `session_sign_out_runtime`, `facility_selection_runtime`,
   `platform_security_runtime`, `staff_mfa_runtime`,
   `clinician_application_runtime`, `registration_review_runtime` and
   `patient_search_runtime` (the patient enrollment, patient safety, delegated
   cookie-read, Outreach cookie-read, provider enrollment, platform admin,
   session sign-out, facility selection, platform security, registration
   review and patient search verifiers on a disposable copy of the rehearsal
   database). Each is in
   `services/identity-api/scripts/` and runs Identity as
   `hid_identity_api_runtime`, except `delegated_cookie_read_runtime`
   (`services/ehr-api/scripts/verify-delegated-cookie-read-runtime.mjs`,
   D-Eminence/hid-system#38), which runs EHR as `hid_ehr_api_runtime` and
   Identity as `hid_identity_api_runtime`: a doctor's same-origin cookie read
   of a patient's encounters through EHR, with no Origin or CSRF token, is
   authorized by Identity, and EHR cookie writes without Origin or CSRF are
   refused (with D-Eminence/hid-system#52 it also reads the
   patient's record summary and two break-glass emergency summaries, a reader
   lacking four category read permissions and the doctor, with their audit
   events; with 0084 it also checks that the patient receives a signed note
   only with its completed encounter and that the emergency summary leaves out
   the notes of an encounter entered in error, and that the seeded doctor is
   refused `403 PERMISSION_DENIED` on the lab-request write, send-to-Lab and
   send-to-Pharmacy routes the launch module set withdrew); and `outreach_cookie_read_runtime`
   (`services/outreach-api/scripts/verify-outreach-cookie-read-runtime.mjs`,
   D-Eminence/hid-system#43), which runs Outreach as
   `hid_outreach_api_runtime` and Identity as `hid_identity_api_runtime`: a
   doctor's same-origin cookie reads of registration cases and campaigns, with
   no Origin or CSRF token, are authorized through Identity, cookie writes need
   Origin and CSRF, campaign writes are refused `400 VALIDATION_FAILED` even
   with both (the campaign is seeded with SQL), and Identity authorizes only a
   read permission for a read that the Outreach workload reports. `patient_enrollment_runtime`
   (`verify-patient-enrollment-runtime.mjs`) runs public NIN enrollment through
   activation, sign-in, refresh, recovery and sign-out, with QoreID (behind the
   real adapter), Siteverify and delivery stubbed (see
   [QoreID verification](QOREID_VERIFICATION_CONTRACT.md)); with migration
   0085 it also checks that the enrollment gate answers bound, pending and
   unknown NINs alike while closed, the 15-minute HID re-display and
   30-minute contact proof windows, and the QoreID lookup quota per IPv6 /64
   and per day across the platform. The rehearsal runs 0085's two SQL suites
   (`public-patient-enrollment-windows.integration.sql`,
   `public-patient-nin-quota.integration.sql`) with the additional suites;
   0085 changes no row of a table the 0028 upgrade check compares.
   `session_sign_out_runtime` (`verify-session-sign-out-runtime.mjs`,
   D-Eminence/hid-system#39) covers sign-out by refresh cookie after the access
   cookie has expired, and refresh and sign-out refused with
   `403 SESSION_CLIENT_MISMATCH` when `X-HID-Client` names the other
   application. It also covers an older rotated token, which ends its sign-in
   whichever application signs out; a sign-out during a timed account
   suspension; and two concurrent sign-outs with one cookie, recorded once.
   After them the module verifiers run on disposable copies with the other
   services faked, among them `encounter_lifecycle_runtime`
   (`services/ehr-api/scripts/verify-encounter-lifecycle-runtime.mjs`, 0084):
   EHR as `hid_ehr_api_runtime` refuses new orders on a completed encounter
   and every record on one entered in error (`409 ENCOUNTER_NOT_OPEN`),
   retracts an encounter's notes, diagnoses and open orders when it is marked
   entered in error (versions and audit included), cancels open orders with
   the encounter, makes a retraction wait for a child create holding the
   encounter, and lets activations race retractions without a deadlock. Since
   0090 (D-Eminence/hid-system#74) it also checks over HTTP that
   a nurse cannot retract a doctor's diagnosis and prescription through the
   encounter (`403 ENCOUNTER_RETRACTION_NOT_PERMITTED` with a fixed detail,
   nothing changed, the refusal audited with the missing permissions) while
   she can retract her own notes and vitals; that the retraction also covers
   vitals and completed prescriptions and returns `cascade`; that a vital can
   be entered in error on its own and then takes no correction, not even a
   direct runtime-role correction racing its retraction (which waits for it
   and is refused); that a closed prescription and a closed encounter take no
   change; and that a staff session on `GET /ehr/me/records` is
   `403 PATIENT_SESSION_REQUIRED` with one audit row. Its fixture gives the
   copy's doctor role `ehr.lab-request.write`, which its fake Identity session
   has always carried, because the 0090 database guard checks it when a
   retraction changes a lab request. The
   Lab, Pharmacy, OCR and EHR-to-Lab verifiers give their actors the Lab and
   Pharmacy write permissions through their fake Identity, so 0084's
   withdrawal of those permissions from the seeded roles does not affect them.
   With 0086 (D-Eminence/hid-system#69): `otp_runtime` also
   requires a completed recovery to revoke the account's Google link and keep
   its `legacy-identity` provenance record, a start
   from another account kind's page and a patient start with only an
   unverified email to send no code, and a staff reset to end the account's
   staff and platform sessions; `patient_enrollment_runtime` requires the
   staff and administrator reset pages to send a patient no code and five
   wrong passwords across a patient's email and HID to lock the account,
   refusing the correct password by either until the window ends;
   `patient_safety_runtime` requires a recent sign-in for an access approval
   and refuses an approval, an access-PIN set and a new emergency contact for
   24 hours after an OTP recovery (`403 PATIENT_RECENT_RECOVERY_HOLD`), while a
   denial and a PIN removal succeed, and requires the clinician's request list
   to name the patient of the active approval only, not of a pending or
   revoked one; `registration_review_runtime` runs
   unchanged against the narrowed `patients_registration_read` policy; and
   `patient_search_runtime` (`verify-patient-search-runtime.mjs`, new) requires
   a lookup with a grant to answer `200`, an unknown HID, a patient without a
   grant, a grant at another facility and a patient the caller can read but
   holds no grant for (a doctor's own patient record) to answer the same `404
   PATIENT_NOT_AVAILABLE` while the audit keeps `not_found` or
   `not_authorized`, a bad purpose `400`, an access request for an unknown HID
   to answer like a recorded one without `patientId` and persist nothing, and
   the actor and facility budgets to count those refusals alike, and not a
   granted lookup, and to answer `429` while blocked, each such request
   audited as a failure. The rehearsal also runs
   the new rollback-only `patient-search.integration.sql` with the additional
   suites.
   `platform_admin_runtime` (`verify-platform-admin-runtime.mjs`) also
   provisions a clinician through the workforce routes of migration 0087
   (launch decision D14, D-Eminence/hid-system#70): a new
   staff identity is attached to a verified facility as a pending membership,
   one Super Admin records the credential attestation, the same administrator
   is refused the grant (`WORKFORCE_SECOND_PERSON_REQUIRED`) and a second one
   grants `doctor`; the clinician then signs in, is refused the patient lookup
   before consent, creates access requests (`201`), and after the patient's
   approval the lookup succeeds (with the status the route declares: `201`
   until 0086 and `200` with it); the facility's `org_admin` is refused it
   (`PERMISSION_DENIED`). A revoke leaves the clinician's actor with no role
   and no permission, and a new grant restores `doctor`. The membership is
   then ended while a patient approval holds its access request FOR UPDATE
   and a staff transaction holds the membership's KEY SHARE and then asks for
   its account's: neither deadlocks, the end waits for the approval, revokes
   both grants (the new one included), expires the other pending request and
   signs the clinician out (`401`). The verifier provides `StaffSearchBudget`
   whenever the source has it, so it runs before and after 0086.
   `membership_duplicates_runtime` (`verify-membership-duplicates-runtime.mjs`,
   N5) runs the legacy promotion's membership uniqueness check against a
   disposable copy of the rehearsal schema: a staged membership beside an
   active, unheld membership the target holds is refused (and would break the
   N5 index); an exact re-promotion and memberships beside inactive, held or
   other facilities' ones are accepted; staged duplicates are refused.
   With 0088 (D-Eminence/hid-system#71): every verifier that signs staff in
   does it with password and authenticator (`staff-session-client.mjs`: the
   password step, the emailed enrolment code on a first sign-in, then a TOTP
   code, or a recovery code when a TOTP step would repeat), so each also
   requires the password step to set no session cookie. `staff_mfa_runtime`
   (`verify-staff-mfa-runtime.mjs`, new) requires the password step to set
   only the challenge cookie and create no session, a first enrolment to be
   refused without the emailed code (`403 MFA_ENROLLMENT_PROOF_REQUIRED`) and
   with a wrong one, the session and its assurance at the first TOTP code,
   TOTP replay and recovery-code reuse to be refused, a staff challenge to be
   refused by the platform steps, a staff session without assurance (as
   issued before 0088) to be refused `403 STAFF_MFA_REQUIRED` by cookie and
   bearer and ended on refresh while it can still sign out, a staff Google
   exchange to be refused `403 GOOGLE_STAFF_SIGN_IN_DISABLED`, an OTP recovery
   to keep the factor, a two-person reset of a staff account to revoke it
   and its sessions, the platform first enrolment of an administrator who is
   also a doctor to be refused `409 MFA_ENROLLMENT_STAFF_SIGN_IN_REQUIRED`
   (that account enrols at staff sign-in and uses the factor for both), and a
   factor enrolled at platform sign-in to be refused at staff sign-in (`403
   STAFF_MFA_FACTOR_UNPROVEN`) and by the database as the runtime role, until
   a two-person reset; `platform_admin_runtime` enrols its auditor and support
   administrator, who also hold staff memberships, at staff sign-in;
   `delegated_cookie_read_runtime` also requires the EHR to
   refuse a reader whose assurance is gone (`403 STAFF_MFA_REQUIRED`) and its
   refresh to end the sign-in. The rehearsal also runs the new rollback-only
   `staff-mfa.integration.sql` with the additional suites.
   `facility_selection_runtime` (`verify-facility-selection-runtime.mjs`,
   migration 0089, ADR-046) signs staff in with password and authenticator
   (`staff-session-client.mjs`) and covers the password step storing and
   reporting nothing, `default` on the enrolment activation and second-factor
   responses, a staff member's selected facility kept for the sign-in across
   a session read and refresh, the selection made unreadable for one step
   (`SELECT` revoked from the Identity runtime and restored): the session read
   `503` with no `Set-Cookie` and the refresh `200` with the rotated cookies
   and `unavailable`, `reselect` once the selected membership ends, another
   sign-in of the account unaffected, refused selections writing no selection
   and only their failed `auth.facility.select` audit row (the global
   `AuditInterceptor` registered as `AppModule` registers it), the 0089 guard
   as the runtime, and a selection waiting at the account lock while a
   sign-out ends the sign-in.
   With 0091 (D-Eminence/hid-system#75, ADR-058): the role
   bootstrap's assertions require that no role holds a `lab.*`, `pharmacy.*`,
   `ocr.*` or `outreach.*` permission, break-glass or document upload;
   `patient_safety_runtime` also requires the patient's request list and
   access history to name the requesting clinician and role, the history to
   report `truncated: false`, a doctor's `GET /auth/session` to list none of
   the withdrawn permissions, and a PIN use over HTTP to place one
   `PATIENT_ACCESS_PIN_USED` inbox item (none for the replay);
   `patient_runtime` expects the history's additive `truncated`;
   `outreach_runtime` and `outreach_cookie_read_runtime` opt their disposable
   copies into Outreach (the doctor role's Outreach permissions and the
   portal control), as the module's re-enabling migration would (a
   permission granted by hand on a staging database stops its next bootstrap,
   ADR-058); the non-superuser database check requires the three launch
   controls to read off after a `NOSUPERUSER NOBYPASSRLS` administrator
   migrates, and runs the release checklist's read-only P10 and P11 checks,
   taken from `PHASE_4_STAGE_5_RELEASE_READINESS.md`, as that administrator
   (they read the controls through `platform.control_enabled`, because the
   table's forced row-level security hides its rows from it); and the P8 owner check
   counts `ehr.patient_self_context` among its nine security-definer
   commands. The additional suites now include the patient-self binding cases
   and the launch-control state. Once 0090
   (D-Eminence/hid-system#74) and 0091 are on one branch,
   0090's `encounter-retraction.integration.sql` needs the merge change in the
   release checklist §2 (the nurse role's `ehr.document.write` inside its
   rollback-only transaction); without it the rehearsal fails on that suite.
   With 0092 (D-Eminence/hid-system#82, ADR-061): the additional
   suites include `public-patient-enrollment-self-reported.integration.sql`
   (a NIN record without a date of birth or gender activates with the values
   the patient enters, from 1900-01-01 to today, a value the record gives is
   refused, a record date that is not on the calendar is refused as an invalid
   identity, the authoritative profile is unchanged and the audit event names
   the entered fields), and
   `patient_enrollment_runtime` also requires a complete record's progress to
   list `requiredProfileFields: []` and refuse an entered date of birth, and
   runs a name-only record from start to sign-in with the date of birth and
   gender entered at activation.
   With 0093 (D-Eminence/hid-system#84, ADR-062): the additional
   suites include `public-patient-holder-proof.integration.sql` (the holder
   commands' catalogue and lock order, the runtime's refused writes, refused
   and accepted proofs, supersession, the facility rule, a bound NIN, the send,
   failure and distinct-NIN budgets with aged rows, the prune and activation
   with and without a proof); the five enrollment suites that activate prove
   the holder first; and the non-superuser owner pass runs them all.
   `patient_enrollment_runtime` runs the holder step over HTTP with registry
   phones `0803...`, `234...`, `+234...` (and with spaces), `null`, `''`,
   absent and unusable, an under-18 record, a wrong, expired, closed and spent
   code, the resend cooldown, the three budgets, a bound NIN answered only
   after a correct code (cookie expired, enrollment deleted), supersession,
   two deterministic races under a held NIN lock, and `{ open, online,
   facility }` availability. A database built with
   `apply-migrations.mjs --through=0092_patient_self_reported_enrollment_profile.sql`
   runs `upgrade/0093-public-patient-holder-backfill.sql` (rollback-only):
   enrollments at `verify_contact`, `set_password` and `active`, then 0093 and
   its backfill.
   With 0094 (D-Eminence/hid-system#85, ADR-063): the
   additional suites include `facility-assisted-registration.integration.sql`
   (designations, the facility list, the staff command and its refusals,
   budgets and audit, the in-person proof and activation), run in both
   passes. `assisted_registration_runtime` runs
   `verify-assisted-registration-runtime.mjs` after the patient enrollment
   verifier: a platform designation with step-up, the desk code, staff
   signed in with an authenticator, refused staff, a mismatch, a match,
   activation and sign-in, an existing Health ID, a race with a phone proof,
   both budgets and a suspension, as `hid_identity_api_runtime`.
   With 0095 (ADR-064): the additional suites include
   `notification-verified-recipient.integration.sql` (the claim-bound
   recipient answers, its refusals and catalogue), run in both passes, and
   `scripts/verify-non-superuser-database.mjs` calls the lookup as the
   RDS-like worker login. `notification_worker_runtime` runs
   `services/notification-worker/scripts/verify-notification-worker-runtime.mjs`
   after the Pharmacy, Lab, OCR and Outreach verifiers: the real worker as
   `hid_notification_worker` against a fake Novu that replays a seen
   idempotency key's answer as Novu does: flag off and on, a failed
   subscriber call that still sends the in-app trigger, an opt-out, a
   deleted, a suspended or a deletion-due login whose email is cleared first,
   an event retried while the patient goes withheld, eligible, withheld, and
   two concurrent events with the login deleted between them.
   With 0096 (the patient record release, ADR-065): the additional suites
   include `patient-record-release.integration.sql` (the database following
   `app.patient_release` category by category, the released rows of each
   table and of the released Lab results view across every withheld state,
   unbound contexts, an expired authorization and a consented staff context,
   the Lab and Identity runtimes refused the view, each policy's and the
   view's own conditions, the section indexes, the exact policy inventory),
   run in both passes.
   `patient_record_release_runtime` runs
   `verify-patient-record-release-runtime.mjs` after the delegated cookie
   read verifier: with every flag off the summary is unchanged; with the
   flags on, the released sets, the counts-only audit, the document download
   and its refusals, a staff session refused, Identity refusing lab-api,
   the runtime's privileges, and the database following the flags in the
   EHR's own patient-self transaction (nothing new without the release
   binding; only vitals with only that flag on), as `hid_ehr_api_runtime`
   against a real Identity child.
   With 0097 (break-glass at launch, with limits; ADR-058 addendum): the role
   assertions require exactly doctor, clinician and nurse to hold
   `identity.break-glass.write`; the additional suites include
   `break-glass-launch.integration.sql` (which sets `break_glass_enabled`
   itself through the administrator command inside its transaction, so it
   passes whatever the restored control holds, and needs an active
   `emergency` and no `healthcare-operations` row), and `schema`, `emergency` and
   `emergency-contacts` rely on the migrated grant; `patient_safety_runtime`
   no longer inserts the `emergency` code or grants the permission, requires
   both from the migrations, and drives `POST /identity/break-glass` over
   HTTP as a doctor signed in with an authenticator: `423
   BREAK_GLASS_DISABLED` with nothing written while `break_glass_enabled` is
   off, `201` and an unextended replay once its copy turns the control on
   (as P11's operator step would), `423` again once it is off, and `403
   PERMISSION_DENIED` for an org admin; and the non-superuser check's P10 and
   P11 expect `emergency` and the three break-glass holders. The
   non-superuser check also confirms 0097's precondition: before the first
   bootstrap the administrator cannot read the control
   (`PLATFORM_CONTROL_UNAVAILABLE`) and 0097 applies; after it, 0097's SQL run
   again as the administrator in rolled-back transactions is refused
   (`55000 BREAK_GLASS_CONTROL_ON`) with the control on and is a no-op with it
   off.
   With 0098 (clinician self sign-up, ADR-066): the additional suites include
   `clinician-applications.integration.sql`, the role assertions cover the
   new commands and keep `identity.workforce_change_role` from every runtime,
   and P11's read-only check expects `clinician_signup_enabled` off.
   `clinician_application_runtime` (`verify-clinician-application-runtime.mjs`,
   new, after `staff_mfa_runtime`) runs the real controllers, services,
   Turnstile verifier, MfaService and commands as `hid_identity_api_runtime`
   on a disposable copy, with only Siteverify and delivery stubbed and a
   virtual TOTP clock. It requires intake closed by default (`503
   CLINICIAN_SIGNUP_CLOSED` with its fixed sentence, availability false, the
   status start not gated) and opened only through `POST /admin/controls`,
   and closed again by the provider portal or maintenance; Turnstile, Origin
   and the signed-out rule to refuse before the service; identical start
   answers for a fresh, a staff-held and a patient-held address and for an
   applicant and four decoys, with a code only where one is due; the draft
   cookie's attributes, the search's verified facilities and its 30-search
   budget; submit to create an account, a pending staff record and an
   application with no membership or session, to rotate the capability and
   to replay; the applicant's sign-in to stay `403
   NO_ACTIVE_FACILITY_MEMBERSHIP`; the authenticator set up before review
   with no session, and neither the capability nor the draft to work at
   `/auth/mfa/*`; no audit row to carry the email, name or licence; the
   status page's authenticator step; the queue's permission and step-up,
   the applicant's live code at step 1 (a wrong one counted; an insider, a
   stale version and an approved application refused before the code, none
   counted), the second Super Admin and the insider refusal, and five
   platform-scoped audit events; the first staff sign-in after approval; a grant pinned to its own
   application's attestation across two applications, and a rejection that
   revokes nothing; a reserved attestation refused for a generic 0087 grant,
   also overdue and unswept, until approval; expiry read before the sweep
   and the sweeper skipping a locked row; races (a double submit, concurrent
   starts, two approvals at once beside a sign-in, a double-submitted step 1
   waiting on the applicant's account, withdraw against approve); a forged
   capability refused on submit and apply-again with no quota charged, and
   the platform cap counting the created application once; a ready
   capability searching beside a session cookie; an approved clinician
   whose authenticator was reset refused enrolment at the status page; and
   faults (a revoked grant, a missing function) answered `503`, never
   `401`. The non-superuser check gains an upgrade stage
   (`clinician_signup_upgrade_path`): on a second database it migrates
   through 0097 with `apply-migrations.mjs --through`, runs the previous
   release's control-owner bootstrap block so `platform.control_enabled` is
   owned by `hid_platform_control_reader` and the administrator holds only
   its ADMIN OPTION, applies 0098 as that administrator, bootstraps and
   verifies, and requires the function's owner unchanged, no INHERIT or SET
   membership left, and the control read `false` by the runtime logins.
   Before that, on the same database, 0098 runs in a rolled-back
   transaction as an administrator named `HidAdmin` (a name that needs
   quoting) that still owns the function, and must apply with no membership
   taken (`clinician_signup_quoted_owner`). It also runs
   `MIGRATION_RUNBOOK.md` §6's two P37 reviews of recent clinician approvals
   (break-glass use and in-person checks) as that administrator; the
   in-person review reads the checks, which force row-level security, as the
   `system:auth` actor, and both answer no rows there
   (`runbook_recent_approval_reviews`).
   With 0099 (imported legacy medical history, ADR-067): the additional
   suites include `imported-medical-history.integration.sql` (the patient-self
   binding and the release set, the staff decision for the one patient a
   transaction names, every refusal, break-glass, the sharing commands, the
   catalogue, and a staff page at the caps that asks the decision a few
   times rather than per row) and `imported-history-import.integration.sql`
   (the import command as `hid_migration_admin` on crafted runs: every
   refusal code, origins, the receipt, an idempotent repeat, the history
   run's seal, timestamp shapes, enrollment staying open, and linear time
   on tables analyzed empty), run in both passes.
   `imported_history_branch_precondition` builds a database to 0098 with a
   branch-shaped `ehr.imported_medical_records` and proves that 0099 refuses
   it (`IMPORTED_HISTORY_BRANCH_OBJECTS_PRESENT`) and leaves it unchanged.
   `imported_history_runtime` runs `verify-imported-history-runtime.mjs`
   after the patient record release verifier: the patient's own read, the
   sharing choice, the staff direct-care read, other purposes, break-glass,
   staff refused the patient routes, the database following the release
   binding, a revoked consent, every switch off, and, with Identity's
   sharing switch off, a withdrawal that still succeeds and the staff read
   that then answers `shared: false`, as `hid_ehr_api_runtime` and
   `hid_identity_api_runtime`. `imported_history_import` runs
   `rehearse-imported-history-import.mjs` on a database of its own: main's
   stage, promote and reconcile, the NIN crosswalk attestation and contact
   rekey, the history scope (a `legacy_imported_history` run the promoter
   refuses and leaves unchanged), the import's dry run, apply, repeat and
   refusals, and `identity.public_patient_enrollment_ready()` true before the
   history, once it is staged and once it is imported. The non-superuser
   pass (`verify-non-superuser-database.mjs`, step `imported_history_import`)
   runs the same rehearsal as the `NOSUPERUSER NOBYPASSRLS CREATEROLE`
   administrator and checks that no `hid_migration_admin` membership is left.
   With 0101 (staff record chat, ADR-069): the additional suites also include
   `staff-record-chat.integration.sql` (the staff proof under consent,
   permission, purpose and break-glass, the staff history against every other
   context, the legal hold, the staff limits and the catalogue), and the
   rehearsal runs `verify-staff-record-chat-runtime.mjs` after the patient's.
   With 0100 (patient record chat, ADR-068): the additional suites include
   `patient-record-chat.integration.sql` (the patient's own history under
   patient-self row-level security against every other context, the legal
   hold that keeps it, the limit commands' quotas, leases and budget, their
   catalogue, the kill switch read again by the reservation),
   run in both passes. `record_chat_runtime` runs
   `verify-record-chat-runtime.mjs` after the imported history verifier, against a
   local fake Messages API on 127.0.0.1 (nothing leaves the machine): flag
   off and kill switch off send nothing, one answered question sends one
   request with the configured model and geography and only the minimised
   extract, replay, validation, refusal, failure, the in-flight lease, a
   record changed and a history cleared during the call, earlier exchanges
   whose cited records were amended or withdrawn (never sent again, replayed
   or shown), a legal hold that keeps the history, another patient, a staff
   session, the hourly quota, the audit rows and a late settlement racing the
   next reservation (two runtime connections; the lease counted once), as
   `hid_ehr_api_runtime` against a real Identity child. The verifier accepts
   only the rehearsal's own socket, as every runtime verifier does
   (`scripts/tests/runtime-verifier-socket-guard.test.mjs`); a developer's
   own cluster is reached only through an untracked copy.
   These results are local synthetic evidence, not deployed application
   validation.
   Separately build a synthetic `0028` database with historical staff sessions,
   verified OTP challenges and registration outbox records; back it up, dry-run
   and apply `0029`–`0034`, verify preservation, fail-closed old OTP behavior,
   the new cutover controls, and minimal verification-evidence boundaries (and,
   since 0084, that no role holds a launch-withdrawn Lab, Pharmacy or EHR
   lab-ordering write permission; since 0090, that the retraction,
   closed-record, retracted-vital-correction and retracted-document triggers
   and the vital status are installed and the upgraded
   role bootstrap grants the EHR runtime the permission decision they use; since 0091 no Lab, Pharmacy, OCR or
   Outreach permission or document upload; since 0092 that
   the 7-argument enrollment activation command is gone and the upgraded role
   bootstrap grants the Identity runtime, and not `PUBLIC`, the new one; and
   since 0093 that the upgraded bootstrap grants the Identity runtime the
   three holder commands, no privilege on the holder events, no table-level
   `INSERT` or `UPDATE` on the enrollment table and no `UPDATE` of
   `holder_method`, and that a new enrollment defaults to `verify_holder`;
   and since 0094 that the upgraded bootstrap grants the Identity runtime the
   facility list, the in-person check command and the two designation
   commands (the designation read and the designation change), and no
   privilege on the designation, its events, the checks, the participation
   and attestation helpers or `auth.staff_session_is_mfa`, and that the
   permission is held by `clinician`, `doctor` and `nurse` only; the
   bootstrap's own `runtime-roles.integration.sql` checks the 0093 and 0094
   grants for every runtime role; and since 0096
   (`patient_record_release_grants`) that the upgraded bootstrap makes
   `hid_lab_release_reader` the owner of `ehr.patient_released_lab_results`,
   grants `SELECT` on it to the EHR runtime and not to the Lab runtimes,
   gives neither the Lab runtime nor the view's owner `ehr.patient_self_context`
   or the Lab runtime `USAGE` on `ehr`, and keeps `ehr.patient_self_context`
   executable by exactly the EHR runtime and the test role; since 0097
   break-glass held by exactly doctor, clinician and nurse, exactly the
   `direct-care` and `emergency` purposes, and `break_glass_enabled` still
   off; and since 0100
   (`record_chat_grants`) that the upgraded bootstrap gives the EHR runtime
   the chat history without `UPDATE`, the two chat commands and the legal
   hold check (none of them to `PUBLIC`), no runtime a privilege on
   the limit tables, and that `record_chat_enabled` and
   `clinician_signup_enabled` are off), then
   restore its pre-schema backup to an independent database for exact comparison.
   A separate restored copy transfers schema/function ownership to a synthetic
   NOLOGIN, NOSUPERUSER, NOBYPASSRLS owner and repeats the new command suites
   with exact runtime callers so superuser function ownership cannot hide RLS failures.
   Then `scripts/verify-non-superuser-database.mjs` runs the chain as RDS runs
   it, on a second disposable Unix-socket cluster of its own whose cluster
   superuser acts only where the RDS master would. That superuser creates a
   `NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB` LOGIN administrator and a
   database it owns. As that administrator the script checks that a migration
   run without `SET ON PARAMETER plpgsql.variable_conflict` stops at 0015 with
   0001-0014 committed; with the grant it applies 0015 to the latest migration,
   and the grant is revoked afterwards. It then runs the role bootstrap twice,
   each run overlapping a transaction that holds a lock on
   `platform.control_settings` and then locks `identity.outbox_events`, as a
   break-glass activation does: the first run must wait for the control table
   holding no application table lock, the second must take no lock on it. It
   runs `db:verify-roles`, checks that it refuses an `ADMIN OPTION`-only grant
   of `hid_ocr_queue_metrics` to `hid_ocr_worker`, creates one LOGIN per
   runtime credential as the administrator and passes
   `db:verify-logins` for all ten, and checks that `db:verify-logins` refuses
   the administrator's URL, a login with an extra role and another service's
   login. `platform.control_enabled` must answer the Identity, EHR and
   Outreach logins from the control rows, and the OCR worker login's claim
   must reach the function's own authorization check without the parameter
   privilege. It also runs `platform-control-owner.integration.sql` and
   `function-parameter-settings.integration.sql`. On a second cluster laid out
   as a new RDS instance (a `NOSUPERUSER CREATEROLE` master owns the database,
   and the provisioned roles sign in with SCRAM-SHA-256 passwords), it runs
   the provisioning task's script: `--administrator`, the 0015 grant, the
   migrations and the revoke, the bootstrap, refusals that change nothing, the
   ten runtime LOGINs verified with their own passwords, a rerun, a rotation
   and `--verify-logins` (`AWS_DEPLOYMENT_RUNBOOK.md` §4). It removes both
   clusters and is recorded under `evidence.checks` as
   `non_superuser_database` (about 20 s locally).
2. Seed a separate synthetic canonical patient/account/facility/membership,
   encounter, clinical note/revision and audit event before backup. Record
   per-table counts and deterministic sorted-row SHA-256 plus sequence state.
3. Create a real custom-format `pg_dump`, verify its archive directory, record
   timestamp/size/SHA-256, and check UTF-8, validated constraints and every
   foreign key for orphan rows.
4. Reproduce the source fixture scan twice; execute the existing stage,
   promote, retry and independent reconciliation commands against PostgreSQL.
   Preserve patient UUID/HID/account associations, Unicode, leap-day DOB, UTC
   timestamps, explicit Africa/Lagos facility mapping, identifiers, staff,
   memberships, request/consent holds and normalized denied audit outcome.
5. Restore the backup to a different disposable database. Compare **every
   table and sequence** to the pre-migration snapshot, recheck foreign keys and
   encoding, verify runtime-role grants, and run the schema/authorization suite
   against the restored database. Record measured restore duration and backup
   hash. This does not claim application HTTP validation.
6. Prove unique-HID, not-null, foreign-key and enum/check denials in rolled-back
   transactions. Run an orphan account-association fixture on a separate
   restored copy: promotion must block, earlier committed batches remain
   identifiable, and a blocked run cannot be retried as success.

Evidence includes `evidence.json`, `commands.json`, `pre-migration.dump`,
`pre-schema-upgrade.dump`, and
before/after count/checksum inventories. The local archive contains only
synthetic data; operational backups must never enter Git or public artifacts.
The evidence records source HEAD and whether the worktree was dirty. A dirty
local run is not evidence for an immutable release commit.

## Schema and import coverage

The candidate destination schema is exactly `0034`. The additive migrations
`0029`–`0034` extend the approved `0028` baseline and require a new admitted
release commit and artifacts; local success does not admit this candidate.
Empty-schema bootstrap and a synthetic `0028` upgrade are covered;
the data-rehearsal backup is taken after schema bootstrap and before legacy
promotion. An existing staging schema upgrade requires its own pre-schema
snapshot and restore verification; do not conflate these two backup points.
The external HID 1.0 source schema/version remains unknown until an authorized
inventory arrives. The fixture models the actual importer contract, not a
claim of compatibility with an unseen production schema.

Source import ordering is accounts/profiles, organizations, facilities,
patients, identifiers, staff, memberships/role associations, access requests,
consent grants, and access/audit events. Destination account identities remain
separate from patient UUIDs. The importer uses exact-key matching, per-row
hashes, deterministic association IDs, bounded serializable batches, and
`migration.runs`, `source_rows`, `conflicts`, `entity_reconciliations` for
progress and integrity. No same-key/different-content overwrite or conflict
skipping is permitted. A whole data migration is **not** one transaction;
earlier batches can survive a later failure.

Schema `0027` added facility lifecycle constraints and a mandatory role-grant
reason. Late legacy imports must use that migration's existing
active→verified/inactive→suspended transformation and record the migration
reason for scoped role grants. Inactive memberships retain revoked role grants
with the same affected-account provenance fallback and revocation reason as
0027. Grant reasons also match that backfill so previously imported rows retain
exact retry compatibility. The rehearsal exercises those real insert paths;
the reconciler checks facility lifecycle as well as the original active state.
Existing applied migration files are unchanged. Legacy `platform_admin` grants
still require reapproval, and unmapped consent purposes remain held.

The real rehearsal also exposed false retry conflicts from PostgreSQL typed
values (for example bigint strings and DATE values) versus raw fixture values.
Promotion now converts expected rows through the destination composite type
before exact comparison; same-key/different-content rows remain conflicts.
Reconciliation reads DATE as its calendar string to preserve leap-day DOB
without a timezone-dependent JavaScript Date conversion.

The 2026-09-06 local synthetic run passed schema, migration, reconciliation,
retry, full-table/sequence restore equality, runtime grants, schema/RLS tests,
constraint denials, inactive→suspended facility and revoked-membership retries, changed-destination
conflict rejection without overwrite, and blocked orphan/partial-failure recovery. Its evidence
SHA-256 is `22b18bca65aabb216783df65572467064cae46696b635ba542ae3e034b9ec984`.
This remains a dirty-worktree local run; actual staging and restored-application
HTTP gates are unexecuted.

Legacy clinical fields carried on Identity patient records are encrypted into
`migration.legacy_clinical_quarantine`. They are not silently imported as
authoritative EHR notes. The synthetic baseline proves current EHR relationship
and content preservation during backup/restore. Unknown legacy EHR/Lab/
Pharmacy/OCR/outreach tables and source object storage require an authorized
inventory and explicit domain mappings; no invented transform can satisfy
that hard gate.

## Actual staging execution checklist

Before migration rehearsal, bind exact source commit, signed TUF target,
artifact-set hash, twelve image digests, metadata versions/hashes, staging
account/region/RDS identity, destination schema, migration operator role,
authorized source dataset/snapshot identity, and a reviewed schema/table/
object inventory. Use synthetic data or a privacy-approved sanitized source.
No production credentials or patient copy may be substituted.

Record source PostgreSQL version/extensions/collation/encoding/timezones,
table/column types, constraints, source schema fingerprint, source row counts,
source timestamps/LSN, null/enum distribution and duplicate/orphan inventory.
Validate target size/capacity, TLS CA, domain-role grants, write freeze and
source consistency. Use the immutable migration image from the admitted plan.

After explicit staging migration authorization, follow the existing runbook's
exact `db:plan`, `db:dry-run`, role bootstrap, source scan, `migration:stage`,
`migration:promote`, and `migration:reconcile` commands with credentials
supplied through the approved private runtime. Do not put their values in
shell history, arguments, this document, CI output, or artifacts.

| Gate | Required retained proof |
| --- | --- |
| Pre-migration backup | Snapshot/backup ARN or version, timestamp/LSN, KMS identity, byte/hash manifest where applicable, successful completion and retention |
| Schema order | Source/destination versions, exact 32-file ledger and pending plan; dry-run outcome, execution order/times, zero pending afterward |
| Data totals | Per-entity source/staged/promoted/reconciled counts; every skipped/held/conflicting row explicitly accounted for |
| Identity | Exact UUID/HID preservation, user/account associations, contact/identifier normalization, no unintended new canonical patients |
| Constraints | Foreign keys, orphans, unique constraints/duplicate identifiers, not-null, check/enums, roles/RLS, facility relationships |
| Clinical history | Domain-owner-approved mapping; medical-record relationships, revisions, attribution, access logs, UTC instants and encoding preserved |
| Idempotency/failure | Exact rerun semantics, blocked-conflict refusal, batch failure evidence, controlled recovery with no blind overwrite |
| Objects | Every source object/version/size/checksum mapped to destination version/checksum/scanner evidence; no unreadable/missing object left unexplained |
| Reconciliation | Independent destination reads/decryption, counts/checksums, constraints, no unresolved integrity mismatch |
| Restore | Different staging restore destination; timestamp/duration/RTO/RPO, original backup identity/hash, all row/relationship/role/object checks repeat |
| Restored application | Deploy the already-admitted compatible application against the restored copy; health/readiness plus authorized synthetic login, patient/record reads and denied unauthorized/facility-crossing reads |

The backup/restore gate fails without both database integrity and application
validation against the restored staging database. Do not reuse local synthetic
SQL tests as evidence of cloud snapshots, PITR or application availability.

## Operational rollback while preserving TUF anti-rollback

Record accepted staging release A and deploy candidate B. After the migration
and restore rehearsal, construct a new approved forward recovery release C
that selects retained A application artifacts compatible with the selected
database state. Allocate a higher release sequence and fresh higher TUF
targets/snapshot/timestamp versions; sign with the normal staging thresholds.
Preserve every immutable root/metadata/target file and durable journal ancestry.
The current release-bundle SHA/artifact-set contract must admit this recovery
subject explicitly; merely relabeling old bytes as newly rebuilt code is forbidden.

Run the normal protected C publication, preview admission, whole-generation
archive, 100% deployment, public canary and journal confirmation, then deploy
the admitted application digests. Never serve an old `timestamp.json`, restore
an old TUF Worker version, decrement versions, reset client state/high-water,
reuse a burned version, or take over an unresolved publication claim.

On a client already updated to B/C, serve old/tampered/mixed/expired metadata
through an isolated attack fixture and prove rejection. On the operational
application, prove that A behavior is restored through C's valid forward
metadata. Test ordinary fresh clients separately using the ceremony root pin.
This distinguishes application rollback from a TUF rollback attack.

Before target writes, a verified pre-migration restore can supply the rollback
database. After target writes, preserve/reconcile those writes under a named
single-writer recovery procedure; a blind old snapshot restore would lose
clinical data. Keep both databases private and quiesced until identity,
clinical/audit/object integrity and operator approval authorize switching.

Retain A/B/C target and metadata identities, all journal revisions/version
references, app task/Worker deployments, restore identity, DNS/CDN route and
cache evidence, monitoring state/alerts, app smoke/denial evidence, measured
outage/recovery time, and reviewer decision. Any unresolved journal, missing
artifact, failed restore, stale metadata or user-facing failure means
`STAGING NOT ACCEPTED`.
