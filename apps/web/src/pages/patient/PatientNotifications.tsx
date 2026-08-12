import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell'
import { Button, Card, PageLoader, showToast } from '../../components/ui'
import { signOutAndClearSessions, usePortalSession } from '../../lib/auth'
import { readPatientNotificationsSnapshot, readPatientProfileSnapshot, seedPatientNotificationsCache, seedPatientProfileCache } from '../../lib/experienceWarmup'
import { fetchMyPatient, listNotifications, markNotificationRead } from '../../lib/hidApi'
import { subscribeToNotifications } from '../../lib/notificationsRealtime'
import { formatDateTime } from '../../lib/utils'
import type { Notification, Patient } from '../../types/database'

const patientNav = [
  { path: '/patient/profile', label: 'Home' },
  { path: '/patient/records', label: 'Records' },
  { path: '/patient/history', label: 'Access History' },
  { path: '/patient/biodata', label: 'Biodata' },
]

export default function PatientNotifications() {
  const navigate = useNavigate()
  const { patient: session, hydrated } = usePortalSession()
  const cachedNotifications = useMemo(() => (
    session ? readPatientNotificationsSnapshot(session.hidCode) : null
  ), [session])
  const cachedPatient = useMemo(() => (
    session ? readPatientProfileSnapshot(session.hidCode) : null
  ), [session])
  const [notifications, setNotifications] = useState<Notification[]>(() => cachedNotifications?.notifications ?? [])
  const [patient, setPatient] = useState<Patient | null>(() => cachedNotifications?.patient ?? cachedPatient)
  const [loading, setLoading] = useState(!cachedNotifications && !cachedPatient)

  useEffect(() => {
    if (!hydrated) return
    if (!session) {
      navigate('/patient')
      return
    }
    void loadNotificationsPage(Boolean(cachedNotifications || cachedPatient))
  }, [cachedNotifications, cachedPatient, hydrated, navigate, session])

  useEffect(() => {
    if (!session) return
    const unsubscribe = subscribeToNotifications(() => {
      void loadNotificationsPage(true)
    })
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadNotificationsPage(true)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [session])

  async function loadNotificationsPage(silent = false) {
    if (!session) return
    if (!silent) setLoading(true)
    try {
      const patientPromise = patient
        ? Promise.resolve(patient)
        : fetchMyPatient()
      const [nextPatient, nextNotifications] = await Promise.all([
        patientPromise,
        listNotifications(session.hidCode, { forceRefresh: silent }),
      ])
      if (!patient) {
        seedPatientProfileCache(nextPatient)
      }
      seedPatientNotificationsCache(session.hidCode, {
        patient: nextPatient,
        notifications: nextNotifications,
      })
      setPatient(nextPatient)
      setNotifications(nextNotifications)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load notifications.'
      showToast(message, 'error')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  async function logout() {
    await signOutAndClearSessions()
    navigate('/patient')
  }

  async function markRead(id: string) {
    const previousNotifications = notifications
    setNotifications(items => items.map(item => item.id === id ? { ...item, is_read: true } : item))
    try {
      await markNotificationRead(id)
    } catch (error) {
      setNotifications(previousNotifications)
      const message = error instanceof Error ? error.message : 'Unable to update this notification.'
      showToast(message, 'error')
    }
  }

  if (!hydrated) return <PageLoader label="Restoring your secure session..." />
  if (!session) return null
  if (loading) {
    return (
      <PortalShell
        title="Notifications"
        subtitle="Access alerts and system updates"
        items={patientNav}
        onLogout={() => { void logout() }}
        userName={patient?.full_name ?? session.fullName}
        avatarUrl={patient?.photo_url}
        notificationPath="/patient/notifications"
        notificationHidCode={session.hidCode}
      >
        <PageLoader label="Loading your notifications..." />
      </PortalShell>
    )
  }

  return (
    <PortalShell
      title="Notifications"
      subtitle="Access alerts and system updates"
      items={patientNav}
      onLogout={() => { void logout() }}
      userName={patient?.full_name ?? session.fullName}
      avatarUrl={patient?.photo_url}
      notificationPath="/patient/notifications"
      notificationHidCode={session.hidCode}
    >
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {notifications.map(item => (
            <div key={item.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, background: item.is_read ? '#fff' : '#eff6ff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <div style={{ fontWeight: 700 }}>{item.title}</div>
                  <div style={{ color: '#374151', marginTop: 6 }}>{item.message}</div>
                  <div style={{ color: '#6b7280', fontSize: 13, marginTop: 6 }}>{formatDateTime(item.created_at)}</div>
                </div>
                {!item.is_read && <Button size="sm" variant="outline" onClick={() => void markRead(item.id)}>Mark read</Button>}
              </div>
            </div>
          ))}
          {notifications.length === 0 && <div style={{ color: '#6b7280' }}>No notifications yet.</div>}
        </div>
      </Card>
    </PortalShell>
  )
}
