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
  /** The media type the virus scan detected (owner decision D3); null until a scan detected one. */
  mediaType?: string | null;
}

export interface EhrOcrClinicalNoteImport {
  /** Absent: the patient's "Imported paper records" encounter at the facility (0113). */
  encounterId?: string;
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
  /** The account that confirmed the job's patient (audit only). */
  confirmedBy?: string;
}

export interface EhrResourceReference { id: string; }

/**
 * ORD-7 (database 0149, 0152 and 0155): a staff member's call to the
 * catalogue. The lists hold no patient, so there is no purpose of use; the
 * browser sends its session (cookie, CSRF token) or a bearer token.
 */
export interface EhrStaffRequestContext {
  correlationId: string;
  facilityId: string;
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
  origin?: string;
}

/** Section 46's dose forms. */
export type EhrCatalogDoseForm = 'tablet' | 'capsule' | 'liquid' | 'injection' | 'cream' | 'inhaler' | 'drops' | 'other';

/** The lab-test categories: the contract's nine and blood-bank, immunology and histopathology. */
export type EhrCatalogLabCategory = 'haematology' | 'chemistry' | 'microbiology' | 'serology' | 'parasitology'
  | 'urine-and-stool' | 'hormones' | 'molecular' | 'blood-bank' | 'immunology' | 'histopathology' | 'other';

/**
 * One list in the status. A list is available when its national version, or
 * (0155) this facility's own items, offer at least one item; the version,
 * sign-off day and seed file are the national list's, null when only the
 * facility's items are offered.
 */
export interface EhrCatalogListStatus {
  available: boolean;
  version: string | null;
  approvedAt: string | null;
  fileSha256: string | null;
}

/** GET ehr/catalog/status. 404 CATALOG_NOT_AVAILABLE before ORD-7's database (keep the built-in lists). */
export interface EhrCatalogStatus {
  medicines: EhrCatalogListStatus;
  labTests: EhrCatalogListStatus;
  diagnoses: { available: boolean; release: string | null; fileSha256: string | null };
  labTestNameOnly: boolean;
  diagnosisNameOnly: boolean;
  classDuplicateCheck: boolean;
  /** Show on the About or Help page. */
  attribution: string[];
}

/**
 * A medicine from the search: national (HID-MED, scope national) or this
 * facility's own (HID-FACILITY with the item's id as the code, scope and
 * source facility: show "Added by this facility"). Send display as
 * medicationDisplay, codeSystem and code as medicationCodeSystem and
 * medicationCode, and one of routes as routeCode.
 */
export interface EhrCatalogMedicine {
  codeSystem: 'HID-MED' | 'HID-FACILITY';
  code: string;
  display: string;
  genericName: string;
  strength: string | null;
  doseForm: EhrCatalogDoseForm | null;
  doseFormText: string | null;
  routes: string[];
  atcCode: string | null;
  /** A hint only; never fill it into the dose fields. */
  commonAdultDose: string | null;
  matchedName: string | null;
  scope: 'national' | 'facility';
  source: string;
}

/** A lab test from the search: national (LOINC or HID-LAB) or this facility's own (HID-FACILITY, scope facility). */
export interface EhrCatalogLabTest {
  codeSystem: 'LOINC' | 'HID-LAB' | 'HID-FACILITY';
  code: string;
  display: string;
  otherNames: string[];
  specimen: string | null;
  category: EhrCatalogLabCategory | null;
  matchedName: string | null;
  scope: 'national' | 'facility';
}

export interface EhrCatalogSearchAnswer<Item> {
  /** The national list's version; null when no national item matched. */
  listVersion: string | null;
  more: boolean;
  items: Item[];
}

export interface EhrCatalogMedicineQuery {
  /** 2-100 characters; never a Health ID or NIN (400 CATALOG_SEARCH_TEXT_NOT_ALLOWED). */
  q: string;
  /** 1-25, default 10. */
  limit?: number;
  doseForm?: EhrCatalogDoseForm;
  route?: string;
}

export interface EhrCatalogLabTestQuery {
  q: string;
  limit?: number;
}

export type EhrFacilityItemKind = 'medicine' | 'lab_test';

interface EhrFacilityItemFields {
  /** The item's id; also its code under HID-FACILITY. Never changed or reused. */
  itemId: string;
  codeSystem: 'HID-FACILITY';
  code: string;
  display: string;
  matchedName: null;
  scope: 'facility';
  /** false once withdrawn: not offered in the searches until brought back. */
  active: boolean;
  /** Send it back as expectedRowVersion to withdraw the item or bring it back. */
  rowVersion: number;
  addedAt: string;
  changedAt: string | null;
}

/** ORD-7 (0155): one of this facility's own medicines, in the medicine search's shape. */
export interface EhrFacilityMedicine extends EhrFacilityItemFields {
  kind: 'medicine';
  genericName: string;
  strength: string | null;
  doseForm: EhrCatalogDoseForm | null;
  doseFormText: null;
  routes: string[];
  atcCode: null;
  commonAdultDose: null;
  source: 'facility';
}

/** ORD-7 (0155): one of this facility's own lab tests, in the lab-test search's shape. */
export interface EhrFacilityLabTest extends EhrFacilityItemFields {
  kind: 'lab_test';
  otherNames: string[];
  specimen: string | null;
  category: EhrCatalogLabCategory | null;
}

export type EhrFacilityItem = EhrFacilityMedicine | EhrFacilityLabTest;

/** GET ehr/catalog/facility-items: active and withdrawn, at most 1,000 (`more` when there are more). */
export interface EhrFacilityItemList {
  items: EhrFacilityItem[];
  more: boolean;
}

/**
 * POST ehr/catalog/facility-items (ehr.catalog.facility-item.write; an
 * Idempotency-Key is required). display 1-500; a medicine needs genericName
 * (1-200) and may have strength (up to 80), doseForm and routes (at most 5
 * plain words); a lab test may have specimen (up to 100) and category. Any
 * other field, or a field of the other kind, is 400 VALIDATION_FAILED.
 * Refusals: 409 FACILITY_ITEM_EXISTS (an active item of that name), 409
 * FACILITY_ITEM_LIMIT (500 active items of the kind), 409
 * IDEMPOTENCY_KEY_REUSED (the key with another body). A replay with the same
 * key and body gives the same answer: the item as it was added (active, row
 * version 1), even if it has changed since.
 */
export type CreateEhrFacilityItemInput =
  | { kind: 'medicine'; display: string; genericName: string; strength?: string; doseForm?: EhrCatalogDoseForm;
    routes?: string[] }
  | { kind: 'lab_test'; display: string; specimen?: string; category?: EhrCatalogLabCategory };

/**
 * PATCH ehr/catalog/facility-items/:itemId: withdraw (active false) or bring
 * back (active true) at the row version the screen loaded. Refusals: 412
 * VERSION_CONFLICT (reload), 404 CATALOG_ITEM_NOT_FOUND, and on bringing it
 * back 409 FACILITY_ITEM_EXISTS or FACILITY_ITEM_LIMIT.
 */
export interface UpdateEhrFacilityItemInput {
  expectedRowVersion: number;
  active: boolean;
}

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

  /** ORD-7: what the catalogue offers at this facility. */
  async getCatalogStatus(context: EhrStaffRequestContext, signal?: AbortSignal): Promise<EhrCatalogStatus> {
    return parseCatalogStatus(await this.staffRequest('/api/v1/ehr/catalog/status', 'GET', undefined, context, undefined,
      signal));
  }

  /** ORD-7: the national medicines and (0155) this facility's own, in one list. */
  async searchCatalogMedicines(query: EhrCatalogMedicineQuery, context: EhrStaffRequestContext, signal?: AbortSignal):
  Promise<EhrCatalogSearchAnswer<EhrCatalogMedicine>> {
    const result = await this.staffRequest(`/api/v1/ehr/catalog/medicines?${searchParameters(query)}`, 'GET', undefined,
      context, undefined, signal);
    return parseSearchAnswer(result, parseCatalogMedicine);
  }

  /** ORD-7: the national lab tests and (0155) this facility's own, in one list. */
  async searchCatalogLabTests(query: EhrCatalogLabTestQuery, context: EhrStaffRequestContext, signal?: AbortSignal):
  Promise<EhrCatalogSearchAnswer<EhrCatalogLabTest>> {
    const result = await this.staffRequest(`/api/v1/ehr/catalog/lab-tests?${searchParameters(query)}`, 'GET', undefined,
      context, undefined, signal);
    return parseSearchAnswer(result, parseCatalogLabTest);
  }

  /** ORD-7 (0155): this facility's own items, of a kind or of both. */
  async listFacilityItems(context: EhrStaffRequestContext, kind?: EhrFacilityItemKind, signal?: AbortSignal):
  Promise<EhrFacilityItemList> {
    const path = `/api/v1/ehr/catalog/facility-items${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`;
    const value = record(await this.staffRequest(path, 'GET', undefined, context, undefined, signal));
    if (!Array.isArray(value.items) || typeof value.more !== 'boolean') throw new EhrApiProblem(502, value);
    return { items: value.items.map(parseFacilityItem), more: value.more };
  }

  /** ORD-7 (0155): adds one of this facility's own items (see CreateEhrFacilityItemInput). */
  async createFacilityItem(input: CreateEhrFacilityItemInput, context: EhrStaffRequestContext, idempotencyKey: string,
    signal?: AbortSignal): Promise<EhrFacilityItem> {
    return parseFacilityItem(await this.staffRequest('/api/v1/ehr/catalog/facility-items', 'POST', input, context,
      idempotencyKey, signal));
  }

  /** ORD-7 (0155): withdraws an item or brings it back (see UpdateEhrFacilityItemInput). Never retried. */
  async updateFacilityItem(itemId: string, input: UpdateEhrFacilityItemInput, context: EhrStaffRequestContext,
    signal?: AbortSignal): Promise<EhrFacilityItem> {
    return parseFacilityItem(await this.staffRequest(`/api/v1/ehr/catalog/facility-items/${encodeURIComponent(itemId)}`,
      'PATCH', input, context, undefined, signal));
  }

  /**
   * A staff call: the session's credentials, no internal-caller headers and
   * no purpose of use. A POST with an Idempotency-Key is tried once more on
   * 502, 503 or 504; nothing else is retried.
   */
  private async staffRequest(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body: unknown,
    context: EhrStaffRequestContext,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const attempts = idempotencyKey ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const { response, payload } = await requestJson({
          baseUrl: this.options.baseUrl, path, method, body, signal,
          timeoutMs: this.options.timeoutMs ?? 10_000, credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-correlation-id': context.correlationId,
            'x-facility-id': context.facilityId,
            ...(context.authorization ? { authorization: context.authorization } : {}),
            ...(context.cookie ? { cookie: context.cookie } : {}),
            ...(context.csrfToken ? { 'x-csrf-token': context.csrfToken } : {}),
            ...(context.origin ? { origin: context.origin } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
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

const DOSE_FORMS: readonly EhrCatalogDoseForm[] = ['tablet', 'capsule', 'liquid', 'injection', 'cream', 'inhaler', 'drops',
  'other'];
const LAB_CATEGORIES: readonly EhrCatalogLabCategory[] = ['haematology', 'chemistry', 'microbiology', 'serology',
  'parasitology', 'urine-and-stool', 'hormones', 'molecular', 'blood-bank', 'immunology', 'histopathology', 'other'];

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new EhrApiProblem(502, value);
  return value;
}

function text(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new EhrApiProblem(502, value);
  return field;
}

function nullableText(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (field === null || field === undefined) return null;
  if (typeof field !== 'string') throw new EhrApiProblem(502, value);
  return field;
}

function texts(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (field === undefined || field === null) return [];
  if (!Array.isArray(field) || field.some((each) => typeof each !== 'string')) throw new EhrApiProblem(502, value);
  return field as string[];
}

function oneOf<Value extends string>(value: Record<string, unknown>, key: string, allowed: readonly Value[]): Value | null {
  const field = value[key];
  if (field === null || field === undefined) return null;
  if (typeof field !== 'string' || !(allowed as readonly string[]).includes(field)) throw new EhrApiProblem(502, value);
  return field as Value;
}

function searchParameters(query: EhrCatalogMedicineQuery | EhrCatalogLabTestQuery): string {
  const parameters = new URLSearchParams({ q: query.q });
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  if ('doseForm' in query && query.doseForm !== undefined) parameters.set('doseForm', query.doseForm);
  if ('route' in query && query.route !== undefined) parameters.set('route', query.route);
  return parameters.toString();
}

function parseListStatus(payload: unknown): EhrCatalogListStatus {
  const value = record(payload);
  if (typeof value.available !== 'boolean') throw new EhrApiProblem(502, value);
  return { available: value.available, version: nullableText(value, 'version'), approvedAt: nullableText(value, 'approvedAt'),
    fileSha256: nullableText(value, 'fileSha256') };
}

function parseCatalogStatus(payload: unknown): EhrCatalogStatus {
  const value = record(payload);
  const diagnoses = record(value.diagnoses);
  if (typeof diagnoses.available !== 'boolean') throw new EhrApiProblem(502, value);
  return {
    medicines: parseListStatus(value.medicines),
    labTests: parseListStatus(value.labTests),
    diagnoses: { available: diagnoses.available, release: nullableText(diagnoses, 'release'),
      fileSha256: nullableText(diagnoses, 'fileSha256') },
    labTestNameOnly: value.labTestNameOnly === true,
    diagnosisNameOnly: value.diagnosisNameOnly === true,
    classDuplicateCheck: value.classDuplicateCheck === true,
    attribution: texts(value, 'attribution'),
  };
}

function parseSearchAnswer<Item>(payload: unknown, parse: (item: unknown) => Item): EhrCatalogSearchAnswer<Item> {
  const value = record(payload);
  if (!Array.isArray(value.items) || typeof value.more !== 'boolean') throw new EhrApiProblem(502, value);
  return { listVersion: nullableText(value, 'listVersion'), more: value.more, items: value.items.map(parse) };
}

function scope(value: Record<string, unknown>): 'national' | 'facility' {
  if (value.scope !== 'national' && value.scope !== 'facility') throw new EhrApiProblem(502, value);
  return value.scope;
}

function parseCatalogMedicine(payload: unknown): EhrCatalogMedicine {
  const value = record(payload);
  const codeSystem = oneOf(value, 'codeSystem', ['HID-MED', 'HID-FACILITY'] as const);
  if (!codeSystem) throw new EhrApiProblem(502, value);
  return {
    codeSystem, code: text(value, 'code'), display: text(value, 'display'), genericName: text(value, 'genericName'),
    strength: nullableText(value, 'strength'), doseForm: oneOf(value, 'doseForm', DOSE_FORMS),
    doseFormText: nullableText(value, 'doseFormText'), routes: texts(value, 'routes'), atcCode: nullableText(value, 'atcCode'),
    commonAdultDose: nullableText(value, 'commonAdultDose'), matchedName: nullableText(value, 'matchedName'),
    scope: scope(value), source: text(value, 'source'),
  };
}

function parseCatalogLabTest(payload: unknown): EhrCatalogLabTest {
  const value = record(payload);
  const codeSystem = oneOf(value, 'codeSystem', ['LOINC', 'HID-LAB', 'HID-FACILITY'] as const);
  if (!codeSystem) throw new EhrApiProblem(502, value);
  return {
    codeSystem, code: text(value, 'code'), display: text(value, 'display'), otherNames: texts(value, 'otherNames'),
    specimen: nullableText(value, 'specimen'), category: oneOf(value, 'category', LAB_CATEGORIES),
    matchedName: nullableText(value, 'matchedName'), scope: scope(value),
  };
}

/** One of this facility's own items: HID-FACILITY, its id as the code, a whole row version, both times as text. */
function parseFacilityItem(payload: unknown): EhrFacilityItem {
  const value = record(payload);
  const itemId = text(value, 'itemId');
  if (value.codeSystem !== 'HID-FACILITY' || value.code !== itemId || typeof value.active !== 'boolean'
    || typeof value.rowVersion !== 'number' || !Number.isInteger(value.rowVersion) || value.rowVersion < 1) {
    throw new EhrApiProblem(502, value);
  }
  const fields = {
    itemId, codeSystem: 'HID-FACILITY' as const, code: itemId, display: text(value, 'display'), matchedName: null,
    scope: 'facility' as const, active: value.active, rowVersion: value.rowVersion, addedAt: text(value, 'addedAt'),
    changedAt: nullableText(value, 'changedAt'),
  };
  if (value.kind === 'medicine') {
    return { ...fields, kind: 'medicine', genericName: text(value, 'genericName'), strength: nullableText(value, 'strength'),
      doseForm: oneOf(value, 'doseForm', DOSE_FORMS), doseFormText: null, routes: texts(value, 'routes'), atcCode: null,
      commonAdultDose: null, source: 'facility' };
  }
  if (value.kind === 'lab_test') {
    return { ...fields, kind: 'lab_test', otherNames: texts(value, 'otherNames'), specimen: nullableText(value, 'specimen'),
      category: oneOf(value, 'category', LAB_CATEGORIES) };
  }
  throw new EhrApiProblem(502, value);
}
