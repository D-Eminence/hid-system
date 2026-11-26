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

/** ORD-11: the six kinds ehr-api sends today. A notice's `kind` is kept as a string, so a later kind still lists. */
export type EhrOrderNoticeKind = 'lab_result_critical' | 'lab_result_corrected' | 'lab_result_ready'
  | 'lab_result_withdrawn' | 'prescription_dispensed' | 'dispensing_reversed';

export interface EhrOrderNoticeCounts {
  unread: number;
  /** Critical notices not yet Seen, read or not. */
  criticalNotSeen: number;
}

/** GET /api/v1/ehr/me/order-notices/summary: the totals and the same per kind. Names no patient. */
export interface EhrOrderNoticeSummary extends EhrOrderNoticeCounts {
  byKind: Record<string, EhrOrderNoticeCounts>;
}

/**
 * One notice to the ordering doctor (ORD-11). While `accessEnded` is true
 * there is no patient, visit or display: show the message and "Ask for
 * access", never a name. `order.routeId` is set for an order sent to another
 * facility, whose result is opened through the route.
 */
export interface EhrOrderNotice {
  noticeId: string;
  kind: EhrOrderNoticeKind | (string & {});
  /** Send it back with mark read: a notice that changed since stays unread. */
  version: number;
  createdAt: string;
  lastEventAt: string;
  count: number;
  readAt: string | null;
  needsSeen: boolean;
  seenAt: string | null;
  order: { type: string; id: string; routeId: string | null; encounterId: string | null; display: string | null };
  patient: { patientId: string; fullName: string; sex: string | null; dateOfBirth: string | null;
    healthIdLast4: string | null } | null;
  accessEnded: boolean;
  message: string;
}

export interface EhrOrderNoticePage {
  items: EhrOrderNotice[];
  /**
   * Where the next page starts, sent back as `cursor` with the same state;
   * null on the last page. Opaque: do not read or build it.
   */
  nextCursor: string | null;
}

export interface EhrOrderNoticeListQuery {
  state: 'unread' | 'all';
  /** The page before's `nextCursor`, as sent. */
  cursor?: string;
  /** 1-50; ehr-api's default is 20. */
  limit?: number;
}

/** A notice to mark read, at the version the screen showed. */
export interface EhrOrderNoticeVersion {
  noticeId: string;
  version: number;
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

  /** ORD-11: the bell's counts. A staff call, sent with the user's own credentials. */
  async orderNoticeSummary(context: EhrRequestContext, signal?: AbortSignal): Promise<EhrOrderNoticeSummary> {
    return parseOrderNoticeSummary(await this.request('/api/v1/ehr/me/order-notices/summary', 'GET', undefined, context,
      undefined, signal, null));
  }

  /** ORD-11: a page of notices, critical ones not Seen first, then newest. */
  async listOrderNotices(query: EhrOrderNoticeListQuery, context: EhrRequestContext,
    signal?: AbortSignal): Promise<EhrOrderNoticePage> {
    const search = new URLSearchParams({ state: query.state });
    if (query.cursor !== undefined) search.set('cursor', query.cursor);
    if (query.limit !== undefined) search.set('limit', String(query.limit));
    const value = record(await this.request(`/api/v1/ehr/me/order-notices?${search.toString()}`, 'GET', undefined,
      context, undefined, signal, null));
    if (!Array.isArray(value.items) || value.items.length > EHR_ORDER_NOTICES_PAGE_MAX) throw new EhrApiProblem(502, value);
    const items = value.items.map(parseOrderNotice);
    if (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !CURSOR.test(value.nextCursor))) {
      throw new EhrApiProblem(502, value);
    }
    return { items, nextCursor: value.nextCursor };
  }

  /**
   * ORD-11: marks read the notices still at the version sent (1-100). One
   * that changed since stays unread and is not counted in `updated`.
   */
  async markOrderNoticesRead(notices: readonly EhrOrderNoticeVersion[], context: EhrRequestContext,
    signal?: AbortSignal): Promise<{ updated: number }> {
    const value = record(await this.request('/api/v1/ehr/me/order-notices/read', 'POST',
      { notices: notices.map((notice) => ({ noticeId: notice.noticeId, version: notice.version })) }, context,
      undefined, signal, null));
    if (!wholeNumber(value.updated) || value.updated > notices.length) throw new EhrApiProblem(502, value);
    return { updated: value.updated };
  }

  /** ORD-11: marks a notice Seen (final). 403 CONSENT_REQUIRED while the patient's records cannot be read here. */
  async markOrderNoticeSeen(noticeId: string, context: EhrRequestContext, signal?: AbortSignal): Promise<EhrOrderNotice> {
    const notice = parseOrderNotice(await this.request(
      `/api/v1/ehr/me/order-notices/${encodeURIComponent(noticeId)}/seen`, 'POST', {}, context, undefined, signal, null));
    if (notice.noticeId !== noticeId || notice.seenAt === null) throw new EhrApiProblem(502, notice);
    return notice;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    context: EhrRequestContext,
    idempotencyKey?: string,
    signal?: AbortSignal,
    caller: EhrInternalCaller | null = 'ocr-api',
  ): Promise<unknown> {
    const attempts = idempotencyKey ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const serviceAuthorization = caller && this.options.serviceAuthorizationProvider
          ? await this.options.serviceAuthorizationProvider(caller) : undefined;
        const { response, payload } = await requestJson({
          baseUrl: this.options.baseUrl, path, method, body, signal,
          timeoutMs: this.options.timeoutMs ?? 10_000, credentials: caller ? 'omit' : 'include',
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
            ...(caller ? (serviceAuthorization
              ? { 'x-hid-service-authorization': serviceAuthorization }
              : { 'x-hid-service-token': this.options.internalServiceToken ?? '' }) : {}),
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

/** ORD-11: at most this many notices on a page. */
export const EHR_ORDER_NOTICES_PAGE_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An opaque page cursor, as ehr-api's query takes it. */
const CURSOR = /^[A-Za-z0-9_-]{16,512}$/;

function record(value: unknown): Record<string, unknown> {
  const unwrapped = unwrap(value);
  if (!isRecord(unwrapped)) throw new EhrApiProblem(502, value);
  return unwrapped;
}

function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function text(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== 'string' || !found) throw new EhrApiProblem(502, { detail: `EHR field ${key} is malformed.` });
  return found;
}

function nullableText(value: Record<string, unknown>, key: string): string | null {
  const found = value[key];
  if (found === null) return null;
  if (typeof found !== 'string') throw new EhrApiProblem(502, { detail: `EHR field ${key} is malformed.` });
  return found;
}

function counts(value: unknown): EhrOrderNoticeCounts {
  if (!isRecord(value) || !wholeNumber(value.unread) || !wholeNumber(value.criticalNotSeen)) {
    throw new EhrApiProblem(502, { detail: 'EHR order notice counts are malformed.' });
  }
  return { unread: value.unread, criticalNotSeen: value.criticalNotSeen };
}

function parseOrderNoticeSummary(payload: unknown): EhrOrderNoticeSummary {
  const value = record(payload);
  const totals = counts(value);
  if (!isRecord(value.byKind)) throw new EhrApiProblem(502, value);
  const byKind: Record<string, EhrOrderNoticeCounts> = {};
  for (const [kind, kindCounts] of Object.entries(value.byKind)) byKind[kind] = counts(kindCounts);
  return { ...totals, byKind };
}

/**
 * One notice. Strict for a type, refused with 502 like any broken answer;
 * a kind or order type this client does not know is kept as sent. Keys the
 * contract does not define are dropped. A notice whose access has ended
 * must carry no patient and no display (never passed on to a screen).
 */
function parseOrderNotice(payload: unknown): EhrOrderNotice {
  const value = record(payload);
  const order = record(value.order);
  const version = value.version;
  const count = value.count;
  if (!wholeNumber(version) || version < 1 || !wholeNumber(count) || count < 1
    || typeof value.needsSeen !== 'boolean' || typeof value.accessEnded !== 'boolean') {
    throw new EhrApiProblem(502, { detail: 'EHR order notice is malformed.' });
  }
  const noticeId = text(value, 'noticeId');
  if (!UUID.test(noticeId)) throw new EhrApiProblem(502, { detail: 'EHR field noticeId is malformed.' });
  let patient: EhrOrderNotice['patient'] = null;
  if (value.patient !== null) {
    const card = record(value.patient);
    patient = { patientId: text(card, 'patientId'), fullName: text(card, 'fullName'), sex: nullableText(card, 'sex'),
      dateOfBirth: nullableText(card, 'dateOfBirth'), healthIdLast4: nullableText(card, 'healthIdLast4') };
  }
  const display = nullableText(order, 'display');
  if (value.accessEnded && (patient !== null || display !== null)) {
    throw new EhrApiProblem(502, { detail: 'EHR order notice shows a patient whose access has ended.' });
  }
  return {
    noticeId, kind: text(value, 'kind'), version, createdAt: text(value, 'createdAt'),
    lastEventAt: text(value, 'lastEventAt'), count, readAt: nullableText(value, 'readAt'), needsSeen: value.needsSeen,
    seenAt: nullableText(value, 'seenAt'),
    order: { type: text(order, 'type'), id: text(order, 'id'), routeId: nullableText(order, 'routeId'),
      encounterId: nullableText(order, 'encounterId'), display },
    patient, accessEnded: value.accessEnded, message: text(value, 'message'),
  };
}
