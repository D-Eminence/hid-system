import { requestJson } from './index';

export interface OutreachRequestContext {
  correlationId: string;
  facilityId: string;
  purposeOfUse: 'direct-care';
  csrfToken?: string;
  authorization?: string;
}

export interface OutreachClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  credentials?: RequestCredentials;
}

export interface OutreachRegistrationCase {
  id: string;
  facilityId: string;
  localCommandId: string;
  temporaryPatientId: string;
  status: 'identity_resolution_pending' | 'identity_resolved';
  fullName: string;
  sex: 'female' | 'male' | 'other' | 'unknown';
  ageYears: number;
  phone: string | null;
  operationalNotes: string | null;
  resolvedPatientId: string | null;
  resolutionKind: 'linked_existing' | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOutreachRegistrationCase {
  localCommandId: string;
  temporaryPatientId: string;
  fullName: string;
  sex: OutreachRegistrationCase['sex'];
  ageYears: number;
  phone?: string | null;
  operationalNotes?: string | null;
}

export interface LinkOutreachExistingPatient {
  canonicalPatientId: string;
  expectedVersion: number;
  reason: string;
}

export class OutreachApiProblem extends Error {
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(readonly status: number, readonly payload: unknown) {
    const problem = typeof payload === 'object' && payload !== null
      ? payload as { detail?: unknown; code?: unknown }
      : null;
    super(typeof problem?.detail === 'string'
      ? problem.detail : `Outreach API request failed (${status})`);
    this.name = 'OutreachApiProblem';
    this.code = typeof problem?.code === 'string' ? problem.code : null;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

export class OutreachApiClient {
  constructor(private readonly options: OutreachClientOptions) {}

  listRegistrationCases(context: OutreachRequestContext, signal?: AbortSignal) {
    return this.request<readonly OutreachRegistrationCase[]>(
      '/api/v1/outreach/registration-cases', 'GET', undefined, context, undefined, signal);
  }

  getRegistrationCase(id: string, context: OutreachRequestContext, signal?: AbortSignal) {
    return this.request<OutreachRegistrationCase>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(id)}`,
      'GET', undefined, context, undefined, signal);
  }

  createRegistrationCase(input: CreateOutreachRegistrationCase, context: OutreachRequestContext,
    idempotencyKey: string, signal?: AbortSignal) {
    return this.request<OutreachRegistrationCase>('/api/v1/outreach/registration-cases',
      'POST', input, context, idempotencyKey, signal);
  }

  linkExistingPatient(caseId: string, input: LinkOutreachExistingPatient,
    context: OutreachRequestContext, idempotencyKey: string, signal?: AbortSignal) {
    return this.request<OutreachRegistrationCase>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(caseId)}/link-existing`,
      'POST', input, context, idempotencyKey, signal);
  }

  private async request<Result>(path: string, method: 'GET' | 'POST', body: unknown,
    context: OutreachRequestContext, idempotencyKey?: string,
    signal?: AbortSignal): Promise<Result> {
    const attempts = idempotencyKey ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const { response, payload } = await requestJson({
          baseUrl: this.options.baseUrl,
          path,
          method,
          body,
          timeoutMs: this.options.timeoutMs ?? 10_000,
          credentials: this.options.credentials ?? 'include',
          signal,
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            'x-correlation-id': context.correlationId,
            'x-facility-id': context.facilityId,
            'x-purpose-of-use': context.purposeOfUse,
            ...(context.csrfToken ? { 'x-csrf-token': context.csrfToken } : {}),
            ...(context.authorization ? { authorization: context.authorization } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
        });
        if (!response.ok) {
          if (attempt < attempts && [502, 503, 504].includes(response.status)) continue;
          throw new OutreachApiProblem(response.status, payload);
        }
        return payload as Result;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || error instanceof OutreachApiProblem || attempt >= attempts) throw error;
      }
    }
    throw lastError;
  }
}
