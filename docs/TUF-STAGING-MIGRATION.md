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
same host (`pg_config --bindir`), installed `services/ehr-api` dependencies,
and the checked-in migration ledger. The command accepts no database URL or
cloud mode. It creates a private temporary Unix-socket-only PostgreSQL cluster
with host connections rejected, uses public synthetic fixture vectors, and
stops/removes only its own temporary cluster. The new evidence directory is
never reused. Caller cloud/database credentials are not passed to child tools.

The executable covers:

1. Verify every immutable migration hash `0001`–`0028`; apply a transactional
   schema dry run and assert its objects rolled back; apply the real schema,
   bootstrap runtime roles, assert zero pending on rerun, and run the real
   rollback-only schema/RLS integration suite.
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

Evidence includes `evidence.json`, `commands.json`, `pre-migration.dump`, and
before/after count/checksum inventories. The local archive contains only
synthetic data; operational backups must never enter Git or public artifacts.
The evidence records source HEAD and whether the worktree was dirty. A dirty
local run is not evidence for an immutable release commit.

## Schema and import coverage

The destination schema is exactly `0028`. Empty-schema bootstrap is covered;
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
| Schema order | Source/destination versions, exact 28-file ledger and pending plan; dry-run outcome, execution order/times, zero pending afterward |
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
