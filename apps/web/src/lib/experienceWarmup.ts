import type { PatientSession, StaffSession } from './auth'
import {
  fetchMyPatient,
  fetchPatientHistory,
  fetchPatientRecordsView,
  fetchStaffDashboard,
  listNotifications,
} from './hidApi'
import { readPageCache, writePageCache } from './pageCache'
import type { Notification, Patient } from '../types/database'
import type { HidStaffDashboardResponse } from '../types/hid'

type PatientRecordsSnapshot = Awaited<ReturnType<typeof fetchPatientRecordsView>>
type PatientHistorySnapshot = Awaited<ReturnType<typeof fetchPatientHistory>>
type PatientNotificationsSnapshot = {
  notifications: Notification[]
  patient: Patient | null
}

const PATIENT_PROFILE_TTL_MS = 120_000
const PAGE_TTL_MS = 90_000
const DOCTOR_DASHBOARD_TTL_MS = 45_000

const inflightPrefetches = new Map<string, Promise<void>>()

function patientProfileKey(hidCode: string) {
  return `patient-profile:${hidCode.toUpperCase()}`
}

function patientRecordsKey(hidCode: string) {
  return `patient-records:self:${hidCode.toUpperCase()}`
}

function patientHistoryKey(hidCode: string) {
  return `patient-history:${hidCode.toUpperCase()}`
}

function patientNotificationsKey(hidCode: string) {
  return `patient-notifications:${hidCode.toUpperCase()}`
}

function doctorDashboardKey(sessionId: string) {
  return `doctor-dashboard:${sessionId}`
}

function doctorPatientRecordsKey(sessionId: string, hidCode: string) {
  return `doctor-patient-records:${sessionId}:${hidCode.toUpperCase()}`
}

function runPrefetchTask(key: string, task: () => Promise<void>) {
  const existing = inflightPrefetches.get(key)
  if (existing) return existing

  const request = task()
    .catch(() => undefined)
    .finally(() => {
      inflightPrefetches.delete(key)
    })

  inflightPrefetches.set(key, request)
  return request
}

export function readPatientProfileSnapshot(hidCode: string) {
  return readPageCache<Patient>(patientProfileKey(hidCode))
}

export function readPatientRecordsSnapshot(hidCode: string) {
  return readPageCache<PatientRecordsSnapshot>(patientRecordsKey(hidCode))
}

export function readPatientHistorySnapshot(hidCode: string) {
  return readPageCache<PatientHistorySnapshot>(patientHistoryKey(hidCode))
}

export function readPatientNotificationsSnapshot(hidCode: string) {
  return readPageCache<PatientNotificationsSnapshot>(patientNotificationsKey(hidCode))
}

export function readDoctorDashboardSnapshot(sessionId: string) {
  return readPageCache<HidStaffDashboardResponse>(doctorDashboardKey(sessionId))
}

export function readDoctorPatientRecordsSnapshot(sessionId: string, hidCode: string) {
  return readPageCache<PatientRecordsSnapshot>(doctorPatientRecordsKey(sessionId, hidCode))
}

export function seedPatientProfileCache(patient: Patient) {
  writePageCache(patientProfileKey(patient.hid_code), patient, PATIENT_PROFILE_TTL_MS)
}

export function seedPatientRecordsCache(hidCode: string, snapshot: PatientRecordsSnapshot) {
  writePageCache(patientRecordsKey(hidCode), snapshot, PAGE_TTL_MS)
}

export function seedPatientHistoryCache(hidCode: string, snapshot: PatientHistorySnapshot) {
  writePageCache(patientHistoryKey(hidCode), snapshot, PAGE_TTL_MS)
}

export function seedPatientNotificationsCache(hidCode: string, snapshot: PatientNotificationsSnapshot) {
  writePageCache(patientNotificationsKey(hidCode), snapshot, PAGE_TTL_MS)
}

export function seedDoctorDashboardCache(sessionId: string, snapshot: HidStaffDashboardResponse) {
  writePageCache(doctorDashboardKey(sessionId), snapshot, DOCTOR_DASHBOARD_TTL_MS)
}

export function seedDoctorPatientRecordsCache(sessionId: string, hidCode: string, snapshot: PatientRecordsSnapshot) {
  writePageCache(doctorPatientRecordsKey(sessionId, hidCode), snapshot, PAGE_TTL_MS)
}

async function prefetchPatientRecordsCache(hidCode: string) {
  const normalizedHidCode = hidCode.trim().toUpperCase()
  return runPrefetchTask(`patient-records-only:${normalizedHidCode}`, async () => {
    const recordsView = await fetchPatientRecordsView(normalizedHidCode)
    seedPatientRecordsCache(normalizedHidCode, recordsView)
  })
}

async function prefetchPatientHistoryOnly(hidCode: string) {
  const normalizedHidCode = hidCode.trim().toUpperCase()
  return runPrefetchTask(`patient-history-only:${normalizedHidCode}`, async () => {
    const history = await fetchPatientHistory(normalizedHidCode)
    seedPatientHistoryCache(normalizedHidCode, history)
  })
}

async function prefetchPatientNotificationsOnly(hidCode: string, knownPatient?: Patient | null) {
  const normalizedHidCode = hidCode.trim().toUpperCase()
  return runPrefetchTask(`patient-notifications-only:${normalizedHidCode}`, async () => {
    const patient = knownPatient ?? readPatientProfileSnapshot(normalizedHidCode) ?? await fetchMyPatient()
    const notifications = await listNotifications(normalizedHidCode)
    seedPatientNotificationsCache(normalizedHidCode, {
      patient,
      notifications,
    })
  })
}

export async function prefetchDoctorPortalCache(session: StaffSession, knownDashboard?: HidStaffDashboardResponse | null) {
  return runPrefetchTask(`doctor-portal:${session.id}`, async () => {
    const dashboard = knownDashboard ?? await fetchStaffDashboard()
    seedDoctorDashboardCache(session.id, dashboard)
  })
}

export async function prefetchDoctorPatientRecordsCache({
  sessionId,
  hidCode,
}: {
  sessionId: string
  hidCode: string
}) {
  const normalizedHidCode = hidCode.trim().toUpperCase()
  return runPrefetchTask(`doctor-patient:${sessionId}:${normalizedHidCode}`, async () => {
    const recordsView = await fetchPatientRecordsView(normalizedHidCode)
    seedDoctorPatientRecordsCache(sessionId, normalizedHidCode, recordsView)
  })
}

export function warmPatientExperience(session: PatientSession, patient: Patient) {
  seedPatientProfileCache(patient)
  void Promise.allSettled([
    prefetchPatientRecordsCache(session.hidCode),
    prefetchPatientHistoryOnly(session.hidCode),
  ])
}

export function prefetchPatientRouteData(path: string, hidCode: string) {
  const normalizedPath = path.trim().toLowerCase()
  const normalizedHidCode = hidCode.trim().toUpperCase()

  if (!normalizedPath || !normalizedHidCode) return

  if (normalizedPath.startsWith('/patient/records')) {
    void prefetchPatientRecordsCache(normalizedHidCode)
    return
  }

  if (normalizedPath.startsWith('/patient/history')) {
    void prefetchPatientHistoryOnly(normalizedHidCode)
    return
  }

  if (normalizedPath.startsWith('/patient/notifications')) {
    void prefetchPatientNotificationsOnly(normalizedHidCode)
    return
  }

  if (normalizedPath.startsWith('/patient/profile')) {
    void prefetchPatientRecordsCache(normalizedHidCode)
  }
}

export function prefetchHospitalRouteData(path: string, session: StaffSession) {
  const normalizedPath = path.trim().toLowerCase()
  if (!normalizedPath) return

  if (
    normalizedPath.startsWith('/hospital/dashboard') ||
    normalizedPath.startsWith('/hospital/access') ||
    normalizedPath.startsWith('/hospital/history') ||
    normalizedPath.startsWith('/hospital/emergency')
  ) {
    void prefetchDoctorPortalCache(session)
  }

  const patientRecordMatch = normalizedPath.match(/^\/hospital\/patient-records\/(.+)$/)
  if (patientRecordMatch?.[1]) {
    void prefetchDoctorPatientRecordsCache({
      sessionId: session.id,
      hidCode: decodeURIComponent(patientRecordMatch[1]),
    })
  }
}
