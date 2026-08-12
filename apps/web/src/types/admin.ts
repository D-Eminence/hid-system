export type AdminOverviewWindow = '24h' | '7d' | '30d'

export interface AdminMetricPoint {
  timestamp: string
  value: number
}

export interface AdminRecentUser {
  id: string
  email: string | null
  name: string | null
  role: string | null
  status: 'verified' | 'unverified'
  createdAt: string
  lastSignInAt: string | null
}

export interface AdminRecentUpload {
  id: string
  fileName: string
  fileType: string | null
  uploadedBy: string | null
  uploadedFor: string | null
  createdAt: string
}

export interface AdminAlert {
  id: string
  level: 'info' | 'warning' | 'critical'
  title: string
  message: string
}

export interface AdminFunnelStep {
  key: string
  label: string
  value: number
  conversionFromPrevious: number | null
}

export interface AdminSentryIssue {
  id: string
  title: string
  culprit: string | null
  count: number
  users: number
  level: string | null
  status: string | null
  lastSeen: string | null
  permalink: string | null
}

export interface AdminPosthogEvent {
  name: string
  total: number
}

export interface AdminBreakdownItem {
  key: string
  label: string
  value: number
  helper?: string | null
}

export interface AdminObservabilityProviderBase {
  configured: boolean
  message: string | null
  externalUrl: string | null
}

export interface AdminSentryOverview extends AdminObservabilityProviderBase {
  affectedUsers: number | null
  criticalIssues: number | null
  issueEvents: number | null
  issuesByLevel: AdminBreakdownItem[]
  issuesByStatus: AdminBreakdownItem[]
  mostRecentIssueAt: string | null
  projectLabel: string | null
  recentIssues: AdminSentryIssue[]
  topCulprits: AdminBreakdownItem[]
  trend: AdminMetricPoint[]
  unresolvedIssues: number | null
}

export interface AdminPosthogOverview extends AdminObservabilityProviderBase {
  autocaptures: number | null
  events: number | null
  identifies: number | null
  pageviewTrend: AdminMetricPoint[]
  pageviews: number | null
  projectLabel: string | null
  topEvents: AdminPosthogEvent[]
  trend: AdminMetricPoint[]
  uniqueUsers: number | null
  webVitals: number | null
}

export interface AdminUserMetrics {
  totalUsers: number
  totalPatients: number
  newSignupsToday: number
  newSignupsWindow: number
  activeUsers24h: number
  activeUsersWindow: number
  verifiedUsers: number
  unverifiedUsers: number
  growth: AdminMetricPoint[]
  recentUsers: AdminRecentUser[]
  funnel: AdminFunnelStep[]
}

export interface AdminRecordMetrics {
  totalRecords: number
  uploadedToday: number
  averagePerUser: number
  storageBytes: number
  uploads: AdminMetricPoint[]
  recentUploads: AdminRecentUpload[]
}

export interface AdminProviderMetrics {
  totalOrganizations: number
  totalProviders: number
  activeProviders: number
  recordsUploadedByProviders: number
}

export interface AdminSecurityMetrics {
  failedLoginAttempts: number
  otpSuccessRate: number | null
  suspiciousActivityCount: number
}

export interface AdminSystemMetrics {
  apiResponseTimeMs: number | null
  errorRate: number | null
  failedRequests: number | null
  uptimePercent: number | null
}

export interface AdminDashboardOverview {
  alerts: AdminAlert[]
  checkedAt: string
  posthog: AdminPosthogOverview
  providers: AdminProviderMetrics
  records: AdminRecordMetrics
  security: AdminSecurityMetrics
  sentry: AdminSentryOverview
  selectedDate: string | null
  system: AdminSystemMetrics
  users: AdminUserMetrics
  window: AdminOverviewWindow
}

export type AdminUserManagementAction =
  | 'lock_profile'
  | 'unlock_profile'
  | 'restrict_staff_access'
  | 'restore_staff_access'
  | 'close_patient_access'
  | 'restore_account'
  | 'delete_account'
  | 'permanently_delete_account'

export interface AdminManagedUserProfile {
  id: string
  authUserId: string
  appRole: string | null
  displayName: string | null
  active: boolean
  deletedAt: string | null
  deletedByUserProfileId: string | null
  deletedReason: string | null
  mfaRequired: boolean
  createdAt: string
  restoredAt: string | null
  restoredByUserProfileId: string | null
  updatedAt: string
}

export interface AdminManagedPatient {
  id: string
  authUserId: string
  userProfileId: string
  hidCode: string
  fullName: string
  email: string | null
  phone: string | null
  gender: string | null
  dateOfBirth: string | null
  country: string | null
  state: string | null
  emergencyContactName: string | null
  emergencyContactPhone: string | null
  profilePercent: number
  notificationsEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface AdminManagedStaffMembership {
  id: string
  organizationId: string
  organizationName: string | null
  membershipRole: string
  appRole: string
  isPrimary: boolean
  active: boolean
  createdAt: string
}

export interface AdminManagedStaff {
  id: string
  authUserId: string
  userProfileId: string
  fullName: string
  email: string
  phone: string | null
  hospitalName: string | null
  verificationStatus: string
  licenseNumber: string | null
  role: string
  active: boolean
  createdAt: string
  updatedAt: string
  memberships: AdminManagedStaffMembership[]
  activeMembershipCount: number
  inactiveMembershipCount: number
}

export interface AdminManagedUserStats {
  activeGrantCount: number
  pendingRequestCount: number
  recordCount: number
  unreadNotificationCount: number
}

export interface AdminManagedUserFlags {
  deleted: boolean
  locked: boolean
  deletable: boolean
  permanentlyDeletable: boolean
  lockable: boolean
  patientAccessOpen: boolean | null
  restrictable: boolean
  restorable: boolean
  staffAccessRestricted: boolean | null
}

export interface AdminManagedUser {
  id: string
  email: string | null
  emailConfirmedAt: string | null
  lastSignInAt: string | null
  profile: AdminManagedUserProfile | null
  patient: AdminManagedPatient | null
  staff: AdminManagedStaff | null
  stats: AdminManagedUserStats
  flags: AdminManagedUserFlags
}

export interface AdminUserDirectoryResponse {
  matches: AdminManagedUser[]
}

export type AdminUsersExportFormat = 'csv' | 'xlsx' | 'pdf' | 'txt'

export type AdminUsersExportScope =
  | 'selected_user'
  | 'search_results'
  | 'selected_day'
  | 'last_7_days'
  | 'last_30_days'
  | 'all'

export interface AdminUsersExportFilters {
  scope: AdminUsersExportScope
  authUserId?: string | null
  query?: string | null
  date?: string | null
}

export interface AdminUsersExportStartResponse {
  challengeId: string
  deliveryChannels: Array<'email'>
  expiresAt: string
  maskedEmail: string | null
}

export interface AdminUserActionResponse {
  deleted: boolean
  permanentlyDeleted: boolean
  targetAuthUserId: string
  user: AdminManagedUser | null
}

export interface AdminPlatformAdmin {
  profileId: string
  authUserId: string
  displayName: string | null
  email: string | null
  emailConfirmedAt: string | null
  lastSignInAt: string | null
  active: boolean
  deletedAt: string | null
  mfaRequired: boolean
  createdAt: string
  updatedAt: string
}

export type AdminPlatformAdminAction =
  | 'lock_admin'
  | 'unlock_admin'
  | 'delete_admin'
  | 'restore_admin'
  | 'permanently_delete_admin'

export interface AdminPlatformAdminActionResponse {
  admin: AdminPlatformAdmin | null
  deletedAuthUserId: string | null
}

export interface AdminStaffRolePolicy {
  role: string
  canOpenDashboard: boolean
  canUseStandardAccess: boolean
  canViewPatientRecords: boolean
  canCreateRecords: boolean
  canUseBreakGlass: boolean
  canViewHistory: boolean
  updatedAt: string
  updatedByUserProfileId: string | null
}

export interface AdminOutreachRolePolicy {
  role: string
  canOpenWorkspace: boolean
  canCreateEncounters: boolean
  canManageInvites: boolean
  canSyncData: boolean
  canViewCampaignData: boolean
  updatedAt: string
  updatedByUserProfileId: string | null
}

export interface AdminRoleManagementResponse {
  admins: AdminPlatformAdmin[]
  canManagePlatformAdmins: boolean
  staffRolePolicies: AdminStaffRolePolicy[]
  outreachRolePolicies: AdminOutreachRolePolicy[]
}

export interface AdminCreatePlatformAdminResponse {
  admin: AdminPlatformAdmin
  passwordSetupLink: string
  verificationType: string | null
}

export interface AdminPlatformControls {
  maintenanceMode: boolean
  patientSignupEnabled: boolean
  hospitalSignupEnabled: boolean
  patientPortalEnabled: boolean
  hospitalPortalEnabled: boolean
  outreachSignupEnabled: boolean
  outreachPortalEnabled: boolean
  migratePortalEnabled: boolean
  breakGlassEnabled: boolean
  uploadsEnabled: boolean
  updatedAt: string
  updatedByUserProfileId: string | null
  updatedByName: string | null
  updatedByEmail: string | null
  outreach?: {
    summary: {
      activeCampaigns: number
      plannedCampaigns: number
      closedCampaigns: number
      workers: number
      openInvites: number
      encounters: number
      queuedEncounters: number
      referrals: number
      urgentReferrals: number
    }
    campaigns: Array<{
      id: string
      name: string
      org: string
      location: string
      status: string
      startsAt: string
      endsAt: string | null
      createdAt: string
    }>
    workers: Array<{
      id: string
      displayName: string
      role: string
      campaignId: string
      createdAt: string
    }>
    invites: Array<{
      id: string
      campaignId: string
      role: string
      useCount: number
      maxUses: number
      expiresAt: string | null
      createdAt: string
      active: boolean
    }>
  }
}

export type AdminAiWorkload =
  | 'ocr'
  | 'handwriting_recognition'
  | 'document_classification'
  | 'structured_data_extraction'
  | 'clinical_entity_extraction'
  | 'document_summarization'
  | 'patient_matching_assistance'
  | 'image_understanding'

export interface AdminAiProvider {
  id: string
  name: string
  provider_type: 'nvidia' | 'deepseek' | 'anthropic' | 'openai' | 'google' | 'other'
  provider_kind: 'ocr' | 'ai' | 'multimodal' | 'compatible'
  api_base_url: string | null
  api_version: string | null
  organization_reference: string | null
  project_reference: string | null
  request_timeout_ms: number
  max_retry_count: number
  status: 'active' | 'disabled' | 'degraded'
  priority: number
  api_key_masked: string | null
  has_api_key: boolean
  last_success_at: string | null
  last_failure_at: string | null
  last_failure_code: string | null
  average_latency_ms: number | null
  configuration_version: number
  created_at: string
  updated_at: string
}

export interface AdminAiModel {
  id: string
  provider_id: string
  display_name: string
  model_id: string
  model_version: string | null
  purposes: AdminAiWorkload[]
  status: 'active' | 'disabled' | 'degraded'
  priority: number
  input_cost_per_million_minor: number | null
  output_cost_per_million_minor: number | null
  page_cost_minor: number | null
  currency: string
  configuration_version: number
  last_used_at: string | null
  provider?: { id: string; name: string; provider_type: string } | null
}

export interface AdminAiWorkloadRoute {
  workload: AdminAiWorkload
  processing_strategy: 'ocr_then_ai' | 'direct_multimodal'
  primary_model_id: string | null
  fallback_model_id: string | null
  configuration_version: number
  primary_model?: { id: string; display_name: string; model_id: string; provider?: { id: string; name: string } | null } | null
  fallback_model?: { id: string; display_name: string; model_id: string; provider?: { id: string; name: string } | null } | null
}

export interface AdminAiUsageSummary {
  requests: number
  successful_requests: number
  failed_requests: number
  rate_limited_requests?: number
  timed_out_requests?: number
  retries: number
  input_tokens: number
  output_tokens: number
  pages_processed: number
  estimated_cost_minor: number
  average_latency_ms: number
}

export interface AdminAiProjectUsage extends AdminAiUsageSummary {
  id: string
  name: string
  project_reference: string
  organization_name: string | null
  pages_scanned: number
  folders_scanned: number
  patients_migrated: number
  failed_jobs: number
  retrying_jobs: number
  cost_per_page_minor: number
  cost_per_patient_minor: number
}

export interface AdminAiProcessingOverview {
  providers: AdminAiProvider[]
  models: AdminAiModel[]
  routes: AdminAiWorkloadRoute[]
  budgets: Array<Record<string, unknown>>
  usage: {
    today: AdminAiUsageSummary
    month: AdminAiUsageSummary
    by_provider: Array<AdminAiUsageSummary & { key: string; provider_quota?: Record<string, unknown> }>
    today_by_provider: Array<AdminAiUsageSummary & { key: string; provider_quota?: Record<string, unknown> }>
    by_workload: Array<AdminAiUsageSummary & { key: string }>
    projects: AdminAiProjectUsage[]
    quota_note: string
  }
  processing: {
    health: 'healthy' | 'degraded' | 'issues_detected'
    queued: number
    processing: number
    retrying: number
    dead_letter: number
    oldest_queued_at: string | null
    failures: {
      ocr: number
      classification: number
      extraction: number
      provider_errors: number
      rate_limit_errors: number
      timeouts: number
      low_confidence_results: number
      human_review: number
    }
    failed_jobs: Array<{
      id: string
      job_type: string
      provider: string | null
      attempt_count: number
      created_at: string
      migration_project_id: string
      status: string
    }>
  }
  migrate: {
    active_projects: number
    patients_migrated: number
    folders_scanned: number
    pages_processed: number
    pending_validation: number
    import_success_rate: number
    estimated_processing_cost_minor: number
  }
  budget: {
    monthly_budget_minor: number
    spent_minor: number
    remaining_minor: number
    warning_threshold_percent: number
    critical_threshold_percent: number
  } | null
  checked_at: string
}

export interface AdminPlatformControlsResponse {
  controls: AdminPlatformControls
}
