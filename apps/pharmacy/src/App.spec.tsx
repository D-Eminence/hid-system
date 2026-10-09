import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { IdentityActorContext } from '@hid/identity-browser-client'
import type { PharmacyWorkItem } from '@hid/api-client'
import App from './App'

const testState = vi.hoisted(() => ({
  actor: null as IdentityActorContext | null,
  online: true,
  listWorkItems: vi.fn<() => Promise<PharmacyWorkItem[]>>(),
}))

vi.mock('@hid/identity-browser-client', () => ({
  getIdentityActorContext: () => Promise.resolve(testState.actor),
  getIdentityCsrfToken: () => 'csrf',
  safeSignOut: () => Promise.resolve(),
}))
vi.mock('@hid/offline', () => ({ useConnectivity: () => ({ online: testState.online, offline: !testState.online }) }))
vi.mock('@hid/telemetry', () => ({ captureProductEvent: vi.fn(), captureSafeException: vi.fn() }))
vi.mock('./lib/pharmacyApi', () => ({
  PharmacyApiProblem: class PharmacyApiProblem extends Error { status = 500 },
  createPharmacyApi: () => ({
    listWorkItems: testState.listWorkItems,
    getDispensing: vi.fn(), dispense: vi.fn(), reverse: vi.fn(), getImport: vi.fn(),
  }),
}))

const facility = (permissions: string[]) => ({
  id: 'facility-1', membershipId: 'membership-1', organizationId: 'organization-1',
  name: 'Test Pharmacy', roles: ['pharmacist'], permissions, isPrimary: true,
})
const actor = (permissions: string[]): IdentityActorContext => ({
  subject: 'subject-1', accountId: 'account-1', displayName: 'Authorized user',
  facilities: [facility(permissions)],
})
const acceptedItem: PharmacyWorkItem = {
  id: 'work-1', patientId: 'patient-0002', facilityId: 'facility-1',
  sourceEhrPrescriptionId: 'rx-1', sourceEhrPrescriptionVersion: 1, sourceEncounterId: 'encounter-1',
  status: 'accepted', medication: { codeSystem: null, code: null, display: 'Amoxicillin' },
  doseQuantity: 1, doseUnit: 'tablet', routeCode: null, frequency: 'daily',
  instructions: 'Protected instruction', acceptedAt: '2026-08-11T00:00:00Z', version: 1, dispensing: null,
}

beforeEach(() => {
  testState.actor = null
  testState.online = true
  testState.listWorkItems.mockReset().mockResolvedValue([acceptedItem])
  window.history.replaceState({}, '', '/pharmacy/')
})
afterEach(cleanup)

describe('Pharmacy route acceptance', () => {
  it('shows Identity sign-in before any workspace data for an unauthenticated user', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Sign in to Pharmacy' })).toBeInTheDocument()
    expect(screen.queryByText('Amoxicillin')).not.toBeInTheDocument()
  })

  it('shows access denied when the membership lacks Pharmacy read authority', async () => {
    testState.actor = actor([])
    render(<App />)
    expect(await screen.findByText('Pharmacy access is unavailable')).toBeInTheDocument()
    expect(testState.listWorkItems).not.toHaveBeenCalled()
  })

  it('renders the real accepted prescription list for an authorized Pharmacy user', async () => {
    testState.actor = actor(['pharmacy.work-item.read', 'pharmacy.dispensing.create'])
    window.history.replaceState({}, '', '/pharmacy/prescriptions')
    render(<App />)
    expect(await screen.findByText('Amoxicillin')).toBeInTheDocument()
    expect(screen.getByText(/accepted is not dispensed/i)).toBeInTheDocument()
    expect(screen.getByText(/Patient context ••••0002/)).toBeInTheDocument()
  })

  it('preserves a direct nested-route refresh through the Pharmacy basename', async () => {
    testState.actor = actor(['pharmacy.work-item.read'])
    window.history.replaceState({}, '', '/pharmacy/evidence')
    render(<App />)
    expect(await screen.findByText('Imported medication evidence')).toBeInTheDocument()
    expect(screen.getByText(/not an active prescription/i)).toBeInTheDocument()
  })

  it('shows the offline safety state and does not load the authoritative queue', async () => {
    testState.actor = actor(['pharmacy.work-item.read', 'pharmacy.dispensing.create'])
    testState.online = false
    window.history.replaceState({}, '', '/pharmacy/dispensing')
    render(<App />)
    expect(await screen.findByText(/Protected Pharmacy mutations are disabled/i)).toBeInTheDocument()
    expect(screen.getByText(/Nothing is labeled dispensed until the API confirms/i)).toBeInTheDocument()
    expect(testState.listWorkItems).not.toHaveBeenCalled()
  })
})
