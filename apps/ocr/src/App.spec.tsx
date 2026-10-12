import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { IdentityActorContext } from '@hid/identity-browser-client'
import App from './App'

const testState = vi.hoisted(() => ({ actor: null as IdentityActorContext | null, online: true }))
const ocrApi = vi.hoisted(() => ({
  findJob: vi.fn(), createJob: vi.fn(), getJob: vi.fn(), retryJob: vi.fn(),
  listExtractions: vi.fn(), listValidations: vi.fn(), listPublications: vi.fn(),
}))

vi.mock('@hid/identity-browser-client', () => ({
  getIdentityActorContext: () => Promise.resolve(testState.actor),
  getIdentityCsrfToken: () => 'csrf',
  safeSignOut: () => Promise.resolve(),
}))
vi.mock('@hid/offline', () => ({ useConnectivity: () => ({ online: testState.online, offline: !testState.online }) }))
vi.mock('@hid/telemetry', () => ({ captureProductEvent: vi.fn(), captureSafeException: vi.fn() }))
vi.mock('./lib/ocrApi', () => ({
  OcrBrowserProblem: class OcrBrowserProblem extends Error { code = null; correlationId = null },
  createOcrApi: () => ocrApi,
}))

const actor = (permissions: string[]): IdentityActorContext => ({
  subject: 'subject-1', accountId: 'account-1', displayName: 'Migrate operator',
  facilities: [{ id: 'facility-1', membershipId: 'membership-1', organizationId: 'organization-1',
    name: 'Digitization Centre', roles: ['ocr_operator'], permissions, isPrimary: true }],
})

beforeEach(() => {
  testState.actor = null
  testState.online = true
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/')
})
afterEach(cleanup)

describe('Migrate route acceptance', () => {
  it('shows Identity sign-in before any Migrate operations for an unauthenticated user', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Sign in to Migrate' })).toBeInTheDocument()
  })

  it('shows access denied when the membership lacks OCR read authority', async () => {
    testState.actor = actor([])
    render(<App />)
    expect(await screen.findByText('Migrate is unavailable')).toBeInTheDocument()
  })

  it('renders the truthful operations dashboard for an authorized Migrate operator', async () => {
    testState.actor = actor(['ocr.job.read'])
    render(<App />)
    expect(await screen.findByText('Digitization operations')).toBeInTheDocument()
    expect(screen.getByText('Not exposed')).toBeInTheDocument()
    expect(screen.getByText('Not claimed')).toBeInTheDocument()
  })

  it('preserves a direct document-processing refresh without granting write authority', async () => {
    testState.actor = actor(['ocr.job.read'])
    window.history.replaceState({}, '', '/document-processing')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Document processing' })).toBeInTheDocument()
    expect(screen.getByText(/cannot create them/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create OCR job' })).toBeDisabled()
  })

  it('creates every OCR job for Textract, the only provider the worker claims, with no provider to edit', async () => {
    testState.actor = actor(['ocr.job.read', 'ocr.job.write'])
    ocrApi.createJob.mockResolvedValue({ id: 'job-1' })
    window.history.replaceState({}, '', '/document-processing')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Document processing' })).toBeInTheDocument()
    const fields = screen.getAllByRole('textbox')
    expect(fields).toHaveLength(1)
    fireEvent.change(fields[0]!, { target: { value: ' 60000000-0000-4000-8000-000000000001 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create OCR job' }))
    await waitFor(() => expect(ocrApi.createJob).toHaveBeenCalledTimes(1))
    expect(ocrApi.createJob.mock.calls[0]?.[0]).toEqual({ documentId: '60000000-0000-4000-8000-000000000001',
      provider: 'textract', purpose: 'healthcare-operations' })
  })

  it('shows the offline shell and never claims OCR execution or publication success', async () => {
    testState.actor = actor(['ocr.job.read', 'ocr.job.write'])
    testState.online = false
    render(<App />)
    expect(await screen.findByText(/not simulated offline/i)).toBeInTheDocument()
    expect(screen.getByText(/Provider readiness/i)).toBeInTheDocument()
  })
})
