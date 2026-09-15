# Synthetic patient journeys with NIN disabled

MetaMap/NIN verification is deferred until after staging. Preserve its existing
implementation and keep `NIN_PROVIDER_MODE=deferred` for staging. NIN verification and new
NIN-based enrollment are outside current staging acceptance. Existing canonical
patients can use login, profile, records, history and recovery without a NIN.

MetaMap NIN integration is prepared but deferred. Activation requires version-specific provider contract confirmation and authorized trial/test access.

The local [fixture generator](../scripts/prepare-staging-journey-fixture.mjs)
prepares input for the existing migration importer. It does not connect to a
database, resolve credentials, call providers, import records or authorize a
deployment. It creates one synthetic patient, a separate synthetic clinician
account, an organization, a facility and the clinician's facility membership.
The patient receives no workforce membership or role.

## Prepare controlled input locally

Use [staging-journey-input.template.json](../release/config/staging-journey-input.template.json)
as the operator input shape. Keep its working copy directly under the already
ignored `release/local/` directory. That directory must be owned by the operator,
be canonical without symlinks, and have mode `0700`; the input file must be `0600`.
The generator rejects other locations or permissions and never changes existing
permissions. Keep controlled inbox addresses in the private local input and fixture
to limit unnecessary disclosure. Passwords, OTPs and credentials must stay out of
chat, Git, shell arguments and public evidence.

Populate `patient_email` and `staff_email` through a local editor with two distinct,
controlled test inboxes. Set `controlled_test_recipients_confirmed` only after
confirming their use for the staging test. No passwords or provider secrets belong
in this file. Account and region are fixed to staging account `659225405023` and
`eu-west-1`. The RDS instance identifier and database name may remain `null` until
discovery supplies actual values. Supplying them does not verify the target.

Run from the repository root with absolute paths and a new output directory:

```sh
node scripts/prepare-staging-journey-fixture.mjs \
  /home/l2e/hid-system/release/local/staging-journey-input.json \
  /home/l2e/hid-system/release/local/staging-journey-reviewed
```

The directory must not already exist. It receives `fixture.json` and
`manifest.json`, both `0600`, inside a new `0700` directory. UUIDs and the synthetic
HID are generated once and retained in those files. Repeated invocation refuses
overwrite; use the same reviewed files for retries. Creating another directory
creates another identity set, not an idempotent retry of the previous import.

The manifest and console output contain IDs, counts, the fixture digest and
unverified target expectations, without emails or credentials. They say
`PREPARED_LOCAL_ONLY`; import and deployment authorization remain false. Keep the
fixture private even though it contains synthetic names: the inboxes are real
controlled contacts. Review the checksum and identifiers before any import.

## Use the existing staging-bound operator path

The generic migration scripts accept a database URL and do not independently
prove that it belongs to staging. Before supplying migration credentials, verify
the existing approved staging plan and admitted application release, AWS account
and region, actual RDS instance and endpoint, database name, verified TLS root,
and the exact migration-only operator identity. Confirm those against discovery
and a database identity read; a manifest label or database name alone is
insufficient. Retain the pre-import backup/restore reference. Production remains
locked. Do not run a fixture against an unverified destination.

Use the existing deployment-only migration task/session. Keep its credentials
separate from runtime LOGINs and preserve RLS and grant checks. Apply the accepted
schema ledger, bootstrap roles, and verify zero pending migrations and runtime
permissions through the commands in [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md).

For the data phase, obtain these inputs through that operator session:

| Input | Source |
| --- | --- |
| `MIGRATION_FIXTURE_PATH` | Absolute path to the exact reviewed `fixture.json`; leave `LEGACY_DATABASE_URL` unset |
| `MIGRATION_RUN_ID`, `MIGRATION_SNAPSHOT_ID` | The generated manifest's `migration.run_id` and `migration.snapshot_id`; retain them across retries |
| `MIGRATION_OPERATOR` | The actual accountable operator identity, not a fictional approver |
| `MIGRATION_FACILITY_TIMEZONES_JSON` | The manifest's `migration.facility_timezones` object, mapping the exact synthetic facility UUID to `Africa/Lagos` |
| Database URL, TLS configuration and migration field encryption/HMAC keys | Existing secure, account-bound migration configuration; never reuse public test vectors or write secrets into this fixture |

With those reviewed inputs established, the existing command sequence is:

```sh
npm --prefix services/ehr-api run migration:stage:dry-run
npm --prefix services/ehr-api run migration:stage
npm --prefix services/ehr-api run migration:promote
npm --prefix services/ehr-api run migration:reconcile
```

Review the dry-run counts/checksum and destination UUID, HID and email collision
checks before promotion. The importer retains its historical `legacy_identity`
source label; the manifest explicitly records that this fixture is synthetic and
is not an actual legacy export. Preserve that distinction in operator evidence.
No NIN identifiers, NIN verification claims, sessions, passwords, verified
contacts, clinical notes, access requests, consent grants or imported audit events
are generated. Both accounts import as `pending_reset` with no password. The
synthetic clinician's active/verified workforce fixture state exercises the doctor
role; it does not assert that a real person's professional credentials were
verified. Review that synthetic facility-scoped assignment explicitly.

## Run normal application journeys

1. Complete the real email OTP recovery/password setup separately for the patient
   and clinician inboxes. Use normal Turnstile, expiry, resend/rate limits and
   atomic OTP completion. Confirm wrong, expired and replayed OTPs are rejected.
   Keep OTP values and passwords out of evidence. Pending accounts must not log in.
2. Use patient login and verify the exact account/patient association, synthetic
   HID, profile, history, refresh and logout. Confirm host-only cookies, CSRF
   checks, account-disable/session-revocation behavior and empty workforce roles.
   NIN-disabled status must not become a login or self-read readiness gate.
3. Log in as the separate synthetic doctor and select the exact synthetic facility.
   Activate emergency access through the governed break-glass command with its
   required reason and emergency purpose. Read through the owning EHR route, then
   revoke/expire the grant and confirm further reads are denied. Review the
   recorded patient access history, audit and notification outcomes.
4. An empty records collection is valid for this fixture; verify the actual
   authenticated read and audit, not fabricated note content. Positive signed-note
   content remains a separate clinical-sample check unless normal clinical APIs
   can create it with current authorized purpose, consent and clinician attribution.
   The importer quarantines legacy notes and holds legacy grants; do not clear
   those controls or apply rollback-only SQL test fixtures as live seed data.

The local regression command is:

```sh
node --test scripts/tests/staging-journey-fixture.test.mjs
```

These tests also run the existing fixture source scanner in offline dry-run mode.
The disposable PostgreSQL rehearsal additionally exercises the real importer:

```sh
node scripts/tuf-staging-migration-rehearsal.mjs
```

It creates its own Unix-socket-only cluster under `/tmp` and applies the accepted
schema to a separate `hid_nin_deferred` database. The generated `.invalid` contacts
cannot deliver mail. The checks prove promotion and reconciliation, distinct
account and patient identifiers, absent passwords and NIN data, unverified
contacts, `pending_reset` accounts, no patient workforce authority, and the exact
synthetic clinician facility role. Pending recovery remains denied by the patient
runtime. The existing patient HTTP checks also run with NIN explicitly deferred
and its credentials absent; local-only Turnstile and notification test doubles
remain local-only. The rehearsal removes its cluster after completion and retains
its result in the printed evidence directory.

Local fixture validation does not prove staging import, OTP delivery, emergency
notification, application deployment or acceptance; record those only when their
actual checks complete.
