# Supported configuration migration

Implemented locally on 2026-10-04 against developer commit c4b5445. Actual
source export, target capture, approved artifact publication, import and live
reconciliation are pending. AWS access was confirmed using hid-softbridge in
account 659225405023 on 2026-10-04. No complete protected source export has been
prepared in this workspace.

## What the tools do

- Capture native product, price and control coordinates and hashes from one
  read-only PostgreSQL snapshot. No customer values or credentials are logged.
- Prepare an exact mapping from the sealed 29-table export. Products require
  an existing supported slug; prices require that product and an existing
  context. Duplicate coordinates, absent targets and unsupported values stay
  retained. No slug, price, currency or permission is guessed.
- Map six controls, including `hospital_portal_enabled` to
  `provider_portal_enabled`. Extra product fields, four signup/Migrate flags,
  billing settings, staff policies and AI settings remain in the exact archive.
- Save a draft that the importer rejects until its reviewer and existing
  authorized actor are recorded. Activation checks source/parent seals, target
  hashes and actor permissions, writes audit events, and respects the existing
  dry-run/rehearsal/release gates. Changed targets are never overwritten.

## Operator sequence

Run from the Health identity workspace. Use the accepted source SHA, migration
image, release artifact hash and populated rehearsal evidence from the release
process. These are required inputs, not values supplied by this document.

1. Export the complete source using
   `infra/terraform/scripts/export-staging-customer-source.ps1 -CertificatePath`
   and the downloaded Supabase certificate. The wrapper prompts privately for
   the connection URL and writes `source.json` plus `metadata.json` in a private
   directory. Existing customer values must not be pasted into chat or Git.
2. Reuse the accepted arguments for `run-staging-additions-task.ps1` with
   `-Operation ConfigurationBaseline -Mode DryRun`. This runs inside the private
   VPC and saves `tmp/staging-configuration-baseline.latest.json`. Apply mode is
   rejected; the database transaction is read-only. The target schema and the
   verified parent must exist. If the receipt is not yet visible, inspect the
   task stream and retry collection; a missing receipt does not authorize import.
3. Prepare the draft beside the private export:

   ```powershell
   $sourceMetadata = 'PATH TO THE PRIVATE metadata.json'
   $sourceInfo = Get-Content -LiteralPath $sourceMetadata -Raw | ConvertFrom-Json
   $draft = Join-Path (Split-Path -Parent $sourceInfo.protected_source_path) 'configuration-map.draft.json'
   node .\integration\hid-application\services\ehr-api\scripts\prepare-customer-configuration-map.mjs $sourceMetadata .\tmp\staging-configuration-baseline.latest.json $draft
   ```

   Inspect the draft locally. Every source configuration row has a disposition;
   `summary` counts rows, while a control row may map several supported keys.
   Retained entries remain preserved and require no invented behavior.
4. Record the actual reviewer and existing authorized admin subject as the two
   optional final arguments to the same preparation command, using a new output
   file such as `configuration-map.approved.json` in the private export directory.
   This produces `hid.customer-configuration-map/v1`. The named actor needs
   `platform.pricing.manage` and/or `platform.control.manage` for the selected
   actions. Recording a subject never grants those permissions. The tool refuses
   to overwrite an existing file. If source or targets changed, regenerate and
   inspect new decisions before proceeding.
5. Package CustomerHistory using `prepare-staging-customer-inputs.ps1` and
   `-ConfigurationMapPath` pointing to the approved map. Run the existing
   CustomerHistory DryRun/Apply procedure using that exact pinned package and
   accepted release. Reconcile all real counts, values, associations and target
   dispositions. A successful draft or synthetic rehearsal is not live completion.

## Browser connections

The public pricing page uses `GET /api/v1/commercial/pricing`. The separate
admin website has a permission-gated `/controls` page using
`GET/POST /api/v1/admin/controls`; the older web admin controls use the same
contract. The six supported values retain their individual versions. A change
reason and `If-Match` are sent only for changed controls through cookie/CSRF
transport. Reader permissions offer no write action.

The API accepts individual control changes, so saving multiple changes is
sequential. A denial or conflict stops subsequent writes; the screen reports
any partial save and requires a reload. Unsupported switches show unavailable.
Full billing, legacy staff-policy editing and dynamic AI routing still need the
developer's runtime implementation or an explicit release disposition.

## Checks

- 20 customer input/history/mapping tests passed.
- Six pricing/control browser tests and 23 existing browser/care tests passed.
- All 42 admin tests passed, including reader, write-version and conflict cases.
- Shared client, web and admin builds passed.
- PowerShell parser and mocked wrapper tests passed for five import operations,
  baseline collection and rejection of a baseline Apply operation.
- Disposable PostgreSQL 16 clean install and 34-to-64 upgrade passed, including
  generated configuration mapping rollback and earlier import/isolation checks.

No AWS mutation, live data import or image publication was performed here.
