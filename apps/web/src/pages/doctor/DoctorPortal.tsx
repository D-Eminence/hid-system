import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HospitalLayout } from '../../components/HospitalLayout'
import { Badge, Button, Card, EmptyState, Input, Modal, PageLoader, Textarea, showToast } from '../../components/ui'
import { FileAttachmentPreview, MedicalRecordMarkdownView } from '../../components/RecordMarkdownView'
import { VoiceToTextButton } from '../../components/VoiceToTextButton'
import { signOutAndClearSessions, usePortalSession } from '../../lib/auth'
import { subscribeToAccessChanges } from '../../lib/accessRealtime'
import {
  readDoctorPatientRecordsSnapshot,
  seedDoctorDashboardCache,
  seedDoctorPatientRecordsCache,
} from '../../lib/experienceWarmup'
import { isCompleteHidInput, normalizeHidInput } from '../../lib/hidInput'
import { HOSPITAL_AUTH_PATH, HOSPITAL_EMERGENCY_PATH, getHospitalPatientRecordsPath } from '../../lib/hospitalRoutes'
import {
  buildOptimisticMedicalRecord,
  buildStructuredRecordBody,
  createEmptyRecordForm,
  getInvalidRecordUploadNames,
  hasRecordContent,
  inferRecordCategory,
  RECORD_UPLOAD_ACCEPT,
  type UploadDraft,
} from '../../lib/medicalRecordUtils'
import { accessPatientWithPin, createMedicalRecordWithUploads, fetchPatientRecordsView, fetchStaffDashboard } from '../../lib/hidApi'
import { formatDateTime } from '../../lib/utils'
import type { MedicalRecord, MedicalRecordFile, Patient } from '../../types/database'

interface AccessedData {
  patient: Patient
  records: MedicalRecord[]
  recordFiles: Record<string, MedicalRecordFile[]>
}

const ACCESS_GRANT_FALLBACK_POLL_MS = 60000

export default function DoctorPortal() {
  const navigate = useNavigate()
  const { staff: session, hydrated } = usePortalSession()
  const [hidCode, setHidCode] = useState('HID-')
  const [pin, setPin] = useState('')
  const [staffName, setStaffName] = useState(session?.fullName ?? '')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<AccessedData | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showAddRecord, setShowAddRecord] = useState(false)
  const [addingRecord, setAddingRecord] = useState(false)
  const [preparingUploads, setPreparingUploads] = useState(false)
  const [recordForm, setRecordForm] = useState(createEmptyRecordForm())
  const [activeGrantId, setActiveGrantId] = useState<string | null>(null)
  const saveLockRef = useRef(false)

  function handleRevokedAccess() {
    setActiveGrantId(null)
    setData(null)
    setPin('')
  }

  useEffect(() => {
    if (!hydrated) return
    if (!session) {
      navigate(HOSPITAL_AUTH_PATH)
    }
  }, [hydrated, navigate, session])

  async function logout() {
    await signOutAndClearSessions()
    navigate(HOSPITAL_AUTH_PATH)
  }

  function validate() {
    const nextErrors: Record<string, string> = {}
    if (!isCompleteHidInput(hidCode)) nextErrors.hid = 'HID code is required'
    if (!pin.trim()) nextErrors.pin = 'Access PIN is required'
    if (!staffName.trim()) nextErrors.staff = 'Staff name is required'
    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  async function loadPatientView(normalizedHidCode: string, forceRefresh = false) {
    if (!session) throw new Error('Please sign in to continue.')
    const view = await fetchPatientRecordsView(normalizedHidCode, { forceRefresh })
    seedDoctorPatientRecordsCache(session.id, normalizedHidCode, view)
    setData({
      patient: view.patient,
      records: view.records,
      recordFiles: view.recordFiles,
    })
    return view
  }

  async function handleAccess(event: React.FormEvent) {
    event.preventDefault()
    if (!session || !validate()) return

    const normalizedHidCode = normalizeHidInput(hidCode)
    setLoading(true)
    setData(null)

    try {
      const response = await accessPatientWithPin(normalizedHidCode, pin.trim(), 60, staffName)
      setActiveGrantId(response.grant_id)
      const cachedView = readDoctorPatientRecordsSnapshot(session.id, normalizedHidCode)
      if (cachedView) {
        setData({
          patient: cachedView.patient,
          records: cachedView.records,
          recordFiles: cachedView.recordFiles,
        })
      }
      const view = await loadPatientView(normalizedHidCode, true)
      showToast(`Access granted. Patient: ${view.patient.full_name}`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to access this patient right now.'
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!activeGrantId || !data?.patient.hid_code || !session) return

    const currentSession = session
    let active = true
    let checking = false

    const verifyGrant = async () => {
      if (!active || checking) return
      checking = true
      try {
        const dashboard = await fetchStaffDashboard({ forceRefresh: true })
        seedDoctorDashboardCache(currentSession.id, dashboard)
        const stillActive = dashboard.requests.some(item =>
          item.grant_id === activeGrantId &&
          item.hid_code === data.patient.hid_code &&
          item.grant_status === 'active' &&
          !!item.expires_at &&
          new Date(item.expires_at).getTime() > Date.now()
        )

        if (!stillActive && active) {
          setActiveGrantId(null)
          setData(null)
          setPin('')
          showToast('This patient access was closed or revoked. Enter the HID details again to continue.', 'error')
        }
      } catch {
        // Best effort only. Access actions will still be enforced by the backend.
      } finally {
        checking = false
      }
    }

    const unsubscribe = subscribeToAccessChanges(change => {
      if (document.visibilityState === 'visible') {
        if (change.table.startsWith('hid_medical_record')) {
          void loadPatientView(data.patient.hid_code, true)
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
  }, [activeGrantId, data?.patient.hid_code, session])

  async function handleAddRecord(event: React.FormEvent) {
    event.preventDefault()
    if (!session || !data || addingRecord || saveLockRef.current) return
    if (preparingUploads) {
      showToast('Attached files are still being prepared. Please wait a moment, then save again.', 'error')
      return
    }
    if (!recordForm.title.trim()) {
      showToast('Enter a record title before saving.', 'error')
      return
    }
    if (!hasRecordContent(recordForm)) {
      showToast('Add a note, result, detail, audio note, or file before saving.', 'error')
      return
    }

    saveLockRef.current = true
    setAddingRecord(true)
    const formSnapshot = recordForm
    const optimisticEntry = buildOptimisticMedicalRecord({
      category: inferRecordCategory(recordForm),
      createdBy: session.fullName,
      createdByRole: session.role,
      hidCode: data.patient.hid_code,
      notes: recordForm.roleNote.trim() || null,
      record: buildStructuredRecordBody(recordForm),
      title: recordForm.title.trim(),
      transcriptionText: recordForm.transcriptionText.trim() || null,
      uploads: recordForm.uploads,
    })

    setData(current => current ? {
      ...current,
      recordFiles: {
        ...current.recordFiles,
        [optimisticEntry.record.id]: optimisticEntry.attachments,
      },
      records: [optimisticEntry.record, ...current.records],
    } : current)
    setRecordForm(createEmptyRecordForm())
    setShowAddRecord(false)
    try {
      await createMedicalRecordWithUploads({
        patientIdentifier: data.patient.hid_code,
        title: recordForm.title.trim(),
        category: inferRecordCategory(recordForm),
        record: buildStructuredRecordBody(recordForm),
        notes: recordForm.roleNote.trim() || null,
        uploads: recordForm.uploads,
      })
      await loadPatientView(data.patient.hid_code, true)
      showToast('Medical record added successfully', 'success')
    } catch (error) {
      setData(current => current ? {
        ...current,
        recordFiles: Object.fromEntries(Object.entries(current.recordFiles).filter(([key]) => key !== optimisticEntry.record.id)),
        records: current.records.filter(item => item.id !== optimisticEntry.record.id),
      } : current)
      setRecordForm(formSnapshot)
      setShowAddRecord(true)
      const message = error instanceof Error ? error.message : 'Unable to save the medical record.'
      showToast(message, 'error')
    } finally {
      setAddingRecord(false)
      saveLockRef.current = false
    }
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
      const uploads = await Promise.all(selectedFiles.map(file => new Promise<UploadDraft>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve({
          file_name: file.name,
          file_type: file.type || 'application/octet-stream',
          file_data_url: typeof reader.result === 'string' ? reader.result : '',
        })
        reader.onerror = () => reject(new Error(`Unable to read ${file.name}`))
        reader.readAsDataURL(file)
      })))

      setRecordForm(current => ({
        ...current,
        uploads: [...current.uploads, ...uploads],
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to prepare the selected files right now.'
      showToast(message, 'error')
    } finally {
      setPreparingUploads(false)
    }
  }

  function appendAudioTranscript(transcript: string) {
    setRecordForm(current => ({
      ...current,
      transcriptionText: `${current.transcriptionText}${current.transcriptionText.trim() ? '\n' : ''}${transcript}`.trim(),
    }))
  }

  function removeUpload(index: number) {
    setRecordForm(current => ({ ...current, uploads: current.uploads.filter((_, currentIndex) => currentIndex !== index) }))
  }

  if (!hydrated) return <PageLoader label="Restoring your secure session..." />
  if (!session) return null

  return (
    <HospitalLayout
      activeSection="access"
      title="Doctor Access Portal"
      subtitle="Access and manage patient records securely."
      onLogout={() => { void logout() }}
      userName={session.fullName}
      organizationName={session.hospitalName ?? null}
      onAccessRevoked={handleRevokedAccess}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <Card>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Patient Record Lookup</h2>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
            Enter the patient HID code and access PIN to retrieve records. Use the emergency route only for urgent care situations.
          </p>

          <form onSubmit={handleAccess}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
                <Input
                  label="HID Code *"
                  placeholder="e.g. HID-ABCD-EFGH-1234"
                  value={hidCode}
                  onChange={event => setHidCode(normalizeHidInput(event.target.value))}
                  error={errors.hid}
                  style={{ fontFamily: 'monospace', letterSpacing: '1px' }}
                />
                <Input
                  label="Access PIN *"
                  type="password"
                  placeholder="Enter patient access PIN"
                  value={pin}
                  onChange={event => setPin(event.target.value)}
                  error={errors.pin}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
                <Input
                  label="Staff Name *"
                  placeholder="Dr. Aisha Johnson"
                  value={staffName}
                  onChange={event => setStaffName(event.target.value)}
                  error={errors.staff}
                  hint="Shown before accessing HID"
                />
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
                  <Button type="submit" loading={loading} size="lg" fullWidth>
                    Access HID
                  </Button>
                  <Button type="button" variant="danger" size="lg" onClick={() => navigate(HOSPITAL_EMERGENCY_PATH)}>
                    Emergency
                  </Button>
                </div>
              </div>
            </div>
          </form>
        </Card>

        {loading && !data && <PageLoader label="Accessing patient records..." />}

        {data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'fadeIn 0.3s ease' }}>
            <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>

            <Card>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, gap: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
                  <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#e8f1fc', color: '#1a6fd4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, flexShrink: 0 }}>
                    {(data.patient.full_name ?? '?').split(' ').filter(Boolean).map(name => name[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <h3 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px', overflowWrap: 'anywhere' }}>{data.patient.full_name}</h3>
                    <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#1a6fd4', marginTop: 2, overflowWrap: 'anywhere' }}>{data.patient.hid_code}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge color="blue">{data.patient.blood_group ?? 'Unknown'}</Badge>
                  <Button size="sm" variant="outline" onClick={() => navigate(getHospitalPatientRecordsPath(data.patient.hid_code))}>
                    Open full patient page
                  </Button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16, background: '#f9fafb', borderRadius: 10, padding: 16 }}>
                {[
                  { label: 'Date of Birth', value: data.patient.dob || '-' },
                  { label: 'Blood Group', value: data.patient.blood_group || '-' },
                  { label: 'Access PIN', value: data.patient.access_pin_configured ? 'Configured' : 'Not set' },
                  { label: 'Registered', value: formatDateTime(data.patient.created_at) },
                ].map(item => (
                  <div key={item.label}>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{item.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 700 }}>Medical Records</h3>
                  <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 2 }}>{data.records.length} record{data.records.length !== 1 ? 's' : ''} found</p>
                </div>
                <Button onClick={() => setShowAddRecord(true)} size="sm">Add Record</Button>
              </div>

              {data.records.length === 0 ? (
                <EmptyState
                  icon={<span style={{ fontSize: 28 }}>[]</span>}
                  title="No records yet"
                  description="No medical records have been added for this patient."
                  action={<Button onClick={() => setShowAddRecord(true)} size="sm">Add First Record</Button>}
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {data.records.map((record, index) => (
                    <div
                      key={record.id}
                      style={{
                        border: '1px solid #e5e7eb',
                        borderRadius: 10,
                        padding: 16,
                        borderLeft: `4px solid ${index === 0 ? '#1a6fd4' : '#e5e7eb'}`,
                      }}
                    >
                      <MedicalRecordMarkdownView record={record} attachments={data.recordFiles[record.id] ?? []} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      <Modal open={showAddRecord} onClose={() => { setShowAddRecord(false); setRecordForm(createEmptyRecordForm()) }} title="Add Medical Record">
        <form onSubmit={handleAddRecord} style={{ display: 'grid', gap: 14 }}>
          {data && (
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', fontSize: 13, overflowWrap: 'anywhere' }}>
              <span style={{ color: '#9ca3af' }}>Patient: </span>
              <strong>{data.patient.full_name}</strong>
              <span style={{ fontFamily: 'monospace', color: '#1a6fd4', marginLeft: 8, fontSize: 12 }}>{data.patient.hid_code}</span>
            </div>
          )}
          <Input label="Record title" value={recordForm.title} onChange={event => setRecordForm(current => ({ ...current, title: event.target.value }))} />
          <Textarea label="Doctor note" value={recordForm.roleNote} onChange={event => setRecordForm(current => ({ ...current, roleNote: event.target.value }))} />
          <Textarea label="Prescription" value={recordForm.prescription} onChange={event => setRecordForm(current => ({ ...current, prescription: event.target.value }))} />
          <Textarea label="Lab result" value={recordForm.labResult} onChange={event => setRecordForm(current => ({ ...current, labResult: event.target.value }))} />
          <Textarea label="Other" value={recordForm.other} onChange={event => setRecordForm(current => ({ ...current, other: event.target.value }))} />
          <Textarea label="Audio to text note" value={recordForm.transcriptionText} onChange={event => setRecordForm(current => ({ ...current, transcriptionText: event.target.value }))} />
          <VoiceToTextButton onTranscript={appendAudioTranscript} label="Start audio to text note" />

          <div style={{ display: 'grid', gap: 8 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>Choose file</label>
            <input type="file" multiple accept={RECORD_UPLOAD_ACCEPT} disabled={preparingUploads || addingRecord} onChange={event => void onAttachment(event.target.files)} />
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            {recordForm.uploads.map((file, index) => (
              <div key={`${file.file_name}-${index}`} style={{ display: 'grid', gap: 8 }}>
                <FileAttachmentPreview attachment={file} />
                <button type="button" onClick={() => removeUpload(index)} style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 600, justifySelf: 'flex-end' }}>
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 4 }}>
            <Button variant="secondary" onClick={() => { setShowAddRecord(false); setRecordForm(createEmptyRecordForm()) }} type="button">Cancel</Button>
            <Button type="submit" loading={addingRecord || preparingUploads} disabled={preparingUploads}>
              {preparingUploads ? 'Preparing files...' : 'Save medical record'}
            </Button>
          </div>
        </form>
      </Modal>
    </HospitalLayout>
  )
}
