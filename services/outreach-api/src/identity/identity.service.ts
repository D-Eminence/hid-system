import { Injectable } from '@nestjs/common';
import { IdentityApiClient, IdentityApiProblem, type IdentityDelegatedContext, type IdentityOutreachHealthIdConfirm,
  type IdentityOutreachHealthIdStart } from '@hid/api-client';
import { WorkloadCredentialsService } from '../auth/workload-credentials.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';

interface AuthorizationDecision {
  allowed: boolean;
  patientId: string;
  facilityId: string;
  membershipId: string;
  scope: 'write_records';
  purpose: string;
  breakGlass: boolean;
}

@Injectable()
export class IdentityService {
  private readonly client: IdentityApiClient;

  constructor(private readonly workload: WorkloadCredentialsService) {
    this.client = new IdentityApiClient({ baseUrl: getEnvironment().IDENTITY_API_URL,
      caller: 'outreach-api', timeoutMs: 5_000,
      workloadHeaders: () => this.workload.headers() });
  }

  /**
   * Assisted Health ID (0119): Identity sends the person an email code. The
   * volunteer's sign-in is forwarded as for every Identity call, so Identity
   * runs 0119's commands in the volunteer's own session. Identity's problems
   * come back verbatim (status, code, detail, healthId, Retry-After).
   */
  async startHealthId(caseId: string, input: { channel: 'email' | 'sms'; email?: string }, idempotencyKey: string,
    context: DataAccessContext): Promise<IdentityOutreachHealthIdStart> {
    return this.client.outreachHealthIdStart({ caseId, channel: input.channel,
      ...(input.email !== undefined ? { email: input.email } : {}) }, idempotencyKey, this.delegated(context))
      .catch((error: unknown) => { throw healthIdProblem(error, 'start'); });
  }

  /** Assisted Health ID (0119): Identity checks the code and creates the Health ID. */
  async confirmHealthId(caseId: string, code: string, context: DataAccessContext): Promise<IdentityOutreachHealthIdConfirm> {
    return this.client.outreachHealthIdConfirm({ caseId, code }, this.delegated(context))
      .catch((error: unknown) => { throw healthIdProblem(error, 'confirm'); });
  }

  private delegated(context: DataAccessContext): IdentityDelegatedContext {
    return { correlationId: context.correlationId, facilityId: context.facilityId, purposeOfUse: 'direct-care',
      authorization: context.userAuthorization, cookie: context.userCookie, csrfToken: context.csrfToken,
      origin: context.origin };
  }

  async authorizeExistingPatient(patientId: string, context: DataAccessContext): Promise<void> {
    const decision = await this.client.authorizePatient(patientId, 'write_records', 'direct-care', {
      correlationId: context.correlationId, facilityId: context.facilityId,
      purposeOfUse: 'direct-care', authorization: context.userAuthorization,
      cookie: context.userCookie, csrfToken: context.csrfToken, origin: context.origin,
    }).catch((error) => { if (error instanceof IdentityApiProblem) throw new DomainProblem(error.status,
      error.code ?? 'IDENTITY_AUTHORIZATION_DENIED', error.message); throw new DomainProblem(503,
      'IDENTITY_SERVICE_UNAVAILABLE', 'Identity authorization service is unavailable'); });
    if (decision.allowed !== true || decision.patientId !== patientId
        || decision.facilityId !== context.facilityId || decision.scope !== 'write_records'
        || decision.breakGlass !== false) throw new DomainProblem(403, 'IDENTITY_AUTHORIZATION_DENIED',
      'Identity did not authorize the existing patient link');
  }
}

/** What a 5xx from Identity says here (Identity sends no detail with a 5xx). */
const UNAVAILABLE = {
  start: "The code couldn't be sent right now. Try again in a few minutes.",
  confirm: "The Health ID couldn't be created right now. Try again in a few minutes.",
} as const;

/**
 * An Identity problem from the Health ID routes as this service's own: the
 * same status, code and plain-words detail, the Health ID of
 * OUTREACH_HEALTH_ID_ALREADY_CREATED, and Retry-After from retryAfterSeconds.
 * A 5xx or no answer at all is 503 OUTREACH_HEALTH_ID_UNAVAILABLE.
 */
export function healthIdProblem(error: unknown, step: 'start' | 'confirm'): DomainProblem {
  if (!(error instanceof IdentityApiProblem) || error.status >= 500 || error.status < 400) {
    return new DomainProblem(503, 'OUTREACH_HEALTH_ID_UNAVAILABLE', UNAVAILABLE[step], undefined, { exposeDetail: true });
  }
  const payload = typeof error.payload === 'object' && error.payload !== null
    ? error.payload as { healthId?: unknown; retryAfterSeconds?: unknown } : {};
  const healthId = typeof payload.healthId === 'string' ? payload.healthId : undefined;
  const retryAfter = typeof payload.retryAfterSeconds === 'number' && Number.isSafeInteger(payload.retryAfterSeconds)
    && payload.retryAfterSeconds > 0 ? payload.retryAfterSeconds : undefined;
  return new DomainProblem(error.status, error.code ?? 'IDENTITY_REQUEST_REFUSED', error.message, undefined, {
    ...(healthId ? { extensions: { healthId }, details: { healthId } } : {}),
    ...(retryAfter ? { headers: { 'Retry-After': String(retryAfter) } } : {}),
  });
}
