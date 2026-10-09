import {
  PharmacyApiClient,
  PharmacyApiProblem,
  type CreatePharmacyDispensingInput,
  type PharmacyImportedMedicationEvidence,
  type PharmacyRequestContext,
  type ReversePharmacyDispensingInput,
} from '@hid/api-client'
import { getIdentityCsrfToken } from '@hid/identity-browser-client'

export { PharmacyApiProblem }

function context(facilityId: string, mutation = false): PharmacyRequestContext {
  const csrfToken = mutation ? getIdentityCsrfToken() : undefined
  if (mutation && !csrfToken) throw new Error('Refresh your Identity session before changing Pharmacy records.')
  return {
    correlationId: crypto.randomUUID(),
    facilityId,
    purposeOfUse: 'direct-care',
    ...(csrfToken ? { csrfToken } : {}),
  }
}

export function createPharmacyApi(facilityId: string) {
  const client = new PharmacyApiClient({ baseUrl: '' })
  return {
    listWorkItems: (signal?: AbortSignal) => client.listWorkItems(context(facilityId), signal),
    getDispensing: (id: string, signal?: AbortSignal) => client.getDispensing(id, context(facilityId), signal),
    dispense: (id: string, input: CreatePharmacyDispensingInput, key: string, signal?: AbortSignal) =>
      client.dispense(id, input, context(facilityId, true), key, signal),
    reverse: (id: string, input: ReversePharmacyDispensingInput, key: string, signal?: AbortSignal) =>
      client.reverseDispensing(id, input, context(facilityId, true), key, signal),
    getImport: (id: string, signal?: AbortSignal): Promise<PharmacyImportedMedicationEvidence> =>
      client.getImportedMedicationEvidence(id, context(facilityId), signal),
  }
}
