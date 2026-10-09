import React, { useMemo, useState } from 'react'
import { BottomSheet, Button, ChipGroup, Input, Select, SelectionCardGrid, Textarea, showToast } from './ui'
import { FileAttachmentPreview } from './RecordMarkdownView'
import { VoiceToTextButton } from './VoiceToTextButton'
import {
  RECORD_UPLOAD_ACCEPT,
  buildHealthInfoTitle,
  createEmptyHealthInfoValues,
  type HealthInfoField,
  type HealthInfoStep,
  type HealthInfoTypeConfig,
  type HealthInfoValues,
  type UploadDraft,
} from '../lib/medicalRecordUtils'
import { HEALTH_EVENT_CATEGORIES, getHealthEventStatusBadge } from '../lib/healthEventUtils'
import type { HidHealthEvent } from '../types/hid'

export type HealthEventOrganizeChoice =
  | { mode: 'none' }
  | { mode: 'new'; title: string; infoCategory: string }
  | { mode: 'existing'; eventId: string }

export interface HealthInformationSubmission {
  infoType: string
  title: string
  structuredData: Record<string, unknown>
  notes: string
  transcriptionText: string
  uploads: UploadDraft[]
  healthEvent: HealthEventOrganizeChoice
}

type FlowStep =
  | { kind: 'upload' }
  | { kind: 'fields'; step: HealthInfoStep }
  | { kind: 'details' }

function buildSteps(type: HealthInfoTypeConfig): FlowStep[] {
  const steps: FlowStep[] = []
  if (type.uploadFirst) steps.push({ kind: 'upload' })
  type.steps.forEach(step => steps.push({ kind: 'fields', step }))
  steps.push({ kind: 'details' })
  return steps
}

function renderFieldControl(field: HealthInfoField, values: HealthInfoValues, onChange: (key: string, value: string) => void) {
  const label = field.required ? `${field.label} *` : field.label

  if (field.kind === 'chips') {
    return (
      <div key={field.key} style={{ display: 'grid', gap: 8 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>{label}</label>
        <ChipGroup options={field.options ?? []} value={values[field.key] ?? ''} onChange={value => onChange(field.key, value)} />
      </div>
    )
  }

  if (field.kind === 'cards') {
    return (
      <div key={field.key} style={{ display: 'grid', gap: 8 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>{label}</label>
        <SelectionCardGrid options={field.options ?? []} value={values[field.key] ?? ''} onChange={value => onChange(field.key, value)} />
      </div>
    )
  }

  if (field.kind === 'select') {
    return (
      <Select
        key={field.key}
        label={label}
        value={values[field.key] ?? ''}
        onChange={event => onChange(field.key, event.target.value)}
        options={field.options ?? []}
      />
    )
  }

  if (field.kind === 'textarea') {
    return (
      <Textarea
        key={field.key}
        label={label}
        value={values[field.key] ?? ''}
        onChange={event => onChange(field.key, event.target.value)}
      />
    )
  }

  return (
    <Input
      key={field.key}
      type={field.kind === 'date' ? 'date' : 'text'}
      label={label}
      value={values[field.key] ?? ''}
      onChange={event => onChange(field.key, event.target.value)}
    />
  )
}

interface HealthInfoFlowProps {
  type: HealthInfoTypeConfig
  open: boolean
  onBack: () => void
  onClose: () => void
  saving: boolean
  preparingUploads: boolean
  uploads: UploadDraft[]
  healthEvents: HidHealthEvent[]
  onAttachment: (files: FileList | null) => void | Promise<void>
  onRemoveUpload: (index: number) => void
  onSubmit: (submission: HealthInformationSubmission) => void | Promise<void>
}

export function HealthInfoFlow({
  type,
  open,
  onBack,
  onClose,
  saving,
  preparingUploads,
  uploads,
  healthEvents,
  onAttachment,
  onRemoveUpload,
  onSubmit,
}: HealthInfoFlowProps) {
  const [values, setValues] = useState<HealthInfoValues>(() => createEmptyHealthInfoValues(type.id))
  const [notes, setNotes] = useState('')
  const [transcriptionText, setTranscriptionText] = useState('')
  const [organizeMode, setOrganizeMode] = useState<HealthEventOrganizeChoice['mode']>('none')
  const [newEventTitle, setNewEventTitle] = useState('')
  const [newEventCategory, setNewEventCategory] = useState('general')
  const [existingEventId, setExistingEventId] = useState('')
  const [stepIndex, setStepIndex] = useState(0)

  const steps = useMemo(() => buildSteps(type), [type])
  const currentStep = steps[stepIndex]
  const isFirstStep = stepIndex === 0
  const isLastStep = stepIndex === steps.length - 1

  function setFieldValue(key: string, value: string) {
    setValues(current => ({ ...current, [key]: value }))
  }

  function appendTranscript(transcript: string) {
    setTranscriptionText(current => `${current}${current.trim() ? '\n' : ''}${transcript}`.trim())
  }

  function goBack() {
    if (isFirstStep) {
      onBack()
    } else {
      setStepIndex(index => index - 1)
    }
  }

  function goNext() {
    if (currentStep.kind === 'upload' && type.requiresAttachment && uploads.length === 0) {
      showToast('Attach a file before continuing.', 'error')
      return
    }

    if (currentStep.kind === 'fields') {
      for (const fieldKey of currentStep.step.fieldKeys) {
        const field = type.fields.find(item => item.key === fieldKey)
        if (field?.required && !(values[fieldKey] ?? '').trim()) {
          showToast(`Enter ${field.label.toLowerCase()} before continuing.`, 'error')
          return
        }
      }
    }

    setStepIndex(index => index + 1)
  }

  async function handleSubmit() {
    if (saving || preparingUploads) return

    if (type.requiresAttachment && uploads.length === 0) {
      showToast('Attach a file before saving.', 'error')
      return
    }

    let healthEvent: HealthEventOrganizeChoice = { mode: 'none' }
    if (organizeMode === 'new') {
      const trimmedEventTitle = newEventTitle.trim()
      if (!trimmedEventTitle) {
        showToast('Enter a name for the new health event.', 'error')
        return
      }
      healthEvent = { mode: 'new', title: trimmedEventTitle, infoCategory: newEventCategory }
    } else if (organizeMode === 'existing') {
      if (!existingEventId) {
        showToast('Choose a health event to add this to.', 'error')
        return
      }
      healthEvent = { mode: 'existing', eventId: existingEventId }
    }

    const structuredData: Record<string, unknown> = {}
    type.fields.forEach(field => {
      const value = (values[field.key] ?? '').trim()
      if (value) structuredData[field.key] = value
    })

    const title = buildHealthInfoTitle(type.id, values, uploads[0]?.file_name)

    await onSubmit({
      infoType: type.id,
      title,
      structuredData,
      notes,
      transcriptionText,
      uploads,
      healthEvent,
    })
  }

  function renderUploadStep() {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <h2 style={{ fontSize: 'clamp(17px, 4.5vw, 20px)', fontWeight: 700 }}>
          {type.id === 'document' ? 'Upload your report' : 'Upload your lab report'}
        </h2>
        <p style={{ color: '#6b7280', fontSize: 13, marginTop: -8 }}>
          {type.requiresAttachment ? 'Attach a file to continue.' : 'Attach a file, or skip and add details manually.'}
        </p>
        <label
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
            border: '2px dashed #c7d2e0', borderRadius: 16, padding: '40px 20px',
            cursor: preparingUploads || saving ? 'not-allowed' : 'pointer',
            color: '#1a6fd4', background: '#f8fbff', textAlign: 'center',
          }}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 16V4M7 9l5-5 5 5M4 20h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Upload Report</span>
          <span style={{ fontSize: 12, color: '#6b7280' }}>JPG, PNG, or PDF</span>
          <input
            type="file"
            multiple
            accept={RECORD_UPLOAD_ACCEPT}
            disabled={preparingUploads || saving}
            style={{ display: 'none' }}
            onChange={event => void onAttachment(event.target.files)}
          />
        </label>

        {uploads.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            {uploads.map((file, index) => (
              <div key={`${file.file_name}-${index}`} style={{ display: 'grid', gap: 8 }}>
                <FileAttachmentPreview attachment={file} />
                <button type="button" onClick={() => onRemoveUpload(index)} style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 600, justifySelf: 'flex-end' }}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  function renderFieldsStep(step: HealthInfoStep) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <h2 style={{ fontSize: 'clamp(17px, 4.5vw, 20px)', fontWeight: 700 }}>{step.question}</h2>
        <div style={{ display: 'grid', gap: 14 }}>
          {step.fieldKeys.map(key => {
            const field = type.fields.find(item => item.key === key)
            return field ? renderFieldControl(field, values, setFieldValue) : null
          })}
        </div>
      </div>
    )
  }

  function renderDetailsStep() {
    const showAttachments = (type.supportsAttachments || type.requiresAttachment) && !type.uploadFirst

    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <h2 style={{ fontSize: 'clamp(17px, 4.5vw, 20px)', fontWeight: 700 }}>
          {type.isVoiceEntry ? 'Record your note' : 'Anything else to add?'}
        </h2>

        {type.isVoiceEntry && (
          <div style={{ display: 'grid', gap: 10 }}>
            <VoiceToTextButton onTranscript={appendTranscript} label="Start voice entry" />
            <Textarea
              label="Transcript"
              placeholder="Your voice note will appear here. You can edit it."
              value={transcriptionText}
              onChange={event => setTranscriptionText(event.target.value)}
            />
          </div>
        )}

        <Textarea label="Notes" value={notes} onChange={event => setNotes(event.target.value)} />

        {!type.isVoiceEntry && (
          <div style={{ display: 'grid', gap: 8 }}>
            <VoiceToTextButton onTranscript={appendTranscript} label="Add note by voice" />
            {transcriptionText && (
              <Textarea label="Voice note transcript" value={transcriptionText} onChange={event => setTranscriptionText(event.target.value)} />
            )}
          </div>
        )}

        {showAttachments && (
          <div style={{ display: 'grid', gap: 8 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>
              {type.requiresAttachment ? 'Attach file *' : 'Attach file (optional)'}
            </label>
            <input type="file" multiple accept={RECORD_UPLOAD_ACCEPT} disabled={preparingUploads || saving} onChange={event => void onAttachment(event.target.files)} />
            {uploads.length > 0 && (
              <div style={{ display: 'grid', gap: 8 }}>
                {uploads.map((file, index) => (
                  <div key={`${file.file_name}-${index}`} style={{ display: 'grid', gap: 8 }}>
                    <FileAttachmentPreview attachment={file} />
                    <button type="button" onClick={() => onRemoveUpload(index)} style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 600, justifySelf: 'flex-end' }}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>Add to a health event (optional)</label>
          <ChipGroup
            options={[
              { value: 'none', label: "Don't add to a health event" },
              { value: 'new', label: 'Create a new health event' },
              ...(healthEvents.length > 0 ? [{ value: 'existing', label: 'Add to an existing health event' }] : []),
            ]}
            value={organizeMode}
            onChange={value => setOrganizeMode(value as HealthEventOrganizeChoice['mode'])}
          />

          {organizeMode === 'new' && (
            <div style={{ display: 'grid', gap: 10 }}>
              <Input
                placeholder="e.g. Typhoid Treatment"
                value={newEventTitle}
                onChange={event => setNewEventTitle(event.target.value)}
              />
              <Select
                value={newEventCategory}
                onChange={event => setNewEventCategory(event.target.value)}
                options={HEALTH_EVENT_CATEGORIES}
              />
            </div>
          )}

          {organizeMode === 'existing' && (
            <Select
              value={existingEventId}
              onChange={event => setExistingEventId(event.target.value)}
              options={healthEvents
                .filter(event => event.status !== 'archived')
                .map(event => ({ value: event.id, label: `${event.title} (${getHealthEventStatusBadge(event.status).label})` }))}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <BottomSheet
      open={open}
      title={type.label}
      onBack={goBack}
      onClose={onClose}
      step={stepIndex}
      totalSteps={steps.length}
      footer={
        <>
          {isFirstStep ? (
            <Button variant="secondary" onClick={onBack}>Choose a different type</Button>
          ) : (
            <Button variant="secondary" onClick={goBack}>Back</Button>
          )}
          {!isLastStep ? (
            <Button onClick={goNext}>Next</Button>
          ) : (
            <Button loading={saving || preparingUploads} disabled={preparingUploads} onClick={() => void handleSubmit()}>
              {preparingUploads ? 'Preparing files...' : 'Save'}
            </Button>
          )}
        </>
      }
    >
      {currentStep.kind === 'upload' && renderUploadStep()}
      {currentStep.kind === 'fields' && renderFieldsStep(currentStep.step)}
      {currentStep.kind === 'details' && renderDetailsStep()}
    </BottomSheet>
  )
}
