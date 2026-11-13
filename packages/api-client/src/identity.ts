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
  kind?: 'staff' | 'patient';
  patientId?: string;
  id: string;
  subject: string;
  accountId: string;
  sessionId?: string;
  email?: string;
  displayName?: string;
  roles: readonly string[];
  permissions: readonly string[];
  platformRoles?: readonly string[];
  platformPermissions?: readonly string[];
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
  /**
   * The method of the browser request being served. Identity uses it, from an
   * authenticated workload only, to apply the browser-write Origin and CSRF
   * check to a forwarded cookie only when that request was a write.
   */
  requestMethod?: string;
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

/** A precheck answer: whether a records read would be allowed, never the grant behind it. */
export type IdentityAuthorizationPrecheck = Omit<IdentityAuthorizationDecision, 'consentGrantId' | 'expiresAt'>;

/** POST identity/outreach/health-id/start's answer (0119). */
export interface IdentityOutreachHealthIdStart {
  channel: 'email';
  expiresAt: string;
  destinationHint: string;
  resendAfterSeconds: number;
}

/** POST identity/outreach/health-id/confirm's answer (0119). */
export interface IdentityOutreachHealthIdConfirm {
  healthId: string;
  outcome: 'created' | 'replayed';
}

/**
 * POST identity/outreach/health-id/create-unclaimed's answer (0120): a Health
 * ID with no account, and its one-time claim code (only in this answer).
 */
export interface IdentityOutreachHealthIdCreateUnclaimed {
  healthId: string;
  claimCode: string;
  claimExpiresAt: string;
}

/** How long outreachHealthIdCreateUnclaimed waits for Identity (0120); still never retried. */
export const OUTREACH_HEALTH_ID_CREATE_UNCLAIMED_TIMEOUT_MS = 20_000;

export interface IdentityClientOptions {
  baseUrl: string;
  caller: IdentityInternalCaller;
  timeoutMs?: number;
  workloadHeaders: () => Promise<Readonly<Record<string, string>>>;
}

export interface PatientSelfAuthorization {
  allowed: true;
  patientId: string;
  accountId: string;
  subject: string;
  sessionId: string;
  expiresAt: string;
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

  async authorizePatientSelf(context: IdentityDelegatedContext): Promise<PatientSelfAuthorization> {
    const payload = await this.request('/api/v1/identity/service/patient-self-authorization', 'GET', undefined, context);
    if (typeof payload !== 'object' || payload === null) throw new IdentityApiProblem(502, payload);
    const value = payload as Partial<PatientSelfAuthorization>;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (value.allowed !== true || !uuid.test(value.patientId ?? '') || !uuid.test(value.accountId ?? '')
      || !uuid.test(value.sessionId ?? '') || typeof value.subject !== 'string' || !value.subject
      || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
      || Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.now() + 60_000) {
      throw new IdentityApiProblem(502, payload);
    }
    return value as PatientSelfAuthorization;
  }

  async patientProfile(context:IdentityDelegatedContext):Promise<Record<string,unknown>> {
    const value=await this.request('/api/v1/identity/me','GET',undefined,context);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new IdentityApiProblem(502,{code:'INVALID_PATIENT_PROFILE'});
    return value as Record<string,unknown>;
  }

  async authorizeStaffRecordRead(patientId:string,context:IdentityDelegatedContext):Promise<IdentityAuthorizationDecision> {
    const payload=await this.request('/api/v1/identity/service/patients/'+encodeURIComponent(patientId)+'/record-read-authorization',
      'GET',undefined,{...context,purposeOfUse:'direct-care'});
    if(!validDecision(payload,patientId,'read_records','direct-care',context.facilityId))throw new IdentityApiProblem(502,payload);
    return payload;
  }

  async staffPatientProfile(patientId:string,context:IdentityDelegatedContext):Promise<Record<string,unknown>> {
    const value=await this.request('/api/v1/identity/service/patients/'+encodeURIComponent(patientId)+'/chat-profile','GET',undefined,context);
    if(!value||typeof value!=='object'||Array.isArray(value)||(value as Record<string,unknown>).patientId!==patientId
      ||!Number.isSafeInteger((value as Record<string,unknown>).version))throw new IdentityApiProblem(502,{code:'INVALID_PATIENT_PROFILE'});
    return value as Record<string,unknown>;
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

  /**
   * The answer authorizePatient would give for a records read, without its
   * side effects: Identity notes no access and records no authorization
   * check. The caller must still call authorizePatient before it opens
   * anything. An Identity without the route answers 404 (IdentityApiProblem).
   */
  async precheckPatientRead(
    patientId: string,
    purpose: 'direct-care' | 'emergency' | 'healthcare-operations',
    context: IdentityDelegatedContext,
  ): Promise<IdentityAuthorizationPrecheck> {
    const payload = await this.request('/api/v1/identity/service/authorization/precheck', 'POST',
      { patientId, scope: 'read_records', purpose }, { ...context, purposeOfUse: purpose });
    if (!validDecision(payload, patientId, 'read_records', purpose, context.facilityId)) {
      throw new IdentityApiProblem(502, payload);
    }
    const { allowed, facilityId, membershipId, breakGlass } = payload;
    return { allowed, patientId, facilityId, membershipId, scope: 'read_records', purpose, breakGlass };
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

  /**
   * Assisted Health ID at an outreach (0119), for outreach-api: sends the
   * person an email code. The volunteer's sign-in is forwarded in `context`
   * (cookie, CSRF token, Origin or bearer). Never retried here: a second start
   * would send a second code; the Idempotency-Key goes as a header so Identity
   * recognises a retry of the same request.
   */
  async outreachHealthIdStart(
    input: { caseId: string; channel: 'email' | 'sms'; email?: string },
    idempotencyKey: string,
    context: IdentityDelegatedContext,
  ): Promise<IdentityOutreachHealthIdStart> {
    const payload = await this.request('/api/v1/identity/outreach/health-id/start', 'POST', input,
      { ...context, purposeOfUse: 'direct-care', idempotencyKey: undefined }, { 'idempotency-key': idempotencyKey });
    const value = payload as Partial<IdentityOutreachHealthIdStart> | null;
    if (!value || value.channel !== 'email' || typeof value.expiresAt !== 'string'
        || typeof value.destinationHint !== 'string' || typeof value.resendAfterSeconds !== 'number') {
      throw new IdentityApiProblem(502, payload);
    }
    return { channel: 'email', expiresAt: value.expiresAt, destinationHint: value.destinationHint,
      resendAfterSeconds: value.resendAfterSeconds };
  }

  /** Assisted Health ID at an outreach (0119): checks the person's code and creates the Health ID. Never retried here. */
  async outreachHealthIdConfirm(
    input: { caseId: string; code: string },
    context: IdentityDelegatedContext,
  ): Promise<IdentityOutreachHealthIdConfirm> {
    const payload = await this.request('/api/v1/identity/outreach/health-id/confirm', 'POST', input,
      { ...context, purposeOfUse: 'direct-care', idempotencyKey: undefined });
    const value = payload as Partial<IdentityOutreachHealthIdConfirm> | null;
    if (!value || typeof value.healthId !== 'string' || !/^HID-[A-HJ-NP-Z2-9]{6,32}$/.test(value.healthId)
        || (value.outcome !== 'created' && value.outcome !== 'replayed')) {
      throw new IdentityApiProblem(502, payload);
    }
    return { healthId: value.healthId, outcome: value.outcome };
  }

  /**
   * No contact at all (0120): creates the person's Health ID with no account
   * and a one-time claim code. Never retried here: the claim code is answered
   * once, and a second call answers 409 OUTREACH_HEALTH_ID_ALREADY_CREATED.
   * Waits up to 20 s (not the client's usual timeout): a timeout after
   * Identity commits would lose a claim code that cannot be shown again.
   */
  async outreachHealthIdCreateUnclaimed(
    input: { caseId: string },
    context: IdentityDelegatedContext,
  ): Promise<IdentityOutreachHealthIdCreateUnclaimed> {
    const payload = await this.request('/api/v1/identity/outreach/health-id/create-unclaimed', 'POST',
      { caseId: input.caseId }, { ...context, purposeOfUse: 'direct-care', idempotencyKey: undefined }, {},
      OUTREACH_HEALTH_ID_CREATE_UNCLAIMED_TIMEOUT_MS);
    const value = payload as Partial<IdentityOutreachHealthIdCreateUnclaimed> | null;
    if (!value || typeof value.healthId !== 'string' || !/^HID-[A-HJ-NP-Z2-9]{6,32}$/.test(value.healthId)
        || typeof value.claimCode !== 'string' || !/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(value.claimCode)
        || typeof value.claimExpiresAt !== 'string') {
      throw new IdentityApiProblem(502, null);
    }
    return { healthId: value.healthId, claimCode: value.claimCode, claimExpiresAt: value.claimExpiresAt };
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
    timeoutMs?: number,
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
          timeoutMs: timeoutMs ?? this.options.timeoutMs ?? 5_000,
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
            ...(context.requestMethod && /^[A-Za-z]{1,16}$/.test(context.requestMethod)
              ? { 'x-hid-original-method': context.requestMethod.toUpperCase() } : {}),
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
  if (actor.kind === 'patient' && (typeof actor.patientId !== 'string'
    || actor.roles?.length !== 0 || actor.permissions?.length !== 0
    || actor.facilityIds?.length !== 0 || actor.facilities?.length !== 0 || actor.facility)) return false;
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
