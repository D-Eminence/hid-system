import React from 'react'
import { badgeMap } from './ui'
import { Badge } from './ui'
import { RecordSourceBadge } from './RecordMarkdownView'
import { getHealthInfoTypeIcon } from './HealthInfoTypeIcon'
import { formatHealthInfoType, getHealthInfoTypeConfig } from '../lib/medicalRecordUtils'
import type { MedicalRecord, MedicalRecordFile } from '../types/database'

interface RecordSummaryCardProps {
  record: MedicalRecord
  attachments: MedicalRecordFile[]
  onClick: () => void
}

export function RecordSummaryCard({ record, attachments, onClick }: RecordSummaryCardProps) {
  const attachmentCount = attachments.length > 0
    ? attachments.length
    : (record.attachment_data_url ? 1 : 0)

  const typeConfig = getHealthInfoTypeConfig(record.info_type)
  const accentColors = badgeMap[typeConfig?.accent ?? 'gray']
  const typeLabel = formatHealthInfoType(record.info_type, record.category)

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: '#fff',
        border: '1px solid #f2f2f2',
        borderRadius: 12,
        padding: 12,
        cursor: 'pointer',
        boxShadow: '0 1px 24px rgba(194, 201, 205, 0.08)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 8, background: accentColors.bg, color: accentColors.text, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {getHealthInfoTypeIcon(typeConfig?.id, 20)}
        </div>
        <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <div style={{ fontWeight: 700, fontSize: 'clamp(13px, 3.5vw, 14px)', color: '#111827' }}>{record.title}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            <Badge color={typeConfig?.accent ?? 'gray'}>{typeLabel}</Badge>
          </div>
        </div>
      </div>

      <RecordSourceBadge record={record} />

      {attachmentCount > 0 && (
        <span style={{ fontSize: 12, color: '#9ca3af' }}>
          {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}
        </span>
      )}
    </button>
  )
}
