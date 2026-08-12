import type { PharmacyWorkItem } from '@hid/api-client'

export type PharmacyOperationalState = 'accepted' | 'dispensed' | 'reversed'

export function operationalState(item: PharmacyWorkItem): PharmacyOperationalState {
  if (item.dispensing?.reversed) return 'reversed'
  if (item.dispensing) return 'dispensed'
  return 'accepted'
}

export function canDispense(item: PharmacyWorkItem, online: boolean, permissions: readonly string[]): boolean {
  return online && !item.dispensing && permissions.includes('pharmacy.dispensing.create')
}

export function pharmacyMetrics(items: readonly PharmacyWorkItem[]) {
  return {
    acceptedPending: items.filter(item => operationalState(item) === 'accepted').length,
    dispensed: items.filter(item => operationalState(item) === 'dispensed').length,
    reversed: items.filter(item => operationalState(item) === 'reversed').length,
    total: items.length,
  }
}

export function patientReference(patientId: string): string {
  return `Patient context ••••${patientId.slice(-4)}`
}
