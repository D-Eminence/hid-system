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

export interface PatientLabPage {
  records: Array<{id:string;version:string;title:string;recordedAt:string;effectiveAt:string|null;fields:Record<string,unknown>}>;
  nextCursor: string | null;
}

/** One imported (OCR or external) Lab report with its transcribed observations, as GET /api/v1/lab/imports returns it. */
export interface LabImportedEvidence {
  id: string; patientId: string; facilityId: string; sourceType: 'IMPORTED_EXTERNAL'; status: string;
  externalLabName: string | null; externalReference: string | null;
  collectedAt: string | null; reportedAt: string | null; receivedAt: string;
  sourceDocumentId: string; ocrJobId: string | null; extractionId: string | null;
  validationId: string | null; validationVersion: number | null; publicationId: string | null;
  version: number; createdAt: string;
  observations: Array<{ id: string; ordinal: number; testCode: string | null; testName: string; value: string | null;
    valueText: string | null; unit: string | null; referenceRange: string | null; abnormalFlag: string;
    reportedAt: string | null; status: string; createdAt: string }>;
}

export interface LabImportedEvidencePage {
  records: LabImportedEvidence[];
  nextCursor: string | null;
}

/** GET /api/v1/lab/imports page size bounds (lab-api ListLabImportsQueryDto). */
export const LAB_IMPORT_PAGE_MAX = 50;

/** The provenance every record from another facility carries (0124). */
export const OTHER_FACILITY_PROVENANCE = 'imported-from-paper-other-facility';

/**
 * One imported (paper, OCR) Lab report from ANOTHER facility, as
 * GET /api/v1/lab/imports/other-facilities returns it (0124): shown only under
 * a patient share that includes other facilities. Unverified; show it with its
 * source facility named.
 */
export interface LabOtherFacilityImportedEvidence {
  id: string; sourceFacilityId: string; sourceFacilityName: string; status: string;
  externalLabName: string | null; externalReference: string | null;
  collectedAt: string | null; reportedAt: string | null; receivedAt: string; createdAt: string;
  observations: Array<{ ordinal: number; testCode: string | null; testName: string; value: string | null;
    valueText: string | null; unit: string | null; referenceRange: string | null; abnormalFlag: string;
    reportedAt: string | null }>;
  provenance: typeof OTHER_FACILITY_PROVENANCE;
}

export interface LabOtherFacilityImportedEvidencePage {
  records: LabOtherFacilityImportedEvidence[];
  /** Opaque; pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
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

  async patientReleasedResults(context: LabRequestContext, cursor?: string, signal?: AbortSignal): Promise<PatientLabPage> {
    return this.releasedPage('/api/v1/lab/internal/me/released-results',context,cursor,signal);
  }

  async staffReleasedResults(patientId:string,context:LabRequestContext,cursor?:string,signal?:AbortSignal):Promise<PatientLabPage> {
    return this.releasedPage('/api/v1/lab/internal/patients/'+encodeURIComponent(patientId)+'/released-results',context,cursor,signal);
  }

  private async releasedPage(path:string,context:LabRequestContext,cursor?:string,signal?:AbortSignal):Promise<PatientLabPage> {
    const value=await this.request(path+(cursor?'?cursor='+encodeURIComponent(cursor):''),'GET',undefined,context,undefined,'ehr-api',signal);
    const page=value as PatientLabPage;
    if (!page || !Array.isArray(page.records) || page.records.length>200
      || (page.nextCursor!==null && (typeof page.nextCursor!=='string' || !/^[a-f0-9-]{36}$/i.test(page.nextCursor)))
      || page.records.some(r=> !r || !/^[a-f0-9-]{36}$/i.test(r.id) || typeof r.version!=='string'
        || typeof r.title!=='string' || typeof r.recordedAt!=='string' || !Number.isFinite(Date.parse(r.recordedAt))
        || (r.effectiveAt!==null && (typeof r.effectiveAt!=='string' || !Number.isFinite(Date.parse(r.effectiveAt))))
        || !r.fields || typeof r.fields!=='object' || Array.isArray(r.fields))) throw new LabApiProblem(502,{code:'INVALID_PATIENT_RESULT_RESPONSE'});
    return page;
  }

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

  /**
   * One patient's imported Lab evidence, newest received first. A staff read
   * (lab.import.read and the patient's read_records decision), sent with the
   * user's credentials and no internal caller.
   */
  async patientImports(patientId: string, context: LabRequestContext,
    page: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<LabImportedEvidencePage> {
    const query = new URLSearchParams({ patientId });
    if (page.cursor) query.set('cursor', page.cursor);
    if (page.limit !== undefined) query.set('limit', String(page.limit));
    const value = await this.request('/api/v1/lab/imports?' + query.toString(), 'GET', undefined, context,
      undefined, undefined, signal) as LabImportedEvidencePage;
    if (!value || !Array.isArray(value.records) || value.records.length > LAB_IMPORT_PAGE_MAX
      || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.nextCursor)))
      || value.records.some((record) => !record || typeof record.id !== 'string' || record.patientId !== patientId
        || !Array.isArray(record.observations))) {
      throw new LabApiProblem(502, { code: 'INVALID_LAB_IMPORT_RESPONSE' });
    }
    return value;
  }

  /**
   * One patient's imported Lab evidence from OTHER facilities, newest received
   * first (0124): only under an active patient share to the caller that
   * includes other facilities; 403 OTHER_FACILITIES_NOT_SHARED otherwise. A
   * staff read sent with the user's credentials and no internal caller.
   */
  async labOtherFacilityImports(patientId: string, context: LabRequestContext,
    page: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<LabOtherFacilityImportedEvidencePage> {
    const query = new URLSearchParams({ patientId });
    if (page.cursor) query.set('cursor', page.cursor);
    if (page.limit !== undefined) query.set('limit', String(page.limit));
    const value = await this.request('/api/v1/lab/imports/other-facilities?' + query.toString(), 'GET', undefined,
      context, undefined, undefined, signal) as LabOtherFacilityImportedEvidencePage;
    // Never pass on more than a page, the caller's own facility's record, or one without its provenance.
    if (!value || !Array.isArray(value.records) || value.records.length > LAB_IMPORT_PAGE_MAX
      || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.nextCursor)))
      || value.records.some((record) => !record || typeof record.id !== 'string'
        || typeof record.sourceFacilityId !== 'string' || record.sourceFacilityId === context.facilityId
        || typeof record.sourceFacilityName !== 'string' || record.provenance !== OTHER_FACILITY_PROVENANCE
        || !Array.isArray(record.observations))) {
      throw new LabApiProblem(502, { code: 'INVALID_LAB_IMPORT_RESPONSE' });
    }
    return value;
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
