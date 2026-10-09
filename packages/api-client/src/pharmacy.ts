import { requestJson } from './index';

export type PharmacyInternalCaller = 'ehr-api' | 'ocr-api';

export interface PharmacyRequestContext {
  correlationId: string;
  facilityId: string;
  purposeOfUse: string;
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
  origin?: string;
}

export interface PharmacyClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  internalServiceToken?: string;
  serviceAuthorizationProvider?: (caller: PharmacyInternalCaller) => Promise<string>;
}

export interface PharmacyResourceReference {
  id: string;
}

export interface PharmacyMedicationReference {
  codeSystem: string | null;
  code: string | null;
  display: string;
}

export interface PharmacyWorkItem {
  id: string;
  patientId: string;
  facilityId: string;
  sourceEhrPrescriptionId: string;
  sourceEhrPrescriptionVersion: number;
  sourceEncounterId: string;
  status: 'accepted';
  medication: PharmacyMedicationReference;
  doseQuantity: number | null;
  doseUnit: string | null;
  routeCode: string | null;
  frequency: string;
  instructions: string;
  acceptedAt: string;
  version: number;
  dispensing: { id: string; status: 'dispensed'; reversed: boolean } | null;
}

export interface PharmacyDispensing {
  id: string;
  workItemId: string;
  patientId: string;
  facilityId: string;
  status: 'dispensed';
  effectiveStatus: 'dispensed' | 'reversed';
  medication: PharmacyMedicationReference;
  quantityDispensed: number;
  quantityUnit: string;
  dispensedAt: string;
  reversalId: string | null;
  version: number;
}

export interface PharmacyDispensingReversal {
  id: string;
  dispensingId: string;
  workItemId: string;
  patientId: string;
  facilityId: string;
  status: 'reversed';
  reversedAt: string;
  version: number;
}

export interface PharmacyImportedMedicationEvidence {
  id: string;
  patientId: string;
  facilityId: string;
  sourceType: 'IMPORTED_MEDICATION_EVIDENCE';
  activityStatus: 'unknown';
  medicationText: string;
  strengthText: string | null;
  doseText: string | null;
  frequencyText: string | null;
  historicalContext: string | null;
  sourceDocumentId: string;
  ocrJobId: string;
  extractionId: string;
  validationId: string;
  validationVersion: number;
  publicationId: string;
  version: number;
  createdAt: string;
}

export interface CreatePharmacyDispensingInput {
  expectedWorkItemVersion: number;
  quantityDispensed: number;
  quantityUnit: string;
  reason: string;
}

export interface ReversePharmacyDispensingInput {
  expectedDispensingVersion: number;
  reason: string;
}

export class PharmacyApiProblem extends Error {
  constructor(readonly status: number, readonly payload: unknown) {
    super(typeof payload === 'object' && payload !== null && 'detail' in payload
      ? String((payload as { detail: unknown }).detail)
      : `Pharmacy API request failed (${status})`);
    this.name = 'PharmacyApiProblem';
  }
}

export class PharmacyApiClient {
  constructor(private readonly options: PharmacyClientOptions) {}

  async acceptEhrPrescription(
    input: unknown,
    context: PharmacyRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PharmacyResourceReference> {
    return this.resourceCommand(
      '/api/v1/pharmacy/work-items/accept-ehr-prescription',
      input,
      context,
      idempotencyKey,
      'ehr-api',
      signal,
    );
  }

  async createOcrImport(
    input: unknown,
    context: PharmacyRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PharmacyResourceReference> {
    return this.resourceCommand(
      '/api/v1/pharmacy/imports/from-ocr',
      input,
      context,
      idempotencyKey,
      'ocr-api',
      signal,
    );
  }

  get(path: string, context: PharmacyRequestContext, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, 'GET', undefined, context, undefined, undefined, signal);
  }

  async listWorkItems(context: PharmacyRequestContext, signal?: AbortSignal): Promise<PharmacyWorkItem[]> {
    const value = record(await this.get('/api/v1/pharmacy/work-items', context, signal), 'Pharmacy work queue');
    if (!Array.isArray(value.items)) throw new PharmacyApiProblem(502, value);
    return value.items.map(parseWorkItem);
  }

  async getWorkItem(workItemId: string, context: PharmacyRequestContext,
    signal?: AbortSignal): Promise<PharmacyWorkItem> {
    return parseWorkItem(await this.get(
      `/api/v1/pharmacy/work-items/${encodeURIComponent(workItemId)}`, context, signal));
  }

  async dispense(workItemId: string, input: CreatePharmacyDispensingInput,
    context: PharmacyRequestContext, idempotencyKey: string,
    signal?: AbortSignal): Promise<PharmacyDispensing> {
    return parseDispensing(await this.request(
      `/api/v1/pharmacy/work-items/${encodeURIComponent(workItemId)}/dispensings`,
      'POST', input, context, idempotencyKey, undefined, signal));
  }

  async getDispensing(dispensingId: string, context: PharmacyRequestContext,
    signal?: AbortSignal): Promise<PharmacyDispensing> {
    return parseDispensing(await this.get(
      `/api/v1/pharmacy/dispensings/${encodeURIComponent(dispensingId)}`, context, signal));
  }

  async reverseDispensing(dispensingId: string, input: ReversePharmacyDispensingInput,
    context: PharmacyRequestContext, idempotencyKey: string,
    signal?: AbortSignal): Promise<PharmacyDispensingReversal> {
    return parseReversal(await this.request(
      `/api/v1/pharmacy/dispensings/${encodeURIComponent(dispensingId)}/reversals`,
      'POST', input, context, idempotencyKey, undefined, signal));
  }

  async getImportedMedicationEvidence(importId: string, context: PharmacyRequestContext,
    signal?: AbortSignal): Promise<PharmacyImportedMedicationEvidence> {
    return parseImport(await this.get(
      `/api/v1/pharmacy/imports/${encodeURIComponent(importId)}`, context, signal));
  }

  private async resourceCommand(
    path: string,
    body: unknown,
    context: PharmacyRequestContext,
    idempotencyKey: string,
    caller: PharmacyInternalCaller,
    signal?: AbortSignal,
  ): Promise<PharmacyResourceReference> {
    const result = await this.request(path, 'POST', body, context, idempotencyKey, caller, signal);
    if (typeof result !== 'object' || result === null
      || typeof (result as { id?: unknown }).id !== 'string') {
      throw new PharmacyApiProblem(502, result);
    }
    return result as PharmacyResourceReference;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    context: PharmacyRequestContext,
    idempotencyKey?: string,
    caller?: PharmacyInternalCaller,
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
          credentials: caller ? 'omit' : 'include',
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
          throw new PharmacyApiProblem(response.status, payload);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || error instanceof PharmacyApiProblem || attempt >= attempts) throw error;
      }
    }
    throw lastError;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  const unwrapped = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(unwrapped)) throw new PharmacyApiProblem(502, { detail: `${label} response is malformed.` });
  return unwrapped;
}

function text(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string' || !value[key]) {
    throw new PharmacyApiProblem(502, { detail: `Pharmacy field ${key} is malformed.` });
  }
  return value[key];
}

function integer(value: Record<string, unknown>, key: string): number {
  if (typeof value[key] !== 'number' || !Number.isInteger(value[key])) {
    throw new PharmacyApiProblem(502, { detail: `Pharmacy field ${key} is malformed.` });
  }
  return value[key];
}

function finiteNumber(value: Record<string, unknown>, key: string): number {
  if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
    throw new PharmacyApiProblem(502, { detail: `Pharmacy field ${key} is malformed.` });
  }
  return value[key];
}

function nullableText(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === 'string' ? value[key] : null;
}

function parseMedication(value: unknown): PharmacyMedicationReference {
  const item = record(value, 'Pharmacy medication');
  return { codeSystem: nullableText(item, 'codeSystem'), code: nullableText(item, 'code'), display: text(item, 'display') };
}

function parseWorkItem(payload: unknown): PharmacyWorkItem {
  const value = record(payload, 'Pharmacy work item');
  const dispensing = value.dispensing === null ? null : record(value.dispensing, 'Pharmacy dispensing summary');
  return {
    id: text(value, 'id'), patientId: text(value, 'patientId'), facilityId: text(value, 'facilityId'),
    sourceEhrPrescriptionId: text(value, 'sourceEhrPrescriptionId'),
    sourceEhrPrescriptionVersion: integer(value, 'sourceEhrPrescriptionVersion'),
    sourceEncounterId: text(value, 'sourceEncounterId'), status: 'accepted',
    medication: parseMedication(value.medication),
    doseQuantity: typeof value.doseQuantity === 'number' ? value.doseQuantity : null,
    doseUnit: nullableText(value, 'doseUnit'), routeCode: nullableText(value, 'routeCode'),
    frequency: text(value, 'frequency'), instructions: text(value, 'instructions'),
    acceptedAt: text(value, 'acceptedAt'), version: integer(value, 'version'),
    dispensing: dispensing ? {
      id: text(dispensing, 'id'), status: 'dispensed', reversed: dispensing.reversed === true,
    } : null,
  };
}

function parseDispensing(payload: unknown): PharmacyDispensing {
  const value = record(payload, 'Pharmacy dispensing');
  return {
    id: text(value, 'id'), workItemId: text(value, 'workItemId'), patientId: text(value, 'patientId'),
    facilityId: text(value, 'facilityId'), status: 'dispensed',
    effectiveStatus: value.effectiveStatus === 'reversed' ? 'reversed' : 'dispensed',
    medication: parseMedication(value.medication),
    quantityDispensed: finiteNumber(value, 'quantityDispensed'),
    quantityUnit: text(value, 'quantityUnit'), dispensedAt: text(value, 'dispensedAt'),
    reversalId: nullableText(value, 'reversalId'), version: integer(value, 'version'),
  };
}

function parseReversal(payload: unknown): PharmacyDispensingReversal {
  const value = record(payload, 'Pharmacy dispensing reversal');
  return {
    id: text(value, 'id'), dispensingId: text(value, 'dispensingId'), workItemId: text(value, 'workItemId'),
    patientId: text(value, 'patientId'), facilityId: text(value, 'facilityId'), status: 'reversed',
    reversedAt: text(value, 'reversedAt'), version: integer(value, 'version'),
  };
}

function parseImport(payload: unknown): PharmacyImportedMedicationEvidence {
  const value = record(payload, 'Imported medication evidence');
  return {
    id: text(value, 'id'), patientId: text(value, 'patientId'), facilityId: text(value, 'facilityId'),
    sourceType: 'IMPORTED_MEDICATION_EVIDENCE', activityStatus: 'unknown',
    medicationText: text(value, 'medicationText'), strengthText: nullableText(value, 'strengthText'),
    doseText: nullableText(value, 'doseText'), frequencyText: nullableText(value, 'frequencyText'),
    historicalContext: nullableText(value, 'historicalContext'), sourceDocumentId: text(value, 'sourceDocumentId'),
    ocrJobId: text(value, 'ocrJobId'), extractionId: text(value, 'extractionId'),
    validationId: text(value, 'validationId'), validationVersion: integer(value, 'validationVersion'),
    publicationId: text(value, 'publicationId'), version: integer(value, 'version'),
    createdAt: text(value, 'createdAt'),
  };
}
