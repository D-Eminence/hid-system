
export interface PatientSelf {
  patientId: string; hid: string; firstName: string; lastName: string; fullName: string
  dateOfBirth: string | null; gender: string | null; country: string | null; state: string | null; version: number
}
export interface ReleasedRecords {
  encounters: Array<{ id: string; facilityId: string; encounterType: string; status: string; startedAt: string; endedAt: string | null }>
  notes: Array<{ id: string; encounterId: string; facilityId: string; noteType: string; title: string | null; status: string; revisionNo: number; content: unknown; signedAt: string | null }>
  limit: number
}
export interface EmergencyGrant {
  accessRequestId: string; consentGrantId: string; patientId: string
  status: 'active'; expiresAt: string; existingGrant: boolean
}
export type CanonicalTransport = <T>(path: string, init?: RequestInit) => Promise<T>
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const canonicalHid = /^HID-[A-HJ-NP-Z2-9]{6,32}$/
function identifier(value: string) {
  if (!uuid.test(value)) throw new Error('An authoritative identifier is required.')
  return encodeURIComponent(value)
}
function emergencyHeaders(facilityId: string) {
  identifier(facilityId)
  return { 'X-Facility-Id': facilityId, 'X-Purpose-Of-Use': 'emergency' }
}
export function emergencyIsActive(grant: EmergencyGrant, now = Date.now()) {
  return grant.status === 'active' && Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > now
}
/** No patient or facility selector is accepted by patient self endpoints. */
export function createCarePortalApi(send: CanonicalTransport) {
  return {
    self: () => send<PatientSelf>('/api/v1/identity/me'),
    ownRecords: () => send<ReleasedRecords>('/api/v1/ehr/me/records'),
    async activate(facilityId: string, hid: string, reason: string, durationMinutes: number) {
      const normalized = hid.trim().toUpperCase()
      if (!canonicalHid.test(normalized) || reason.trim().length < 8 || reason.trim().length > 500
          || !Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 240) {
        throw new Error('Enter a complete HID, an emergency reason of 8–500 characters, and a duration of 5–240 minutes.')
      }
      const grant = await send<EmergencyGrant>('/api/v1/identity/break-glass', {
        method: 'POST', headers: emergencyHeaders(facilityId),
        body: JSON.stringify({ hid: normalized, reason: reason.trim(), durationMinutes }),
      })
      identifier(grant.consentGrantId); identifier(grant.patientId)
      if (!emergencyIsActive(grant)) throw new Error('The emergency grant has expired. Request a new authorization.')
      return grant
    },
    async emergencyRecords(facilityId: string, grant: EmergencyGrant) {
      if (!emergencyIsActive(grant)) throw new Error('Emergency access has expired.')
      const records = await send<ReleasedRecords>(`/api/v1/ehr/patients/${identifier(grant.patientId)}/emergency-records`, {
        headers: emergencyHeaders(facilityId),
      })
      // A response arriving after expiry must never restore the record view.
      if (!emergencyIsActive(grant)) throw new Error('Emergency access has expired.')
      return records
    },
    close: (facilityId: string, grantId: string, reason: string) => {
      if (reason.trim().length < 8 || reason.trim().length > 500) throw new Error('Enter a closing reason of 8–500 characters.')
      return send<{ consentGrantId: string; patientId: string; status: 'revoked'; closedAt: string; alreadyClosed: boolean }>(
        `/api/v1/identity/consent-grants/${identifier(grantId)}/close`, {
          method: 'POST', headers: emergencyHeaders(facilityId), body: JSON.stringify({ reason: reason.trim() }),
        })
    },
  }
}
