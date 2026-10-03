export const platformControlKeys = [
  'maintenance_mode', 'patient_portal_enabled', 'provider_portal_enabled',
  'outreach_portal_enabled', 'break_glass_enabled', 'uploads_enabled',
] as const
export type PlatformControlKey = typeof platformControlKeys[number]
export interface PlatformControl {
  controlKey: PlatformControlKey
  enabled: boolean
  reason: string
  version: number
  updatedAt: string
}
type Transport = <T>(path: string, init?: RequestInit) => Promise<T>

function validateControls(rows: PlatformControl[]): PlatformControl[] {
  if (!Array.isArray(rows) || rows.length !== platformControlKeys.length
    || new Set(rows.map(row => row.controlKey)).size !== platformControlKeys.length
    || rows.some(row => !platformControlKeys.includes(row.controlKey)
      || typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.version) || row.version < 1
      || typeof row.reason !== 'string' || !Number.isFinite(Date.parse(row.updatedAt)))) {
    throw new Error('Platform controls are incomplete. Reload before making changes.')
  }
  return rows
}

export function createPlatformControlsApi(send: Transport) {
  const list = async () => validateControls(await send<PlatformControl[]>('/api/v1/admin/controls'))
  return {
    list,
    async save(current: PlatformControl[], changes: Partial<Record<PlatformControlKey, boolean>>, reason: string) {
      validateControls(current)
      const keys = Object.keys(changes) as PlatformControlKey[]
      if (keys.some(key => !platformControlKeys.includes(key) || typeof changes[key] !== 'boolean')) {
        throw new Error('This platform control is unavailable.')
      }
      const trimmedReason = reason.trim()
      if (trimmedReason.length < 8 || trimmedReason.length > 500) {
        throw new Error('Enter a change reason between 8 and 500 characters.')
      }
      let saved = 0
      try {
        for (const key of keys) {
          const previous = current.find(row => row.controlKey === key)!
          if (previous.enabled === changes[key]) continue
          const result = await send<{ controlKey: PlatformControlKey; enabled: boolean; version: number }>(
            '/api/v1/admin/controls', {
              method: 'POST', headers: { 'If-Match': `"${previous.version}"` },
              body: JSON.stringify({ controlKey: key, enabled: changes[key], reason: trimmedReason }),
            },
          )
          saved++
          if (result.controlKey !== key || result.enabled !== changes[key]
            || !Number.isSafeInteger(result.version) || result.version <= previous.version) {
            throw new Error('The saved control could not be verified.')
          }
        }
        return await list()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Platform controls could not be saved.'
        throw new Error(`${message} ${saved ? 'Some changes were saved. ' : ''}Reload controls before trying again.`)
      }
    },
  }
}
