import { OcrApiClient, type OcrTransportRequest } from '@hid/api-client'
import { getIdentityCsrfToken } from '@hid/identity-browser-client'

export class OcrBrowserProblem extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly correlationId: string | null, message: string) {
    super(message)
    this.name = 'OcrBrowserProblem'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createOcrApi(facilityId: string) {
  const transport = async (request: OcrTransportRequest): Promise<unknown> => {
    const correlationId = crypto.randomUUID()
    const headers = new Headers({
      Accept: 'application/problem+json, application/json',
      'X-Correlation-ID': correlationId,
      'X-Facility-ID': facilityId,
      'X-Purpose-Of-Use': request.purposeOfUse,
    })
    if (request.body !== undefined) headers.set('Content-Type', 'application/json')
    if (request.idempotencyKey) headers.set('Idempotency-Key', request.idempotencyKey)
    if (request.method !== 'GET') {
      const csrf = getIdentityCsrfToken()
      if (!csrf) throw new OcrBrowserProblem(401, 'SESSION_REFRESH_REQUIRED', correlationId, 'Refresh your Identity session before changing OCR workflow state.')
      headers.set('X-CSRF-Token', csrf)
    }
    const response = await fetch(request.path, {
      method: request.method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal,
    })
    const text = await response.text()
    let payload: unknown
    try { payload = text ? JSON.parse(text) : null } catch { throw new OcrBrowserProblem(502, 'INVALID_RESPONSE', response.headers.get('x-correlation-id') ?? correlationId, 'OCR returned an invalid response.') }
    if (!response.ok) {
      const value = isRecord(payload) ? payload : {}
      throw new OcrBrowserProblem(response.status, typeof value.code === 'string' ? value.code : null,
        response.headers.get('x-correlation-id') ?? correlationId,
        typeof value.detail === 'string' ? value.detail : 'OCR request could not be completed.')
    }
    return payload
  }
  return new OcrApiClient({ transport })
}
