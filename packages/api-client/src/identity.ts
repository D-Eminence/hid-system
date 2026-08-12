import { requestJson } from './index';

export type IdentityInternalCaller = 'ehr-api' | 'lab-api' | 'pharmacy-api' | 'ocr-api' | 'outreach-api';

export interface IdentityFacilityAssignment {
  id: string;
  membershipId: string;
  organizationId: string;
  name: string;
  code?: string;
  roles: readonly string[];
  permissions: readonly string[];
  isPrimary: boolean;
}

export interface IdentityActorContext {
  id: string;
  subject: string;
  accountId: string;
  sessionId?: string;
  email?: string;
  displayName?: string;
  roles: readonly string[];
  permissions: readonly string[];
  facilityIds: readonly string[];
  facilities: readonly IdentityFacilityAssignment[];
  facility?: IdentityFacilityAssignment;
  role?: string;
  authenticationMethod: 'local' | 'oidc';
}

export interface IdentityDelegatedContext {
  correlationId: string;
  facilityId?: string;
  purposeOfUse?: 'direct-care' | 'emergency' | 'healthcare-operations';
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
  origin?: string;
  validateMutation?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ResolveNinRegistration {
  nin: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender?: 'female' | 'male' | 'intersex' | 'other' | 'unknown';
  purpose: 'healthcare-operations';
}

export interface IdentityRegistrationCase {
  caseId: string;
  status: 'pending_new_identity_approval' | 'review_required' | 'resolved_existing_identity'
    | 'linked_existing' | 'approved_new_identity' | 'rejected' | 'cancelled';
  version: number;
  candidateCount: number;
  patient?: { patientId: string; hid: string };
}

export interface IdentityAuthorizationDecision {
  allowed: boolean;
  patientId: string;
  facilityId: string;
  membershipId: string;
  scope: 'read_records' | 'write_records';
  purpose: 'direct-care' | 'emergency' | 'healthcare-operations';
  consentGrantId?: string;
  expiresAt?: string;
  breakGlass: boolean;
}

export interface IdentityClientOptions {
  baseUrl: string;
  caller: IdentityInternalCaller;
  timeoutMs?: number;
  workloadHeaders: () => Promise<Readonly<Record<string, string>>>;
}

export class IdentityApiProblem extends Error {
  readonly code: string | null;

  constructor(readonly status: number, readonly payload: unknown) {
    const problem = typeof payload === 'object' && payload !== null
      ? payload as { detail?: unknown; code?: unknown } : null;
    super(typeof problem?.detail === 'string'
      ? problem.detail : `Identity API request failed (${status})`);
    this.name = 'IdentityApiProblem';
    this.code = typeof problem?.code === 'string' ? problem.code : null;
  }
}

export class IdentityApiClient {
  constructor(private readonly options: IdentityClientOptions) {}

  async authenticateActor(context: IdentityDelegatedContext): Promise<IdentityActorContext> {
    const payload = await this.request(
      '/api/v1/auth/service-session',
      context.validateMutation ? 'POST' : 'GET',
      undefined,
      context,
    );
    const actor = typeof payload === 'object' && payload !== null && 'actor' in payload
      ? (payload as { actor?: unknown }).actor : undefined;
    if (!validActor(actor)) throw new IdentityApiProblem(502, payload);
    return actor;
  }

  async authorizePatient(
    patientId: string,
    scope: 'read_records' | 'write_records',
    purpose: 'direct-care' | 'emergency' | 'healthcare-operations',
    context: IdentityDelegatedContext,
  ): Promise<IdentityAuthorizationDecision> {
    const payload = await this.request('/api/v1/identity/service/authorization/check', 'POST',
      { patientId, scope, purpose }, { ...context, purposeOfUse: purpose });
    if (!validDecision(payload, patientId, scope, purpose, context.facilityId)) {
      throw new IdentityApiProblem(502, payload);
    }
    return payload;
  }

  async authorizeOutreachPermission(
    permission: string,
    context: IdentityDelegatedContext,
  ): Promise<IdentityActorContext> {
    const payload = await this.request('/api/v1/identity/outreach/authorize', 'POST',
      { permission }, { ...context, purposeOfUse: 'direct-care' });
    const actor = typeof payload === 'object' && payload !== null && 'actor' in payload
      ? (payload as { actor?: unknown }).actor : undefined;
    if (!validActor(actor)) throw new IdentityApiProblem(502, payload);
    return actor;
  }

  async authorizeDocumentScanner(
    scannerAuthorization: string,
    correlationId: string,
  ): Promise<{ subject: string; accountId: string }> {
    const payload = await this.request('/api/v1/identity/service/workloads/document-scanner/authorize',
      'POST', undefined, { correlationId }, { 'x-hid-scanner-authorization': scannerAuthorization });
    if (typeof payload !== 'object' || payload === null
        || typeof (payload as { subject?: unknown }).subject !== 'string'
        || typeof (payload as { accountId?: unknown }).accountId !== 'string') {
      throw new IdentityApiProblem(502, payload);
    }
    return payload as { subject: string; accountId: string };
  }

  async resolveNin(
    input: ResolveNinRegistration,
    idempotencyKey: string,
    context: IdentityDelegatedContext,
  ): Promise<IdentityRegistrationCase> {
    return this.registrationCase(await this.request('/api/v1/identity/nin/resolve', 'POST', input,
      { ...context, purposeOfUse: input.purpose, idempotencyKey }));
  }

  async getRegistrationCase(
    caseId: string,
    context: IdentityDelegatedContext,
  ): Promise<IdentityRegistrationCase> {
    return this.registrationCase(await this.request(
      `/api/v1/identity/registration-cases/${encodeURIComponent(caseId)}`, 'GET', undefined, context));
  }

  async approveNewRegistration(
    caseId: string,
    input: { expectedVersion: number; reason: string },
    idempotencyKey: string,
    context: IdentityDelegatedContext,
  ): Promise<IdentityRegistrationCase> {
    return this.registrationCase(await this.request(
      `/api/v1/identity/registration-cases/${encodeURIComponent(caseId)}/approve-new`,
      'POST', input, { ...context, idempotencyKey }));
  }

  async linkExistingRegistration(
    caseId: string,
    input: { patientId: string; expectedVersion: number; reason: string },
    idempotencyKey: string,
    context: IdentityDelegatedContext,
  ): Promise<IdentityRegistrationCase> {
    return this.registrationCase(await this.request(
      `/api/v1/identity/registration-cases/${encodeURIComponent(caseId)}/link-existing`,
      'POST', input, { ...context, idempotencyKey }));
  }

  private registrationCase(payload: unknown): IdentityRegistrationCase {
    if (typeof payload !== 'object' || payload === null) throw new IdentityApiProblem(502, payload);
    const value = payload as Partial<IdentityRegistrationCase>;
    if (typeof value.caseId !== 'string' || typeof value.status !== 'string'
        || typeof value.version !== 'number' || typeof value.candidateCount !== 'number') {
      throw new IdentityApiProblem(502, payload);
    }
    return value as IdentityRegistrationCase;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    context: IdentityDelegatedContext,
    additionalHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const attempts = context.idempotencyKey ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const workloadHeaders = await this.options.workloadHeaders();
        const { response, payload } = await requestJson({
          baseUrl: this.options.baseUrl,
          path,
          method,
          body,
          signal: context.signal,
          timeoutMs: this.options.timeoutMs ?? 5_000,
          credentials: 'omit',
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            'x-correlation-id': context.correlationId,
            'x-hid-internal-caller': this.options.caller,
            ...workloadHeaders,
            ...(context.facilityId ? { 'x-facility-id': context.facilityId } : {}),
            ...(context.purposeOfUse ? { 'x-purpose-of-use': context.purposeOfUse } : {}),
            ...(context.authorization ? { authorization: context.authorization } : {}),
            ...(context.cookie ? { cookie: context.cookie } : {}),
            ...(context.csrfToken ? { 'x-csrf-token': context.csrfToken } : {}),
            ...(context.origin ? { origin: context.origin } : {}),
            ...(context.idempotencyKey ? { 'idempotency-key': context.idempotencyKey } : {}),
            ...additionalHeaders,
          },
        });
        if (!response.ok) {
          if (attempt < attempts && [502, 503, 504].includes(response.status)) continue;
          throw new IdentityApiProblem(response.status, payload);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (context.signal?.aborted || error instanceof IdentityApiProblem || attempt >= attempts) throw error;
      }
    }
    throw lastError;
  }
}

function validActor(value: unknown): value is IdentityActorContext {
  if (typeof value !== 'object' || value === null) return false;
  const actor = value as Partial<IdentityActorContext>;
  return typeof actor.id === 'string' && typeof actor.subject === 'string'
    && typeof actor.accountId === 'string' && Array.isArray(actor.roles)
    && Array.isArray(actor.permissions) && Array.isArray(actor.facilityIds)
    && Array.isArray(actor.facilities)
    && (actor.authenticationMethod === 'local' || actor.authenticationMethod === 'oidc');
}

function validDecision(
  value: unknown,
  patientId: string,
  scope: IdentityAuthorizationDecision['scope'],
  purpose: IdentityAuthorizationDecision['purpose'],
  facilityId: string | undefined,
): value is IdentityAuthorizationDecision {
  if (typeof value !== 'object' || value === null) return false;
  const decision = value as Partial<IdentityAuthorizationDecision>;
  return typeof decision.allowed === 'boolean' && decision.patientId === patientId
    && decision.scope === scope && decision.purpose === purpose
    && typeof decision.facilityId === 'string'
    && (!facilityId || decision.facilityId === facilityId)
    && typeof decision.membershipId === 'string'
    && typeof decision.breakGlass === 'boolean';
}
