import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell'
import { Badge, Button, Card, Input, Modal, PageLoader, SectionHeader, Textarea, showToast } from '../../components/ui'
import { signOutAndClearSessions, usePortalSession } from '../../lib/auth'
import { subscribeToAccessChanges } from '../../lib/accessRealtime'
import { readPatientHistorySnapshot, readPatientProfileSnapshot, seedPatientHistoryCache, seedPatientProfileCache } from '../../lib/experienceWarmup'
import {
  cancelShareInvite,
  fetchMyPatient,
  fetchPatientHistory,
  revokeAccessGrant,
  type LegacyAccessRequestWithShare,
} from '../../lib/hidApi'
import { getSharePermissionTierBadge, getSharePermissionTierLabel, getShareDurationLabel } from '../../lib/shareUtils'
import { formatDateTime, getAccessLogLabel } from '../../lib/utils'
import { type ActiveAccessGroup, getAccessLabel, getRequestDuration, groupActiveAccess, timeAgo } from '../../lib/accessUtils'
import type { AccessLog, Patient } from '../../types/database'
import type { HidPendingShareInvite } from '../../types/hid'

const patientNav = [
  { path: '/patient/profile', label: 'Home' },
  { path: '/patient/records', label: 'Records' },
  { path: '/patient/history', label: 'Access History' },
  { path: '/patient/biodata', label: 'Biodata' },
]

export default function PatientHistory() {
  const navigate = useNavigate()
  const { patient: session, hydrated } = usePortalSession()
  const cachedHistory = useMemo(() => (
    session ? readPatientHistorySnapshot(session.hidCode) : null
  ), [session])
  const cachedPatient = useMemo(() => (
    session ? readPatientProfileSnapshot(session.hidCode) : null
  ), [session])
  const [logs, setLogs] = useState<AccessLog[]>(() => cachedHistory?.logs ?? [])
  const [patient, setPatient] = useState<Patient | null>(() => cachedPatient)
  const [activeGrants, setActiveGrants] = useState<LegacyAccessRequestWithShare[]>(() => cachedHistory?.activeGrants ?? [])
  const [pendingInvites, setPendingInvites] = useState<HidPendingShareInvite[]>(() => cachedHistory?.pendingInvites ?? [])
  const [loading, setLoading] = useState(!cachedHistory && !cachedPatient)
  const [actingId, setActingId] = useState('')
  const [cancelingInviteId, setCancelingInviteId] = useState('')
  const [logSearch, setLogSearch] = useState('')
  const [logDate, setLogDate] = useState('')
  const [revokeGroup, setRevokeGroup] = useState<ActiveAccessGroup | null>(null)
  const [customRevokeReason, setCustomRevokeReason] = useState('')

  useEffect(() => {
    if (!hydrated) return
    if (!session) {
      navigate('/patient')
      return
    }
    void loadHistoryData(Boolean(cachedHistory || cachedPatient))
  }, [cachedHistory, cachedPatient, hydrated, navigate, session])

  useEffect(() => {
    if (!session) return

    const unsubscribe = subscribeToAccessChanges(() => {
      if (document.visibilityState === 'visible') {
        void loadHistoryData(true)
      }
    })

    return unsubscribe
  }, [session])

  async function loadHistoryData(silent = false) {
    if (!session) return
    if (!silent) setLoading(true)
    try {
      const patientPromise = patient
        ? Promise.resolve(patient)
        : fetchMyPatient()
      const [nextPatient, history] = await Promise.all([
        patientPromise,
        fetchPatientHistory(session.hidCode, { forceRefresh: silent }),
      ])
      if (!patient) {
        seedPatientProfileCache(nextPatient)
      }
      seedPatientHistoryCache(session.hidCode, history)
      setPatient(nextPatient)
      setActiveGrants(history.activeGrants)
      setPendingInvites(history.pendingInvites)
      setLogs(history.logs)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load your access history.'
      showToast(message, 'error')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  async function logout() {
    await signOutAndClearSessions()
    navigate('/patient')
  }

  async function revokeGrantGroup(group: ActiveAccessGroup, reason?: string | null) {
    setActingId(group.id)
    const previousGrants = activeGrants
    const revokedIds = new Set(group.grants.map(item => item.id))
    const revokeReason = reason ?? undefined
    setActiveGrants(current => current.filter(item => !revokedIds.has(item.id)))
    try {
      await Promise.all(group.grants.map(grant => revokeAccessGrant(grant.id, revokeReason)))
      showToast('Access revoked.', 'success')
      setRevokeGroup(null)
      setCustomRevokeReason('')
      void loadHistoryData(true)
    } catch (error) {
      setActiveGrants(previousGrants)
      const message = error instanceof Error ? error.message : 'Unable to revoke access.'
      showToast(message, 'error')
    } finally {
      setActingId('')
    }
  }

  async function cancelInvite(invite: HidPendingShareInvite) {
    setCancelingInviteId(invite.invite_id)
    const previousInvites = pendingInvites
    setPendingInvites(current => current.filter(item => item.invite_id !== invite.invite_id))
    try {
      await cancelShareInvite(invite.invite_id)
      showToast('Invitation cancelled.', 'success')
    } catch (error) {
      setPendingInvites(previousInvites)
      const message = error instanceof Error ? error.message : 'Unable to cancel this invitation.'
      showToast(message, 'error')
    } finally {
      setCancelingInviteId('')
    }
  }

  const activeAccessGroups = useMemo(() => groupActiveAccess(activeGrants), [activeGrants])
  const filteredLogs = useMemo(() => {
    const query = logSearch.trim().toLowerCase()
    return logs.filter(log => {
      const dateKey = new Date(log.access_time).toISOString().slice(0, 10)
      const matchesDate = !logDate || dateKey === logDate
      const matchesSearch = !query || [
        log.hid_code,
        log.accessed_by,
        log.reason ?? '',
        getAccessLogLabel(log),
        formatDateTime(log.access_time),
        dateKey,
      ].some(value => value.toLowerCase().includes(query))

      return matchesDate && matchesSearch
    })
  }, [logDate, logSearch, logs])

  if (!hydrated) return <PageLoader label="Restoring your secure session..." />
  if (!session) return null
  if (loading) {
    return (
      <PortalShell
        title="Access history"
        subtitle="Review active access and see your access logs."
        items={patientNav}
        onLogout={() => { void logout() }}
        userName={patient?.full_name ?? session.fullName}
        avatarUrl={patient?.photo_url}
        notificationPath="/patient/notifications"
        notificationHidCode={session.hidCode}
        onShareSuccess={() => void loadHistoryData(true)}
      >
        <PageLoader label="Loading your access history..." />
      </PortalShell>
    )
  }

  return (
    <PortalShell
      title="Access history"
      subtitle="Review active access and see your access logs."
      items={patientNav}
      onLogout={() => { void logout() }}
      userName={patient?.full_name ?? session.fullName}
      avatarUrl={patient?.photo_url}
      notificationPath="/patient/notifications"
      notificationHidCode={session.hidCode}
      onShareSuccess={() => void loadHistoryData(true)}
    >
      <Card style={{ borderRadius: 24, marginBottom: 18 }}>
        <SectionHeader title="Active access" subtitle="Providers that currently have access to your records." />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(248px, 100%), 1fr))', gap: 18 }}>
          {activeAccessGroups.map(group => {
            const request = group.primary
            const isEmergency = request.request_type === 'emergency'
            const accent = isEmergency ? '#ff2d35' : '#1877e6'
            return (
              <div
                key={group.id}
                style={{
                  borderRadius: 20,
                  background: '#fff',
                  border: '1px solid #edf1f5',
                  borderTop: `5px solid ${accent}`,
                  borderBottom: `5px solid ${accent}`,
                  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.04)',
                  overflow: 'hidden',
                }}
              >
                <div style={{ padding: '16px 16px 12px' }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 24,
                      padding: '0 10px',
                      borderRadius: 999,
                      background: isEmergency ? '#fff1f2' : '#eef6ff',
                      color: isEmergency ? '#dc2626' : '#1877e6',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {getAccessLabel(request)}
                  </span>
                  {request.permission_tier && (
                    <span style={{ marginLeft: 8 }}>
                      <Badge color={getSharePermissionTierBadge(request.permission_tier)}>
                        {getSharePermissionTierLabel(request.permission_tier)}{request.duration_preset ? ` · ${getShareDurationLabel(request.duration_preset)}` : ''}
                      </Badge>
                    </span>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, paddingBottom: 12, borderBottom: '1px solid #f1f5f9' }}>
                    <span
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 10,
                        border: '1px solid #edf1f5',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#6b7280',
                        background: '#fff',
                        flexShrink: 0,
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M3 2.7h10v10.6H3V2.7Z" stroke="currentColor" strokeWidth="1.2" />
                        <path d="M5.2 13.3V9.5h5.6v3.8M5 5.5h6M5 7.5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </span>
                    <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      <div style={{ fontSize: 18, fontWeight: 500, color: '#334155', lineHeight: 1.25 }}>{request.doctor_name}</div>
                      {group.grants.length > 1 && (
                        <div style={{ fontSize: 11, color: '#8a95a6', marginTop: 3 }}>{group.grants.length} active sessions grouped</div>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ padding: '0 16px 16px' }}>
                  <div style={{ padding: '12px 0', borderBottom: '1px solid #f1f5f9' }}>
                    <div style={{ fontWeight: 700, color: '#111827' }}>Access:</div>
                    <div style={{ marginTop: 4, fontSize: 12, color: '#334155', lineHeight: 1.55 }}>
                      <div>Medical Records</div>
                      <div>Lab Results</div>
                      <div>Medications</div>
                    </div>
                  </div>

                  <div style={{ padding: '12px 0', borderBottom: '1px solid #f1f5f9' }}>
                    <div style={{ fontWeight: 700, color: '#111827' }}>Used by:</div>
                    <div style={{ marginTop: 4, fontSize: 12, color: '#334155', lineHeight: 1.55 }}>
                      <div>{request.doctor_name}</div>
                      <div>{isEmergency ? 'Emergency session' : 'Approved provider session'}</div>
                    </div>
                  </div>

                  <div style={{ padding: '12px 0', borderBottom: '1px solid #f1f5f9' }}>
                    <div style={{ fontWeight: 700, color: '#111827' }}>Duration:</div>
                    <div style={{ marginTop: 4, fontSize: 12, color: '#334155', lineHeight: 1.55 }}>
                      <div>{request.access_expires_at ? `${formatDateTime(request.approved_at ?? request.created_at)} - ${formatDateTime(request.access_expires_at)}` : getRequestDuration(request)}</div>
                    </div>
                  </div>

                  <div style={{ padding: '12px 0 10px' }}>
                    <div style={{ fontWeight: 700, color: '#111827' }}>Last Activity</div>
                    <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontSize: 12, color: '#334155' }}>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{request.reason || 'Access currently active'}</span>
                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{timeAgo(request.approved_at ?? request.created_at)}</span>
                    </div>
                  </div>

                  <Button size="sm" variant="danger" loading={actingId === group.id} onClick={() => setRevokeGroup(group)} style={{ marginTop: 8 }}>
                    Revoke access
                  </Button>
                </div>
              </div>
            )
          })}
          {activeAccessGroups.length === 0 && <div style={{ color: '#6b7280' }}>No active provider access right now.</div>}
        </div>
      </Card>

      {pendingInvites.length > 0 && (
        <Card style={{ borderRadius: 24, marginBottom: 18 }}>
          <SectionHeader title="Pending invitations" subtitle="Providers you've invited who haven't joined HID yet." />
          <div style={{ display: 'grid', gap: 12 }}>
            {pendingInvites.map(invite => (
              <div
                key={invite.invite_id}
                style={{
                  borderRadius: 16,
                  border: '1px solid #edf1f5',
                  padding: 16,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{invite.invited_name || invite.invited_email}</div>
                  {invite.invited_name && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{invite.invited_email}</div>}
                  <div style={{ marginTop: 8 }}>
                    <Badge color={getSharePermissionTierBadge(invite.permission_tier)}>
                      {getSharePermissionTierLabel(invite.permission_tier)} · {getShareDurationLabel(invite.duration_preset)}
                    </Badge>
                  </div>
                  {invite.reason && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>{invite.reason}</div>}
                  <div style={{ fontSize: 12, color: '#8a95a6', marginTop: 8 }}>
                    Sent {formatDateTime(invite.created_at)} · Waiting for provider to join HID
                  </div>
                </div>
                <Button size="sm" variant="danger" loading={cancelingInviteId === invite.invite_id} onClick={() => void cancelInvite(invite)}>
                  Cancel
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card style={{ borderRadius: 24 }}>
        <SectionHeader title="Access Logs" subtitle="Security-relevant activity related to your record access." />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Input
            placeholder="Search by provider, action, reason, or date"
            value={logSearch}
            onChange={event => setLogSearch(event.target.value)}
          />
          <Input
            type="date"
            value={logDate}
            onChange={event => setLogDate(event.target.value)}
            aria-label="Filter logs by date"
          />
        </div>
        <div style={{ overflowX: 'auto', marginTop: 20 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                <th style={{ padding: '12px 10px' }}>Actor</th>
                <th style={{ padding: '12px 10px' }}>Activity</th>
                <th style={{ padding: '12px 10px' }}>Reason</th>
                <th style={{ padding: '12px 10px' }}>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map(log => (
                <tr key={log.id} style={{ borderTop: '1px solid #edf1f5' }}>
                  <td style={{ padding: '12px 10px', fontWeight: 600 }}>{log.accessed_by}</td>
                  <td style={{ padding: '12px 10px' }}>{getAccessLogLabel(log)}</td>
                  <td style={{ padding: '12px 10px' }}>{log.reason || '-'}</td>
                  <td style={{ padding: '12px 10px' }}>{formatDateTime(log.access_time)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && <div style={{ color: '#6b7280', marginTop: 12 }}>No access history yet.</div>}
          {logs.length > 0 && filteredLogs.length === 0 && <div style={{ color: '#6b7280', marginTop: 12 }}>No access logs match that search.</div>}
        </div>
      </Card>

      <Modal open={!!revokeGroup} onClose={() => { setRevokeGroup(null); setCustomRevokeReason('') }} title="Revoke provider access">
        {revokeGroup && (
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7 }}>
              This will close {revokeGroup.grants.length > 1 ? `${revokeGroup.grants.length} active sessions` : 'this active session'} for {revokeGroup.primary.doctor_name}.
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {[
                'No longer needed',
                'Provider not recognized',
                'Privacy concern',
                'Access opened by mistake',
              ].map(reason => (
                <Button key={reason} variant="outline" fullWidth loading={actingId === revokeGroup.id} onClick={() => void revokeGrantGroup(revokeGroup, reason)}>
                  {reason}
                </Button>
              ))}
            </div>
            <Textarea
              label="Other reason"
              value={customRevokeReason}
              onChange={event => setCustomRevokeReason(event.target.value)}
              placeholder="Optional reason for this revocation"
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Button variant="secondary" onClick={() => { setRevokeGroup(null); setCustomRevokeReason('') }}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={actingId === revokeGroup.id}
                onClick={() => void revokeGrantGroup(revokeGroup, customRevokeReason.trim() || 'Revoked by patient')}
              >
                Revoke now
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </PortalShell>
  )
}
