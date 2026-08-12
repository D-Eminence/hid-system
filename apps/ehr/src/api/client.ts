import type {
  ApiProblemDocument,
  AuthSession,
  AuthorizedPatientResponse,
  ClinicalRecordKind,
  ClinicalRecordSummary,
  ClinicalCreateResult,
  ClinicalDocumentRecord,
  CreateClinicalNoteInput,
  CreateDiagnosisInput,
  CreateEncounterInput,
  CreateLabRequestInput,
  LabRequestCreateResult,
  CreatePrescriptionInput,
  CreateVitalInput,
  DocumentUploadOptions,
  EncounterRecord,
  IdentityPatientSummary,
  LoginResponse,
  OcrPatientConfirmationInput,
  OcrPatientConfirmation,
  OcrExtraction,
  OcrJob,
  OcrPublicationInput,
  OcrPublicationResult,
  OcrValidationInput,
  OcrValidation,
  TimelinePage,
} from './contracts';
import {
  fetchWithTimeout,
  HidInvalidJsonError,
  HidRequestTimeoutError,
  normalizeApiBaseUrl,
  OcrApiClient,
  requestJson,
} from '../../../../packages/api-client/src/index';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
  authenticated?: boolean;
  requireFacility?: boolean;
  purposeOfUse?: 'direct-care' | 'healthcare-operations';
  idempotencyKey?: string;
  skipSessionRefresh?: boolean;
}

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_HID_API_URL);
const AUTH_COOKIE_NAME = import.meta.env.VITE_HID_AUTH_COOKIE_NAME?.trim() || 'hid_access';
const REQUEST_TIMEOUT_MS = 20_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let accessToken: string | null = null;
let csrfToken: string | null = null;
let currentSession: AuthSession | null = null;
let refreshInFlight: Promise<void> | null = null;
const sessionExpiredListeners = new Set<() => void>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (source: Record<string, unknown>, field: string): string => {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiProblemError({
      title: 'Invalid API response',
      detail: `The API response is missing required field '${field}'.`,
      status: 502,
      code: 'INVALID_UPSTREAM_RESPONSE',
    });
  }
  return value;
};

const optionalString = (source: Record<string, unknown>, field: string): string | undefined => {
  const value = source[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

const unwrapData = (payload: unknown): unknown => {
  if (isRecord(payload) && 'data' in payload) return payload.data;
  return payload;
};

const parseActor = (value: unknown): AuthSession['actor'] => {
  if (!isRecord(value)) {
    throw invalidResponse('The authenticated actor is missing.');
  }

  const roleValue = value.role;
  const singularRole = typeof roleValue === 'string'
    ? roleValue
    : isRecord(roleValue)
      ? requiredString(roleValue, 'key')
      : undefined;
  const roleList = Array.isArray(value.roles)
    ? value.roles.filter((role): role is string => typeof role === 'string' && role.trim() !== '')
    : [];
  const roles = [...new Set([...(singularRole ? [singularRole] : []), ...roleList])];
  if (roles.length === 0) throw invalidResponse('The authenticated actor role is missing.');

  const roleLabel = isRecord(roleValue)
    ? optionalString(roleValue, 'label')
    : optionalString(value, 'roleLabel');

  return {
    id: optionalString(value, 'id') ?? requiredString(value, 'subject'),
    email: optionalString(value, 'email'),
    displayName: requiredString(value, 'displayName'),
    roles,
    roleLabel,
    permissions: Array.isArray(value.permissions)
      ? value.permissions.filter((permission): permission is string => typeof permission === 'string')
      : undefined,
  };
};

const parseFacility = (value: unknown): AuthSession['facility'] => {
  if (!isRecord(value)) {
    throw invalidResponse('The active facility is missing.');
  }
  const departments = Array.isArray(value.departments)
    ? value.departments.filter((department): department is string => typeof department === 'string')
    : undefined;

  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    code: optionalString(value, 'code'),
    type: optionalString(value, 'type'),
    departments,
  };
};

const parseSession = (payload: unknown): AuthSession => {
  const value = unwrapData(payload);
  if (!isRecord(value)) throw invalidResponse('The authentication response is malformed.');
  if (!isRecord(value.actor)) throw invalidResponse('The authenticated actor is missing.');
  return {
    actor: parseActor(value.actor),
    facility: parseFacility(value.facility ?? value.actor.facility),
    expiresAt: optionalString(value, 'expiresAt'),
  };
};

const parseLogin = (payload: unknown): LoginResponse => {
  const value = unwrapData(payload);
  if (!isRecord(value)) throw invalidResponse('The login response is malformed.');
  return {
    ...parseSession(value),
    accessToken: optionalString(value, 'accessToken'),
    csrfToken: optionalString(value, 'csrfToken'),
  };
};

const parsePatient = (value: unknown): IdentityPatientSummary => {
  if (!isRecord(value)) throw invalidResponse('The patient response is malformed.');

  const sex = value.sex ?? value.gender;
  const normalizedSex = typeof sex === 'string'
    ? ({ male: 'Male', female: 'Female', other: 'Other', unknown: 'Unknown' } as const)[sex.trim().toLowerCase() as 'male' | 'female' | 'other' | 'unknown']
    : undefined;
  const status = value.status;
  const allowedStatuses = new Set(['active', 'admitted', 'emergency', 'discharged', 'inactive']);

  return {
    patientId: requireUuid(requiredString(value, 'patientId'), 'Patient identifier'),
    hid: requiredString(value, 'hid'),
    firstName: optionalString(value, 'firstName'),
    lastName: optionalString(value, 'lastName'),
    fullName: optionalString(value, 'fullName'),
    dateOfBirth: optionalString(value, 'dateOfBirth'),
    sex: normalizedSex,
    bloodGroup: optionalString(value, 'bloodGroup'),
    phone: optionalString(value, 'phone'),
    mrn: optionalString(value, 'mrn'),
    registrationDate: optionalString(value, 'registrationDate'),
    lastVisit: optionalString(value, 'lastVisit'),
    status: typeof status === 'string' && allowedStatuses.has(status)
      ? status as IdentityPatientSummary['status']
      : undefined,
  };
};

const parseAuthorizedPatient = (payload: unknown, requestedHid: string): AuthorizedPatientResponse => {
  const value = unwrapData(payload);
  if (!isRecord(value) || !isRecord(value.authorization)) {
    throw invalidResponse('The patient authorization decision is missing.');
  }
  const decision = requiredString(value.authorization, 'decision');
  if (decision !== 'allow' && decision !== 'deny') {
    throw invalidResponse('The patient authorization decision is invalid.');
  }

  const authorizationDetails = {
    expiresAt: optionalString(value.authorization, 'expiresAt'),
    consentId: optionalString(value.authorization, 'consentId')
      ?? optionalString(value.authorization, 'consentGrantId'),
    breakGlass: value.authorization.breakGlass === true,
  };
  if (decision === 'deny') {
    return { authorization: { decision, ...authorizationDetails } };
  }
  const patient = parsePatient(value.patient);
  if (patient.hid.trim().toUpperCase() !== requestedHid.trim().toUpperCase()) {
    throw invalidResponse('The authorized patient response does not match the requested identity.');
  }
  return {
    patient,
    authorization: { decision, ...authorizationDetails },
  };
};

const invalidResponse = (detail: string): ApiProblemError => new ApiProblemError({
  title: 'Invalid API response',
  detail,
  status: 502,
  code: 'INVALID_UPSTREAM_RESPONSE',
});

export class ApiProblemError extends Error {
  readonly type?: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly code?: string;
  readonly correlationId?: string;
  readonly errors?: unknown;

  constructor(problem: ApiProblemDocument) {
    super(problem.detail ?? problem.title ?? 'The request could not be completed.');
    this.name = 'ApiProblemError';
    this.type = problem.type;
    this.title = problem.title ?? 'Request failed';
    this.status = problem.status ?? 0;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.code = problem.code;
    this.correlationId = problem.correlationId;
    this.errors = problem.errors;
  }
}

const parseProblem = (payload: unknown, status: number, correlationId?: string): ApiProblemDocument => {
  if (!isRecord(payload)) {
    return { title: 'Request failed', status, correlationId };
  }
  return {
    type: optionalString(payload, 'type'),
    title: optionalString(payload, 'title') ?? 'Request failed',
    status: typeof payload.status === 'number' ? payload.status : status,
    detail: optionalString(payload, 'detail'),
    instance: optionalString(payload, 'instance'),
    code: optionalString(payload, 'code'),
    correlationId: optionalString(payload, 'correlationId') ?? correlationId,
    errors: payload.errors,
  };
};

const clearAuthMaterial = (): void => {
  accessToken = null;
  csrfToken = null;
  currentSession = null;
  pendingUploads.clear();
};

const notifySessionExpired = (): void => {
  accessToken = null;
  csrfToken = null;
  currentSession = null;
  pendingUploads.clear();
  sessionExpiredListeners.forEach((listener) => listener());
};

const readCsrfCookie = (): string | null => {
  if (typeof document === 'undefined') return null;
  const expectedName = `${AUTH_COOKIE_NAME}_csrf`;
  for (const pair of document.cookie.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== expectedName) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1));
    } catch {
      return null;
    }
  }
  return null;
};

const apiRequest = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const method = options.method ?? 'GET';
  const authenticated = options.authenticated ?? true;
  if (options.requireFacility && !currentSession?.facility.id) {
    throw new ApiProblemError({
      title: 'No active facility',
      detail: 'A verified facility session is required for this request.',
      status: 403,
      code: 'FACILITY_CONTEXT_REQUIRED',
    });
  }

  const headers = new Headers({
    Accept: 'application/problem+json, application/json',
    'X-Correlation-ID': crypto.randomUUID(),
  });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (authenticated && accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (authenticated && currentSession?.facility.id) {
    headers.set('X-Facility-ID', currentSession.facility.id);
  }
  if (options.purposeOfUse) headers.set('X-Purpose-Of-Use', options.purposeOfUse);
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  if (method !== 'GET' && csrfToken) headers.set('X-CSRF-Token', csrfToken);

  let response: Response;
  let payload: unknown;
  try {
    ({ response, payload } = await requestJson({
      baseUrl: API_BASE_URL,
      path,
      method,
      headers,
      body: options.body,
      signal: options.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    }));
    const responseCsrfToken = response.headers.get('X-CSRF-Token');
    if (responseCsrfToken) csrfToken = responseCsrfToken;
  } catch (error: unknown) {
    if (error instanceof HidRequestTimeoutError) {
      throw new ApiProblemError({
        title: 'Request timed out',
        detail: 'The secure HID service did not respond in time.',
        status: 0,
        code: 'REQUEST_TIMEOUT',
      });
    }
    if (error instanceof HidInvalidJsonError) {
      throw invalidResponse('The API returned invalid JSON.');
    }
    throw error;
  }

  if (!response.ok) {
    if (authenticated && response.status === 401 && !options.skipSessionRefresh) {
      try {
        await refreshSession();
        return apiRequest<T>(path, { ...options, skipSessionRefresh: true });
      } catch {
        notifySessionExpired();
      }
    } else if (authenticated && response.status === 401) {
      notifySessionExpired();
    }
    throw new ApiProblemError(parseProblem(
      payload,
      response.status,
      response.headers.get('X-Correlation-ID') ?? undefined,
    ));
  }

  return payload as T;
};

const refreshSession = async (): Promise<void> => {
  if (refreshInFlight) return refreshInFlight;
  csrfToken ??= readCsrfCookie();
  if (!csrfToken) {
    throw new ApiProblemError({
      title: 'Session refresh unavailable',
      detail: 'The protected refresh context is missing.',
      status: 401,
      code: 'SESSION_REFRESH_UNAVAILABLE',
    });
  }

  refreshInFlight = (async () => {
    const payload = await apiRequest<unknown>('/api/v1/auth/refresh', {
      method: 'POST',
      authenticated: false,
      skipSessionRefresh: true,
    });
    currentSession = parseSession(payload);
    accessToken = null;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
};

export const authApi = {
  async login(email: string, password: string, turnstileToken?: string, signal?: AbortSignal): Promise<AuthSession> {
    const payload = await apiRequest<unknown>('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password, turnstileToken, turnstileAction: 'ehr-login' },
      authenticated: false,
      signal,
    });
    const login = parseLogin(payload);
    accessToken = login.accessToken ?? null;
    csrfToken = login.csrfToken ?? csrfToken;
    currentSession = {
      actor: login.actor,
      facility: login.facility,
      expiresAt: login.expiresAt,
    };
    return currentSession;
  },

  async restoreSession(signal?: AbortSignal): Promise<AuthSession> {
    const payload = await apiRequest<unknown>('/api/v1/auth/session', { signal });
    currentSession = parseSession(payload);
    return currentSession;
  },

  async logout(): Promise<void> {
    try {
      await apiRequest<void>('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      clearAuthMaterial();
    }
  },

  clear(): void {
    clearAuthMaterial();
  },

  /** Establishes a session returned by authenticated login or restoration. */
  setSession(session: AuthSession): void {
    currentSession = session;
    accessToken = null;
  },

  onSessionExpired(listener: () => void): () => void {
    sessionExpiredListeners.add(listener);
    return () => sessionExpiredListeners.delete(listener);
  },
};

export const identityApi = {
  async lookupPatientByHid(
    hid: string,
    purpose: 'direct-care',
    signal?: AbortSignal,
  ): Promise<AuthorizedPatientResponse> {
    const payload = await apiRequest<unknown>(
      '/api/v1/identity/patient-lookup',
      {
        method: 'POST',
        body: { hid, purpose },
        signal,
        requireFacility: true,
        purposeOfUse: 'direct-care',
      },
    );
    return parseAuthorizedPatient(payload, hid);
  },
};

const ALLOWED_DOCUMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff']);
const MAX_DOCUMENT_SIZE = 52_428_800;

const requireUuid = (value: string, label: string): string => {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiProblemError({ title: 'Invalid clinical context', detail: `${label} is invalid.`, status: 400 });
  }
  return value;
};

const parseCreateResult = (payload: unknown): ClinicalCreateResult => {
  const value = unwrapData(payload);
  if (!isRecord(value)) throw invalidResponse('The clinical create response is malformed.');
  return { id: requireUuid(requiredString(value, 'id'), 'Clinical resource identifier') };
};

const parseEncounter = (payload: unknown, expectedPatientId?: string): EncounterRecord => {
  const value = unwrapData(payload);
  if (!isRecord(value)) throw invalidResponse('The encounter response is malformed.');
  const encounterType = requiredString(value, 'encounterType');
  const status = requiredString(value, 'status');
  const encounterTypes = new Set(['ambulatory', 'emergency', 'inpatient', 'home', 'virtual', 'other']);
  const statuses = new Set(['planned', 'in_progress', 'on_hold', 'completed', 'cancelled', 'entered_in_error']);
  if (!encounterTypes.has(encounterType) || !statuses.has(status)) {
    throw invalidResponse('The encounter response contains an invalid state.');
  }
  const id = requireUuid(requiredString(value, 'id'), 'Encounter identifier');
  const patientId = requireUuid(requiredString(value, 'patientId'), 'Patient identifier');
  const facilityId = requireUuid(requiredString(value, 'facilityId'), 'Facility identifier');
  if ((expectedPatientId && patientId !== expectedPatientId)
    || (currentSession?.facility.id && facilityId !== currentSession.facility.id)) {
    throw invalidResponse('The encounter response does not match the active patient and facility context.');
  }
  return {
    id,
    patientId,
    facilityId,
    encounterNumber: optionalString(value, 'encounterNumber') ?? null,
    encounterType: encounterType as EncounterRecord['encounterType'],
    status: status as EncounterRecord['status'],
    startedAt: requiredString(value, 'startedAt'),
    endedAt: optionalString(value, 'endedAt') ?? null,
    chiefComplaint: optionalString(value, 'chiefComplaint') ?? null,
    rowVersion: String(value.rowVersion ?? ''),
  };
};

const parseEncounterPage = (payload: unknown, expectedPatientId: string): TimelinePage<EncounterRecord> => {
  const value = unwrapData(payload);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw invalidResponse('The encounter list response is malformed.');
  }
  return {
    items: value.items.map((item) => parseEncounter(item, expectedPatientId)),
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
  };
};

const nullableNumber = (source: Record<string, unknown>, field: string): number | null => {
  const value = source[field];
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw invalidResponse(`The clinical record field '${field}' is invalid.`);
  return parsed;
};

const clinicalRecordSummary = (
  value: unknown,
  kind: ClinicalRecordKind,
  expectedPatientId: string,
  expectedEncounterId: string,
): ClinicalRecordSummary => {
  if (!isRecord(value)) throw invalidResponse('A clinical timeline record is malformed.');
  const patientId = requireUuid(requiredString(value, 'patientId'), 'Patient identifier');
  const facilityId = requireUuid(requiredString(value, 'facilityId'), 'Facility identifier');
  const encounterId = requireUuid(requiredString(value, 'encounterId'), 'Encounter identifier');
  if (patientId !== expectedPatientId
    || encounterId !== expectedEncounterId
    || (currentSession?.facility.id && facilityId !== currentSession.facility.id)) {
    throw invalidResponse('A clinical record does not match the active patient, encounter, and facility context.');
  }

  const id = requireUuid(requiredString(value, 'id'), 'Clinical resource identifier');
  if (kind === 'note') {
    return {
      id, kind,
      title: requiredString(value, 'title'),
      detail: `${requiredString(value, 'noteType')} note`,
      status: requiredString(value, 'status'),
      occurredAt: requiredString(value, 'createdAt'),
    };
  }
  if (kind === 'vitals') {
    const measurements = [
      nullableNumber(value, 'systolicMmhg') !== null && nullableNumber(value, 'diastolicMmhg') !== null
        ? `BP ${nullableNumber(value, 'systolicMmhg')}/${nullableNumber(value, 'diastolicMmhg')} mmHg`
        : '',
      nullableNumber(value, 'temperatureC') !== null ? `Temp ${nullableNumber(value, 'temperatureC')} °C` : '',
      nullableNumber(value, 'pulseBpm') !== null ? `Pulse ${nullableNumber(value, 'pulseBpm')} bpm` : '',
      nullableNumber(value, 'oxygenSaturationPercent') !== null ? `SpO₂ ${nullableNumber(value, 'oxygenSaturationPercent')}%` : '',
    ].filter(Boolean);
    return {
      id, kind,
      title: 'Vitals recorded',
      detail: measurements.join(' • ') || 'Clinical measurements recorded',
      occurredAt: requiredString(value, 'recordedAt'),
    };
  }
  if (kind === 'diagnosis') {
    return {
      id, kind,
      title: requiredString(value, 'display'),
      detail: `${requiredString(value, 'codeSystem')} • ${requiredString(value, 'code')}`,
      status: requiredString(value, 'clinicalStatus'),
      occurredAt: requiredString(value, 'createdAt'),
    };
  }
  if (kind === 'prescription') {
    const dose = nullableNumber(value, 'doseQuantity');
    const doseUnit = optionalString(value, 'doseUnit');
    return {
      id, kind,
      title: requiredString(value, 'medicationDisplay'),
      detail: [dose !== null && doseUnit ? `${dose} ${doseUnit}` : '', requiredString(value, 'frequency')].filter(Boolean).join(' • '),
      status: requiredString(value, 'status'),
      occurredAt: requiredString(value, 'createdAt'),
    };
  }
  return {
    id, kind,
    title: requiredString(value, 'testDisplay'),
    detail: `${requiredString(value, 'testCode')} • ${requiredString(value, 'priority').toUpperCase()}`,
    status: requiredString(value, 'status'),
    occurredAt: requiredString(value, 'createdAt'),
  };
};

const parseClinicalPage = (
  payload: unknown,
  kind: ClinicalRecordKind,
  patientId: string,
  encounterId: string,
): TimelinePage<ClinicalRecordSummary> => {
  const value = unwrapData(payload);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw invalidResponse('The clinical timeline response is malformed.');
  }
  return {
    items: value.items.map((item) => clinicalRecordSummary(item, kind, patientId, encounterId)),
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
  };
};

const clinicalPath = (patientId: string, encounterId?: string): string => {
  const patient = requireUuid(patientId, 'Patient identifier');
  const base = `/api/v1/ehr/patients/${patient}/encounters`;
  return encounterId ? `${base}/${requireUuid(encounterId, 'Encounter identifier')}` : base;
};

const createClinicalResource = async (
  path: string,
  input: unknown,
  idempotencyKey: string,
): Promise<ClinicalCreateResult> => {
  const payload = await apiRequest<unknown>(path, {
    method: 'POST',
    body: input,
    requireFacility: true,
    purposeOfUse: 'direct-care',
    idempotencyKey,
  });
  return parseCreateResult(payload);
};

interface UploadIntentResponse {
  documentId: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
}

const pendingUploads = new Map<string, { intent: UploadIntentResponse; uploaded: boolean }>();

const sha256Hex = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const parseUploadIntent = (payload: unknown): UploadIntentResponse => {
  const value = unwrapData(payload);
  if (!isRecord(value) || !isRecord(value.document) || !isRecord(value.upload)) {
    throw invalidResponse('The document upload response is malformed.');
  }
  if (value.upload.method !== 'PUT' || !isRecord(value.upload.requiredHeaders)) {
    throw invalidResponse('The document upload method is invalid.');
  }
  const requiredHeaders: Record<string, string> = {};
  Object.entries(value.upload.requiredHeaders).forEach(([name, headerValue]) => {
    if (typeof headerValue !== 'string') throw invalidResponse('A document upload header is invalid.');
    requiredHeaders[name] = headerValue;
  });
  return {
    documentId: requiredString(value.document, 'id'),
    uploadUrl: requiredString(value.upload, 'url'),
    requiredHeaders,
  };
};

export const newIdempotencyKey = (): string => crypto.randomUUID();

export const clinicalApi = {
  async listDocuments(patientId: string, encounterId: string, signal?: AbortSignal): Promise<ClinicalDocumentRecord[]> {
    const expectedPatient = requireUuid(patientId, 'Patient identifier');
    const expectedEncounter = requireUuid(encounterId, 'Encounter identifier');
    const query = new URLSearchParams({ patientId: expectedPatient, encounterId: expectedEncounter });
    const payload = await apiRequest<unknown>(`/api/v1/ehr/documents?${query}`, {
      signal, requireFacility: true, purposeOfUse: 'direct-care',
    });
    const value = unwrapData(payload);
    if (!isRecord(value) || !Array.isArray(value.items)) throw invalidResponse('The document list response is malformed.');
    return value.items.map((item): ClinicalDocumentRecord => {
      if (!isRecord(item)) throw invalidResponse('A document list item is malformed.');
      const itemPatient = requireUuid(requiredString(item, 'patientId'), 'Patient identifier');
      const itemEncounter = requireUuid(requiredString(item, 'encounterId'), 'Encounter identifier');
      if (itemPatient !== expectedPatient || itemEncounter !== expectedEncounter) {
        throw invalidResponse('A document does not match the active patient and encounter context.');
      }
      return {
        id: requireUuid(requiredString(item, 'id'), 'Document identifier'), patientId: itemPatient,
        encounterId: itemEncounter, fileName: requiredString(item, 'fileName'), mediaType: requiredString(item, 'mediaType'),
        sizeBytes: Number(item.sizeBytes), status: requiredString(item, 'status'), scanStatus: requiredString(item, 'scanStatus'),
        version: Number(item.version), createdAt: requiredString(item, 'createdAt'),
      };
    });
  },

  async documentDownload(documentId: string, signal?: AbortSignal): Promise<{ url: string; expiresAt: string | null }> {
    const payload = await apiRequest<unknown>(`/api/v1/ehr/documents/${requireUuid(documentId, 'Document identifier')}/download`, {
      signal, requireFacility: true, purposeOfUse: 'direct-care',
    });
    const value = unwrapData(payload);
    if (!isRecord(value)) throw invalidResponse('The document download response is malformed.');
    return { url: requiredString(value, 'url'), expiresAt: optionalString(value, 'expiresAt') ?? null };
  },
  async listEncounters(patientId: string, signal?: AbortSignal): Promise<TimelinePage<EncounterRecord>> {
    const payload = await apiRequest<unknown>(`${clinicalPath(patientId)}?limit=50`, {
      signal,
      requireFacility: true,
      purposeOfUse: 'direct-care',
    });
    return parseEncounterPage(payload, patientId);
  },

  async createEncounter(patientId: string, input: CreateEncounterInput, key: string): Promise<EncounterRecord> {
    const payload = await apiRequest<unknown>(clinicalPath(patientId), {
      method: 'POST', body: input, requireFacility: true, purposeOfUse: 'direct-care', idempotencyKey: key,
    });
    return parseEncounter(payload, patientId);
  },

  async listRecords(
    patientId: string,
    encounterId: string,
    kind: ClinicalRecordKind,
    signal?: AbortSignal,
  ): Promise<TimelinePage<ClinicalRecordSummary>> {
    const segment = kind === 'note' ? 'clinical-notes'
      : kind === 'vitals' ? 'vitals'
        : kind === 'diagnosis' ? 'diagnoses'
          : kind === 'prescription' ? 'prescriptions'
            : 'lab-requests';
    const payload = await apiRequest<unknown>(`${clinicalPath(patientId, encounterId)}/${segment}?limit=50`, {
      signal,
      requireFacility: true,
      purposeOfUse: 'direct-care',
    });
    return parseClinicalPage(payload, kind, patientId, encounterId);
  },

  createNote(patientId: string, encounterId: string, input: CreateClinicalNoteInput, key: string) {
    return createClinicalResource(`${clinicalPath(patientId, encounterId)}/clinical-notes`, input, key);
  },

  createVital(patientId: string, encounterId: string, input: CreateVitalInput, key: string) {
    return createClinicalResource(`${clinicalPath(patientId, encounterId)}/vitals`, input, key);
  },

  createDiagnosis(patientId: string, encounterId: string, input: CreateDiagnosisInput, key: string) {
    return createClinicalResource(`${clinicalPath(patientId, encounterId)}/diagnoses`, input, key);
  },

  createPrescription(patientId: string, encounterId: string, input: CreatePrescriptionInput, key: string) {
    return createClinicalResource(`${clinicalPath(patientId, encounterId)}/prescriptions`, input, key);
  },

  async createLabRequest(patientId: string, encounterId: string, input: CreateLabRequestInput, key: string): Promise<LabRequestCreateResult> {
    const payload = await apiRequest<any>(`${clinicalPath(patientId, encounterId)}/lab-requests`, {
      method: 'POST', body: input, requireFacility: true, purposeOfUse: 'direct-care', idempotencyKey: key,
    });
    const base = parseCreateResult(payload);
    const item = payload?.labWorkItem;
    if (item == null) return { ...base, labWorkItem: null };
    if (typeof item.id !== 'string' || item.status !== 'accepted' || typeof item.sourceEhrOrderId !== 'string'
      || typeof item.sourceEhrOrderVersion !== 'number' || typeof item.acceptedAt !== 'string') throw new Error('Invalid Lab acceptance response');
    return { ...base, labWorkItem: item };
  },

  async uploadDocument(
    patientId: string,
    encounterId: string,
    file: File,
    options: DocumentUploadOptions,
    key: string,
  ): Promise<ClinicalCreateResult> {
    requireUuid(patientId, 'Patient identifier');
    requireUuid(encounterId, 'Encounter identifier');
    if (!ALLOWED_DOCUMENT_TYPES.has(file.type) || file.size < 1 || file.size > MAX_DOCUMENT_SIZE) {
      throw new ApiProblemError({
        title: 'Invalid document',
        detail: 'Use a PDF, JPEG, PNG, or TIFF file no larger than 50 MiB.',
        status: 400,
      });
    }

    let pending = pendingUploads.get(key);
    if (!pending) {
      const payload = await apiRequest<unknown>('/api/v1/ehr/documents/upload-intents', {
        method: 'POST',
        body: {
          patientId,
          encounterId,
          fileName: file.name,
          mediaType: file.type,
          sizeBytes: file.size,
          sha256Hex: await sha256Hex(file),
          classification: options.classification,
          retentionClass: options.retentionClass,
        },
        requireFacility: true,
        purposeOfUse: 'direct-care',
        idempotencyKey: key,
      });
      pending = { intent: parseUploadIntent(payload), uploaded: false };
      pendingUploads.set(key, pending);
    }

    if (!pending.uploaded) {
      let uploadResponse: Response;
      try {
        uploadResponse = await fetchWithTimeout(pending.intent.uploadUrl, {
          method: 'PUT',
          headers: pending.intent.requiredHeaders,
          body: file,
          credentials: 'omit',
        }, 60_000);
      } catch (error: unknown) {
        if (error instanceof HidRequestTimeoutError) {
          throw new ApiProblemError({
            title: 'Document upload timed out',
            detail: 'The encrypted object store did not accept the document in time.',
            status: 0,
          });
        }
        throw error;
      }
      if (!uploadResponse.ok) {
        // The intent endpoint is idempotent and will return a fresh presigned URL for
        // the same document. Discard a rejected URL so an unchanged form can retry.
        pendingUploads.delete(key);
        throw new ApiProblemError({
          title: 'Document upload failed',
          detail: 'The encrypted object store did not accept the document.',
          status: uploadResponse.status,
        });
      }
      pending.uploaded = true;
    }

    await apiRequest<unknown>(`/api/v1/ehr/documents/${pending.intent.documentId}/complete`, {
      method: 'POST', requireFacility: true, purposeOfUse: 'direct-care',
    });
    pendingUploads.delete(key);
    return { id: pending.intent.documentId };
  },
};

export const labApi = {
  listWorkItems: () => apiRequest<any>('/api/v1/lab/work-items', { requireFacility:true,purposeOfUse:'direct-care' }),
  createAccession: (workItemId:string,input:{requirements:{specimenType:string;containerType?:string}[];reason:string},key:string) =>
    apiRequest<any>(`/api/v1/lab/work-items/${requireUuid(workItemId,'Lab work-item identifier')}/accession`,
      {method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
  getAccession: (accessionId:string) => apiRequest<any>(`/api/v1/lab/accessions/${requireUuid(accessionId,'Accession identifier')}`,
    {requireFacility:true,purposeOfUse:'direct-care'}),
  collectSpecimen: (accessionId:string,specimenId:string,input:{expectedVersion:number;collectedAt:string;notes?:string},key:string) =>
    apiRequest<any>(`/api/v1/lab/accessions/${requireUuid(accessionId,'Accession identifier')}/specimens/${requireUuid(specimenId,'Specimen identifier')}/collect`,
      {method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
  receiveSpecimen: (accessionId:string,specimenId:string,input:{expectedVersion:number;receivedAt:string;condition?:string},key:string) =>
    apiRequest<any>(`/api/v1/lab/accessions/${requireUuid(accessionId,'Accession identifier')}/specimens/${requireUuid(specimenId,'Specimen identifier')}/receive`,
      {method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
  rejectSpecimen: (accessionId:string,specimenId:string,input:{expectedVersion:number;reason:string},key:string) =>
    apiRequest<any>(`/api/v1/lab/accessions/${requireUuid(accessionId,'Accession identifier')}/specimens/${requireUuid(specimenId,'Specimen identifier')}/reject`,
      {method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
  listExecutions: (specimenId:string) => apiRequest<any>(`/api/v1/lab/specimens/${requireUuid(specimenId,'Specimen identifier')}/executions`,{requireFacility:true,purposeOfUse:'direct-care'}),
  startExecution: (specimenId:string,input:{expectedSpecimenVersion:number;startedAt:string;method?:string;reason:string},key:string) => apiRequest<any>(`/api/v1/lab/specimens/${requireUuid(specimenId,'Specimen identifier')}/executions`,{method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
  completeExecution: (executionId:string,input:{expectedVersion:number;completedAt:string;notes?:string},key:string) => apiRequest<any>(`/api/v1/lab/executions/${requireUuid(executionId,'Execution identifier')}/complete`,{method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
  enterResult: (executionId:string,input:{expectedExecutionVersion:number;resultType:'numeric'|'text';numericValue?:number;textValue?:string;unit?:string;referenceRange?:string;abnormalFlag?:string},key:string) => apiRequest<any>(`/api/v1/lab/executions/${requireUuid(executionId,'Execution identifier')}/results`,{method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
  correctResult: (executionId:string,resultId:string,input:any,key:string) => apiRequest<any>(`/api/v1/lab/executions/${requireUuid(executionId,'Execution identifier')}/results/${requireUuid(resultId,'Result identifier')}/corrections`,{method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
  verifyResult: (resultId:string,input:any,key:string) => apiRequest<any>(`/api/v1/lab/results/${requireUuid(resultId,'Result identifier')}/verify`,{method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
  releaseResult: (resultId:string,input:any,key:string) => apiRequest<any>(`/api/v1/lab/results/${requireUuid(resultId,'Result identifier')}/release`,{method:'POST',body:input,requireFacility:true,purposeOfUse:'direct-care',idempotencyKey:key}),
};

const sharedOcrApi = new OcrApiClient({
  transport: ({ path, method, body, idempotencyKey, purposeOfUse, signal }) =>
    apiRequest<unknown>(path, { method, body, idempotencyKey, purposeOfUse,
      signal, requireFacility: true }),
});

export const ocrApi = {
  async createJob(documentId: string, patientId: string, key: string, signal?: AbortSignal): Promise<OcrJob> {
    return sharedOcrApi.createJob({ documentId: requireUuid(documentId, 'Document identifier'),
      patientId: requireUuid(patientId, 'Patient identifier'), provider: 'textract',
      purpose: 'healthcare-operations' }, key, signal);
  },
  async findJob(documentId: string, signal?: AbortSignal): Promise<OcrJob | null> {
    return sharedOcrApi.findJob(requireUuid(documentId, 'Document identifier'), signal);
  },
  async getJob(jobId: string, signal?: AbortSignal): Promise<OcrJob> {
    return sharedOcrApi.getJob(requireUuid(jobId, 'OCR job identifier'), signal);
  },
  async listExtractions(jobId: string, signal?: AbortSignal): Promise<OcrExtraction[]> {
    return sharedOcrApi.listExtractions(requireUuid(jobId, 'OCR job identifier'), signal);
  },
  async listValidations(jobId: string, signal?: AbortSignal): Promise<OcrValidation[]> {
    return sharedOcrApi.listValidations(requireUuid(jobId, 'OCR job identifier'), signal);
  },
  async validate(jobId: string, input: OcrValidationInput, key: string, signal?: AbortSignal): Promise<void> {
    await sharedOcrApi.validate(requireUuid(jobId, 'OCR job identifier'), input, key, signal);
  },
  async confirmPatient(jobId: string, input: OcrPatientConfirmationInput, key: string, signal?: AbortSignal): Promise<OcrPatientConfirmation> {
    return sharedOcrApi.confirmPatient(requireUuid(jobId, 'OCR job identifier'), input, key, signal);
  },
  async publish(validationId: string, input: OcrPublicationInput, key: string,
    signal?: AbortSignal): Promise<OcrPublicationResult> {
    return sharedOcrApi.publish(requireUuid(validationId, 'OCR validation identifier'), input, key, signal);
  },
  async listPublications(validationId: string, signal?: AbortSignal): Promise<OcrPublicationResult[]> {
    return sharedOcrApi.listPublications(
      requireUuid(validationId, 'OCR validation identifier'), signal,
    );
  },
};
