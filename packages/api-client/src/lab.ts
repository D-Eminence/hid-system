import { requestJson } from './index';

export type LabInternalCaller = 'ehr-api' | 'ocr-api';

export interface LabRequestContext {
  correlationId: string;
  facilityId: string;
  purposeOfUse: string;
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
  origin?: string;
}

export interface LabClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  internalServiceToken?: string;
  serviceAuthorizationProvider?: (caller: LabInternalCaller) => Promise<string>;
}

export interface LabResourceReference {
  id: string;
}

export class LabApiProblem extends Error {
  constructor(readonly status: number, readonly payload: unknown) {
    super(typeof payload === 'object' && payload !== null && 'detail' in payload
      ? String((payload as { detail: unknown }).detail) : `Lab API request failed (${status})`);
    this.name = 'LabApiProblem';
  }
}

export class LabApiClient {
  constructor(private readonly options: LabClientOptions) {}

  acceptEhrOrder(
    input: unknown,
    context: LabRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.command('/api/v1/lab/work-items/accept-ehr-order', input, context,
      idempotencyKey, 'ehr-api', signal);
  }

  async createOcrImport(
    input: unknown,
    context: LabRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<LabResourceReference> {
    const result = await this.command('/api/v1/lab/imports/from-ocr', input, context,
      idempotencyKey, 'ocr-api', signal);
    if (typeof result !== 'object' || result === null
        || typeof (result as { id?: unknown }).id !== 'string') {
      throw new LabApiProblem(502, result);
    }
    return result as LabResourceReference;
  }

  get(path: string, context: LabRequestContext, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, 'GET', undefined, context, undefined, undefined, signal);
  }

  private command(
    path: string,
    body: unknown,
    context: LabRequestContext,
    idempotencyKey: string,
    caller: LabInternalCaller,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(path, 'POST', body, context, idempotencyKey, caller, signal);
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    context: LabRequestContext,
    idempotencyKey?: string,
    caller?: LabInternalCaller,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const attempts = idempotencyKey ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const serviceAuthorization = caller && this.options.serviceAuthorizationProvider
          ? await this.options.serviceAuthorizationProvider(caller)
          : undefined;
        const { response, payload } = await requestJson({
          baseUrl: this.options.baseUrl,
          path,
          method,
          body,
          timeoutMs: this.options.timeoutMs ?? 10_000,
          credentials: 'omit',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-correlation-id': context.correlationId,
            'x-facility-id': context.facilityId,
            'x-purpose-of-use': context.purposeOfUse,
            ...(context.authorization ? { authorization: context.authorization } : {}),
            ...(context.cookie ? { cookie: context.cookie } : {}),
            ...(context.csrfToken ? { 'x-csrf-token': context.csrfToken } : {}),
            ...(context.origin ? { origin: context.origin } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
            ...(caller ? {
              'x-hid-internal-caller': caller,
              ...(serviceAuthorization
                ? { 'x-hid-service-authorization': serviceAuthorization }
                : { 'x-hid-service-token': this.options.internalServiceToken ?? '' }),
            } : {}),
          },
        });
        if (!response.ok) {
          if (attempt < attempts && [502, 503, 504].includes(response.status)) continue;
          throw new LabApiProblem(response.status, payload);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || error instanceof LabApiProblem || attempt >= attempts) throw error;
      }
    }
    throw lastError;
  }
}
