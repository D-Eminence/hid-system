import type { OcrExtraction, OcrJob, OcrPublicationResult } from '@hid/api-client'
import { extractionSummary, publicationTruth, retryAllowed } from './presentation'

const job: OcrJob = { id: 'j', facilityId: 'f', documentId: 'd', patientId: null, status: 'failed', provider: 'provider-neutral', attemptCount: 1, maxAttempts: 3, version: 2, createdAt: '2026-08-11', patientConfirmation: null }
const extraction: OcrExtraction = { id: 'e', version: 2, attempt: 1, provider: 'provider-neutral', providerModel: null, rawText: 'protected OCR text', structuredPayload: { protected: true }, confidence: 0.9, provenance: {}, createdAt: '2026-08-11' }

describe('OCR operational presentation', () => {
  it('allows authorized online retry for a failed job', () => expect(retryAllowed(job, true, ['ocr.job.write'])).toBe(true))
  it('blocks retry offline', () => expect(retryAllowed(job, false, ['ocr.job.write'])).toBe(false))
  it('blocks retry without operator permission', () => expect(retryAllowed(job, true, [])).toBe(false))
  it('blocks retry after the attempt limit', () => expect(retryAllowed({ ...job, attemptCount: 3 }, true, ['ocr.job.write'])).toBe(false))
  it('does not expose raw OCR text in the operations summary', () => expect(extractionSummary(extraction)).not.toHaveProperty('rawText'))
  it('does not claim pending publication succeeded', () => expect(publicationTruth({ status: 'pending' } as OcrPublicationResult)).toContain('no clinical success'))
  it('reports failed publication without fake success', () => expect(publicationTruth({ status: 'failed' } as OcrPublicationResult)).toContain('failed'))
  it('distinguishes server-confirmed publication', () => expect(publicationTruth({ status: 'published' } as OcrPublicationResult)).toContain('server acknowledgement'))
})
