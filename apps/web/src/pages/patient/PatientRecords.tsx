import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell'
import { Badge, Card, EmptyState, Input, Modal, PageLoader, showToast } from '../../components/ui'
import { MedicalRecordMarkdownView } from '../../components/RecordMarkdownView'
import { RecordSummaryCard } from '../../components/RecordSummaryCard'
import { AddHealthInformationModal, type HealthInformationSubmission } from '../../components/AddHealthInformationModal'
import { HealthEventTimeline } from '../../components/HealthEventTimeline'
import { signOutAndClearSessions, usePortalSession } from '../../lib/auth'
import { readPatientRecordsSnapshot, seedPatientProfileCache, seedPatientRecordsCache } from '../../lib/experienceWarmup'
import {
  buildHealthInfoRecordBody,
  buildOptimisticMedicalRecord,
  filterRecordsByQuery,
  filterRecordsWithDocuments,
  getInvalidRecordUploadNames,
  groupRecordsByDay,
  inferLegacyCategoryFromInfoType,
  isMedicationRecord,
  type UploadDraft,
} from '../../lib/medicalRecordUtils'
import { sortHealthEvents } from '../../lib/healthEventUtils'
import {
  addRecordToHealthEvent,
  createHealthEvent,
  createMedicalRecordWithUploads,
  fetchPatientHealthEvents,
  fetchPatientRecordsView,
  removeRecordFromHealthEvent,
  renameHealthEvent,
  setHealthEventStatus,
} from '../../lib/hidApi'
import { getPersonInitials } from '../../lib/utils'
import type { MedicalRecord, MedicalRecordFile, Patient } from '../../types/database'
import type { HidHealthEvent, HidHealthEventStatus } from '../../types/hid'

const patientNav = [
  { path: '/patient/profile', label: 'Home' },
  { path: '/patient/records', label: 'Records' },
  { path: '/patient/history', label: 'Access History' },
  { path: '/patient/biodata', label: 'Biodata' },
]

type RecordsTab = 'history' | 'documents' | 'medication'

const RECORDS_TABS: { id: RecordsTab; label: string }[] = [
  { id: 'history', label: 'Medical History' },
  { id: 'documents', label: 'Medical Documents' },
  { id: 'medication', label: 'Medication' },
]

export default function PatientRecords() {
  const navigate = useNavigate()
  const location = useLocation()
  const { patient: session, hydrated } = usePortalSession()
  const cachedView = useMemo(() => (
    session ? readPatientRecordsSnapshot(session.hidCode) : null
  ), [session])
  const [records, setRecords] = useState<MedicalRecord[]>(() => cachedView?.records ?? [])
  const [recordFiles, setRecordFiles] = useState<Record<string, MedicalRecordFile[]>>(() => cachedView?.recordFiles ?? {})
  const [patient, setPatient] = useState<Patient | null>(() => cachedView?.patient ?? null)
  const [loading, setLoading] = useState(!cachedView)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preparingUploads, setPreparingUploads] = useState(false)
  const [search, setSearch] = useState('')
  const [uploads, setUploads] = useState<UploadDraft[]>([])
  const [healthEvents, setHealthEvents] = useState<HidHealthEvent[]>([])
  const [activeTab, setActiveTab] = useState<RecordsTab>('history')
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const saveLockRef = useRef(false)

  useEffect(() => {
    if (!hydrated) return
    if (!session) {
      navigate('/patient')
      return
    }
    void loadPageData(Boolean(cachedView))
  }, [cachedView, hydrated, navigate, session])

  useEffect(() => {
    if (location.state?.openAddHealthInfo) {
      setOpen(true)
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location, navigate])

  async function loadPageData(silent = false) {
    if (!session) return
    if (!silent) setLoading(true)
    try {
      const nextPage = await fetchPatientRecordsView(session.hidCode)
      seedPatientProfileCache(nextPage.patient)
      seedPatientRecordsCache(session.hidCode, nextPage)
      setPatient(nextPage.patient)
      setRecords(nextPage.records)
      setRecordFiles(nextPage.recordFiles)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load your records.'
      showToast(message, 'error')
    } finally {
      if (!silent) setLoading(false)
    }

    try {
      const events = await fetchPatientHealthEvents(session.hidCode)
      setHealthEvents(sortHealthEvents(events))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load health events.'
      showToast(message, 'error')
    }
  }

  async function handleAddRecordToEvent(eventId: string, recordId: string) {
    if (!session) return
    await addRecordToHealthEvent(eventId, recordId)
    const events = await fetchPatientHealthEvents(session.hidCode, { forceRefresh: true })
    setHealthEvents(sortHealthEvents(events))
  }

  async function handleRemoveRecordFromEvent(eventId: string, recordId: string) {
    if (!session) return
    await removeRecordFromHealthEvent(eventId, recordId)
    const events = await fetchPatientHealthEvents(session.hidCode, { forceRefresh: true })
    setHealthEvents(sortHealthEvents(events))
  }

  async function handleRenameHealthEvent(eventId: string, title: string) {
    if (!session) return
    await renameHealthEvent(eventId, title)
    const events = await fetchPatientHealthEvents(session.hidCode, { forceRefresh: true })
    setHealthEvents(sortHealthEvents(events))
  }

  async function handleSetHealthEventStatus(eventId: string, status: HidHealthEventStatus) {
    if (!session) return
    await setHealthEventStatus(eventId, status)
    const events = await fetchPatientHealthEvents(session.hidCode, { forceRefresh: true })
    setHealthEvents(sortHealthEvents(events))
  }

  async function logout() {
    await signOutAndClearSessions()
    navigate('/patient')
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
    if (!session || saving || saveLockRef.current) return

    saveLockRef.current = true
    setSaving(true)
    const category = inferLegacyCategoryFromInfoType(submission.infoType)
    const recordBody = buildHealthInfoRecordBody(submission.notes, submission.transcriptionText)
    const structuredData = Object.keys(submission.structuredData).length > 0 ? submission.structuredData : null
    const optimisticEntry = buildOptimisticMedicalRecord({
      category,
      createdBy: session.fullName,
      createdByRole: 'patient',
      hidCode: session.hidCode,
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
        patientIdentifier: session.hidCode,
        title: submission.title,
        category,
        record: recordBody,
        notes: submission.notes.trim() || null,
        uploads: submission.uploads,
        infoType: submission.infoType,
        structuredData,
      })
      await loadPageData(true)
      showToast('Health information saved.', 'success')

      if (submission.healthEvent.mode !== 'none') {
        try {
          if (submission.healthEvent.mode === 'new') {
            await createHealthEvent({
              patientIdentifier: session.hidCode,
              title: submission.healthEvent.title,
              infoCategory: submission.healthEvent.infoCategory,
              recordIds: [created.record_id],
            })
          } else {
            await addRecordToHealthEvent(submission.healthEvent.eventId, created.record_id)
          }
          const events = await fetchPatientHealthEvents(session.hidCode, { forceRefresh: true })
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

  function removeUpload(index: number) {
    setUploads(current => current.filter((_, currentIndex) => currentIndex !== index))
  }

  const filteredRecords = useMemo(() => filterRecordsByQuery(records, search), [records, search])
  const tabRecords = useMemo(() => {
    if (activeTab === 'documents') return filterRecordsWithDocuments(filteredRecords, recordFiles)
    if (activeTab === 'medication') return filteredRecords.filter(isMedicationRecord)
    return filteredRecords
  }, [activeTab, filteredRecords, recordFiles])
  const tabSections = useMemo(() => groupRecordsByDay(tabRecords), [tabRecords])
  const selectedRecord = useMemo(() => records.find(record => record.id === selectedRecordId) ?? null, [records, selectedRecordId])
  const patientInitials = getPersonInitials(patient?.full_name ?? session?.fullName ?? '')

  if (!hydrated) return <PageLoader label="Restoring your secure session..." />
  if (!session) return null
  if (loading) {
    return (
      <PortalShell
        title="Patient records"
        subtitle="Search, review, and add saved medical records."
        items={patientNav}
        onLogout={() => { void logout() }}
        userName={patient?.full_name ?? session.fullName}
        avatarUrl={patient?.photo_url}
        notificationPath="/patient/notifications"
        notificationHidCode={session.hidCode}
      >
        <PageLoader label="Loading your records..." />
      </PortalShell>
    )
  }

  return (
    <PortalShell
      title="Patient records"
      subtitle="Search, review, and add saved medical records."
      items={patientNav}
      onLogout={() => { void logout() }}
      userName={patient?.full_name ?? session.fullName}
      avatarUrl={patient?.photo_url}
      notificationPath="/patient/notifications"
      notificationHidCode={session.hidCode}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', overflow: 'hidden', background: 'linear-gradient(180deg, #f4f7fb 0%, #dfe8f4 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#68758b', flexShrink: 0 }}>
          {patient?.photo_url ? <img src={patient.photo_url} alt={session.fullName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : patientInitials}
        </div>
        <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>{session.fullName}</div>
          <div style={{ color: '#8da031', fontSize: 11 }}>{session.hidCode}</div>
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <Input
          placeholder="Search by date, title, or keyword"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
      </div>

      <div style={{ marginBottom: 18, maxWidth: '100%', overflowX: 'auto' }}>
        <div style={{ display: 'inline-flex', gap: 8, background: '#f6f7f8', borderRadius: 999, padding: 8 }}>
          {RECORDS_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={{
                border: 'none',
                borderRadius: 999,
                padding: '8px 16px',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                background: activeTab === tab.id ? '#fff' : 'transparent',
                color: activeTab === tab.id ? '#1891ff' : '#484f58',
                boxShadow: activeTab === tab.id ? '0px 2px 2px #fafafa' : 'none',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {records.length === 0 ? (
        <Card style={{ borderRadius: 16 }}>
          <EmptyState
            icon={<span style={{ fontSize: 28 }}>[]</span>}
            title="No medical records yet"
            description="Add your first piece of health information: a condition, lab result, medication, allergy, vaccination, procedure, hospital visit, or report."
          />
        </Card>
      ) : (
        <>
          {activeTab === 'history' && (
            <HealthEventTimeline
              events={healthEvents}
              records={records}
              onSelectRecord={recordId => setSelectedRecordId(recordId)}
              onAddRecord={handleAddRecordToEvent}
              onRemoveRecord={handleRemoveRecordFromEvent}
              onRename={handleRenameHealthEvent}
              onSetStatus={handleSetHealthEventStatus}
            />
          )}

          {filteredRecords.length === 0 ? (
            <Card style={{ borderRadius: 16 }}>
              <EmptyState
                icon={<span style={{ fontSize: 28 }}>[]</span>}
                title="No records match your search"
                description="Try a different date, title, or keyword."
              />
            </Card>
          ) : tabSections.length === 0 ? (
            <Card style={{ borderRadius: 16 }}>
              <EmptyState
                icon={<span style={{ fontSize: 28 }}>[]</span>}
                title={activeTab === 'documents' ? 'No medical documents yet' : 'No medication records yet'}
                description={activeTab === 'documents'
                  ? 'Records with attached files, like lab results or reports, will appear here.'
                  : 'Medications you add will appear here.'}
              />
            </Card>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {tabSections.map(section => (
                <Card key={section.key} style={{ borderRadius: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>{section.label}</div>
                    <Badge color="blue">{section.records.length} saved</Badge>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18 }}>
                    {section.records.map(record => (
                      <RecordSummaryCard
                        key={record.id}
                        record={record}
                        attachments={recordFiles[record.id] ?? []}
                        onClick={() => setSelectedRecordId(record.id)}
                      />
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ position: 'sticky', bottom: 20, display: 'flex', justifyContent: 'flex-end', marginTop: 24, pointerEvents: 'none' }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: '#1891ff',
            color: '#fff',
            border: 'none',
            borderRadius: 999,
            padding: '14px 22px',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 16px 32px rgba(24, 145, 255, 0.35)',
          }}
        >
          <PlusCircleIcon />
          Add Health Information
        </button>
      </div>

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
    </PortalShell>
  )
}

function PlusCircleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
