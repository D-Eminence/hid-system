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
import { HOSPITAL_AUTH_PATH } from '../../lib/hospitalRoutes'
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
import { breakGlassAccess, createMedicalRecordWithUploads, fetchPatientRecordsView, fetchStaffDashboard } from '../../lib/hidApi'
import { formatDateTime } from '../../lib/utils'
import type { MedicalRecord, MedicalRecordFile, Patient } from '../../types/database'

interface AccessedData {
  patient: Patient
}

interface SessionRecordEntry {
  record: MedicalRecord
  attachments: MedicalRecordFile[]
}

const ACCESS_GRANT_FALLBACK_POLL_MS = 60000

export default function DoctorEmergency() {
  const navigate = useNavigate()
  const { staff: session, hydrated } = usePortalSession()
  const [hidCode, setHidCode] = useState('HID-')
  const [staffName, setStaffName] = useState(session?.fullName ?? '')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<AccessedData | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showAddRecord, setShowAddRecord] = useState(false)
  const [savingRecord, setSavingRecord] = useState(false)
  const [preparingUploads, setPreparingUploads] = useState(false)
  const [sessionRecords, setSessionRecords] = useState<SessionRecordEntry[]>([])
  const [recordForm, setRecordForm] = useState(createEmptyRecordForm())
  const [activeGrantId, setActiveGrantId] = useState<string | null>(null)
  const saveLockRef = useRef(false)

  function handleRevokedAccess() {
    setActiveGrantId(null)
    setData(null)
    setReason('')
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
    if (!staffName.trim()) nextErrors.staff = 'Staff name is required'
    if (!reason.trim()) nextErrors.reason = 'Reason is required for emergency access'
    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  async function handleEmergencyAccess(event: React.FormEvent) {
    event.preventDefault()
    if (!session || !validate()) return

    const normalizedHidCode = normalizeHidInput(hidCode)
    setLoading(true)
    setData(null)
    setSessionRecords([])

    try {
      const response = await breakGlassAccess(normalizedHidCode, reason.trim(), 60, staffName)
      setActiveGrantId(response.grant_id)
      const cachedView = readDoctorPatientRecordsSnapshot(session.id, normalizedHidCode)
      if (cachedView) {
        setData({
          patient: cachedView.patient,
        })
      }
      const view = await fetchPatientRecordsView(normalizedHidCode, { forceRefresh: true })
      seedDoctorPatientRecordsCache(session.id, normalizedHidCode, view)
      setData({
        patient: view.patient,
      })
      showToast(`Emergency access granted. Patient: ${view.patient.full_name}`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to activate emergency access.'
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
          setReason('')
          showToast('Emergency access was closed or revoked. Start a new emergency access session to continue.', 'error')
        }
      } catch {
        // Best effort only. Emergency actions are still enforced by the backend.
      } finally {
        checking = false
      }
    }

    const unsubscribe = subscribeToAccessChanges(() => {
      if (document.visibilityState === 'visible') {
        void verifyGrant()
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
    if (!session || !data || savingRecord || saveLockRef.current) return
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
    setSavingRecord(true)
    const formSnapshot = recordForm
    const optimisticEntry = buildOptimisticMedicalRecord({
      category: inferRecordCategory(recordForm),
      createdBy: session.fullName,
      createdByRole: session.role,
      hidCode: data.patient.hid_code,
      notes: recordForm.roleNote.trim() || `Emergency session note: ${reason.trim()}`,
      record: buildStructuredRecordBody(recordForm),
      title: recordForm.title.trim(),
      transcriptionText: recordForm.transcriptionText.trim() || null,
      uploads: recordForm.uploads,
    })

    setSessionRecords(current => [
      {
        attachments: optimisticEntry.attachments,
        record: optimisticEntry.record,
      },
      ...current.filter(entry => entry.record.id !== optimisticEntry.record.id),
    ])
    setRecordForm(createEmptyRecordForm())
    setShowAddRecord(false)
    try {
      const created = await createMedicalRecordWithUploads({
        patientIdentifier: data.patient.hid_code,
        title: recordForm.title.trim(),
        category: inferRecordCategory(recordForm),
        record: buildStructuredRecordBody(recordForm),
        notes: recordForm.roleNote.trim() || `Emergency session note: ${reason.trim()}`,
        uploads: recordForm.uploads,
      })

      const view = await fetchPatientRecordsView(data.patient.hid_code, { forceRefresh: true })
      seedDoctorPatientRecordsCache(session.id, data.patient.hid_code, view)
      const createdRecord = view.records.find(record => record.id === created.record_id)
      if (!createdRecord) {
        throw new Error('The emergency note was saved, but it could not be loaded back into this session.')
      }

      setSessionRecords(current => {
        const next = [
          { record: createdRecord, attachments: view.recordFiles[created.record_id] ?? [] },
          ...current.filter(entry => entry.record.id !== created.record_id),
        ]
        return next
      })
      showToast('Emergency session record saved.', 'success')
    } catch (error) {
      setSessionRecords(current => current.filter(entry => entry.record.id !== optimisticEntry.record.id))
      setRecordForm(formSnapshot)
      setShowAddRecord(true)
      const message = error instanceof Error ? error.message : 'Unable to save the emergency session record.'
      showToast(message, 'error')
    } finally {
      setSavingRecord(false)
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
      activeSection="emergency"
      title="Emergency Access"
      subtitle="Use break-glass access only for urgent patient care."
      onLogout={() => { void logout() }}
      userName={session.fullName}
      organizationName={session.hospitalName ?? null}
      onAccessRevoked={handleRevokedAccess}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <Card>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Emergency Patient Access</h2>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
            Emergency access bypasses patient approval for urgent care. Every action here is logged and reviewed.
          </p>

          <form onSubmit={handleEmergencyAccess}>
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
                  label="Staff Name *"
                  placeholder="Dr. Aisha Johnson"
                  value={staffName}
                  onChange={event => setStaffName(event.target.value)}
                  error={errors.staff}
                />
              </div>

              <Textarea
                label="Reason for Emergency Access *"
                placeholder="Describe the emergency situation requiring immediate access..."
                value={reason}
                onChange={event => setReason(event.target.value)}
                error={errors.reason}
              />

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button type="submit" loading={loading} size="lg" variant="danger">
                  Emergency Access
                </Button>
              </div>
            </div>
          </form>
        </Card>

        {loading && !data && <PageLoader label="Activating emergency access..." />}

        {data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'fadeIn 0.3s ease' }}>
            <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>

            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>Emergency Access</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>High-priority access initiated due to a medical emergency.</div>
            </div>

            <div
              style={{
                borderRadius: 28,
                border: '1px solid #fee2e2',
                borderTop: '12px solid #ff2d35',
                borderBottom: '12px solid #ff2d35',
                background: '#fff',
                padding: '20px 20px 24px',
              }}
            >
              <div style={{ width: 34, height: 34, borderRadius: 10, background: '#dc2626', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path d="M3.2 3.4h8.1l3.5 3.5v7.7H3.2V3.4Z" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M5.6 8.9h6.8M9 5.5v6.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 18 }}>
                <EmergencyProfileSection
                  title="Patient Identity"
                  fields={[
                    { label: 'Full Name', value: data.patient.full_name || '-' },
                    { label: 'HID Number', value: data.patient.hid_code || '-' },
                    { label: 'Date of Birth', value: data.patient.dob || '-' },
                    { label: 'Phone Number', value: data.patient.phone || data.patient.email || '-' },
                  ]}
                />

                <EmergencyProfileSection
                  title="Patient Profile"
                  fields={[
                    { label: 'Blood Group', value: data.patient.blood_group || '-' },
                    { label: 'Genotype', value: data.patient.genotype || '-' },
                    { label: 'Allergies', value: data.patient.allergies || '-' },
                    { label: 'Current Medication', value: data.patient.current_medications || '-' },
                  ]}
                />

                <EmergencyProfileSection
                  title="Emergency Contact"
                  fields={[
                    { label: 'Name', value: data.patient.emergency_contact_name || '-' },
                    { label: 'Relationship', value: data.patient.emergency_contact_relationship || '-' },
                    { label: 'Phone Number', value: data.patient.emergency_contact_phone || '-' },
                    { label: 'Address', value: data.patient.emergency_contact_address || '-' },
                  ]}
                />
              </div>
            </div>

            <Card>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 700 }}>Emergency Session Records</h3>
                  <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 2 }}>Only records created in this emergency session appear here.</p>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge color="red">Emergency session active</Badge>
                  <Button size="sm" onClick={() => setShowAddRecord(true)}>Add Record</Button>
                </div>
              </div>

              {sessionRecords.length === 0 ? (
                <EmptyState
                  icon={<span style={{ fontSize: 28 }}>[]</span>}
                  title="No emergency records added yet"
                  description="Use this session to add only the records needed for the current emergency."
                  action={<Button size="sm" onClick={() => setShowAddRecord(true)}>Add emergency record</Button>}
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {sessionRecords.map((entry, index) => (
                    <div
                      key={entry.record.id}
                      style={{
                        border: '1px solid #e5e7eb',
                        borderRadius: 10,
                        padding: 16,
                        borderLeft: `4px solid ${index === 0 ? '#dc2626' : '#fca5a5'}`,
                      }}
                    >
                      <div style={{ marginBottom: 10, fontSize: 12, color: '#6b7280' }}>
                        Added during this emergency session at {formatDateTime(entry.record.created_at)}
                      </div>
                      <MedicalRecordMarkdownView record={entry.record} attachments={entry.attachments} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      <Modal open={showAddRecord} onClose={() => { setShowAddRecord(false); setRecordForm(createEmptyRecordForm()) }} title="Add Emergency Record">
        <form onSubmit={handleAddRecord} style={{ display: 'grid', gap: 14 }}>
          {data && (
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', fontSize: 13, overflowWrap: 'anywhere' }}>
              <span style={{ color: '#9ca3af' }}>Patient: </span>
              <strong>{data.patient.full_name}</strong>
              <span style={{ fontFamily: 'monospace', color: '#dc2626', marginLeft: 8, fontSize: 12 }}>{data.patient.hid_code}</span>
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
            <input type="file" multiple accept={RECORD_UPLOAD_ACCEPT} disabled={preparingUploads || savingRecord} onChange={event => void onAttachment(event.target.files)} />
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
            <Button type="submit" loading={savingRecord || preparingUploads} disabled={preparingUploads}>
              {preparingUploads ? 'Preparing files...' : 'Save medical record'}
            </Button>
          </div>
        </form>
      </Modal>
    </HospitalLayout>
  )
}

function EmergencyProfileSection({
  title,
  fields,
}: {
  title: string
  fields: Array<{ label: string; value: string }>
}) {
  return (
    <div style={{ border: '1px solid #edf1f5', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
      <div style={{ background: '#f5f5f5', padding: '12px 14px', fontSize: 16, fontWeight: 700, color: '#1f2937' }}>{title}</div>
      <div style={{ padding: '18px 14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
          {fields.map(field => (
            <div key={field.label} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{field.label}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{field.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
