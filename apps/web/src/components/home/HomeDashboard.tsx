import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Card, EmptyState, SectionHeader, showToast } from '../ui'
import { ShareProfileModal } from '../ShareProfileModal'
import { formatDate, formatDateTime, getAccessLogLabel, getPersonInitials } from '../../lib/utils'
import { type ActiveAccessGroup, groupActiveAccess, timeAgo } from '../../lib/accessUtils'
import { getSharePermissionTierBadge, getSharePermissionTierLabel, getShareDurationLabel } from '../../lib/shareUtils'
import { getHealthEventStatusBadge, getHealthEventSummary, sortHealthEvents } from '../../lib/healthEventUtils'
import { formatHealthInfoType, getRecordContributorLabel } from '../../lib/medicalRecordUtils'
import { revokeAccessGrant, type LegacyAccessRequestWithShare } from '../../lib/hidApi'
import type { AccessLog, MedicalRecord, MedicalRecordFile, Patient } from '../../types/database'
import type { HidHealthEvent, HidPendingShareInvite } from '../../types/hid'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

interface HomeDashboardProps {
  patient: Patient
  records: MedicalRecord[]
  recordFiles: Record<string, MedicalRecordFile[]>
  healthEvents: HidHealthEvent[]
  activeGrants: LegacyAccessRequestWithShare[]
  pendingInvites: HidPendingShareInvite[]
  logs: AccessLog[]
  onRefresh: () => void
}

export function HomeDashboard({ patient, records, healthEvents, activeGrants, logs, onRefresh }: HomeDashboardProps) {
  const navigate = useNavigate()
  const [shareModalOpen, setShareModalOpen] = useState(false)

  const activeAccessGroups = useMemo(() => groupActiveAccess(activeGrants), [activeGrants])

  const attentionItems = useMemo(() => {
    const now = Date.now()
    const items: { id: string; text: string; path: string }[] = []

    activeGrants.forEach(grant => {
      if (!grant.access_expires_at) return
      const remaining = new Date(grant.access_expires_at).getTime() - now
      if (remaining > 0 && remaining <= SEVEN_DAYS_MS) {
        items.push({
          id: `expiry-${grant.id}`,
          text: `Access for ${grant.doctor_name} expires ${formatDate(grant.access_expires_at)}`,
          path: '/patient/history',
        })
      }
    })

    records.forEach(record => {
      if (!record.added_by_role || record.added_by_role === 'patient') return
      const age = now - new Date(record.created_at).getTime()
      if (age >= 0 && age <= SEVEN_DAYS_MS) {
        items.push({
          id: `upload-${record.id}`,
          text: `${record.created_by} added ${record.title}`,
          path: '/patient/records',
        })
      }
    })

    return items
  }, [activeGrants, records])

  const recentLogs = useMemo(() => logs.slice(0, 6), [logs])

  const recentHealthEvents = useMemo(() => sortHealthEvents(healthEvents).slice(0, 3), [healthEvents])

  const recentContributions = useMemo(() => {
    return records
      .filter(record => record.added_by_role && record.added_by_role !== 'patient')
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5)
  }, [records])

  return (
    <div style={{ display: 'grid', gap: 'clamp(14px, 4vw, 24px)' }}>
      <PatientOverviewCard
        patient={patient}
        onOpenShare={() => setShareModalOpen(true)}
        onAddHealthInfo={() => navigate('/patient/records', { state: { openAddHealthInfo: true } })}
      />

      <HealthSnapshotGrid
        totalRecords={records.length}
        healthEventCount={healthEvents.length}
        activeShareCount={activeGrants.length}
        connectedProviderCount={activeAccessGroups.length}
      />

      {attentionItems.length > 0 && <AttentionRequiredCard items={attentionItems} />}

      <RecentActivityCard logs={recentLogs} />

      <ActiveAccessCard groups={activeAccessGroups} onRefresh={onRefresh} />

      <RecentHealthEventsCard events={recentHealthEvents} records={records} />

      <RecentProviderContributionsCard records={recentContributions} />

      <ShareProfileModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        onShared={onRefresh}
      />
    </div>
  )
}

function PatientOverviewCard({ patient, onOpenShare, onAddHealthInfo }: {
  patient: Patient
  onOpenShare: () => void
  onAddHealthInfo: () => void
}) {
  return (
    <Card style={{ borderRadius: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        {patient.photo_url ? (
          <img src={patient.photo_url} alt={patient.full_name} style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#e8f1fc', color: '#1a6fd4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18, flexShrink: 0 }}>
            {getPersonInitials(patient.full_name)}
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'clamp(16px, 4vw, 20px)', fontWeight: 700, color: '#111827' }}>{patient.full_name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>{patient.hid_code}</span>
            <Badge color={patient.nin_verified ? 'green' : 'gray'}>{patient.nin_verified ? 'NIN Verified' : 'Not Verified'}</Badge>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 'clamp(12px, 4vw, 20px)' }}>
        <Button size="sm" onClick={onOpenShare}>Share Records</Button>
        <Button size="sm" variant="secondary" onClick={onAddHealthInfo}>Add Health Information</Button>
      </div>
    </Card>
  )
}

function HealthSnapshotGrid({ totalRecords, healthEventCount, activeShareCount, connectedProviderCount }: {
  totalRecords: number
  healthEventCount: number
  activeShareCount: number
  connectedProviderCount: number
}) {
  const tiles = [
    { label: 'Total Records', value: totalRecords },
    { label: 'Health Events', value: healthEventCount },
    { label: 'Active Shares', value: activeShareCount },
    { label: 'Connected Providers', value: connectedProviderCount },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 'clamp(10px, 3vw, 16px)' }}>
      {tiles.map(tile => (
        <Card key={tile.label} style={{ borderRadius: 12 }}>
          <div style={{ fontSize: 'clamp(18px, 5vw, 24px)', fontWeight: 700, color: '#111827' }}>{tile.value}</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{tile.label}</div>
        </Card>
      ))}
    </div>
  )
}

function AttentionRequiredCard({ items }: { items: { id: string; text: string; path: string }[] }) {
  const navigate = useNavigate()
  return (
    <Card style={{ borderRadius: 12, border: '1px solid #fde68a', background: '#fffbeb' }}>
      <SectionHeader title="Attention required" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => navigate(item.path)}
            style={{ textAlign: 'left', border: 'none', background: '#fff', borderRadius: 10, padding: '10px 12px', cursor: 'pointer', fontSize: 13, color: '#92400e', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
          >
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{item.text}</span>
            <span style={{ flexShrink: 0 }}>&rarr;</span>
          </button>
        ))}
      </div>
    </Card>
  )
}

function RecentActivityCard({ logs }: { logs: AccessLog[] }) {
  return (
    <Card style={{ borderRadius: 12 }}>
      <SectionHeader title="Recent activity" />
      {logs.length === 0 ? (
        <EmptyState icon={<span style={{ fontSize: 28 }}>[]</span>} title="No activity yet" description="Access activity on your records will show up here." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {logs.map(log => (
            <div key={log.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, fontSize: 13, paddingBottom: 10, borderBottom: '1px solid #f1f5f9' }}>
              <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <span style={{ fontWeight: 600, color: '#111827' }}>{log.accessed_by}</span>
                <span style={{ color: '#6b7280' }}> &middot; {getAccessLogLabel(log)}</span>
              </div>
              <span style={{ color: '#9ca3af', whiteSpace: 'nowrap', flexShrink: 0 }}>{formatDateTime(log.access_time)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function ActiveAccessCard({ groups, onRefresh }: { groups: ActiveAccessGroup[]; onRefresh: () => void }) {
  const [localGroups, setLocalGroups] = useState(groups)
  const [revokingId, setRevokingId] = useState('')

  useEffect(() => {
    setLocalGroups(groups)
  }, [groups])

  async function handleRevoke(group: ActiveAccessGroup) {
    setRevokingId(group.id)
    const previous = localGroups
    setLocalGroups(current => current.filter(item => item.id !== group.id))
    try {
      await Promise.all(group.grants.map(grant => revokeAccessGrant(grant.id, 'Revoked from Home')))
      showToast('Access revoked.', 'success')
      onRefresh()
    } catch (error) {
      setLocalGroups(previous)
      const message = error instanceof Error ? error.message : 'Unable to revoke access.'
      showToast(message, 'error')
    } finally {
      setRevokingId('')
    }
  }

  return (
    <Card style={{ borderRadius: 12 }}>
      <SectionHeader title="Active access" subtitle="Providers that currently have access to your records." />
      {localGroups.length === 0 ? (
        <EmptyState icon={<span style={{ fontSize: 28 }}>[]</span>} title="Nothing yet" description="Providers you share access with will appear here." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 14 }}>
          {localGroups.map(group => {
            const request = group.primary
            return (
              <div key={group.id} style={{ border: '1px solid #edf1f5', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', overflowWrap: 'anywhere' }}>{request.doctor_name}</div>
                {request.permission_tier && (
                  <Badge color={getSharePermissionTierBadge(request.permission_tier)}>
                    {getSharePermissionTierLabel(request.permission_tier)}{request.duration_preset ? ` · ${getShareDurationLabel(request.duration_preset)}` : ''}
                  </Badge>
                )}
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  {request.access_expires_at ? `Expires ${formatDateTime(request.access_expires_at)}` : `Active since ${timeAgo(request.approved_at ?? request.created_at)}`}
                </div>
                <Button size="sm" variant="danger" loading={revokingId === group.id} onClick={() => void handleRevoke(group)} style={{ alignSelf: 'flex-start' }}>
                  Revoke
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function RecentHealthEventsCard({ events, records }: { events: HidHealthEvent[]; records: MedicalRecord[] }) {
  const navigate = useNavigate()
  return (
    <Card style={{ borderRadius: 12 }}>
      <SectionHeader title="Recent health events" />
      {events.length === 0 ? (
        <EmptyState icon={<span style={{ fontSize: 28 }}>[]</span>} title="Nothing yet" description="Health events you create will appear here." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {events.map(event => {
            const status = getHealthEventStatusBadge(event.status)
            const summary = getHealthEventSummary(event, records)
            return (
              <div key={event.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingBottom: 10, borderBottom: '1px solid #f1f5f9', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: '#111827', overflowWrap: 'anywhere' }}>{event.title}</span>
                    <Badge color={status.color}>{status.label}</Badge>
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                    {summary.recordCount} record{summary.recordCount === 1 ? '' : 's'} · {summary.contributorCount} contributor{summary.contributorCount === 1 ? '' : 's'} · Updated {summary.updatedLabel}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/patient/records')}
                  style={{ border: 'none', background: 'none', color: '#1a6fd4', fontWeight: 600, cursor: 'pointer', fontSize: 12, flexShrink: 0 }}
                >
                  View Event &rarr;
                </button>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function RecentProviderContributionsCard({ records }: { records: MedicalRecord[] }) {
  return (
    <Card style={{ borderRadius: 12 }}>
      <SectionHeader title="Recent provider contributions" />
      {records.length === 0 ? (
        <EmptyState icon={<span style={{ fontSize: 28 }}>[]</span>} title="Nothing yet" description="Records added by providers will appear here." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {records.map(record => (
            <div key={record.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingBottom: 10, borderBottom: '1px solid #f1f5f9', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{record.title}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  {getRecordContributorLabel(record)}{record.created_by_org ? ` · ${record.created_by_org}` : ''} · {formatHealthInfoType(record.info_type, record.category)}
                </div>
              </div>
              <span style={{ fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap', flexShrink: 0 }}>{formatDate(record.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
