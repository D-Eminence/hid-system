# HID 1.0 Identity and Data Migration Runbook

Status: repository tooling, additive schema, deterministic fixture rehearsal,
and reconciliation contracts are implemented. No live HID 1.0 read, object
copy, AWS migration, cutover, credential rotation, or decommissioning has been
performed.

Supabase is a read-only legacy migration source in this runbook. It is not a
supported runtime identity, database, storage, or authentication dependency.
The target runtime supports local credentials and approved OIDC only.

## 1. Non-negotiable invariants

1. Preserve every valid patient UUID and HID code byte-for-byte.
2. Identity remains the only canonical patient/HID authority; no EHR patient
   copy is created.
3. Never update a same-key/different-content target row. Record a blocking
   conflict, correct it through governance, and create a new run.
4. Preserve source suspension/deletion and provenance. Missing facility,
   purpose, or identity facts become explicit holds, never inferred authority.
5. Password hashes are imported only after exact bcrypt compatibility is
   proven; a successful login upgrades atomically to Argon2id. Unsupported
   hashes require verified reset or OIDC relink.
6. A raw HID 1.0 session is not accepted. Repository evidence cannot prove the
   real issuer, signing algorithm/key, audience, expiry, revocation, or cookie
   contract. Seamless exchange remains rejected until that complete live trust
   contract is independently proven.
7. The fallback is a purpose-bound six-digit contact OTP mapped to the existing
   patient. OTP values are never plaintext-persisted/logged or sent through
   Novu/EventBridge/SQS.
8. All source and destination objects remain private, encrypted, versioned, and
   addressed by opaque PHI-free keys.
9. Migrations `0001`–`0027` are immutable. `0028` is additive. Future changes
   require a new migration.
10. Zero data loss cannot be claimed until the final write boundary, database
    and object reconciliation, cutover, and rollback evidence are signed.

## 2. Implemented assets

| Asset | Purpose |
|---|---|
| `database/migrations/0001_*.sql` through `0027_*.sql` | Immutable platform ledger |
| `database/migrations/0028_identity_notification_migration_state.sql` | OTP/KYC assurance, legacy mapping, encrypted device registration, delivery reconciliation |
| `database/migrations/0033_supabase_cutover_identity_controls.sql` | Sealed Supabase cutover input, server-only patient PIN controls, exact Google subject links, and outreach preservation holds |
| `database/migrations/0034_qoreid_verification_evidence.sql` | Append-only, minimal QoreID NIN/CAC evidence commands for existing HID patients and organizations; no raw identifier or provider payload storage |
| `database/migrations/0047_provider_integration_controls.sql` | Secret-free provider/capability controls, optimistic routing, runtime decisions and append-only admin history |
| `database/migrations/0048_cac_legal_entity_binding.sql` | Original exact CAC number/legal-name approval guard; `0056` extends it for verified submitted identifiers and sourced profile fields |
| `database/migrations/0049_qoreid_request_quotas.sql` | Shared NIN/CAC/test and public application request limits, keyed network digests, and 48-hour counter retention |
| `database/migrations/0050_patient_nin_evidence_binding.sql` | Require the current patient's prior governed NIN HMAC binding before recording verified QoreID evidence; remove the unbound evidence command |
| `database/migrations/0051_public_patient_enrollment.sql` | Encrypted unique-NIN pending enrollment, single-contact OTP and rate limits, immutable authoritative profile, and atomic account/patient/HID activation after OTP and password |
| `database/migrations/0052_authoritative_cac_identity.sql` | Registration-identifier-only public intake and original complete-QoreID-profile binding guard, revised by `0056` |
| `database/migrations/0053_remove_unwired_piersflow_catalog.sql` | Remove the non-executable PiersFlow placeholder from the admin provider catalog while preserving any unexpected audit history |
| `database/migrations/0054_complete_existing_cac_evidence_binding.sql` | Compare all required persisted legal-entity fields for existing-organization CAC evidence; incomplete historical bindings fail closed |
| `database/migrations/0055_verified_incomplete_cac_result.sql` | Historical `verified_incomplete` representation for a successful sparse lookup; `0056` converts it to verified provider state plus incomplete profile state |
| `database/migrations/0056_cac_applicant_profile_completion.sql` | Separate CAC provider verification from profile completion; preserve the verified submitted RC/BN/IT identifier when QoreID omits `cac.rcNumber`, enforce returned-number matches, store provider fields and per-field `qoreid`/`user_provided` sources, add bounded email-OTP completion, preserve non-active provider status while blocking review, and require a complete sourced active profile plus existing governed review before binding/approval |
| `database/migrations/0057_legacy_nin_crosswalk_and_contact_lookup.sql` | Dedicated canonical contact lookup, restricted exact/absent legacy NIN inventory and verified-run attestation, and fail-closed readiness commands |
| `database/migrations/0058_progressive_patient_nin_binding.sql` | Session-bound QoreID verification that binds an exact NIN to the preserved migrated patient and advances assurance without changing UUID or HID |
| `database/migrations/0059_google_onboarding.sql` | Short-lived accountless Google proof, recoverable enrollment binding, atomic activation link, and explicit existing-account link command |
| `database/migrations/0060_patient_access_pin_profile_status.sql` | Patient-safe assurance and Access PIN configured status without returning PIN material |
| `database/migrations/0061_provider_cac_self_service_onboarding.sql` | Self-service approval mode for organization applications, public application lookup, verified-CAC result recording, and atomic organization/facility/product/administrator activation |
| `database/migrations/0062_provider_cac_self_service_constraints.sql` | Self-service-aware review constraint, accountless self-service application submission, and the runtime activation command that returns the new login email in the same transaction |
| `database/migrations/0063_provider_self_service_cac_quota.sql` | Accountless self-service CAC lookups charged to a keyed client-network digest (IPv4 address or IPv6 /64, 5 an hour and 15 a day) and the shared per-application daily CAC limit, with every decision audited; reviewer `application_cac` quotas are unchanged |
| `database/migrations/0064_patient_account_deletion_lifecycle.sql` | Patient login/account deletion lifecycle with single-use confirmation, configurable cancellation window, legal-hold and retain-only record-class policy, terminal deleted login, and atomic revocation/completion audit; no identity, NIN, clinical, or audit data is deleted |
| `database/migrations/0065_patient_emergency_contacts.sql` | Encrypted patient emergency contacts, code verification, and idempotent minimum-necessary emergency-contact notification intents from `EmergencyAccessActivated`; break-glass authorization unchanged |
| `database/migrations/0066_patient_access_safety.sql` | Session-bound patient access-request decisions (and corrected `0035` commands), patient-owned grant revocation, break-glass/revocability labels in access history, and no new inbox items for deleted logins |
| `database/migrations/0067_platform_admin_scope.sql` | Explicit platform scope for facility-less administration audit (`audit.events.access_scope`, replaced staff checks, permission-checked BEFORE INSERT trigger), corrected `audit.list_platform_events` result, and platform-scope onboarding gate |
| `database/migrations/0068_admin_account_transition_safety.sql` | Admin status command cannot activate `pending_reset`/`locked` accounts or bypass recovery by disable/re-enable (`auth.accounts.disabled_from_status`); administrators cannot change their own status or platform roles |
| `database/migrations/0069_platform_mfa_sessions.sql` | Platform administrator MFA: encrypted TOTP factors, one-time recovery-code digests, short-lived MFA sign-in challenges, the `platform` session kind with 15-minute idle and 8-hour absolute ceilings, server-side session assurance and step-up evidence, MFA session events and rate-limit scopes, the restricted principal-export and MFA-reset permissions, and session-family revocation |
| `database/migrations/0070_platform_two_person_approval.sql` | Two-person approval (24-hour requests, executed once by a second MFA-enrolled Super Admin with fresh step-up) for Super Admin grants and MFA resets; the one-step role command refuses Super Admin grants; last-Super-Admin reachability no longer requires a facility membership |
| `database/migrations/0071_platform_control_command_column_references.sql` | Replaces `platform.admin_set_control` (same signature, result and checks) with qualified table references; the 0039 version failed on every call because its output columns shadowed the table columns |
| `database/migrations/0072_platform_admin_contract_gaps.sql` | Target filter (`resource_type`/`resource_id`) on `audit.list_platform_events` (dropped and recreated with eleven arguments; the role bootstrap grants the new signature) and its `audit_resource_uuid_sequence_idx` index (audit inserts wait while it builds); `identity.admin_transition_facility` counts the platform-session reachable Super Admins (same signature); null-safe `auth.other_reachable_super_admins`. Release the Identity API of this stage with the Health-id Stage 4B admin console (`PHASE_4_STAGE_4A_ADMIN_CONTRACTS.md` §7); the release order, index-build window and checks are in `PHASE_4_STAGE_5_RELEASE_READINESS.md` |
| `database/migrations/0073_session_revocation_serialization.sql` | `auth.admin_revoke_account_sessions` and `auth.admin_revoke_session_family` lock the target and acting administrator's account rows (`FOR UPDATE`, in account order) before revoking (same signatures and results), and the new `auth.lock_account_sessions(uuid)` gives the Identity API the same lock. A revocation then waits for a refresh rotation in flight and also revokes the session that rotation created. No table lock; the role bootstrap grants the helper to the Identity runtime. Apply 0073 and the bootstrap before a Stage 5B Identity starts (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §2, §5, §9) |
| `database/migrations/0074_staff_access_request_outcome.sql` | `identity.list_my_staff_access_requests` reports the outcome of each approval: `consent_grant_id`, `grant_expires_at`, `effective_status` (`active`, `expired`, `closed`, `revoked`, or the request status) and `authorization_method`. The status filter also matches these outcomes. The result type changes, so the function is dropped and recreated: until the role bootstrap restores its `EXECUTE` grant, every Identity build is refused the clinician list (`403`), so run the bootstrap immediately after the migrations, and before an Identity build that reads the new columns (earlier builds keep working after it). `consent_grants_request_idx` is built without `CONCURRENTLY` under a `SHARE` lock on `identity.consent_grants`: new grants wait while it builds, reads continue. Time it in the staging rehearsal with the table's size |
| `database/migrations/0075_ocr_queue_metrics_and_outbox_insert.sql` | `ocr.worker_queue_metrics()` returns the OCR queue depth and the oldest queued age, aggregates only, for the OCR worker, which has no table privileges and could not read them before (`42501`, logged as `ocr.queue.metrics_unavailable`). The role bootstrap grants `EXECUTE` to `hid_ocr_worker` only and makes the new non-login role `hid_ocr_queue_metrics` its owner, which reads only `ocr.jobs.status` and `queued_at`, across facilities, through the exact policy `ocr_jobs_queue_metrics_read`. A worker of this release that runs before the bootstrap keeps logging the warning and claims jobs as before. `ocr_outbox_staff_insert` lets the OCR API runtime append outbox events for the current facility: without it, `FORCE ROW LEVEL SECURITY` refused every insert, so patient confirmation and every publication request, success and failure failed. `CREATE POLICY` holds an `ACCESS EXCLUSIVE` lock on `ocr.outbox_events` only for the catalog change; it waits for in-flight OCR transactions within the 5 s lock timeout |
| `database/migrations/0076_mfa_account_lock_and_fail_closed_ocr_guards.sql` | `auth.lock_account_for_mfa(uuid)` (`FOR NO KEY UPDATE` on the account row), which every platform MFA transaction of Stage 7 Identity calls first, so it cannot deadlock with an approved MFA reset and MFA transactions of one account run one at a time; the role bootstrap grants it to the Identity runtime only. The OCR patient-confirmation and validation guards fail closed: a missing job, source patient, extraction, session account or membership is refused, and comparisons use `IS DISTINCT FROM` (before, `<>` with a NULL side let the write through, so a confirmation was accepted for any patient when the guard could not read the source document). The confirmation guard also binds the confirming account and membership to the session. `CREATE OR REPLACE` keeps the owners and ACLs; no table lock. Apply 0076 and the bootstrap before a Stage 7 Identity starts; until then every platform MFA transaction fails with a `5xx` (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §3, §5, §6) |
| `database/migrations/0077_fail_closed_session_guards_and_ocr_worker_leases.sql` | The remaining session guards fail closed (ADR-040): the Lab, Pharmacy and Outreach triggers refuse a missing session account, membership or facility (and, for Outreach, a purpose other than direct care) with their existing codes and messages and compare with `IS DISTINCT FROM`. Before, `<>` with a NULL side let the row through, so a session that bypasses row-level security could record Lab, Pharmacy or Outreach rows attributed to any member with no request context. The Lab OCR-import guard also refuses another facility's OCR evidence when its owner cannot read it (P8). OCR: `complete_worker_job` and `fail_worker_job` refuse a NULL claim token (before, any replica of the shared worker subject could complete or fail a job another replica held) and `fail_worker_job` refuses an expired lease; lease renewal works for an active lease, at most an hour ahead (the job trigger refused every `renew_worker_claim`, so a job that outlived its lease could not complete); a new job, or one moved to another source or started, needs an exact clean scan of its document, while jobs created earlier without a scan event can still be failed, retried and validated; failing, cancelling or requeueing a job no longer re-reads its evidence, so a document withdrawn during OCR no longer stops every claim of its provider; a publication must name the session's own account and membership. `CREATE OR REPLACE` keeps owners, ACLs and triggers; no table lock. The role bootstrap grants `auth.account_id_for_subject(text)` to the Outreach runtime: without it every Outreach write failed with `42501`. Before applying, run the read-only OCR scan check (`PHASE_4_STAGE_5_RELEASE_READINESS.md` P9) and apply 0077 and the bootstrap together (§2, §5, §9) |
| `database/migrations/0078_runtime_command_repairs.sql` | Two defects behind the runtime-role locks that Stage 9 removed. The `patient_identifiers_self_nin_insert` policy (0058) applies to every role and read `identity.verification_evidence`, which the Identity runtime cannot read; PostgreSQL checks the privileges of every applicable policy, so every Identity runtime insert of a patient identifier, including both NIN registration reviews, failed with `42501`. The policy is dropped: the only writer of self-NIN identifiers, `identity.bind_my_verified_nin`, is a definer function owned by the table's owner on a table without forced row-level security, so it never used the policy, which only let another role insert self-NIN identifiers without the function's checks. `lab.validate_work_item_child` (0018) read `NEW.ordinal` on `lab.work_item_events` (`42703`), so every Lab acceptance of an EHR order failed; the requested-test check is now reached only for `lab.work_item_requested_tests`, unchanged. Dropping the policy takes a brief `ACCESS EXCLUSIVE` lock on `identity.patient_identifiers` for the catalog change only. No grant change, but the Stage 9 role assertions require the policy to be gone, so run `db:bootstrap` and `db:verify-roles` after 0078 (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §2, §5, §9) |
| `database/migrations/0079_patient_access_pin_actor_window.sql` | Replaces `identity.access_patient_with_pin` (same signature, result, `SECURITY DEFINER` attribute and `search_path`) so that a correct PIN clears only the failure window of the patient it verified. Before, any success also cleared the staff member's actor window, so a clinician who knew one patient's PIN could keep guessing other patients' PINs without reaching the five-failure actor lock. Function replacement only; no table, grant or data change |
| `database/migrations/0080_pharmacy_source_prescription_guards.sql` | Replaces `pharmacy.validate_work_item()` and `pharmacy.validate_dispensing()` (same signature, `SECURITY DEFINER` attribute, `search_path`, volatility, owner and 0077 checks) so that each also reads the EHR prescription with a share lock: an acceptance must equal the exact active prescription version (every snapshot field except the prescription time and the start and end dates, which a later release will compare), and a dispensing needs its prescription still active at the accepted version. Each refusal is `23514` with its own constraint name, which the Pharmacy API answers with `409`. Before, Pharmacy accepted cancelled or nonexistent prescriptions and dispensed work whose prescription had been cancelled. Function replacement only; no table, grant or data change, no table lock. Deploy the Pharmacy API with the `409` mapping before or with 0080; earlier EHR builds keep working (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §2, §3, §5, §6) |
| `database/migrations/0081_uniform_recovery_start_cooldown.sql` | New table `auth.otp_start_cooldowns`: the recovery start cooldown per purpose and keyed identifier, kept whether or not the identifier has an account, so a repeat start inside the cooldown is answered with the same challenge id for a known and an unknown identifier (before, only a real account's repeat got its live id back). No foreign key, no row-level security; the role bootstrap grants `SELECT`, `INSERT` and `UPDATE` to the Identity runtime and the schema-test runtime, and `DELETE` to none. A new table: no lock on an existing table, no window. Run `db:bootstrap` and `db:verify-roles` after it, and only then deploy the Identity build of this change, whose every recovery start fails (`500`) without the table and the grant (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §3, §5, §6) |
| `database/migrations/0082_purpose_of_use_vocabulary.sql` | Seeds `identity.purpose_of_use_codes` with `direct-care` ("Direct patient care", active, source `hid`), `ON CONFLICT (code) DO NOTHING`, so a row already inserted or deactivated by an operator is kept as it is. 0003 created the table empty and nothing inserted a row, while every consent decision requires an active code, so on a database built only from migrations every staff consent check, access request, grant close, PIN and break-glass failed closed. `emergency` and `healthcare-operations` are not seeded: each waits for a product decision (§5). `ROW EXCLUSIVE` lock on that table only; no grant or service change |
| `database/migrations/0083_ocr_claim_in_body_variable_conflict.sql` | Replaces `ocr.claim_worker_job(text, integer)` (`CREATE OR REPLACE`; same signature, result columns, `SECURITY DEFINER`, `search_path` and body) with `#variable_conflict use_column` as the first line of its body instead of 0015's `SET plpgsql.variable_conflict = 'use_column'`. That parameter has superuser context: on RDS, where no role is a superuser, a fresh chain stops at 0015 unless the migration administrator holds `SET ON PARAMETER plpgsql.variable_conflict`, and the definer applied the setting as its owner on every claim, so the privilege was needed for good. After 0083 no function needs it, and the operator revokes it (§6). The option resolves the same names to columns, so claims behave as before; owner, grants and comment are kept. Function replacement only; no table lock, grant or data change (`DATABASE.md`, "Non-superuser database chain on RDS (0083)") |
| `database/migrations/0084_ehr_clinical_safety_and_launch_modules.sql` | EHR clinical safety and the launch module set (D-Eminence/hid-system#64). Deletes `ehr.lab-request.write`, `lab.work-item.accept`, `lab.accession.create`, `pharmacy.work-item.accept` and `pharmacy.dispensing.create` from every role in `auth.role_permissions` (decision D17: Lab and Pharmacy off at launch; the routes answer `403`); reads stay. Adds `SECURITY INVOKER` triggers that share-lock the encounter and refuse a note, vital, diagnosis, document, prescription or lab request on a cancelled or entered-in-error encounter, and a new or activated order on a completed one (`55000 ENCOUNTER_NOT_OPEN`); refuse any update of a diagnosis entered in error; and refuse an update of a recorded vital other than its current correction number. Recreates the two patient-self note policies to require a completed encounter. No table, column or grant change, no scan. `CREATE TRIGGER` takes a brief `SHARE ROW EXCLUSIVE` lock on six clinical tables and the policy change a brief `ACCESS EXCLUSIVE` lock on `ehr.clinical_notes` and `ehr.clinical_note_revisions`, each within the 5 s lock timeout. Existing rows are not changed; retract the open lab requests of closed encounters that the clinical owner does not keep before it, while the permission is still held (P12). Run `db:bootstrap` and `db:verify-roles` after it: the role assertions require that no role holds the five permissions. The platform controls are set by an operator, not by the migration (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §2, §5, P11, P12) |
| `database/migrations/0085_public_enrollment_windows_and_nin_lookup_quota.sql` | Replaces `identity.activate_public_patient_enrollment` (same signature, result, `SECURITY DEFINER` attribute, `search_path` and grants) so that it refuses a replay more than 15 minutes after activation (`P0002 PATIENT_ENROLLMENT_REPLAY_EXPIRED`) and a first activation whose contact was proved more than 30 minutes earlier (`23514 PATIENT_CONTACT_REVERIFY_REQUIRED`), decisions N2(b) and N2(c). New table `platform.public_patient_nin_quota_counters` (forced row-level security, no runtime privilege) and command `platform.consume_public_patient_nin_quota(char,integer,integer,integer)`: each QoreID NIN lookup of public enrollment is charged to a keyed client-network digest per hour and day and to a platform-wide daily cap, refusals audited; `platform.prune_verification_quotas()` also drains it. No lock on an existing table, no window. Run `db:bootstrap` and `db:verify-roles` after it (the bootstrap grants `EXECUTE` to the Identity runtime), and only then deploy the Identity build of this change, whose every enrollment start that reaches QoreID fails (`503 VERIFICATION_QUOTA_UNAVAILABLE`) without the command and the grant. Deploy it right after: an earlier Identity on 0085 answers an activation with a contact proof more than 30 minutes old `409 ENROLLMENT_STAGE_INVALID` and cannot send it back to the contact step, so that enrollment cannot activate until it expires (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §3, §5, §6, §9) |
| `database/migrations/0086_recovery_and_patient_search_hardening.sql` | Account recovery and patient search hardening (D-Eminence/hid-system#69). `CREATE OR REPLACE` of `auth.complete_recovery_otp` (also revokes every external sign-in identity, today Google links, of the recovered account and keeps the legacy importer's `legacy-identity` provenance record; audit counts the revoked ones), `identity.create_access_request` (an unknown HID gets a uniform pending answer, an `identity.access-request.refused` audit event and no row) and `identity.list_my_staff_access_requests` (`patient_id` only while the request's grant is active); `patients_registration_read` dropped and created again in the same transaction (a registration member reads only patients linked to a case or candidate at its facility, no longer every patient; `ACCESS EXCLUSIVE` on `identity.patients` until commit, taken first); new `SECURITY DEFINER` functions `auth.recovery_account_audience`, `identity.registration_nin_holder`, `identity.registration_candidates` and `identity.patient_lookup_audit_subject`, revoked from `PUBLIC` and granted by the role bootstrap to the Identity and schema-test runtimes only; four staff search scopes in `otp_rate_limits_scope_check` (`ACCESS EXCLUSIVE` on `auth.otp_rate_limits`, taken second); index `otp_challenges_account_consumed_idx` (`SHARE` on `auth.otp_challenges`, taken last). Each lock is held until commit. A recovery completion caught between its challenge update and its patient read can deadlock with the migration (`40P01`); if PostgreSQL cancels the migration, or a wait exceeds the 5 s `lock_timeout` (`55P03`), 0086 rolls back whole and `migrate` is run again. Run `db:bootstrap` and `db:verify-roles` after it and deploy the Identity build of the same change with it: the older build's registration duplicate checks read patients the narrowed policy hides. After it a patient recovery code goes only to a verified contact, so an imported account whose source email was never confirmed (`email_verified_at` null) and that has no verified enrollment phone gets no code (§6, §11) |
| `database/migrations/0087_governed_workforce_provisioning.sql` | Launch D14 (workforce) and N5 (ADR-049). A unique partial index allows one active, unheld membership per account and facility; if a database already holds duplicates the migration stops with `23505 MEMBERSHIP_DUPLICATES_FOUND` and changes nothing, so run operator plan I4 first (`PHASE_3_LAUNCH_DECISIONS.md` §3) on any database the legacy promotion or SQL has written. `staff_memberships_scoped_uq` is narrowed to active rows (drop and recreate: a brief `ACCESS EXCLUSIVE` lock on `identity.staff_facility_memberships`, which every staff request reads, so apply it in the migration window). New permission `platform.workforce.manage` (`platform_super_admin` only); tables for credential attestations, the workforce membership lifecycle and attested role grants (row-level security, no runtime grant); SECURITY DEFINER commands to attach staff, record an attestation, grant or revoke a clinical role and end a membership, plus a profile read; `auth.membership_has_permission` ignores a role whose attestation lapsed. Run `db:bootstrap` and `db:verify-roles` immediately after it: the Identity build of this change calls `auth.facility_role_is_effective` on every staff sign-in and request, which fails until the bootstrap grants it (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §2, §5, §6, §9) |
| `database/migrations/0088_staff_mfa_sessions.sql` | Staff MFA (D-Eminence/hid-system#71, launch blocker MFA-1). `auth.mfa_login_challenges` gains `session_kind` (`platform` default, or `staff`) and the enrolment proof columns (`proof_method`, `proof_verifier_hmac`, `proof_key_version`, `proof_sent_at`, `proof_verified_at`) with two checks; `auth.mfa_factors` gains `enrollment_proof` and `enrollment_challenge_id` with one check and the new trigger `mfa_factors_enrollment_proof_guard` (a factor records a staff proof only from a live, verified staff enrolment challenge of its account, and never changes it); `ACCESS EXCLUSIVE` on each of the two tables until commit, no rewrite, the checks scan their rows. `CREATE OR REPLACE` of `auth.guard_mfa_login_challenge_change` (kind immutable, verified proof final, a staff enrolment challenge cannot be consumed without a verified proof) and `auth.guard_session_assurance_change` (accepts staff session families, but only on a factor that records a staff proof: `STAFF_MFA_FACTOR_UNPROVEN`); comments; the `platform.mfa.reset` description. No session, account or factor row changes and no grant changes (the new trigger function is revoked from `PUBLIC`). Existing factors record no staff proof: they keep verifying platform sign-in, and an administrator who also holds an eligible staff membership is refused staff sign-in (`403 STAFF_MFA_FACTOR_UNPROVEN`) until a two-person MFA reset (§6 lists them). Deploy the Identity build of the same change after it (the build writes the new columns); from that deploy every existing staff session is refused (`403 STAFF_MFA_REQUIRED`) and ended on refresh, and every staff member signs in again with an authenticator, enrolling on first sign-in with a code sent to the account email. The older Identity build keeps working on 0088 (it writes platform challenges only and the defaults fit) (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §2, §5, §9) |
| `database/migrations/0089_session_facility_selection.sql` | `auth.session_facility_selection` keeps the facility a staff sign-in selected with `POST /auth/facility`, one row per session family, so a reload or refresh reports it instead of the primary facility (ADR-046). It is only the default the session reports: every facility-scoped request still carries `X-Facility-ID`. Its guard admits a row only for the root session of a staff sign-in of the same account that still has a live session and an active membership of that account at an active facility (the membership, migration-hold, staff, organization and facility conditions of `CurrentStaffContextService`; account status is checked earlier by `verify()`), and refuses DELETE. The role bootstrap grants `SELECT`, `INSERT` and `UPDATE` to the Identity runtime only. A new table: no existing row or grant changes. Creating its four foreign keys takes `SHARE ROW EXCLUSIVE` on `auth.sessions`, `auth.accounts`, `identity.facilities` and `identity.staff_facility_memberships` until its transaction commits (DDL only, so briefly): sign-ins, refreshes, sign-outs and workforce changes wait for it, and it waits for in-flight writes to those tables within the runner's 5 s lock timeout, after which 0089 fails without applying and can be re-run. Apply 0089 and the bootstrap before deploying the Identity API that reads it: without the table every staff `GET /auth/session` answers `503`, every staff refresh answers `200` with `facilitySelection: 'unavailable'` (so the portal asks where the user works), and `POST /auth/facility` fails. The bootstrap fails on a database without 0089, so run it after the migrations. The previous Identity API ignores the table. Written as `0080` in D-Eminence/hid-system#47 and ported after 0088 (D-Eminence/hid-system#73, ADR-046) (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §2, §3, §5, §9) |
| `database/migrations/0090_ehr_retraction_integrity.sql` | EHR retraction integrity (BRANCH:launch/ehr-retraction-integrity; 0085 to 0089 belong to other changes). Adds `ehr.vitals.status` (`final` by default, or `entered_in_error`; a constant default, so no row is rewritten or versioned) and six `SECURITY INVOKER` trigger guards with a pinned `search_path`: `ehr.require_retraction_permission()` refuses cancelling or retracting an encounter (`42501 ENCOUNTER_RETRACTION_NOT_PERMITTED`) unless the writing membership holds the write permission of every kind of record the close changes (`auth.membership_has_permission`); `ehr.keep_closed_encounter()` refuses any update of a cancelled or entered-in-error encounter (`55000 ENCOUNTER_NOT_OPEN`); `ehr.keep_closed_order()` refuses any update of a completed, cancelled or entered-in-error prescription or lab request except completed to `entered_in_error` alone (`55000 PRESCRIPTION_FINAL` / `LAB_REQUEST_FINAL`) and status changes outside the order transitions (`55000 INVALID_*_TRANSITION`); the replaced `ehr.keep_recorded_vital()` also allows a final vital to be entered in error and then refuses any change (`55000 VITAL_ENTERED_IN_ERROR`); `ehr.require_final_vital()` refuses a correction row of a vital entered in error (`55000 VITAL_ENTERED_IN_ERROR`, reading the vital `FOR SHARE`); and `ehr.keep_retracted_document()` refuses any update of a document entered in error (`55000 DOCUMENT_ENTERED_IN_ERROR`). `runtime-grants.sql` grants `hid_ehr_runtime` `EXECUTE` on `auth.membership_has_permission`: run the role bootstrap right after the migration, or a doctor's retraction of an encounter that holds records fails with `403 ACCESS_DENIED` (nothing written). Takes `ACCESS EXCLUSIVE` on `ehr.vitals` (catalog change and a validating scan, no rewrite) and `SHARE ROW EXCLUSIVE` on `ehr.encounters`, `ehr.prescriptions`, `ehr.lab_requests`, `ehr.vital_corrections` and `ehr.documents`, each within the 5 s lock timeout. Forward-only; changes no row. Deploy the EHR API of this change right after it (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §5, §9; `DATABASE.md`, "EHR retraction integrity (0090)") |
| `database/runtime-grants.sql` | Idempotent least-privilege runtime roles. Runs as a superuser or as the non-superuser administrator that created the roles (RDS); checks the roles' attributes instead of re-asserting them (§6) |
| `database/runtime-login-assertions.sql` and `scripts/verify-runtime-logins.mjs` | `npm run db:verify-logins`: checks each runtime credential's own LOGIN, connected with that credential's URL (§6) |
| `scripts/apply-migrations.mjs` | Ordered checksummed plan/dry-run/apply |
| `scripts/stage-legacy-identity.mjs` | Read-only repeatable source snapshot or deterministic offline fixture; restricted per-row hash evidence and sealed staging ledger |
| `scripts/promote-legacy-identity.mjs` | Explicit dependency ordering, UUID/HID preservation, encryption/HMAC, holds and conflict evidence; refuses, before any write, staged memberships that would give one staff identity two active memberships at one facility, or one beside a membership the target already holds (N5, `membership-duplicates.mjs`) |
| `scripts/reconcile-legacy-identity.mjs` | Independent destination read-back, counts, decryption and checksums |
| `scripts/verify-legacy-migration.mjs` | Offline determinism, preservation, idempotency and blocking-contract verification |
| `scripts/rekey-patient-contact-lookups.mjs` | Dry-run-default, conflict-checked canonical contact lookup rekey with an atomic completion marker |
| `scripts/import-legacy-nin-crosswalk.mjs` | Dry-run-default import of a complete, attested exact/absent legacy NIN source inventory; never asserts QoreID verification |
| `test/fixtures/legacy-identity.sample.json` | Synthetic account/profile/patient rehearsal with fixed UUID/HID |

The migration ledger is physically under EHR for the current repository
checkpoint; that does not make EHR the owner of Identity, Notification, or
other service schemas.

## 3. Separation of duties and inputs

Use different credentials for:

- read-only HID 1.0 database extraction;
- target migration/schema administration;
- each of the nine non-owner runtime LOGINs;
- scanner callback authority; and
- backup/restore operations.

The migration environment requires only the inputs for the selected step:

```text
LEGACY_DATABASE_URL                       # real source staging only
MIGRATION_FIXTURE_PATH                    # offline rehearsal instead of source URL
DATABASE_URL                              # target migrator; not required for fixture --dry-run
MIGRATION_OPERATOR
MIGRATION_SNAPSHOT_ID
MIGRATION_RUN_ID                          # fresh per stage attempt; successful stage output is required for promote/reconcile
MIGRATION_FIELD_ENCRYPTION_KEY_B64
MIGRATION_LOOKUP_HMAC_KEY_B64
MIGRATION_FIELD_KEY_REFERENCE
MIGRATION_FACILITY_TIMEZONES_JSON
MIGRATION_BATCH_SIZE                      # optional, 10..5000
CONTACT_LOOKUP_HMAC_KEY_B64               # same 32-byte key as the Identity runtime
NIN_LOOKUP_HMAC_KEY_B64                   # same 32-byte key as the Identity runtime
NIN_ENCRYPTION_KEY_B64                    # rekey of pending public enrollment contacts
OTP_HMAC_KEY_B64                          # verify the old public OTP recipient HMAC
LEGACY_NIN_ATTESTATION_PATH               # restricted, operator-reviewed JSON input; no repository copy
DATABASE_SSL=true
DATABASE_SSL_ROOT_CERT_BASE64
LEGACY_DATABASE_SSL=true
LEGACY_DATABASE_SSL_ROOT_CERT_BASE64      # when source CA is not system-trusted
```

`MIGRATION_FIXTURE_PATH` and `LEGACY_DATABASE_URL` are mutually exclusive.
Production TLS must verify the approved trust chain. Secrets must not enter
files, shell history, screenshots, tickets, application logs, or reconciliation
payloads.

### Canonical contact and legacy NIN reconciliation order

After legacy promotion is independently reconciled, run the contact rekey dry
run with an operator-approved evidence label in `MIGRATION_SNAPSHOT_ID`, the
operator, and the same contact/NIN/OTP keys used by Identity. The label is
recorded for operational traceability; the command establishes completeness by
locking and validating every current legacy patient and prior public enrollment,
rather than treating the label itself as database proof. It decrypts every legacy patient
contact and every existing public enrollment contact, verifies each old lookup
or OTP recipient HMAC, detects canonical contact conflicts, and rolls back.
Review the counts before running the same command with `--apply`. The apply
command commits all lookup changes and its completion marker together.

```bash
npm --prefix services/ehr-api run migration:rekey-contacts
npm --prefix services/ehr-api run migration:rekey-contacts -- --apply
```

Prepare one access-controlled JSON attestation per verified legacy migration
run. It must identify the exact `runId`, `sourceSnapshot`,
`sourceChecksumSha256`, `evidenceReference`, `attestedBy`, and UTC `attestedAt`.
Its `patients` array must cover **every** staged patient in that run. Each
patient entry contains its preserved `patientId`, a source
`evidenceReference`, and either `ninStatus: "exact"` with an independently
attested complete 11-digit `nin`, or `ninStatus: "absent"` with no `nin` field.
An absent claim is rejected when the staged source has any deprecated NIN
field; obtain exact source evidence or hold reconciliation instead. The importer
checks source UUID/account/HID preservation, prior governed NIN ownership,
duplicate NINs, and inventory completeness. It stores only the keyed HMAC,
attestation metadata, and source row checksum. Exact source association does
**not** grant `NIN_VERIFIED`; only later authoritative QoreID proof can do so.

```bash
npm --prefix services/ehr-api run migration:import-nin-crosswalk
npm --prefix services/ehr-api run migration:import-nin-crosswalk -- --apply
```

Both commands default to dry run. Public new-patient enrollment remains closed
while a legacy run is actively staged, a promoted patient is unreconciled or
lacks a complete attested NIN inventory, and while old contact lookups lack the applied rekey
marker. An installation with no migrated patients or stale contact rows needs
no fictitious import. Terminal failed/blocked attempts remain immutable evidence
but do not permanently poison a later complete verified inventory. Distinct verified migration runs can be attested separately;
overlapping patient inventories require explicit governance before reimport.
These repository commands and disposable rehearsals do not establish live
migration readiness or authorize cutover.

## 4. Offline rehearsal

Install locked dependencies and run:

```bash
npm --prefix services/ehr-api run migration:verify
MIGRATION_FIXTURE_PATH=test/fixtures/legacy-identity.sample.json \
  npm --prefix services/ehr-api run migration:stage:dry-run
```

The fixture verifier must produce the same sorted entity counts and checksum on
repeated runs, preserve its patient UUID/HID, demonstrate idempotent mapping,
and confirm reconciliation/conflict rules. It contains no real credentials or
patients. This rehearsal proves deterministic tooling, not live source schema
compatibility.

## 5. Pre-migration gates

Before a real source read:

- name operators/approvers and approve the change/data-processing window;
- rotate/revoke any previously exposed Vercel/Supabase/provider credentials;
- capture an immutable source snapshot/PITR point and prove isolated restore;
- validate the exact live source tables, columns, hash formats, object metadata,
  counts, and timezone mappings against the extraction contract;
- provision private PostgreSQL 16 with TLS, encryption, backups, logs and
  deletion controls;
- verify with `npm run db:verify-logins` (§6), connected with each runtime
  credential's own URL, that no runtime LOGIN is the migration administrator
  or the RDS master, owns or has an owner's privileges on any application
  object, has superuser, `CREATEROLE`, `CREATEDB`, `REPLICATION` or
  `BYPASSRLS`, or has any membership but its aggregate role;
- approve the purpose-of-use vocabulary, consent/deny precedence and RLS
  tests. Migration `0082` seeds only `direct-care` (active), and keeps any
  row already present as it is; list the codes before and after it (release
  checklist P10). Operators still approve, and insert by a reviewed change,
  `emergency` (only once `break_glass_enabled` is set to its intended launch
  state, because the code makes break-glass usable at once; break-glass is off
  at launch by owner default, so `emergency` stays absent) and
  `healthcare-operations` (with the OCR purpose-of-use decision). Retire a
  code with `active = false`, never by deleting it;
- establish private object export/import paths and checksum inventory; and
- select a final-write strategy: bounded maintenance window, or separately
  reviewed CDC into restricted staging with a known final LSN.

Any source-contract mismatch blocks execution. Change the tooling and repeat
rehearsal; never patch an already-applied migration checksum.

## 6. Target schema and roles

On RDS no role is a PostgreSQL superuser. The migration administrator is a
deployment-only LOGIN, `NOSUPERUSER NOBYPASSRLS CREATEROLE`, created by the RDS
master (`hid_platform_bootstrap`) with `CREATE` on the target database, and it
owns every schema and object the migrations create. No runtime LOGIN may be
it, be a member of it, or hold `BYPASSRLS`, and the release does not rely on
the owner bypassing row-level security (release checklist P8).

### 6.1 Migrations

A database that has not applied 0015 needs one temporary privilege. 0015 sets
`plpgsql.variable_conflict` on `ocr.claim_worker_job`, a parameter with
superuser context, which a non-superuser may set only with
`SET ON PARAMETER` on it. 0083 moves that option into the function body, after
which no function needs the privilege. As the RDS master, immediately before
the migration run:

```sql
grant set on parameter plpgsql.variable_conflict to <migration administrator>;
```

From `services/ehr-api`, as the migration administrator:

```bash
npm run db:plan
npm run db:dry-run   # runs 0015 too before rolling back, so it needs the grant as well
npm run db:migrate
```

Once the ledger shows `0083` applied, as the RDS master:

```sql
revoke set on parameter plpgsql.variable_conflict from <migration administrator>;
select has_parameter_privilege('<migration administrator>',
  'plpgsql.variable_conflict', 'SET');  -- false
```

Without the grant `db:migrate` stops at 0015 with `permission denied to set
parameter "plpgsql.variable_conflict"`. 0001 to 0014 stay committed, and a
rerun after the grant continues from 0015. A database that already applied
0015 needs no grant for 0083. The grant is cluster-wide; keep it only for the
run, and record both statements and the check in the release evidence.

Whether the RDS master may grant this privilege is unverified. If RDS refuses
it, do not work around it with a superuser-like role or `BYPASSRLS`. Stop and
take a reviewed ledger exception instead: no staging or production database
has applied 0015, so one reviewed change can replace 0015's statement with the
in-body option and update its pinned checksum in
`scripts/verify-migration-ledger.mjs` and `release/config/components.json`,
after which local and development databases are rebuilt. That exception is
not made in this repository.

### 6.2 Role bootstrap

As the same migration administrator. It must be the role that creates the HID
group roles, because every membership grant needs `ADMIN OPTION` on them:

```bash
export DATABASE_ADMIN_URL=<migration administrator URL>
npm run db:bootstrap
npm run db:verify-roles
```

Run it only with `npm run db:bootstrap`, which sends `runtime-grants.sql` as
one transaction (with `psql`, only as `psql -1 -v ON_ERROR_STOP=1 -f`): its
temporary memberships below must never outlive or leave that transaction. The
bootstrap may run again at any time. A run that transfers a function to its
technical owner leaves that owner an `EXECUTE` entry on it, which the next
run's `REVOKE ALL` removes; from then on a run changes nothing. It creates
each role with its attributes and then checks them. It refuses a HID group
role with `SUPERUSER`, `BYPASSRLS` or `REPLICATION`, and a runner that is
neither a superuser nor holds `ADMIN OPTION` on every HID role; neither can
happen to roles this administrator created. Inside its own transaction it
holds `SET` and `INHERIT` membership in the three technical owners
(`hid_event_delivery_commands`, `hid_ocr_queue_metrics`,
`hid_platform_control_reader`), and each of them holds `CREATE` on one schema
only around its function transfer; it revokes both before it commits.
PostgreSQL 16 records, for a non-superuser that creates a role, an `ADMIN
OPTION`-only membership granted by the bootstrap superuser. It carries no
privilege and no `SET ROLE`, and the administrator cannot revoke it.
`db:verify-roles` allows that row on a technical owner only when its member is
the role running the check, so run `db:verify-roles` as the same
administrator; any other membership in a technical owner, `ADMIN OPTION` alone
included, fails it.

Locks. Every lock the bootstrap takes is held until its transaction commits.
`lock_timeout` (5 s) and `statement_timeout` (120 s) apply to the bootstrap's
own statements only. The run that first creates
`platform_controls_definer_read` (the first run of
D-Eminence/hid-system#63, or one after the policy was removed or
changed) takes an `ACCESS EXCLUSIVE` lock on `platform.control_settings`,
before any other table lock. Until it commits, every control read of the
Identity, EHR and Outreach guards, that is every request that is not a
platform administrator's, waits behind it, within the services' 15 s statement
timeout; locally, on a synthetic database, the rest of the transaction took
about 0.1 s. Run that first bootstrap with traffic low. Because that lock
comes first, a break-glass activation (which reads the controls and then
writes `identity.outbox_events` in one transaction) waits for the bootstrap or
the bootstrap waits for it; they do not deadlock. A later run finds the policy
and takes no lock on `platform.control_settings`. Every run still recreates
the `ocr.jobs` and outbox delivery policies under brief `ACCESS EXCLUSIVE`
locks, as before.

A later migration that replaces a function a technical role owns
(`ocr.worker_queue_metrics()`, the `integration` delivery commands,
`platform.control_enabled(text)`) needs that owner's privileges. Run it, as
the bootstrap does, with a temporary membership in that role, or change the
function's owner back and rerun the bootstrap afterwards.

### 6.3 Runtime LOGINs

Create one LOGIN per runtime credential, `LOGIN NOSUPERUSER NOBYPASSRLS
NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`, granted exactly its aggregate
role, and store its URL in that service's secret (`url`; the EHR scanner
pool's in `scannerUrl`). Only a role with `ADMIN OPTION` on the aggregate may
grant it, which in PostgreSQL 16 is the migration administrator that created
the HID roles; the RDS master is refused (`permission denied to grant role`).
Create the LOGINs as that administrator too, so one role does both steps. If
the master creates a LOGIN, the administrator still issues the grant.

| Credential | Variable for `db:verify-logins` | Aggregate role |
| --- | --- | --- |
| Identity API | `DATABASE_LOGIN_URL_IDENTITY_API` | `hid_identity_api_runtime` |
| EHR API | `DATABASE_LOGIN_URL_EHR_API` | `hid_ehr_api_runtime` |
| EHR scanner pool (`WORKLOAD_DATABASE_URL`) | `DATABASE_LOGIN_URL_EHR_API_SCANNER` | `hid_document_scanner` |
| Lab API | `DATABASE_LOGIN_URL_LAB_API` | `hid_lab_api_runtime` |
| Pharmacy API | `DATABASE_LOGIN_URL_PHARMACY_API` | `hid_pharmacy_api_runtime` |
| OCR API | `DATABASE_LOGIN_URL_OCR_API` | `hid_ocr_api_runtime` |
| OCR worker | `DATABASE_LOGIN_URL_OCR_WORKER` | `hid_ocr_worker` |
| Outreach API | `DATABASE_LOGIN_URL_OUTREACH_API` | `hid_outreach_api_runtime` |
| Event dispatcher | `DATABASE_LOGIN_URL_EVENT_DISPATCHER` | `hid_event_dispatcher` |
| Notification worker | `DATABASE_LOGIN_URL_NOTIFICATION_WORKER` | `hid_notification_worker` |

Then verify every credential, each over its own connection:

```bash
export DATABASE_SSL=true DATABASE_SSL_ROOT_CERT_BASE64=<RDS CA bundle, base64>
export DATABASE_FORBIDDEN_LOGINS=hid_platform_bootstrap,<migration administrator>
export DATABASE_LOGIN_URL_IDENTITY_API=...   # and the other nine
npm run db:verify-logins
```

It must report `"status": "passed"` with ten verified credentials. It refuses
a login that authenticates as one role and runs as another, is named in
`DATABASE_FORBIDDEN_LOGINS`, has `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`,
`CREATEDB` or `REPLICATION`, has a direct membership other than its aggregate
(inherited, without `ADMIN OPTION`) or reaches any role its aggregate does not,
has the privileges of the owner of the database or of any application schema,
relation or function, is named by a direct grant, or may create objects; and
two credentials that share a login. It prints role names only, never a URL or
password. Run it again after every credential rotation (`--partial` with only
the rotated credentials). Clear the variables afterwards. In production every
service that connects to the database also refuses to start over a superuser,
`BYPASSRLS` or owner connection.

Confirm the candidate ledger reaches `0090`, no unexpected constraint remains
unvalidated, and each runtime LOGIN can perform only its intended commands.
After the legacy import, record (read-only, counts only, no identifiers) how
many imported patient accounts have `email_verified_at` null and no verified
enrollment phone: after 0086 their OTP recovery and activation send no code,
so each needs another approved activation route before it can sign in
(`PHASE_4_STAGE_5_RELEASE_READINESS.md` §10). Also count (read-only,
counts only) the imported staff accounts with an active membership and no
email address: after the Identity build of 0088 a staff account enrols its
authenticator only with a code sent to its email, so each of them is refused
(`409 MFA_ENROLLMENT_PROOF_UNAVAILABLE`) until it is given one.

After 0088, list (read-only) the accounts whose active authenticator was
enrolled at platform sign-in and that also hold an active staff membership.
Each is refused staff sign-in (`403 STAFF_MFA_FACTOR_UNPROVEN`) until a
two-person MFA reset, after which the administrator enrols at staff sign-in
and uses that factor for both. Before 0088 every factor is listed this way,
since only platform sign-in enrolled factors.

```sql
begin transaction isolation level repeatable read read only;
set local row_security = off;
select factor.account_id, factor.activated_at
  from auth.mfa_factors factor
 where factor.status = 'active' and factor.enrollment_proof is null
   and exists (select 1 from identity.staff_facility_memberships membership
                where membership.account_id = factor.account_id and membership.active)
 order by factor.activated_at;
rollback;
```

Before clinical roles are enabled, and after every bulk provisioning, check
(read-only) that every account with an active clinical membership has an
authenticator enrolled at staff sign-in; the release checklist (P22) makes
this a gate. An account without one is as strong as its mailbox until it
enrols (`INTERFACE_CONTRACT.md`, staff sign-in):

```sql
begin transaction isolation level repeatable read read only;
set local row_security = off;
select membership.facility_id, membership.app_role, count(*) as accounts_without_staff_factor
  from identity.staff_facility_memberships membership
 where membership.active
   and membership.app_role in ('doctor', 'clinician', 'nurse', 'lab', 'pharmacist')
   and not exists (select 1 from auth.mfa_factors factor
                    where factor.account_id = membership.account_id and factor.status = 'active'
                      and factor.enrollment_proof is not null)
 group by membership.facility_id, membership.app_role
 order by membership.facility_id, membership.app_role;
rollback;
```

Review, at least daily during the launch period, the staff enrolments by
emailed code that followed a password recovery of the same account. Each is
one where control of the mailbox alone was enough; confirm it with the staff
member through a channel other than that mailbox:

```sql
begin transaction isolation level repeatable read read only;
set local row_security = off;
select enrolled.actor_account_id as account_id, enrolled.occurred_at as enrolled_at,
       max(recovered.occurred_at) as recovered_at
  from audit.events enrolled
  join audit.events recovered
    on recovered.actor_account_id = enrolled.actor_account_id
   and recovered.action = 'auth.otp.recovery.completed'
   and recovered.occurred_at < enrolled.occurred_at
 where enrolled.action = 'auth.staff.mfa.enrolled'
   and enrolled.details->>'proofMethod' = 'email_code'
   and enrolled.occurred_at > now() - interval '7 days'
   and not exists (select 1 from audit.events earlier
                    where earlier.actor_account_id = enrolled.actor_account_id
                      and earlier.action = 'auth.staff.mfa.enrolled'
                      and earlier.occurred_at between recovered.occurred_at and enrolled.occurred_at
                      and earlier.event_id <> enrolled.event_id)
 group by enrolled.actor_account_id, enrolled.occurred_at
 order by enrolled.occurred_at desc;
rollback;
```
The one-shot ECS migration task defaults to `--plan`; never turn it into a
service or place administrator credentials in a steady-state task. The
migration image also carries `scripts/bootstrap-database-roles.mjs` and
`scripts/verify-runtime-logins.mjs`.

## 7. Stage a controlled snapshot

First perform a real-source dry run with a read-only credential:

```bash
npm --prefix services/ehr-api run migration:stage:dry-run
```

After counts/checksums match the approved inventory, stage:

```bash
npm --prefix services/ehr-api run migration:stage
```

The source transaction is `REPEATABLE READ READ ONLY`. It excludes recovery,
confirmation and session tokens; stores canonical per-row SHA-256; preserves
timestamps/UUIDs; and seals the resulting category counts/checksum. A
failed/running stage run is never resumed: retain it as restricted evidence and
create a fresh `MIGRATION_RUN_ID` from a new controlled source snapshot.

Staging contains PHI and password hashes. Restrict the `migration` schema to the
migrator, retain encryption, and disable payload query logging.

## 8. Promote

Set the returned `MIGRATION_RUN_ID` plus encryption/HMAC/timezone inputs, then:

```bash
npm --prefix services/ehr-api run migration:promote
```

Promotion is dependency-ordered and idempotent only for identical target
content. It preserves account suspension, canonical UUID/HID, source mappings,
and timestamps. Contact/identifier/quarantine values use AES-256-GCM and
independent lookup HMACs. Missing facility or purpose creates a hold. Legacy
clinical fragments remain quarantined, are not EHR records, and cannot be made
visible by merely clearing a flag.

Legacy scan evidence not bound to an exact immutable object version and SHA-256
cannot authorize document access. Create new governed evidence only after the
exact bytes are independently verified.

## 9. Object migration

For every legacy profile photo, medical record, or other governed object:

1. inventory the source bucket/key/version/size/checksum without making it public;
2. export through an approved private read-only channel;
3. verify bytes against the source checksum before upload;
4. assign an opaque destination key containing no patient/facility/clinical value;
5. upload with the target document KMS policy and record destination version ID;
6. verify destination size/checksum by read-back;
7. record retry count, terminal error, and source-to-destination mapping in
   restricted migration evidence; and
8. reconcile every inventory row, including zero-byte/missing/duplicate cases.

Batching and retries must be bounded and idempotent. A provider timeout or
unknown result does not justify a duplicate copy. Keep source access read-only
until retention and rollback governance approves decommissioning.

## 10. Reconcile

```bash
npm --prefix services/ehr-api run migration:reconcile
```

The reconciler independently reads target rows, decrypts governed fields,
compares counts/checksums/relationships, and writes per-entity evidence. All
blocking conflicts must be zero. Resolve mismatches in source or target through
an approved correction and create a new run; never edit staged payloads or mark
an unequal row successful.

Also reconcile object inventory count, byte total, checksum, version ID,
missing/unreadable rows, and malware/scan binding. Sample UUID/HID/account
continuity with synthetic or authorized minimum-necessary identifiers.

## 11. Controlled single-writer cutover

1. Announce and enter the approved identity-write window.
2. Freeze source identity/object mutations or capture the final CDC boundary.
3. Record the final snapshot/LSN and source/object counts.
4. Stage the final delta/snapshot.
5. Promote and reconcile to zero blocking conflicts.
6. Verify the ledger at `0090`, runtime grants (`db:verify-roles`) and logins
   (`db:verify-logins`), RLS and purpose/deny behavior, and list the
   purpose-of-use codes (release checklist P10). After `0084`, confirm the
   launch platform controls and the launch module set (P11) and review the
   open records of closed encounters (P12). Record the count of imported
   patient accounts without a verified contact (§6). Run I4 before applying 0087
   to a database the promotion has written: 0087 refuses duplicate active
   memberships at one facility. After `0090`, the role bootstrap must have
   run: it grants the EHR runtime the permission decision the encounter
   retraction guard uses.
7. Prove local/OIDC login, exact bcrypt upgrade, session revocation and OTP
   fallback against migrated accounts. A migrated staff account signs in with
   its password, then enrols an authenticator with the code emailed to it
   (MFA-1, 0088); no staff session is issued on the password alone. A
   platform administrator who also holds a staff membership enrols at staff
   sign-in (platform enrolment answers `409
   MFA_ENROLLMENT_STAFF_SIGN_IN_REQUIRED`); one whose factor predates 0088 is
   reset first (§6).
8. Prove patient UUID/HID links from EHR/Lab/Pharmacy/OCR/Outreach remain exact.
9. Prove private object read/version/checksum/scanner behavior.
10. Start minimum target services and run synthetic smoke tests.
11. Move traffic progressively while monitoring auth, duplicate identity,
    errors and audit evidence.
12. Keep the source read-only and retain the rollback/PITR decision point.
13. Obtain data, security, clinical and operations sign-off.
14. Decommission source access only under a separate approved retention plan.

Do not take an initial snapshot, allow untracked writes, and later cut traffic.
Do not accept a session token merely because it came from a legacy cookie. Do
not create a new patient when an OTP-authenticated contact maps to an existing
identity but matching is ambiguous; route it to governed resolution.

## 12. Rollback and evidence

Before target write traffic, rollback can restore source authority after
disposing of the failed target run under policy. After target writes begin,
rollback requires a named reconciliation strategy for those writes; a blind
DNS reversal is unsafe. Database migrations are forward-only—use additive
correction or approved PITR, never edit/down-run applied migrations.

Retain the approved snapshot/LSN, tool Git SHA, migration checksums, operators,
start/end times, counts/checksums, conflict/resolution evidence, object mapping
and version totals, role tests, auth/OTP results, smoke tests, rollback decision,
and sign-offs. Evidence must be access-controlled and redact tokens, OTP values,
password hashes, encryption keys, raw contacts and clinical payloads.

Until these live gates pass, the correct classification is:
`IMPLEMENTED, EXTERNAL ENVIRONMENT VERIFICATION PENDING`.

## Additive staging recovery correction after the approved 0028 baseline

The staging implementation candidate adds `0029_governed_otp_recovery.sql`.
Previously issued OTP challenges lack the new account token-version binding
and cannot complete recovery after this migration; users request a fresh code.
This is deliberate fail-closed credential invalidation, not account or patient
migration. Existing accounts, patient UUIDs/HIDs, passwords and clinical rows
are not rewritten by the migration itself.

Use the current reviewed migration ledger and release contract for the final
candidate schema; do not label the changed tree as approved source
`a709e643a731b444f7cb775b2b16fe28164146a7`. Preserve all prior applied migration
hashes and run the isolated full schema/role/OTP/backup/restore rehearsal before
an actual staging migration. No generic UPDATE on accounts is granted to solve
recovery. Database rollback remains forward correction or an approved isolated
restore with write reconciliation. Provider delivery, staging TLS/roles and
restored application login remain external acceptance evidence.
