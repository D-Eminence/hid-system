import {
  identityApiUrl,
  identityFunctionUrl,
  isConfigured,
  markStoredIdentityAuthSession,
  NETWORK_TIMEOUT_MESSAGE,
  NETWORK_TIMEOUT_MS,
} from './identityApiConfig'
import {
  fetchWithTimeout as sharedFetchWithTimeout,
  HidRequestTimeoutError,
} from '@hid/api-client'

export type IdentityAuthEvent =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED'

export interface IdentityUser {
  id: string
  email?: string
  user_metadata: {
    full_name?: string
    name?: string
    requested_role?: string
    [key: string]: unknown
  }
  app_metadata: Record<string, unknown>
  identities?: Array<{ provider: string }>
}

export interface IdentitySession {
  access_token: string
  refresh_token: string
  expires_in?: number
  token_type?: string
  user: IdentityUser
}

export interface IdentityFacilityAssignment {
  id: string
  membershipId: string
  organizationId: string
  name: string
  code?: string
  roles: string[]
  permissions: string[]
  isPrimary: boolean
}

export interface IdentityActorContext {
  subject: string
  accountId: string
  displayName?: string
  facilities: IdentityFacilityAssignment[]
}

export interface IdentityClientError extends Error {
  context?: Response
  status?: number
  code?: string | null
}

type RecoveryOtpPurpose = 'PASSWORD_RESET' | 'LEGACY_ACCOUNT_RECOVERY' | 'LEGACY_SESSION_FALLBACK'
type RecoveryTurnstileAction = 'patient-reset-start' | 'staff-reset' | 'admin-reset' | 'legacy-recovery'

interface RecoveryOtpStart {
  accepted: true
  challengeId: string
  deliveryChannels: ['email']
  expiresInSeconds: number
  resendAfterSeconds: number
}

interface RecoveryOtpVerification {
  verified: true
  challengeId: string
  verificationToken: string
}

export interface IdentityFunctionInvokeOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  headers?: HeadersInit
}

interface IdentityFactor {
  id: string
  factor_type: string
  status: string
  friendly_name?: string | null
}

type AuthListener = (event: IdentityAuthEvent, session: IdentitySession | null) => void
type JsonRecord = Record<string, unknown>

let currentSession: IdentitySession | null = null
let csrfToken: string | null = null
const authListeners = new Set<AuthListener>()

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && 'data' in value ? value.data : value
}

function requestError(response: Response, payload: unknown): IdentityClientError {
  const record = isRecord(payload) ? payload : null
  const message = readString(record?.detail)
    ?? readString(record?.message)
    ?? `Identity API request failed with status ${response.status}`
  const error = new Error(message) as IdentityClientError
  error.context = response
  error.status = response.status
  error.code = readString(record?.code)
  return error
}

function readCsrfToken(response: Response): void {
  const nextToken = response.headers.get('x-csrf-token')
  if (nextToken) csrfToken = nextToken
}

function actorSession(payload: unknown): IdentitySession | null {
  const unwrapped = unwrapData(payload)
  if (!isRecord(unwrapped)) return null
  const actor = isRecord(unwrapped.actor) ? unwrapped.actor : null
  if (!actor) return null
  const id = readString(actor.accountId) ?? readString(actor.id) ?? readString(actor.subject)
  if (!id) return null
  const email = readString(actor.email) ?? undefined
  const roles = Array.isArray(actor.roles)
    ? actor.roles.filter((role): role is string => typeof role === 'string')
    : []
  const role = readString(actor.role) ?? roles[0] ?? null
  const user: IdentityUser = {
    id,
    ...(email ? { email } : {}),
    user_metadata: {
      display_name: readString(actor.displayName),
      requested_role: role,
      roles,
    },
    app_metadata: {
      provider: readString(actor.authenticationMethod) ?? 'local',
      role,
      roles,
      permissions: Array.isArray(actor.permissions) ? actor.permissions : [],
    },
    identities: [{ provider: readString(actor.authenticationMethod) === 'oidc' ? 'google' : 'email' }],
  }
  return {
    access_token: 'http-only-cookie',
    refresh_token: 'http-only-cookie',
    token_type: 'cookie',
    user,
  }
}

function sessionFromPayload(payload: unknown): IdentitySession | null {
  const unwrapped = unwrapData(payload)
  if (isRecord(unwrapped) && isRecord(unwrapped.session)) {
    const candidate = unwrapped.session
    const userCandidate = isRecord(candidate.user) ? candidate.user : null
    const userId = readString(userCandidate?.id)
    if (userId) {
      return {
        access_token: readString(candidate.access_token) ?? 'http-only-cookie',
        refresh_token: readString(candidate.refresh_token) ?? 'http-only-cookie',
        expires_in: typeof candidate.expires_in === 'number' ? candidate.expires_in : undefined,
        token_type: readString(candidate.token_type) ?? 'cookie',
        user: {
          id: userId,
          ...(readString(userCandidate?.email) ? { email: readString(userCandidate?.email) ?? undefined } : {}),
          user_metadata: isRecord(userCandidate?.user_metadata) ? userCandidate.user_metadata : {},
          app_metadata: isRecord(userCandidate?.app_metadata) ? userCandidate.app_metadata : {},
          identities: Array.isArray(userCandidate?.identities)
            ? userCandidate.identities.filter((identity): identity is { provider: string } =>
                isRecord(identity) && typeof identity.provider === 'string')
            : undefined,
        },
      }
    }
  }
  return actorSession(payload)
}

function emitAuthEvent(event: IdentityAuthEvent, session: IdentitySession | null): void {
  currentSession = session
  markStoredIdentityAuthSession(Boolean(session))
  authListeners.forEach(listener => listener(event, session))
}

function safeJson(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

async function request(
  pathOrUrl: string,
  init: RequestInit = {},
  options: { allowUnauthorized?: boolean; absolute?: boolean } = {},
): Promise<{ payload: unknown; response: Response }> {
  const method = init.method ?? 'GET'
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (isMutation(method) && csrfToken && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrfToken)
  const response = await fetchWithTimeout(options.absolute ? pathOrUrl : identityApiUrl(pathOrUrl), {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers,
  })
  readCsrfToken(response)
  const payload = safeJson(await response.text())
  if (!response.ok && !(options.allowUnauthorized && response.status === 401)) {
    throw requestError(response, payload)
  }
  return { payload, response }
}

async function authRequest(
  path: string,
  init: RequestInit,
  successEvent?: IdentityAuthEvent,
): Promise<{ data: { session: IdentitySession | null; user: IdentityUser | null }; error: IdentityClientError | null }> {
  try {
    const { payload } = await request(path, init)
    const session = sessionFromPayload(payload)
    if (successEvent) emitAuthEvent(successEvent, session)
    return { data: { session, user: session?.user ?? null }, error: null }
  } catch (error) {
    return {
      data: { session: null, user: null },
      error: error instanceof Error ? error as IdentityClientError : new Error('Identity request failed'),
    }
  }
}

async function publicCommand<T>(path: string, input: Record<string, unknown>): Promise<{ data: T | null; error: IdentityClientError | null }> {
  try {
    const { payload } = await request(path, { method: 'POST', body: JSON.stringify(input) })
    return { data: unwrapData(payload) as T, error: null }
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error as IdentityClientError : new Error('Identity request failed'),
    }
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = NETWORK_TIMEOUT_MS,
  timeoutMessage = NETWORK_TIMEOUT_MESSAGE,
) {
  try {
    return await sharedFetchWithTimeout(input, init, timeoutMs)
  } catch (error) {
    if (error instanceof HidRequestTimeoutError) throw new Error(timeoutMessage)
    throw error
  }
}

export const identityClient = {
  auth: {
    async getSession() {
      try {
        const { payload, response } = await request('/api/v1/auth/session', {}, { allowUnauthorized: true })
        if (response.status === 401) {
          emitAuthEvent('SIGNED_OUT', null)
          return { data: { session: null }, error: null }
        }
        const session = sessionFromPayload(payload)
        currentSession = session
        markStoredIdentityAuthSession(Boolean(session))
        return { data: { session }, error: null }
      } catch (error) {
        return { data: { session: null }, error: error as IdentityClientError }
      }
    },
    async getUser() {
      const result = await identityClient.auth.getSession()
      return { data: { user: result.data.session?.user ?? null }, error: result.error }
    },
    signInWithPassword(input: { email: string; password: string; options?: { captchaToken?: string; captchaAction?: string } }) {
      return authRequest('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          turnstileToken: input.options?.captchaToken,
          turnstileAction: input.options?.captchaAction,
        }),
      }, 'SIGNED_IN')
    },
    signInWithIdToken(input: { provider: string; token: string; nonce?: string }) {
      return authRequest('/api/v1/auth/oidc/exchange', {
        method: 'POST',
        body: JSON.stringify(input),
      }, 'SIGNED_IN')
    },
    signUp(input: {
      email: string
      password: string
      options?: {
        data?: Record<string, unknown>
        captchaToken?: string
      }
    }) {
      return authRequest('/api/v1/auth/signup', {
        method: 'POST',
        body: JSON.stringify(input),
      }, 'SIGNED_IN')
    },
    startRecoveryOtp(input: {
      identifier: string
      purpose: RecoveryOtpPurpose
      turnstileAction: RecoveryTurnstileAction
      turnstileToken?: string
    }) {
      return publicCommand<RecoveryOtpStart>('/api/v1/auth/otp/start', input)
    },
    verifyRecoveryOtp(input: { challengeId: string; purpose: RecoveryOtpPurpose; code: string }) {
      return publicCommand<RecoveryOtpVerification>('/api/v1/auth/otp/verify', input)
    },
    completeRecoveryOtp(input: {
      challengeId: string
      purpose: RecoveryOtpPurpose
      verificationToken: string
      newPassword: string
    }) {
      return publicCommand<{ completed: true }>('/api/v1/auth/otp/complete', input)
    },
    setSession(input: { access_token: string; refresh_token: string }) {
      return authRequest('/api/v1/auth/token-exchange', {
        method: 'POST',
        body: JSON.stringify(input),
      }, 'SIGNED_IN')
    },
    updateUser(input: { password?: string; data?: Record<string, unknown> }) {
      return authRequest('/api/v1/auth/user', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }, 'USER_UPDATED')
    },
    async signOut() {
      try {
        await request('/api/v1/auth/logout', { method: 'POST' }, { allowUnauthorized: true })
        emitAuthEvent('SIGNED_OUT', null)
        return { error: null }
      } catch (error) {
        emitAuthEvent('SIGNED_OUT', null)
        return { error: error as IdentityClientError }
      }
    },
    onAuthStateChange(listener: AuthListener) {
      authListeners.add(listener)
      queueMicrotask(() => listener('INITIAL_SESSION', currentSession))
      return {
        data: {
          subscription: {
            unsubscribe: () => authListeners.delete(listener),
          },
        },
      }
    },
    mfa: {
      async listFactors() {
        try {
          const { payload } = await request('/api/v1/auth/mfa/factors')
          const value = unwrapData(payload)
          const record = isRecord(value) ? value : {}
          const all = Array.isArray(record.all) ? record.all as IdentityFactor[] : []
          const totp = Array.isArray(record.totp) ? record.totp as IdentityFactor[] : all.filter(factor => factor.factor_type === 'totp')
          return { data: { all, totp }, error: null }
        } catch (error) {
          return { data: { all: [], totp: [] }, error: error as IdentityClientError }
        }
      },
      async getAuthenticatorAssuranceLevel() {
        try {
          const { payload } = await request('/api/v1/auth/mfa/assurance')
          const value = unwrapData(payload)
          const record = isRecord(value) ? value : {}
          return {
            data: {
              currentLevel: readString(record.currentLevel),
              nextLevel: readString(record.nextLevel),
            },
            error: null,
          }
        } catch (error) {
          return { data: { currentLevel: null, nextLevel: null }, error: error as IdentityClientError }
        }
      },
      async enroll(input: { factorType: 'totp'; friendlyName?: string }) {
        try {
          const { payload } = await request('/api/v1/auth/mfa/enroll', {
            method: 'POST',
            body: JSON.stringify(input),
          })
          return { data: unwrapData(payload) as {
            id?: string
            friendly_name?: string | null
            totp?: { qr_code?: string; secret?: string; uri?: string }
          } | null, error: null }
        } catch (error) {
          return { data: null, error: error as IdentityClientError }
        }
      },
      async challengeAndVerify(input: { factorId: string; code: string }) {
        try {
          const { payload } = await request('/api/v1/auth/mfa/verify', {
            method: 'POST',
            body: JSON.stringify(input),
          })
          emitAuthEvent('TOKEN_REFRESHED', currentSession)
          return { data: unwrapData(payload), error: null }
        } catch (error) {
          return { data: null, error: error as IdentityClientError }
        }
      },
      async unenroll(input: { factorId: string }) {
        try {
          const { payload } = await request(`/api/v1/auth/mfa/factors/${encodeURIComponent(input.factorId)}`, {
            method: 'DELETE',
          })
          return { data: unwrapData(payload), error: null }
        } catch (error) {
          return { data: null, error: error as IdentityClientError }
        }
      },
    },
  },
  functions: {
    async invoke(name: string, options: IdentityFunctionInvokeOptions = {}) {
      try {
        const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
        const headers = new Headers(options.headers)
        const { payload } = await request(identityFunctionUrl(name), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        }, { absolute: true })
        return { data: payload, error: null }
      } catch (error) {
        return { data: null, error: error as IdentityClientError }
      }
    },
  },
}

export async function getSafeSession() {
  const { data, error } = await identityClient.auth.getSession()
  if (error) throw error
  return data.session
}

export async function getIdentityActorContext(): Promise<IdentityActorContext | null> {
  const { payload, response } = await request('/api/v1/auth/session', {}, { allowUnauthorized: true })
  if (response.status === 401) return null
  const value = unwrapData(payload)
  const actor = isRecord(value) && isRecord(value.actor) ? value.actor : null
  if (!actor || !readString(actor.subject) || !readString(actor.accountId)
      || !Array.isArray(actor.facilities)) return null
  const facilities = actor.facilities.flatMap((candidate): IdentityFacilityAssignment[] => {
    if (!isRecord(candidate)) return []
    const id = readString(candidate.id)
    const membershipId = readString(candidate.membershipId)
    const organizationId = readString(candidate.organizationId)
    const name = readString(candidate.name)
    if (!id || !membershipId || !organizationId || !name) return []
    return [{
      id,
      membershipId,
      organizationId,
      name,
      ...(readString(candidate.code) ? { code: readString(candidate.code) ?? undefined } : {}),
      roles: Array.isArray(candidate.roles)
        ? candidate.roles.filter((role): role is string => typeof role === 'string') : [],
      permissions: Array.isArray(candidate.permissions)
        ? candidate.permissions.filter((permission): permission is string => typeof permission === 'string') : [],
      isPrimary: candidate.isPrimary === true,
    }]
  })
  return {
    subject: readString(actor.subject)!,
    accountId: readString(actor.accountId)!,
    ...(readString(actor.displayName) ? { displayName: readString(actor.displayName) ?? undefined } : {}),
    facilities,
  }
}

export async function getSafeUser() {
  const { data, error } = await identityClient.auth.getUser()
  if (error) throw error
  return data.user
}

export async function safeSignOut() {
  const { error } = await identityClient.auth.signOut()
  if (error) throw error
}

export function getIdentityCsrfToken() {
  return csrfToken
}

export {
  isConfigured,
  NETWORK_TIMEOUT_MESSAGE,
  NETWORK_TIMEOUT_MS,
} from './identityApiConfig'
