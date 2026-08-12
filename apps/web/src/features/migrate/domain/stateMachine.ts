import { MIGRATION_CASE_STATES } from './constants'
import type { MigrationCaseState } from './types'

const transitions = {
  draft: ['capturing', 'cancelled'],
  capturing: ['uploaded', 'upload_failed', 'cancelled'],
  uploaded: ['image_processing', 'cancelled'],
  image_processing: ['ocr_queued', 'needs_rescan', 'processing_failed'],
  ocr_queued: ['ocr_processing', 'cancelled'],
  ocr_processing: ['ocr_complete', 'processing_failed', 'needs_rescan'],
  ocr_complete: ['extraction_processing', 'needs_validation'],
  extraction_processing: ['needs_validation', 'processing_failed'],
  needs_validation: ['validating', 'cancelled'],
  validating: ['validated', 'validation_rejected', 'needs_rescan'],
  validated: ['qa_required', 'matching'],
  qa_required: ['qa_reviewing'],
  qa_reviewing: ['qa_approved', 'qa_returned'],
  qa_approved: ['matching'],
  matching: ['match_review', 'match_blocked'],
  match_review: ['ready_for_import', 'match_blocked'],
  ready_for_import: ['importing', 'correction_required', 'cancelled'],
  importing: ['verification', 'import_failed'],
  verification: ['imported', 'import_failed', 'correction_required'],
  imported: ['completed', 'correction_required'],
  completed: ['correction_required'],
  upload_failed: ['capturing', 'cancelled'],
  processing_failed: ['image_processing', 'ocr_queued', 'extraction_processing', 'needs_rescan', 'cancelled'],
  needs_rescan: ['capturing', 'cancelled'],
  validation_rejected: ['needs_validation', 'needs_rescan', 'cancelled'],
  qa_returned: ['needs_validation', 'cancelled'],
  match_blocked: ['matching', 'match_review', 'cancelled'],
  import_failed: ['ready_for_import', 'importing', 'correction_required'],
  correction_required: ['needs_validation', 'matching', 'ready_for_import', 'cancelled'],
  cancelled: [],
} as const satisfies Record<MigrationCaseState, readonly MigrationCaseState[]>

export const MIGRATION_CASE_TRANSITIONS: Readonly<Record<MigrationCaseState, readonly MigrationCaseState[]>> = transitions

export function isMigrationCaseState(value: unknown): value is MigrationCaseState {
  return typeof value === 'string' && (MIGRATION_CASE_STATES as readonly string[]).includes(value)
}

export function allowedMigrationCaseTransitions(state: MigrationCaseState) {
  return MIGRATION_CASE_TRANSITIONS[state]
}

export function canTransitionMigrationCase(from: MigrationCaseState, to: MigrationCaseState) {
  return MIGRATION_CASE_TRANSITIONS[from].includes(to as never)
}

export function assertMigrationCaseTransition(from: MigrationCaseState, to: MigrationCaseState) {
  if (!canTransitionMigrationCase(from, to)) {
    throw new Error(`Invalid migration case transition: ${from} → ${to}`)
  }
}
