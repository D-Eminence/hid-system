import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Card, EmptyState, Input, Modal, PageLoader, SectionHeader, showToast } from '../../components/ui'
import { HospitalLayout } from '../../components/HospitalLayout'
import { signOutAndClearSessions, usePortalSession } from '../../lib/auth'
import { subscribeToAccessChanges } from '../../lib/accessRealtime'
import { readDoctorDashboardSnapshot, seedDoctorDashboardCache } from '../../lib/experienceWarmup'
import { HOSPITAL_AUTH_PATH } from '../../lib/hospitalRoutes'
import { fetchStaffDashboard } from '../../lib/hidApi'
import { formatDateTime } from '../../lib/utils'
import type { HidStaffDashboardResponse } from '../../types/hid'

type AccessType = 'standard' | 'emergency'

interface HospitalAccessLog {
  id: string
  hid_code: string
  accessed_by: string
  access_time: string
  access_type: AccessType
  reason: string | null
  action: string
  patient_name: string | null
}

function timeAgo(input: string) {
  const diffMs = Date.now() - new Date(input).getTime()
  const diffMinutes = Math.max(1, Math.floor(diffMs / 60000))
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

function toHospitalLogs(dashboard: HidStaffDashboardResponse): HospitalAccessLog[] {
  return dashboard.audit_events.map(item => {
    const raw = `${item.action} ${item.reason ?? ''}`.toLowerCase()
    const accessType: AccessType = raw.includes('break_glass') || raw.includes('emergency') ? 'emergency' : 'standard'
    return {
      id: item.event_id,
      hid_code: item.patient_hid_code ?? 'N/A',
      accessed_by: dashboard.staff_account.full_name,
      access_time: item.created_at,
      access_type: accessType,
      reason: item.reason,
      action: item.action,
      patient_name: item.patient_name ?? null,
    }
  }).sort((left, right) => new Date(right.access_time).getTime() - new Date(left.access_time).getTime())
}

export default function DoctorHistory() {
  const navigate = useNavigate()
  const { staff: session, hydrated } = usePortalSession()
  const cachedDashboard = useMemo(() => (
    session ? readDoctorDashboardSnapshot(session.id) : null
  ), [session])
  const [dashboard, setDashboard] = useState<HidStaffDashboardResponse | null>(cachedDashboard)
  const [logs, setLogs] = useState<HospitalAccessLog[]>(() => cachedDashboard ? toHospitalLogs(cachedDashboard) : [])
  const [loading, setLoading] = useState(!cachedDashboard)
  const [search, setSearch] = useState('')
  const [dateFilter, setDateFilter] = useState('')
  const [filter, setFilter] = useState<'all' | 'standard' | 'emergency'>('all')
  const [selected, setSelected] = useState<HospitalAccessLog | null>(null)
  const [isCompact, setIsCompact] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 900 : false))

  useEffect(() => {
    if (!hydrated) return
    if (!session) {
      navigate(HOSPITAL_AUTH_PATH)
      return
    }
    void loadLogs(Boolean(cachedDashboard))
  }, [cachedDashboard, hydrated, navigate, session])

  useEffect(() => {
    if (!session) return

    const unsubscribe = subscribeToAccessChanges(() => {
      if (document.visibilityState === 'visible') {
        void loadLogs(true, true)
      }
    })

    return unsubscribe
  }, [session])

  useEffect(() => {
    const handleResize = () => setIsCompact(window.innerWidth < 900)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  async function loadLogs(silent = false, forceRefresh = false) {
    if (!session) return
    if (!silent) setLoading(true)
    try {
      const nextDashboard = await fetchStaffDashboard({ forceRefresh })
      seedDoctorDashboardCache(session.id, nextDashboard)
      setDashboard(nextDashboard)
      setLogs(toHospitalLogs(nextDashboard))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load hospital access logs.'
      showToast(message, 'error')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  async function logout() {
    await signOutAndClearSessions()
    navigate(HOSPITAL_AUTH_PATH)
  }

  const filtered = logs.filter(log => {
    const normalizedSearch = search.toLowerCase()
    const logDate = new Date(log.access_time).toISOString().slice(0, 10)
    const matchSearch =
      log.hid_code.toLowerCase().includes(normalizedSearch) ||
      log.accessed_by.toLowerCase().includes(normalizedSearch) ||
      log.action.toLowerCase().includes(normalizedSearch) ||
      logDate.includes(normalizedSearch) ||
      formatDateTime(log.access_time).toLowerCase().includes(normalizedSearch) ||
      (log.patient_name ?? '').toLowerCase().includes(normalizedSearch)
    const matchFilter = filter === 'all' || log.access_type === filter
    const matchDate = !dateFilter || logDate === dateFilter
    return matchSearch && matchFilter && matchDate
  })

  const emergencyCount = logs.filter(log => log.access_type === 'emergency').length
  const hospitalName = dashboard?.staff_account.hospital_name ?? session?.hospitalName ?? 'Hospital'
  const staffDisplayName = dashboard?.staff_account.full_name ?? session?.fullName ?? hospitalName

  if (!hydrated) return <PageLoader label="Restoring your secure session..." />
  if (!session) return null
  if (loading && logs.length === 0) {
    return (
      <HospitalLayout
        activeSection="history"
        title="Access Logs"
        subtitle="Complete audit trail of all hospital record access events."
        onLogout={() => { void logout() }}
        userName={staffDisplayName}
        organizationName={hospitalName}
      >
        <PageLoader label="Loading access logs..." />
      </HospitalLayout>
    )
  }

  return (
    <HospitalLayout
      activeSection="history"
      title="Access Logs"
      subtitle="Complete audit trail of all hospital record access events."
      onLogout={() => { void logout() }}
      userName={staffDisplayName}
      organizationName={hospitalName}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          {[
            { label: 'Total Access Events', value: logs.length, color: '#1a6fd4' },
            { label: 'Standard Access', value: logs.length - emergencyCount, color: '#16a34a' },
            { label: 'Emergency Access', value: emergencyCount, color: '#dc2626' },
          ].map(item => (
            <Card key={item.label} padding={18}>
              <div style={{ fontSize: 28, fontWeight: 800, color: item.color, letterSpacing: '-1px', lineHeight: 1 }}>{item.value}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{item.label}</div>
            </Card>
          ))}
        </div>

        <Card padding={14}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1 }}>
              <Input
                placeholder="Search by HID code, patient name, action, or date..."
                value={search}
                onChange={event => setSearch(event.target.value)}
              />
            </div>
            <div style={{ minWidth: 160 }}>
              <Input
                type="date"
                value={dateFilter}
                onChange={event => setDateFilter(event.target.value)}
                aria-label="Filter access logs by date"
              />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(['all', 'standard', 'emergency'] as const).map(value => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 8,
                    border: '1.5px solid',
                    borderColor: filter === value ? (value === 'emergency' ? '#dc2626' : '#1a6fd4') : '#e5e7eb',
                    background: filter === value ? (value === 'emergency' ? '#fee2e2' : '#e8f1fc') : '#fff',
                    color: filter === value ? (value === 'emergency' ? '#dc2626' : '#1a6fd4') : '#6b7280',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    textTransform: 'capitalize',
                  }}
                >
                  {value}
                </button>
              ))}
            </div>
            <Button variant="outline" onClick={() => void loadLogs(false, true)} size="sm">Refresh</Button>
          </div>
        </Card>

        <Card padding={0}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
            <SectionHeader
              title={`Access Events (${filtered.length})`}
              subtitle="Immutable audit log - hospital access events cannot be edited or deleted."
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: -8 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a', animation: 'pulse 2s infinite' }} />
              <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}`}</style>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Live hospital audit trail</span>
            </div>
          </div>

          {loading ? (
            <div style={{ padding: 48, textAlign: 'center', color: '#6b7280' }}>Refreshing logs...</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<span style={{ fontSize: 28 }}>[]</span>}
              title="No access logs found"
              description="Hospital access events are logged automatically when patient records are opened."
            />
          ) : isCompact ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
              {filtered.map(log => (
                <div
                  key={log.id}
                  style={{
                    border: '1px solid #eef2f7',
                    borderRadius: 14,
                    padding: 14,
                    background: log.access_type === 'emergency' ? '#fffbeb' : '#fff',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: 'monospace', fontSize: 13, color: '#1a6fd4', fontWeight: 600, overflowWrap: 'anywhere' }}>{log.hid_code}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginTop: 4, overflowWrap: 'anywhere' }}>{log.patient_name ?? 'Unknown patient'}</div>
                    </div>
                    <Badge color={log.access_type === 'emergency' ? 'red' : 'blue'}>
                      {log.access_type === 'emergency' ? 'Emergency' : 'Standard'}
                    </Badge>
                  </div>
                  <div style={{ fontSize: 13, color: '#374151' }}>{log.action}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, fontSize: 12, color: '#6b7280' }}>
                    <div>
                      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af', marginBottom: 4 }}>Time</div>
                      <div>{timeAgo(log.access_time)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af', marginBottom: 4 }}>Details</div>
                      <div>{formatDateTime(log.access_time)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      onClick={() => setSelected(log)}
                      style={{
                        background: 'none',
                        border: '1px solid #e5e7eb',
                        borderRadius: 8,
                        padding: '8px 12px',
                        fontSize: 12,
                        color: '#6b7280',
                        cursor: 'pointer',
                      }}
                    >
                      View
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.4fr 1fr 1fr 80px', gap: 12, padding: '10px 20px', fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.4px', borderBottom: '1px solid #f3f4f6' }}>
                <span>Patient HID</span>
                <span>Action</span>
                <span>Type</span>
                <span>Time</span>
                <span>Details</span>
              </div>
              {filtered.map((log, index) => (
                <div
                  key={log.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.2fr 1.4fr 1fr 1fr 80px',
                    gap: 12,
                    padding: '13px 20px',
                    borderBottom: index < filtered.length - 1 ? '1px solid #f9fafb' : 'none',
                    alignItems: 'center',
                    background: log.access_type === 'emergency' ? '#fffbeb' : 'transparent',
                  }}
                >
                  <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#1a6fd4', fontWeight: 500 }}>{log.hid_code}</span>
                  <span style={{ fontSize: 13 }}>{log.action}</span>
                  <Badge color={log.access_type === 'emergency' ? 'red' : 'blue'}>
                    {log.access_type === 'emergency' ? 'Emergency' : 'Standard'}
                  </Badge>
                  <div>
                    <div style={{ fontSize: 12, color: '#374151' }}>{timeAgo(log.access_time)}</div>
                    <div style={{ fontSize: 11, color: '#d1d5db' }}>{formatDateTime(log.access_time)}</div>
                  </div>
                  <button
                    onClick={() => setSelected(log)}
                    style={{
                      background: 'none',
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
                      padding: '5px 10px',
                      fontSize: 12,
                      color: '#6b7280',
                      cursor: 'pointer',
                    }}
                  >
                    View
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Modal open={!!selected} onClose={() => setSelected(null)} title="Access Log Details">
        {selected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Badge color={selected.access_type === 'emergency' ? 'red' : 'blue'}>
                {selected.access_type === 'emergency' ? 'Emergency Access' : 'Standard Access'}
              </Badge>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, background: '#f9fafb', borderRadius: 10, padding: 16 }}>
              {[
                { label: 'Patient HID', value: selected.hid_code, mono: true },
                { label: 'Patient Name', value: selected.patient_name ?? '-' },
                { label: 'Accessed By', value: selected.accessed_by },
                { label: 'Action', value: selected.action },
                { label: 'Access Time', value: formatDateTime(selected.access_time) },
                { label: 'Access Type', value: selected.access_type },
              ].map(item => (
                <div key={item.label} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{item.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 500, fontFamily: item.mono ? 'monospace' : undefined, color: item.mono ? '#1a6fd4' : undefined, textTransform: item.label === 'Access Type' ? 'capitalize' : undefined, overflowWrap: 'anywhere' }}>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
            {selected.reason && (
              <div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Reason</div>
                <div style={{ fontSize: 14, color: '#374151', background: '#fef3c7', borderRadius: 8, padding: '12px 14px', lineHeight: 1.6, border: '1px solid #fde68a' }}>
                  {selected.reason}
                </div>
              </div>
            )}
            <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
              Log ID: <span style={{ fontFamily: 'monospace' }}>{selected.id}</span>
            </p>
          </div>
        )}
      </Modal>
    </HospitalLayout>
  )
}
