import React, { useMemo, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Select, SectionHeader, showToast } from './ui'
import {
  HEALTH_EVENT_STATUSES,
  getHealthEventCategoryLabel,
  getHealthEventStatusBadge,
  getHealthEventSummary,
  getRecordsForHealthEvent,
  formatHealthEventDateRange,
} from '../lib/healthEventUtils'
import { formatDateTime } from '../lib/utils'
import { formatHealthInfoType, getRecordSourceBadge } from '../lib/medicalRecordUtils'
import { RecordSourceBadge } from './RecordMarkdownView'
import type { MedicalRecord } from '../types/database'
import type { HidHealthEvent, HidHealthEventStatus } from '../types/hid'

interface HealthEventTimelineProps {
  events: HidHealthEvent[]
  records: MedicalRecord[]
  onSelectRecord: (recordId: string) => void
  onAddRecord: (eventId: string, recordId: string) => Promise<void>
  onRemoveRecord: (eventId: string, recordId: string) => Promise<void>
  onRename: (eventId: string, title: string) => Promise<void>
  onSetStatus: (eventId: string, status: HidHealthEventStatus) => Promise<void>
}

export function HealthEventTimeline({
  events,
  records,
  onSelectRecord,
  onAddRecord,
  onRemoveRecord,
  onRename,
  onSetStatus,
}: HealthEventTimelineProps) {
  const [addRecordEventId, setAddRecordEventId] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  async function runAction(key: string, action: () => Promise<void>) {
    if (busyKey) return
    setBusyKey(key)
    try {
      await action()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong. Please try again.'
      showToast(message, 'error')
    } finally {
      setBusyKey(null)
    }
  }

  const addRecordEvent = events.find(event => event.id === addRecordEventId) ?? null
  const availableForAdd = useMemo(() => {
    if (!addRecordEvent) return []
    const used = new Set(addRecordEvent.record_ids)
    return records.filter(record => !used.has(record.id))
  }, [addRecordEvent, records])

  if (events.length === 0) return null

  return (
    <Card style={{ borderRadius: 16, marginBottom: 18 }}>
      <SectionHeader
        title="Health events"
        subtitle="Related records grouped into a healthcare journey, like a hospital visit or an ongoing condition."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {events.map(event => (
          <HealthEventFolderCard
            key={event.id}
            event={event}
            records={records}
            busy={busyKey?.startsWith(event.id) ?? false}
            onSelectRecord={onSelectRecord}
            onAddRecord={() => setAddRecordEventId(event.id)}
            onRemoveRecord={recordId => void runAction(`${event.id}:remove:${recordId}`, () => onRemoveRecord(event.id, recordId))}
            onRename={title => runAction(`${event.id}:rename`, () => onRename(event.id, title))}
            onSetStatus={status => runAction(`${event.id}:status`, () => onSetStatus(event.id, status))}
          />
        ))}
      </div>

      <Modal open={Boolean(addRecordEvent)} onClose={() => setAddRecordEventId(null)} title="Add a record to this event" width={520}>
        {availableForAdd.length === 0 ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>All of your records are already part of this health event.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {availableForAdd.map(record => (
              <button
                key={record.id}
                type="button"
                disabled={Boolean(busyKey)}
                onClick={() => {
                  if (!addRecordEvent) return
                  void runAction(`${addRecordEvent.id}:add:${record.id}`, () => onAddRecord(addRecordEvent.id, record.id))
                }}
                style={{
                  textAlign: 'left',
                  borderRadius: 8,
                  border: '1px solid #edf1f5',
                  background: '#fff',
                  padding: '10px 14px',
                  cursor: busyKey ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{record.title}</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{formatHealthInfoType(record.info_type, record.category)} · {formatDateTime(record.created_at)}</span>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </Card>
  )
}

function HealthEventFolderCard({
  event,
  records,
  busy,
  onSelectRecord,
  onAddRecord,
  onRemoveRecord,
  onRename,
  onSetStatus,
}: {
  event: HidHealthEvent
  records: MedicalRecord[]
  busy: boolean
  onSelectRecord: (recordId: string) => void
  onAddRecord: () => void
  onRemoveRecord: (recordId: string) => void
  onRename: (title: string) => Promise<void>
  onSetStatus: (status: HidHealthEventStatus) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(event.title)
  const statusBadge = getHealthEventStatusBadge(event.status)
  const summary = useMemo(() => getHealthEventSummary(event, records), [event, records])
  const timelineRecords = useMemo(() => [...getRecordsForHealthEvent(event, records)].reverse(), [event, records])
  const highlight = summary.highlightContributor ? getRecordSourceBadge(summary.highlightContributor) : null

  async function saveRename() {
    const trimmed = title.trim()
    if (!trimmed || trimmed === event.title) {
      setTitle(event.title)
      setRenaming(false)
      return
    }
    await onRename(trimmed)
    setRenaming(false)
  }

  return (
    <div style={{ border: '1px solid #edf1f5', borderRadius: 12, padding: 16, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 'min(200px, 100%)' }}>
          {renaming ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Input value={title} onChange={e => setTitle(e.target.value)} style={{ height: 36 }} />
              <Button size="sm" disabled={busy} onClick={() => void saveRename()}>Save</Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setTitle(event.title); setRenaming(false) }}>Cancel</Button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 16, color: '#111827', overflowWrap: 'anywhere' }}>{event.title}</span>
              <Badge color={statusBadge.color}>{statusBadge.label}</Badge>
              <Badge color="gray">{getHealthEventCategoryLabel(event.info_category)}</Badge>
              <button type="button" onClick={() => setRenaming(true)} style={{ border: 'none', background: 'none', color: '#1a6fd4', fontWeight: 600, cursor: 'pointer', fontSize: 12, padding: 0 }}>
                Rename
              </button>
            </div>
          )}

          <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
            {summary.recordCount} Record{summary.recordCount === 1 ? '' : 's'} · {summary.contributorCount} Contributor{summary.contributorCount === 1 ? '' : 's'} · Updated {summary.updatedLabel}
          </div>

          {highlight && summary.highlightContributor && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, color: '#6b7280' }}>
              <span>{summary.highlightContributor.created_by}</span>
              <Badge color={highlight.color}>{highlight.label}</Badge>
              {summary.highlightContributor.created_by_org && <span>{summary.highlightContributor.created_by_org}</span>}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setExpanded(current => !current)}
          style={{ border: 'none', background: 'none', color: '#1891ff', fontWeight: 600, cursor: 'pointer', fontSize: 13, padding: 0, whiteSpace: 'nowrap' }}
        >
          {expanded ? 'Hide event' : 'View event'} →
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f3f4f6' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{formatHealthEventDateRange(event)}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Select
                value={event.status}
                disabled={busy}
                onChange={e => onSetStatus(e.target.value as HidHealthEventStatus)}
                options={HEALTH_EVENT_STATUSES.map(option => ({ value: option.value, label: option.label }))}
                style={{ height: 34, fontSize: 12 }}
              />
              <Button size="sm" variant="secondary" disabled={busy} onClick={onAddRecord}>+ Add record</Button>
            </div>
          </div>

          {timelineRecords.length === 0 ? (
            <p style={{ fontSize: 13, color: '#9ca3af' }}>No records added to this event yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {timelineRecords.map((record, index) => (
                <div key={record.id} style={{ display: 'flex', gap: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 8, flexShrink: 0 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#1891ff', marginTop: 6, flexShrink: 0 }} />
                    {index < timelineRecords.length - 1 && <div style={{ flex: 1, width: 2, background: '#edf1f5', marginTop: 2 }} />}
                  </div>

                  <div style={{ flex: 1, paddingBottom: index < timelineRecords.length - 1 ? 16 : 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => onSelectRecord(record.id)}
                        style={{ textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}
                      >
                        <span style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{record.title}</span>
                        <RecordSourceBadge record={record} />
                        <span style={{ fontSize: 12, color: '#9ca3af' }}>{formatHealthInfoType(record.info_type, record.category)}</span>
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRemoveRecord(record.id)}
                        style={{ border: 'none', background: 'none', color: '#dc2626', cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 12, flexShrink: 0 }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
