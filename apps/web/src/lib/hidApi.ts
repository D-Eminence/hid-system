import type { IdentitySession } from './identityClient'
import type { AccessLog, AccessRequest, MedicalRecord, MedicalRecordFile, Notification, Patient } from '../types/database'
import type {
  HidHealthEvent,
  HidHealthEventStatus,
  HidHistoryActiveGrant,
  HidHistoryEvent,
  HidHistoryPendingRequest,
  HidNotification,
  HidPatient,
  HidPatientHistoryResponse,
  HidPatientProfileResponse,
  HidPatientRecordsResponse,
  HidPendingShareInvite,
  HidSessionPayload,
  HidShareDurationPreset,
  HidSharePermissionTier,
  HidStaffAccount,
  HidStaffDashboardResponse,
  HidStaffSearchResult,
} from '../types/hid'
import type { UploadDraft } from './medicalRecordUtils'
import { createApiRequestId, parseApiPayload, readApiErrorInfo, unwrapApiData } from './apiResponse'
import { clearAllPortalSessions } from './auth'
import { pruneExpiredMapEntries, setBoundedMapEntry } from './cacheBudget'
import { registerCacheResetter } from './cacheReset'
import { BANNED_ACCOUNT_MESSAGE, isBannedAuthMessage } from './securityMessages'
import {
  fetchWithTimeout,
  getIdentityCsrfToken,
  getSafeSession,
  getSafeUser,
  identityClient,
  NETWORK_TIMEOUT_MESSAGE,
  safeSignOut,
} from './identityClient'
import { identityFunctionUrl } from './identityApiConfig'

type PendingPatientSignup = {
  email?: string | null
  firstName: string
  lastName: string
  hospitalCurrentlyUsing?: string | null
  gender?: string | null
  dob?: string | null
  phone?: string | null
}

type PendingStaffOnboarding = {
  country?: string | null
  fullName: string
  hospitalName?: string | null
  licenseNumber?: string | null
  onboardingType?: 'hospital_signup' | 'staff_invite'
  phone?: string | null
  state?: string | null
}

type EdgeRequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  query?: Record<string, string | number | undefined | null>
  requireAuth?: boolean
}

type SignedUploadResponse = {
  signedUrl: string
  token: string
  path: string
  uploadToken: string
  uploadTokenExpiresAt: string
}

type SignedDownloadResponse = {
  signedUrl: string
}

type PasswordResetStartResponse = {
  challengeId: string
  deliveryChannels: Array<'email'>
  expiresAt: string
  maskedEmail: string | null
}

type PasswordResetVerifyResponse = {
  challengeId: string
  verificationToken: string
}

type AccountDeletionStartResponse = {
  challengeId: string
  deliveryChannels: Array<'email'>
  expiresAt: string
  maskedEmail: string | null
}

type AccountDeletionVerifyResponse = {
  challengeId: string
  verificationToken: string
}

type SignupStartResponse = {
  challengeId: string
  deliveryChannels: Array<'email'>
  expiresAt: string
  maskedEmail: string | null
}

type RecordCreationResponse = {
  record_id: string
  version_id: string
}

type UserSecurityProfile = {
  app_role: string | null
  deleted_at: string | null
  mfa_required: boolean
}

type PrivilegedMfaRequirement = {
  challengeFactorId: string | null
  challengeFactorLabel: string | null
  currentLevel: 'aal1' | 'aal2' | null
  nextLevel: 'aal1' | 'aal2' | null
  needsEnrollment: boolean
  required: boolean
}

function normalizeMfaAssuranceLevel(level: unknown): 'aal1' | 'aal2' | null {
  return level === 'aal1' || level === 'aal2' ? level : null
}

type SignupAvailabilityResponse = {
  accountType: 'patient' | 'hospital'
  emailInUse: boolean
  emailOwner: 'patient' | 'hospital' | 'account' | null
  phoneInUse: boolean
}

type NotificationCountResponse = {
  count: number
}

type TotpEnrollment = {
  factorId: string
  friendlyName: string | null
  qrCode: string
  secret: string
  uri: string
}

export type LegacyAccessRequestWithShare = AccessRequest & {
  permission_tier: HidSharePermissionTier | null
  share_target_type: 'profile' | 'record' | 'health_event'
  duration_preset: HidShareDurationPreset | null
}

type HistoryView = {
  activeGrants: LegacyAccessRequestWithShare[]
  pendingInvites: HidPendingShareInvite[]
  logs: AccessLog[]
}

const RECORD_FILE_BUCKET = 'medical-record-files'
const VIEW_CACHE_TTL_MS = 12000
const RECENT_RECORD_SAVE_TTL_MS = 5 * 60 * 1000
const RECORD_UPLOAD_TIMEOUT_MS = 90000
const RECORD_UPLOAD_RETRY_COUNT = 3
const NOTIFICATIONS_CACHE_TTL_MS = 10_000
const MAX_VIEW_CACHE_ENTRIES = 80
const MAX_SIGNED_DOWNLOAD_CACHE_ENTRIES = 120
const MAX_RECENT_RECORD_SAVE_ENTRIES = 40
const PRIVILEGED_MFA_ROLES = new Set(['platform_admin', 'org_admin', 'clinician'])
const inflightRecordSaves = new Map<string, Promise<RecordCreationResponse>>()
const inflightEdgeGetRequests = new Map<string, Promise<unknown>>()
const recentRecordSaves = new Map<string, RecentRecordSaveEntry>()

type ViewCacheEntry<T> = {
  expiresAt: number
  promise?: Promise<T>
  value?: T
}

type RecentRecordSaveEntry = {
  expiresAt: number
  result: RecordCreationResponse
  uploadedFileKeys: Set<string>
}

type SignedDownloadCacheEntry = {
  expiresAt: number
  promise?: Promise<string>
  value?: string
}

const viewCache = new Map<string, ViewCacheEntry<unknown>>()
const signedDownloadCache = new Map<string, SignedDownloadCacheEntry>()

function clearHidApiCaches() {
  viewCache.clear()
  signedDownloadCache.clear()
  inflightEdgeGetRequests.clear()
  inflightRecordSaves.clear()
  recentRecordSaves.clear()
}

registerCacheResetter(clearHidApiCaches)

export class HidApiError extends Error {
  status: number
  details?: unknown
  code: string | null
  requestId: string | null
  retryable: boolean

  constructor(
    status: number,
    message: string,
    details?: unknown,
    metadata: { code?: string | null; requestId?: string | null; retryable?: boolean } = {},
  ) {
    super(message)
    this.status = status
    this.details = details
    this.code = metadata.code ?? null
    this.requestId = metadata.requestId ?? null
    this.retryable = metadata.retryable ?? (status === 408 || status === 425 || status === 429 || status >= 500)
  }
}

function fallbackErrorMessageForStatus(status: number) {
  if (status === 400 || status === 422) return 'Some information is missing or not in the right format. Review it and try again.'
  if (status === 401) return 'Please sign in to continue.'
  if (status === 403) return 'This account is not allowed to do that right now.'
  if (status === 404) return 'We could not find the information you requested.'
  if (status === 408) return NETWORK_TIMEOUT_MESSAGE
  if (status === 409) return 'This action conflicts with existing information. Review the details and try again.'
  if (status === 429) return 'Too many requests were made too quickly. Please wait a moment and try again.'
  if (status >= 500) return 'This service is temporarily unavailable right now. Please try again shortly.'
  return 'That action could not be completed right now. Please try again.'
}

function isLowSignalErrorMessage(message: string) {
  const lower = message.toLowerCase()
  return (
    lower === 'request failed' ||
    lower === 'failed' ||
    lower === 'error' ||
    lower === 'internal server error' ||
    lower === 'bad request' ||
    lower === 'forbidden' ||
    lower === 'unauthorized' ||
    lower === 'not found' ||
    lower === 'service unavailable' ||
    lower === 'gateway timeout'
  )
}

function readCachedView<T>(key: string): { hit: boolean; value?: T } {
  pruneExpiredMapEntries(viewCache)
  const cached = viewCache.get(key) as ViewCacheEntry<T> | undefined
  if (!cached) return { hit: false }
  if (cached.value !== undefined && cached.expiresAt > Date.now()) {
    return { hit: true, value: cached.value }
  }
  if (!cached.promise) {
    viewCache.delete(key)
  }
  return { hit: false }
}

function writeCachedView<T>(key: string, value: T, ttlMs = VIEW_CACHE_TTL_MS) {
  setBoundedMapEntry(viewCache, key, {
    expiresAt: Date.now() + ttlMs,
    value,
  }, MAX_VIEW_CACHE_ENTRIES)
  return value
}

function invalidateViewCache(prefix: string) {
  for (const key of viewCache.keys()) {
    if (key.startsWith(prefix)) {
      viewCache.delete(key)
    }
  }
}

async function loadCachedView<T>(key: string, loader: () => Promise<T>, ttlMs = VIEW_CACHE_TTL_MS) {
  const immediate = readCachedView<T>(key)
  if (immediate.hit) {
    return immediate.value as T
  }

  const cached = viewCache.get(key) as ViewCacheEntry<T> | undefined
  if (cached?.promise) {
    return cached.promise
  }

  const promise = loader()
    .then(value => writeCachedView(key, value, ttlMs))
    .catch(error => {
      viewCache.delete(key)
      throw error
    })

  setBoundedMapEntry(viewCache, key, {
    expiresAt: Date.now() + ttlMs,
    promise,
  }, MAX_VIEW_CACHE_ENTRIES)

  return promise
}

function normalizePhone(value: string) {
  return value.replace(/[^0-9+]/g, '').trim()
}

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function normalizeComparableText(value: string | null | undefined) {
  return `${value ?? ''}`.trim().toLowerCase().replace(/\s+/g, ' ')
}

function looksLikeEmailIdentifier(value: string) {
  return /\S+@\S+\.\S+/.test(value.trim())
}

async function clearConflictingAuthSession(targetEmail?: string | null) {
  const normalizedTargetEmail = targetEmail?.trim().toLowerCase() ?? null
  const currentUser = await getSafeUser()

  if (!currentUser) return

  const currentEmail = currentUser.email?.trim().toLowerCase() ?? null
  if (normalizedTargetEmail && currentEmail === normalizedTargetEmail) return

  await safeSignOut()
  clearAllPortalSessions()
}

async function assertHospitalAccountCompatibleEmail() {
  const user = await getSafeUser()
  if (!user) return

  const requestedRole = `${user.user_metadata.requested_role ?? ''}`.trim().toLowerCase()
  const hasPendingPatientSignup = isPendingPatientSignup(user.user_metadata.pending_patient_signup)
  const hasPendingStaffOnboarding = isPendingStaffOnboarding(user.user_metadata.pending_staff_onboarding)

  if (requestedRole === 'patient' && !hasPendingStaffOnboarding) {
    await safeSignOut()
    clearAllPortalSessions()
    throw new HidApiError(
      409,
      hasPendingPatientSignup
        ? 'This email is already linked to a patient account. Use a different email for the hospital account.'
        : 'This email cannot be used for a hospital account. Use a different email address.'
    )
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isExistingAccountError(error: unknown) {
  if (!(error instanceof Error)) return false
  const lower = error.message.toLowerCase()
  return lower.includes('already registered') || lower.includes('already exists')
}

function hasSilentExistingSignupConflict(user: { identities?: Array<unknown> | null } | null | undefined) {
  return Boolean(user && Array.isArray(user.identities) && user.identities.length === 0)
}

export function isTotpEnrollmentUnavailableError(error: unknown) {
  if (!(error instanceof Error)) return false
  const lower = error.message.toLowerCase()
  return (
    lower.includes('mfa enroll is disabled for totp') ||
    lower.includes('totp enroll is disabled') ||
    (lower.includes('mfa') && lower.includes('disabled') && lower.includes('totp'))
  )
}

function isPendingPatientSignup(value: unknown): value is PendingPatientSignup {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.firstName === 'string' && typeof candidate.lastName === 'string'
}

function isPendingStaffOnboarding(value: unknown): value is PendingStaffOnboarding {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.fullName === 'string'
}

function formatDeletedAccountMessage(message: string) {
  const lower = message.toLowerCase()
  if (lower.includes('patient account has been deleted')) {
    return 'This patient account has been deleted and can no longer be opened by a hospital.'
  }
  if (lower.includes('account has been deleted')) {
    return 'This account has been deleted and is no longer available.'
  }
  return null
}

function formatLockedAccountMessage(message: string) {
  const lower = message.toLowerCase()
  if (lower.includes('patient account is locked')) {
    return 'This patient account is locked right now and cannot be opened by a hospital.'
  }
  if (lower.includes('account is inactive') || lower.includes('account is not active') || lower.includes('account is locked')) {
    return 'This account is locked right now. Contact support if you need help.'
  }
  return null
}

function formatTechnicalApiMessage(message: string, status: number) {
  const lower = message.toLowerCase()
  if (lower.includes('foreign key') || lower.includes('violates') && lower.includes('constraint')) {
    return 'This action cannot be completed because other records still depend on this information.'
  }
  if (lower.includes('platform admin') && lower.includes('delete')) {
    return 'The platform admin could not be permanently deleted right now. Please try again shortly.'
  }
  if (lower.includes('failed to fetch') || lower.includes('network')) {
    return 'We could not reach the service right now. Check your connection and try again.'
  }
  if (status >= 500 && (lower.includes('identity api') || lower.includes('postgres') || lower.includes('database'))) {
    return 'The service is temporarily unavailable. Please try again shortly.'
  }
  return null
}

async function resetAuthState() {
  try {
    await safeSignOut()
  } catch {
    // Best effort only.
  }
  clearAllPortalSessions()
  viewCache.clear()
}

async function edgeRequest<T>(functionName: string, options: EdgeRequestOptions = {}): Promise<T> {
  const url = new URL(identityFunctionUrl(functionName), window.location.origin)
  const method = options.method ?? (options.body == null ? 'GET' : 'POST')

  Object.entries(options.query ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    url.searchParams.set(key, String(value))
  })

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-ID': createApiRequestId(),
  }

  if (options.requireAuth !== false) {
    const session = await getSafeSession()
    if (!session) {
      throw new HidApiError(401, 'Please sign in to continue.')
    }
  }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    const csrfToken = getIdentityCsrfToken()
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken
  }

  const requestInit: RequestInit = {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
    credentials: 'include',
  }
  const inflightKey =
    method === 'GET'
      ? JSON.stringify({
          url: url.toString(),
          requireAuth: options.requireAuth !== false,
        })
      : null

  const runRequest = async () => {
    let response: Response
    try {
      response = await fetchWithTimeout(url.toString(), requestInit)
    } catch (error) {
      if (isAbortError(error) || (error instanceof Error && error.message.toLowerCase().includes('took too long'))) {
        throw new HidApiError(408, NETWORK_TIMEOUT_MESSAGE, error, {
          code: 'REQUEST_TIMEOUT',
          requestId: headers['X-Request-ID'],
          retryable: true,
        })
      }
      throw new HidApiError(503, 'We could not reach the service right now. Check your connection and try again.', error, {
        code: 'NETWORK_ERROR',
        requestId: headers['X-Request-ID'],
        retryable: true,
      })
    }

    const rawBody = await response.text()
    const parsedPayload = parseApiPayload(rawBody)

    const fallbackMessage = rawBody
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (!response.ok) {
      const errorInfo = readApiErrorInfo(parsedPayload, {
        fallbackMessage: fallbackMessage || response.statusText || fallbackErrorMessageForStatus(response.status),
        fallbackStatus: response.status,
        response,
      })
      const rawResponseMessage = errorInfo.message
      const normalizedAccountStateMessage = formatDeletedAccountMessage(rawResponseMessage) ?? formatLockedAccountMessage(rawResponseMessage)
      const technicalMessage = formatTechnicalApiMessage(rawResponseMessage, response.status)
      const responseMessage = isBannedAuthMessage(rawResponseMessage)
        ? BANNED_ACCOUNT_MESSAGE
        : normalizedAccountStateMessage
          ? normalizedAccountStateMessage
          : technicalMessage
            ? technicalMessage
          : rawResponseMessage && !isLowSignalErrorMessage(rawResponseMessage)
            ? rawResponseMessage
            : fallbackErrorMessageForStatus(response.status)

      const lowered = responseMessage.toLowerCase()
      if (
        response.status === 401 ||
        lowered.includes('jwt') ||
        lowered.includes('refresh token') ||
        lowered.includes('authentication required') ||
        lowered.includes('please sign in again')
      ) {
        await resetAuthState()
      }

      throw new HidApiError(
        response.status,
        responseMessage,
        errorInfo.details,
        {
          code: errorInfo.code,
          requestId: errorInfo.requestId ?? headers['X-Request-ID'],
          retryable: errorInfo.retryable,
        },
      )
    }

    const unwrapped = unwrapApiData<T>(parsedPayload)
    if (unwrapped.found) {
      return unwrapped.value as T
    }

    return (parsedPayload ?? rawBody) as T
  }

  if (!inflightKey) {
    return runRequest()
  }

  const existing = inflightEdgeGetRequests.get(inflightKey)
  if (existing) {
    return existing as Promise<T>
  }

  const promise = runRequest().finally(() => {
    inflightEdgeGetRequests.delete(inflightKey)
  })
  inflightEdgeGetRequests.set(inflightKey, promise)
  return promise
}

async function clearPendingMetadata(key: 'pending_patient_signup' | 'pending_staff_onboarding') {
  const user = await getSafeUser()
  if (!user) return
  if (!(key in user.user_metadata)) return

  try {
    await identityClient.auth.updateUser({
      data: {
        ...user.user_metadata,
        [key]: null,
      },
    })
  } catch {
    // Metadata cleanup is best effort only.
  }
}

export async function assertGoogleSignInEligibility(path: 'patient' | 'hospital', email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!looksLikeEmailIdentifier(normalizedEmail)) {
    throw new HidApiError(400, 'Enter the email address already registered on HID before using Google sign-in.')
  }

  const result = await edgeRequest<{ registered: boolean }>('google-signin-eligibility', {
    method: 'POST',
    requireAuth: false,
    body: { accountType: path === 'hospital' ? 'hospital' : 'patient', email: normalizedEmail },
  })
  if (!result.registered) {
    throw new HidApiError(404, 'This Google email is not registered on HID. Use Sign Up first.')
  }
}

export async function signInWithGoogleIdToken(path: 'patient' | 'hospital', credential: string, email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  await assertGoogleSignInEligibility(path, normalizedEmail)
  await clearConflictingAuthSession(normalizedEmail)

  const { data, error } = await identityClient.auth.signInWithIdToken({
    provider: 'google',
    token: credential,
  })
  if (error) {
    const message = error.message.toLowerCase()
    if (message.includes('audience') || message.includes('client') || message.includes('id token') || message.includes('jwt')) {
      throw new HidApiError(503, 'Google sign-in is not configured correctly right now. Please contact HID support.', error)
    }
    throw new HidApiError(401, 'Google could not sign you in. Choose the Google account already registered on HID and try again.', error)
  }

  const authenticatedEmail = data.user?.email?.trim().toLowerCase()
  if (!authenticatedEmail || authenticatedEmail !== normalizedEmail) {
    await safeSignOut().catch(() => undefined)
    clearAllPortalSessions()
    throw new HidApiError(401, 'Google returned a different account than the one selected. Please try again.')
  }

  return data
}

export async function finalizeGoogleSignIn(path: 'patient' | 'hospital') {
  return edgeRequest<{ registered: boolean }>('google-signin-finalize', {
    method: 'POST',
    body: { accountType: path === 'hospital' ? 'hospital' : 'patient' },
  })
}

async function getCurrentUserSecurityProfile() {
  return fetchCurrentSecurityProfile()
}

async function getCurrentUserAppRole() {
  const profile = await getCurrentUserSecurityProfile()
  return profile?.app_role ?? null
}

function formatSignupAvailabilityConflict(result: SignupAvailabilityResponse) {
  if (result.emailInUse && result.phoneInUse) {
    return 'The information has already been used, Try to sign in.'
  }
  if (result.emailInUse) {
    return 'The information has already been used, Try to sign in.'
  }
  if (result.phoneInUse) {
    return 'The information has already been used, Try to sign in.'
  }
  return null
}

async function checkSignupAvailability(params: {
  accountType: 'patient' | 'hospital'
  email?: string | null
  phone?: string | null
}) {
  const normalizedEmail = normalizeOptionalText(params.email?.trim().toLowerCase())
  const normalizedPhone = normalizeOptionalText(normalizePhone(params.phone ?? ''))
  const cacheKey = `signup-availability:${params.accountType}:${normalizedEmail ?? ''}:${normalizedPhone ?? ''}`

  return loadCachedView(
    cacheKey,
    () => edgeRequest<SignupAvailabilityResponse>('signup-availability', {
      method: 'POST',
      requireAuth: false,
      body: {
        accountType: params.accountType,
        email: normalizedEmail,
        phone: normalizedPhone,
      },
    }),
    8_000,
  )
}

async function assertSignupAvailability(params: {
  accountType: 'patient' | 'hospital'
  email?: string | null
  phone?: string | null
}) {
  const result = await checkSignupAvailability(params)
  const conflictMessage = formatSignupAvailabilityConflict(result)
  if (conflictMessage) {
    throw new HidApiError(409, conflictMessage, result)
  }
}

async function assertNoSilentSignupConflict(params: {
  accountType: 'patient' | 'hospital'
  email?: string | null
  phone?: string | null
  user: { identities?: Array<unknown> | null } | null | undefined
}) {
  if (!hasSilentExistingSignupConflict(params.user)) return

  const availability = await checkSignupAvailability({
    accountType: params.accountType,
    email: params.email,
    phone: params.phone,
  })

  throw new HidApiError(
    409,
    formatSignupAvailabilityConflict(availability) ?? 'The information has already been used, Try to sign in.',
    availability,
  )
}

async function startSignupVerification(params: {
  accountType: 'patient' | 'hospital'
  captchaToken?: string | null
  email: string
  patient?: PendingPatientSignup
  staff?: PendingStaffOnboarding
}) {
  return edgeRequest<SignupStartResponse>('signup-start', {
    method: 'POST',
    requireAuth: false,
    body: {
      accountType: params.accountType,
      email: params.email.trim().toLowerCase(),
      patient: params.patient,
      staff: params.staff,
      turnstileToken: params.captchaToken ?? null,
    },
  })
}

function toFriendlyFactorLabel(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function listMfaFactors() {
  const { data, error } = await identityClient.auth.mfa.listFactors()
  if (error) {
    throw new HidApiError(400, error.message, error)
  }
  return data
}

export async function getPrivilegedMfaRequirement(): Promise<PrivilegedMfaRequirement> {
  const profile = await getCurrentUserSecurityProfile()
  if (!profile?.mfa_required || !profile.app_role || !PRIVILEGED_MFA_ROLES.has(profile.app_role)) {
    return {
      challengeFactorId: null,
      challengeFactorLabel: null,
      currentLevel: null,
      nextLevel: null,
      needsEnrollment: false,
      required: false,
    }
  }

  const [{ data: assurance, error: assuranceError }, factors] = await Promise.all([
    identityClient.auth.mfa.getAuthenticatorAssuranceLevel(),
    listMfaFactors(),
  ])

  if (assuranceError) {
    throw new HidApiError(400, assuranceError.message, assuranceError)
  }

  const verifiedTotp = (factors?.totp ?? []).find(factor => typeof factor?.id === 'string') ?? null
  const currentLevel = normalizeMfaAssuranceLevel(assurance?.currentLevel)
  const nextLevel = normalizeMfaAssuranceLevel(assurance?.nextLevel)

  return {
    challengeFactorId: typeof verifiedTotp?.id === 'string' ? verifiedTotp.id : null,
    challengeFactorLabel: toFriendlyFactorLabel(verifiedTotp?.friendly_name),
    currentLevel,
    nextLevel,
    needsEnrollment: !verifiedTotp,
    required: currentLevel !== 'aal2',
  }
}

export async function enrollPrivilegedTotp(friendlyName: string): Promise<TotpEnrollment> {
  const factors = await listMfaFactors()
  const staleUnverifiedTotp = (factors?.all ?? []).filter(
    factor => factor.factor_type === 'totp' && factor.status !== 'verified' && typeof factor.id === 'string',
  )

  for (const factor of staleUnverifiedTotp) {
    await identityClient.auth.mfa.unenroll({ factorId: factor.id }).catch(() => undefined)
  }

  const { data, error } = await identityClient.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName,
  })

  if (error || !data?.id || !data.totp?.qr_code || !data.totp.secret || !data.totp.uri) {
    throw new HidApiError(400, error?.message ?? 'Unable to start multi-factor setup right now.', error)
  }

  return {
    factorId: data.id,
    friendlyName: toFriendlyFactorLabel(data.friendly_name) ?? friendlyName,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
    uri: data.totp.uri,
  }
}

export async function verifyPrivilegedTotp(factorId: string, code: string) {
  const normalizedCode = code.trim()
  if (normalizedCode.length !== 6) {
    throw new HidApiError(400, 'Enter the 6-digit authenticator code first.')
  }

  const { error } = await identityClient.auth.mfa.challengeAndVerify({
    factorId,
    code: normalizedCode,
  })

  if (error) {
    throw new HidApiError(400, error.message, error)
  }
}

async function requestEmailOtp(
  email: string,
  turnstileAction: 'staff-reset' | 'admin-reset' | 'legacy-recovery',
  captchaToken?: string | null,
) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!looksLikeEmailIdentifier(normalizedEmail)) {
    throw new HidApiError(400, 'Enter a valid email address first.')
  }

  await clearConflictingAuthSession(normalizedEmail)

  const { data, error } = await identityClient.auth.startRecoveryOtp({
    identifier: normalizedEmail,
    purpose: turnstileAction === 'legacy-recovery' ? 'LEGACY_ACCOUNT_RECOVERY' : 'PASSWORD_RESET',
    turnstileAction,
    turnstileToken: captchaToken ?? undefined,
  })

  if (error) {
    throw new HidApiError(400, error.message, error)
  }
  if (!data) throw new HidApiError(503, 'Verification codes are unavailable right now.')
  return data
}

async function verifyEmailOtp(challengeId: string, code: string) {
  const { data, error } = await identityClient.auth.verifyRecoveryOtp({
    challengeId,
    purpose: 'PASSWORD_RESET',
    code: code.trim(),
  })

  if (error) {
    throw new HidApiError(400, error.message, error)
  }

  if (!data?.verificationToken) {
    throw new HidApiError(400, 'The verification code is not correct.')
  }
  return data
}

async function completeEmailOtp(challengeId: string, verificationToken: string, password: string) {
  const { data, error } = await identityClient.auth.completeRecoveryOtp({
    challengeId,
    purpose: 'PASSWORD_RESET',
    verificationToken,
    newPassword: password,
  })
  if (error) throw new HidApiError(400, error.message, error)
  if (!data?.completed) throw new HidApiError(400, 'Unable to complete password recovery.')
}

export function toLegacyPatient(patient: HidPatient): Patient {
  return {
    id: patient.id,
    first_name: patient.first_name,
    last_name: patient.last_name,
    full_name: patient.full_name,
    phone: patient.phone_e164,
    email: patient.email,
    hospital_currently_using: patient.hospital_currently_using,
    gender: patient.gender,
    auth_password_hash: null,
    blood_group: patient.blood_group ?? 'Unknown',
    nin_verified: Boolean(patient.nin_hash || patient.nin_ciphertext || patient.nin_last4),
    hid_code: patient.hid_code,
    pin: null,
    created_at: patient.created_at,
    nin: patient.nin_last4 ? `****${patient.nin_last4}` : null,
    dob: patient.dob,
    country: patient.country,
    state: patient.state,
    genotype: patient.genotype,
    allergies: patient.allergies,
    chronic_conditions: patient.chronic_conditions,
    current_medications: patient.current_medications,
    photo_url: patient.photo_url,
    emergency_contact_name: patient.emergency_contact_name,
    emergency_contact_relationship: patient.emergency_contact_relationship,
    emergency_contact_phone: patient.emergency_contact_phone,
    emergency_contact_address: patient.emergency_contact_address,
    hmo_organization: patient.hmo_organization,
    medical_notes: patient.medical_notes,
    profile_percent: patient.profile_percent,
    notifications_enabled: patient.notifications_enabled,
    access_pin_configured: Boolean(patient.access_pin_configured),
  }
}

function inferLegacyAccessType(scope: string, breakGlass = false): 'standard' | 'emergency' {
  if (breakGlass || scope === 'break_glass') return 'emergency'
  return 'standard'
}

function toLegacyAccessRequest(
  hidCode: string,
  entry: HidHistoryPendingRequest | HidHistoryActiveGrant
): LegacyAccessRequestWithShare {
  const startTime = 'starts_at' in entry ? entry.starts_at : entry.created_at
  const endTime = 'expires_at' in entry ? entry.expires_at : null
  const durationHours = endTime
    ? Math.max(1, Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / (60 * 60 * 1000)))
    : null

  return {
    id: 'grant_id' in entry ? entry.grant_id : entry.request_id,
    hid_code: hidCode,
    doctor_account_id: entry.staff_account_id,
    doctor_name: entry.staff_name,
    request_type: inferLegacyAccessType(entry.scope, entry.break_glass),
    status: 'grant_id' in entry ? 'approved' : 'pending',
    reason: entry.reason,
    pin_verified: false,
    approved_by: 'grant_id' in entry ? 'Patient' : null,
    approved_at: 'starts_at' in entry ? entry.starts_at : entry.approved_at,
    duration_hours: durationHours,
    access_expires_at: 'expires_at' in entry ? entry.expires_at : null,
    created_at: startTime,
    permission_tier: 'permission_tier' in entry ? entry.permission_tier : null,
    share_target_type: 'share_target_type' in entry ? entry.share_target_type : 'profile',
    duration_preset: 'duration_preset' in entry ? entry.duration_preset : null,
  }
}

function toLegacyAccessLog(hidCode: string, event: HidHistoryEvent): AccessLog {
  const reasonText = `${event.reason ?? ''} ${JSON.stringify(event.metadata ?? {})}`.toLowerCase()
  return {
    id: event.event_id,
    hid_code: hidCode,
    accessed_by: event.actor_name,
    access_time: event.created_at,
    reason: event.reason,
    access_type: reasonText.includes('break_glass') || event.action.includes('break_glass') ? 'emergency' : 'standard',
    request_id: typeof event.metadata?.request_id === 'string' ? event.metadata.request_id : null,
  }
}

function toLegacyNotification(notification: HidNotification, hidCode: string): Notification {
  return {
    id: notification.id,
    hid_code: hidCode,
    title: notification.title,
    message: notification.message,
    type: notification.type as Notification['type'],
    is_read: Boolean(notification.read_at),
    created_at: notification.created_at,
  }
}

async function signRecordDownload(fileId: string) {
  const cacheKey = `${fileId}:180`
  const now = Date.now()
  pruneExpiredMapEntries(signedDownloadCache, now)
  const cached = signedDownloadCache.get(cacheKey)

  if (cached?.value && cached.expiresAt > now) {
    return { signedUrl: cached.value }
  }

  if (cached?.promise) {
    const signedUrl = await cached.promise
    return { signedUrl }
  }

  const request = edgeRequest<SignedDownloadResponse>('files-sign-download', {
    method: 'POST',
    body: { fileId, expiresIn: 180 },
  })
    .then(response => {
      setBoundedMapEntry(signedDownloadCache, cacheKey, {
        expiresAt: Date.now() + 120_000,
        value: response.signedUrl,
      }, MAX_SIGNED_DOWNLOAD_CACHE_ENTRIES)
      return response.signedUrl
    })
    .catch(error => {
      signedDownloadCache.delete(cacheKey)
      throw error
    })

  setBoundedMapEntry(signedDownloadCache, cacheKey, {
    expiresAt: now + 120_000,
    promise: request,
  }, MAX_SIGNED_DOWNLOAD_CACHE_ENTRIES)

  const signedUrl = await request
  return { signedUrl }
}

async function toLegacyRecordFiles(files: HidPatientRecordsResponse['records'][number]['files']): Promise<MedicalRecordFile[]> {
  const resolvedFiles = await Promise.all(files.map(async file => {
    try {
      const signedUrl = file.signed_download_url || (await signRecordDownload(file.id)).signedUrl
      return {
        id: file.id,
        record_id: file.record_id,
        file_name: file.original_file_name,
        file_type: file.mime_type,
        file_data_url: signedUrl,
        created_at: file.created_at,
      } satisfies MedicalRecordFile
    } catch {
      return {
        id: file.id,
        record_id: file.record_id,
        file_name: file.original_file_name,
        file_type: file.mime_type,
        file_data_url: '',
        created_at: file.created_at,
      } satisfies MedicalRecordFile
    }
  }))

  return resolvedFiles
}

function toLegacyMedicalRecord(
  patient: HidPatient,
  bundle: HidPatientRecordsResponse['records'][number],
  files: MedicalRecordFile[]
): MedicalRecord {
  const firstFile = files[0]
  const version = bundle.current_version
  return {
    id: bundle.record.id,
    hid_code: patient.hid_code,
    title: bundle.record.title,
    category: (bundle.record.category as MedicalRecord['category']) ?? 'other',
    record: version?.record ?? 'No record details available.',
    notes: version?.notes ?? null,
    attachment_name: firstFile?.file_name ?? null,
    attachment_type: firstFile?.file_type ?? null,
    attachment_data_url: firstFile?.file_data_url ?? null,
    transcription_text: version?.transcription_text ?? null,
    created_by: version?.created_by_name ?? bundle.record.created_by_name ?? 'Authorized user',
    added_by_role: version?.created_by_role ?? bundle.record.created_by_role ?? 'patient',
    created_at: bundle.record.created_at,
    info_type: bundle.record.info_type ?? 'document',
    structured_data: version?.structured_data ?? null,
    created_by_org: version?.created_by_org ?? bundle.record.created_by_org ?? null,
    created_by_verified: version?.created_by_verified ?? bundle.record.created_by_verified ?? false,
    source_provenance: bundle.record.source_provenance ?? null,
    structured_schema_version: bundle.record.structured_schema_version ?? null,
  }
}

async function dataUrlToBlob(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/)
  if (!match) {
    const response = await fetchWithTimeout(dataUrl)
    return response.blob()
  }

  const mimeType = match[1] || 'application/octet-stream'
  const isBase64 = Boolean(match[2])
  const payload = match[3] ?? ''

  if (isBase64) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new Blob([bytes], { type: mimeType })
  }

  return new Blob([decodeURIComponent(payload)], { type: mimeType })
}

function delay(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function buildUploadDraftKey(upload: UploadDraft) {
  return `${upload.file_name}:${upload.file_type ?? ''}:${upload.file_data_url.length}`
}

function pruneRecentRecordSaves() {
  pruneExpiredMapEntries(recentRecordSaves)
}

async function fetchWithManualTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  try {
    return await fetchWithTimeout(input, init, timeoutMs)
  } catch (error) {
    if (error instanceof Error && error.message === NETWORK_TIMEOUT_MESSAGE) {
      throw new HidApiError(408, NETWORK_TIMEOUT_MESSAGE, error)
    }
    throw error
  }
}

async function retryRecordUpload<T>(operation: () => Promise<T>) {
  let lastError: unknown = null
  for (let attempt = 0; attempt < RECORD_UPLOAD_RETRY_COUNT; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof HidApiError && [400, 401, 403, 404, 409, 422].includes(error.status)) {
        throw error
      }
      lastError = error
      if (attempt === RECORD_UPLOAD_RETRY_COUNT - 1) break
      await delay(400 * (attempt + 1))
    }
  }
  throw lastError instanceof Error ? lastError : new HidApiError(502, 'Unable to finish uploading the attached files right now.')
}

export async function fetchPatientProfileBundle() {
  return edgeRequest<HidPatientProfileResponse>('patients-me')
}

async function fetchPatientProfileBundleWithRetry(attempts = 5, delayMs = 160) {
  let lastError: unknown = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchPatientProfileBundle()
    } catch (error) {
      lastError = error
      if (!(error instanceof HidApiError) || error.status !== 404 || attempt === attempts - 1) {
        throw error
      }
      await delay(delayMs * (attempt + 1))
    }
  }

  throw lastError instanceof Error ? lastError : new HidApiError(404, 'Patient profile not found.')
}

export async function ensurePatientProfileRegistered(override?: PendingPatientSignup) {
  try {
    return await fetchPatientProfileBundle()
  } catch (error) {
    if (!(error instanceof HidApiError) || error.status !== 404) throw error
  }

  const user = await getSafeUser()
  if (!user) {
    throw new HidApiError(401, 'Please sign in to continue.')
  }

  const pendingData = override ?? (
    isPendingPatientSignup(user.user_metadata.pending_patient_signup)
      ? user.user_metadata.pending_patient_signup
      : null
  )

  if (!pendingData) {
    throw new HidApiError(400, 'Your patient profile is incomplete. Start the sign-up process again.')
  }

  try {
      await edgeRequest<{ patient_id: string; hid_code: string }>('patient-register', {
      method: 'POST',
      body: {
        firstName: pendingData.firstName,
        lastName: pendingData.lastName,
        hospitalCurrentlyUsing: normalizeOptionalText(pendingData.hospitalCurrentlyUsing),
        gender: normalizeOptionalText(pendingData.gender),
        dob: normalizeOptionalText(pendingData.dob),
        phone: normalizeOptionalText(pendingData.phone),
      },
    })
  } catch (error) {
    if (!(error instanceof HidApiError) || !isExistingAccountError(error)) {
      throw error
    }
  }

  await clearPendingMetadata('pending_patient_signup')
  return fetchPatientProfileBundleWithRetry()
}

export async function fetchMyPatient() {
  const session = await getSafeSession()
  const userId = session?.user.id
  if (!userId) {
    throw new HidApiError(401, 'Please sign in to continue.')
  }

  return loadCachedView(`patient:${userId}`, async () => {
    // Loading an authenticated user must never create an app profile. OAuth
    // users complete onboarding explicitly through password and OTP signup.
    const bundle = await fetchPatientProfileBundle()
    return toLegacyPatient(bundle.patient)
  })
}

export async function updateMyPatientProfile(patch: Partial<Patient>) {
  const current = await ensurePatientProfileRegistered()
  const payload = {
    first_name: patch.first_name ?? current.patient.first_name,
    last_name: patch.last_name ?? current.patient.last_name,
    full_name: patch.full_name ?? `${patch.first_name ?? current.patient.first_name} ${patch.last_name ?? current.patient.last_name}`.trim(),
    phone_e164: patch.phone ?? current.patient.phone_e164,
    email: patch.email ?? current.patient.email,
    gender: patch.gender ?? current.patient.gender,
    dob: patch.dob ?? current.patient.dob,
    blood_group: patch.blood_group ?? current.patient.blood_group,
    genotype: patch.genotype ?? current.patient.genotype,
    country: patch.country ?? current.patient.country,
    state: patch.state ?? current.patient.state,
    hospital_currently_using: patch.hospital_currently_using ?? current.patient.hospital_currently_using,
    allergies: patch.allergies ?? current.patient.allergies,
    chronic_conditions: patch.chronic_conditions ?? current.patient.chronic_conditions,
    current_medications: patch.current_medications ?? current.patient.current_medications,
    photo_url: patch.photo_url ?? current.patient.photo_url,
    emergency_contact_name: patch.emergency_contact_name ?? current.patient.emergency_contact_name,
    emergency_contact_relationship: patch.emergency_contact_relationship ?? current.patient.emergency_contact_relationship,
    emergency_contact_phone: patch.emergency_contact_phone ?? current.patient.emergency_contact_phone,
    emergency_contact_address: patch.emergency_contact_address ?? current.patient.emergency_contact_address,
    hmo_organization: patch.hmo_organization ?? current.patient.hmo_organization,
    medical_notes: patch.medical_notes ?? current.patient.medical_notes,
    notifications_enabled: patch.notifications_enabled ?? current.patient.notifications_enabled,
    profile_percent: patch.profile_percent ?? current.patient.profile_percent,
  }

  const response = await edgeRequest<{ data?: HidPatient } | HidPatient>('patient-profile-update', {
    method: 'POST',
    body: payload,
  })
  const data = 'data' in response && response.data ? response.data : response

  invalidateViewCache('patient:')
  return {
    ...toLegacyPatient(data as HidPatient),
    access_pin_configured: Boolean(current.patient.access_pin_configured),
  }
}

export async function setMyPatientAccessPin(accessPin?: string | null) {
  const response = await edgeRequest<{ configured: boolean }>('patient-access-pin', {
    method: 'POST',
    body: {
      accessPin: normalizeOptionalText(accessPin),
    },
  })
  invalidateViewCache('patient:')
  return response
}

export async function countUnreadNotifications(options: { forceRefresh?: boolean } = {}) {
  if (options.forceRefresh) {
    viewCache.delete('notifications:count:self')
  }

  return loadCachedView('notifications:count:self', async () => {
    const response = await edgeRequest<NotificationCountResponse>('notifications-list', {
      query: {
        countOnly: '1',
        unreadOnly: '1',
      },
    })

    return Number.isFinite(response.count) ? response.count : 0
  }, NOTIFICATIONS_CACHE_TTL_MS)
}

export async function listNotifications(hidCode: string, options: { forceRefresh?: boolean } = {}) {
  const cacheKey = `notifications:list:${hidCode}`
  if (options.forceRefresh) {
    viewCache.delete(cacheKey)
  }

  return loadCachedView(cacheKey, async () => {
    const data = await edgeRequest<HidNotification[]>('notifications-list', {
      query: {
        limit: 200,
      },
    })

    return (data ?? []).map(item => toLegacyNotification(item, hidCode))
  }, NOTIFICATIONS_CACHE_TTL_MS)
}

export async function listUnreadNotifications(hidCode: string, limit = 20, options: { forceRefresh?: boolean } = {}) {
  const cacheKey = `notifications:unread:${hidCode}:${limit}`
  if (options.forceRefresh) {
    viewCache.delete(cacheKey)
  }

  return loadCachedView(cacheKey, async () => {
    const data = await edgeRequest<HidNotification[]>('notifications-list', {
      query: {
        limit,
        unreadOnly: '1',
      },
    })

    return (data ?? []).map(item => toLegacyNotification(item, hidCode))
  }, NOTIFICATIONS_CACHE_TTL_MS)
}

export async function listCurrentUserNotifications(
  limit = 20,
  options: { forceRefresh?: boolean; unreadOnly?: boolean } = {},
) {
  const cacheKey = `notifications:current:${options.unreadOnly ? 'unread' : 'all'}:${limit}`
  if (options.forceRefresh) {
    viewCache.delete(cacheKey)
  }

  return loadCachedView(cacheKey, () => edgeRequest<HidNotification[]>('notifications-list', {
    query: {
      limit,
      unreadOnly: options.unreadOnly ? '1' : null,
    },
  }), NOTIFICATIONS_CACHE_TTL_MS)
}

export async function markNotificationRead(id: string) {
  await edgeRequest('notifications-mark-read', {
    method: 'POST',
    body: { id },
  })

  invalidateViewCache('notifications:')
}

export async function fetchPatientRecordsView(patientIdentifier?: string, options: { forceRefresh?: boolean } = {}) {
  const cacheKey = `records:${patientIdentifier ?? 'self'}`
  if (options.forceRefresh) {
    viewCache.delete(cacheKey)
  }

  return loadCachedView(cacheKey, async () => {
    const bundle = await edgeRequest<HidPatientRecordsResponse>('patients-records', {
      query: {
        patientIdentifier: patientIdentifier ?? null,
      },
    })

    const patient = toLegacyPatient(bundle.patient)
    const fileGroups = await Promise.all(bundle.records.map(async item => {
      const files = await toLegacyRecordFiles(item.files)
      return [item.record.id, files] as const
    }))

    const recordFiles = Object.fromEntries(fileGroups) as Record<string, MedicalRecordFile[]>
    const records = bundle.records.map(item => toLegacyMedicalRecord(bundle.patient, item, recordFiles[item.record.id] ?? []))

    return {
      patient,
      records,
      recordFiles,
      rawPatient: bundle.patient,
    }
  }, patientIdentifier ? 0 : VIEW_CACHE_TTL_MS)
}

export async function createMedicalRecordWithUploads({
  patientIdentifier,
  title,
  category,
  record,
  notes,
  uploads,
  infoType,
  structuredData,
}: {
  patientIdentifier: string
  title: string
  category: string
  record: string
  notes?: string | null
  uploads?: UploadDraft[]
  infoType?: string
  structuredData?: Record<string, unknown> | null
}) {
  pruneRecentRecordSaves()
  const normalizedNotes = normalizeOptionalText(notes)
  const uploadsFingerprint = (uploads ?? [])
    .map(buildUploadDraftKey)
    .join('|')
  const requestKey = [
    patientIdentifier.trim().toUpperCase(),
    title.trim(),
    category.trim().toLowerCase(),
    record.trim(),
    normalizedNotes ?? '',
    uploadsFingerprint,
    infoType ?? '',
    structuredData ? JSON.stringify(structuredData) : '',
  ].join('::')

  const existing = inflightRecordSaves.get(requestKey)
  if (existing) {
    return existing
  }

  const request = (async () => {
    let saveEntry = recentRecordSaves.get(requestKey)
    if (!saveEntry || saveEntry.expiresAt <= Date.now()) {
      const created = await edgeRequest<RecordCreationResponse>('records-create', {
        method: 'POST',
        body: {
          patientIdentifier,
          title,
          category,
          record,
          notes: normalizedNotes,
          info_type: infoType,
          structured_data: structuredData ?? null,
        },
      })

      saveEntry = {
        expiresAt: Date.now() + RECENT_RECORD_SAVE_TTL_MS,
        result: created,
        uploadedFileKeys: new Set<string>(),
      }
      setBoundedMapEntry(recentRecordSaves, requestKey, saveEntry, MAX_RECENT_RECORD_SAVE_ENTRIES)
    }

    if (uploads && uploads.length > 0) {
      await uploadRecordFiles(saveEntry.result.record_id, uploads, saveEntry.uploadedFileKeys)
    }

    invalidateViewCache('records:')
    invalidateViewCache('history:')
    invalidateViewCache('staff-dashboard:')
    saveEntry.expiresAt = Date.now() + RECENT_RECORD_SAVE_TTL_MS
    setBoundedMapEntry(recentRecordSaves, requestKey, saveEntry, MAX_RECENT_RECORD_SAVE_ENTRIES)
    return saveEntry.result
  })()

  inflightRecordSaves.set(requestKey, request)

  try {
    return await request
  } finally {
    inflightRecordSaves.delete(requestKey)
  }
}

export async function fetchPatientHealthEvents(patientIdentifier?: string, options: { forceRefresh?: boolean } = {}) {
  const cacheKey = `health-events:${patientIdentifier ?? 'self'}`
  if (options.forceRefresh) {
    viewCache.delete(cacheKey)
  }

  return loadCachedView(cacheKey, async () => {
    const response = await edgeRequest<{ data: HidHealthEvent[] }>('health-events', {
      query: {
        patientIdentifier: patientIdentifier ?? null,
      },
    })

    return response.data ?? []
  }, patientIdentifier ? 0 : VIEW_CACHE_TTL_MS)
}

export async function createHealthEvent({
  patientIdentifier,
  title,
  infoCategory,
  recordIds,
}: {
  patientIdentifier: string
  title: string
  infoCategory?: string
  recordIds?: string[]
}) {
  const result = await edgeRequest<{ data: { event_id: string } }>('health-events', {
    method: 'POST',
    body: {
      patientIdentifier,
      title,
      infoCategory,
      recordIds,
    },
  })

  invalidateViewCache('health-events:')
  return result.data
}

export async function addRecordToHealthEvent(healthEventId: string, recordId: string) {
  const result = await edgeRequest<{ data: { ok: boolean } }>('health-event-update', {
    method: 'POST',
    body: { healthEventId, action: 'add_record', recordId },
  })

  invalidateViewCache('health-events:')
  return result.data
}

export async function removeRecordFromHealthEvent(healthEventId: string, recordId: string) {
  const result = await edgeRequest<{ data: { ok: boolean } }>('health-event-update', {
    method: 'POST',
    body: { healthEventId, action: 'remove_record', recordId },
  })

  invalidateViewCache('health-events:')
  return result.data
}

export async function renameHealthEvent(healthEventId: string, title: string) {
  const result = await edgeRequest<{ data: { ok: boolean } }>('health-event-update', {
    method: 'POST',
    body: { healthEventId, action: 'rename', title },
  })

  invalidateViewCache('health-events:')
  return result.data
}

export async function setHealthEventStatus(healthEventId: string, status: HidHealthEventStatus) {
  const result = await edgeRequest<{ data: { ok: boolean } }>('health-event-update', {
    method: 'POST',
    body: { healthEventId, action: 'set_status', status },
  })

  invalidateViewCache('health-events:')
  return result.data
}

export async function uploadRecordFiles(recordId: string, uploads: UploadDraft[], uploadedFileKeys = new Set<string>()) {
  for (const upload of uploads) {
    const uploadKey = buildUploadDraftKey(upload)
    if (uploadedFileKeys.has(uploadKey)) continue

    await retryRecordUpload(async () => {
      const signed = await edgeRequest<SignedUploadResponse>('files-sign-upload', {
        method: 'POST',
        body: {
          recordId,
          fileName: upload.file_name,
        },
      })

      const blob = await dataUrlToBlob(upload.file_data_url)
      const uploadResponse = await fetchWithManualTimeout(signed.signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': upload.file_type ?? 'application/octet-stream',
        },
        body: blob,
      }, RECORD_UPLOAD_TIMEOUT_MS)

      if (!uploadResponse.ok) {
        throw new HidApiError(uploadResponse.status, `Unable to upload ${upload.file_name}.`)
      }

      await edgeRequest('files-register-upload', {
        method: 'POST',
        body: {
          recordId,
          originalFileName: upload.file_name,
          uploadToken: signed.uploadToken,
          mimeType: upload.file_type,
          sizeBytes: blob.size,
        },
      })
    })

    uploadedFileKeys.add(uploadKey)
  }
}

export async function fetchPatientHistory(hidCode: string, options: { forceRefresh?: boolean } = {}): Promise<HistoryView> {
  const cacheKey = `history:${hidCode}`
  if (options.forceRefresh) {
    viewCache.delete(cacheKey)
  }

  return loadCachedView(cacheKey, async () => {
    const history = await edgeRequest<HidPatientHistoryResponse>('patient-history-list')

    return {
      activeGrants: history.active_grants.map(item => toLegacyAccessRequest(hidCode, item)),
      pendingInvites: history.pending_invites ?? [],
      logs: history.events.map(item => toLegacyAccessLog(hidCode, item)),
    }
  })
}

export async function revokeAccessGrant(grantId: string, reason?: string) {
  const response = await edgeRequest<{ grant_id: string; status: string }>('access-grant-revoke', {
    method: 'POST',
    body: {
      grantId,
      reason: normalizeOptionalText(reason),
    },
  })
  invalidateViewCache('history:')
  invalidateViewCache('staff-dashboard:')
  return response
}

export async function searchStaffForShare(query: string): Promise<HidStaffSearchResult[]> {
  const response = await edgeRequest<{ data: HidStaffSearchResult[] }>('staff-search', {
    query: { query },
  })
  return response.data ?? []
}

export async function createShare({
  staffAccountId,
  permissionTier,
  durationPreset,
  reason,
}: {
  staffAccountId: string
  permissionTier: HidSharePermissionTier
  durationPreset: HidShareDurationPreset
  reason?: string
}) {
  const response = await edgeRequest<{ data: { grant_id: string } }>('share-create', {
    method: 'POST',
    body: {
      staffAccountId,
      permissionTier,
      durationPreset,
      reason: normalizeOptionalText(reason),
    },
  })
  invalidateViewCache('history:')
  return response.data
}

export async function createShareInvite({
  email,
  fullName,
  permissionTier,
  durationPreset,
  reason,
}: {
  email: string
  fullName?: string
  permissionTier: HidSharePermissionTier
  durationPreset: HidShareDurationPreset
  reason?: string
}) {
  const response = await edgeRequest<{ data: { mode: 'connected' | 'invited'; grant_id?: string; invite_id?: string } }>('share-invite-create', {
    method: 'POST',
    body: {
      email,
      fullName: normalizeOptionalText(fullName),
      permissionTier,
      durationPreset,
      reason: normalizeOptionalText(reason),
    },
  })
  invalidateViewCache('history:')
  return response.data
}

export async function cancelShareInvite(inviteId: string) {
  const response = await edgeRequest<{ data: { invite_id: string } }>('share-invite-cancel', {
    method: 'POST',
    body: { inviteId },
  })
  invalidateViewCache('history:')
  return response.data
}

export async function patientSignUpWithPassword(params: PendingPatientSignup & { password: string; captchaToken?: string | null }): Promise<{
  challengeId: string
  deliveryChannels: Array<'email'>
  expiresAt: string
  maskedEmail: string | null
  profile: Awaited<ReturnType<typeof ensurePatientProfileRegistered>> | null
  requiresVerification: boolean
}> {
  const normalizedEmail = params.email?.trim().toLowerCase() ?? ''
  const normalizedPhone = normalizeOptionalText(normalizePhone(params.phone ?? ''))
  const pendingData: PendingPatientSignup = {
    email: normalizeOptionalText(normalizedEmail),
    firstName: params.firstName.trim(),
    lastName: params.lastName.trim(),
    hospitalCurrentlyUsing: normalizeOptionalText(params.hospitalCurrentlyUsing),
    gender: normalizeOptionalText(params.gender),
    dob: normalizeOptionalText(params.dob),
    phone: normalizedPhone,
  }

  await assertSignupAvailability({
    accountType: 'patient',
    email: normalizedEmail,
    phone: normalizedPhone,
  })
  await clearConflictingAuthSession(normalizedEmail)

  const verification = await startSignupVerification({
    accountType: 'patient',
    captchaToken: params.captchaToken,
    email: normalizedEmail,
    patient: pendingData,
  })

  return {
    ...verification,
    requiresVerification: true,
    profile: null,
  }
}

export async function verifyPatientSignupOtp(challengeId: string, email: string, password: string, code: string) {
  let response: { session: HidSessionPayload } | null = null

  try {
    response = await edgeRequest<{ session: HidSessionPayload }>('signup-verify', {
      method: 'POST',
      requireAuth: false,
      body: {
        accountType: 'patient',
        challengeId,
        code,
        email,
        password,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (!message.includes('verification session has already been used')) {
      throw error
    }

    const { error: signInError } = await identityClient.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })

    if (signInError) {
      throw error
    }

    return ensurePatientProfileRegistered()
  }

  const { error } = await identityClient.auth.setSession({
    access_token: response.session.access_token,
    refresh_token: response.session.refresh_token,
  })

  if (error) {
    throw new HidApiError(401, isBannedAuthMessage(error.message) ? BANNED_ACCOUNT_MESSAGE : error.message, error)
  }

  return ensurePatientProfileRegistered()
}

export async function patientSignIn(identifier: string, password: string, captchaToken?: string | null) {
  const trimmedIdentifier = identifier.trim()
  if (!trimmedIdentifier) {
    throw new HidApiError(400, 'Enter your HID code or email to sign in.')
  }

  const response = await edgeRequest<{ session: HidSessionPayload }>('patient-login', {
    method: 'POST',
    requireAuth: false,
    body: {
      identifier: looksLikeEmailIdentifier(trimmedIdentifier) ? trimmedIdentifier.toLowerCase() : trimmedIdentifier.toUpperCase(),
      password,
      turnstileToken: captchaToken ?? null,
    },
  })

  const { error } = await identityClient.auth.setSession({
    access_token: response.session.access_token,
    refresh_token: response.session.refresh_token,
  })

  if (error) {
    throw new HidApiError(
      401,
      isBannedAuthMessage(error.message)
        ? BANNED_ACCOUNT_MESSAGE
        : error.message,
      error
    )
  }

  return ensurePatientProfileRegistered()
}

export async function startPatientPasswordReset(identifier: string, captchaToken?: string | null) {
  const normalizedIdentifier = identifier.trim()
  if (!normalizedIdentifier) {
    throw new HidApiError(400, 'Enter your HID code or email address.')
  }

  const { data, error } = await identityClient.auth.startRecoveryOtp({
    identifier: looksLikeEmailIdentifier(normalizedIdentifier)
      ? normalizedIdentifier.toLowerCase()
      : normalizedIdentifier.toUpperCase(),
    purpose: 'PASSWORD_RESET',
    turnstileAction: 'patient-reset-start',
    turnstileToken: captchaToken ?? undefined,
  })
  if (error) throw new HidApiError(400, error.message, error)
  if (!data) throw new HidApiError(503, 'Verification codes are unavailable right now.')
  return {
    challengeId: data.challengeId,
    deliveryChannels: data.deliveryChannels,
    expiresAt: new Date(Date.now() + data.expiresInSeconds * 1000).toISOString(),
    maskedEmail: null,
  } satisfies PasswordResetStartResponse
}

export async function verifyPatientPasswordResetCode(challengeId: string, code: string) {
  return verifyEmailOtp(challengeId, code) satisfies Promise<PasswordResetVerifyResponse>
}

export async function completePatientPasswordReset(challengeId: string, verificationToken: string, password: string) {
  await completeEmailOtp(challengeId, verificationToken, password)
  return { challengeId, status: 'completed' }
}

export async function updateCurrentUserPassword(password: string) {
  const { error } = await identityClient.auth.updateUser({ password })
  if (error) {
    throw new HidApiError(400, error.message, error)
  }
}

export async function startAccountDeletion() {
  return edgeRequest<AccountDeletionStartResponse>('account-delete-start', {
    method: 'POST',
  })
}

export async function verifyAccountDeletionCode(challengeId: string, code: string) {
  return edgeRequest<AccountDeletionVerifyResponse>('account-delete-verify', {
    method: 'POST',
    body: {
      challengeId,
      code,
    },
  })
}

export async function deleteMyAccount(challengeId: string, verificationToken: string) {
  await edgeRequest<{ deleted: true }>('delete-my-account', {
    method: 'POST',
    body: {
      challengeId,
      verificationToken,
    },
  })

  await resetAuthState()
}

export async function fetchMyStaffAccount() {
  const session = await getSafeSession()
  const userId = session?.user.id
  if (!userId) return null

  return loadCachedView(`staff:${userId}`, async () => {
    const response = await edgeRequest<{ data?: HidStaffAccount | null } | HidStaffAccount | null>('staff-account-me')
    const staffAccount = response && typeof response === 'object' && 'data' in response
      ? response.data ?? null
      : response as HidStaffAccount | null
    if (staffAccount?.deleted_at) {
      await safeSignOut().catch(() => undefined)
      clearAllPortalSessions()
      throw new HidApiError(403, 'This account has been deleted and is no longer available.')
    }

    if (staffAccount?.active === false) {
      await safeSignOut().catch(() => undefined)
      clearAllPortalSessions()
      throw new HidApiError(403, 'This account is locked right now. Contact support if you need help.')
    }

    return staffAccount
  })
}

export async function fetchCurrentSecurityProfile(): Promise<UserSecurityProfile | null> {
  const user = await getSafeUser()
  if (!user) return null
  return edgeRequest<UserSecurityProfile>('security-profile')
}

async function fetchMyStaffAccountWithRetry(attempts = 5, delayMs = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const staffAccount = await fetchMyStaffAccount()
    if (staffAccount) return staffAccount

    if (attempt < attempts - 1) {
      invalidateViewCache('staff:')
      await delay(delayMs * (attempt + 1))
    }
  }

  return null
}

export async function ensureStaffAccountReady(override?: PendingStaffOnboarding) {
  const existing = await fetchMyStaffAccountWithRetry(2, 120)
  if (existing) return existing

  const user = await getSafeUser()
  if (!user) {
    throw new HidApiError(401, 'Please sign in to continue.')
  }

  const pendingData = override ?? (
    isPendingStaffOnboarding(user.user_metadata.pending_staff_onboarding)
      ? user.user_metadata.pending_staff_onboarding
      : null
  )

  if (!pendingData) {
    throw new HidApiError(400, 'Your hospital account setup is incomplete. Complete onboarding again.')
  }

  await edgeRequest('staff-complete-onboarding', {
    method: 'POST',
    body: {
      fullName: pendingData.fullName,
      hospitalName: normalizeOptionalText(pendingData.hospitalName),
      licenseNumber: normalizeOptionalText(pendingData.licenseNumber),
      onboardingType: normalizeOptionalText(pendingData.onboardingType),
      phone: normalizeOptionalText(pendingData.phone),
      country: normalizeOptionalText(pendingData.country),
      state: normalizeOptionalText(pendingData.state),
    },
  })
  await clearPendingMetadata('pending_staff_onboarding')
  invalidateViewCache('staff:')

  const created = await fetchMyStaffAccountWithRetry()
  if (!created) {
    throw new HidApiError(500, 'Your hospital account is still finishing setup. Sign in again in a moment.')
  }

  return created
}

export async function providerActivateInvite(params: PendingStaffOnboarding & { email: string; password: string; captchaToken?: string | null }) {
  await assertSignupAvailability({
    accountType: 'hospital',
    email: params.email,
  })
  await clearConflictingAuthSession(params.email)

  const pendingData: PendingStaffOnboarding = {
    fullName: params.fullName.trim(),
    licenseNumber: normalizeOptionalText(params.licenseNumber),
    onboardingType: 'staff_invite',
  }

  const { data, error } = await identityClient.auth.signUp({
    email: params.email.trim().toLowerCase(),
    password: params.password,
    options: {
      captchaToken: params.captchaToken ?? undefined,
      data: {
        full_name: pendingData.fullName,
        pending_staff_onboarding: pendingData,
        requested_role: 'clinician',
      },
    },
  })

  if (error) {
    throw new HidApiError(400, error.message, error)
  }

  await assertNoSilentSignupConflict({
    accountType: 'hospital',
    email: params.email,
    user: data.user,
  })

  if (data.session) {
    const staffAccount = await ensureStaffAccountReady(pendingData)
    return {
      requiresVerification: false,
      staffAccount,
    }
  }

  return {
    requiresVerification: true,
    staffAccount: null,
  }
}

export async function providerSignUp(params: {
  hospitalName: string
  email: string
  phone?: string
  state: string
  country: string
  password: string
  captchaToken?: string | null
}): Promise<{
  challengeId: string
  deliveryChannels: Array<'email'>
  expiresAt: string
  maskedEmail: string | null
  requiresVerification: boolean
  staffAccount: Awaited<ReturnType<typeof ensureStaffAccountReady>> | null
}> {
  const hospitalName = params.hospitalName.trim()
  const normalizedEmail = params.email.trim().toLowerCase()
  await assertSignupAvailability({
    accountType: 'hospital',
    email: normalizedEmail,
  })
  await clearConflictingAuthSession(normalizedEmail)

  const pendingData: PendingStaffOnboarding = {
    country: normalizeOptionalText(params.country),
    fullName: `${hospitalName} Admin`,
    hospitalName,
    onboardingType: 'hospital_signup',
    phone: normalizeOptionalText(normalizePhone(params.phone ?? '')),
    state: normalizeOptionalText(params.state),
  }

  const verification = await startSignupVerification({
    accountType: 'hospital',
    captchaToken: params.captchaToken,
    email: normalizedEmail,
    staff: pendingData,
  })

  return {
    ...verification,
    requiresVerification: true,
    staffAccount: null,
  }
}

export async function verifyStaffSignupOtp(challengeId: string, email: string, password: string, code: string) {
  await clearConflictingAuthSession(email)
  let response: { session: HidSessionPayload } | null = null

  try {
    response = await edgeRequest<{ session: HidSessionPayload }>('signup-verify', {
      method: 'POST',
      requireAuth: false,
      body: {
        accountType: 'hospital',
        challengeId,
        code,
        email,
        password,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (!message.includes('verification session has already been used')) {
      throw error
    }

    const { error: signInError } = await identityClient.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })

    if (signInError) {
      throw error
    }

    await assertHospitalAccountCompatibleEmail()
    return ensureStaffAccountReady()
  }

  const { error } = await identityClient.auth.setSession({
    access_token: response.session.access_token,
    refresh_token: response.session.refresh_token,
  })

  if (error) {
    throw new HidApiError(401, isBannedAuthMessage(error.message) ? BANNED_ACCOUNT_MESSAGE : error.message, error)
  }

  await assertHospitalAccountCompatibleEmail()
  return ensureStaffAccountReady()
}

export async function providerSignIn(hospitalName: string, email: string, password: string, captchaToken?: string | null) {
  await clearConflictingAuthSession(email)

  const response = await edgeRequest<{ session: HidSessionPayload }>('staff-login', {
    method: 'POST',
    requireAuth: false,
    body: {
      email: email.trim().toLowerCase(),
      password,
      turnstileToken: captchaToken ?? null,
    },
  })

  const { error } = await identityClient.auth.setSession({
    access_token: response.session.access_token,
    refresh_token: response.session.refresh_token,
  })

  if (error) {
    throw new HidApiError(
      401,
      isBannedAuthMessage(error.message) ? BANNED_ACCOUNT_MESSAGE : error.message,
      error
    )
  }

  await assertHospitalAccountCompatibleEmail()
  const staffAccount = await ensureStaffAccountReady()
  const expectedHospital = normalizeComparableText(hospitalName)
  const actualHospital = normalizeComparableText(staffAccount.hospital_name)

  if (!expectedHospital || !actualHospital || expectedHospital !== actualHospital) {
    await safeSignOut()
    throw new HidApiError(401, 'Invalid hospital credentials.')
  }

  return staffAccount
}

export async function sendStaffPasswordReset(email: string, redirectTo: string, captchaToken?: string | null) {
  void redirectTo
  return requestEmailOtp(email, 'staff-reset', captchaToken)
}

export async function verifyStaffPasswordResetOtp(challengeId: string, code: string) {
  return verifyEmailOtp(challengeId, code)
}

export async function completeStaffPasswordResetOtp(challengeId: string, verificationToken: string, password: string) {
  return completeEmailOtp(challengeId, verificationToken, password)
}

export async function startAdminPasswordResetOtp(email: string, captchaToken?: string | null) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!looksLikeEmailIdentifier(normalizedEmail)) {
    throw new HidApiError(400, 'Enter a valid admin email address first.')
  }

  await clearConflictingAuthSession(normalizedEmail)
  return requestEmailOtp(normalizedEmail, 'admin-reset', captchaToken)
}

export async function verifyAdminPasswordResetOtp(challengeId: string, code: string) {
  return verifyEmailOtp(challengeId, code)
}

export async function completeAdminPasswordResetOtp(challengeId: string, verificationToken: string, password: string) {
  return completeEmailOtp(challengeId, verificationToken, password)
}

export async function fetchStaffDashboard(options: { forceRefresh?: boolean } = {}) {
  const session = await getSafeSession()
  const authUserId = session?.user?.id ?? null
  if (!authUserId) {
    throw new HidApiError(401, 'Please sign in to continue.')
  }

  if (options.forceRefresh) {
    viewCache.delete(`staff-dashboard:${authUserId}`)
  }

  return loadCachedView(`staff-dashboard:${authUserId}`, async () => edgeRequest<HidStaffDashboardResponse>('staff-dashboard'))
}

export async function accessPatientWithPin(patientIdentifier: string, accessPin: string, durationMinutes = 60, staffDisplayName?: string | null) {
  const response = await edgeRequest<{ request_id: string | null; grant_id: string; patient_id: string }>('access-request-create', {
    method: 'POST',
    body: {
      patientIdentifier,
      accessPin,
      durationMinutes,
      staffDisplayName: normalizeOptionalText(staffDisplayName),
    },
  })
  invalidateViewCache('history:')
  invalidateViewCache('records:')
  invalidateViewCache('staff-dashboard:')
  return response
}

export async function breakGlassAccess(patientIdentifier: string, reason: string, durationMinutes = 30, staffDisplayName?: string | null) {
  const response = await edgeRequest<{ request_id: string; grant_id: string }>('break-glass', {
    method: 'POST',
    body: {
      patientIdentifier,
      reason,
      durationMinutes,
      staffDisplayName: normalizeOptionalText(staffDisplayName),
    },
  })
  invalidateViewCache('history:')
  invalidateViewCache('records:')
  invalidateViewCache('staff-dashboard:')
  return response
}

export async function closeMyAccessGrant(grantId: string, reason?: string) {
  const response = await edgeRequest<{ grant_id: string; status: string }>('access-grant-close', {
    method: 'POST',
    body: {
      grantId,
      reason: normalizeOptionalText(reason),
    },
  })
  invalidateViewCache('history:')
  invalidateViewCache('records:')
  invalidateViewCache('staff-dashboard:')
  return response
}

export async function syncSessionFromRecovery(session: IdentitySession | null) {
  if (!session) return
  const { error } = await identityClient.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })

  if (error) {
    throw new HidApiError(400, error.message, error)
  }
}
