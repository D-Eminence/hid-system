import type { LegacyAccessRequestWithShare } from './hidApi'

export function timeAgo(input: string) {
  const diffMs = Date.now() - new Date(input).getTime()
  const diffMinutes = Math.max(1, Math.floor(diffMs / 60000))
  if (diffMinutes < 60) return `${diffMinutes} mins ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours} hrs ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays} days ago`
}

export function getRequestDuration(request: LegacyAccessRequestWithShare) {
  if (request.duration_hours && request.duration_hours > 0) {
    return `Up to ${request.duration_hours} hour${request.duration_hours === 1 ? '' : 's'}`
  }
  return 'Until you respond'
}

export function getAccessLabel(request: LegacyAccessRequestWithShare) {
  return request.request_type === 'emergency' ? 'Emergency Access' : 'Standard Access'
}

export type ActiveAccessGroup = {
  grants: LegacyAccessRequestWithShare[]
  id: string
  primary: LegacyAccessRequestWithShare
}

export function groupActiveAccess(grants: LegacyAccessRequestWithShare[]): ActiveAccessGroup[] {
  const groups = new Map<string, LegacyAccessRequestWithShare[]>()

  grants.forEach(grant => {
    const key = [
      grant.doctor_account_id,
      grant.request_type,
      grant.doctor_name.trim().toLowerCase(),
    ].join(':')
    groups.set(key, [...(groups.get(key) ?? []), grant])
  })

  return Array.from(groups.entries())
    .map(([key, entries]) => {
      const sorted = [...entries].sort((left, right) => {
        const leftTime = new Date(left.access_expires_at ?? left.approved_at ?? left.created_at).getTime()
        const rightTime = new Date(right.access_expires_at ?? right.approved_at ?? right.created_at).getTime()
        return rightTime - leftTime
      })

      const primary = sorted[0] as LegacyAccessRequestWithShare

      return {
        grants: sorted,
        id: key,
        primary,
      }
    })
    .sort((left, right) => new Date(right.primary.approved_at ?? right.primary.created_at).getTime() - new Date(left.primary.approved_at ?? left.primary.created_at).getTime())
}
