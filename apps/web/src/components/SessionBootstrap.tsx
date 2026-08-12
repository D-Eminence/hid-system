import React, { useEffect } from 'react'
import { clearAllPortalSessions, getStaffSession, markPortalSessionsHydrated, setPatientSession, setStaffSession } from '../lib/auth'
import { prefetchDoctorPortalCache, seedPatientProfileCache, warmPatientExperience } from '../lib/experienceWarmup'
import { fetchMyPatient, fetchMyStaffAccount } from '../lib/hidApi'
import { clearObservabilityIdentity, identifyObservabilityUser } from '../lib/observabilityBridge'
import { getSafeSession, safeSignOut, identityClient } from '../lib/identityClient'

const HYDRATE_COOLDOWN_MS = 250
const BACKGROUND_WARMUP_DELAY_MS = 1200
let inflightHydration: Promise<void> | null = null
let lastHydratedAt = 0

function isAuthFailure(reason: unknown) {
  if (!(reason instanceof Error)) return false
  const lower = reason.message.toLowerCase()
  return (
    lower.includes('please sign in') ||
    lower.includes('jwt') ||
    lower.includes('refresh token') ||
    lower.includes('token has expired') ||
    lower.includes('token is expired') ||
    lower.includes('invalid token')
  )
}

function isConstrainedNetwork() {
  if (typeof navigator === 'undefined') return false
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string }
  }).connection

  if (!connection) return false
  if (connection.saveData) return true
  return typeof connection.effectiveType === 'string' && connection.effectiveType.includes('2g')
}

function scheduleBackgroundWarmup(task: () => void) {
  if (typeof window === 'undefined' || isConstrainedNetwork()) return

  const idleWindow = window as Window & {
    requestIdleCallback?: (task: () => void, options?: { timeout: number }) => number
  }

  window.setTimeout(() => {
    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleWindow.requestIdleCallback(task, { timeout: 1500 })
      return
    }
    task()
  }, BACKGROUND_WARMUP_DELAY_MS)
}

async function hydratePortalSession() {
  const now = Date.now()
  if (inflightHydration) {
    return inflightHydration
  }
  if (now - lastHydratedAt < HYDRATE_COOLDOWN_MS) {
    return
  }

  const hydration = (async () => {
    const session = await getSafeSession()

    if (!session) {
      clearAllPortalSessions()
      clearObservabilityIdentity()
      return
    }

    const pathname = typeof window !== 'undefined' ? window.location.pathname : '/'
    const requestedRole = `${session.user.user_metadata.requested_role ?? ''}`.trim().toLowerCase()
    const shouldLoadPatient =
      pathname.startsWith('/patient') ||
      requestedRole === 'patient' ||
      (!pathname.startsWith('/hospital') && !pathname.startsWith('/doctor') && !pathname.startsWith('/eminence') && !pathname.startsWith('/migrate'))
    const shouldLoadStaff =
      pathname.startsWith('/hospital') ||
      pathname.startsWith('/doctor') ||
      pathname.startsWith('/migrate') ||
      requestedRole === 'clinician' ||
      requestedRole === 'org_admin'

    const [patient, staff] = await Promise.allSettled([
      shouldLoadPatient ? fetchMyPatient() : Promise.resolve(null),
      shouldLoadStaff ? fetchMyStaffAccount() : Promise.resolve(null),
    ])

    if (patient.status === 'fulfilled' && patient.value) {
      const patientValue = patient.value
      const nextPatientSession = {
        hidCode: patientValue.hid_code,
        phone: patientValue.phone ?? '',
        fullName: patientValue.full_name,
      }
      setPatientSession(nextPatientSession)
      seedPatientProfileCache(patientValue)
      scheduleBackgroundWarmup(() => {
        warmPatientExperience(nextPatientSession, patientValue)
      })
      identifyObservabilityUser({
        appRole: 'patient',
        id: session.user.id,
      })
    }

    if (staff.status === 'fulfilled' && staff.value) {
      const staffValue = staff.value
      const existingStaffSession = getStaffSession()
      const nextStaffSession = {
        id: staffValue.id,
        fullName: staffValue.full_name,
        hospitalName: staffValue.hospital_name ?? existingStaffSession?.hospitalName ?? null,
        email: staffValue.email,
        role: staffValue.role,
      }
      setStaffSession(nextStaffSession)
      scheduleBackgroundWarmup(() => {
        void prefetchDoctorPortalCache(nextStaffSession)
      })
      identifyObservabilityUser({
        appRole: 'clinician',
        id: session.user.id,
        staffRole: staffValue.role,
      })
    }

    if (patient.status !== 'fulfilled' && (staff.status !== 'fulfilled' || !staff.value)) {
      clearObservabilityIdentity()
      const patientReason = patient.status === 'rejected' ? patient.reason : null
      const staffReason = staff.status === 'rejected' ? staff.reason : null

      if (isAuthFailure(patientReason) || isAuthFailure(staffReason)) {
        await safeSignOut().catch(() => {})
        clearAllPortalSessions()
      }
    }
  })().finally(() => {
    markPortalSessionsHydrated()
  })

  inflightHydration = hydration.finally(() => {
    inflightHydration = null
    lastHydratedAt = Date.now()
  })

  return inflightHydration
}

export function SessionBootstrap() {
  useEffect(() => {
    // Session restoration is background UX. A temporarily unavailable Identity
    // API must not become an unhandled browser rejection or clear an existing
    // in-memory session before an authoritative response is available.
    void hydratePortalSession().catch(() => undefined)

    const { data } = identityClient.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') {
        clearAllPortalSessions()
        clearObservabilityIdentity()
        return
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        void hydratePortalSession().catch(() => undefined)
      }
    })

    return () => {
      data.subscription.unsubscribe()
    }
  }, [])

  return null
}
