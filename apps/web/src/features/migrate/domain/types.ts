import type {
  MIGRATION_CASE_STATES,
  MIGRATION_DOCUMENT_CATEGORIES,
  MIGRATION_FIELD_MAPPING_STATUSES,
  MIGRATION_IDENTIFIER_TYPES,
  MIGRATION_IMPORT_STATUSES,
  MIGRATION_MATCH_BANDS,
  MIGRATION_MATCH_STATUSES,
  MIGRATION_PROJECT_STATUSES,
  MIGRATION_QA_STATUSES,
  MIGRATION_ROLES,
  MIGRATION_VALIDATION_STATUSES,
} from './constants'

type ValueOf<T extends readonly string[]> = T[number]

export type MigrationRole = ValueOf<typeof MIGRATION_ROLES>
export type MigrationCaseState = ValueOf<typeof MIGRATION_CASE_STATES>
export type MigrationProjectStatus = ValueOf<typeof MIGRATION_PROJECT_STATUSES>
export type MigrationDocumentCategory = ValueOf<typeof MIGRATION_DOCUMENT_CATEGORIES>
export type MigrationIdentifierType = ValueOf<typeof MIGRATION_IDENTIFIER_TYPES>
export type MigrationValidationStatus = ValueOf<typeof MIGRATION_VALIDATION_STATUSES>
export type MigrationQaStatus = ValueOf<typeof MIGRATION_QA_STATUSES>
export type MigrationMatchStatus = ValueOf<typeof MIGRATION_MATCH_STATUSES>
export type MigrationImportStatus = ValueOf<typeof MIGRATION_IMPORT_STATUSES>
export type MigrationFieldMappingStatus = ValueOf<typeof MIGRATION_FIELD_MAPPING_STATUSES>
export type MigrationMatchBand = ValueOf<typeof MIGRATION_MATCH_BANDS>

export type Uuid = string
export type IsoDate = string
export type IsoDateTime = string
export type ConfidenceScore = number

export type MigrationCapability =
  | 'project.read'
  | 'project.manage'
  | 'member.manage'
  | 'assignment.manage'
  | 'capture.write'
  | 'processing.retry'
  | 'validation.decide'
  | 'qa.decide'
  | 'match.decide'
  | 'match.decide_assigned'
  | 'match.decide_escalated'
  | 'import.execute'
  | 'report.read'
  | 'report.read_own'
  | 'report.read_qa'
  | 'audit.read'

export interface MigrationProjectAccess {
  id: Uuid
  project_reference: string
  name: string
  organization_id: Uuid
  organization_name: string
  facility_id: Uuid
  facility_name: string
  migration_role: MigrationRole
  capabilities: MigrationCapability[]
}

export interface MigrationAccessContext {
  staff_account_id: Uuid
  projects: MigrationProjectAccess[]
  creation_scopes?: MigrationCreationScope[]
}

export interface MigrationCreationScope {
  organization_id: Uuid
  organization_name: string
  facility_id: Uuid
  facility_name: string
  staff_membership_id: Uuid
}

export interface MigrationProjectRecord {
  id: Uuid
  organization_id: Uuid
  facility_id: Uuid
  project_reference: string
  name: string
  description: string | null
  record_location: string | null
  estimated_patients: number
  estimated_folders: number
  start_date: IsoDate | null
  expected_completion: IsoDate | null
  status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'
  active: boolean
  created_at: IsoDateTime
  updated_at: IsoDateTime
}

export interface MigrationProjectMemberRecord {
  id: Uuid
  migration_project_id: Uuid
  staff_account_id: Uuid
  staff_membership_id: Uuid
  migration_role: MigrationRole
  active: boolean
  starts_at: IsoDateTime
  ends_at: IsoDateTime | null
  staff: { full_name: string; email: string; role: string } | null
}

export interface MigrationWorkAssignmentRecord {
  id: Uuid
  migration_project_id: Uuid
  migration_batch_id: Uuid | null
  assigned_to_project_member_id: Uuid
  title: string
  description: string | null
  priority: number
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  due_at: IsoDateTime | null
  completed_at: IsoDateTime | null
  created_at: IsoDateTime
  updated_at: IsoDateTime
}

export interface MigrationBatchRecord {
  id: Uuid
  migration_project_id: Uuid
  batch_reference: string
  name: string
  description: string | null
  estimated_folders: number
  status: 'draft' | 'open' | 'closed' | 'cancelled'
  created_at: IsoDateTime
  updated_at: IsoDateTime
}

export interface MigrationTenantScope {
  organization_id: Uuid
  facility_id: Uuid
  branch_id: Uuid | null
  department_id: Uuid | null
}

export interface MigrationSourceIdentifier {
  identifier_type: MigrationIdentifierType
  raw_value: string
  normalized_value: string
  issuer: string | null
  organization_id: Uuid
  facility_id: Uuid | null
}

export interface MigrationPatientCandidate {
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  full_name: string | null
  dob: IsoDate | null
  gender: string | null
  phone_e164: string | null
  email: string | null
  address: string | null
  nin_last4: string | null
  source_identifiers: MigrationSourceIdentifier[]
}

export interface MigrationSourceLineage {
  source_facility_id: Uuid
  source_department_id: Uuid | null
  source_folder_number: string
  source_document_ids: Uuid[]
  scan_batch_id: Uuid
  scanned_by_staff_account_id: Uuid
  scanned_at: IsoDateTime
}

export interface MigrationQualitySummary {
  page_count: number
  failed_page_count: number
  mean_image_quality_score: number | null
  mean_ocr_confidence: ConfidenceScore | null
  mean_classification_confidence: ConfidenceScore | null
  low_confidence_field_count: number
}

export interface MigrationCaseDecisionState {
  validation_status: MigrationValidationStatus
  validated_by_staff_account_id: Uuid | null
  validated_at: IsoDateTime | null
  qa_status: MigrationQaStatus
  qa_reviewed_by_staff_account_id: Uuid | null
  qa_reviewed_at: IsoDateTime | null
  match_status: MigrationMatchStatus
  matched_patient_id: Uuid | null
  match_decided_by_staff_account_id: Uuid | null
  match_decided_at: IsoDateTime | null
  import_status: MigrationImportStatus
  import_job_id: Uuid | null
  imported_at: IsoDateTime | null
}

/**
 * The aggregate root for one physical patient folder moving through HID Migrate.
 *
 * A Migration Case is staging/workflow data. It never replaces `hid_patients`,
 * `hid_medical_records`, or another canonical HID clinical entity.
 */
export interface MigrationCase {
  id: Uuid
  case_reference: string
  migration_project_id: Uuid
  migration_batch_id: Uuid
  tenant_scope: MigrationTenantScope
  state: MigrationCaseState
  version: number
  source: MigrationSourceLineage
  patient_candidate: MigrationPatientCandidate
  quality: MigrationQualitySummary
  decisions: MigrationCaseDecisionState
  assigned_to_staff_account_id: Uuid | null
  created_at: IsoDateTime
  updated_at: IsoDateTime
}

export interface MigrationCaseTransition {
  from_state: MigrationCaseState
  to_state: MigrationCaseState
  occurred_at: IsoDateTime
  actor_staff_account_id: Uuid | null
  reason: string | null
  correlation_id: Uuid
}

export interface MigrationFieldMapping {
  source_field: string
  detected_value: string
  target_hid_field: string
  status: MigrationFieldMappingStatus
}

export interface MigrationProject {
  id: Uuid
  project_reference: string
  name: string
  organization_id: Uuid
  facility_id: Uuid
  branch_id: Uuid | null
  department_id: Uuid | null
  record_location: string
  estimated_patients: number
  estimated_folders: number
  pages_scanned: number
  patients_processed: number
  validation_progress: number
  import_progress: number
  assigned_team: number
  start_date: IsoDate | null
  expected_completion: IsoDate | null
  status: MigrationProjectStatus
}

export interface MigrationMatchCandidate {
  patient_id: Uuid
  hid_code: string
  band: MigrationMatchBand
  score: ConfidenceScore
  matching_fields: string[]
  conflicting_fields: string[]
}

export interface MigrationMetadata {
  migration_project_id: Uuid
  migration_batch_id: Uuid
  scan_batch_id: Uuid
  source_folder_number: string
  source_document_id: Uuid
  ocr_confidence: ConfidenceScore | null
  classification_confidence: ConfidenceScore | null
  validation_status: MigrationValidationStatus
  validated_by: Uuid | null
  qa_status: MigrationQaStatus
  import_status: MigrationImportStatus
  imported_at: IsoDateTime | null
  source_facility_id: Uuid
  source_department_id: Uuid | null
}
