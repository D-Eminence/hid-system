export type HidAppRole = 'patient' | 'clinician' | 'org_admin' | 'platform_admin'
export type HidStaffRole = 'doctor' | 'nurse' | 'lab' | 'pharmacist' | 'admin'
export type HidAccessScope = 'read_records' | 'write_records' | 'break_glass'
export type HidRequestStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired'
export type HidGrantStatus = 'active' | 'revoked' | 'expired'
export type HidSharePermissionTier = 'view_only' | 'clinical_review' | 'clinical_collaboration'
export type HidShareDurationPreset = '24h' | '7d' | '30d' | 'until_revoked'
export type HidShareTargetType = 'profile' | 'record' | 'health_event'

export interface HidPatient {
  id: string
  user_profile_id: string
  auth_user_id: string
  hid_code: string
  first_name: string
  last_name: string
  full_name: string
  phone_e164: string | null
  email: string | null
  hospital_currently_using: string | null
  gender: string | null
  dob: string | null
  blood_group: string | null
  genotype: string | null
  country: string | null
  state: string | null
  allergies: string | null
  chronic_conditions: string | null
  current_medications: string | null
  photo_url: string | null
  emergency_contact_name: string | null
  emergency_contact_relationship: string | null
  emergency_contact_phone: string | null
  emergency_contact_address: string | null
  hmo_organization: string | null
  medical_notes: string | null
  nin_last4: string | null
  nin_hash: string | null
  nin_ciphertext: string | null
  notifications_enabled: boolean
  profile_percent: number
  access_pin_configured?: boolean
  created_at: string
  updated_at: string
}

export interface HidPatientIdentifier {
  id: string
  patient_id: string
  identifier_type: 'hid_code' | 'phone' | 'email'
  raw_value: string
  normalized_value: string
  verified: boolean
  created_at: string
}

export interface HidStaffAccount {
  id: string
  user_profile_id: string
  auth_user_id: string
  full_name: string
  email: string
  phone_e164: string | null
  hospital_name: string | null
  verification_status: string
  license_number: string | null
  role: HidStaffRole
  active: boolean
  deleted_at?: string | null
  created_at: string
  updated_at: string
}

export interface HidStaffMembership {
  id: string
  staff_account_id: string
  organization_id: string
  facility_id: string | null
  membership_role: HidStaffRole
  app_role: HidAppRole
  is_primary: boolean
  active: boolean
  created_at: string
  updated_at: string
}

export interface HidMedicalRecord {
  id: string
  patient_id: string
  title: string
  category: string
  info_type?: string
  created_by_user_profile_id: string
  created_by_staff_account_id: string | null
  current_version_id: string | null
  created_at: string
  updated_at: string
  created_by_name?: string | null
  created_by_role?: string | null
  created_by_org?: string | null
  created_by_verified?: boolean
  source_provenance?: {
    migration_project_id?: string
    source_folder_id?: string
    source_document_id?: string
    import_item_id?: string
  } | null
  structured_schema_version?: string | null
}

export interface HidMedicalRecordVersion {
  id: string
  record_id: string
  version_no: number
  record: string
  notes: string | null
  transcription_text: string | null
  structured_data?: Record<string, unknown> | null
  created_by_user_profile_id: string
  created_by_staff_account_id: string | null
  created_at: string
  created_by_name?: string | null
  created_by_role?: string | null
  created_by_org?: string | null
  created_by_verified?: boolean
}

export interface HidMedicalRecordFile {
  id: string
  record_id: string
  record_version_id: string
  patient_id: string
  original_file_name: string
  mime_type: string | null
  size_bytes: number | null
  signed_download_url?: string | null
  uploaded_by_user_profile_id: string
  created_at: string
}

export interface HidNotification {
  id: string
  user_profile_id: string
  patient_id: string | null
  title: string
  message: string
  type: string
  read_at: string | null
  created_at: string
}

export interface HidPatientProfileResponse {
  patient: HidPatient
  identifiers: HidPatientIdentifier[]
  active_grants: number
}

export interface HidPatientRecordBundle {
  record: HidMedicalRecord
  current_version: HidMedicalRecordVersion | null
  files: HidMedicalRecordFile[]
}

export interface HidPatientRecordsResponse {
  patient: HidPatient
  records: HidPatientRecordBundle[]
}

export type HidHealthEventStatus = 'active' | 'monitoring' | 'resolved' | 'archived'

export interface HidHealthEvent {
  id: string
  patient_id: string
  title: string
  info_category: string
  status: HidHealthEventStatus
  started_at: string | null
  ended_at: string | null
  created_by_user_profile_id: string | null
  created_by_staff_account_id: string | null
  created_at: string
  updated_at: string
  record_ids: string[]
}

export interface HidHistoryPendingRequest {
  request_id: string
  staff_account_id: string
  staff_name: string
  staff_role: HidStaffRole
  hospital_name: string | null
  scope: HidAccessScope
  status: HidRequestStatus
  reason: string
  break_glass: boolean
  created_at: string
  approved_at: string | null
}

export interface HidHistoryActiveGrant {
  grant_id: string
  request_id: string | null
  staff_account_id: string
  staff_name: string
  staff_role: HidStaffRole
  hospital_name: string | null
  scope: HidAccessScope
  status: HidGrantStatus
  reason: string
  starts_at: string
  expires_at: string
  break_glass: boolean
  permission_tier: HidSharePermissionTier | null
  share_target_type: HidShareTargetType
  share_target_id: string | null
  duration_preset: HidShareDurationPreset | null
}

export interface HidStaffSearchResult {
  staff_account_id: string
  full_name: string
  hospital_name: string | null
  role: HidStaffRole
}

export type HidShareInviteStatus = 'pending' | 'activated' | 'cancelled' | 'expired'

export interface HidPendingShareInvite {
  invite_id: string
  invited_email: string
  invited_name: string | null
  permission_tier: HidSharePermissionTier
  duration_preset: HidShareDurationPreset
  reason: string | null
  status: HidShareInviteStatus
  created_at: string
}

export interface HidHistoryEvent {
  event_id: string
  action: string
  resource_type: string
  reason: string | null
  created_at: string
  actor_name: string
  actor_role: string
  hospital_name: string | null
  metadata: Record<string, unknown>
}

export interface HidPatientHistoryResponse {
  pending_requests: HidHistoryPendingRequest[]
  active_grants: HidHistoryActiveGrant[]
  pending_invites: HidPendingShareInvite[]
  events: HidHistoryEvent[]
}

export interface HidStaffDashboardRequest {
  request_id: string
  grant_id: string | null
  patient_id: string
  hid_code: string
  patient_name: string
  scope: HidAccessScope
  request_status: HidRequestStatus
  grant_status: HidGrantStatus | null
  reason: string
  break_glass: boolean
  created_at: string
  approved_at: string | null
  expires_at: string | null
  hospital_name: string | null
  staff_display_name?: string | null
}

export interface HidStaffDashboardEvent {
  event_id: string
  action: string
  reason: string | null
  resource_type: string
  created_at: string
  patient_hid_code: string | null
  patient_name: string | null
}

export interface HidStaffDashboardResponse {
  staff_account: HidStaffAccount
  memberships: HidStaffMembership[]
  requests: HidStaffDashboardRequest[]
  audit_events: HidStaffDashboardEvent[]
}

export interface HidSessionPayload {
  access_token: string
  refresh_token: string
  expires_in?: number
  expires_at?: number
  token_type?: string
}
