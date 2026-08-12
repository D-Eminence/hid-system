export type MigrationDataDictionaryEntry = {
  display_name: string
  frontend_property: string
  api_field: string
  database_field: string
  entity: string
  data_type: string
  required: 'yes' | 'no' | 'conditional' | 'system'
  example_value: string
  repository_alignment: string
}

export const MIGRATION_DATA_DICTIONARY: readonly MigrationDataDictionaryEntry[] = [
  { display_name:'Patient ID', frontend_property:'patientId', api_field:'patient_id', database_field:'patient_id', entity:'Patient', data_type:'UUID', required:'system', example_value:'b68b…', repository_alignment:'Existing internal patient key' },
  { display_name:'HID Number', frontend_property:'hidCode', api_field:'hid_code', database_field:'hid_code', entity:'Patient', data_type:'text', required:'conditional', example_value:'HID-00018291', repository_alignment:'Existing canonical HID identity field' },
  { display_name:'First Name', frontend_property:'firstName', api_field:'first_name', database_field:'first_name', entity:'Patient', data_type:'text', required:'yes', example_value:'Abdulrahman', repository_alignment:'Existing field' },
  { display_name:'Middle Name', frontend_property:'middleName', api_field:'middle_name', database_field:'middle_name', entity:'Patient', data_type:'text', required:'no', example_value:'Tunde', repository_alignment:'Proposed canonical Patient extension' },
  { display_name:'Last Name', frontend_property:'lastName', api_field:'last_name', database_field:'last_name', entity:'Patient', data_type:'text', required:'yes', example_value:'Bello', repository_alignment:'Existing field' },
  { display_name:'Full Name', frontend_property:'fullName', api_field:'full_name', database_field:'full_name', entity:'Patient', data_type:'text', required:'yes', example_value:'Abdulrahman Bello', repository_alignment:'Existing field' },
  { display_name:'Date of Birth', frontend_property:'dob', api_field:'dob', database_field:'dob', entity:'Patient', data_type:'date', required:'no', example_value:'1984-03-12', repository_alignment:'Existing field; do not rename date_of_birth' },
  { display_name:'Phone Number', frontend_property:'phoneE164', api_field:'phone_e164', database_field:'phone_e164', entity:'Patient', data_type:'text', required:'no', example_value:'+2348030009920', repository_alignment:'Existing normalized field' },
  { display_name:'Hospital Number', frontend_property:'hospitalNumber', api_field:'hospital_number', database_field:'identifier_value', entity:'PatientIdentifier', data_type:'text', required:'no', example_value:'H-220041', repository_alignment:'New tenant-qualified identifier type' },
  { display_name:'Legacy Folder Number', frontend_property:'legacyFolderNumber', api_field:'legacy_folder_number', database_field:'identifier_value', entity:'PatientIdentifier', data_type:'text', required:'no', example_value:'UI-04471', repository_alignment:'New tenant-qualified identifier type' },
  { display_name:'Migration Case ID', frontend_property:'migrationCaseId', api_field:'migration_case_id', database_field:'id', entity:'MigrationCase', data_type:'UUID', required:'system', example_value:'7b0f…', repository_alignment:'New migration-only aggregate key' },
  { display_name:'Migration Project ID', frontend_property:'migrationProjectId', api_field:'migration_project_id', database_field:'migration_project_id', entity:'MigrationCase', data_type:'UUID', required:'yes', example_value:'37a1…', repository_alignment:'Migration-only foreign key' },
  { display_name:'Migration Batch ID', frontend_property:'migrationBatchId', api_field:'migration_batch_id', database_field:'migration_batch_id', entity:'MigrationCase', data_type:'UUID', required:'yes', example_value:'81bb…', repository_alignment:'Migration-only foreign key' },
  { display_name:'Scan Batch ID', frontend_property:'scanBatchId', api_field:'scan_batch_id', database_field:'scan_batch_id', entity:'MigrationSourceLineage', data_type:'UUID', required:'yes', example_value:'67c8…', repository_alignment:'Distinct from migration batch and import job' },
  { display_name:'Source Document ID', frontend_property:'sourceDocumentId', api_field:'source_document_id', database_field:'source_document_id', entity:'MigrationDocument', data_type:'UUID', required:'yes', example_value:'05fc…', repository_alignment:'Preserves source lineage' },
  { display_name:'OCR Confidence', frontend_property:'ocrConfidence', api_field:'ocr_confidence', database_field:'ocr_confidence', entity:'MigrationOcrResult', data_type:'decimal 0..1', required:'no', example_value:'0.962', repository_alignment:'Migration-only processing metadata' },
  { display_name:'Validation Status', frontend_property:'validationStatus', api_field:'validation_status', database_field:'validation_status', entity:'MigrationCaseDecisionState', data_type:'enum', required:'yes', example_value:'approved', repository_alignment:'Uses canonical validation status, not case state' },
  { display_name:'Import Status', frontend_property:'importStatus', api_field:'import_status', database_field:'import_status', entity:'MigrationCaseDecisionState', data_type:'enum', required:'yes', example_value:'ready', repository_alignment:'Uses canonical import status, not case state' },
] as const
