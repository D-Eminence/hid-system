import { useSyncExternalStore } from 'react'
import { safeSignOut } from './identityClient'
import { resetClientCaches } from './cacheReset'

export interface PatientSession {
  hidCode: string
  phone: string
  fullName: string
}

export interface StaffSession {
  id: string
  fullName: string
  hospitalName?: string | null
  email: string
  role: 'doctor' | 'nurse' | 'lab' | 'pharmacist' | 'admin'
}

export interface PortalSessionSnapshot {
  patient: PatientSession | null
  staff: StaffSession | null
  hydrated: boolean
}

let snapshot: PortalSessionSnapshot = {
  patient: null,
  staff: null,
  hydrated: false,
}
const listeners = new Set<() => void>()

function updateSnapshot(next: PortalSessionSnapshot) {
  snapshot = next
  listeners.forEach(listener => listener())
}

export function subscribePortalSessions(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPortalSessionSnapshot() {
  return snapshot
}

export function usePortalSession() {
  return useSyncExternalStore(subscribePortalSessions, getPortalSessionSnapshot, getPortalSessionSnapshot)
}

export function getPatientSession(): PatientSession | null {
  return snapshot.patient
}

export function setPatientSession(session: PatientSession) {
  updateSnapshot({ ...snapshot, patient: session, hydrated: true })
}

export function clearPatientSession() {
  updateSnapshot({ ...snapshot, patient: null })
}

export function getStaffSession(): StaffSession | null {
  return snapshot.staff
}

export function setStaffSession(session: StaffSession) {
  updateSnapshot({ ...snapshot, staff: session, hydrated: true })
}

export function clearStaffSession() {
  updateSnapshot({ ...snapshot, staff: null })
}

export function markPortalSessionsHydrated() {
  if (!snapshot.hydrated) updateSnapshot({ ...snapshot, hydrated: true })
}

export function clearAllPortalSessions() {
  clearPatientSession()
  clearStaffSession()
  resetClientCaches()
}

export async function signOutAndClearSessions() {
  await safeSignOut()
  clearAllPortalSessions()
}
