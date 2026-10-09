import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { OtpInputs } from '../../components/OtpInputs'
import { Badge, Button, Card, Input, Modal, PageLoader, showToast } from '../../components/ui'
import { HospitalLayout } from '../../components/HospitalLayout'
import { signOutAndClearSessions, usePortalSession } from '../../lib/auth'
import { subscribeToAccessChanges } from '../../lib/accessRealtime'
import { readDoctorDashboardSnapshot, seedDoctorDashboardCache } from '../../lib/experienceWarmup'
import {
  HOSPITAL_ACCESS_PATH,
  HOSPITAL_AUTH_PATH,
  HOSPITAL_EMERGENCY_PATH,
  HOSPITAL_HISTORY_PATH,
  getHospitalPatientRecordsPath,
} from '../../lib/hospitalRoutes'
import { deleteMyAccount, fetchStaffDashboard, startAccountDeletion, verifyAccountDeletionCode } from '../../lib/hidApi'
import { formatDateTime } from '../../lib/utils'
import type { HidStaffDashboardResponse } from '../../types/hid'

function timeAgo(input: string) {
  const diffMs = Date.now() - new Date(input).getTime()
  const diffMinutes = Math.max(1, Math.floor(diffMs / 60000))
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

function isActiveGrant(status: string | null, expiresAt: string | null) {
  return status === 'active' && !!expiresAt && new Date(expiresAt).getTime() > Date.now()
}

export default function HospitalDashboard() {
  const navigate = useNavigate()
  const { staff: session, hydrated } = usePortalSession()
  const cachedDashboard = useMemo(() => (
    session ? readDoctorDashboardSnapshot(session.id) : null
  ), [session])
  const [dashboard, setDashboard] = useState<HidStaffDashboardResponse | null>(cachedDashboard)
  const [loading, setLoading] = useState(!cachedDashboard)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleteChallengeId, setDeleteChallengeId] = useState('')
  const [deleteMaskedEmail, setDeleteMaskedEmail] = useState('')
  const [deleteOtp, setDeleteOtp] = useState('')
  const [deleteVerificationToken, setDeleteVerificationToken] = useState('')
  const [sendingDeleteOtp, setSendingDeleteOtp] = useState(false)
  const [verifyingDeleteOtp, setVerifyingDeleteOtp] = useState(false)
  const [deletingAccount, setDeletingAccount] = useState(false)

  useEffect(() => {
    if (!hydrated) return
    if (!session) {
      navigate(HOSPITAL_AUTH_PATH)
      return
    }
    void loadDashboard(Boolean(cachedDashboard))
  }, [cachedDashboard, hydrated, navigate, session])

  useEffect(() => {
    if (!session) return

    const unsubscribe = subscribeToAccessChanges(() => {
      if (document.visibilityState === 'visible') {
        void loadDashboard(true, true)
      }
    })

    return unsubscribe
  }, [session])

  async function loadDashboard(silent = false, forceRefresh = false) {
    if (!session) return
    if (!silent) setLoading(true)
    try {
      const nextDashboard = await fetchStaffDashboard({ forceRefresh })
      seedDoctorDashboardCache(session.id, nextDashboard)
      setDashboard(nextDashboard)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load the hospital dashboard.'
      showToast(message, 'error')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  async function logout() {
    await signOutAndClearSessions()
    navigate(HOSPITAL_AUTH_PATH)
  }

  function resetDeleteFlow() {
    setDeleteConfirmText('')
    setDeleteChallengeId('')
    setDeleteMaskedEmail('')
    setDeleteOtp('')
    setDeleteVerificationToken('')
    setSendingDeleteOtp(false)
    setVerifyingDeleteOtp(false)
    setDeletingAccount(false)
  }

  async function requestDeleteOtp() {
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      showToast('Type DELETE to confirm account deletion.', 'error')
      return
    }

    setSendingDeleteOtp(true)
    try {
      const result = await startAccountDeletion()
      setDeleteChallengeId(result.challengeId)
      setDeleteMaskedEmail(result.maskedEmail ?? '')
      setDeleteOtp('')
      setDeleteVerificationToken('')
      showToast(`We sent a 6-digit code to ${result.maskedEmail || 'your email address'}.`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send a verification code right now.'
      showToast(message, 'error')
    } finally {
      setSendingDeleteOtp(false)
    }
  }

  async function verifyDeleteOtp(nextCode = deleteOtp) {
    if (nextCode.trim().length !== 6 || !deleteChallengeId) {
      showToast('Enter the full 6-digit verification code first.', 'error')
      return
    }

    setVerifyingDeleteOtp(true)
    try {
      const result = await verifyAccountDeletionCode(deleteChallengeId, nextCode.trim())
      setDeleteVerificationToken(result.verificationToken)
      showToast('Verification complete. You can now delete this hospital account.', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The verification code is not correct.'
      showToast(message, 'error')
    } finally {
      setVerifyingDeleteOtp(false)
    }
  }

  async function confirmPermanentDelete() {
    if (!deleteChallengeId || !deleteVerificationToken) {
      showToast('Verify the 6-digit code before deleting this account.', 'error')
      return
    }

    setDeletingAccount(true)
    try {
      await deleteMyAccount(deleteChallengeId, deleteVerificationToken)
      showToast('Your hospital account has been deleted and is no longer available.', 'success')
      navigate(HOSPITAL_AUTH_PATH, { replace: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete this hospital account right now.'
      showToast(message, 'error')
    } finally {
      setDeletingAccount(false)
    }
  }

  const requests = dashboard?.requests ?? []
  const auditEvents = dashboard?.audit_events ?? []
  const uniquePatients = Array.from(new Map(requests.map(item => [item.hid_code, item])).values())
  const activeAccess = requests.filter(item => isActiveGrant(item.grant_status, item.expires_at)).length
  const emergencySessions = requests.filter(item => item.break_glass).length
  const recentPatients = [...uniquePatients].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()).slice(0, 5)
  const recentEvents = [...auditEvents].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()).slice(0, 5)
  const hospitalName = dashboard?.staff_account.hospital_name ?? session?.hospitalName ?? 'Hospital'
  const staffDisplayName = dashboard?.staff_account.full_name ?? session?.fullName ?? hospitalName

  const statCards = [
    {
      label: 'Tracked Requests',
      value: requests.length,
      color: '#1a6fd4',
      bg: '#e8f1fc',
      action: () => navigate(HOSPITAL_ACCESS_PATH),
      icon: (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect x="3" y="2" width="16" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M7 8h8M7 12h6M7 16h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      label: 'Active Access',
      value: activeAccess,
      color: '#16a34a',
      bg: '#dcfce7',
      action: () => navigate(HOSPITAL_HISTORY_PATH),
      icon: (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path d="M11 1a10 10 0 1 0 0 20A10 10 0 0 0 11 1z" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M11 6v5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      label: 'Emergency Sessions',
      value: emergencySessions,
      color: '#dc2626',
      bg: '#fee2e2',
      action: () => navigate(HOSPITAL_EMERGENCY_PATH),
      icon: (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path d="M11 2.3 18.8 16a1 1 0 0 1-.87 1.5H4.07A1 1 0 0 1 3.2 16L11 2.3Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M11 7.1v5.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="11" cy="15.2" r="1" fill="currentColor" />
        </svg>
      ),
    },
  ]

  if (!hydrated) return <PageLoader label="Restoring your secure session..." />
  if (!session) return null
  if (loading) {
    return (
      <HospitalLayout
        activeSection="dashboard"
        title="Dashboard"
        subtitle="Hospital CTA home - overview of active access, patient activity, and audit trail."
        onLogout={() => { void logout() }}
        userName={staffDisplayName}
        organizationName={hospitalName}
      >
        <PageLoader label="Loading hospital dashboard..." />
      </HospitalLayout>
    )
  }

  return (
    <HospitalLayout
      activeSection="dashboard"
      title="Dashboard"
      subtitle="Hospital CTA home - overview of active access, patient activity, and audit trail."
      onLogout={() => { void logout() }}
      userName={staffDisplayName}
      organizationName={hospitalName}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          {statCards.map(card => (
            <Card key={card.label} onClick={card.action} style={{ cursor: 'pointer' }}>
              <div style={{ width: 44, height: 44, borderRadius: 10, background: card.bg, color: card.color, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                {card.icon}
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, color: card.color, letterSpacing: '-1px', lineHeight: 1 }}>{card.value}</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>{card.label}</div>
            </Card>
          ))}
        </div>

        <Card>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Quick Actions</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Button onClick={() => navigate(HOSPITAL_ACCESS_PATH)} fullWidth>
              Access Patient HID
            </Button>
            <Button variant="secondary" onClick={() => navigate(HOSPITAL_EMERGENCY_PATH)} fullWidth>
              Emergency Access
            </Button>
            <Button variant="outline" onClick={() => navigate(HOSPITAL_HISTORY_PATH)} fullWidth>
              View Access Logs
            </Button>
          </div>
        </Card>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: 15, fontWeight: 700 }}>Recent Patients</h3>
              <Button variant="ghost" size="sm" onClick={() => navigate(HOSPITAL_ACCESS_PATH)}>Open access</Button>
            </div>
            {recentPatients.length === 0 ? (
              <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: '20px 0' }}>No hospital patient activity yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {recentPatients.map(patient => (
                  <div key={patient.hid_code} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#e8f1fc', color: '#1a6fd4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                      {(patient.patient_name ?? '?').split(' ').filter(Boolean).map(name => name[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{patient.patient_name ?? 'Unknown patient'}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{patient.hid_code}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => navigate(getHospitalPatientRecordsPath(patient.hid_code))}>
                      Open
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: 15, fontWeight: 700 }}>Recent Activity</h3>
              <Button variant="ghost" size="sm" onClick={() => navigate(HOSPITAL_HISTORY_PATH)}>View all</Button>
            </div>
            {recentEvents.length === 0 ? (
              <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: '20px 0' }}>No access logs yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {recentEvents.map(item => {
                  const isEmergency = `${item.action} ${item.reason ?? ''}`.toLowerCase().includes('break_glass')
                  return (
                    <div key={item.event_id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: isEmergency ? '#dc2626' : '#1a6fd4' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.action}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{item.patient_hid_code ?? 'N/A'}</div>
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{timeAgo(item.created_at)}</div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>

        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700 }}>Open Requests</h3>
            <Badge color="blue">{requests.length} tracked</Badge>
          </div>
          {requests.length === 0 ? (
            <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: '20px 0' }}>No tracked requests yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {requests.slice(0, 6).map(item => {
                const isEmergency = item.break_glass
                const canOpen = isActiveGrant(item.grant_status, item.expires_at)
                return (
                  <div key={item.request_id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', overflowWrap: 'anywhere' }}>{item.patient_name}</div>
                        <div style={{ fontSize: 12, color: '#9ca3af', fontFamily: 'monospace', marginTop: 4, overflowWrap: 'anywhere' }}>{item.hid_code}</div>
                      </div>
                      <Badge color={isEmergency ? 'red' : canOpen ? 'green' : item.request_status === 'pending' ? 'amber' : 'blue'}>
                        {isEmergency ? 'Emergency' : canOpen ? 'Active' : item.request_status}
                      </Badge>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginTop: 12, fontSize: 12, color: '#6b7280' }}>
                      <div><strong>Requested:</strong> {formatDateTime(item.created_at)}</div>
                      <div><strong>Approved:</strong> {item.approved_at ? formatDateTime(item.approved_at) : 'Pending'}</div>
                      <div><strong>Expires:</strong> {item.expires_at ? formatDateTime(item.expires_at) : '-'}</div>
                    </div>
                    {canOpen && (
                      <div style={{ marginTop: 12 }}>
                        <Button size="sm" onClick={() => navigate(getHospitalPatientRecordsPath(item.hid_code))}>Open patient records</Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        <Card style={{ border: '1px solid #e5e7eb', background: '#f8fafc' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#374151' }}>Danger Zone</div>
          <div style={{ color: '#6b7280', fontSize: 12, marginTop: 6, lineHeight: 1.7 }}>
            Deleting your account removes your access to HID immediately. You can recover your account through HID Support within 30 days. After 30 days, your account and data are permanently deleted and cannot be restored.
          </div>
          <Button
            variant="outline"
            style={{ marginTop: 14, borderColor: '#d1d5db', color: '#374151', background: '#f9fafb' }}
            onClick={() => {
              resetDeleteFlow()
              setDeleteModalOpen(true)
            }}
          >
            Delete account
          </Button>
        </Card>
      </div>

      <Modal open={deleteModalOpen} onClose={() => { if (!sendingDeleteOtp && !verifyingDeleteOtp && !deletingAccount) setDeleteModalOpen(false) }} title="Delete hospital account" width={520}>
        <div style={{ display: 'grid', gap: 16 }}>
          {!deleteChallengeId ? (
            <>
              <div style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7 }}>
                Deleting your account removes your access to HID immediately. You can recover your account through HID Support within 30 days. After 30 days, your account and data are permanently deleted and cannot be restored. Type DELETE, then we will send a 6-digit verification code to your email.
              </div>
              <Input
                label='Type "DELETE" to confirm'
                value={deleteConfirmText}
                onChange={event => setDeleteConfirmText(event.target.value)}
                placeholder="DELETE"
                autoComplete="off"
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={sendingDeleteOtp}>
                  Cancel
                </Button>
                <Button variant="danger" loading={sendingDeleteOtp} onClick={() => void requestDeleteOtp()}>
                  Send OTP
                </Button>
              </div>
            </>
          ) : !deleteVerificationToken ? (
            <>
              <div style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7 }}>
                We sent a 6-digit code to {deleteMaskedEmail || 'your email address'}. Enter it below to confirm account deletion.
              </div>
              <OtpInputs value={deleteOtp} onChange={setDeleteOtp} onComplete={verifyDeleteOtp} />
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={() => void requestDeleteOtp()}
                  style={{ border: 'none', background: 'none', color: '#1f8cff', fontSize: 12, cursor: 'pointer', padding: 0 }}
                >
                  Send code again
                </button>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={verifyingDeleteOtp || sendingDeleteOtp}>
                    Cancel
                  </Button>
                  <Button variant="danger" loading={verifyingDeleteOtp} onClick={() => void verifyDeleteOtp()}>
                    Verify code
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7 }}>
                Verification complete. Deleting your account removes your access to HID immediately. You can recover your account through HID Support within 30 days. After 30 days, your account and data are permanently deleted and cannot be restored.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={deletingAccount}>
                  Cancel
                </Button>
                <Button variant="danger" loading={deletingAccount} onClick={() => void confirmPermanentDelete()}>
                  Delete account
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </HospitalLayout>
  )
}
