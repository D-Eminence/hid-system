import React, { useEffect, useMemo, useState } from 'react'
import { AdminLayout, type AdminSidebarSection } from '../../components/AdminLayout'
import { AdminFunnelChart } from '../../components/admin/AdminFunnelChart'
import { AdminMetricCard } from '../../components/admin/AdminMetricCard'
import { AdminSeriesChart } from '../../components/admin/AdminSeriesChart'
import { Badge, Button, EmptyState, Input, Modal, PageLoader, Select, showToast } from '../../components/ui'
import { OtpInputs } from '../../components/OtpInputs'
import { useAdminDashboard } from '../../hooks/useAdminDashboard'
import { ADMIN_LOGIN_PATH } from '../../lib/adminRoutes'
import { signOutAndClearSessions } from '../../lib/auth'
import { getSafeUser } from '../../lib/identityClient'
import {
  applyAdminUserAction,
  applyPlatformAdminAction,
  createPlatformAdmin,
  downloadAdminUsersExport,
  fetchAdminPlatformControls,
  fetchAdminAiProcessing,
  fetchAdminRoleManagement,
  fetchDeletedAdminUsers,
  searchAdminUsers,
  startAdminUsersExport,
  updateAdminOutreachRolePolicy,
  updateAdminPlatformControls,
  updateAdminStaffRolePolicy,
} from '../../services/adminDashboard'
import type {
  AdminAlert,
  AdminAiProcessingOverview,
  AdminManagedUser,
  AdminOverviewWindow,
  AdminOutreachRolePolicy,
  AdminPlatformAdmin,
  AdminPlatformAdminAction,
  AdminPlatformControls,
  AdminStaffRolePolicy,
  AdminUsersExportFilters,
  AdminUsersExportFormat,
  AdminUsersExportScope,
  AdminUsersExportStartResponse,
  AdminUserManagementAction,
} from '../../types/admin'

const windowOptions: Array<{ key: AdminOverviewWindow; label: string }> = [
  { key: '24h', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
]

const sidebarSections: AdminSidebarSection[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'users', label: 'Users' },
  { id: 'records', label: 'Records' },
  { id: 'providers', label: 'Providers' },
  { id: 'security', label: 'Security' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'billing', label: 'Billing', href: '/eminence/billing' },
  { id: 'ai-processing', label: 'AI & Processing', href: '/eminence/ai-processing' },
  { id: 'settings', label: 'Settings' },
]

function formatCompact(value: number | null) {
  if (value == null) return 'N/A'
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatStorage(bytes: number | null) {
  if (bytes == null) return 'N/A'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(size >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatPercentage(value: number | null) {
  if (value == null) return 'N/A'
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function formatDuration(value: number | null) {
  if (value == null) return 'N/A'
  return `${value.toFixed(0)}ms`
}

function formatDateTime(value: string | null) {
  if (!value) return 'N/A'
  return new Date(value).toLocaleString()
}

function formatRelativeTime(value: string | null) {
  if (!value) return 'N/A'
  const diffMs = Date.now() - new Date(value).getTime()
  const diffMinutes = Math.max(1, Math.floor(diffMs / 60000))
  if (diffMinutes < 60) return `${diffMinutes} min ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours} hr ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
}

function formatDayLabel(value: string | null) {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatLabelValue(value: string | number | null | undefined) {
  if (value == null || value === '') return 'Not available'
  return String(value)
}

function formatRoleLabel(role: string) {
  return role.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

function formatBool(value: boolean) {
  return value ? 'Yes' : 'No'
}

function matchesQuery(values: Array<string | null | undefined>, query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return values.some(value => `${value ?? ''}`.toLowerCase().includes(normalized))
}

const POSTHOG_WEB_SIGNAL_EVENT_KEYS = new Set([
  '$autocapture',
  '$identify',
  '$pageview',
  '$web_vitals',
  'web_vitals',
  'web vitals',
])

function normalizePosthogEventKey(value: string | null | undefined) {
  return `${value ?? ''}`.trim().toLowerCase().replace(/\s+/g, '_')
}

function metricIcon(path: 'users' | 'plus' | 'activity' | 'check' | 'records' | 'upload' | 'average' | 'storage' | 'providers' | 'provider-active' | 'api' | 'warning' | 'uptime' | 'failed' | 'lock' | 'shield' | 'analytics', color = 'var(--admin-accent)') {
  const wrap: React.CSSProperties = {
    width: 20,
    height: 20,
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(26, 111, 212, 0.08)',
    color,
  }

  const strokeProps = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

  const icon = (() => {
    switch (path) {
      case 'users':
        return <path d="M3.6 12.4c.5-1.8 1.9-2.8 3.4-2.8 1.5 0 2.9 1 3.4 2.8M7 7.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z" {...strokeProps} />
      case 'plus':
        return <path d="M8 3.2v9.6M3.2 8h9.6" {...strokeProps} />
      case 'activity':
        return <path d="M2.8 8h2.1l1.3-2.8 1.8 5 1.5-3h2.7" {...strokeProps} />
      case 'check':
        return <path d="m3.4 8 2.3 2.3L12.6 3.8" {...strokeProps} />
      case 'records':
        return <><rect x="3.2" y="2.8" width="9.6" height="10.4" rx="1.4" {...strokeProps} /><path d="M5.4 5.4h5.2M5.4 7.8h5.2M5.4 10.2h3.2" {...strokeProps} /></>
      case 'upload':
        return <><path d="M8 11V4.2M5.2 7 8 4.2 10.8 7" {...strokeProps} /><path d="M3.2 11.8h9.6" {...strokeProps} /></>
      case 'average':
        return <path d="M3.2 10.8 6 6l2 3 2.8-4 2 5.8" {...strokeProps} />
      case 'storage':
        return <><ellipse cx="8" cy="4.2" rx="4.2" ry="1.8" {...strokeProps} /><path d="M3.8 4.2v4.8c0 1 1.9 1.8 4.2 1.8s4.2-.8 4.2-1.8V4.2" {...strokeProps} /></>
      case 'providers':
        return <path d="M3 12.8V6.2L8 3l5 3.2v6.6M6.2 12.8V9.1h3.6v3.7" {...strokeProps} />
      case 'provider-active':
        return <><circle cx="6.2" cy="6" r="2" {...strokeProps} /><path d="M3.6 12.5c.4-1.6 1.5-2.6 2.6-2.6s2.2 1 2.6 2.6" {...strokeProps} /><path d="M11 5.2h2.8M12.4 3.8v2.8" {...strokeProps} /></>
      case 'api':
        return <path d="M4 10.8 6.5 5.2 9.2 10l2-3.2" {...strokeProps} />
      case 'warning':
        return <><path d="M8 3.1 13 12H3L8 3.1Z" {...strokeProps} /><path d="M8 6.4v2.5" {...strokeProps} /><circle cx="8" cy="10.2" r=".5" fill="currentColor" /></>
      case 'uptime':
        return <><circle cx="8" cy="8" r="5" {...strokeProps} /><path d="M8 5v3l2 1.4" {...strokeProps} /></>
      case 'failed':
        return <><path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" {...strokeProps} /></>
      case 'lock':
        return <><rect x="4.4" y="7.4" width="7.2" height="5.2" rx="1.2" {...strokeProps} /><path d="M5.8 7.4V5.8a2.2 2.2 0 1 1 4.4 0v1.6" {...strokeProps} /></>
      case 'shield':
        return <path d="M8 3.2 12 4.6v2.7c0 2.2-1.4 3.8-4 5.4-2.6-1.6-4-3.2-4-5.4V4.6L8 3.2Z" {...strokeProps} />
      case 'analytics':
      default:
        return <path d="M3.4 11.8h9.2M5 10V7.2M8 10V4.6M11 10V6.2" {...strokeProps} />
    }
  })()

  return (
    <span style={wrap}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        {icon}
      </svg>
    </span>
  )
}

function sectionLabel(label: string) {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', color: 'var(--admin-muted)', textTransform: 'uppercase', marginBottom: 8 }}>
      {label}
    </div>
  )
}

function sectionTitle(title: string) {
  return (
    <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1f2937', marginBottom: 12 }}>
      {title}
    </div>
  )
}

function panelStyle(): React.CSSProperties {
  return {
    background: '#fff',
    border: '1px solid var(--admin-border)',
    borderRadius: 12,
    padding: 14,
    boxShadow: 'var(--admin-shadow)',
  }
}

function tableHeaderCell(label: string) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--admin-muted)' }}>
      {label}
    </div>
  )
}

function alertToneStyle(level: AdminAlert['level']): React.CSSProperties {
  if (level === 'critical') {
    return {
      background: 'rgba(239, 68, 68, 0.08)',
      border: '1px solid rgba(239, 68, 68, 0.16)',
      color: '#b91c1c',
    }
  }
  if (level === 'warning') {
    return {
      background: 'rgba(245, 158, 11, 0.10)',
      border: '1px solid rgba(245, 158, 11, 0.18)',
      color: '#b45309',
    }
  }
  return {
    background: 'rgba(59, 130, 246, 0.08)',
    border: '1px solid rgba(59, 130, 246, 0.14)',
    color: '#1d4ed8',
  }
}

function statusBadgeColor(status: string) {
  if (status === 'verified') return 'green'
  if (status === 'unverified') return 'amber'
  return 'gray'
}

function readinessTone(ready: boolean) {
  return ready ? 'green' : 'amber'
}

const staffRoleCapabilityFields: Array<{
  key: keyof Pick<AdminStaffRolePolicy, 'canOpenDashboard' | 'canUseStandardAccess' | 'canViewPatientRecords' | 'canCreateRecords' | 'canUseBreakGlass' | 'canViewHistory'>
  label: string
  helper: string
}> = [
  { key: 'canOpenDashboard', label: 'Dashboard', helper: 'Open the hospital dashboard' },
  { key: 'canUseStandardAccess', label: 'Standard Access', helper: 'Request or open patient access' },
  { key: 'canViewPatientRecords', label: 'View Records', helper: 'Open patient record screens' },
  { key: 'canCreateRecords', label: 'Write Records', helper: 'Create and update records or uploads' },
  { key: 'canUseBreakGlass', label: 'Emergency', helper: 'Use break-glass access' },
  { key: 'canViewHistory', label: 'History', helper: 'View hospital audit and history' },
]

const outreachRoleCapabilityFields: Array<{
  key: keyof Pick<AdminOutreachRolePolicy, 'canOpenWorkspace' | 'canCreateEncounters' | 'canManageInvites' | 'canSyncData' | 'canViewCampaignData'>
  label: string
  helper: string
}> = [
  { key: 'canOpenWorkspace', label: 'Workspace', helper: 'Open the outreach workspace' },
  { key: 'canCreateEncounters', label: 'Create Encounters', helper: 'Capture field encounters and patient details' },
  { key: 'canManageInvites', label: 'Manage Invites', helper: 'Generate and share campaign invite links' },
  { key: 'canSyncData', label: 'Sync Data', helper: 'Queue and sync outreach records' },
  { key: 'canViewCampaignData', label: 'Campaign Data', helper: 'View campaign encounters and activity' },
]

const platformControlFields: Array<{
  key: keyof Pick<AdminPlatformControls, 'maintenanceMode' | 'patientSignupEnabled' | 'hospitalSignupEnabled' | 'patientPortalEnabled' | 'hospitalPortalEnabled' | 'outreachSignupEnabled' | 'outreachPortalEnabled' | 'migratePortalEnabled' | 'breakGlassEnabled' | 'uploadsEnabled'>
  label: string
  helper: string
}> = [
  { key: 'maintenanceMode', label: 'Maintenance Mode', helper: 'Blocks non-admin patient and hospital portal access' },
  { key: 'patientSignupEnabled', label: 'Patient Signup', helper: 'Allow new patient accounts to be created' },
  { key: 'hospitalSignupEnabled', label: 'Hospital Signup', helper: 'Allow new hospital or staff onboarding' },
  { key: 'patientPortalEnabled', label: 'Patient Portal', helper: 'Allow patient portal sign-in and API access' },
  { key: 'hospitalPortalEnabled', label: 'Hospital Portal', helper: 'Allow hospital portal sign-in and API access' },
  { key: 'outreachSignupEnabled', label: 'Outreach Signup', helper: 'Allow outreach campaign admins and invited workers to join' },
  { key: 'outreachPortalEnabled', label: 'Outreach Portal', helper: 'Keep outreach workspace access enabled for field teams' },
  { key: 'migratePortalEnabled', label: 'Migrate Portal', helper: 'Allow assigned staff to open protected Migrate workspaces' },
  { key: 'breakGlassEnabled', label: 'Break Glass', helper: 'Allow emergency access requests' },
  { key: 'uploadsEnabled', label: 'File Uploads', helper: 'Allow medical record file uploads' },
]

const exportFormatOptions: Array<{
  value: AdminUsersExportFormat
  label: string
  helper: string
}> = [
  { value: 'csv', label: 'CSV', helper: 'Best for spreadsheets and quick data review' },
  { value: 'xlsx', label: 'XLSX', helper: 'Best for Excel and worksheet tools' },
  { value: 'pdf', label: 'PDF', helper: 'Best for human-readable reports' },
  { value: 'txt', label: 'TXT', helper: 'Best for lightweight plain-text export' },
]

const exportScopeOptions: Array<{
  value: AdminUsersExportScope
  label: string
  helper: string
}> = [
  { value: 'selected_user', label: 'Selected user', helper: 'Export the user currently selected in the directory' },
  { value: 'search_results', label: 'Search results', helper: 'Export users matching the current HID code or email search' },
  { value: 'selected_day', label: 'Selected day', helper: 'Export users created on one specific date' },
  { value: 'last_7_days', label: 'Weekly', helper: 'Export users created in the last 7 days' },
  { value: 'last_30_days', label: 'Monthly', helper: 'Export users created in the last 30 days' },
  { value: 'all', label: 'All users', helper: 'Export the full reportable user directory' },
]

export default function AdminDashboard() {
  const [viewerEmail, setViewerEmail] = useState<string | null>(null)
  const [viewerAuthUserId, setViewerAuthUserId] = useState<string | null>(null)
  const [windowKey, setWindowKey] = useState<AdminOverviewWindow>('7d')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [directoryResults, setDirectoryResults] = useState<AdminManagedUser[]>([])
  const [deletedDirectoryResults, setDeletedDirectoryResults] = useState<AdminManagedUser[]>([])
  const [selectedDirectoryUserId, setSelectedDirectoryUserId] = useState<string | null>(null)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [deletedDirectoryLoading, setDeletedDirectoryLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [deletedDirectoryError, setDeletedDirectoryError] = useState<string | null>(null)
  const [actioning, setActioning] = useState<AdminUserManagementAction | null>(null)
  const [platformAdmins, setPlatformAdmins] = useState<AdminPlatformAdmin[]>([])
  const [canManagePlatformAdmins, setCanManagePlatformAdmins] = useState(false)
  const [staffRolePolicies, setStaffRolePolicies] = useState<AdminStaffRolePolicy[]>([])
  const [outreachRolePolicies, setOutreachRolePolicies] = useState<AdminOutreachRolePolicy[]>([])
  const [platformControls, setPlatformControls] = useState<AdminPlatformControls | null>(null)
  const [roleManagementLoading, setRoleManagementLoading] = useState(false)
  const [platformControlsLoading, setPlatformControlsLoading] = useState(false)
  const [roleManagementError, setRoleManagementError] = useState<string | null>(null)
  const [platformControlsError, setPlatformControlsError] = useState<string | null>(null)
  const [creatingAdmin, setCreatingAdmin] = useState(false)
  const [platformAdminActioning, setPlatformAdminActioning] = useState<string | null>(null)
  const [savingPlatformControls, setSavingPlatformControls] = useState(false)
  const [savingStaffRole, setSavingStaffRole] = useState<string | null>(null)
  const [savingOutreachRole, setSavingOutreachRole] = useState<string | null>(null)
  const [newAdminForm, setNewAdminForm] = useState({ fullName: '', email: '' })
  const [newAdminArtifact, setNewAdminArtifact] = useState<{ email: string; passwordSetupLink: string } | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<AdminUsersExportFormat>('csv')
  const [exportScope, setExportScope] = useState<AdminUsersExportScope>('all')
  const [exportTargetUserId, setExportTargetUserId] = useState<string | null>(null)
  const [exportQuery, setExportQuery] = useState('')
  const [exportDate, setExportDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [exportChallenge, setExportChallenge] = useState<AdminUsersExportStartResponse | null>(null)
  const [exportCode, setExportCode] = useState('')
  const [exportStarting, setExportStarting] = useState(false)
  const [exportDownloading, setExportDownloading] = useState(false)
  const [selectedStaffRole, setSelectedStaffRole] = useState('')
  const [selectedOutreachRole, setSelectedOutreachRole] = useState('')
  const [activeSection, setActiveSection] = useState('dashboard')
  const [aiProcessingOverview, setAiProcessingOverview] = useState<AdminAiProcessingOverview | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440))
  const { data, error, loading, refreshing, refresh } = useAdminDashboard(windowKey, selectedDate)

  useEffect(() => {
    void loadViewer()
    void loadDeletedDirectory()
    void loadRoleManagement()
    void loadPlatformControlsState()
    void fetchAdminAiProcessing().then(setAiProcessingOverview).catch(() => undefined)
  }, [])

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const handleScroll = () => {
      const visible = [...sidebarSections].reverse().find(section => {
        const element = document.getElementById(section.id)
        if (!element) return false
        return element.getBoundingClientRect().top <= 180
      })
      if (visible) setActiveSection(visible.id)
    }

    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (staffRolePolicies.length === 0) {
      if (selectedStaffRole) setSelectedStaffRole('')
      return
    }
    if (!selectedStaffRole || !staffRolePolicies.some(policy => policy.role === selectedStaffRole)) {
      setSelectedStaffRole(staffRolePolicies[0].role)
    }
  }, [selectedStaffRole, staffRolePolicies])

  useEffect(() => {
    if (outreachRolePolicies.length === 0) {
      if (selectedOutreachRole) setSelectedOutreachRole('')
      return
    }
    if (!selectedOutreachRole || !outreachRolePolicies.some(policy => policy.role === selectedOutreachRole)) {
      setSelectedOutreachRole(outreachRolePolicies[0].role)
    }
  }, [outreachRolePolicies, selectedOutreachRole])

  async function loadViewer() {
    const user = await getSafeUser()
    setViewerEmail(user?.email ?? null)
    setViewerAuthUserId(user?.id ?? null)
  }

  function resetExportFlow() {
    setExportChallenge(null)
    setExportCode('')
    setExportStarting(false)
    setExportDownloading(false)
  }

  function getDefaultExportScope(): AdminUsersExportScope {
    if (selectedDirectoryUserId) return 'selected_user'
    if (directoryQuery.trim()) return 'search_results'
    if (selectedDate) return 'selected_day'
    return 'all'
  }

  function buildExportFilters(): AdminUsersExportFilters {
    const trimmedQuery = exportQuery.trim()
    return {
      scope: exportScope,
      authUserId: exportScope === 'selected_user' ? (exportTargetUserId ?? null) : null,
      query: exportScope === 'search_results' ? trimmedQuery : null,
      date: exportScope === 'selected_day' ? exportDate : null,
    }
  }

  function openExportDialog() {
    setExportDialogOpen(true)
    setExportScope(getDefaultExportScope())
    setExportTargetUserId(selectedDirectoryUserId)
    setExportQuery(directoryQuery.trim())
    setExportDate(selectedDate ?? new Date().toISOString().slice(0, 10))
    resetExportFlow()
  }

  function closeExportDialog() {
    setExportDialogOpen(false)
    resetExportFlow()
  }

  async function requestExportCode() {
    if (exportStarting || exportDownloading) return

    const filters = buildExportFilters()
    if (filters.scope === 'selected_user' && !filters.authUserId) {
      showToast('Choose a user first, then export again.', 'error')
      return
    }
    if (filters.scope === 'search_results' && !filters.query) {
      showToast('Enter an HID code or email to export first.', 'error')
      return
    }
    if (filters.scope === 'selected_day' && !filters.date) {
      showToast('Choose a date to export first.', 'error')
      return
    }

    setExportStarting(true)
    try {
      const challenge = await startAdminUsersExport({
        format: exportFormat,
        filters,
      })
      setExportChallenge(challenge)
      setExportCode('')
      showToast(`Verification code sent to ${challenge.maskedEmail ?? 'your email address'}.`, 'success')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The user export could not be prepared right now.'
      showToast(message, 'error')
    } finally {
      setExportStarting(false)
    }
  }

  async function confirmExportDownload() {
    if (!exportChallenge || exportDownloading) return

    const code = exportCode.trim()
    if (code.length !== 6) {
      showToast('Enter the 6-digit verification code first.', 'error')
      return
    }

    setExportDownloading(true)
    try {
      const { blob, fileName } = await downloadAdminUsersExport({
        challengeId: exportChallenge.challengeId,
        code,
        format: exportFormat,
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      showToast('Users export downloaded successfully.', 'success')
      closeExportDialog()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The user export could not be downloaded right now.'
      showToast(message, 'error')
    } finally {
      setExportDownloading(false)
    }
  }

  async function logout() {
    await signOutAndClearSessions()
    window.location.assign(ADMIN_LOGIN_PATH)
  }

  const selectedDirectoryUser = useMemo(() => (
    directoryResults.find(item => item.id === selectedDirectoryUserId)
    ?? deletedDirectoryResults.find(item => item.id === selectedDirectoryUserId)
    ?? null
  ), [deletedDirectoryResults, directoryResults, selectedDirectoryUserId])
  const selectedStaffPolicy = useMemo(() => (
    staffRolePolicies.find(policy => policy.role === selectedStaffRole) ?? null
  ), [selectedStaffRole, staffRolePolicies])
  const selectedOutreachPolicy = useMemo(() => (
    outreachRolePolicies.find(policy => policy.role === selectedOutreachRole) ?? null
  ), [outreachRolePolicies, selectedOutreachRole])
  const selectedExportFormatOption = useMemo(() => (
    exportFormatOptions.find(option => option.value === exportFormat) ?? exportFormatOptions[0]
  ), [exportFormat])
  const selectedExportScopeOption = useMemo(() => (
    exportScopeOptions.find(option => option.value === exportScope) ?? exportScopeOptions[0]
  ), [exportScope])
  const exportCanRequest = useMemo(() => {
    if (exportScope === 'selected_user') return Boolean(exportTargetUserId)
    if (exportScope === 'search_results') return Boolean(exportQuery.trim())
    if (exportScope === 'selected_day') return Boolean(exportDate)
    return true
  }, [exportDate, exportQuery, exportScope, exportTargetUserId])
  const exportScopeSummary = useMemo(() => {
    if (exportScope === 'selected_user') {
      if (!selectedDirectoryUser) return 'No user is selected right now.'
      const label = selectedDirectoryUser.patient?.fullName ?? selectedDirectoryUser.staff?.fullName ?? selectedDirectoryUser.profile?.displayName ?? selectedDirectoryUser.email ?? 'Selected user'
      const extra = selectedDirectoryUser.patient?.hidCode ?? selectedDirectoryUser.email ?? 'No email'
      return `${label} • ${extra}`
    }
    if (exportScope === 'search_results') {
      return exportQuery.trim() ? `Matches for "${exportQuery.trim()}"` : 'Enter a search query to export matching users.'
    }
    if (exportScope === 'selected_day') {
      return exportDate ? `Users created on ${formatDayLabel(exportDate) ?? exportDate}` : 'Choose a date to export.'
    }
    if (exportScope === 'last_7_days') return 'Users created in the last 7 days.'
    if (exportScope === 'last_30_days') return 'Users created in the last 30 days.'
    return 'All reportable users.'
  }, [exportDate, exportQuery, exportScope, selectedDirectoryUser])
  const visibleDeletedDirectoryResults = useMemo(() => (
    deletedDirectoryResults.filter(item => !directoryResults.some(directoryItem => directoryItem.id === item.id))
  ), [deletedDirectoryResults, directoryResults])

  async function loadDeletedDirectory(force = false) {
    setDeletedDirectoryLoading(true)
    setDeletedDirectoryError(null)
    try {
      const matches = await fetchDeletedAdminUsers({ force })
      setDeletedDirectoryResults(matches)
      setSelectedDirectoryUserId(current => {
        if (current && (directoryResults.some(item => item.id === current) || matches.some(item => item.id === current))) {
          return current
        }
        return current
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Deleted accounts could not be loaded right now.'
      setDeletedDirectoryError(message)
    } finally {
      setDeletedDirectoryLoading(false)
    }
  }

  async function loadRoleManagement(force = false) {
    setRoleManagementLoading(true)
    setRoleManagementError(null)
    try {
      const response = await fetchAdminRoleManagement({ force })
      setPlatformAdmins(response.admins)
      setCanManagePlatformAdmins(response.canManagePlatformAdmins)
      setStaffRolePolicies(response.staffRolePolicies)
      setOutreachRolePolicies(response.outreachRolePolicies ?? [])
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Admin role settings could not be loaded right now.'
      setRoleManagementError(message)
    } finally {
      setRoleManagementLoading(false)
    }
  }

  async function loadPlatformControlsState(force = false) {
    setPlatformControlsLoading(true)
    setPlatformControlsError(null)
    try {
      const controls = await fetchAdminPlatformControls({ force })
      setPlatformControls(controls)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Platform controls could not be loaded right now.'
      setPlatformControlsError(message)
    } finally {
      setPlatformControlsLoading(false)
    }
  }

  async function runDirectorySearch(force = false) {
    const trimmed = directoryQuery.trim()
    if (!trimmed) {
      setDirectoryResults([])
      setSelectedDirectoryUserId(null)
      setDirectoryError('Enter an HID code or email to search.')
      return
    }

    setDirectoryLoading(true)
    setDirectoryError(null)
    try {
      const matches = await searchAdminUsers(trimmed, { force })
      setDirectoryResults(matches)
      setSelectedDirectoryUserId(current => {
        if (matches.length === 0) return null
        if (current && matches.some(item => item.id === current)) return current
        return matches[0].id
      })
      if (matches.length === 0) {
        setDirectoryError('No user matched that HID code or email.')
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The user directory could not be loaded right now.'
      setDirectoryError(message)
      showToast(message, 'error')
    } finally {
      setDirectoryLoading(false)
    }
  }

  async function handleCreatePlatformAdmin() {
    const email = newAdminForm.email.trim().toLowerCase()
    const fullName = newAdminForm.fullName.trim()

    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      showToast('Enter a valid admin email address first.', 'error')
      return
    }

    setCreatingAdmin(true)
    try {
      const created = await createPlatformAdmin(email, fullName || email.split('@')[0] || 'Platform Admin')
      setPlatformAdmins(current => {
        const next = [...current.filter(item => item.authUserId !== created.admin.authUserId), created.admin]
        return next.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
      })
      setNewAdminArtifact({
        email: created.admin.email ?? email,
        passwordSetupLink: created.passwordSetupLink,
      })
      setNewAdminForm({ fullName: '', email: '' })
      showToast('Platform admin created. Share the password setup link shown below.', 'success')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The platform admin could not be created right now.'
      showToast(message, 'error')
    } finally {
      setCreatingAdmin(false)
    }
  }

  async function handlePlatformAdminAction(admin: AdminPlatformAdmin, action: AdminPlatformAdminAction) {
    const actionLabel = action === 'lock_admin'
      ? 'limit access for this platform admin'
      : action === 'unlock_admin'
        ? 'restore access for this platform admin'
        : action === 'delete_admin'
          ? 'delete this platform admin account'
          : action === 'restore_admin'
            ? 'restore this deleted platform admin account'
            : 'permanently delete this platform admin account and all of its account data'

    if (!window.confirm(`Do you want to ${actionLabel}?`)) return

    setPlatformAdminActioning(`${admin.authUserId}:${action}`)
    try {
      const result = await applyPlatformAdminAction(admin.authUserId, action)
      if (result.deletedAuthUserId) {
        setPlatformAdmins(current => current.filter(item => item.authUserId !== result.deletedAuthUserId))
      } else if (result.admin) {
        const updatedAdmin = result.admin
        setPlatformAdmins(current => current.map(item => (
          item.authUserId === updatedAdmin.authUserId ? updatedAdmin : item
        )))
      }
      showToast(
        action === 'lock_admin'
          ? 'Platform admin access limited successfully.'
          : action === 'unlock_admin'
            ? 'Platform admin access restored successfully.'
            : action === 'delete_admin'
              ? 'Platform admin account deleted successfully. It can now be restored or permanently deleted.'
              : action === 'restore_admin'
                ? 'Platform admin account restored successfully.'
                : 'Platform admin account permanently deleted successfully.',
        'success',
      )
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The platform admin access change could not be completed right now.'
      showToast(message, 'error')
    } finally {
      setPlatformAdminActioning(null)
    }
  }

  function updateStaffRolePolicyDraft(role: string, field: keyof Pick<AdminStaffRolePolicy, 'canOpenDashboard' | 'canUseStandardAccess' | 'canViewPatientRecords' | 'canCreateRecords' | 'canUseBreakGlass' | 'canViewHistory'>, value: boolean) {
    setStaffRolePolicies(current => current.map(policy => (
      policy.role === role ? { ...policy, [field]: value } : policy
    )))
  }

  function updateOutreachRolePolicyDraft(role: string, field: keyof Pick<AdminOutreachRolePolicy, 'canOpenWorkspace' | 'canCreateEncounters' | 'canManageInvites' | 'canSyncData' | 'canViewCampaignData'>, value: boolean) {
    setOutreachRolePolicies(current => current.map(policy => (
      policy.role === role ? { ...policy, [field]: value } : policy
    )))
  }

  async function saveStaffRolePolicy(role: string) {
    const policy = staffRolePolicies.find(item => item.role === role)
    if (!policy) return

    setSavingStaffRole(role)
    try {
      const updated = await updateAdminStaffRolePolicy(role, {
        canOpenDashboard: policy.canOpenDashboard,
        canUseStandardAccess: policy.canUseStandardAccess,
        canViewPatientRecords: policy.canViewPatientRecords,
        canCreateRecords: policy.canCreateRecords,
        canUseBreakGlass: policy.canUseBreakGlass,
        canViewHistory: policy.canViewHistory,
      })
      setStaffRolePolicies(current => current.map(item => item.role === role ? updated : item))
      showToast(`${role} RBAC updated successfully.`, 'success')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The RBAC definition could not be updated right now.'
      showToast(message, 'error')
      void loadRoleManagement(true)
    } finally {
      setSavingStaffRole(null)
    }
  }

  async function saveOutreachRolePolicy(role: string) {
    const policy = outreachRolePolicies.find(item => item.role === role)
    if (!policy) return

    setSavingOutreachRole(role)
    try {
      const updated = await updateAdminOutreachRolePolicy(role, {
        canOpenWorkspace: policy.canOpenWorkspace,
        canCreateEncounters: policy.canCreateEncounters,
        canManageInvites: policy.canManageInvites,
        canSyncData: policy.canSyncData,
        canViewCampaignData: policy.canViewCampaignData,
      })
      setOutreachRolePolicies(current => current.map(item => item.role === role ? updated : item))
      showToast(`${role} outreach RBAC updated successfully.`, 'success')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The outreach RBAC definition could not be updated right now.'
      showToast(message, 'error')
      void loadRoleManagement(true)
    } finally {
      setSavingOutreachRole(null)
    }
  }

  async function savePlatformControls() {
    if (!platformControls) return

    setSavingPlatformControls(true)
    try {
      const updated = await updateAdminPlatformControls({
        maintenanceMode: platformControls.maintenanceMode,
        patientSignupEnabled: platformControls.patientSignupEnabled,
        hospitalSignupEnabled: platformControls.hospitalSignupEnabled,
        patientPortalEnabled: platformControls.patientPortalEnabled,
        hospitalPortalEnabled: platformControls.hospitalPortalEnabled,
        outreachSignupEnabled: platformControls.outreachSignupEnabled,
        outreachPortalEnabled: platformControls.outreachPortalEnabled,
        migratePortalEnabled: platformControls.migratePortalEnabled,
        breakGlassEnabled: platformControls.breakGlassEnabled,
        uploadsEnabled: platformControls.uploadsEnabled,
      })
      setPlatformControls(updated)
      showToast('Platform controls updated successfully.', 'success')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Platform controls could not be updated right now.'
      showToast(message, 'error')
      void loadPlatformControlsState(true)
    } finally {
      setSavingPlatformControls(false)
    }
  }

  async function handleDirectoryAction(action: AdminUserManagementAction) {
    if (!selectedDirectoryUser) return

    const actionLabels: Record<AdminUserManagementAction, string> = {
      close_patient_access: 'close this patient access',
      delete_account: 'delete this account',
      lock_profile: 'lock this profile',
      permanently_delete_account: 'permanently delete this account and its stored data',
      restore_account: 'restore this account',
      restore_staff_access: 'restore this hospital access',
      restrict_staff_access: 'restrict this hospital access',
      unlock_profile: 'unlock this profile',
    }

    const confirmed = window.confirm(`Do you want to ${actionLabels[action]}?`)
    if (!confirmed) return

    setActioning(action)
    try {
      const result = await applyAdminUserAction(selectedDirectoryUser.id, action)
      if (result.permanentlyDeleted) {
        setDirectoryResults(current => current.filter(item => item.id !== result.targetAuthUserId))
        setDeletedDirectoryResults(current => current.filter(item => item.id !== result.targetAuthUserId))
        setSelectedDirectoryUserId(null)
        showToast('Account permanently deleted successfully.', 'success')
      } else if (result.deleted) {
        if (result.user) {
          const nextUser = result.user
          setDirectoryResults(current => current.map(item => item.id === nextUser.id ? nextUser : item))
          setDeletedDirectoryResults(current => {
            const existingIndex = current.findIndex(item => item.id === nextUser.id)
            if (existingIndex >= 0) {
              return current.map(item => item.id === nextUser.id ? nextUser : item)
            }
            return [nextUser, ...current].slice(0, 20)
          })
          setSelectedDirectoryUserId(nextUser.id)
        }
        showToast('Account deleted successfully.', 'success')
      } else if (result.user) {
        const nextUser = result.user
        setDirectoryResults(current => {
          const existingIndex = current.findIndex(item => item.id === nextUser.id)
          if (existingIndex >= 0) {
            return current.map(item => item.id === nextUser.id ? nextUser : item)
          }
          return action === 'restore_account' ? [nextUser, ...current] : current
        })
        setDeletedDirectoryResults(current => {
          if (action === 'restore_account') {
            return current.filter(item => item.id !== nextUser.id)
          }
          return current.map(item => item.id === nextUser.id ? nextUser : item)
        })
        setSelectedDirectoryUserId(nextUser.id)
        const successMessage =
          action === 'lock_profile' ? 'Profile locked successfully.'
            : action === 'unlock_profile' ? 'Profile unlocked successfully.'
              : action === 'restore_account' ? 'Account restored successfully.'
              : action === 'restrict_staff_access' ? 'Hospital access restricted successfully.'
                : action === 'restore_staff_access' ? 'Hospital access restored successfully.'
                  : action === 'close_patient_access' ? 'Patient access closed successfully.'
                    : 'Account updated successfully.'
        showToast(successMessage, 'success')
      }
      await Promise.all([refresh(true), loadDeletedDirectory(true)])
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'This admin action could not be completed right now.'
      showToast(message, 'error')
    } finally {
      setActioning(null)
    }
  }

  const filteredUsers = useMemo(() => (
    (data?.users.recentUsers ?? []).filter(user => matchesQuery([user.email, user.name, user.role], searchQuery))
  ), [data?.users.recentUsers, searchQuery])

  const filteredUploads = useMemo(() => (
    (data?.records.recentUploads ?? []).filter(upload => matchesQuery([upload.fileName, upload.fileType, upload.uploadedBy, upload.uploadedFor], searchQuery))
  ), [data?.records.recentUploads, searchQuery])

  const filteredAlerts = useMemo(() => (
    (data?.alerts ?? []).filter(alert => matchesQuery([alert.title, alert.message, alert.level], searchQuery))
  ), [data?.alerts, searchQuery])

  const filteredIssues = useMemo(() => (
    (data?.sentry.recentIssues ?? []).filter(issue => matchesQuery([issue.title, issue.culprit, issue.level, issue.status], searchQuery))
  ), [data?.sentry.recentIssues, searchQuery])
  const sentryLevelSignals = useMemo(() => (
    (data?.sentry.issuesByLevel ?? []).filter(item => matchesQuery([item.label, item.helper], searchQuery))
  ), [data?.sentry.issuesByLevel, searchQuery])
  const sentryStatusSignals = useMemo(() => (
    (data?.sentry.issuesByStatus ?? []).filter(item => matchesQuery([item.label, item.helper], searchQuery))
  ), [data?.sentry.issuesByStatus, searchQuery])
  const sentryHotspots = useMemo(() => (
    (data?.sentry.topCulprits ?? []).filter(item => matchesQuery([item.label, item.helper], searchQuery))
  ), [data?.sentry.topCulprits, searchQuery])

  const filteredEvents = useMemo(() => (
    (data?.posthog.topEvents ?? [])
      .filter(event => !POSTHOG_WEB_SIGNAL_EVENT_KEYS.has(normalizePosthogEventKey(event.name)))
      .filter(event => matchesQuery([event.name], searchQuery))
  ), [data?.posthog.topEvents, searchQuery])
  const posthogWebSignals = useMemo(() => (
    [
      { key: 'pageviews', label: 'Pageviews', value: data?.posthog.pageviews ?? null, helper: 'Tracked web page views' },
      { key: 'autocaptures', label: 'Autocapture', value: data?.posthog.autocaptures ?? null, helper: 'Captured browser interactions' },
      { key: 'identifies', label: 'Identify Calls', value: data?.posthog.identifies ?? null, helper: 'Identity association events' },
      { key: 'webVitals', label: 'Web Vitals', value: data?.posthog.webVitals ?? null, helper: 'Frontend performance signals' },
    ].filter(signal => matchesQuery([signal.label, signal.helper], searchQuery))
  ), [data?.posthog.autocaptures, data?.posthog.identifies, data?.posthog.pageviews, data?.posthog.webVitals, searchQuery])

  const notificationsCount = filteredAlerts.filter(alert => alert.level !== 'info').length
  const verifiedRate = data?.users.totalUsers ? (data.users.verifiedUsers / data.users.totalUsers) * 100 : null
  const activeOverviewDate = data?.selectedDate ?? selectedDate
  const activeOverviewDayLabel = formatDayLabel(activeOverviewDate)
  const sentryConfigured = Boolean(data?.sentry.configured)
  const posthogConfigured = Boolean(data?.posthog.configured)
  const otpSuccessLabel = data?.security.otpSuccessRate == null ? 'No recent OTP activity' : 'Verification completion rate'
  const otpSuccessHelper = data?.security.otpSuccessRate == null ? 'This updates after signup or reset OTP events are recorded.' : 'OTP completion performance'
  const deploymentReadinessCards = [
    { label: 'Frontend Hosting', value: 'Cloudflare Worker deployment requires external verification.', ready: false },
    { label: 'Domain & Edge', value: 'DNS, TLS, and custom-domain activation are externally pending.', ready: false },
    { label: 'Backend', value: 'Identity API remains the only backend for admin, patient, and hospital flows.', ready: true },
  ]
  const observabilityCards = [
    {
      label: 'Sentry',
      ready: sentryConfigured,
      value: sentryConfigured ? `Connected to ${data?.sentry.projectLabel ?? 'configured project'}.` : (data?.sentry.message ?? 'Sentry is not configured yet.'),
    },
    {
      label: 'PostHog',
      ready: posthogConfigured,
      value: posthogConfigured ? `Connected to ${data?.posthog.projectLabel ?? 'configured project'}.` : (data?.posthog.message ?? 'PostHog is not configured yet.'),
    },
  ]

  const metricGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
    gap: 10,
  }
  const dualChartStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: viewportWidth < 1180 ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: 12,
  }
  const splitPanelStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: viewportWidth < 1180 ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: 12,
  }
  const tableGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: viewportWidth < 1180 ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: 12,
  }

  if (loading && !data) {
    return <PageLoader label="Preparing the admin dashboard..." />
  }

  const normalizedError = error?.toLowerCase() ?? ''
  const unauthorized = normalizedError.includes('permission')
  const authRequired = normalizedError.includes('sign in') || normalizedError.includes('401')
  const overviewUnavailable = Boolean(!data && error && !unauthorized && !authRequired)

  if (!loading && !data && (unauthorized || authRequired)) {
    return (
      <AdminLayout
        activeSection={activeSection}
        darkMode={false}
        notificationsCount={0}
        onNotificationsClick={() => undefined}
        onLogout={() => { void logout() }}
        onSearchChange={setSearchQuery}
        onToggleTheme={() => undefined}
        searchQuery={searchQuery}
        sections={sidebarSections}
        title="Dashboard"
        userName={viewerEmail}
      >
        <div style={panelStyle()}>
          <EmptyState
            icon={(
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                <rect x="7" y="7" width="26" height="26" rx="8" stroke="currentColor" strokeWidth="1.6" />
                <path d="M20 14v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="20" cy="26" r="1.6" fill="currentColor" />
              </svg>
            )}
            title={unauthorized ? 'Admin access is limited to platform admins.' : 'Sign in to open the admin dashboard.'}
            description={unauthorized
              ? 'Promote your user profile to the platform_admin role, then refresh this page to continue.'
              : 'Sign in again and refresh this page to continue.'}
          />
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
            <Button onClick={() => { void refresh().catch(() => undefined) }}>Retry</Button>
            {authRequired
              ? <Button variant="outline" onClick={() => window.location.assign(ADMIN_LOGIN_PATH)}>Admin sign in</Button>
              : <Button variant="outline" onClick={() => window.location.assign('/')}>Go home</Button>}
          </div>
        </div>
      </AdminLayout>
    )
  }

  return (
    <AdminLayout
      activeSection={activeSection}
      darkMode={false}
      notificationsCount={notificationsCount}
      onNotificationsClick={() => document.getElementById('security')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      onLogout={() => { void logout() }}
      onSearchChange={setSearchQuery}
      onToggleTheme={() => undefined}
      searchQuery={searchQuery}
      sections={sidebarSections}
      title="Dashboard"
      userName={viewerEmail}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {overviewUnavailable && (
          <div style={{ ...alertToneStyle('warning'), borderRadius: 12, padding: '12px 14px', fontSize: 11.5, lineHeight: 1.6 }}>
            The admin overview could not be loaded right now, but admin controls below remain available. Refresh the overview when you want live metrics back.
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, color: 'var(--admin-muted)' }}>
            Updated {formatRelativeTime(data?.checkedAt ?? null)}
            {activeOverviewDayLabel ? ` • Overview for ${activeOverviewDayLabel}` : ''}
            {searchQuery ? ` • Filtered by "${searchQuery}"` : ''}
            {error ? ' • Live data issue detected' : ''}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {windowOptions.map(option => (
              <button
                key={option.key}
                onClick={() => {
                  setSelectedDate(null)
                  setWindowKey(option.key)
                }}
                style={{
                  border: '1px solid var(--admin-border)',
                  background: option.key === windowKey && !activeOverviewDate ? 'rgba(26, 111, 212, 0.08)' : '#fff',
                  color: option.key === windowKey && !activeOverviewDate ? 'var(--admin-accent)' : 'var(--admin-muted)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  fontSize: 10.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {option.label}
              </button>
            ))}
            <input
              type="date"
              value={selectedDate ?? ''}
              max={new Date().toISOString().slice(0, 10)}
              onChange={event => setSelectedDate(event.target.value || null)}
              style={{
                height: 34,
                borderRadius: 8,
                border: '1px solid var(--admin-border)',
                padding: '0 10px',
                fontSize: 11.5,
                background: '#fff',
                color: 'var(--admin-text)',
              }}
            />
            {activeOverviewDate && (
              <Button size="sm" variant="outline" onClick={() => setSelectedDate(null)}>
                Clear Day
              </Button>
            )}
            <Button size="sm" variant="outline" loading={refreshing} onClick={() => { void refresh().catch(() => undefined) }}>
              Refresh
            </Button>
          </div>
        </div>

        <section id="dashboard" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            {sectionLabel('User Metrics')}
            <div style={metricGridStyle}>
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('users')} title="Total Users" value={data?.users.totalUsers ?? null} trendLabel={`+${formatCompact(data?.users.newSignupsWindow ?? null)} in selected range`} trendTone="positive" helper="All registered users" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('users')} title="Total Patients" value={data?.users.totalPatients ?? null} trendLabel={`${formatCompact(data?.users.totalUsers ?? null)} total users`} trendTone="positive" helper="Registered patient accounts" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('plus')} title={activeOverviewDate ? 'New Signups On Day' : 'New Signups Today'} value={data?.users.newSignupsToday ?? null} trendLabel={`${formatCompact(data?.users.newSignupsWindow ?? null)} this range`} trendTone="positive" helper={activeOverviewDate ? 'New accounts created on the selected day' : 'New accounts created today'} />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('activity')} title={activeOverviewDate ? 'Active On Day' : 'Active (24h)'} value={data?.users.activeUsers24h ?? null} trendLabel={`${formatCompact(data?.users.activeUsersWindow ?? null)} in selected range`} trendTone="critical" helper={activeOverviewDate ? 'Users active on the selected day' : 'Users active in the last day'} />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('check')} title="Verified Users" value={verifiedRate} valueFormatter={formatPercentage} trendLabel={`${formatCompact(data?.users.unverifiedUsers ?? null)} pending`} trendTone="positive" helper="Verified vs unverified accounts" />
            </div>
          </div>

          <div>
            {sectionLabel('Records & Providers')}
            <div style={metricGridStyle}>
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('records')} title="Total Records" value={data?.records.totalRecords ?? null} trendLabel={`${formatCompact(data?.records.uploadedToday ?? null)} uploaded today`} trendTone="positive" helper="All records stored" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('upload')} title="Uploaded Today" value={data?.records.uploadedToday ?? null} trendLabel={`${formatCompact(data?.providers.recordsUploadedByProviders ?? null)} by providers`} trendTone="positive" helper="Records added today" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('average')} title="Avg per User" value={data?.records.averagePerUser ?? null} valueFormatter={value => value == null ? 'N/A' : value.toFixed(1)} trendLabel={`${formatCompact(data?.users.totalUsers ?? null)} users`} trendTone="positive" helper="Average records per user" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('storage')} title="Storage Used" value={data?.records.storageBytes ?? null} valueFormatter={formatStorage} trendLabel="Attachment footprint" trendTone="neutral" helper="Total storage usage" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('providers')} title="Total Providers" value={data?.providers.totalProviders ?? null} trendLabel={`${formatCompact(data?.providers.totalOrganizations ?? null)} organizations`} trendTone="positive" helper="Hospitals and clinicians onboarded" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('provider-active')} title="Active Providers" value={data?.providers.activeProviders ?? null} trendLabel={`${formatCompact(data?.providers.recordsUploadedByProviders ?? null)} uploads`} trendTone="positive" helper="Providers currently active" />
            </div>
          </div>

          <div>
            {sectionLabel('HID Migrate & AI Infrastructure')}
            <div style={metricGridStyle}>
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('records')} title="Patients Migrated" value={aiProcessingOverview?.migrate.patients_migrated ?? null} trendLabel={`${formatCompact(aiProcessingOverview?.migrate.pages_processed ?? null)} pages processed`} trendTone="positive" helper="Canonical patients with completed migration imports" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('activity')} title="Processing Health" value={aiProcessingOverview ? 1 : null} valueFormatter={() => aiProcessingOverview ? formatRoleLabel(aiProcessingOverview.processing.health) : 'N/A'} trendLabel={`${formatCompact(aiProcessingOverview?.processing.queued ?? null)} queued`} trendTone={aiProcessingOverview?.processing.health === 'healthy' ? 'positive' : 'critical'} helper="OCR and AI durable-job health" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('api')} title="Providers Online" value={aiProcessingOverview?.providers.filter(provider => provider.status === 'active' && provider.last_success_at).length ?? null} trendLabel={`${formatCompact(aiProcessingOverview?.providers.length ?? null)} configured`} trendTone="positive" helper="Providers with a successful real connection test" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('analytics')} title="AI Spend This Month" value={aiProcessingOverview?.usage.month.estimated_cost_minor ?? null} valueFormatter={value => value == null ? 'N/A' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value / 100)} trendLabel={`${formatCompact(aiProcessingOverview?.usage.month.requests ?? null)} requests`} trendTone="neutral" helper="Estimated usage-event cost" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
              <Button size="sm" variant="outline" onClick={() => window.location.assign('/eminence/ai-processing')}>
                View AI & Processing
              </Button>
            </div>
          </div>
        </section>

        <section id="users" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={panelStyle()}>
            {sectionLabel('User Controls')}
            {sectionTitle('User Directory')}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', lineHeight: 1.6, maxWidth: 680 }}>
                Search by HID code or email to inspect a user profile, lock or unlock the profile, manage staff access, close patient access, delete the account, or restore a deleted account.
                Use export if you need a secure offline copy of the current user directory.
              </div>
              <Button variant="outline" onClick={openExportDialog}>
                Export Users
              </Button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
              <input
                value={directoryQuery}
                onChange={event => {
                  setDirectoryQuery(event.target.value)
                  if (directoryError) setDirectoryError(null)
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void runDirectorySearch()
                  }
                }}
                placeholder="Search by HID code or email"
                style={{
                  flex: '1 1 320px',
                  minWidth: 240,
                  height: 42,
                  borderRadius: 10,
                  border: '1px solid var(--admin-border)',
                  padding: '0 14px',
                  fontSize: 14,
                  background: '#fff',
                  color: 'var(--admin-text)',
                  outline: 'none',
                }}
              />
              <Button onClick={() => void runDirectorySearch()} loading={directoryLoading}>
                Search
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setDirectoryQuery('')
                  setDirectoryResults([])
                  setSelectedDirectoryUserId(null)
                  setDirectoryError(null)
                }}
              >
                Clear
              </Button>
            </div>
            {directoryError && (
              <div style={{ ...alertToneStyle('warning'), borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 11.5 }}>
                {directoryError}
              </div>
            )}
            {deletedDirectoryError && (
              <div style={{ ...alertToneStyle('warning'), borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 11.5 }}>
                {deletedDirectoryError}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: viewportWidth < 1180 ? '1fr' : 'minmax(280px, 360px) minmax(0, 1fr)', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {directoryResults.length === 0 ? (
                  <EmptyState
                    icon={<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="14" cy="14" r="7.5" stroke="currentColor" strokeWidth="1.5" /><path d="m19.5 19.5 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>}
                    title="Search for a user"
                    description="Results will appear here after you search with a HID code or email."
                  />
                ) : (
                  directoryResults.map(item => {
                    const selected = selectedDirectoryUserId === item.id
                    const primaryLabel = item.patient?.fullName ?? item.staff?.fullName ?? item.profile?.displayName ?? item.email ?? 'Unknown user'
                    const secondaryLabel = item.patient?.hidCode ?? item.email ?? 'No email'
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedDirectoryUserId(item.id)}
                        style={{
                          border: `1px solid ${selected ? 'rgba(26, 111, 212, 0.28)' : 'var(--admin-border)'}`,
                          borderRadius: 12,
                          background: selected ? 'rgba(26, 111, 212, 0.06)' : '#fff',
                          padding: '12px 14px',
                          textAlign: 'left',
                          cursor: 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--admin-text)', wordBreak: 'break-word' }}>{primaryLabel}</div>
                            <div style={{ fontSize: 11, color: 'var(--admin-muted)', marginTop: 2, wordBreak: 'break-word' }}>{secondaryLabel}</div>
                          </div>
                          <Badge color={item.flags.deleted ? 'amber' : item.flags.locked ? 'red' : 'green'}>
                            {item.flags.deleted ? 'deleted' : item.flags.locked ? 'locked' : 'active'}
                          </Badge>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {item.profile?.appRole && <Badge color="blue">{item.profile.appRole}</Badge>}
                          {item.patient && <Badge color="green">patient</Badge>}
                          {item.staff && <Badge color={item.flags.staffAccessRestricted ? 'amber' : 'green'}>{item.flags.staffAccessRestricted ? 'restricted staff' : 'staff'}</Badge>}
                        </div>
                      </button>
                    )
                  })
                )}
                <div style={{ borderTop: '1px solid var(--admin-border)', marginTop: 6, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--admin-text)' }}>Deleted Accounts</div>
                    <Button size="sm" variant="outline" loading={deletedDirectoryLoading} onClick={() => { void loadDeletedDirectory(true) }}>
                      Refresh
                    </Button>
                  </div>
                  {visibleDeletedDirectoryResults.length === 0 ? (
                    <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', border: '1px dashed var(--admin-border)', borderRadius: 10, padding: '12px 14px' }}>
                      No deleted accounts are waiting in the admin directory.
                    </div>
                  ) : (
                    visibleDeletedDirectoryResults.map(item => {
                      const selected = selectedDirectoryUserId === item.id
                      const primaryLabel = item.patient?.fullName ?? item.staff?.fullName ?? item.profile?.displayName ?? item.email ?? 'Unknown user'
                      const deletedAt = item.profile?.deletedAt ?? null
                      return (
                        <button
                          key={`deleted-${item.id}`}
                          type="button"
                          onClick={() => setSelectedDirectoryUserId(item.id)}
                          style={{
                            border: `1px solid ${selected ? 'rgba(245, 158, 11, 0.30)' : 'var(--admin-border)'}`,
                            borderRadius: 12,
                            background: selected ? 'rgba(245, 158, 11, 0.06)' : '#fffdf8',
                            padding: '12px 14px',
                            textAlign: 'left',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--admin-text)', wordBreak: 'break-word' }}>{primaryLabel}</div>
                              <div style={{ fontSize: 11, color: 'var(--admin-muted)', marginTop: 2, wordBreak: 'break-word' }}>
                                {item.patient?.hidCode ?? item.email ?? 'No email'}{deletedAt ? ` • deleted ${formatRelativeTime(deletedAt)}` : ''}
                              </div>
                            </div>
                            <Badge color="amber">deleted</Badge>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {item.profile?.appRole && <Badge color="blue">{item.profile.appRole}</Badge>}
                            {item.patient && <Badge color="green">patient</Badge>}
                            {item.staff && <Badge color="amber">staff</Badge>}
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>

              <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, background: '#fbfdff', padding: 14 }}>
                {!selectedDirectoryUser ? (
                  <EmptyState
                    icon={<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="11" r="5" stroke="currentColor" strokeWidth="1.5" /><path d="M7 26c1-4 5-6 9-6s8 2 9 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>}
                    title="Choose a user"
                    description="Select a result to inspect the profile and manage the account."
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--admin-text)', overflowWrap: 'anywhere' }}>
                          {selectedDirectoryUser.patient?.fullName ?? selectedDirectoryUser.staff?.fullName ?? selectedDirectoryUser.profile?.displayName ?? selectedDirectoryUser.email ?? 'Unknown user'}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--admin-muted)', marginTop: 4, overflowWrap: 'anywhere' }}>
                          {selectedDirectoryUser.patient?.hidCode ? `${selectedDirectoryUser.patient.hidCode} • ` : ''}
                          {selectedDirectoryUser.email ?? 'No email available'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {selectedDirectoryUser.profile?.appRole && <Badge color="blue">{selectedDirectoryUser.profile.appRole}</Badge>}
                        <Badge color={selectedDirectoryUser.flags.deleted ? 'amber' : selectedDirectoryUser.flags.locked ? 'red' : 'green'}>
                          {selectedDirectoryUser.flags.deleted ? 'Deleted' : selectedDirectoryUser.flags.locked ? 'Locked' : 'Active'}
                        </Badge>
                        {selectedDirectoryUser.staff && (
                          <Badge color={selectedDirectoryUser.flags.staffAccessRestricted ? 'amber' : 'green'}>
                            {selectedDirectoryUser.flags.staffAccessRestricted ? 'Access Restricted' : 'Access Open'}
                          </Badge>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                      <div style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px' }}>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Unread Notifications</div>
                        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{formatCompact(selectedDirectoryUser.stats.unreadNotificationCount)}</div>
                      </div>
                      <div style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px' }}>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Grants</div>
                        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{formatCompact(selectedDirectoryUser.stats.activeGrantCount)}</div>
                      </div>
                      <div style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px' }}>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Records</div>
                        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{formatCompact(selectedDirectoryUser.stats.recordCount)}</div>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: viewportWidth < 1180 ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
                      <div style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '12px 14px' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Profile</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                          <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Role</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.profile?.appRole)}</div></div>
                          <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Deleted</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{selectedDirectoryUser.profile?.deletedAt ? formatRelativeTime(selectedDirectoryUser.profile.deletedAt) : 'No'}</div></div>
                          <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>MFA Required</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{selectedDirectoryUser.profile ? formatBool(selectedDirectoryUser.profile.mfaRequired) : 'Not available'}</div></div>
                          <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Email Confirmed</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{selectedDirectoryUser.emailConfirmedAt ? formatRelativeTime(selectedDirectoryUser.emailConfirmedAt) : 'No'}</div></div>
                          <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Last Sign In</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatRelativeTime(selectedDirectoryUser.lastSignInAt)}</div></div>
                          <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Created</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatRelativeTime(selectedDirectoryUser.profile?.createdAt ?? null)}</div></div>
                          <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Updated</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatRelativeTime(selectedDirectoryUser.profile?.updatedAt ?? null)}</div></div>
                          <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Delete Reason</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.profile?.deletedReason)}</div></div>
                          <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Restored</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{selectedDirectoryUser.profile?.restoredAt ? formatRelativeTime(selectedDirectoryUser.profile.restoredAt) : 'Not yet'}</div></div>
                        </div>
                      </div>

                      <div style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '12px 14px' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>{selectedDirectoryUser.patient ? 'Patient Details' : selectedDirectoryUser.staff ? 'Staff Details' : 'Account Details'}</div>
                        {selectedDirectoryUser.patient ? (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Phone</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.patient.phone)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Gender</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.patient.gender)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Date of Birth</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.patient.dateOfBirth)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Profile Completion</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{selectedDirectoryUser.patient.profilePercent}%</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Country</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.patient.country)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>State</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.patient.state)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Emergency Contact</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.patient.emergencyContactName)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Emergency Phone</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.patient.emergencyContactPhone)}</div></div>
                          </div>
                        ) : selectedDirectoryUser.staff ? (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Hospital Name</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.staff.hospitalName)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Role</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.staff.role)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Phone</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.staff.phone)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Verification</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.staff.verificationStatus)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>License</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{formatLabelValue(selectedDirectoryUser.staff.licenseNumber)}</div></div>
                            <div style={{ minWidth: 0 }}><div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Memberships</div><div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{selectedDirectoryUser.staff.activeMembershipCount} active / {selectedDirectoryUser.staff.inactiveMembershipCount} inactive</div></div>
                          </div>
                        ) : (
                          <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>
                            No patient or hospital profile is attached to this account.
                          </div>
                        )}
                      </div>
                    </div>

                    {selectedDirectoryUser.staff && selectedDirectoryUser.staff.memberships.length > 0 && (
                      <div style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '12px 14px' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Hospital Memberships</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {selectedDirectoryUser.staff.memberships.map(membership => (
                            <div key={membership.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{membership.organizationName ?? 'Unknown organization'}</div>
                                <div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>
                                  {membership.membershipRole} • {membership.appRole}{membership.isPrimary ? ' • primary' : ''}
                                </div>
                              </div>
                              <Badge color={membership.active ? 'green' : 'amber'}>{membership.active ? 'active' : 'inactive'}</Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '12px 14px' }}>
                      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Admin Actions</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                        {!selectedDirectoryUser.flags.deleted && (
                          <>
                            <Button
                              variant={selectedDirectoryUser.flags.locked ? 'secondary' : 'outline'}
                              loading={actioning === (selectedDirectoryUser.flags.locked ? 'unlock_profile' : 'lock_profile')}
                              onClick={() => void handleDirectoryAction(selectedDirectoryUser.flags.locked ? 'unlock_profile' : 'lock_profile')}
                              disabled={!selectedDirectoryUser.flags.lockable}
                            >
                              {selectedDirectoryUser.flags.locked ? 'Unlock Profile' : 'Lock Profile'}
                            </Button>
                            {selectedDirectoryUser.staff && (
                              <Button
                                variant={selectedDirectoryUser.flags.staffAccessRestricted ? 'secondary' : 'outline'}
                                loading={actioning === (selectedDirectoryUser.flags.staffAccessRestricted ? 'restore_staff_access' : 'restrict_staff_access')}
                                onClick={() => void handleDirectoryAction(selectedDirectoryUser.flags.staffAccessRestricted ? 'restore_staff_access' : 'restrict_staff_access')}
                                disabled={!selectedDirectoryUser.flags.restrictable}
                              >
                                {selectedDirectoryUser.flags.staffAccessRestricted ? 'Restore Access' : 'Restrict Access'}
                              </Button>
                            )}
                            {selectedDirectoryUser.patient && (
                              <Button
                                variant="outline"
                                loading={actioning === 'close_patient_access'}
                                onClick={() => void handleDirectoryAction('close_patient_access')}
                                disabled={!selectedDirectoryUser.flags.patientAccessOpen}
                              >
                                Close Active Access
                              </Button>
                            )}
                          </>
                        )}
                        <Button
                          variant={selectedDirectoryUser.flags.deleted ? 'secondary' : 'danger'}
                          loading={actioning === (selectedDirectoryUser.flags.deleted ? 'restore_account' : 'delete_account')}
                          onClick={() => void handleDirectoryAction(selectedDirectoryUser.flags.deleted ? 'restore_account' : 'delete_account')}
                          disabled={selectedDirectoryUser.flags.deleted ? !selectedDirectoryUser.flags.restorable : !selectedDirectoryUser.flags.deletable}
                        >
                          {selectedDirectoryUser.flags.deleted ? 'Restore Account' : 'Delete Account'}
                        </Button>
                        {selectedDirectoryUser.flags.deleted && (
                          <Button
                            variant="danger"
                            loading={actioning === 'permanently_delete_account'}
                            onClick={() => void handleDirectoryAction('permanently_delete_account')}
                            disabled={!selectedDirectoryUser.flags.permanentlyDeletable}
                          >
                            Permanently Delete
                          </Button>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--admin-muted)', marginTop: 10, lineHeight: 1.6 }}>
                        Locking blocks the profile immediately. Restricting staff access disables hospital access and revokes active grants. Deleting keeps the account for recovery while removing user access. Permanently deleting a deleted account removes its account data and cannot be undone.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={panelStyle()}>
            {sectionTitle('Platform Admins')}
            <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', marginBottom: 12, lineHeight: 1.6 }}>
              Create dedicated admin accounts without touching patient or hospital users. New admins receive a one-time password setup link and must complete MFA after signing in. Account removal is two-stage: delete first, then restore or permanently delete.
            </div>
            {roleManagementError && (
              <div style={{ ...alertToneStyle('warning'), borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 11.5 }}>
                {roleManagementError}
              </div>
            )}
            {canManagePlatformAdmins ? (
              <div style={{ display: 'grid', gridTemplateColumns: viewportWidth < 1180 ? '1fr' : 'minmax(320px, 420px) minmax(0, 1fr)', gap: 12 }}>
              <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, background: '#fbfdff', padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Create Admin</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <Input
                    label="Full Name"
                    value={newAdminForm.fullName}
                    onChange={event => setNewAdminForm(current => ({ ...current, fullName: event.target.value }))}
                    placeholder="Platform administrator"
                  />
                  <Input
                    label="Email Address"
                    value={newAdminForm.email}
                    onChange={event => setNewAdminForm(current => ({ ...current, email: event.target.value }))}
                    placeholder="admin@example.com"
                    type="email"
                  />
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <Button onClick={() => void handleCreatePlatformAdmin()} loading={creatingAdmin}>
                      Create Admin
                    </Button>
                    <Button variant="outline" onClick={() => void loadRoleManagement(true)} loading={roleManagementLoading}>
                      Refresh
                    </Button>
                  </div>
                </div>
                {newAdminArtifact && (
                  <div style={{ marginTop: 12, border: '1px solid rgba(26, 111, 212, 0.16)', borderRadius: 10, padding: '12px 14px', background: 'rgba(26, 111, 212, 0.04)' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--admin-accent)', marginBottom: 8 }}>
                      Password Setup Link
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--admin-text)', marginBottom: 8 }}>
                      Share this one-time link with <strong>{newAdminArtifact.email}</strong>. It is only shown here after creation.
                    </div>
                    <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#1f2937', wordBreak: 'break-all', fontFamily: 'monospace', background: '#fff', border: '1px solid var(--admin-border)', borderRadius: 8, padding: '10px 12px' }}>
                      {newAdminArtifact.passwordSetupLink}
                    </div>
                  </div>
                )}
              </div>

              <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, background: '#fff', padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>Current Admins</div>
                  <Badge color="blue">{platformAdmins.length}</Badge>
                </div>
                {roleManagementLoading && platformAdmins.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>Loading platform admins...</div>
                ) : platformAdmins.length === 0 ? (
                  <EmptyState
                    icon={<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><rect x="7" y="7" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="1.5" /><path d="M16 12v8m-4-4h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>}
                    title="No extra admins yet"
                    description="Create a new platform admin account to expand operational coverage."
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {platformAdmins.map(admin => {
                      const isCurrentAdmin = admin.authUserId === viewerAuthUserId
                      const isDeleted = Boolean(admin.deletedAt)
                      const actionKey = (action: AdminPlatformAdminAction) => `${admin.authUserId}:${action}`

                      return (
                        <div key={admin.authUserId} style={{ border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', display: 'grid', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, wordBreak: 'break-word' }}>{admin.displayName ?? admin.email ?? 'Platform Admin'}</div>
                              <div style={{ fontSize: 11, color: 'var(--admin-muted)', wordBreak: 'break-word' }}>{admin.email ?? 'No email'}</div>
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                              <Badge color={isDeleted ? 'red' : admin.active ? 'green' : 'amber'}>{isDeleted ? 'deleted' : admin.active ? 'active' : 'limited'}</Badge>
                              <Badge color={admin.mfaRequired ? 'blue' : 'amber'}>{admin.mfaRequired ? 'mfa required' : 'mfa optional'}</Badge>
                            </div>
                          </div>
                          <div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>
                            Created {formatRelativeTime(admin.createdAt)} • Last sign-in {formatRelativeTime(admin.lastSignInAt)}
                          </div>
                          {!isCurrentAdmin && (
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              {!isDeleted && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    loading={platformAdminActioning === actionKey(admin.active ? 'lock_admin' : 'unlock_admin')}
                                    onClick={() => void handlePlatformAdminAction(admin, admin.active ? 'lock_admin' : 'unlock_admin')}
                                  >
                                    {admin.active ? 'Limit Access' : 'Restore Access'}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    loading={platformAdminActioning === actionKey('delete_admin')}
                                    onClick={() => void handlePlatformAdminAction(admin, 'delete_admin')}
                                  >
                                    Delete Account
                                  </Button>
                                </>
                              )}
                              {isDeleted && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    loading={platformAdminActioning === actionKey('restore_admin')}
                                    onClick={() => void handlePlatformAdminAction(admin, 'restore_admin')}
                                  >
                                    Restore Account
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    loading={platformAdminActioning === actionKey('permanently_delete_admin')}
                                    onClick={() => void handlePlatformAdminAction(admin, 'permanently_delete_admin')}
                                  >
                                    Permanently Delete
                                  </Button>
                                </>
                              )}
                            </div>
                          )}
                          {isCurrentAdmin && (
                            <div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Your own admin account cannot be limited or deleted here.</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              </div>
            ) : (
              <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, background: '#fbfdff', padding: 14, fontSize: 11.5, color: 'var(--admin-muted)', lineHeight: 1.6 }}>
                Platform-admin account management is restricted to the primary HID administrator.
              </div>
            )}
          </div>

          <div style={dualChartStyle}>
            <div style={panelStyle()}>
              {sectionTitle('User Growth')}
              <AdminSeriesChart points={data?.users.growth ?? []} type="line" tone="#5b8def" />
            </div>
            <div id="records" style={panelStyle()}>
              {sectionTitle('Records Uploaded')}
              <AdminSeriesChart points={data?.records.uploads ?? []} type="bar" tone="#22c55e" />
            </div>
          </div>
        </section>

        <section id="providers" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sectionLabel('System Health & Security')}
          <div style={metricGridStyle}>
            <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('api')} title="API Response" value={data?.system.apiResponseTimeMs ?? null} valueFormatter={formatDuration} trendLabel="Latest probe result" trendTone={(data?.system.apiResponseTimeMs ?? 0) > 800 ? 'warning' : 'positive'} helper="Average API response" />
            <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('warning', 'var(--admin-danger)')} title="Error Rate" value={data?.system.errorRate ?? null} valueFormatter={formatPercentage} trendLabel={`${formatCompact(data?.system.failedRequests ?? null)} failed requests`} trendTone={(data?.system.errorRate ?? 0) > 5 ? 'critical' : 'positive'} helper="Observed application errors" />
            <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('uptime')} title="Uptime" value={data?.system.uptimePercent ?? null} valueFormatter={formatPercentage} trendLabel="Service health snapshot" trendTone="positive" helper="Observed availability" />
            <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('failed', 'var(--admin-danger)')} title="Failed Requests" value={data?.system.failedRequests ?? null} trendLabel="Issue-linked failures" trendTone="critical" helper="Failed request count" />
            <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('lock', 'var(--admin-danger)')} title="Failed Logins" value={data?.security.failedLoginAttempts ?? null} trendLabel="Selected window" trendTone="critical" helper="Failed login attempts" />
            <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('check')} title="OTP Success" value={data?.security.otpSuccessRate ?? null} valueFormatter={formatPercentage} trendLabel={otpSuccessLabel} trendTone={data?.security.otpSuccessRate == null ? 'neutral' : (data.security.otpSuccessRate < 35 ? 'warning' : 'positive')} helper={otpSuccessHelper} />
            <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('shield')} title="Suspicious Activity" value={data?.security.suspiciousActivityCount ?? null} trendLabel="Break-glass and auth spikes" trendTone={(data?.security.suspiciousActivityCount ?? 0) > 0 ? 'warning' : 'positive'} helper="Security anomaly count" />
          </div>
        </section>

        <section id="security" style={splitPanelStyle}>
          <div style={panelStyle()}>
            {sectionTitle('User Onboarding Funnel')}
            <AdminFunnelChart steps={data?.users.funnel ?? []} />
          </div>
          <div style={panelStyle()}>
            {sectionTitle('System Alerts')}
            {filteredAlerts.length === 0 ? (
              <EmptyState
                icon={<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M16 5.4 28 26.6H4L16 5.4Z" stroke="currentColor" strokeWidth="1.5" /><path d="M16 12.8v5.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="16" cy="22.2" r="1" fill="currentColor" /></svg>}
                title="No active alerts"
                description="The selected window looks stable right now."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {filteredAlerts.map(alert => (
                  <div key={alert.id} style={{ ...alertToneStyle(alert.level), borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 12, fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' }}>{alert.title}</div>
                      <Badge color={alert.level === 'critical' ? 'red' : alert.level === 'warning' ? 'amber' : 'blue'}>{alert.level}</Badge>
                    </div>
                    <div style={{ fontSize: 11.5, lineHeight: 1.6, overflowWrap: 'anywhere' }}>{alert.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section style={tableGridStyle}>
          <div id="analytics" style={panelStyle()}>
            {sectionTitle('Recent Users')}
            {filteredUsers.length === 0 ? (
              <EmptyState
                icon={<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="11" r="5" stroke="currentColor" strokeWidth="1.5" /><path d="M7 26c1-4 5-6 9-6s8 2 9 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>}
                title="No users match this filter"
                description="Adjust the search or date range to see more activity."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {viewportWidth >= 480 && (
                  <div style={{ display: 'grid', gridTemplateColumns: viewportWidth < 1320 ? '1fr 1fr 1fr' : '1.2fr 1.1fr 0.7fr 0.9fr', gap: 10, padding: '0 0 8px', borderBottom: '1px solid var(--admin-border)' }}>
                    {tableHeaderCell('Name')}
                    {tableHeaderCell('Email')}
                    {tableHeaderCell('Status')}
                    {viewportWidth >= 1320 && tableHeaderCell('Time')}
                  </div>
                )}
                {filteredUsers.map(user => (
                  <div key={user.id} style={{ display: 'grid', gridTemplateColumns: viewportWidth < 480 ? '1fr' : viewportWidth < 1320 ? '1fr 1fr 1fr' : '1.2fr 1.1fr 0.7fr 0.9fr', gap: viewportWidth < 480 ? 4 : 10, padding: '10px 0', borderBottom: '1px solid #f0f4f8', alignItems: viewportWidth < 480 ? 'flex-start' : 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{user.name ?? user.email ?? 'Unknown user'}</div>
                      {viewportWidth < 1320 && <div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>{user.role ?? 'patient'}{viewportWidth >= 480 ? ` • ${formatRelativeTime(user.createdAt)}` : ''}</div>}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', minWidth: 0, overflowWrap: 'anywhere' }}>{user.email ?? 'No email'}</div>
                    <div>
                      <Badge color={statusBadgeColor(user.status)}>{user.status}</Badge>
                    </div>
                    {viewportWidth < 480 && <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>{formatRelativeTime(user.createdAt)}</div>}
                    {viewportWidth >= 1320 && <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>{formatRelativeTime(user.createdAt)}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={panelStyle()}>
            {sectionTitle('Recent Uploads')}
            {filteredUploads.length === 0 ? (
              <EmptyState
                icon={<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M16 21V9m0 0-4 4m4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><rect x="7" y="22" width="18" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.5" /></svg>}
                title="No uploads match this filter"
                description="Recent uploads will appear here as records are added."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {viewportWidth >= 480 && (
                  <div style={{ display: 'grid', gridTemplateColumns: viewportWidth < 1320 ? '1fr 1fr 1fr' : '1.1fr 0.8fr 0.8fr 0.7fr', gap: 10, padding: '0 0 8px', borderBottom: '1px solid var(--admin-border)' }}>
                    {tableHeaderCell('User')}
                    {tableHeaderCell('Type')}
                    {tableHeaderCell('Provider')}
                    {viewportWidth >= 1320 && tableHeaderCell('Time')}
                  </div>
                )}
                {filteredUploads.map(upload => (
                  <div key={upload.id} style={{ display: 'grid', gridTemplateColumns: viewportWidth < 480 ? '1fr' : viewportWidth < 1320 ? '1fr 1fr 1fr' : '1.1fr 0.8fr 0.8fr 0.7fr', gap: viewportWidth < 480 ? 4 : 10, padding: '10px 0', borderBottom: '1px solid #f0f4f8', alignItems: viewportWidth < 480 ? 'flex-start' : 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{upload.uploadedFor ?? 'Unknown patient'}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', overflowWrap: 'anywhere' }}>{upload.fileName}{viewportWidth >= 480 && viewportWidth < 1320 ? ` • ${formatRelativeTime(upload.createdAt)}` : ''}</div>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', minWidth: 0, overflowWrap: 'anywhere' }}>{upload.fileType ?? 'Unknown type'}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', minWidth: 0, overflowWrap: 'anywhere' }}>{upload.uploadedBy ?? 'System user'}</div>
                    {viewportWidth < 480 && <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>{formatRelativeTime(upload.createdAt)}</div>}
                    {viewportWidth >= 1320 && <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>{formatRelativeTime(upload.createdAt)}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <Modal
          open={exportDialogOpen}
          onClose={() => {
            if (!exportStarting && !exportDownloading) {
              closeExportDialog()
            }
          }}
          title="Export users"
          width={560}
        >
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7 }}>
              Export one selected user, the current search results, or a date-based batch only after OTP verification. The export is available in CSV, XLSX, PDF, or TXT and is sent securely to the signed-in admin email.
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <Select
                label="Export format"
                value={exportFormat}
                onChange={event => setExportFormat(event.target.value as AdminUsersExportFormat)}
                options={exportFormatOptions.map(option => ({ value: option.value, label: option.label }))}
                placeholder="Choose a format"
                disabled={Boolean(exportChallenge)}
              />
              <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', lineHeight: 1.6 }}>
                {selectedExportFormatOption.helper}
              </div>
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <Select
                label="Export scope"
                value={exportScope}
                onChange={event => setExportScope(event.target.value as AdminUsersExportScope)}
                options={exportScopeOptions.map(option => ({ value: option.value, label: option.label }))}
                placeholder="Choose a scope"
                disabled={Boolean(exportChallenge)}
              />
              <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', lineHeight: 1.6 }}>
                {selectedExportScopeOption.helper}
              </div>
            </div>

            <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, padding: '12px 14px', background: '#fbfdff' }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--admin-muted)', marginBottom: 6 }}>
                Export preview
              </div>
              <div style={{ fontSize: 13, color: '#4b5563', lineHeight: 1.7 }}>
                {exportScopeSummary}
              </div>
            </div>

            {exportScope === 'selected_user' && (
              <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Selected user</div>
                <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', lineHeight: 1.6 }}>
                  {selectedDirectoryUser
                    ? `${selectedDirectoryUser.patient?.fullName ?? selectedDirectoryUser.staff?.fullName ?? selectedDirectoryUser.profile?.displayName ?? selectedDirectoryUser.email ?? 'Selected user'} • ${selectedDirectoryUser.patient?.hidCode ?? selectedDirectoryUser.email ?? 'No email'}`
                    : 'Search for a user first, then reopen export to target that account.'}
                </div>
              </div>
            )}

            {exportScope === 'search_results' && (
              <Input
                label="Search query"
                value={exportQuery}
                onChange={event => setExportQuery(event.target.value)}
                placeholder="Search by HID code or email"
              />
            )}

            {exportScope === 'selected_day' && (
              <Input
                label="Export date"
                type="date"
                value={exportDate}
                max={new Date().toISOString().slice(0, 10)}
                onChange={event => setExportDate(event.target.value)}
              />
            )}

            {!exportChallenge ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                <Button variant="outline" onClick={closeExportDialog} disabled={exportStarting}>
                  Cancel
                </Button>
                <Button loading={exportStarting} onClick={() => void requestExportCode()} disabled={!exportCanRequest}>
                  Send OTP
                </Button>
              </div>
            ) : (
              <>
                <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, padding: '12px 14px', background: '#fbfdff' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--admin-muted)', marginBottom: 6 }}>
                    Verification sent
                  </div>
                  <div style={{ fontSize: 13, color: '#4b5563', lineHeight: 1.7 }}>
                    We sent a 6-digit code to <strong>{exportChallenge.maskedEmail ?? 'your email address'}</strong>. It expires at {formatDateTime(exportChallenge.expiresAt)}.
                  </div>
                </div>

                <OtpInputs value={exportCode} onChange={setExportCode} onComplete={setExportCode} />

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => void requestExportCode()}
                    style={{ border: 'none', background: 'none', color: '#1f8cff', fontSize: 12, cursor: 'pointer', padding: 0 }}
                    disabled={exportStarting || exportDownloading}
                  >
                    Send code again
                  </button>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <Button variant="outline" onClick={closeExportDialog} disabled={exportStarting || exportDownloading}>
                      Cancel
                    </Button>
                    <Button loading={exportDownloading} onClick={() => void confirmExportDownload()}>
                      Download export
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </Modal>

        <section style={splitPanelStyle}>
          <div style={panelStyle()}>
            {sectionLabel('Sentry')}
            {sectionTitle('Error Monitoring')}
            <div style={{ ...metricGridStyle, marginBottom: 12 }}>
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('warning', 'var(--admin-danger)')} title="Unresolved Issues" value={data?.sentry.unresolvedIssues ?? null} trendLabel={data?.sentry.projectLabel ?? 'Sentry project'} trendTone={data?.sentry.message ? 'warning' : 'positive'} helper="Open issues in selected window" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('failed', 'var(--admin-danger)')} title="Issue Hits" value={data?.sentry.issueEvents ?? null} trendLabel={`${formatCompact(data?.sentry.affectedUsers ?? null)} affected users`} trendTone="critical" helper="Total recent issue events" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('shield', 'var(--admin-danger)')} title="Critical Issues" value={data?.sentry.criticalIssues ?? null} trendLabel={data?.sentry.mostRecentIssueAt ? `Last seen ${formatRelativeTime(data.sentry.mostRecentIssueAt)}` : 'No recent critical issue'} trendTone={(data?.sentry.criticalIssues ?? 0) > 0 ? 'critical' : 'positive'} helper="Fatal and error-level issues" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('users')} title="Affected Users" value={data?.sentry.affectedUsers ?? null} trendLabel={`${formatCompact(filteredIssues.length)} active issue groups`} trendTone={(data?.sentry.affectedUsers ?? 0) > 0 ? 'warning' : 'positive'} helper="Users touched by recent issues" />
            </div>
            {data?.sentry.message && (
              <div style={{ ...alertToneStyle('warning'), borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 11.5 }}>
                {data.sentry.message}
              </div>
            )}
            <AdminSeriesChart points={data?.sentry.trend ?? []} type="line" tone="#5b8def" />
            <div style={{ ...splitPanelStyle, marginTop: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--admin-text)' }}>Issue Severity Mix</div>
                {sentryLevelSignals.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>No matching severity data in this window.</div>
                ) : (
                  sentryLevelSignals.map(item => (
                    <div key={item.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{item.label}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', overflowWrap: 'anywhere' }}>{item.helper ?? 'Observed issue groups'}</div>
                      </div>
                      <Badge color={item.label === 'Fatal' || item.label === 'Error' ? 'red' : item.label === 'Warning' ? 'amber' : 'blue'}>{formatCompact(item.value)}</Badge>
                    </div>
                  ))
                )}
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--admin-text)', marginTop: 4 }}>Issue Status</div>
                {sentryStatusSignals.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>No matching issue status data in this window.</div>
                ) : (
                  sentryStatusSignals.map(item => (
                    <div key={item.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{item.label}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', overflowWrap: 'anywhere' }}>{item.helper ?? 'Observed issue groups'}</div>
                      </div>
                      <Badge color={item.label === 'Unresolved' ? 'red' : item.label === 'Resolved' ? 'green' : 'amber'}>{formatCompact(item.value)}</Badge>
                    </div>
                  ))
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--admin-text)' }}>Issue Hotspots</div>
                {sentryHotspots.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>No matching Sentry hotspots in this window.</div>
                ) : (
                  sentryHotspots.map(item => (
                    <div key={item.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', overflowWrap: 'anywhere' }}>{item.helper ?? 'Observed issue groups'}</div>
                      </div>
                      <Badge color="amber">{formatCompact(item.value)}</Badge>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {filteredIssues.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>
                  {sentryConfigured ? 'No actionable Sentry issues in this range.' : 'Sentry is not configured for this environment.'}
                </div>
              ) : (
                filteredIssues.slice(0, 5).map(issue => (
                  <div key={issue.id} style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{issue.title}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', overflowWrap: 'anywhere' }}>{issue.culprit ?? 'No culprit provided'}</div>
                      </div>
                      <Badge color={issue.level === 'error' || issue.level === 'fatal' ? 'red' : 'amber'}>{issue.level ?? 'issue'}</Badge>
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', marginTop: 8 }}>
                      {issue.count} hits • {issue.users} users • {formatRelativeTime(issue.lastSeen)}
                    </div>
                  </div>
                ))
              )}
            </div>
            {data?.sentry.externalUrl && (
              <div style={{ marginTop: 12 }}>
                <Button size="sm" variant="outline" onClick={() => window.open(data.sentry.externalUrl!, '_blank', 'noopener,noreferrer')}>
                  Open Sentry
                </Button>
              </div>
            )}
          </div>

          <div style={panelStyle()}>
            {sectionLabel('PostHog')}
            {sectionTitle('Product Analytics')}
            <div style={{ ...metricGridStyle, marginBottom: 12 }}>
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('analytics')} title="Tracked Events" value={data?.posthog.events ?? null} trendLabel={data?.posthog.projectLabel ?? 'PostHog project'} trendTone={data?.posthog.message ? 'warning' : 'positive'} helper="Selected window" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('users')} title="Unique Users" value={data?.posthog.uniqueUsers ?? null} trendLabel={`${filteredEvents.length} top events`} trendTone="positive" helper="Unique users in range" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('analytics')} title="Pageviews" value={data?.posthog.pageviews ?? null} trendLabel="Web traffic activity" trendTone="positive" helper="Observed $pageview events" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('activity')} title="Autocapture" value={data?.posthog.autocaptures ?? null} trendLabel="Browser interaction tracking" trendTone="positive" helper="Observed $autocapture events" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('check')} title="Identify Calls" value={data?.posthog.identifies ?? null} trendLabel="Known-user attribution" trendTone="positive" helper="Observed $identify events" />
              <AdminMetricCard accent="var(--admin-accent)" icon={metricIcon('activity')} title="Web Vitals" value={data?.posthog.webVitals ?? null} trendLabel="Performance telemetry" trendTone="positive" helper="Frontend web performance events" />
            </div>
            {data?.posthog.message && (
              <div style={{ ...alertToneStyle('warning'), borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 11.5 }}>
                {data.posthog.message}
              </div>
            )}
            <div style={{ ...splitPanelStyle, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--admin-text)', marginBottom: 8 }}>All Event Trend</div>
                <AdminSeriesChart points={data?.posthog.trend ?? []} type="bar" tone="#22c55e" />
              </div>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--admin-text)', marginBottom: 8 }}>Pageview Trend</div>
                <AdminSeriesChart points={data?.posthog.pageviewTrend ?? []} type="line" tone="#1a6fd4" />
              </div>
            </div>
            <div style={{ ...splitPanelStyle, marginTop: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--admin-text)' }}>Top Events</div>
                {filteredEvents.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>No matching custom PostHog events.</div>
                ) : (
                  filteredEvents.slice(0, 6).map(event => (
                    <div key={event.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{event.name}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>Observed in selected range</div>
                      </div>
                      <Badge color="green">{formatCompact(event.total)}</Badge>
                    </div>
                  ))
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--admin-text)' }}>Web Analytics Signals</div>
                {posthogWebSignals.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>No matching PostHog web analytics metrics.</div>
                ) : (
                  posthogWebSignals.map(signal => (
                    <div key={signal.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{signal.label}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', overflowWrap: 'anywhere' }}>{signal.helper}</div>
                      </div>
                      <Badge color="blue">{formatCompact(signal.value)}</Badge>
                    </div>
                  ))
                )}
              </div>
            </div>
            {data?.posthog.externalUrl && (
              <div style={{ marginTop: 12 }}>
                <Button size="sm" variant="outline" onClick={() => window.open(data.posthog.externalUrl!, '_blank', 'noopener,noreferrer')}>
                  Open PostHog
                </Button>
              </div>
            )}
          </div>
        </section>

        <section id="settings" style={panelStyle()}>
          {sectionLabel('Settings')}
          {sectionTitle('Platform Controls')}
          <div style={{ display: 'grid', gridTemplateColumns: viewportWidth < 1180 ? '1fr' : 'minmax(0, 1.1fr) minmax(0, 0.9fr)', gap: 12 }}>
            <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, background: '#fbfdff', padding: 14 }}>
              <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', marginBottom: 12, lineHeight: 1.6 }}>
                These controls take effect on live sign-up and API access. Platform admins remain able to reach this dashboard during maintenance so recovery actions stay available.
              </div>
              {platformControlsError && (
                <div style={{ ...alertToneStyle('warning'), borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 11.5 }}>
                  {platformControlsError}
                </div>
              )}
              <div style={{ display: 'grid', gap: 8 }}>
                {platformControlFields.map(field => {
                  const checked = platformControls ? Boolean(platformControls[field.key]) : false
                  return (
                    <label key={field.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', background: '#fff' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!platformControls || platformControlsLoading || savingPlatformControls}
                        onChange={event => setPlatformControls(current => current ? { ...current, [field.key]: event.target.checked } : current)}
                        style={{ marginTop: 2 }}
                      />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--admin-text)' }}>{field.label}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', lineHeight: 1.5 }}>{field.helper}</div>
                      </div>
                    </label>
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
                <Button onClick={() => void savePlatformControls()} loading={savingPlatformControls} disabled={!platformControls}>
                  Save Controls
                </Button>
                <Button variant="outline" onClick={() => void loadPlatformControlsState(true)} loading={platformControlsLoading}>
                  Reload Controls
                </Button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--admin-muted)', marginTop: 10, lineHeight: 1.6 }}>
                Last updated {formatRelativeTime(platformControls?.updatedAt ?? null)}
                {platformControls?.updatedByName || platformControls?.updatedByEmail
                  ? ` by ${platformControls.updatedByName ?? platformControls.updatedByEmail}`
                  : ''}
              </div>
            </div>

            <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, background: '#fff', padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Deploy Readiness</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {deploymentReadinessCards.map(card => (
                  <div key={card.label} style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px', background: '#fbfdff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{card.label}</div>
                      <Badge color={readinessTone(card.ready)}>{card.ready ? 'ready' : 'attention'}</Badge>
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 4 }}>{card.value}</div>
                  </div>
                ))}
                {observabilityCards.map(card => (
                  <div key={card.label} style={{ border: '1px solid var(--admin-border)', borderRadius: 10, padding: '10px 12px', background: '#fbfdff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{card.label}</div>
                      <Badge color={readinessTone(card.ready)}>{card.ready ? 'connected' : 'needs setup'}</Badge>
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 4 }}>{card.value}</div>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: 'var(--admin-muted)', lineHeight: 1.7 }}>
                  The admin dashboard uses live Identity API data, and the observability panels reflect the current Sentry and PostHog connection state.
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            {sectionTitle('Outreach Platform Control')}
            <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', marginBottom: 12, lineHeight: 1.6 }}>
              Monitor outreach campaigns, workers, invites, and field sync readiness from the same platform control surface.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: viewportWidth < 1180 ? '1fr' : 'minmax(0, 0.8fr) minmax(0, 1.2fr)', gap: 12 }}>
              <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, background: '#fbfdff', padding: 14 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                  <div style={{ border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', background: '#fff' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Active Campaigns</div>
                    <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{formatCompact(platformControls?.outreach?.summary.activeCampaigns ?? 0)}</div>
                  </div>
                  <div style={{ border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', background: '#fff' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Workers</div>
                    <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{formatCompact(platformControls?.outreach?.summary.workers ?? 0)}</div>
                  </div>
                  <div style={{ border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', background: '#fff' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Open Invites</div>
                    <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{formatCompact(platformControls?.outreach?.summary.openInvites ?? 0)}</div>
                  </div>
                  <div style={{ border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', background: '#fff' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Queued Encounters</div>
                    <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{formatCompact(platformControls?.outreach?.summary.queuedEncounters ?? 0)}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                  <Badge color={platformControls?.outreachSignupEnabled ? 'green' : 'amber'}>
                    Signup {platformControls?.outreachSignupEnabled ? 'enabled' : 'disabled'}
                  </Badge>
                  <Badge color={platformControls?.outreachPortalEnabled ? 'green' : 'amber'}>
                    Portal {platformControls?.outreachPortalEnabled ? 'enabled' : 'disabled'}
                  </Badge>
                  {(platformControls?.outreach?.summary.urgentReferrals ?? 0) > 0 && (
                    <Badge color="red">{formatCompact(platformControls?.outreach?.summary.urgentReferrals ?? 0)} urgent referrals</Badge>
                  )}
                </div>
              </div>

              <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, background: '#fff', padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>Recent Campaigns</div>
                  <Button size="sm" variant="outline" onClick={() => void loadPlatformControlsState(true)} loading={platformControlsLoading}>
                    Refresh
                  </Button>
                </div>
                {(platformControls?.outreach?.campaigns.length ?? 0) === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>No outreach campaigns have been created yet.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {platformControls?.outreach?.campaigns.slice(0, 4).map(campaign => (
                      <div key={campaign.id} style={{ border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{campaign.name}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', overflowWrap: 'anywhere' }}>{campaign.org} • {campaign.location} • {formatRelativeTime(campaign.createdAt)}</div>
                        </div>
                        <Badge color={campaign.status === 'active' ? 'green' : campaign.status === 'planned' ? 'blue' : 'gray'}>{campaign.status}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            {sectionTitle('Hospital RBAC')}
            <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', marginBottom: 12, lineHeight: 1.6 }}>
              Edit what each hospital role can do in the active product. These permissions are enforced in the existing hospital access, records, history, and emergency endpoints.
            </div>
            {roleManagementError && (
              <div style={{ ...alertToneStyle('warning'), borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 11.5 }}>
                {roleManagementError}
              </div>
            )}
            <div style={{ display: 'grid', gap: 10 }}>
              <Select
                label="Select a hospital role"
                placeholder="Choose a role"
                value={selectedStaffRole}
                onChange={event => setSelectedStaffRole(event.target.value)}
                options={staffRolePolicies.map(policy => ({ value: policy.role, label: formatRoleLabel(policy.role) }))}
              />
              {selectedStaffPolicy ? (
                <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 800 }}>{formatRoleLabel(selectedStaffPolicy.role)}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>
                        Updated {formatRelativeTime(selectedStaffPolicy.updatedAt)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <Button
                        size="sm"
                        onClick={() => void saveStaffRolePolicy(selectedStaffPolicy.role)}
                        loading={savingStaffRole === selectedStaffPolicy.role}
                      >
                        Save Role
                      </Button>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: viewportWidth < 1320 ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                    {staffRoleCapabilityFields.map(field => (
                      <label key={`${selectedStaffPolicy.role}-${field.key}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', background: '#fbfdff' }}>
                        <input
                          type="checkbox"
                          checked={Boolean(selectedStaffPolicy[field.key])}
                          disabled={savingStaffRole === selectedStaffPolicy.role}
                          onChange={event => updateStaffRolePolicyDraft(selectedStaffPolicy.role, field.key, event.target.checked)}
                          style={{ marginTop: 2 }}
                        />
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>{field.label}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', lineHeight: 1.5 }}>{field.helper}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>Loading RBAC definitions...</div>
              )}
              {roleManagementLoading && staffRolePolicies.length === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>Loading RBAC definitions...</div>
              )}
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            {sectionTitle('Outreach RBAC')}
            <div style={{ fontSize: 11.5, color: 'var(--admin-muted)', marginBottom: 12, lineHeight: 1.6 }}>
              Control what each outreach role can do across campaign workspaces, invite management, encounter capture, and sync operations.
            </div>
            {roleManagementError && (
              <div style={{ ...alertToneStyle('warning'), borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 11.5 }}>
                {roleManagementError}
              </div>
            )}
            <div style={{ display: 'grid', gap: 10 }}>
              <Select
                label="Select an outreach role"
                placeholder="Choose a role"
                value={selectedOutreachRole}
                onChange={event => setSelectedOutreachRole(event.target.value)}
                options={outreachRolePolicies.map(policy => ({ value: policy.role, label: formatRoleLabel(policy.role) }))}
              />
              {selectedOutreachPolicy ? (
                <div style={{ border: '1px solid var(--admin-border)', borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 800 }}>{formatRoleLabel(selectedOutreachPolicy.role)}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--admin-muted)' }}>
                        Updated {formatRelativeTime(selectedOutreachPolicy.updatedAt)}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => void saveOutreachRolePolicy(selectedOutreachPolicy.role)}
                      loading={savingOutreachRole === selectedOutreachPolicy.role}
                    >
                      Save Role
                    </Button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: viewportWidth < 1320 ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                    {outreachRoleCapabilityFields.map(field => (
                      <label key={`${selectedOutreachPolicy.role}-${field.key}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, border: '1px solid #eef2f7', borderRadius: 10, padding: '10px 12px', background: '#fbfdff' }}>
                        <input
                          type="checkbox"
                          checked={Boolean(selectedOutreachPolicy[field.key])}
                          disabled={savingOutreachRole === selectedOutreachPolicy.role}
                          onChange={event => updateOutreachRolePolicyDraft(selectedOutreachPolicy.role, field.key, event.target.checked)}
                          style={{ marginTop: 2 }}
                        />
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>{field.label}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', lineHeight: 1.5 }}>{field.helper}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>Loading outreach RBAC definitions...</div>
              )}
              {roleManagementLoading && outreachRolePolicies.length === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--admin-muted)' }}>Loading outreach RBAC definitions...</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </AdminLayout>
  )
}
