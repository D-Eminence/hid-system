import type { PharmacyWorkItem } from '@hid/api-client'
import { canDispense, operationalState, patientReference, pharmacyMetrics } from './domain'

const item = (dispensing: PharmacyWorkItem['dispensing'] = null): PharmacyWorkItem => ({
  id: '10000000-0000-4000-8000-000000000001', patientId: '20000000-0000-4000-8000-000000000002',
  facilityId: '30000000-0000-4000-8000-000000000003', sourceEhrPrescriptionId: '40000000-0000-4000-8000-000000000004',
  sourceEhrPrescriptionVersion: 2, sourceEncounterId: '50000000-0000-4000-8000-000000000005', status: 'accepted',
  medication: { codeSystem: null, code: null, display: 'Protected medication' }, doseQuantity: 1, doseUnit: 'tablet',
  routeCode: null, frequency: 'daily', instructions: 'Protected instruction', acceptedAt: '2026-08-11T00:00:00Z', version: 1, dispensing,
})

describe('Pharmacy operational truth', () => {
  it('keeps accepted distinct from dispensed', () => expect(operationalState(item())).toBe('accepted'))
  it('reports server-confirmed dispensing', () => expect(operationalState(item({ id: 'd', status: 'dispensed', reversed: false }))).toBe('dispensed'))
  it('preserves reversal as a separate state', () => expect(operationalState(item({ id: 'd', status: 'dispensed', reversed: true }))).toBe('reversed'))
  it('requires live connectivity for dispensing', () => expect(canDispense(item(), false, ['pharmacy.dispensing.create'])).toBe(false))
  it('requires dispensing permission', () => expect(canDispense(item(), true, [])).toBe(false))
  it('does not dispense an already dispensed work item', () => expect(canDispense(item({ id: 'd', status: 'dispensed', reversed: false }), true, ['pharmacy.dispensing.create'])).toBe(false))
  it('derives truthful server-backed metrics', () => expect(pharmacyMetrics([item(), item({ id: 'd', status: 'dispensed', reversed: false })])).toEqual({ acceptedPending: 1, dispensed: 1, reversed: 0, total: 2 }))
  it('masks the patient reference in list presentation', () => expect(patientReference(item().patientId)).toBe('Patient context ••••0002'))
})
