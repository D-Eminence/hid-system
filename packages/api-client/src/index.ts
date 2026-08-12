export interface HidHttpRequestOptions {
  baseUrl: string;
  path: string;
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  credentials?: RequestCredentials;
}

export interface HidHttpResponse {
  response: Response;
  payload: unknown;
}

export class HidRequestTimeoutError extends Error {
  constructor() {
    super('The HID API request timed out.');
    this.name = 'HidRequestTimeoutError';
  }
}

export class HidInvalidJsonError extends Error {
  constructor() {
    super('The HID API returned invalid JSON.');
    this.name = 'HidInvalidJsonError';
  }
}

export function normalizeApiBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

export function apiUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizeApiBaseUrl(baseUrl)}${normalizedPath}`;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const sourceSignal = init.signal;
  const forwardAbort = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) forwardAbort();
  else sourceSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = globalThis.setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new HidRequestTimeoutError();
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    sourceSignal?.removeEventListener('abort', forwardAbort);
  }
}

export async function requestJson(options: HidHttpRequestOptions): Promise<HidHttpResponse> {
  const response = await fetchWithTimeout(apiUrl(options.baseUrl, options.path), {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: options.credentials ?? 'include',
    cache: 'no-store',
    signal: options.signal,
  }, options.timeoutMs);
  const payload = await readJson(response);
  return { response, payload };
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return undefined;
    throw new HidInvalidJsonError();
  }
}

export { LabApiClient, LabApiProblem } from './lab';
export type {
  LabClientOptions,
  LabInternalCaller,
  LabRequestContext,
  LabResourceReference,
} from './lab';
export { PharmacyApiClient, PharmacyApiProblem } from './pharmacy';
export type {
  CreatePharmacyDispensingInput,
  PharmacyDispensing,
  PharmacyDispensingReversal,
  PharmacyImportedMedicationEvidence,
  PharmacyClientOptions,
  PharmacyInternalCaller,
  PharmacyMedicationReference,
  PharmacyRequestContext,
  PharmacyResourceReference,
  PharmacyWorkItem,
  ReversePharmacyDispensingInput,
} from './pharmacy';
export { EhrApiClient, EhrApiProblem } from './ehr';
export type {
  EhrClientOptions, EhrInternalCaller, EhrOcrClinicalNoteImport, EhrOcrDocumentSource,
  EhrRequestContext, EhrResourceReference,
} from './ehr';
export { OcrApiClient, OcrContractError } from './ocr';
export type {
  OcrCandidateType, OcrClientOptions, OcrCreateJobInput, OcrExtraction, OcrJob,
  OcrPatientConfirmation, OcrPatientConfirmationInput, OcrPublicationInput,
  OcrPublicationResult, OcrRetryInput, OcrTargetDomain, OcrTransport, OcrTransportRequest,
  OcrValidation, OcrValidationInput,
} from './ocr';
export { OutreachApiClient, OutreachApiProblem } from './outreach';
export type {
  CreateOutreachRegistrationCase,
  LinkOutreachExistingPatient,
  OutreachClientOptions,
  OutreachRegistrationCase,
  OutreachRequestContext,
} from './outreach';
export { IdentityApiClient, IdentityApiProblem } from './identity';
export type {
  IdentityActorContext,
  IdentityAuthorizationDecision,
  IdentityClientOptions,
  IdentityDelegatedContext,
  IdentityFacilityAssignment,
  IdentityInternalCaller,
  IdentityRegistrationCase,
  ResolveNinRegistration,
} from './identity';
