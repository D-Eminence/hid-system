export type ApiErrorInfo = {
  code: string | null
  details: unknown
  message: string
  requestId: string | null
  retryable: boolean
  status: number
}

type ApiRecord = Record<string, unknown>

function isRecord(value: unknown): value is ApiRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function createApiRequestId() {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`
  return `hid_web_${randomPart}`
}

export function parseApiPayload(rawBody: string): unknown {
  if (!rawBody.trim()) return null
  try {
    return JSON.parse(rawBody) as unknown
  } catch {
    return null
  }
}

export function unwrapApiData<T>(payload: unknown): { found: boolean; value: T | null } {
  if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return { found: false, value: null }
  }
  return { found: true, value: payload.data as T }
}

export function readApiErrorInfo(
  payload: unknown,
  options: {
    fallbackMessage: string
    fallbackStatus: number
    response?: Response | null
  },
): ApiErrorInfo {
  const record = isRecord(payload) ? payload : null
  const nestedError = record && isRecord(record.error) ? record.error : null
  const response = options.response ?? null
  const statusValue = record?.status
  const status = response?.status ||
    (typeof statusValue === 'number' && Number.isFinite(statusValue) ? statusValue : options.fallbackStatus)
  const message =
    readString(record?.message) ??
    readString(record?.error) ??
    readString(nestedError?.message) ??
    options.fallbackMessage
  const requestId =
    readString(record?.requestId) ??
    readString(record?.request_id) ??
    response?.headers.get('x-request-id') ??
    null
  const code =
    readString(record?.code) ??
    readString(nestedError?.code) ??
    null
  const retryable = typeof record?.retryable === 'boolean'
    ? record.retryable
    : status === 408 || status === 425 || status === 429 || status >= 500

  return {
    code,
    details: record && Object.prototype.hasOwnProperty.call(record, 'details') ? record.details : payload,
    message,
    requestId,
    retryable,
    status,
  }
}

export async function readFunctionInvokeError(error: unknown, fallbackMessage: string): Promise<ApiErrorInfo> {
  const candidate = isRecord(error) ? error : null
  const context = candidate?.context
  const response = typeof Response !== 'undefined' && context instanceof Response ? context : null
  let payload: unknown = null

  if (response) {
    try {
      payload = parseApiPayload(await response.clone().text())
    } catch {
      payload = null
    }
  }

  const rawMessage = readString(candidate?.message) ?? (error instanceof Error ? error.message : null)
  return readApiErrorInfo(payload, {
    fallbackMessage: rawMessage ?? fallbackMessage,
    fallbackStatus: response?.status || 500,
    response,
  })
}
