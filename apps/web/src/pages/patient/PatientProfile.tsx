import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell'
import { HomeDashboard } from '../../components/home/HomeDashboard'
import { PageLoader, showToast } from '../../components/ui'
import { signOutAndClearSessions, usePortalSession } from '../../lib/auth'
import {
  readPatientHistorySnapshot,
  readPatientProfileSnapshot,
  readPatientRecordsSnapshot,
  seedPatientHistoryCache,
  seedPatientProfileCache,
  seedPatientRecordsCache,
  warmPatientExperience,
} from '../../lib/experienceWarmup'
import {
  fetchMyPatient,
  fetchPatientHealthEvents,
  fetchPatientHistory,
  fetchPatientRecordsView,
  type LegacyAccessRequestWithShare,
} from '../../lib/hidApi'
import { sortHealthEvents } from '../../lib/healthEventUtils'
import type { AccessLog, MedicalRecord, MedicalRecordFile, Patient } from '../../types/database'
import type { HidHealthEvent, HidPendingShareInvite } from '../../types/hid'

const patientNav = [
  { path: '/patient/profile', label: 'Home' },
  { path: '/patient/records', label: 'Records' },
  { path: '/patient/history', label: 'Access History' },
  { path: '/patient/biodata', label: 'Biodata' },
]

export default function PatientProfile() {
  const navigate = useNavigate()
  const { patient: session, hydrated } = usePortalSession()
  const cachedPatient = useMemo(() => (
    session ? readPatientProfileSnapshot(session.hidCode) : null
  ), [session])
  const [patient, setPatient] = useState<Patient | null>(cachedPatient)
  const [loading, setLoading] = useState(!cachedPatient)

  const cachedRecordsView = useMemo(() => (
    session ? readPatientRecordsSnapshot(session.hidCode) : null
  ), [session])
  const cachedHistory = useMemo(() => (
    session ? readPatientHistorySnapshot(session.hidCode) : null
  ), [session])
  const [records, setRecords] = useState<MedicalRecord[]>(() => cachedRecordsView?.records ?? [])
  const [recordFiles, setRecordFiles] = useState<Record<string, MedicalRecordFile[]>>(() => cachedRecordsView?.recordFiles ?? {})
  const [healthEvents, setHealthEvents] = useState<HidHealthEvent[]>([])
  const [activeGrants, setActiveGrants] = useState<LegacyAccessRequestWithShare[]>(() => cachedHistory?.activeGrants ?? [])
  const [pendingInvites, setPendingInvites] = useState<HidPendingShareInvite[]>(() => cachedHistory?.pendingInvites ?? [])
  const [logs, setLogs] = useState<AccessLog[]>(() => cachedHistory?.logs ?? [])

  useEffect(() => {
    if (!hydrated) return
    if (!session) {
      navigate('/patient')
      return
    }

    let active = true
    void (async () => {
      try {
        const nextPatient = await fetchMyPatient()
        if (!active) return
        seedPatientProfileCache(nextPatient)
        if (session) {
          warmPatientExperience(session, nextPatient)
        }
        setPatient(nextPatient)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to load your profile.'
        showToast(message, 'error')
        if (active) navigate('/patient')
      } finally {
        if (active) setLoading(false)
      }
    })()

    return () => { active = false }
  }, [hydrated, navigate, session])

  useEffect(() => {
    if (!session) return
    void loadDashboardData()
  }, [session])

  async function loadDashboardData() {
    if (!session) return

    try {
      const recordsView = await fetchPatientRecordsView(session.hidCode)
      seedPatientRecordsCache(session.hidCode, recordsView)
      setRecords(recordsView.records)
      setRecordFiles(recordsView.recordFiles)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load your records.'
      showToast(message, 'error')
    }

    try {
      const events = await fetchPatientHealthEvents(session.hidCode)
      setHealthEvents(sortHealthEvents(events))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load health events.'
      showToast(message, 'error')
    }

    try {
      const history = await fetchPatientHistory(session.hidCode)
      seedPatientHistoryCache(session.hidCode, history)
      setActiveGrants(history.activeGrants)
      setPendingInvites(history.pendingInvites)
      setLogs(history.logs)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load your access history.'
      showToast(message, 'error')
    }
  }

  async function logout() {
    await signOutAndClearSessions()
    navigate('/patient')
  }

  if (!hydrated) return <PageLoader label="Restoring your secure session..." />
  if (!session) return null
  if (loading || !patient) {
    return (
      <PortalShell
        title=""
        items={patientNav}
        onLogout={() => { void logout() }}
        userName={session.fullName}
        notificationPath="/patient/notifications"
        notificationHidCode={session.hidCode}
      >
        <PageLoader label="Loading your dashboard..." />
      </PortalShell>
    )
  }

  const patientName = `${patient.first_name ?? ''} ${patient.last_name ?? ''}`.trim() || patient.full_name

  return (
    <PortalShell
      title=""
      items={patientNav}
      onLogout={() => { void logout() }}
      userName={patientName}
      avatarUrl={patient.photo_url}
      notificationPath="/patient/notifications"
      notificationHidCode={session.hidCode}
    >
      <HomeDashboard
        patient={patient}
        records={records}
        recordFiles={recordFiles}
        healthEvents={healthEvents}
        activeGrants={activeGrants}
        pendingInvites={pendingInvites}
        logs={logs}
        onRefresh={() => void loadDashboardData()}
      />
    </PortalShell>
  )
}
