# Imported medical history

## Representation and access decision (2026-10-03)

The user authorized direct import of the protected September medical records.
Sixteen were patient-authored; one was provider-authored. There is no source
encounter/facility binding. Migration 0061 adds an EHR-owned imported-history
type rather than manufacturing visits, staff memberships or clinician signatures.
Identity retains ownership of patient/account IDs. Source UUIDs, complete original
JSON, checksums, source dates, authors, all versions and file relationships are
preserved; runtime serializers expose an explicit content/metadata allowlist.
Imported history is immutable, separate from newly signed encounter notes.

Patient self reads require fresh Identity self authorization and transaction-local
self proof. Staff reads require `ehr.note.read`, selected facility/membership,
purpose of use, fresh Identity `read_records` authorization, existing consent RLS
and durable audit before disclosure. Consent authorizes patient-wide imported
history at the selected facility; it does not assign that facility as its origin.
Emergency reads retain the existing fresh break-glass requirement. Runtime roles
receive SELECT only and cannot read migration quarantine or change history.

## API and screens

- Existing `GET /api/v1/ehr/me/records` and emergency summary add
  `importedRecords` (up to 50 original records, with all their preserved versions).
- `GET /api/v1/ehr/patients/:patientId/imported-records` returns
  `{ importedRecords, limit: 50 }`, using the same staff authentication, facility,
  permission and consent pipeline as other EHR reads.
- Record DTO: ID, origin (`patient-provided` / `provider-authored`), title,
  category, info type, created/updated times, currentVersionId, versions and files.
  Version DTO includes ID/number, authorship origin, original timestamp, record
  text, structuredData, notes and transcriptionText. File DTO contains ID,
  version link, original name/type/size/date and pending access status. Source
  storage paths, raw provenance, account IDs and quarantine data are omitted.
- Patient records/emergency screens and the EHR patient workspace display history
  independently of encounters. React renders content as text, never injected HTML.

Migration 0062 implements exact attachment binding, append-only scan evidence,
authorized short-lived downloads and preserved patient health profiles. The
live four-file scan/import remains pending. Unscanned files still display
`pending-safety-verification`; file-copy verification cannot approve a download.
The current contracts and operator tools are in
[CUSTOMER_DATA_COMPLETION.md](CUSTOMER_DATA_COMPLETION.md).

## Import execution

`services/ehr-api/scripts/import-staging-medical-records.mjs` defaults to rollback;
only `--apply` commits. It requires staging environment, managed database input,
`MIGRATION_PARENT_RUN_ID`, externally recorded
`MIGRATION_PARENT_SOURCE_CHECKSUM`, `MIGRATION_OPERATOR`, original
`MIGRATION_FIELD_KEY_REFERENCE` and original `MIGRATION_FIELD_ENCRYPTION_KEY_B64`.
Keys are injected from protected secrets, never command arguments or chat.

The existing operator helper `infra/terraform/scripts/run-staging-additions-task.ps1`
accepts `-Operation MedicalHistory` with `-Mode DryRun` or `Apply`. It retains the
clean approved source/image/artifact and populated-copy evidence gates. Medical
history has its own evidence filenames and Apply requires its matching successful
medical dry run; an identity/PIN dry run cannot approve the medical import. The
wrapper was parsed locally and has not been executed against AWS.

The serializable, advisory-locked transaction verifies the reconciled parent,
every source category/count/hash, original clinical quarantine AES-GCM payloads,
canonical patient/account provenance, all version/file bindings and target
equality. Changed targets reject without overwrite. Repeated apply produces one
receipt. Parent evidence/quarantine remains unchanged. No operational outreach
rows, new patients, visits, signatures or scan approvals are created.

Run only after migration 0061 and separate restricted runtime grants. Before live
AWS execution: Review/Correct, clean approved source/artifacts, current recovery
point and populated staging-copy rehearsal. The local synthetic PostgreSQL
rehearsal does not satisfy populated-copy acceptance. Do not replay the September
full importer. Use the additive operation against the verified parent.

Local validation entry points:

```text
node --test services/ehr-api/scripts/imported-medical-records.test.mjs
node services/ehr-api/scripts/test-staging-schema-upgrade.mjs
node services/ehr-api/scripts/verify-medical-import-source.mjs <protected-fixture> <metadata-manifest>
```

Protected fixture verification reports aggregates only and performs no database
write. The recorded fixture is a September snapshot, not a current final delta.
