import type { BadgeColor } from '../components/ui'
import { getRecordContributorLabel } from './medicalRecordUtils'
import type { MedicalRecord } from '../types/database'
import type { HidHealthEvent, HidHealthEventStatus } from '../types/hid'
import { formatDate } from './utils'

export interface HealthEventCategoryOption {
  value: string
  label: string
}

export const HEALTH_EVENT_CATEGORIES: HealthEventCategoryOption[] = [
  { value: 'general', label: 'General' },
  { value: 'illness', label: 'Illness' },
  { value: 'injury', label: 'Injury' },
  { value: 'surgery', label: 'Surgery / Procedure' },
  { value: 'pregnancy', label: 'Pregnancy' },
  { value: 'chronic_management', label: 'Chronic condition management' },
  { value: 'other', label: 'Other' },
]

export function getHealthEventCategoryLabel(category: string): string {
  return HEALTH_EVENT_CATEGORIES.find(option => option.value === category)?.label ?? 'General'
}

export interface HealthEventStatusOption {
  value: HidHealthEventStatus
  label: string
  color: BadgeColor
}

export const HEALTH_EVENT_STATUSES: HealthEventStatusOption[] = [
  { value: 'active', label: 'Active', color: 'green' },
  { value: 'monitoring', label: 'Monitoring', color: 'blue' },
  { value: 'resolved', label: 'Resolved', color: 'gray' },
  { value: 'archived', label: 'Archived', color: 'gray' },
]

export function getHealthEventStatusBadge(status: HidHealthEventStatus): { label: string; color: BadgeColor } {
  const option = HEALTH_EVENT_STATUSES.find(item => item.value === status)
  return option ? { label: option.label, color: option.color } : { label: 'Active', color: 'green' }
}

const STATUS_PRIORITY: Record<HidHealthEventStatus, number> = {
  active: 0,
  monitoring: 1,
  resolved: 2,
  archived: 3,
}

export function sortHealthEvents(events: HidHealthEvent[]): HidHealthEvent[] {
  return [...events].sort((a, b) => {
    const priorityDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
    if (priorityDiff !== 0) return priorityDiff
    return b.updated_at.localeCompare(a.updated_at)
  })
}

export function getRecordsForHealthEvent(event: HidHealthEvent, records: MedicalRecord[]): MedicalRecord[] {
  const recordIds = new Set(event.record_ids)
  return records
    .filter(record => recordIds.has(record.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function formatHealthEventDateRange(event: HidHealthEvent): string {
  const start = event.started_at ? formatDate(event.started_at) : formatDate(event.created_at)
  if (!event.ended_at) return event.status === 'resolved' || event.status === 'archived' ? start : `${start} - ongoing`
  return `${start} - ${formatDate(event.ended_at)}`
}

export function getHealthEventContributors(records: MedicalRecord[]): string[] {
  return Array.from(new Set(records.map(getRecordContributorLabel)))
}

export interface HealthEventSummary {
  recordCount: number
  contributorCount: number
  updatedLabel: string
  highlightContributor: MedicalRecord | null
}

export function getHealthEventSummary(event: HidHealthEvent, records: MedicalRecord[]): HealthEventSummary {
  const eventRecords = getRecordsForHealthEvent(event, records)
  return {
    recordCount: eventRecords.length,
    contributorCount: getHealthEventContributors(eventRecords).length,
    updatedLabel: formatDate(event.updated_at),
    highlightContributor: eventRecords.find(record => getRecordContributorLabel(record) !== 'You') ?? null,
  }
}
