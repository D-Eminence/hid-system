# HID Migrate canonical data dictionary

The executable source of truth is
[`domain/dataDictionary.ts`](./domain/dataDictionary.ts). This document records
the approved human-readable rules.

## Naming policy

- Database and API fields use the existing HID snake_case convention.
- TypeScript domain/read models retain those fields. View adapters may use
  camelCase only inside a component boundary.
- Reuse existing HID names exactly: `hid_code`, `dob`, `phone_e164`,
  `first_name`, `last_name`, `full_name`.
- A legacy hospital identifier is never an HID Number.
- Migration workflow data is separate from canonical Patient and Medical Record
  data.

| Display name | Frontend | API | Database | Entity | Type | Requirement | Example |
|---|---|---|---|---|---|---|---|
| Patient ID | `patientId` | `patient_id` | `patient_id` | Patient | UUID | System | `b68b…` |
| HID Number | `hidCode` | `hid_code` | `hid_code` | Patient | text | After identity creation | `HID-00018291` |
| First Name | `firstName` | `first_name` | `first_name` | Patient | text | Required | `Abdulrahman` |
| Middle Name | `middleName` | `middle_name` | `middle_name` | Patient extension | text | Optional | `Tunde` |
| Last Name | `lastName` | `last_name` | `last_name` | Patient | text | Required | `Bello` |
| Full Name | `fullName` | `full_name` | `full_name` | Patient | text | Required | `Abdulrahman Bello` |
| Date of Birth | `dob` | `dob` | `dob` | Patient | date | Optional | `1984-03-12` |
| Phone Number | `phoneE164` | `phone_e164` | `phone_e164` | Patient | text | Optional | `+2348030009920` |
| Hospital Number | `hospitalNumber` | `hospital_number` | `identifier_value` | PatientIdentifier | text | Optional | `H-220041` |
| Legacy Folder Number | `legacyFolderNumber` | `legacy_folder_number` | `identifier_value` | PatientIdentifier | text | Optional | `UI-04471` |
| Migration Case ID | `migrationCaseId` | `migration_case_id` | `id` | MigrationCase | UUID | System | `7b0f…` |
| Migration Project ID | `migrationProjectId` | `migration_project_id` | `migration_project_id` | MigrationCase | UUID | Required | `37a1…` |
| Migration Batch ID | `migrationBatchId` | `migration_batch_id` | `migration_batch_id` | MigrationCase | UUID | Required | `81bb…` |
| Scan Batch ID | `scanBatchId` | `scan_batch_id` | `scan_batch_id` | SourceLineage | UUID | Required | `67c8…` |
| Source Document ID | `sourceDocumentId` | `source_document_id` | `source_document_id` | MigrationDocument | UUID | Required | `05fc…` |
| OCR Confidence | `ocrConfidence` | `ocr_confidence` | `ocr_confidence` | OCR Result | decimal 0-1 | Optional | `0.962` |
| Validation Status | `validationStatus` | `validation_status` | `validation_status` | Case Decision | enum | Required | `approved` |
| QA Status | `qaStatus` | `qa_status` | `qa_status` | Case Decision | enum | Required | `required` |
| Match Status | `matchStatus` | `match_status` | `match_status` | Case Decision | enum | Required | `review_required` |
| Import Status | `importStatus` | `import_status` | `import_status` | Case Decision | enum | Required | `ready` |

## Canonical status families

Do not substitute one family for another:

- Case state: the end-to-end Migration Case lifecycle.
- Project status: aggregate project operation.
- Validation status: human validation decision.
- QA status: QA requirement and decision.
- Match status: patient identity decision.
- Import status: canonical write progress.

All values are defined in
[`domain/constants.ts`](./domain/constants.ts). Legal case transitions are defined
in [`domain/stateMachine.ts`](./domain/stateMachine.ts).

## Document categories

`consultation`, `laboratory_result`, `prescription`, `admission`,
`discharge_summary`, `radiology_report`, `referral`, `insurance_document`,
`hmo_document`, `billing_document`, `consent`, `attachment`, `other`,
`unclassified`.

Original scans, derived assets, OCR, structured candidates, validation history,
QA history and import lineage remain linked. Import mapping must be reviewed before
data is promoted into canonical HID entities.
