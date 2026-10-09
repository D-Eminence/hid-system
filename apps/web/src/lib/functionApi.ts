import { createApiRequestId, readFunctionInvokeError } from './apiResponse'
import { identityClient } from './identityClient'

type FunctionInvokeOptions = Parameters<typeof identityClient.functions.invoke>[1]

export class FunctionApiError extends Error {
  status: number
  code: string | null
  requestId: string | null
  retryable: boolean
  details: unknown

  constructor(
    message: string,
    options: {
      status?: number
      code?: string | null
      requestId?: string | null
      retryable?: boolean
      details?: unknown
    } = {},
  ) {
    super(message)
    this.name = 'FunctionApiError'
    this.status = options.status ?? 500
    this.code = options.code ?? null
    this.requestId = options.requestId ?? null
    this.retryable = options.retryable ?? this.status >= 500
    this.details = options.details ?? null
  }
}

function isLowSignalMessage(message: string) {
  const lower = message.trim().toLowerCase()
  return (
    !lower ||
    lower.includes('edge function returned') ||
    lower.includes('failed to fetch') ||
    lower === 'request failed' ||
    lower === 'internal server error'
  )
}

export async function invokeApiFunction<T>(
  name: string,
  options: FunctionInvokeOptions,
  fallbackMessage: string,
): Promise<T> {
  const requestId = createApiRequestId()
  const headers = new Headers(options?.headers)
  headers.set('Accept', 'application/json')
  headers.set('X-Request-ID', requestId)

  let result: Awaited<ReturnType<typeof identityClient.functions.invoke>>
  try {
    result = await identityClient.functions.invoke(name, {
      ...options,
      headers: Object.fromEntries(headers.entries()),
    })
  } catch (error) {
    throw new FunctionApiError(
      'We could not reach the service right now. Check your connection and try again.',
      {
        status: 503,
        code: 'NETWORK_ERROR',
        requestId,
        retryable: true,
        details: error,
      },
    )
  }

  if (result.error) {
    const info = await readFunctionInvokeError(result.error, fallbackMessage)
    throw new FunctionApiError(
      isLowSignalMessage(info.message) ? fallbackMessage : info.message,
      {
        status: info.status,
        code: info.code,
        requestId: info.requestId ?? requestId,
        retryable: info.retryable,
        details: info.details,
      },
    )
  }

  return result.data as T
}
