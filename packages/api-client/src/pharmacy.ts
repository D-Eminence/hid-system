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

/**
 * The patient on a work item: name, sex, date of birth and the last 4
 * characters of the Health ID. On this facility's own work it is sent while
 * pharmacy-api's OWN_WORK_PATIENT_CARD_ENABLED is on and the member may read
 * the work (0121); absent otherwise.
 */
export interface PharmacyWorkItemPatient {
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string | null;
}

/**
 * A work item's medicine, and on this facility's own work, while
 * pharmacy-api's PRESCRIPTION_DISPENSING_DETAILS_ENABLED is on and the
 * prescriber gave them (0122), its strength as written ("500 mg") and its
 * form (tablet, capsule, liquid, injection, cream, inhaler, drops, other).
 */
export interface PharmacyWorkItemMedication extends PharmacyMedicationReference {
  strength?: string;
  doseForm?: string;
}

export interface PharmacyWorkItem {
  id: string;
  patientId: string;
  facilityId: string;
  sourceEhrPrescriptionId: string;
  sourceEhrPrescriptionVersion: number;
  sourceEncounterId: string;
  status: 'accepted';
  medication: PharmacyWorkItemMedication;
  doseQuantity: number | null;
  doseUnit: string | null;
  routeCode: string | null;
  frequency: string;
  instructions: string;
  acceptedAt: string;
  version: number;
  dispensing: { id: string; status: 'dispensed'; reversed: boolean } | null;
  /** Present only when pharmacy-api sent it (see PharmacyWorkItemPatient). */
  patient?: PharmacyWorkItemPatient;
  /**
   * The prescription details on own work (0122), each present only when
   * pharmacy-api sent it (see PharmacyWorkItemMedication): the priority
   * (routine, urgent, asap, stat); how long it is for (a whole number of
   * days, weeks or months; from the prescription's dates when it gave none);
   * and how much to hand over with its unit, which the pharmacist confirms.
   */
  priority?: string;
  duration?: { value: number; unit: string };
  quantityToDispense?: number;
  quantityUnit?: string;
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

export interface PharmacyImportBatch {
  id: string;
  count: number;
  items: PharmacyImportedMedicationEvidence[];
}

/** One page of a patient's imported medication records, newest first. */
export interface PharmacyImportedMedicationPage {
  items: PharmacyImportedMedicationEvidence[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ListPharmacyImportedMedicationsOptions {
  /** 1-100; Pharmacy answers 50 when it is left out. */
  limit?: number;
  cursor?: string;
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

  /**
   * Several medicines from one OCR review. Pharmacy stores each as its own
   * record in one transaction (all or none) and answers every record, in the
   * order sent; `id` is the first one.
   */
  async createOcrImportBatch(
    input: unknown,
    context: PharmacyRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PharmacyImportBatch> {
    const result = await this.request('/api/v1/pharmacy/imports/from-ocr/batch', 'POST', input, context,
      idempotencyKey, 'ocr-api', signal);
    const value = record(result, 'Imported medication evidence batch');
    if (!Array.isArray(value.items) || value.items.length < 1) throw new PharmacyApiProblem(502, result);
    const items = value.items.map(parseImport);
    const count = integer(value, 'count');
    if (count !== items.length || text(value, 'id') !== items[0]?.id) throw new PharmacyApiProblem(502, result);
    return { id: items[0].id, count, items };
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

  /** One patient's imported medication records at the request's facility, newest first (GET pharmacy/imports). */
  async listImportedMedicationEvidence(patientId: string, context: PharmacyRequestContext,
    options: ListPharmacyImportedMedicationsOptions = {}, signal?: AbortSignal): Promise<PharmacyImportedMedicationPage> {
    const query = new URLSearchParams({ patientId });
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const value = record(await this.get(`/api/v1/pharmacy/imports?${query.toString()}`, context, signal),
      'Imported medication evidence page');
    if (!Array.isArray(value.items)) throw new PharmacyApiProblem(502, value);
    if (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor)) {
      throw new PharmacyApiProblem(502, value);
    }
    // Never pass on more than a page, or a record of another patient, to the chart.
    if (value.items.length > 100) throw new PharmacyApiProblem(502, { code: 'INVALID_PHARMACY_IMPORT_RESPONSE' });
    const items = value.items.map(parseImport);
    if (items.some((item) => item.patientId !== patientId)) {
      throw new PharmacyApiProblem(502, { code: 'INVALID_PHARMACY_IMPORT_RESPONSE' });
    }
    return { items, nextCursor: value.nextCursor };
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

/**
 * The optional prescription details (0122): each left out when absent; a
 * malformed one is refused like any other field.
 */
function parseWorkItemDetails(value: Record<string, unknown>): Pick<PharmacyWorkItem,
  'priority' | 'duration' | 'quantityToDispense' | 'quantityUnit'> {
  const duration = value.duration === undefined ? undefined : record(value.duration, 'Pharmacy work item duration');
  return {
    ...(value.priority === undefined ? {} : { priority: text(value, 'priority') }),
    ...(duration === undefined ? {} : { duration: { value: integer(duration, 'value'), unit: text(duration, 'unit') } }),
    ...(value.quantityToDispense === undefined ? {} : { quantityToDispense: finiteNumber(value, 'quantityToDispense') }),
    ...(value.quantityUnit === undefined ? {} : { quantityUnit: text(value, 'quantityUnit') }),
  };
}

function parseWorkItemMedication(value: unknown): PharmacyWorkItemMedication {
  const medication = parseMedication(value);
  const item = record(value, 'Pharmacy medication');
  return { ...medication, ...(item.strength === undefined ? {} : { strength: text(item, 'strength') }),
    ...(item.doseForm === undefined ? {} : { doseForm: text(item, 'doseForm') }) };
}

/** The optional patient: left out when absent; a malformed one is refused like any other field. */
function parseWorkItemPatient(value: unknown): { patient?: PharmacyWorkItemPatient } {
  if (value === undefined) return {};
  const patient = record(value, 'Pharmacy work item patient');
  return { patient: { fullName: text(patient, 'fullName'), sex: nullableText(patient, 'sex'),
    dateOfBirth: nullableText(patient, 'dateOfBirth'), healthIdLast4: nullableText(patient, 'healthIdLast4') } };
}

function parseWorkItem(payload: unknown): PharmacyWorkItem {
  const value = record(payload, 'Pharmacy work item');
  const dispensing = value.dispensing === null ? null : record(value.dispensing, 'Pharmacy dispensing summary');
  return {
    id: text(value, 'id'), patientId: text(value, 'patientId'), facilityId: text(value, 'facilityId'),
    sourceEhrPrescriptionId: text(value, 'sourceEhrPrescriptionId'),
    sourceEhrPrescriptionVersion: integer(value, 'sourceEhrPrescriptionVersion'),
    sourceEncounterId: text(value, 'sourceEncounterId'), status: 'accepted',
    medication: parseWorkItemMedication(value.medication),
    doseQuantity: typeof value.doseQuantity === 'number' ? value.doseQuantity : null,
    doseUnit: nullableText(value, 'doseUnit'), routeCode: nullableText(value, 'routeCode'),
    frequency: text(value, 'frequency'), instructions: text(value, 'instructions'),
    acceptedAt: text(value, 'acceptedAt'), version: integer(value, 'version'),
    dispensing: dispensing ? {
      id: text(dispensing, 'id'), status: 'dispensed', reversed: dispensing.reversed === true,
    } : null,
    ...parseWorkItemPatient(value.patient),
    ...parseWorkItemDetails(value),
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
