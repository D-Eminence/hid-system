export type AccessType = 'standard' | 'emergency'
export type AccessStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type StaffRole = 'doctor'
export type RecordCategory = 'lab_results' | 'drug_prescription' | 'medical_report' | 'other'
export type NotificationType = 'access_request' | 'access_granted' | 'access_rejected' | 'system'
export type VerificationStatus = 'pending_profile' | 'pending_verification' | 'verified'

export type Database = {
  public: {
    Tables: {
      patients: {
        Row: {
          id: string
          first_name: string | null
          last_name: string | null
          full_name: string
          phone: string | null
          email: string | null
          gender: string | null
          auth_password_hash: string | null
          blood_group: string
          nin_verified: boolean | null
          hid_code: string
          pin: string | null
          created_at: string
          nin: string | null
          dob: string | null
          country: string | null
          state: string | null
          genotype: string | null
          allergies: string | null
          chronic_conditions: string | null
          current_medications: string | null
          photo_url: string | null
          emergency_contact_name: string | null
          emergency_contact_relationship: string | null
          emergency_contact_phone: string | null
          emergency_contact_address: string | null
          medical_notes: string | null
          profile_percent: number | null
          notifications_enabled: boolean | null
        }
        Insert: {
          id?: string
          first_name?: string | null
          last_name?: string | null
          full_name: string
          phone?: string | null
          email?: string | null
          gender?: string | null
          auth_password_hash?: string | null
          blood_group?: string
          nin_verified?: boolean | null
          hid_code: string
          pin?: string | null
          created_at?: string
          nin?: string | null
          dob?: string | null
          country?: string | null
          state?: string | null
          genotype?: string | null
          allergies?: string | null
          chronic_conditions?: string | null
          current_medications?: string | null
          photo_url?: string | null
          emergency_contact_name?: string | null
          emergency_contact_relationship?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_address?: string | null
          medical_notes?: string | null
          profile_percent?: number | null
          notifications_enabled?: boolean | null
        }
        Update: Partial<Database['public']['Tables']['patients']['Insert']>
      }
      medical_records: {
        Row: {
          id: string
          hid_code: string
          title: string
          category: RecordCategory
          record: string
          notes: string | null
          attachment_name: string | null
          attachment_type: string | null
          attachment_data_url: string | null
          transcription_text: string | null
          created_by: string
          added_by_role: string | null
          created_at: string
          info_type: string
          structured_data: Record<string, unknown> | null
          created_by_org: string | null
          created_by_verified: boolean
          source_provenance?: {
            migration_project_id?: string
            source_folder_id?: string
            source_document_id?: string
            import_item_id?: string
          } | null
          structured_schema_version?: string | null
        }
        Insert: {
          id?: string
          hid_code: string
          title: string
          category?: RecordCategory
          record: string
          notes?: string | null
          attachment_name?: string | null
          attachment_type?: string | null
          attachment_data_url?: string | null
          transcription_text?: string | null
          created_by: string
          added_by_role?: string | null
          created_at?: string
          info_type?: string
          structured_data?: Record<string, unknown> | null
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
        Update: Partial<Database['public']['Tables']['medical_records']['Insert']>
      }
      medical_record_files: {
        Row: {
          id: string
          record_id: string
          file_name: string
          file_type: string | null
          file_data_url: string
          created_at: string
        }
        Insert: {
          id?: string
          record_id: string
          file_name: string
          file_type?: string | null
          file_data_url: string
          created_at?: string
        }
        Update: never
      }
      patient_notes: {
        Row: {
          id: string
          hid_code: string
          note: string
          created_by: string
          created_at: string
        }
        Insert: {
          id?: string
          hid_code: string
          note: string
          created_by: string
          created_at?: string
        }
        Update: never
      }
      access_logs: {
        Row: {
          id: string
          hid_code: string
          accessed_by: string
          access_time: string
          reason: string | null
          access_type: AccessType
          request_id: string | null
        }
        Insert: {
          id?: string
          hid_code: string
          accessed_by: string
          access_time?: string
          reason?: string | null
          access_type?: AccessType
          request_id?: string | null
        }
        Update: never
      }
      staff_accounts: {
        Row: {
          id: string
          full_name: string
          hospital_name: string | null
          verification_status: VerificationStatus | null
          email: string
          password_hash: string
          role: StaffRole
          active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          full_name: string
          hospital_name?: string | null
          verification_status?: VerificationStatus | null
          email: string
          password_hash: string
          role: StaffRole
          active?: boolean
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['staff_accounts']['Insert']>
      }
      access_requests: {
        Row: {
          id: string
          hid_code: string
          doctor_account_id: string | null
          doctor_name: string
          request_type: AccessType
          status: AccessStatus
          reason: string | null
          pin_verified: boolean
          approved_by: string | null
          approved_at: string | null
          duration_hours: number | null
          access_expires_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          hid_code: string
          doctor_account_id?: string | null
          doctor_name: string
          request_type: AccessType
          status?: AccessStatus
          reason?: string | null
          pin_verified?: boolean
          approved_by?: string | null
          approved_at?: string | null
          duration_hours?: number | null
          access_expires_at?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['access_requests']['Insert']>
      }
      notifications: {
        Row: {
          id: string
          hid_code: string
          title: string
          message: string
          type: NotificationType
          is_read: boolean
          created_at: string
        }
        Insert: {
          id?: string
          hid_code: string
          title: string
          message: string
          type?: NotificationType
          is_read?: boolean
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['notifications']['Insert']>
      }
      hid_outreach_campaigns: {
        Row: {
          id: string
          name: string
          org: string
          location: string
          status: 'planned' | 'active' | 'closed'
          starts_at: string
          ends_at: string | null
          services: Array<'registration' | 'vitals' | 'vaccination' | 'lab_sample' | 'referral'>
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          org: string
          location: string
          status?: 'planned' | 'active' | 'closed'
          starts_at: string
          ends_at?: string | null
          services?: Array<'registration' | 'vitals' | 'vaccination' | 'lab_sample' | 'referral'>
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['hid_outreach_campaigns']['Insert']>
      }
      hid_outreach_workers: {
        Row: {
          id: string
          auth_user_id: string
          campaign_id: string
          display_name: string
          role: 'enumerator' | 'health_worker' | 'admin'
          created_at: string
        }
        Insert: {
          id?: string
          auth_user_id: string
          campaign_id: string
          display_name: string
          role: 'enumerator' | 'health_worker' | 'admin'
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['hid_outreach_workers']['Insert']>
      }
      hid_outreach_encounters: {
        Row: {
          id: string
          campaign_id: string
          worker_id: string
          patient_hid: string | null
          provisional_patient_id: string | null
          full_name: string
          sex: 'female' | 'male' | 'other'
          age_years: number
          phone: string | null
          service_type: 'registration' | 'vitals' | 'vaccination' | 'lab_sample' | 'referral'
          status: 'draft' | 'queued' | 'synced' | 'referred'
          notes: string | null
          consent_captured_at: string | null
          consent_method: 'pin' | 'signature' | 'verbal_witness' | null
          created_at: string
          synced_at: string | null
        }
        Insert: {
          id?: string
          campaign_id: string
          worker_id: string
          patient_hid?: string | null
          provisional_patient_id?: string | null
          full_name: string
          sex: 'female' | 'male' | 'other'
          age_years: number
          phone?: string | null
          service_type: 'registration' | 'vitals' | 'vaccination' | 'lab_sample' | 'referral'
          status?: 'draft' | 'queued' | 'synced' | 'referred'
          notes?: string | null
          consent_captured_at?: string | null
          consent_method?: 'pin' | 'signature' | 'verbal_witness' | null
          created_at?: string
          synced_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['hid_outreach_encounters']['Insert']>
      }
      hid_vaccinations: {
        Row: {
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
        Insert: {
          id?: string
          encounter_id: string
          campaign_id: string
          vaccine_name: string
          dose_label: string
          vial_lot: string
          administered_at?: string
          aefi_observed?: boolean
          notes?: string | null
        }
        Update: Partial<Database['public']['Tables']['hid_vaccinations']['Insert']>
      }
      hid_outreach_referrals: {
        Row: {
          id: string
          encounter_id: string
          campaign_id: string
          facility_name: string
          reason: string
          urgency: 'routine' | 'soon' | 'urgent'
          created_at: string
        }
        Insert: {
          id?: string
          encounter_id: string
          campaign_id: string
          facility_name: string
          reason: string
          urgency: 'routine' | 'soon' | 'urgent'
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['hid_outreach_referrals']['Insert']>
      }
      hid_mobile_lab_samples: {
        Row: {
          id: string
          encounter_id: string
          campaign_id: string
          sample_type: string
          barcode: string
          collected_at: string
          cold_chain_required: boolean
        }
        Insert: {
          id?: string
          encounter_id: string
          campaign_id: string
          sample_type: string
          barcode: string
          collected_at?: string
          cold_chain_required?: boolean
        }
        Update: Partial<Database['public']['Tables']['hid_mobile_lab_samples']['Insert']>
      }
      hid_outreach_invites: {
        Row: {
          id: string
          campaign_id: string
          created_by: string
          code: string
          role: 'enumerator' | 'health_worker' | 'admin'
          max_uses: number
          use_count: number
          expires_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          campaign_id: string
          created_by: string
          code: string
          role?: 'enumerator' | 'health_worker' | 'admin'
          max_uses?: number
          use_count?: number
          expires_at?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['hid_outreach_invites']['Insert']>
      }
      hid_sync_queue: {
        Row: {
          id: string
          campaign_id: string
          worker_id: string
          entity: 'encounter' | 'vaccination' | 'referral' | 'mobile_lab_sample'
          action: 'insert' | 'update'
          payload: unknown
          status: 'queued' | 'syncing' | 'failed' | 'synced'
          error: string | null
          created_at: string
          synced_at: string | null
        }
        Insert: {
          id?: string
          campaign_id: string
          worker_id: string
          entity: 'encounter' | 'vaccination' | 'referral' | 'mobile_lab_sample'
          action: 'insert' | 'update'
          payload: unknown
          status?: 'queued' | 'syncing' | 'failed' | 'synced'
          error?: string | null
          created_at?: string
          synced_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['hid_sync_queue']['Insert']>
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

export type Patient = Database['public']['Tables']['patients']['Row'] & {
  access_pin_configured?: boolean | null
  hospital_currently_using?: string | null
  hmo_organization?: string | null
}
export type MedicalRecord = Database['public']['Tables']['medical_records']['Row']
export type MedicalRecordFile = Database['public']['Tables']['medical_record_files']['Row']
export type AccessLog = Database['public']['Tables']['access_logs']['Row']
export type StaffAccount = Database['public']['Tables']['staff_accounts']['Row']
export type AccessRequest = Database['public']['Tables']['access_requests']['Row']
export type Notification = Database['public']['Tables']['notifications']['Row']
export type PatientNote = Database['public']['Tables']['patient_notes']['Row']
