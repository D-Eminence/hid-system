import React, { useState } from 'react'
import { AddHealthInformationSheet } from './AddHealthInformationSheet'
import {
  HealthInfoFlow,
  type HealthEventOrganizeChoice,
  type HealthInformationSubmission,
} from './HealthInfoFlow'
import type { HealthInfoTypeConfig, UploadDraft } from '../lib/medicalRecordUtils'
import type { HidHealthEvent } from '../types/hid'

export type { HealthEventOrganizeChoice, HealthInformationSubmission }

interface AddHealthInformationModalProps {
  open: boolean
  onClose: () => void
  saving: boolean
  preparingUploads: boolean
  uploads: UploadDraft[]
  healthEvents: HidHealthEvent[]
  onAttachment: (files: FileList | null) => void | Promise<void>
  onRemoveUpload: (index: number) => void
  onSubmit: (submission: HealthInformationSubmission) => void | Promise<void>
}

export function AddHealthInformationModal({
  open,
  onClose,
  saving,
  preparingUploads,
  uploads,
  healthEvents,
  onAttachment,
  onRemoveUpload,
  onSubmit,
}: AddHealthInformationModalProps) {
  const [selectedType, setSelectedType] = useState<HealthInfoTypeConfig | null>(null)

  function handleClose() {
    setSelectedType(null)
    onClose()
  }

  async function handleSubmit(submission: HealthInformationSubmission) {
    await onSubmit(submission)
    setSelectedType(null)
  }

  if (selectedType) {
    return (
      <HealthInfoFlow
        type={selectedType}
        open={open}
        onBack={() => setSelectedType(null)}
        onClose={handleClose}
        saving={saving}
        preparingUploads={preparingUploads}
        uploads={uploads}
        healthEvents={healthEvents}
        onAttachment={onAttachment}
        onRemoveUpload={onRemoveUpload}
        onSubmit={handleSubmit}
      />
    )
  }

  return (
    <AddHealthInformationSheet
      open={open}
      onClose={handleClose}
      onSelectType={setSelectedType}
    />
  )
}
