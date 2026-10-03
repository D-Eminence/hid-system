# Staging customer-data access and preservation

Supported pricing/control mapping and browser integration update, 2026-10-04:
see `SUPPORTED_CONFIGURATION_MIGRATION.md`. Local implementation is complete;
actual source export/import, accepted artifacts and live reconciliation remain.

Implemented locally on 2026-10-03. This is section 1 of the workspace tracking
file. Migration `0062_customer_history_access.sql` follows the unchanged 63-file
ledger. Neither this document nor the local tests perform an AWS migration.

## Access contracts

- EHR self, staff imported-history and emergency summaries add
  `importedHealthProfile: {content, updatedAt} | null`. Content contains only
  blood group, genotype, allergies, chronic conditions, current medications and
  medical notes. Original patient timestamps and authenticated quarantine seals
  are verified before import; source absence is never inferred from missing columns.
- `GET /api/v1/ehr/me/imported-attachments/:fileId/download`: active patient
  session, fresh Identity self authorization and patient RLS.
- `GET /api/v1/ehr/patients/:patientId/imported-attachments/:fileId/download`:
  `ehr.note.read` and `ehr.document.read`, fresh membership/consent authorization,
  selected facility and `direct-care` purpose. RLS remains authoritative.
- Downloads require an immutable bucket/key/version/SHA/size binding and the
  latest matching clean scan. Missing, infected and error scans deny access. A
  newer failed result supersedes an earlier clean result; older reports cannot
  be reinserted as approvals. S3 independently confirms the exact version,
  checksum, size and KMS encryption before a 60-second URL is signed. Durable
  audit commits first. URLs use attachment disposition and private/no-store.
- `GET /api/v1/identity/me/imported-notifications?limit=50&offset=0`: recipient
  comes from the freshly checked account/session, never a caller account or a
  notification's patient. Bounded pages make the whole history accessible.
  `POST .../:notificationId/read` adds a separate immutable read receipt;
  original read timestamps stay intact. Patient and EHR screens expose this
  history. No delivery, event, subscriber or OTP replay is created.
- `GET /api/v1/admin/imported-configuration` returns `{items}`. Each category
  requires both platform-admin access and its pricing/control/role/integration
  capability. The admin preserved-settings page shows an allowlisted view;
  unrestricted source JSON remains in owner-only storage. Reading is audited.

## Exact source and import tooling

The September fixture has 16 categories. It lacks the historical notification
and configuration rows. Code cannot recover those rows by assuming values.

Run the **read-only** operator export from the workspace root:

```powershell
.\infra\terraform\scripts\export-staging-customer-source.ps1 -CertificatePath 'C:\Users\User\Downloads\prod-ca-2021.crt'
```

The Supabase URL is entered privately. A verified CA is required; source reads
use a single repeatable-read transaction. The wrapper creates a directory whose
Windows ACL permits only the operator, saves source JSON there and prints only
counts and seals. Keep this source out of Git and chat. If currently populated
tables exceed the reviewed 29, or core rows differ from the reconciled parent,
stop and reconcile that delta through the approved process. Do not substitute
the new checksum or replay the old import to force a match.

The additive import modules default to rollback and accept `--apply` only in
staging. They use serializable transactions, verified parent/category seals,
exact-repeat checks and owner-only INSERT privileges. Runtime roles cannot
import, rewrite history, read quarantine, or grant permissions.

| Script under `services/ehr-api/scripts/` | Protected inputs |
| --- | --- |
| `import-staging-health-profiles.mjs` | Parent ID/checksum, original field key/reference and operator |
| `import-staging-attachment-evidence.mjs` | Parent seal, original fixture SHA, pinned manifest version/SHA and scan-report file/SHA; independently rereads each S3 version |
| `import-staging-customer-history.mjs` | Full source file/SHA and source checksum, verified parent; optional reviewed configuration map file/SHA |
| `verify-customer-nin-coverage.mjs` | Source file/SHA; optional source-owner attestation file |

All import commands also need the managed staging database connection with
verified TLS. Secrets are injected through protected environment inputs, never
CLI arguments. The existing ECS wrapper now supports `HealthProfiles`,
`AttachmentEvidence` and `CustomerHistory`, alongside the two existing operations.
Its accepted image/source/rehearsal checks remain required. `Apply` additionally
requires the same operation, source fixture, input-reference bytes, rehearsal
evidence and task revision as a successful `DryRun`.

### Execute through the AWS migration runner

1. Obtain the reviewed clean source commit, accepted migration image digest and
   populated staging-copy rehearsal for that artifact set. The existing migration
   Dockerfile copies all scripts, so these additions use its migration target.
2. Export the complete source using the protected export wrapper above. If
   attachment access is included, obtain genuine scan evidence with its wrapper.
3. Package each external input using workspace
   `infra/terraform/scripts/prepare-staging-customer-inputs.ps1`:
   choose `-Operation CustomerHistory` and its source `metadata.json`, or
   `-Operation AttachmentEvidence` and its scan `metadata.json`. Supply the
   reviewed `-ApplicationRoot` and `-ExpectedSourceCommit`; a reviewed
   `-ConfigurationMapPath` is optional for CustomerHistory.
4. That wrapper uploads a KMS-encrypted package to the existing restricted source
   bucket under `migration-inputs/`, rereads its returned version, verifies exact
   bytes and saves a metadata-only input reference. Source/map/scan bytes are
   bound separately inside the package. No customer payload enters ECS overrides.
5. Apply the reviewed Terraform policy/task update before running these operations.
   The promotion task receives accepted input/document bucket and KMS references.
   Its permissions allow version reads only from the input and medical-file
   prefixes. S3-mediated decrypt supports both bucket-key and object contexts;
   see [AWS SSE-KMS encryption context](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html#encryption-context).
6. Run `run-staging-additions-task.ps1` with `-Operation HealthProfiles`,
   `AttachmentEvidence` or `CustomerHistory`, first `-Mode DryRun`, then
   `-Mode Apply`. Supply the existing accepted source/image/rehearsal/artifact-set
   arguments. AttachmentEvidence and CustomerHistory also require the prepared
   `-InputMetadataPath`; HealthProfiles uses the already reconciled parent and
   preserved field key. Run MedicalHistory before AttachmentEvidence.
7. Inspect aggregate task results and reconcile actual source/target counts,
   associations and hashes. A successful synthetic test is not live evidence.

The task verifies the pinned S3 version, accepted KMS key, byte count and SHA,
then reads/decode inputs in memory with bounded sizes. It writes no customer
source files to its read-only filesystem. Wrong operation/parent/fixture rejects
before import. Each imported attachment is independently reread from its exact
document version and verified before binding evidence. Input or task changes
after DryRun require another DryRun. Existing import rollback, no-overwrite and
repeat checks remain authoritative.

## Genuine attachment scan

Install the approved ClamAV distribution and update official signatures using
its documented installation/update procedure. The runner requires complete-scan
limits/alerts and signatures updated within 24 hours. It captures the executable
hash, engine/signature versions and private output hashes; it never assigns a
clean result from file-copy evidence. See [ClamAV scanning](https://docs.clamav.net/manual/Usage/Scanning.html)
and [signature management](https://docs.clamav.net/manual/Usage/SignatureManagement.html).

```powershell
.\infra\terraform\scripts\scan-staging-medical-files.ps1 -ClamScanPath 'C:\path\to\approved\clamscan.exe'
```

The wrapper checks the expected AWS account, retrieves the pinned private
staging manifest, verifies its original fixture association, scans all four
exact object versions in an operator-private folder and saves a report. Any
failed/infected/incomplete scan exits unsuccessfully. No file bytes or scanner
output are printed. Import successful evidence using the attachment module;
rescan if evidence/signatures are stale. Synthetic test reports are never live
scan evidence.

## Configuration decisions and limits

All source products/prices, billing, controls, staff policies and AI routes are
preserved as exact immutable JSON, including source relationships, dates,
amounts, currencies and subscription/trial settings. Unsupported semantics are
explicitly `retained-pending-activation`, not completed operational mappings.

A reviewed map uses `hid.customer-configuration-map/v1`, exact source checksum,
approver, existing authorized platform actor and an entry for every source
configuration row. Each entry binds its category/source key/source SHA and
reason. Default action is explicit `retain`; it performs no native changes.

Supported operational actions:

- `product`: choose one of the seven native product slugs, bind the exact target
  JSON SHA, and map supported name/status fields. Unsupported product names and
  active-but-private semantics reject. Remaining subscription fields stay saved.
- `price`: reviewed source-product mapping must match the target product;
  context, amount, currency, visibility, billing period, unit and active flag
  must fit the native contract. Bind the exact existing target JSON SHA.
- `control`: list supported source controls and provide a target SHA for each.
  Six native controls exist. Hospital portal maps explicitly to provider portal;
  unsupported signup/HID Migrate flags remain retained. Empty/unknown mappings reject.

Only an existing actor with the respective manage capability can activate
native fields. Changes create native immutable catalog/control audit events.
Append-only mapping evidence is separate from source preservation, so a later
review can follow an initial archive. A changed target or previous decision
rejects instead of overwriting. The admin status `mapped-target-fields` refers
only to those approved fields, not every retained source property.

Actual missing developer decisions/contracts (see
`DATABASE_CONFIGURATION_MAPPING_REQUIRED.md`):

1. Eight source products versus seven current product slugs; complete visibility
   and subscription mapping needs the real source export and product-owner decisions.
2. Native billing execution does not implement the legacy grace/fee/proration
   contract. Exact settings are retained/readable; activating that billing behavior
   needs an approved contract, not new invented defaults.
3. Legacy signup/HID Migrate switches lack matching enforced native controls.
4. Five legacy staff-policy flags do not establish an approved native permission
   crosswalk. This import never grants roles/permissions or broadens access.
5. Eight legacy AI routes do not authorize Bedrock models or processing modes.
   Model/strategy approval and corresponding runtime wiring remain required.

## Authentication, outreach and NIN disposition

The 74 legacy authentication challenges are preserved only in the restricted
source archive with disposition `expired-no-replay`. No challenge, OTP hash,
verification token or session is inserted into active Auth tables. Customers
request a fresh challenge through the current governed flow. Existing protected
backups remain retained; this change neither deletes source rows nor invents a
retention period.

All seven invalid outreach categories have `excluded-invalid-outreach`
dispositions. Rows stay in the restricted evidence archive; operational Outreach
tables receive zero rows. Canonical and clinical categories must match the
already reconciled parent. All 29 table counts/checksums/dispositions are saved;
unreviewed additional populated tables block execution.

NIN coverage checks require 123 unique patients and both source columns. Paired
presence or explicit paired absence is counted; missing/partial evidence rejects.
The September source has zero present and 123 explicitly absent. This does not
prove absence in another source or in a later update. Optional attestation schema
`hid.nin-coverage-attestation/v1` binds source SHA, patient count, source owner/date,
`sources_checked`, and `alternate_source_has_additional_nins: false`. A positive
alternate source requires an approved crosswalk, not an absence attestation.
The final cutover source/delta remains a separate requirement.

## Validation and current execution status

Focused API/UI/source tests and disposable PostgreSQL 16 checks exercise clean
64-file install, 34-to-64 upgrade, rollback, preserved old hashes, immutable
profiles/bindings/history, wrong-key/object denial, all notification pages,
recipient isolation, source archive/configuration repeat checks, subsequent
reviewed native mapping, native audit, and rejection of changed targets. Runtime
grants and RLS deny other patients/facilities; a newer infected report blocks a
prior clean result. Test data and scan reports are invented.

Live execution remains pending: this tool session has no configured AWS profile,
remaining source rows are not exported and genuine file scans are not obtained.
The accepted ECS wrapper/input transport is implemented locally and tested;
its image and Terraform update have not been deployed. Operational configuration
conversion remains dependent on the developer's missing target contract.
Migrate NIN as stored in the agreed source; investigating additional systems is
additional scope. Review, recovery, populated staging-copy rehearsal, approved
artifacts and section-2 deployment gates apply before updating AWS staging.
Preserve these open items in the tracker.
