import type { BadgeColor } from '../components/ui'
import type { MedicalRecord, MedicalRecordFile, RecordCategory } from '../types/database'
import { formatDate, formatDateTime } from './utils'

export interface UploadDraft {
  file_name: string
  file_type: string | null
  file_data_url: string
}

export interface RecordFormValues {
  title: string
  roleNote: string
  prescription: string
  labResult: string
  other: string
  transcriptionText: string
  uploads: UploadDraft[]
}

export interface RecordDateSection {
  key: string
  label: string
  records: MedicalRecord[]
}

export type HealthInfoFieldKind = 'text' | 'date' | 'select' | 'textarea' | 'chips' | 'cards'

export interface HealthInfoField {
  key: string
  label: string
  kind: HealthInfoFieldKind
  options?: { value: string; label: string }[]
  required?: boolean
}

export interface HealthInfoStep {
  question: string
  fieldKeys: string[]
}

export interface HealthInfoTypeConfig {
  id: string
  label: string
  description: string
  accent: BadgeColor
  fields: HealthInfoField[]
  steps: HealthInfoStep[]
  supportsAttachments: boolean
  requiresAttachment: boolean
  uploadFirst?: boolean
  isVoiceEntry?: boolean
}

export type HealthInfoValues = Record<string, string>

export interface RecordSourceBadgeInfo {
  label: string
  color: BadgeColor
}

export const HEALTH_INFO_TYPES: HealthInfoTypeConfig[] = [
  {
    id: 'condition',
    label: 'Condition / Diagnosis',
    description: 'A diagnosed condition, illness, or ongoing health issue.',
    accent: 'blue',
    supportsAttachments: true,
    requiresAttachment: false,
    fields: [
      { key: 'condition_name', label: 'Condition', kind: 'text', required: true },
      { key: 'date_diagnosed', label: 'Date diagnosed', kind: 'date' },
      { key: 'status', label: 'Status', kind: 'chips', options: [
        { value: 'active', label: 'Active' },
        { value: 'resolved', label: 'Resolved' },
        { value: 'unsure', label: 'Unsure' },
      ] },
      { key: 'facility', label: 'Facility', kind: 'text' },
      { key: 'provider', label: 'Provider', kind: 'text' },
    ],
    steps: [
      { question: 'What condition or diagnosis is this?', fieldKeys: ['condition_name'] },
      { question: "What's the status?", fieldKeys: ['status', 'date_diagnosed'] },
      { question: 'Where was it diagnosed?', fieldKeys: ['facility', 'provider'] },
    ],
  },
  {
    id: 'lab_result',
    label: 'Laboratory Result',
    description: 'Results from a lab test, such as blood work or imaging.',
    accent: 'green',
    supportsAttachments: true,
    requiresAttachment: false,
    uploadFirst: true,
    fields: [
      { key: 'test_name', label: 'Test name', kind: 'text', required: true },
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'laboratory_name', label: 'Laboratory name', kind: 'text' },
    ],
    steps: [
      { question: 'What test was this?', fieldKeys: ['test_name'] },
      { question: 'When and where was it done?', fieldKeys: ['date', 'laboratory_name'] },
    ],
  },
  {
    id: 'medication',
    label: 'Medication',
    description: 'A medication you are taking or have taken.',
    accent: 'amber',
    supportsAttachments: false,
    requiresAttachment: false,
    fields: [
      { key: 'medication_name', label: 'Medication name', kind: 'text', required: true },
      { key: 'dosage', label: 'Dosage', kind: 'text' },
      { key: 'frequency', label: 'Frequency', kind: 'text' },
      { key: 'start_date', label: 'Start date', kind: 'date' },
      { key: 'end_date', label: 'End date', kind: 'date' },
      { key: 'prescribing_provider', label: 'Prescribing provider', kind: 'text' },
    ],
    steps: [
      { question: 'What medication are you taking?', fieldKeys: ['medication_name'] },
      { question: 'How often do you take it?', fieldKeys: ['dosage', 'frequency'] },
      { question: 'When did you start, and who prescribed it?', fieldKeys: ['start_date', 'end_date', 'prescribing_provider'] },
    ],
  },
  {
    id: 'allergy',
    label: 'Allergy',
    description: 'An allergy or sensitivity to a food, medication, or substance.',
    accent: 'red',
    supportsAttachments: false,
    requiresAttachment: false,
    fields: [
      { key: 'allergy_name', label: 'Allergy', kind: 'text', required: true },
      { key: 'category', label: 'Category', kind: 'chips', options: [
        { value: 'food', label: 'Food' },
        { value: 'medication', label: 'Medication' },
        { value: 'environmental', label: 'Environmental' },
        { value: 'other', label: 'Other' },
      ] },
      { key: 'severity', label: 'Severity', kind: 'chips', options: [
        { value: 'mild', label: 'Mild' },
        { value: 'moderate', label: 'Moderate' },
        { value: 'severe', label: 'Severe' },
      ] },
      { key: 'symptoms', label: 'Symptoms', kind: 'text' },
    ],
    steps: [
      { question: 'What are you allergic to?', fieldKeys: ['allergy_name'] },
      { question: 'What category and how severe?', fieldKeys: ['category', 'severity'] },
      { question: 'Any symptoms? (optional)', fieldKeys: ['symptoms'] },
    ],
  },
  {
    id: 'vaccination',
    label: 'Vaccination',
    description: 'A vaccine or immunization you have received.',
    accent: 'blue',
    supportsAttachments: false,
    requiresAttachment: false,
    fields: [
      { key: 'vaccine_name', label: 'Vaccine', kind: 'text', required: true },
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'provider', label: 'Provider', kind: 'text' },
    ],
    steps: [
      { question: 'Which vaccine did you receive?', fieldKeys: ['vaccine_name'] },
      { question: 'When and where was it given?', fieldKeys: ['date', 'provider'] },
    ],
  },
  {
    id: 'procedure',
    label: 'Surgery / Procedure',
    description: 'A surgery or medical procedure you have had.',
    accent: 'gray',
    supportsAttachments: true,
    requiresAttachment: false,
    fields: [
      { key: 'procedure_name', label: 'Procedure', kind: 'text', required: true },
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'facility', label: 'Facility', kind: 'text' },
      { key: 'provider', label: 'Provider', kind: 'text' },
    ],
    steps: [
      { question: 'What procedure did you have?', fieldKeys: ['procedure_name'] },
      { question: 'When and where was it done?', fieldKeys: ['date', 'facility', 'provider'] },
    ],
  },
  {
    id: 'hospital_visit',
    label: 'Hospital Visit',
    description: 'A hospital admission, emergency visit, or appointment.',
    accent: 'green',
    supportsAttachments: true,
    requiresAttachment: false,
    fields: [
      { key: 'visit_type', label: 'Visit type', kind: 'cards', required: true, options: [
        { value: 'consultation', label: 'Consultation' },
        { value: 'emergency', label: 'Emergency' },
        { value: 'admission', label: 'Admission' },
        { value: 'follow_up', label: 'Follow-up' },
      ] },
      { key: 'facility', label: 'Facility', kind: 'text', required: true },
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'reason', label: 'Reason for visit', kind: 'text' },
      { key: 'provider', label: 'Provider', kind: 'text' },
    ],
    steps: [
      { question: 'What type of visit was this?', fieldKeys: ['visit_type'] },
      { question: 'Where and when was the visit?', fieldKeys: ['facility', 'date'] },
      { question: 'Why did you visit?', fieldKeys: ['reason', 'provider'] },
    ],
  },
  {
    id: 'document',
    label: 'Upload Existing Report',
    description: 'Upload an existing medical report, letter, or scan.',
    accent: 'gray',
    supportsAttachments: true,
    requiresAttachment: true,
    uploadFirst: true,
    fields: [],
    steps: [],
  },
  {
    id: 'voice_note',
    label: 'Voice Entry',
    description: 'Record a quick voice note about your health.',
    accent: 'gray',
    supportsAttachments: false,
    requiresAttachment: false,
    isVoiceEntry: true,
    fields: [],
    steps: [],
  },
]

export function getHealthInfoTypeConfig(typeId: string | null | undefined): HealthInfoTypeConfig | undefined {
  return HEALTH_INFO_TYPES.find(type => type.id === typeId)
}

export function createEmptyHealthInfoValues(typeId: string): HealthInfoValues {
  const config = getHealthInfoTypeConfig(typeId)
  const values: HealthInfoValues = {}
  config?.fields.forEach(field => { values[field.key] = '' })
  return values
}

export function buildHealthInfoTitle(typeId: string, values: HealthInfoValues, fallback?: string): string {
  const config = getHealthInfoTypeConfig(typeId)
  const primaryField = config?.fields[0]
  const primaryValue = primaryField ? (values[primaryField.key] ?? '').trim() : ''
  if (primaryValue) return primaryValue
  if (fallback?.trim()) return fallback.trim()
  return config?.label ?? 'Health Information'
}

export function inferLegacyCategoryFromInfoType(infoType: string): RecordCategory {
  if (infoType === 'lab_result') return 'lab_results'
  if (infoType === 'medication') return 'drug_prescription'
  if (infoType === 'document') return 'medical_report'
  return 'other'
}

export function buildHealthInfoRecordBody(notes: string, transcriptionText?: string): string {
  const sections: string[] = []

  if (notes.trim()) {
    sections.push('Notes', notes.trim())
  }

  if (transcriptionText?.trim()) {
    sections.push('Audio to text note', transcriptionText.trim())
  }

  return sections.join('\n\n').trim() || 'No additional notes provided.'
}

export function formatHealthInfoType(infoType: string | null | undefined, fallbackCategory?: RecordCategory): string {
  const config = getHealthInfoTypeConfig(infoType)
  if (config) return config.label
  if (fallbackCategory) return formatRecordCategory(fallbackCategory)
  return 'Other'
}

export function getRecordContributorLabel(record: MedicalRecord): string {
  if (!record.added_by_role || record.added_by_role === 'patient') return 'You'
  return record.created_by_org ?? record.created_by
}

export function isMedicationRecord(record: MedicalRecord): boolean {
  return record.info_type === 'medication' || record.category === 'drug_prescription'
}

export function getRecordSourceBadge(record: MedicalRecord): RecordSourceBadgeInfo {
  if (record.source_provenance?.import_item_id) {
    return { label: 'Validated archive import', color: 'blue' }
  }
  const role = record.added_by_role ?? 'patient'
  const verified = record.created_by_verified ?? false
  switch (role) {
    case 'doctor':
      return { label: verified ? 'Verified HID Doctor' : 'Clinician Verified', color: 'blue' }
    case 'nurse':
    case 'clinician':
      return { label: 'Clinician Verified', color: 'blue' }
    case 'lab':
      return { label: 'Laboratory Verified', color: 'green' }
    case 'pharmacist':
      return { label: 'Pharmacy Verified', color: 'amber' }
    case 'admin':
    case 'org_admin':
    case 'platform_admin':
      return { label: 'Hospital Verified', color: 'blue' }
    default:
      return { label: 'Patient Reported', color: 'gray' }
  }
}

export const RECORD_UPLOAD_ACCEPT = '.img,.png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf'
const allowedUploadExtensions = ['.img', '.png', '.jpg', '.jpeg', '.pdf']
const allowedUploadMimeTypes = ['image/png', 'image/jpeg', 'application/pdf']

export function createEmptyRecordForm(): RecordFormValues {
  return {
    title: '',
    roleNote: '',
    prescription: '',
    labResult: '',
    other: '',
    transcriptionText: '',
    uploads: [],
  }
}

export function formatRecordCategory(category: RecordCategory): string {
  if (category === 'drug_prescription') return 'Prescription'
  if (category === 'lab_results') return 'Lab results'
  if (category === 'medical_report') return 'Medical report'
  return 'Other'
}

export function getRoleNoteLabel(role: string | null | undefined): string {
  if (role === 'doctor') return 'Doctor note'
  if (role === 'patient') return 'Patient note'
  return 'Note'
}

export function hasRecordContent(form: RecordFormValues): boolean {
  return [
    form.roleNote,
    form.prescription,
    form.labResult,
    form.other,
    form.transcriptionText,
  ].some(value => value.trim().length > 0) || form.uploads.length > 0
}

export function inferRecordCategory(form: RecordFormValues): RecordCategory {
  if (form.prescription.trim()) return 'drug_prescription'
  if (form.labResult.trim()) return 'lab_results'
  if (form.other.trim()) return 'other'
  return 'medical_report'
}

export function buildStructuredRecordBody(form: RecordFormValues): string {
  const sections: string[] = []
  if (form.prescription.trim()) {
    sections.push('Prescription', form.prescription.trim())
  }
  if (form.labResult.trim()) {
    sections.push('Lab result', form.labResult.trim())
  }
  if (form.other.trim()) {
    sections.push('Other', form.other.trim())
  }
  if (form.transcriptionText.trim()) {
    sections.push('Audio to text note', form.transcriptionText.trim())
  }
  return sections.join('\n\n').trim() || 'No additional record details provided.'
}

export function isAllowedRecordUpload(file: Pick<UploadDraft, 'file_name' | 'file_type'> | Pick<File, 'name' | 'type'>): boolean {
  const fileName = 'file_name' in file ? file.file_name : file.name
  const fileType = ('file_type' in file ? file.file_type : file.type) ?? ''
  const normalizedName = fileName.toLowerCase()
  const normalizedType = fileType.toLowerCase()
  return allowedUploadMimeTypes.includes(normalizedType) || allowedUploadExtensions.some(extension => normalizedName.endsWith(extension))
}

export function getInvalidRecordUploadNames(files: Array<Pick<File, 'name' | 'type'>>): string[] {
  return files.filter(file => !isAllowedRecordUpload(file)).map(file => file.name)
}

export function getRecordAttachmentCount(record: MedicalRecord, attachments: UploadDraft[] | Array<{ file_name: string; file_type: string | null; file_data_url: string }> = []): number {
  if (attachments.length > 0) return attachments.length
  return record.attachment_data_url ? 1 : 0
}

export function countAllRecordAttachments(records: MedicalRecord[], recordFiles: Record<string, Array<{ file_name: string; file_type: string | null; file_data_url: string }>>): number {
  return records.reduce((sum, record) => sum + getRecordAttachmentCount(record, recordFiles[record.id] ?? []), 0)
}

export function buildOptimisticRecordFiles(record: MedicalRecord, uploads: UploadDraft[]): MedicalRecordFile[] {
  return uploads.map((file, index) => ({
    id: `${record.id}-${index}`,
    record_id: record.id,
    file_name: file.file_name,
    file_type: file.file_type,
    file_data_url: file.file_data_url,
    created_at: record.created_at,
  }))
}

export function buildOptimisticMedicalRecord(params: {
  category: RecordCategory
  createdBy: string
  createdByRole: string
  hidCode: string
  notes?: string | null
  record: string
  title: string
  transcriptionText?: string | null
  uploads?: UploadDraft[]
  infoType?: string
  structuredData?: Record<string, unknown> | null
}) {
  const createdAt = new Date().toISOString()
  const optimisticRecord = {
    id: `optimistic-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`,
    hid_code: params.hidCode,
    title: params.title,
    category: params.category,
    record: params.record,
    notes: params.notes ?? null,
    attachment_name: params.uploads?.[0]?.file_name ?? null,
    attachment_type: params.uploads?.[0]?.file_type ?? null,
    attachment_data_url: params.uploads?.[0]?.file_data_url ?? null,
    transcription_text: params.transcriptionText ?? null,
    created_by: params.createdBy,
    added_by_role: params.createdByRole,
    created_at: createdAt,
    info_type: params.infoType ?? 'document',
    structured_data: params.structuredData ?? null,
    created_by_org: null,
    created_by_verified: false,
  } satisfies MedicalRecord

  return {
    attachments: buildOptimisticRecordFiles(optimisticRecord, params.uploads ?? []),
    record: optimisticRecord,
  }
}

export function filterSessionRecords(records: MedicalRecord[], sessionStartedAt: string | null | undefined): MedicalRecord[] {
  if (!sessionStartedAt) return []
  return records.filter(record => record.created_at >= sessionStartedAt)
}

export function filterRecordsWithDocuments(records: MedicalRecord[], recordFiles: Record<string, Array<{ file_name: string; file_type: string | null; file_data_url: string }>>): MedicalRecord[] {
  return records.filter(record => {
    const attachments = recordFiles[record.id] ?? []
    if (attachments.length > 0) {
      return attachments.some(file => isAllowedRecordUpload(file))
    }
    return !!record.attachment_data_url && isAllowedRecordUpload({
      file_name: record.attachment_name ?? 'record.pdf',
      file_type: record.attachment_type,
    })
  })
}

export function recordContainsSection(record: MedicalRecord, sectionLabel: string): boolean {
  const content = `${record.record}\n${record.notes ?? ''}\n${record.transcription_text ?? ''}`.toLowerCase()
  return content.includes(sectionLabel.toLowerCase())
}

export function isLabRecord(record: MedicalRecord): boolean {
  return record.category === 'lab_results' || recordContainsSection(record, 'Lab result')
}

export function buildRecordSearchText(record: MedicalRecord): string {
  return [
    record.title,
    record.created_by,
    record.added_by_role,
    formatDate(record.created_at),
    formatDateTime(record.created_at),
    record.created_at,
    record.record,
    record.notes,
    record.transcription_text,
    formatHealthInfoType(record.info_type, record.category),
    record.structured_data ? JSON.stringify(record.structured_data) : '',
  ].join(' ').toLowerCase()
}

export function filterRecordsByQuery(records: MedicalRecord[], query: string): MedicalRecord[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return records
  return records.filter(record => buildRecordSearchText(record).includes(normalized))
}

export function groupRecordsByDay(records: MedicalRecord[]): RecordDateSection[] {
  const groups = new Map<string, MedicalRecord[]>()
  records.forEach(record => {
    const key = record.created_at.slice(0, 10)
    groups.set(key, [...(groups.get(key) ?? []), record])
  })

  return Array.from(groups.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, items]) => ({
      key,
      label: formatDate(key),
      records: [...items].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    }))
}
