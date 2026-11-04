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
  campaignId: string | null;
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
  /**
   * Present only while the server's OUTREACH_VISITS_ENABLED is on (0115).
   * createdBy: the registering staff member's name, or null when the caller
   * may not see it. campaignName: null without a campaign or when the caller
   * may not read campaigns. nextFollowUpOn: the follow-up date of the latest
   * visit (YYYY-MM-DD), or null.
   */
  createdBy?: { name: string } | null;
  campaignName?: string | null;
  nextFollowUpOn?: string | null;
  visitCount?: number;
}

export interface CreateOutreachRegistrationCase {
  localCommandId: string;
  campaignId?: string;
  temporaryPatientId: string;
  fullName: string;
  sex: OutreachRegistrationCase['sex'];
  ageYears: number;
  phone?: string | null;
  operationalNotes?: string | null;
}

/**
 * Exactly one of canonicalPatientId or healthId. The healthId form needs the
 * server's OUTREACH_VISITS_ENABLED; Identity resolves the Health ID again at
 * link time and nothing from a preview is trusted. Each healthId link counts
 * against the member's 20 Health ID checks an hour (with previews), found or
 * not, except a replay of a link already made (429 OUTREACH_HEALTH_ID_LIMIT).
 */
export type LinkOutreachExistingPatient =
  | { canonicalPatientId: string; healthId?: never; expectedVersion: number; reason: string }
  | { healthId: string; canonicalPatientId?: never; expectedVersion: number; reason: string };

export type OutreachCaseVisitKind = 'visit' | 'referral' | 'follow_up';

export interface CreateOutreachCaseVisit {
  kind: OutreachCaseVisitKind;
  /** YYYY-MM-DD in Africa/Lagos, not after today there. */
  occurredOn: string;
  /** YYYY-MM-DD after occurredOn, or null. */
  followUpOn?: string | null;
  /** 2-160 characters, or null. */
  referredTo?: string | null;
  /** At most 1000 characters; newlines are the only control characters allowed. */
  notes?: string | null;
}

export interface OutreachCaseVisit {
  id: string;
  registrationCaseId: string;
  kind: OutreachCaseVisitKind;
  occurredOn: string;
  followUpOn: string | null;
  referredTo: string | null;
  notes: string | null;
  recordedByMembershipId: string;
  createdAt: string;
}

/**
 * The person a Health ID belongs to, as far as the caller may read them.
 * canLink is false when the caller may read but not write this record (an
 * Access PIN, or a share below clinical collaboration): linking would be
 * refused.
 */
export interface OutreachLinkPreview {
  patient: { fullName: string; dateOfBirth: string | null; healthIdLast4: string };
  canLink: boolean;
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

  /** Needs the server's OUTREACH_VISITS_ENABLED (otherwise 404 NOT_FOUND). */
  listCaseVisits(caseId: string, context: OutreachRequestContext, signal?: AbortSignal) {
    return this.request<{ items: readonly OutreachCaseVisit[] }>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(caseId)}/visits`,
      'GET', undefined, context, undefined, signal);
  }

  /** Needs the server's OUTREACH_VISITS_ENABLED (otherwise 404 NOT_FOUND). */
  createCaseVisit(caseId: string, input: CreateOutreachCaseVisit, context: OutreachRequestContext,
    idempotencyKey: string, signal?: AbortSignal) {
    return this.request<{ visit: OutreachCaseVisit }>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(caseId)}/visits`,
      'POST', input, context, idempotencyKey, signal);
  }

  /**
   * Needs the server's OUTREACH_VISITS_ENABLED (otherwise 404 NOT_FOUND). The
   * Health ID goes in the body, never the path. Not retried.
   */
  previewLink(caseId: string, healthId: string, context: OutreachRequestContext, signal?: AbortSignal) {
    return this.request<OutreachLinkPreview>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(caseId)}/link-preview`,
      'POST', { healthId }, context, undefined, signal);
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
