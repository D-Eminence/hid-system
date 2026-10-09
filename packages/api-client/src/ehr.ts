import { requestJson } from './index';

export type EhrInternalCaller = 'ocr-api';

export interface EhrRequestContext {
  correlationId: string;
  facilityId: string;
  purposeOfUse: string;
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
  origin?: string;
}

export interface EhrClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  internalServiceToken?: string;
  serviceAuthorizationProvider?: (caller: EhrInternalCaller) => Promise<string>;
}

export interface EhrOcrDocumentSource {
  id: string;
  patientId: string;
  facilityId: string;
  objectVersionId: string | null;
  sha256Hex: string | null;
  status: string;
  scanStatus: string;
}

export interface EhrOcrClinicalNoteImport {
  encounterId: string;
  noteType: string;
  title: string;
  content: string;
  publicationId: string;
  documentId: string;
  ocrJobId: string;
  extractionId: string;
  validationId: string;
  validationVersion: number;
  reviewedBy: string;
}

export interface EhrResourceReference { id: string; }

export class EhrApiProblem extends Error {
  constructor(readonly status: number, readonly payload: unknown) {
    super(typeof payload === 'object' && payload !== null && 'detail' in payload
      ? String((payload as { detail: unknown }).detail)
      : `EHR API request failed (${status})`);
    this.name = 'EhrApiProblem';
  }
}

export class EhrApiClient {
  constructor(private readonly options: EhrClientOptions) {}

  async getOcrDocumentSource(
    documentId: string,
    context: EhrRequestContext,
    signal?: AbortSignal,
  ): Promise<EhrOcrDocumentSource> {
    const result = await this.request(
      `/api/v1/ehr/internal/ocr/documents/${encodeURIComponent(documentId)}/source`,
      'GET', undefined, context, undefined, signal,
    );
    if (!isRecord(result) || typeof result.id !== 'string'
        || typeof result.patientId !== 'string' || typeof result.facilityId !== 'string'
        || typeof result.status !== 'string' || typeof result.scanStatus !== 'string') {
      throw new EhrApiProblem(502, result);
    }
    return result as unknown as EhrOcrDocumentSource;
  }

  async createOcrClinicalNote(
    patientId: string,
    input: EhrOcrClinicalNoteImport,
    context: EhrRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<EhrResourceReference> {
    const result = await this.request(
      `/api/v1/ehr/internal/ocr/patients/${encodeURIComponent(patientId)}/clinical-notes`,
      'POST', input, context, idempotencyKey, signal,
    );
    if (!isRecord(result) || typeof result.id !== 'string') throw new EhrApiProblem(502, result);
    return { id: result.id };
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    context: EhrRequestContext,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const attempts = idempotencyKey ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const serviceAuthorization = this.options.serviceAuthorizationProvider
          ? await this.options.serviceAuthorizationProvider('ocr-api') : undefined;
        const { response, payload } = await requestJson({
          baseUrl: this.options.baseUrl, path, method, body, signal,
          timeoutMs: this.options.timeoutMs ?? 10_000, credentials: 'omit',
          headers: {
            'content-type': 'application/json',
            'x-correlation-id': context.correlationId,
            'x-facility-id': context.facilityId,
            'x-purpose-of-use': context.purposeOfUse,
            'x-hid-internal-caller': 'ocr-api',
            ...(context.authorization ? { authorization: context.authorization } : {}),
            ...(context.cookie ? { cookie: context.cookie } : {}),
            ...(context.csrfToken ? { 'x-csrf-token': context.csrfToken } : {}),
            ...(context.origin ? { origin: context.origin } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
            ...(serviceAuthorization
              ? { 'x-hid-service-authorization': serviceAuthorization }
              : { 'x-hid-service-token': this.options.internalServiceToken ?? '' }),
          },
        });
        if (!response.ok) {
          if (attempt < attempts && [502, 503, 504].includes(response.status)) continue;
          throw new EhrApiProblem(response.status, payload);
        }
        return unwrap(payload);
      } catch (error) {
        lastError = error;
        if (signal?.aborted || error instanceof EhrApiProblem || attempt >= attempts) throw error;
      }
    }
    throw lastError;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrap(value: unknown): unknown {
  return isRecord(value) && 'data' in value ? value.data : value;
}
