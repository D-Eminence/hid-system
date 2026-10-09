import { canonicalRequest } from './identityClient'

export interface RegistrationCase {
  caseId: string
  status: 'pending_new_identity_approval' | 'review_required' | 'resolved_existing_identity' | 'linked_existing' | 'approved_new_identity' | 'rejected' | 'cancelled'
  version: number
  candidateCount: number
  candidates?: Array<{ patientId: string; fullName: string; dateOfBirth: string | null }>
  patient?: { patientId: string; hid: string }
}
export interface RegistrationInput { nin: string; firstName: string; lastName: string; dateOfBirth: string }
export interface RegistrationCapabilities {
  nin: { enabled: boolean; state: 'deferred' | 'unavailable' | 'test-only' }
  newPatientRegistrationRequiresNin: boolean
}
function headers(facilityId: string, key?: string) {
  return { 'X-Facility-Id': facilityId, ...(key ? { 'Idempotency-Key': key } : {}) }
}
export const patientRegistrationApi = {
  capabilities(facilityId: string) {
    return canonicalRequest<RegistrationCapabilities>('/api/v1/identity/registration-capabilities', { headers: headers(facilityId) })
  },
  resolve(facilityId: string, input: RegistrationInput, key: string) {
    return canonicalRequest<RegistrationCase>('/api/v1/identity/nin/resolve', {
      method: 'POST', headers: headers(facilityId, key), body: JSON.stringify({ ...input, purpose: 'healthcare-operations' }),
    })
  },
  read(facilityId: string, caseId: string) {
    return canonicalRequest<RegistrationCase>(`/api/v1/identity/registration-cases/${encodeURIComponent(caseId)}`, { headers: headers(facilityId) })
  },
  review(facilityId: string, registration: RegistrationCase, reason: string, patientId: string | null, key: string) {
    const action = patientId ? 'link-existing' : 'approve-new'
    return canonicalRequest<RegistrationCase>(`/api/v1/identity/registration-cases/${encodeURIComponent(registration.caseId)}/${action}`, {
      method: 'POST', headers: headers(facilityId, key),
      body: JSON.stringify({ expectedVersion: registration.version, reason, purpose: 'healthcare-operations', ...(patientId ? { patientId } : {}) }),
    })
  },
  enroll(facilityId: string, registration: RegistrationCase, email: string, reason: string, key: string) {
    return canonicalRequest<{ patientId: string; hid: string; contactVerificationRequired: true }>(
      `/api/v1/identity/registration-cases/${encodeURIComponent(registration.caseId)}/enroll`, {
        method: 'POST', headers: headers(facilityId, key),
        body: JSON.stringify({ expectedVersion: registration.version, email, reason, purpose: 'healthcare-operations' }),
      })
  },
}
