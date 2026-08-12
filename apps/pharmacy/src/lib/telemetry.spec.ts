import { describe, expect, it } from 'vitest'
import {
  captureProductEvent,
  captureSafeException,
  redactSentryEvent,
  safeTelemetryProperties,
} from '@hid/telemetry'

describe('shared healthcare telemetry redaction', () => {
  it('keeps only explicitly approved product properties', () => {
    expect(safeTelemetryProperties({ workspace: 'ocr', result: 'failed', arbitrary: 'blocked' }))
      .toEqual({ workspace: 'ocr', result: 'failed' })
  })

  it.each([
    'authorization', 'cookie', 'csrf_token', 'nin', 'patient_name', 'phone', 'email', 'hid',
    'clinical_note', 'diagnosis', 'lab_result_value', 'medication', 'ocr_text', 'document_url',
    'raw_payload', 'request_body', 'access_pin', 'secret',
  ])('blocks sensitive property %s', key => {
    expect(safeTelemetryProperties({ [key]: 'protected', workspace: 'ehr' })).toEqual({ workspace: 'ehr' })
  })

  it('bounds approved string properties', () => {
    expect(safeTelemetryProperties({ operation: 'a'.repeat(300) }).operation).toHaveLength(160)
  })

  it('removes request URLs, user identity, contexts, and unsafe extra data', () => {
    const event = redactSentryEvent({
      request: { method: 'POST', url: 'https://hid.test/api/v1/ocr/jobs/patient-id?token=secret' },
      user: { id: 'patient-id', email: 'patient@example.test' },
      contexts: { response: { body: 'clinical payload' } },
      extra: { operation: 'job_load', medication: 'protected', response_body: 'protected' },
    })
    expect(event.request).toEqual({ method: 'POST' })
    expect(event.user).toBeUndefined()
    expect(event.contexts).toBeUndefined()
    expect(event.extra).toEqual({ operation: 'job_load' })
  })

  it('redacts exception messages and drops input/network/console breadcrumbs', () => {
    const event = redactSentryEvent({
      exception: { values: [{ type: 'ApiFailure', value: 'OCR text and medication detail' }] },
      breadcrumbs: [
        { category: 'ui.input', message: 'NIN' },
        { category: 'fetch', data: { url: '/api/v1/patient' } },
        { category: 'console', message: 'clinical note' },
        { category: 'navigation', message: '/ocr/jobs' },
      ],
    })
    expect(event.exception?.values?.[0]?.value).toBe('ApiFailure (details redacted)')
    expect(event.breadcrumbs).toEqual([{ category: 'navigation', level: undefined, timestamp: undefined }])
  })

  it('never throws when telemetry has not been configured', () => {
    expect(() => captureProductEvent('workspace_opened', { workspace: 'lab' })).not.toThrow()
    expect(() => captureSafeException(new Error('protected details'), { operation: 'test' })).not.toThrow()
  })
})
