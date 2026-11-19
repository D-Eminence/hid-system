import { Injectable, Logger } from '@nestjs/common';
import { requestJson } from '@hid/api-client';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ServiceWorkloadIdentityService } from './service-workload-identity.service';

/**
 * ORD-3. Where each prescription and lab request is in this facility's own
 * pharmacy and laboratory, as `ownProgress` on the EHR's list and get
 * answers. Read from pharmacy-api and lab-api (POST .../work-items/progress)
 * with the clinician's own credentials, so the read depends on the
 * clinician's consent and never on a pharmacist's or laboratory member's
 * grant. Those services audit each lookup with the patient. Work sent to
 * another facility is not "own" work: its progress is on `orderRoute`.
 *
 * Nothing here can fail the EHR answer: when a service cannot be reached,
 * refuses, times out or answers something unexpected, every item it was
 * asked about carries `{ status: 'unknown' }` with no times.
 */

/** At most this many ids in one call (the services' limit). */
export const OWN_PROGRESS_BATCH = 100;
/** A slow pharmacy or laboratory must not hold the clinician's list for long. */
export const OWN_PROGRESS_TIMEOUT_MS = 3_000;

export type PharmacyOwnProgressStatus = 'not_received' | 'received' | 'dispensed' | 'dispensing_reversed' | 'withdrawn'
  | 'sent_elsewhere' | 'unknown';
export interface PharmacyOwnProgress {
  status: PharmacyOwnProgressStatus;
  receivedAt: string | null;
  dispensedAt: string | null;
  reversedAt: string | null;
}

export type LabOwnProgressStatus = 'not_received' | 'received' | 'sample_collected' | 'some_results_ready'
  | 'results_ready' | 'unknown';
export interface LabOwnProgress {
  status: LabOwnProgressStatus;
  receivedAt: string | null;
  collectedAt: string | null;
  lastResultAt: string | null;
}

export const PHARMACY_PROGRESS_UNKNOWN: PharmacyOwnProgress = Object.freeze({ status: 'unknown', receivedAt: null,
  dispensedAt: null, reversedAt: null });
export const PHARMACY_PROGRESS_NOT_RECEIVED: PharmacyOwnProgress = Object.freeze({ status: 'not_received',
  receivedAt: null, dispensedAt: null, reversedAt: null });
export const LAB_PROGRESS_UNKNOWN: LabOwnProgress = Object.freeze({ status: 'unknown', receivedAt: null,
  collectedAt: null, lastResultAt: null });
export const LAB_PROGRESS_NOT_RECEIVED: LabOwnProgress = Object.freeze({ status: 'not_received', receivedAt: null,
  collectedAt: null, lastResultAt: null });

// 'withdrawn' (0133): sent by itself, then held, cancelled, entered in error, edited or resumed before dispensing.
// 'sent_elsewhere' (0133 D14, owner's Q121 A): this hospital's pharmacy had it, and it was sent to another facility's
// pharmacy before it was dispensed; where it went is the prescription's orderRoute.
const PHARMACY_STATUSES = new Set(['not_received', 'received', 'dispensed', 'dispensing_reversed', 'withdrawn',
  'sent_elsewhere']);

/**
 * Sent on the pharmacy call only (ORD-3): this ehr-api reads 'withdrawn' and
 * 'sent_elsewhere'. pharmacy-api answers them only to a call that carries
 * it; to an older ehr-api it answers 'received' and 'not_received', the
 * statuses that image knows, so its page never turns unknown because of
 * them. Always sent; not a setting.
 */
export const OWN_PROGRESS_HEADER = Object.freeze({ 'x-hid-own-progress': '0133' });
const LAB_STATUSES = new Set(['not_received', 'received', 'sample_collected', 'some_results_ready', 'results_ready']);

/** A draft was never sent, so it is not asked about; every other status may have been. */
const SENDABLE = (status: unknown) => status !== 'draft';

interface OrderItem { id: string; status?: unknown }

@Injectable()
export class WorkItemProgressService {
  private readonly logger = new Logger(WorkItemProgressService.name);

  constructor(private readonly workloadIdentity: ServiceWorkloadIdentityService) {}

  /** The page (or single prescription) with `ownProgress` on each item. */
  async withPrescriptionProgress<Page extends { items: readonly OrderItem[] }>(context: DataAccessContext,
    patientId: string, page: Page): Promise<Page & { items: Array<Page['items'][number] & { ownProgress: PharmacyOwnProgress }> }> {
    const progress = await this.pharmacy(context, patientId, page.items);
    return { ...page, items: page.items.map((item) => ({ ...item, ownProgress: progress.get(item.id)! })) };
  }

  async withPrescription<Item extends OrderItem>(context: DataAccessContext, patientId: string, item: Item) {
    return { ...item, ownProgress: (await this.pharmacy(context, patientId, [item])).get(item.id)! };
  }

  async withLabRequestProgress<Page extends { items: readonly OrderItem[] }>(context: DataAccessContext,
    patientId: string, page: Page): Promise<Page & { items: Array<Page['items'][number] & { ownProgress: LabOwnProgress }> }> {
    const progress = await this.lab(context, patientId, page.items);
    return { ...page, items: page.items.map((item) => ({ ...item, ownProgress: progress.get(item.id)! })) };
  }

  async withLabRequest<Item extends OrderItem>(context: DataAccessContext, patientId: string, item: Item) {
    return { ...item, ownProgress: (await this.lab(context, patientId, [item])).get(item.id)! };
  }

  /** Each prescription's progress in this facility's own pharmacy, by id. Never throws. */
  async pharmacy(context: DataAccessContext, patientId: string, items: readonly OrderItem[]):
    Promise<Map<string, PharmacyOwnProgress>> {
    const result = new Map<string, PharmacyOwnProgress>(items.map((item) => [item.id, PHARMACY_PROGRESS_NOT_RECEIVED]));
    const asked = items.filter((item) => SENDABLE(item.status)).map((item) => item.id);
    for (const batch of batches(asked)) {
      const answer = await this.call('pharmacy', '/api/v1/pharmacy/work-items/progress', context,
        { patientId, sourceEhrPrescriptionIds: batch });
      const parsed = parseItems(answer, batch, 'sourceEhrPrescriptionId', PHARMACY_STATUSES,
        ['receivedAt', 'dispensedAt', 'reversedAt']);
      for (const id of batch) {
        const found = parsed?.get(id);
        result.set(id, found ? { status: found.status as PharmacyOwnProgressStatus, receivedAt: found.receivedAt ?? null,
          dispensedAt: found.dispensedAt ?? null, reversedAt: found.reversedAt ?? null } : PHARMACY_PROGRESS_UNKNOWN);
      }
    }
    return result;
  }

  /** Each lab request's progress in this facility's own laboratory, by id. Never throws. */
  async lab(context: DataAccessContext, patientId: string, items: readonly OrderItem[]):
    Promise<Map<string, LabOwnProgress>> {
    const result = new Map<string, LabOwnProgress>(items.map((item) => [item.id, LAB_PROGRESS_NOT_RECEIVED]));
    const asked = items.filter((item) => SENDABLE(item.status)).map((item) => item.id);
    for (const batch of batches(asked)) {
      const answer = await this.call('lab', '/api/v1/lab/work-items/progress', context,
        { patientId, sourceEhrOrderIds: batch });
      const parsed = parseItems(answer, batch, 'sourceEhrOrderId', LAB_STATUSES,
        ['receivedAt', 'collectedAt', 'lastResultAt']);
      for (const id of batch) {
        const found = parsed?.get(id);
        result.set(id, found ? { status: found.status as LabOwnProgressStatus, receivedAt: found.receivedAt ?? null,
          collectedAt: found.collectedAt ?? null, lastResultAt: found.lastResultAt ?? null } : LAB_PROGRESS_UNKNOWN);
      }
    }
    return result;
  }

  /** One POST with the clinician's credentials and the EHR's internal-caller proof; undefined on any failure. */
  private async call(service: 'pharmacy' | 'lab', path: string, context: DataAccessContext,
    body: unknown): Promise<unknown> {
    try {
      if (!context.authorization && !context.userCookie) throw new Error('no delegated credentials');
      const environment = getEnvironment();
      const jwt = service === 'pharmacy' ? environment.PHARMACY_SERVICE_IDENTITY_MODE === 'jwt'
        : environment.LAB_SERVICE_IDENTITY_MODE === 'jwt';
      const token = service === 'pharmacy' ? environment.PHARMACY_INTERNAL_SERVICE_TOKEN
        : environment.LAB_INTERNAL_SERVICE_TOKEN;
      const caller: Record<string, string> = jwt
        ? { 'x-hid-service-authorization': await this.workloadIdentity.authorization(service) }
        : { 'x-hid-service-token': token ?? '' };
      const { response, payload } = await requestJson({
        baseUrl: service === 'pharmacy' ? environment.PHARMACY_API_URL : environment.LAB_API_URL,
        path, method: 'POST', body, timeoutMs: OWN_PROGRESS_TIMEOUT_MS, credentials: 'omit',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': context.correlationId,
          'x-facility-id': context.facilityId,
          'x-purpose-of-use': context.purposeOfUse,
          ...(context.authorization ? { authorization: context.authorization } : {}),
          ...(context.userCookie ? { cookie: context.userCookie } : {}),
          ...(context.csrfToken ? { 'x-csrf-token': context.csrfToken } : {}),
          ...(context.origin ? { origin: context.origin } : {}),
          'x-hid-internal-caller': 'ehr-api',
          ...caller,
          ...(service === 'pharmacy' ? OWN_PROGRESS_HEADER : {}),
        },
      });
      if (!response.ok) {
        const code = (payload as { code?: unknown } | undefined)?.code;
        this.logger.warn(`Own ${service} progress is unknown: ${response.status} ${typeof code === 'string' ? code : ''}`.trim());
        return undefined;
      }
      return payload;
    } catch (error) {
      this.logger.warn(`Own ${service} progress is unknown: ${error instanceof Error ? error.name : 'error'}`);
      return undefined;
    }
  }
}

function batches(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let start = 0; start < ids.length; start += OWN_PROGRESS_BATCH) out.push(ids.slice(start, start + OWN_PROGRESS_BATCH));
  return out;
}

const isTime = (value: unknown) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

/**
 * The answer's items by id, or undefined when the answer is not exactly one
 * well-formed item per id asked, in order (then the batch is unknown).
 */
function parseItems(answer: unknown, asked: readonly string[], idField: string, statuses: ReadonlySet<string>,
  timeFields: readonly string[]): Map<string, Record<string, string | null>> | undefined {
  const items = (answer as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items) || items.length !== asked.length) return undefined;
  const parsed = new Map<string, Record<string, string | null>>();
  for (const [index, raw] of items.entries()) {
    if (!raw || typeof raw !== 'object') return undefined;
    const item = raw as Record<string, unknown>;
    if (item[idField] !== asked[index] || typeof item.status !== 'string' || !statuses.has(item.status)
      || timeFields.some((field) => !isTime(item[field] ?? null))) return undefined;
    parsed.set(asked[index]!, Object.fromEntries([['status', item.status],
      ...timeFields.map((field) => [field, (item[field] as string | null | undefined) ?? null])]));
  }
  return parsed;
}
