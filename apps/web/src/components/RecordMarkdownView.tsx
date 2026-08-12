import React from 'react'
import { Badge, badgeMap } from './ui'
import { formatHealthInfoType, getHealthInfoTypeConfig, getRecordSourceBadge, getRoleNoteLabel } from '../lib/medicalRecordUtils'
import { formatDate, formatDateTime } from '../lib/utils'
import type { MedicalRecord, MedicalRecordFile, PatientNote } from '../types/database'

function markdownShell(lines: string[]) {
  const renderedLines = lines.join('\n').split('\n')

  return (
    <div
      style={{
        margin: 0,
        background: '#0f172a',
        color: '#e2e8f0',
        padding: 16,
        borderRadius: 12,
        lineHeight: 1.7,
        fontSize: 13,
        display: 'grid',
        gap: 6,
      }}
    >
      {renderedLines.map((line, index) => {
        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
        if (headingMatch) {
          const level = headingMatch[1].length
          const fontSize = level === 1 ? 18 : level === 2 ? 15 : 14
          return (
            <div key={`line-${index}`} style={{ fontWeight: 700, fontSize, color: '#f8fafc', marginTop: level === 1 ? 4 : 8 }}>
              {headingMatch[2]}
            </div>
          )
        }

        if (!line.trim()) {
          return <div key={`line-${index}`} style={{ height: 4 }} />
        }

        if (line.startsWith('- ')) {
          return (
            <div key={`line-${index}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: '#dbe7f3' }}>
              <span style={{ color: '#93c5fd', lineHeight: 1.7 }}>•</span>
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line.slice(2)}</span>
            </div>
          )
        }

        if (line.startsWith('> ')) {
          return (
            <div
              key={`line-${index}`}
              style={{
                borderLeft: '3px solid #60a5fa',
                paddingLeft: 10,
                color: '#cbd5e1',
                fontStyle: 'italic',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {line.slice(2)}
            </div>
          )
        }

        return (
          <div key={`line-${index}`} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e2e8f0' }}>
            {line}
          </div>
        )
      })}
    </div>
  )
}

export function FileAttachmentPreview({ attachment }: { attachment: { file_name: string; file_type: string | null; file_data_url: string } }) {
  const safeType = attachment.file_type ?? ''
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, background: '#fff' }}>
      <a href={attachment.file_data_url} download={attachment.file_name} target="_blank" rel="noreferrer" style={{ color: '#1a6fd4', fontWeight: 600 }}>
        {attachment.file_name}
      </a>
      {safeType.startsWith('image/') && (
        <img
          src={attachment.file_data_url}
          alt={attachment.file_name}
          style={{ width: '100%', maxHeight: 360, objectFit: 'contain', borderRadius: 12, border: '1px solid #e5e7eb', background: '#f8fafc' }}
        />
      )}
      {safeType === 'application/pdf' && (
        <iframe
          src={attachment.file_data_url}
          title={attachment.file_name}
          style={{ width: '100%', minHeight: 360, border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff' }}
        />
      )}
      {safeType.startsWith('audio/') && (
        <audio controls style={{ width: '100%' }}>
          <source src={attachment.file_data_url} type={safeType} />
        </audio>
      )}
    </div>
  )
}

export function RecordSourceBadge({ record }: { record: MedicalRecord }) {
  const source = getRecordSourceBadge(record)
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, color: '#6b7280' }}>
      <Badge color={source.color}>{source.label}</Badge>
      <span>{record.created_by}</span>
      {record.created_by_org && <span>· {record.created_by_org}</span>}
      <span>· {formatDateTime(record.created_at)}</span>
    </div>
  )
}

function RecordDisclosure({
  title,
  subtitle,
  children,
  defaultOpen = true,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details
      className="record-disclosure"
      open={defaultOpen}
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      <style>{`
        .record-disclosure > summary {
          list-style: none;
        }
        .record-disclosure > summary::-webkit-details-marker {
          display: none;
        }
      `}</style>
      <summary
        style={{
          listStyle: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 14px',
          userSelect: 'none',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111827' }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 2 }}>{subtitle}</div>}
        </div>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ color: '#9ca3af', flexShrink: 0 }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div style={{ padding: '0 14px 14px' }}>{children}</div>
    </details>
  )
}

function formatStructuredFieldValue(value: unknown, kind: string | undefined, options?: { value: string; label: string }[]) {
  const raw = String(value)
  if (kind === 'date') return formatDate(raw)
  if (kind === 'select') return options?.find(option => option.value === raw)?.label ?? raw
  return raw
}

export function MedicalRecordMarkdownView({ record, attachments = [] }: { record: MedicalRecord; attachments?: MedicalRecordFile[] }) {
  const allAttachments = attachments.length > 0
    ? attachments
    : (record.attachment_data_url ? [{
        id: `legacy-${record.id}`,
        record_id: record.id,
        file_name: record.attachment_name ?? 'uploaded-file',
        file_type: record.attachment_type,
        file_data_url: record.attachment_data_url,
        created_at: record.created_at,
      }] : [])

  const structuredData = record.structured_data
  const typeConfig = getHealthInfoTypeConfig(record.info_type)
  const structuredEntries = structuredData ? Object.entries(structuredData) : []
  const categoryLabel = formatHealthInfoType(record.info_type, record.category)
  const accent = badgeMap[typeConfig?.accent ?? 'gray']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <RecordSourceBadge record={record} />
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 16, background: '#fff', padding: 16, boxShadow: '0 10px 24px rgba(15, 23, 42, 0.04)', display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: accent.text }}>
              Medical record
            </div>
            <div style={{ fontSize: 'clamp(18px, 4.5vw, 22px)', fontWeight: 800, color: '#111827', marginTop: 4, overflowWrap: 'anywhere' }}>
              {record.title}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6, overflowWrap: 'anywhere' }}>
              {categoryLabel}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
            <Badge color={typeConfig?.accent ?? 'gray'}>{categoryLabel}</Badge>
            <Badge color="gray">{allAttachments.length} file{allAttachments.length === 1 ? '' : 's'}</Badge>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: '10px 12px', background: '#f8fafc' }}>
            <div style={{ fontSize: 10.5, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Saved by</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginTop: 4, overflowWrap: 'anywhere' }}>{record.created_by}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: '10px 12px', background: '#f8fafc' }}>
            <div style={{ fontSize: 10.5, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Saved at</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginTop: 4, overflowWrap: 'anywhere' }}>{formatDateTime(record.created_at)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: '10px 12px', background: '#f8fafc' }}>
            <div style={{ fontSize: 10.5, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Category</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginTop: 4, overflowWrap: 'anywhere' }}>{categoryLabel}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: '10px 12px', background: '#f8fafc' }}>
            <div style={{ fontSize: 10.5, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Attachments</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginTop: 4 }}>{allAttachments.length}</div>
          </div>
        </div>
      </div>

      {structuredEntries.length > 0 && (
        <RecordDisclosure
          title="Structured details"
          subtitle={`${structuredEntries.length} field${structuredEntries.length === 1 ? '' : 's'} categorized from the record`}
        >
          <div style={{ display: 'grid', gap: 10 }}>
            {structuredEntries.map(([key, value]) => {
              const field = typeConfig?.fields.find(item => item.key === key)
              const label = field?.label ?? key
              return (
                <div key={key} style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: '10px 12px', background: '#f8fafc' }}>
                  <div style={{ fontSize: 10.5, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111827', marginTop: 4, overflowWrap: 'anywhere' }}>
                    {formatStructuredFieldValue(value, field?.kind, field?.options)}
                  </div>
                </div>
              )
            })}
          </div>
        </RecordDisclosure>
      )}

      {record.record && (
        <RecordDisclosure
          title="Record details"
          subtitle="Saved medical note content"
        >
          {markdownShell(record.record.split('\n'))}
        </RecordDisclosure>
      )}

      {record.notes && (
        <RecordDisclosure
          title={getRoleNoteLabel(record.added_by_role)}
          subtitle="Additional context from the contributor"
        >
          {markdownShell(record.notes.split('\n'))}
        </RecordDisclosure>
      )}

      {record.transcription_text && (
        <RecordDisclosure
          title="Audio to text note"
          subtitle="Voice transcript captured during entry"
        >
          {markdownShell(record.transcription_text.split('\n'))}
        </RecordDisclosure>
      )}

      {allAttachments.length > 0 && (
        <RecordDisclosure
          title="Attachments"
          subtitle={`${allAttachments.length} linked file${allAttachments.length === 1 ? '' : 's'}`}
          defaultOpen={allAttachments.length <= 2}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {allAttachments.map(attachment => <FileAttachmentPreview key={attachment.id} attachment={attachment} />)}
          </div>
        </RecordDisclosure>
      )}

      <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>
        Saved medical records are read-only.
      </div>
    </div>
  )
}

export function PatientNoteMarkdownView({ note }: { note: PatientNote }) {
  return markdownShell([
    `# Patient note`,
    '',
    `- Created by: ${note.created_by}`,
    `- Saved at: ${formatDateTime(note.created_at)}`,
    '',
    `## Note`,
    note.note,
  ])
}
