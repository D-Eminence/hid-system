import type { OcrExtraction, OcrJob, OcrPublicationResult } from '@hid/api-client'

export function retryAllowed(job: OcrJob, online: boolean, permissions: readonly string[]): boolean {
  return online && job.status === 'failed' && job.attemptCount < job.maxAttempts && permissions.includes('ocr.job.write')
}

export function extractionSummary(extraction: OcrExtraction) {
  return {
    version: extraction.version,
    attempt: extraction.attempt,
    provider: extraction.provider,
    confidence: extraction.confidence,
    createdAt: extraction.createdAt,
  }
}

export function publicationTruth(publication: OcrPublicationResult | null): string {
  if (!publication) return 'No publication command exists.'
  if (publication.status === 'published') return 'Published by the owning service after server acknowledgement.'
  if (publication.status === 'failed') return 'Publication failed; no clinical success is claimed.'
  return `Publication is ${publication.status}; no clinical success is claimed yet.`
}
