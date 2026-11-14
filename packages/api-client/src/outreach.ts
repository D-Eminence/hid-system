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

/**
 * How long the browser waits for createUnverifiedHealthId: longer than
 * outreach-api's own wait for Identity (OUTREACH_HEALTH_ID_CREATE_UNCLAIMED_TIMEOUT_MS,
 * 20 s) plus its registration read, so the browser never gives up while the
 * server can still answer with the one-time claim code.
 */
export const OUTREACH_HEALTH_ID_CREATE_UNVERIFIED_BROWSER_TIMEOUT_MS = 45_000;

/** How a Health ID created at outreach was created (0120). */
export type OutreachHealthIdStatus = 'verified' | 'unclaimed';

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
  /** The person's area, town or LGA as given at registration (0118), or null; absent before 0118. */
  area?: string | null;
  /** Whether the registration has a screening (0118); absent before 0118. */
  hasScreening?: boolean;
  /** The screening's genotype (0122), null when not recorded; absent before 0122. */
  genotype?: OutreachGenotype | null;
  /** The screening's blood group (0122), null when not recorded; absent before 0122. */
  bloodGroup?: OutreachBloodGroup | null;
  resolvedPatientId: string | null;
  resolutionKind: 'linked_existing' | null;
  /** The Health ID created for this person at the outreach (0119), or null; absent before 0119. */
  healthId?: string | null;
  /** Whether that Health ID was created from this registration at the outreach (0119); absent before 0119. */
  healthIdCreatedByOutreach?: boolean;
  /**
   * How that Health ID was created (0120): 'verified' (the person proved an
   * email; 0119), 'unclaimed' (no contact; nobody can sign in until it is
   * claimed), or null when there is none; absent before 0120.
   */
  healthIdStatus?: OutreachHealthIdStatus | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** POST .../health-id/start (0119): email only for now; { channel: 'sms' } answers 503 OUTREACH_HEALTH_ID_UNAVAILABLE. */
export type OutreachHealthIdStartInput = { channel: 'email'; email: string } | { channel: 'sms' };

/** 202 from POST .../health-id/start (0119). */
export interface OutreachHealthIdStarted {
  channel: 'email';
  expiresAt: string;
  /** The email masked, e.g. "a***@gmail.com". */
  destinationHint: string;
  resendAfterSeconds: number;
}

/** 201 from POST .../health-id/confirm (0119), also for a replay. */
export interface OutreachHealthIdCreated {
  healthId: string;
  registration: OutreachRegistrationCase;
}

/**
 * 201 from POST .../health-id/create-unverified (0120): a Health ID with no
 * account and its one-time claim code. The claim code is answered only here,
 * once: print it on the person's slip. Never store or log it.
 */
export interface OutreachHealthIdCreatedUnverified {
  healthId: string;
  claimCode: string;
  claimExpiresAt: string;
  registration: OutreachRegistrationCase;
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
  /** Optional, up to 100 characters (0118). */
  area?: string | null;
}

/** Genotypes (0122); 'unknown' means the person does not know it ("Not known"). */
export const OUTREACH_GENOTYPES = ['AA', 'AS', 'AC', 'SS', 'SC', 'CC', 'unknown'] as const;
export type OutreachGenotype = typeof OUTREACH_GENOTYPES[number];
/** Blood groups (0122), stored with an ASCII '-'; 'unknown' means "Not known". */
export const OUTREACH_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'] as const;
export type OutreachBloodGroup = typeof OUTREACH_BLOOD_GROUPS[number];

export interface OutreachScreeningMedicine {
  name: string;
  dose?: string | null;
}

/**
 * A registration's whole screening as saved (0118): every field optional; an
 * omitted field is saved as null, except genotype and blood group (0122),
 * which an update keeps when omitted. Send those two only to a service whose
 * screening answer lists them in `accepts`: an older one refuses them (400).
 */
export interface SaveOutreachRegistrationScreening {
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  pulseBpm?: number | null;
  temperatureC?: number | null;
  weightKg?: number | null;
  heightCm?: number | null;
  glucoseValue?: number | null;
  glucoseUnit?: 'mmol/L' | 'mg/dL' | null;
  glucoseTiming?: 'fasting' | 'random' | null;
  malariaRdt?: 'positive' | 'negative' | 'not_done' | null;
  hearingLeft?: 'pass' | 'refer' | 'not_done' | null;
  hearingRight?: 'pass' | 'refer' | 'not_done' | null;
  mainComplaint?: string | null;
  seenByClinician?: boolean | null;
  clinicianName?: string | null;
  outcome?: string | null;
  medicinesGiven?: readonly OutreachScreeningMedicine[] | null;
  referred?: boolean | null;
  referredTo?: string | null;
  /** Since 0122. */
  genotype?: OutreachGenotype | null;
  /** Since 0122. */
  bloodGroup?: OutreachBloodGroup | null;
}

/** A registration's screening as answered (0118; genotype and blood group since 0122). */
export interface OutreachRegistrationScreening extends Required<Omit<SaveOutreachRegistrationScreening,
  'medicinesGiven' | 'genotype' | 'bloodGroup'>> {
  caseId: string;
  /** Absent before 0122; null when not recorded. */
  genotype?: OutreachGenotype | null;
  /** Absent before 0122; null when not recorded. */
  bloodGroup?: OutreachBloodGroup | null;
  medicinesGiven: readonly { name: string; dose: string | null }[];
  version: number;
  recordedAt: string;
  recordedByMembershipId: string;
  updatedAt: string;
}

export interface OutreachRegistrationScreeningResult {
  screening: OutreachRegistrationScreening | null;
  /** The optional fields beyond 0118's that the service takes (0122: genotype, bloodGroup); absent before 0122. */
  accepts?: readonly string[];
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
    const healthId = typeof payload === 'object' && payload !== null
      ? (payload as { healthId?: unknown }).healthId : undefined;
    this.healthId = typeof healthId === 'string' ? healthId : null;
  }

  /** OUTREACH_HEALTH_ID_ALREADY_CREATED's Health ID (0119), else null. */
  readonly healthId: string | null;
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

  /**
   * Sends the person a 6-digit code by email to create their Health ID (0119).
   * Problems: OutreachApiProblem with code (e.g. OUTREACH_HEALTH_ID_EMAIL_TAKEN)
   * and, for OUTREACH_HEALTH_ID_ALREADY_CREATED, the Health ID in `healthId`.
   */
  healthIdStart(caseId: string, input: OutreachHealthIdStartInput, context: OutreachRequestContext,
    idempotencyKey: string, signal?: AbortSignal) {
    return this.request<OutreachHealthIdStarted>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(caseId)}/health-id/start`,
      'POST', input, context, idempotencyKey, signal, undefined, false);
  }

  /** Checks the code the person read out and creates their Health ID (0119). */
  healthIdConfirm(caseId: string, input: { code: string }, context: OutreachRequestContext,
    idempotencyKey: string, signal?: AbortSignal) {
    return this.request<OutreachHealthIdCreated>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(caseId)}/health-id/confirm`,
      'POST', input, context, idempotencyKey, signal, undefined, false);
  }

  /**
   * No contact at all (0120): creates the person's Health ID with no account
   * and a one-time claim code. Never retried: a second call, even with the
   * same Idempotency-Key, answers 409 OUTREACH_HEALTH_ID_ALREADY_CREATED with
   * `healthId` and never the claim code again.
   */
  createUnverifiedHealthId(caseId: string, context: OutreachRequestContext, idempotencyKey: string,
    signal?: AbortSignal) {
    return this.request<OutreachHealthIdCreatedUnverified>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(caseId)}/health-id/create-unverified`,
      'POST', {}, context, idempotencyKey, signal, undefined, false,
      Math.max(this.options.timeoutMs ?? 10_000, OUTREACH_HEALTH_ID_CREATE_UNVERIFIED_BROWSER_TIMEOUT_MS));
  }

  /** A registration's screening (0118): { screening: null } when none was recorded. */
  getRegistrationScreening(caseId: string, context: OutreachRequestContext, signal?: AbortSignal) {
    return this.request<OutreachRegistrationScreeningResult>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(caseId)}/screening`,
      'GET', undefined, context, undefined, signal);
  }

  /**
   * Saves a registration's whole screening (0118). expectedVersion is omitted
   * for the first save and is the current screening's version after it (sent
   * as If-Match).
   */
  saveRegistrationScreening(caseId: string, input: SaveOutreachRegistrationScreening,
    expectedVersion: number | undefined, context: OutreachRequestContext, idempotencyKey: string,
    signal?: AbortSignal) {
    return this.request<{ screening: OutreachRegistrationScreening; accepts?: readonly string[] }>(
      `/api/v1/outreach/registration-cases/${encodeURIComponent(caseId)}/screening`,
      'PUT', input, context, idempotencyKey, signal,
      expectedVersion === undefined ? undefined : `"${expectedVersion}"`);
  }

  /** Records that the registration list was exported (format and count only); 204, no body. */
  recordRegistrationExport(input: { format: 'csv' | 'pdf' | 'docx' | 'xlsx'; count: number; campaignId?: string },
    context: OutreachRequestContext, signal?: AbortSignal) {
    return this.request<void>('/api/v1/outreach/registration-cases/exports', 'POST', input, context, undefined, signal);
  }

  private async request<Result>(path: string, method: 'GET' | 'POST' | 'PUT', body: unknown,
    context: OutreachRequestContext, idempotencyKey?: string,
    signal?: AbortSignal, ifMatch?: string, retry = true, timeoutMs?: number): Promise<Result> {
    // A Health ID code is never resent by a retry: each start emails a new code.
    const attempts = idempotencyKey && retry ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const { response, payload } = await requestJson({
          baseUrl: this.options.baseUrl,
          path,
          method,
          body,
          timeoutMs: timeoutMs ?? this.options.timeoutMs ?? 10_000,
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
            ...(ifMatch ? { 'if-match': ifMatch } : {}),
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
