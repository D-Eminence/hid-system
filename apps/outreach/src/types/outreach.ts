export type OutreachRole = 'enumerator' | 'health_worker' | 'admin'
export type OutreachCampaignStatus = 'planned' | 'active' | 'closed'
export type OutreachEncounterStatus = 'draft' | 'queued' | 'synced' | 'referred'
export type OutreachServiceType = 'registration' | 'vitals' | 'vaccination' | 'lab_sample' | 'referral'
export type OutreachSex = 'female' | 'male' | 'other'
export type OutreachSyncEntity = 'encounter' | 'vaccination' | 'referral' | 'mobile_lab_sample'
export type OutreachSyncAction = 'insert' | 'update'
export type OutreachSyncStatus = 'queued' | 'syncing' | 'failed' | 'synced'

export interface OutreachCampaign {
  id: string
  name: string
  org: string
  location: string
  status: OutreachCampaignStatus
  starts_at: string
  ends_at: string | null
  services: OutreachServiceType[]
  created_at: string
}

export interface OutreachWorker {
  id: string
  auth_user_id: string
  campaign_id: string
  display_name: string
  role: OutreachRole
  created_at: string
}

export interface OutreachEncounter {
  id: string
  campaign_id: string
  worker_id: string
  patient_hid: string | null
  provisional_patient_id: string | null
  full_name: string
  sex: OutreachSex
  age_years: number
  phone: string | null
  service_type: OutreachServiceType
  status: OutreachEncounterStatus
  notes: string | null
  consent_captured_at: string | null
  consent_method: 'pin' | 'signature' | 'verbal_witness' | null
  created_at: string
  synced_at: string | null
}

export interface OutreachVaccination {
  id: string
  encounter_id: string
  campaign_id: string
  vaccine_name: string
  dose_label: string
  vial_lot: string
  administered_at: string
  aefi_observed: boolean
  notes: string | null
}

export interface OutreachReferral {
  id: string
  encounter_id: string
  campaign_id: string
  facility_name: string
  reason: string
  urgency: 'routine' | 'soon' | 'urgent'
  created_at: string
}

export interface OutreachLabSample {
  id: string
  encounter_id: string
  campaign_id: string
  sample_type: string
  barcode: string
  collected_at: string
  cold_chain_required: boolean
}

export interface OutreachSyncQueueItem {
  id: string
  campaign_id: string
  worker_id: string
  entity: OutreachSyncEntity
  action: OutreachSyncAction
  payload: unknown
  status: OutreachSyncStatus
  error: string | null
  created_at: string
  synced_at: string | null
}

export interface OutreachInvite {
  id: string
  campaign_id: string
  created_by: string
  code: string
  role: OutreachRole
  max_uses: number
  use_count: number
  expires_at: string | null
  created_at: string
}

export type NewEncounterInput = {
  full_name: string
  sex: OutreachSex
  age_years: number
  phone?: string | null
  service_type: OutreachServiceType
  notes?: string | null
  consent_method?: 'pin' | 'signature' | 'verbal_witness' | null
}
