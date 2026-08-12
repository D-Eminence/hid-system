import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { IdentityActorContext } from '@hid/identity-browser-client'
import App from './App'

const testState = vi.hoisted(() => ({ actor: null as IdentityActorContext | null, online: true }))

vi.mock('@hid/identity-browser-client', () => ({
  getIdentityActorContext: () => Promise.resolve(testState.actor),
  getIdentityCsrfToken: () => 'csrf',
  safeSignOut: () => Promise.resolve(),
}))
vi.mock('@hid/offline', () => ({ useConnectivity: () => ({ online: testState.online, offline: !testState.online }) }))
vi.mock('@hid/telemetry', () => ({ captureProductEvent: vi.fn(), captureSafeException: vi.fn() }))
vi.mock('./lib/ocrApi', () => ({
  OcrBrowserProblem: class OcrBrowserProblem extends Error { code = null; correlationId = null },
  createOcrApi: () => ({
    findJob: vi.fn(), createJob: vi.fn(), getJob: vi.fn(), retryJob: vi.fn(),
    listExtractions: vi.fn(), listValidations: vi.fn(), listPublications: vi.fn(),
  }),
}))

const actor = (permissions: string[]): IdentityActorContext => ({
  subject: 'subject-1', accountId: 'account-1', displayName: 'OCR operator',
  facilities: [{ id: 'facility-1', membershipId: 'membership-1', organizationId: 'organization-1',
    name: 'Digitization Centre', roles: ['ocr_operator'], permissions, isPrimary: true }],
})

beforeEach(() => {
  testState.actor = null
  testState.online = true
  window.history.replaceState({}, '', '/ocr/')
})
afterEach(cleanup)

describe('OCR route acceptance', () => {
  it('shows Identity sign-in before any OCR operations for an unauthenticated user', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Sign in to OCR Operations' })).toBeInTheDocument()
  })

  it('shows access denied when the membership lacks OCR read authority', async () => {
    testState.actor = actor([])
    render(<App />)
    expect(await screen.findByText('OCR operations is unavailable')).toBeInTheDocument()
  })

  it('renders the truthful operations dashboard for an authorized OCR operator', async () => {
    testState.actor = actor(['ocr.job.read'])
    render(<App />)
    expect(await screen.findByText('Digitization operations')).toBeInTheDocument()
    expect(screen.getByText('Not exposed')).toBeInTheDocument()
    expect(screen.getByText('Not claimed')).toBeInTheDocument()
  })

  it('preserves a direct document-processing refresh without granting write authority', async () => {
    testState.actor = actor(['ocr.job.read'])
    window.history.replaceState({}, '', '/ocr/document-processing')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Document processing' })).toBeInTheDocument()
    expect(screen.getByText(/cannot create them/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create OCR job' })).toBeDisabled()
  })

  it('shows the offline shell and never claims OCR execution or publication success', async () => {
    testState.actor = actor(['ocr.job.read', 'ocr.job.write'])
    testState.online = false
    render(<App />)
    expect(await screen.findByText(/not simulated offline/i)).toBeInTheDocument()
    expect(screen.getByText(/Provider readiness/i)).toBeInTheDocument()
  })
})
