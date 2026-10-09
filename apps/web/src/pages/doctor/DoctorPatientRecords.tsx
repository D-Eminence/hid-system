import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { HospitalLayout } from '../../components/HospitalLayout'
import { Badge, Button, Card, EmptyState, Input, Modal, PageLoader, showToast } from '../../components/ui'
import { MedicalRecordMarkdownView } from '../../components/RecordMarkdownView'
import { AddHealthInformationModal, type HealthInformationSubmission } from '../../components/AddHealthInformationModal'
import { HealthEventTimeline } from '../../components/HealthEventTimeline'
import { signOutAndClearSessions, usePortalSession } from '../../lib/auth'
import { subscribeToAccessChanges } from '../../lib/accessRealtime'
import {
  readDoctorDashboardSnapshot,
  seedDoctorDashboardCache,
  seedDoctorPatientRecordsCache,
} from '../../lib/experienceWarmup'
import { HOSPITAL_ACCESS_PATH, HOSPITAL_AUTH_PATH } from '../../lib/hospitalRoutes'
import {
  buildHealthInfoRecordBody,
  buildOptimisticMedicalRecord,
  countAllRecordAttachments,
  filterRecordsByQuery,
  getInvalidRecordUploadNames,
  groupRecordsByDay,
  inferLegacyCategoryFromInfoType,
  type UploadDraft,
} from '../../lib/medicalRecordUtils'
import { sortHealthEvents } from '../../lib/healthEventUtils'
import {
  addRecordToHealthEvent,
  closeMyAccessGrant,
  createHealthEvent,
  createMedicalRecordWithUploads,
  fetchPatientHealthEvents,
  fetchPatientRecordsView,
  fetchStaffDashboard,
  removeRecordFromHealthEvent,
  renameHealthEvent,
  setHealthEventStatus,
} from '../../lib/hidApi'
import { formatDateTime } from '../../lib/utils'
import type { MedicalRecord, MedicalRecordFile, Patient } from '../../types/database'
import type { HidHealthEvent, HidHealthEventStatus, HidStaffDashboardRequest } from '../../types/hid'

const ACCESS_GRANT_FALLBACK_POLL_MS = 60000

export default function DoctorPatientRecords() {
  const navigate = useNavigate()
  const { hidCode = '' } = useParams()
  const { staff: session, hydrated } = usePortalSession()
  const normalizedHidCode = hidCode.trim().toUpperCase()
  const cachedDashboard = useMemo(() => (
    session ? readDoctorDashboardSnapshot(session.id) : null
  ), [session])
  const initialActiveRequest = useMemo(() => (
    cachedDashboard?.requests.find(item =>
      item.hid_code === normalizedHidCode &&
      item.grant_status === 'active' &&
      !!item.expires_at &&
      new Date(item.expires_at).getTime() > Date.now()
    ) ?? null
  ), [cachedDashboard, normalizedHidCode])
  const [patient, setPatient] = useState<Patient | null>(null)
  const [records, setRecords] = useState<MedicalRecord[]>([])
  const [recordFiles, setRecordFiles] = useState<Record<string, MedicalRecordFile[]>>({})
  const [activeRequest, setActiveRequest] = useState<HidStaffDashboardRequest | null>(initialActiveRequest)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preparingUploads, setPreparingUploads] = useState(false)
  const [uploads, setUploads] = useState<UploadDraft[]>([])
  const [healthEvents, setHealthEvents] = useState<HidHealthEvent[]>([])
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const saveLockRef = useRef(false)

  function handleRevokedAccess() {
    showToast('This patient access was closed or revoked. Return to the access page to continue.', 'error')
    navigate(HOSPITAL_ACCESS_PATH, { replace: true })
  }

  useEffect(() => {
    if (!hydrated) return
    if (!session) {
      navigate(HOSPITAL_AUTH_PATH)
      return
    }
    if (!normalizedHidCode) {
      navigate(HOSPITAL_ACCESS_PATH)
      return
    }
    void loadPageData(false, true)
  }, [hydrated, navigate, normalizedHidCode, session])

  useEffect(() => {
    if (!activeRequest?.grant_id || !normalizedHidCode || !session) return

    let active = true
    let checking = false

    const verifyGrant = async () => {
      if (!active || checking) return
      checking = true
      try {
        const dashboard = await fetchStaffDashboard({ forceRefresh: true })
        seedDoctorDashboardCache(session.id, dashboard)
        const grant = dashboard.requests.find(item =>
          item.grant_id === activeRequest.grant_id &&
          item.hid_code === normalizedHidCode &&
          item.grant_status === 'active' &&
          !!item.expires_at &&
          new Date(item.expires_at).getTime() > Date.now()
        ) ?? null

        if (!grant && active) {
          showToast('This patient access was closed or revoked. Return to the access page to continue.', 'error')
          navigate(HOSPITAL_ACCESS_PATH, { replace: true })
          return
        }

        setActiveRequest(grant)
      } catch {
        // Best effort only. Access control is still enforced by the backend.
      } finally {
        checking = false
      }
    }

    const unsubscribe = subscribeToAccessChanges(change => {
      if (document.visibilityState === 'visible') {
        if (change.table.startsWith('hid_medical_record')) {
          void loadPageData(true, true)
        } else {
          void verifyGrant()
        }
      }
    })
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void verifyGrant()
      }
    }, ACCESS_GRANT_FALLBACK_POLL_MS)

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void verifyGrant()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      unsubscribe()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [activeRequest?.grant_id, navigate, normalizedHidCode, session])

  async function loadPageData(silent = false, forceRefresh = false) {
    if (!session || !normalizedHidCode) return
    if (!silent) setLoading(true)
    try {
      const [dashboard, recordsView] = await Promise.all([
        fetchStaffDashboard({ forceRefresh }),
        fetchPatientRecordsView(normalizedHidCode, { forceRefresh: true }),
      ])
      seedDoctorDashboardCache(session.id, dashboard)
      seedDoctorPatientRecordsCache(session.id, normalizedHidCode, recordsView)

      const grant = dashboard.requests.find(item =>
        item.hid_code === normalizedHidCode &&
        item.grant_status === 'active' &&
        !!item.expires_at &&
        new Date(item.expires_at).getTime() > Date.now()
      ) ?? null

      if (!grant?.grant_id) {
        showToast('This patient record access is no longer active.', 'error')
        navigate(HOSPITAL_ACCESS_PATH)
        return
      }

      setActiveRequest(grant)
      setPatient(recordsView.patient)
      setRecords(recordsView.records)
      setRecordFiles(recordsView.recordFiles)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load the patient records.'
      showToast(message, 'error')
      navigate(HOSPITAL_ACCESS_PATH)
    } finally {
      if (!silent) setLoading(false)
    }

    try {
      const events = await fetchPatientHealthEvents(normalizedHidCode, { forceRefresh })
      setHealthEvents(sortHealthEvents(events))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load health events.'
      showToast(message, 'error')
    }
  }

  async function handleAddRecordToEvent(eventId: string, recordId: string) {
    if (!normalizedHidCode) return
    await addRecordToHealthEvent(eventId, recordId)
    const events = await fetchPatientHealthEvents(normalizedHidCode, { forceRefresh: true })
    setHealthEvents(sortHealthEvents(events))
  }

  async function handleRemoveRecordFromEvent(eventId: string, recordId: string) {
    if (!normalizedHidCode) return
    await removeRecordFromHealthEvent(eventId, recordId)
    const events = await fetchPatientHealthEvents(normalizedHidCode, { forceRefresh: true })
    setHealthEvents(sortHealthEvents(events))
  }

  async function handleRenameHealthEvent(eventId: string, title: string) {
    if (!normalizedHidCode) return
    await renameHealthEvent(eventId, title)
    const events = await fetchPatientHealthEvents(normalizedHidCode, { forceRefresh: true })
    setHealthEvents(sortHealthEvents(events))
  }

  async function handleSetHealthEventStatus(eventId: string, status: HidHealthEventStatus) {
    if (!normalizedHidCode) return
    await setHealthEventStatus(eventId, status)
    const events = await fetchPatientHealthEvents(normalizedHidCode, { forceRefresh: true })
    setHealthEvents(sortHealthEvents(events))
  }

  async function logout() {
    await signOutAndClearSessions()
    navigate(HOSPITAL_AUTH_PATH)
  }

  async function onAttachment(files: FileList | null) {
    if (!files || files.length === 0 || preparingUploads) return
    const selectedFiles = Array.from(files)
    const invalidFiles = getInvalidRecordUploadNames(selectedFiles)
    if (invalidFiles.length > 0) {
      showToast(`Only JPG, PNG, IMG, and PDF files can be uploaded. Remove: ${invalidFiles.join(', ')}`, 'error')
      return
    }

    setPreparingUploads(true)
    try {
      const newUploads = await Promise.all(selectedFiles.map(file => new Promise<UploadDraft>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve({
          file_name: file.name,
          file_type: file.type || 'application/octet-stream',
          file_data_url: typeof reader.result === 'string' ? reader.result : '',
        })
        reader.onerror = () => reject(new Error(`Unable to read ${file.name}`))
        reader.readAsDataURL(file)
      })))

      setUploads(current => [...current, ...newUploads])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to prepare the selected files right now.'
      showToast(message, 'error')
    } finally {
      setPreparingUploads(false)
    }
  }

  async function saveHealthInformation(submission: HealthInformationSubmission) {
    if (!session || !patient || saving || saveLockRef.current) return

    saveLockRef.current = true
    setSaving(true)
    const category = inferLegacyCategoryFromInfoType(submission.infoType)
    const recordBody = buildHealthInfoRecordBody(submission.notes, submission.transcriptionText)
    const structuredData = Object.keys(submission.structuredData).length > 0 ? submission.structuredData : null
    const optimisticEntry = buildOptimisticMedicalRecord({
      category,
      createdBy: session.fullName,
      createdByRole: session.role,
      hidCode: patient.hid_code,
      notes: submission.notes.trim() || null,
      record: recordBody,
      title: submission.title,
      transcriptionText: submission.transcriptionText.trim() || null,
      uploads: submission.uploads,
      infoType: submission.infoType,
      structuredData,
    })

    setRecords(current => [optimisticEntry.record, ...current])
    setRecordFiles(current => ({
      ...current,
      [optimisticEntry.record.id]: optimisticEntry.attachments,
    }))
    setOpen(false)
    setUploads([])
    try {
      const created = await createMedicalRecordWithUploads({
        patientIdentifier: patient.hid_code,
        title: submission.title,
        category,
        record: recordBody,
        notes: submission.notes.trim() || null,
        uploads: submission.uploads,
        infoType: submission.infoType,
        structuredData,
      })
      await loadPageData(true, true)
      showToast('Health information saved.', 'success')

      if (submission.healthEvent.mode !== 'none') {
        try {
          if (submission.healthEvent.mode === 'new') {
            await createHealthEvent({
              patientIdentifier: patient.hid_code,
              title: submission.healthEvent.title,
              infoCategory: submission.healthEvent.infoCategory,
              recordIds: [created.record_id],
            })
          } else {
            await addRecordToHealthEvent(submission.healthEvent.eventId, created.record_id)
          }
          const events = await fetchPatientHealthEvents(normalizedHidCode, { forceRefresh: true })
          setHealthEvents(sortHealthEvents(events))
        } catch {
          showToast('Health information saved, but adding it to the health event failed - you can add it manually.', 'error')
        }
      }
    } catch (error) {
      setRecords(current => current.filter(item => item.id !== optimisticEntry.record.id))
      setRecordFiles(current => {
        const next = { ...current }
        delete next[optimisticEntry.record.id]
        return next
      })
      const message = error instanceof Error ? error.message : 'Unable to save health information.'
      showToast(message, 'error')
    } finally {
      setSaving(false)
      saveLockRef.current = false
    }
  }

  async function closeProfile() {
    if (!activeRequest?.grant_id) {
      navigate(HOSPITAL_ACCESS_PATH)
      return
    }

    try {
      await closeMyAccessGrant(activeRequest.grant_id)
      showToast('Patient access closed.', 'success')
      navigate(HOSPITAL_ACCESS_PATH)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to close this patient access session.'
      showToast(message, 'error')
    }
  }

  function removeUpload(index: number) {
    setUploads(current => current.filter((_, currentIndex) => currentIndex !== index))
  }

  const filteredRecords = useMemo(() => filterRecordsByQuery(records, search), [records, search])
  const recordSections = useMemo(() => groupRecordsByDay(filteredRecords), [filteredRecords])
  const selectedRecord = useMemo(() => records.find(record => record.id === selectedRecordId) ?? null, [records, selectedRecordId])
  const totalFiles = useMemo(() => countAllRecordAttachments(records, recordFiles), [recordFiles, records])
  const latestRecord = records[0]
  const resultSummary = `${filteredRecords.length} record${filteredRecords.length === 1 ? '' : 's'} shown in newest to oldest order.`

  if (!hydrated) return <PageLoader label="Restoring your secure session..." />
  if (!session) return null
  if (loading) return <PageLoader label="Loading patient records..." />

  return (
    <HospitalLayout
      activeSection="access"
      title="Patient Records"
      subtitle="Authorized provider access to saved patient medical records."
      onLogout={() => { void logout() }}
      userName={session.fullName}
      organizationName={session.hospitalName ?? null}
      onAccessRevoked={handleRevokedAccess}
    >
      <Card style={{ borderRadius: 24, marginBottom: 18, background: 'linear-gradient(180deg, #ffffff 0%, #f7fbff 100%)', borderColor: '#dbe8f8' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#111827', overflowWrap: 'anywhere' }}>{patient?.full_name ?? hidCode}</div>
              <Badge color={activeRequest?.break_glass ? 'red' : 'green'}>
                {activeRequest?.break_glass ? 'Emergency access active' : 'Approved access active'}
              </Badge>
            </div>
            <div style={{ color: '#6b7280', fontSize: 13, marginTop: 8 }}>
              Search saved records, review attachments, and add new medical records while this grant is active.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => navigate(HOSPITAL_ACCESS_PATH)}>Back to access</Button>
            <Button variant="outline" onClick={() => void closeProfile()}>Close access</Button>
            <Button onClick={() => setOpen(true)}>Add health information</Button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginTop: 20 }}>
          <StatCard label="Patient HID" value={patient?.hid_code ?? '-'} />
          <StatCard label="Total records" value={`${records.length}`} />
          <StatCard label="Attached files" value={`${totalFiles}`} />
          <StatCard label="Access granted" value={activeRequest?.approved_at ? formatDateTime(activeRequest.approved_at) : '-'} />
          <StatCard label="Access expires" value={activeRequest?.expires_at ? formatDateTime(activeRequest.expires_at) : '-'} />
          <StatCard label="Latest update" value={latestRecord ? formatDateTime(latestRecord.created_at) : 'No records yet'} />
        </div>

        <div style={{ marginTop: 18 }}>
          <Input
            label="Search patient records"
            placeholder="Search by date, title, or keyword"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>{resultSummary}</div>
        </div>
      </Card>

      <HealthEventTimeline
        events={healthEvents}
        records={records}
        onSelectRecord={recordId => setSelectedRecordId(recordId)}
        onAddRecord={handleAddRecordToEvent}
        onRemoveRecord={handleRemoveRecordFromEvent}
        onRename={handleRenameHealthEvent}
        onSetStatus={handleSetHealthEventStatus}
      />

      {records.length === 0 ? (
        <Card style={{ borderRadius: 24 }}>
          <EmptyState
            icon={<span style={{ fontSize: 28 }}>[]</span>}
            title="No medical records saved yet"
            description="Use this page to add the first piece of health information for this patient."
            action={<Button onClick={() => setOpen(true)}>Add health information</Button>}
          />
        </Card>
      ) : recordSections.length === 0 ? (
        <Card style={{ borderRadius: 24 }}>
          <EmptyState
            icon={<span style={{ fontSize: 28 }}>[]</span>}
            title="No records match your search"
            description="Try a different date, record title, or keyword."
          />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {recordSections.map(section => (
            <Card key={section.key} style={{ borderRadius: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>{section.label}</div>
                <Badge color="blue">{section.records.length} saved</Badge>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18 }}>
                {section.records.map(record => (
                  <div key={record.id} style={{ border: '1px solid #edf1f5', borderRadius: 18, padding: 14, minWidth: 0 }}>
                    <MedicalRecordMarkdownView record={record} attachments={recordFiles[record.id] ?? []} />
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      <AddHealthInformationModal
        open={open}
        onClose={() => { setOpen(false); setUploads([]) }}
        saving={saving}
        preparingUploads={preparingUploads}
        uploads={uploads}
        healthEvents={healthEvents}
        onAttachment={onAttachment}
        onRemoveUpload={removeUpload}
        onSubmit={saveHealthInformation}
      />

      <Modal open={Boolean(selectedRecord)} onClose={() => setSelectedRecordId(null)} title={selectedRecord?.title ?? 'Record details'} width={640}>
        {selectedRecord && (
          <MedicalRecordMarkdownView record={selectedRecord} attachments={recordFiles[selectedRecord.id] ?? []} />
        )}
      </Modal>
    </HospitalLayout>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ borderRadius: 18, border: '1px solid #dbe8f8', background: '#fff', padding: 16, minWidth: 0 }}>
      <div style={{ color: '#6b7280', fontSize: 12 }}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 18, fontWeight: 700, color: '#111827', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  )
}
