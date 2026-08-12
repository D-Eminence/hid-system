export const MIGRATION_ROLES = [
  'migration_administrator',
  'project_manager',
  'medical_records_officer',
  'scanner_operator',
  'validation_officer',
  'qa_reviewer',
] as const

export const MIGRATION_CASE_STATES = [
  'draft',
  'capturing',
  'uploaded',
  'image_processing',
  'ocr_queued',
  'ocr_processing',
  'ocr_complete',
  'extraction_processing',
  'needs_validation',
  'validating',
  'validated',
  'qa_required',
  'qa_reviewing',
  'qa_approved',
  'matching',
  'match_review',
  'ready_for_import',
  'importing',
  'verification',
  'imported',
  'completed',
  'upload_failed',
  'processing_failed',
  'needs_rescan',
  'validation_rejected',
  'qa_returned',
  'match_blocked',
  'import_failed',
  'correction_required',
  'cancelled',
] as const

export const MIGRATION_PROJECT_STATUSES = [
  'draft',
  'active',
  'paused',
  'processing',
  'awaiting_review',
  'ready_for_import',
  'importing',
  'completed',
  'cancelled',
] as const

export const MIGRATION_DOCUMENT_CATEGORIES = [
  'consultation',
  'laboratory_result',
  'prescription',
  'admission',
  'discharge_summary',
  'radiology_report',
  'referral',
  'insurance_document',
  'hmo_document',
  'billing_document',
  'consent',
  'attachment',
  'other',
  'unclassified',
] as const

export const MIGRATION_IDENTIFIER_TYPES = [
  'hid_code',
  'hospital_number',
  'patient_number',
  'legacy_folder_number',
  'card_number',
  'file_number',
  'registration_number',
] as const

export const MIGRATION_VALIDATION_STATUSES = [
  'not_required',
  'pending',
  'in_review',
  'approved',
  'rejected',
  'returned',
] as const

export const MIGRATION_QA_STATUSES = [
  'not_required',
  'required',
  'in_review',
  'approved',
  'returned',
  'escalated',
] as const

export const MIGRATION_MATCH_STATUSES = [
  'not_started',
  'candidates_ready',
  'review_required',
  'linked_existing',
  'create_new',
  'review_later',
  'blocked',
] as const

export const MIGRATION_IMPORT_STATUSES = [
  'not_ready',
  'ready',
  'queued',
  'importing',
  'verifying',
  'imported',
  'failed',
  'correction_required',
] as const

export const MIGRATION_FIELD_MAPPING_STATUSES = [
  'mapped',
  'needs_review',
  'unmapped',
] as const

export const MIGRATION_MATCH_BANDS = [
  'exact',
  'strong',
  'possible',
  'weak',
  'no_match',
] as const
