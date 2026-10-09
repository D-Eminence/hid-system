export const HOSPITAL_ROOT_PATH = '/hospital'
export const HOSPITAL_AUTH_PATH = '/hospital/auth'
export const HOSPITAL_DASHBOARD_PATH = '/hospital/dashboard'
export const HOSPITAL_ACCESS_PATH = '/hospital/access'
export const HOSPITAL_HISTORY_PATH = '/hospital/history'
export const HOSPITAL_EMERGENCY_PATH = '/hospital/emergency'

export function getHospitalPatientRecordsPath(hidCode: string) {
  return `/hospital/patient-records/${hidCode.trim().toUpperCase()}`
}

export const hospitalNavItems = [
  { path: HOSPITAL_DASHBOARD_PATH, label: 'Dashboard' },
  { path: HOSPITAL_HISTORY_PATH, label: 'History' },
  { path: HOSPITAL_EMERGENCY_PATH, label: 'Emergency' },
]

export function getHospitalPatientNavItems(hidCode: string) {
  return [...hospitalNavItems, { path: getHospitalPatientRecordsPath(hidCode), label: 'Patient Records' }]
}
