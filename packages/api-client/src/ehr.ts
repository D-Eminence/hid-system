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

export type EhrLabPriority = 'routine' | 'urgent' | 'asap' | 'stat';
export type EhrOrderStatus = 'draft' | 'active' | 'on_hold' | 'completed' | 'cancelled' | 'entered_in_error';

/**
 * What became of sending an active lab request to this facility's Lab after
 * the EHR saved it (ehr-api's labHandoff). ORD-6: a group's send cut off by
 * its 25 s deadline is `failed` 503 LAB_SERVICE_UNAVAILABLE, one not tried
 * before it `failed` 503 LAB_HANDOFF_NOT_TRIED; "Send to lab" sends either.
 */
export type EhrLabHandoff =
  | { state: 'accepted' }
  | { state: 'already_accepted'; code: 'LAB_ORDER_ALREADY_ACCEPTED' }
  | { state: 'failed'; status: number; code: string }
  | { state: 'not_sent'; code: 'LAB_PERMISSION_ABSENT' | 'ORDER_ROUTED' };

/** A lab request as ehr-api answers it: the list, the read, a create and an update. */
export interface EhrLabRequest {
  id: string;
  encounterId: string;
  patientId: string;
  facilityId: string;
  createdBy: string;
  createdByMembershipId: string;
  /** Both null for a test ordered by its name only (0156). */
  testCodeSystem: string | null;
  testCode: string | null;
  testDisplay: string;
  priority: EhrLabPriority;
  status: EhrOrderStatus;
  specimenTypeCode: string | null;
  clinicalInformation: string | null;
  externalOrderReference: string | null;
  /**
   * ORD-6 (0158): the group the request was ordered in (one POST of several
   * tests), or null for a request ordered on its own. ehr-api makes it and
   * never takes one from a client; it never changes. Answered whatever
   * LAB_REQUEST_GROUPS_ENABLED says.
   */
  requestGroupId: string | null;
  rowVersion: string;
  createdAt: string;
  updatedAt: string;
}

/** A lab request as a create answers it, with what became of sending it to Lab (both null when not active). */
export interface EhrLabRequestCreated extends EhrLabRequest {
  labWorkItem: unknown;
  labHandoff: EhrLabHandoff | null;
}

/**
 * One test of an ORD-6 group: the single create's test fields and limits
 * (R-2). The code pair may be left out (both) only while ehr-api's
 * LAB_REQUEST_NAME_ONLY_ENABLED is on (0156). No requestGroupId: ehr-api
 * refuses one (400 VALIDATION_FAILED).
 */
export interface EhrLabRequestGroupTestInput {
  testCodeSystem?: string;
  testCode?: string;
  testDisplay: string;
  specimenTypeCode?: string;
  /** The group's priority when left out. */
  priority?: EhrLabPriority;
}

/** ORD-6: several tests in one lab request (POST .../lab-request-groups). */
export interface EhrLabRequestGroupInput {
  status: 'draft' | 'active';
  priority?: EhrLabPriority;
  clinicalInformation?: string;
  /**
   * 1 to 20. None repeats another: the same test (by code system and code,
   * or by name) on the same specimenTypeCode, or with either specimen
   * missing or blank, which matches any specimen of the same test. The
   * codes and the specimen are compared without case, the name without
   * case or extra spaces. One culture on blood and on urine goes in one
   * Save; a second set on the same specimen goes as its own request, with
   * its site in that request's clinicalInformation.
   */
  tests: EhrLabRequestGroupTestInput[];
}

/** ORD-6: the group create's answer: each test's own request and outcome, in the order sent. */
export interface EhrLabRequestGroupCreated {
  requestGroupId: string;
  labRequests: EhrLabRequestCreated[];
}

/** One national list in the catalogue status (ORD-7, 0149): available once its signed version offers a row. */
export interface EhrCatalogListStatus {
  available: boolean;
  version: string | null;
  /** The clinical lead's sign-off day (Lagos), YYYY-MM-DD. */
  approvedAt: string | null;
  fileSha256: string | null;
}

/**
 * What the screens may use: ehr-api's `GET /api/v1/ehr/catalog/status`
 * (any staff member of the facility; no X-Purpose-Of-Use). A screen reads
 * it once per page load.
 */
export interface EhrCatalogStatus {
  medicines: EhrCatalogListStatus;
  labTests: EhrCatalogListStatus;
  /** ORD-9 (0152): the ICD-11 release the diagnosis search uses, when one is loaded. */
  diagnoses: { available: boolean; release: string | null; fileSha256: string | null };
  /** 0156: a lab request may be saved by its test name only (LAB_REQUEST_NAME_ONLY_ENABLED). */
  labTestNameOnly: boolean;
  /**
   * ORD-6 (0158): several tests may be saved in one lab request
   * (LAB_REQUEST_GROUPS_ENABLED). The website offers the multi-test form
   * only when it is true, and otherwise saves one test per request. It
   * cannot learn this from the group route: through the public gateway its
   * 503 LAB_REQUEST_GROUPS_UNAVAILABLE is the gateway's 503
   * UPSTREAM_UNAVAILABLE. An ehr-api before ORD-6 sends no such field: read
   * it as false.
   */
  labRequestGroups: boolean;
  /** 0156: a diagnosis may be saved by its name only (DIAGNOSIS_NAME_ONLY_ENABLED). */
  diagnosisNameOnly: boolean;
  /** ORD-10 phase 2. */
  classDuplicateCheck: false;
  /** The notices the active lists' sources require, for the About page. */
  attribution: string[];
}

/** ORD-6: at most this many tests in one group (ehr-api's LAB_REQUEST_GROUP_MAX_TESTS). */
export const EHR_LAB_REQUEST_GROUP_MAX_TESTS = 20;

/**
 * ORD-6: how long the group create may take. ehr-api ends its sends to Lab
 * 25 s after the request reached it, inside nginx's 30 s, so the call is
 * given 30 s rather than the client's 10 s.
 */
export const EHR_LAB_REQUEST_GROUP_TIMEOUT_MS = 30_000;

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

  /**
   * ORD-6 (0158): several tests in one lab request, one POST
   * (`ehr.lab-request.write`). A staff call: the user's credentials, no
   * internal caller. One Idempotency-Key covers the group; the same key and
   * body answers the saved group again and sends its active tests again,
   * whatever the setting says. While ehr-api's LAB_REQUEST_GROUPS_ENABLED is
   * off a new group is 503 LAB_REQUEST_GROUPS_UNAVAILABLE: add each test on
   * its own. Read EhrCatalogStatus.labRequestGroups before offering a group:
   * only a direct call to ehr-api sees that code; through the public gateway
   * it is nginx's 503 UPSTREAM_UNAVAILABLE, as every ehr-api 502, 503 and
   * 504 is. Each answer is checked: one requestGroupId, on every request, 1
   * to 20 requests.
   */
  async createLabRequestGroup(
    patientId: string,
    encounterId: string,
    input: EhrLabRequestGroupInput,
    context: EhrRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<EhrLabRequestGroupCreated> {
    const result = await this.request(
      `/api/v1/ehr/patients/${encodeURIComponent(patientId)}/encounters/${encodeURIComponent(encounterId)}`
        + '/lab-request-groups',
      'POST', input, context, idempotencyKey, signal, null, EHR_LAB_REQUEST_GROUP_TIMEOUT_MS,
    );
    if (!isLabRequestGroup(result)) throw new EhrApiProblem(502, { code: 'INVALID_LAB_REQUEST_GROUP_RESPONSE' });
    return result;
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

  /**
   * `caller` is the internal caller the call is made as (OCR's calls), or
   * null for a staff call made with the user's credentials only (ORD-6's
   * group create), which sends no internal caller and no service credential.
   */
  private async request(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    context: EhrRequestContext,
    idempotencyKey?: string,
    signal?: AbortSignal,
    caller: EhrInternalCaller | null = 'ocr-api',
    timeoutMs = this.options.timeoutMs ?? 10_000,
  ): Promise<unknown> {
    const attempts = idempotencyKey ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const serviceAuthorization = caller && this.options.serviceAuthorizationProvider
          ? await this.options.serviceAuthorizationProvider(caller) : undefined;
        const { response, payload } = await requestJson({
          baseUrl: this.options.baseUrl, path, method, body, signal,
          timeoutMs, credentials: 'omit',
          headers: {
            'content-type': 'application/json',
            'x-correlation-id': context.correlationId,
            'x-facility-id': context.facilityId,
            'x-purpose-of-use': context.purposeOfUse,
            ...(caller ? { 'x-hid-internal-caller': caller } : {}),
            ...(context.authorization ? { authorization: context.authorization } : {}),
            ...(context.cookie ? { cookie: context.cookie } : {}),
            ...(context.csrfToken ? { 'x-csrf-token': context.csrfToken } : {}),
            ...(context.origin ? { origin: context.origin } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
            ...(!caller ? {} : serviceAuthorization
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDOFF_STATES = new Set(['accepted', 'already_accepted', 'failed', 'not_sent']);

/** An ORD-6 group answer: one group id, carried by each of its 1 to 20 requests, each with its handoff. */
function isLabRequestGroup(value: unknown): value is EhrLabRequestGroupCreated {
  if (!isRecord(value) || typeof value.requestGroupId !== 'string' || !UUID.test(value.requestGroupId)) return false;
  const { requestGroupId, labRequests } = value;
  return Array.isArray(labRequests) && labRequests.length >= 1 && labRequests.length <= EHR_LAB_REQUEST_GROUP_MAX_TESTS
    && labRequests.every((request) => isRecord(request) && typeof request.id === 'string' && UUID.test(request.id)
      && request.requestGroupId === requestGroupId && typeof request.testDisplay === 'string'
      && (request.labHandoff === null || (isRecord(request.labHandoff) && typeof request.labHandoff.state === 'string'
        && HANDOFF_STATES.has(request.labHandoff.state))));
}

function unwrap(value: unknown): unknown {
  return isRecord(value) && 'data' in value ? value.data : value;
}
