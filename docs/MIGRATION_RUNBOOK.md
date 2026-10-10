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
| `database/runtime-grants.sql` | Idempotent least-privilege runtime roles |
| `scripts/apply-migrations.mjs` | Ordered checksummed plan/dry-run/apply |
| `scripts/stage-legacy-identity.mjs` | Read-only repeatable source snapshot or deterministic offline fixture; restricted per-row hash evidence and sealed staging ledger |
| `scripts/promote-legacy-identity.mjs` | Explicit dependency ordering, UUID/HID preservation, encryption/HMAC, holds and conflict evidence |
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
- verify no runtime LOGIN owns schemas or has superuser, `CREATEROLE`,
  `BYPASSRLS`, or migration inheritance;
- approve purpose-of-use vocabulary, consent/deny precedence and RLS tests;
- establish private object export/import paths and checksum inventory; and
- select a final-write strategy: bounded maintenance window, or separately
  reviewed CDC into restricted staging with a known final LSN.

Any source-contract mismatch blocks execution. Change the tooling and repeat
rehearsal; never patch an already-applied migration checksum.

## 6. Target schema and roles

From `services/ehr-api` with the migration administrator:

```bash
npm run db:plan
npm run db:dry-run
npm run db:migrate
npm run db:bootstrap
npm run db:verify-roles
```

Confirm the candidate ledger reaches `0078`, no unexpected constraint remains
unvalidated, and each runtime LOGIN can perform only its intended commands.
The one-shot ECS migration task defaults to `--plan`; never turn it into a
service or place administrator credentials in a steady-state task.

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
6. Verify `0078`, runtime grants, RLS and purpose/deny behavior.
7. Prove local/OIDC login, exact bcrypt upgrade, session revocation and OTP
   fallback against migrated accounts.
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
