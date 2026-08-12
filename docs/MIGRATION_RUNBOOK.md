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
| `database/runtime-grants.sql` | Idempotent least-privilege runtime roles |
| `scripts/apply-migrations.mjs` | Ordered checksummed plan/dry-run/apply |
| `scripts/stage-legacy-identity.mjs` | Read-only repeatable source snapshot or deterministic offline fixture; hash-only staging comparisons |
| `scripts/promote-legacy-identity.mjs` | Explicit dependency ordering, UUID/HID preservation, encryption/HMAC, holds and conflict evidence |
| `scripts/reconcile-legacy-identity.mjs` | Independent destination read-back, counts, decryption and checksums |
| `scripts/verify-legacy-migration.mjs` | Offline determinism, preservation, idempotency and blocking-contract verification |
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
MIGRATION_RUN_ID                          # stage output; required for promote/reconcile
MIGRATION_FIELD_ENCRYPTION_KEY_B64
MIGRATION_LOOKUP_HMAC_KEY_B64
MIGRATION_FIELD_KEY_REFERENCE
MIGRATION_FACILITY_TIMEZONES_JSON
MIGRATION_BATCH_SIZE                      # optional, 10..5000
DATABASE_SSL=true
DATABASE_SSL_ROOT_CERT_BASE64
LEGACY_DATABASE_SSL=true
LEGACY_DATABASE_SSL_ROOT_CERT_BASE64      # when source CA is not system-trusted
```

`MIGRATION_FIXTURE_PATH` and `LEGACY_DATABASE_URL` are mutually exclusive.
Production TLS must verify the approved trust chain. Secrets must not enter
files, shell history, screenshots, tickets, application logs, or reconciliation
payloads.

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

Confirm the ledger reaches `0028`, no unexpected constraint remains
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
timestamps/UUIDs; and fails if resumed content differs. A failed/running run
may resume only with the same controlled snapshot ID and content.

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
6. Verify `0028`, runtime grants, RLS and purpose/deny behavior.
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
correction or approved PITR, never edit/down-run `0001`–`0028`.

Retain the approved snapshot/LSN, tool Git SHA, migration checksums, operators,
start/end times, counts/checksums, conflict/resolution evidence, object mapping
and version totals, role tests, auth/OTP results, smoke tests, rollback decision,
and sign-offs. Evidence must be access-controlled and redact tokens, OTP values,
password hashes, encryption keys, raw contacts and clinical payloads.

Until these live gates pass, the correct classification is:
`IMPLEMENTED, EXTERNAL ENVIRONMENT VERIFICATION PENDING`.
