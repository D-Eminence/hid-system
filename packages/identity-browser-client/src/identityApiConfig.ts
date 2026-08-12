const configuredApiUrl = (
  import.meta.env.VITE_HID_IDENTITY_API_URL ?? import.meta.env.VITE_HID_API_URL ?? ''
) as string

export const IDENTITY_API_BASE_URL = configuredApiUrl.trim().replace(/\/+$/, '')
export const IDENTITY_FUNCTIONS_PATH = (
  (import.meta.env.VITE_HID_FUNCTIONS_PATH as string | undefined)?.trim() || '/api/v1/functions'
).replace(/\/+$/, '')
export const NETWORK_TIMEOUT_MS = 15000
export const NETWORK_TIMEOUT_MESSAGE = 'The request took too long. Check your internet connection and try again.'
export const isConfigured = true

const AUTH_SESSION_HINT_KEY = 'hid_auth_session_hint'

export function identityApiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${IDENTITY_API_BASE_URL}${normalizedPath}`
}

export function identityFunctionUrl(name: string) {
  const normalizedName = name.replace(/^\/+/, '')
  return identityApiUrl(`${IDENTITY_FUNCTIONS_PATH}/${normalizedName}`)
}

export function markStoredIdentityAuthSession(active: boolean) {
  if (typeof window === 'undefined') return
  if (active) window.localStorage.setItem(AUTH_SESSION_HINT_KEY, '1')
  else window.localStorage.removeItem(AUTH_SESSION_HINT_KEY)
}

export function hasStoredIdentityAuthSession() {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(AUTH_SESSION_HINT_KEY) === '1'
}
