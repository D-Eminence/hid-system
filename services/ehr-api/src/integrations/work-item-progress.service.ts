import { Injectable, Logger } from '@nestjs/common';
import { HidRequestTimeoutError, requestJson } from '@hid/api-client';
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
 *
 * ORD-4 adds the pharmacist's step between "Sent to pharmacy" and
 * "Dispensed": the pharmacy status 'accepted' and the time `acceptedAt`.
 *
 * Decision 4: "Ordered by me" (MY-1) asks for its whole page in one call per
 * service (pharmacyForPatients, labForPatients: POST
 * .../work-items/progress/batch), and once per patient on the one-patient
 * route when that service answers 404 (an image without the batch form).
 */

/** At most this many ids in one call, in all (also the batch form's limit). */
export const OWN_PROGRESS_BATCH = 100;
/** At most this many patients in one batch call (the services' limit: a page of "Ordered by me"). */
export const OWN_PROGRESS_BATCH_PATIENTS = 50;
/** A slow pharmacy or laboratory must not hold the clinician's list for long. */
export const OWN_PROGRESS_TIMEOUT_MS = 3_000;
/**
 * The batch call's limit, from sending it to a parsed answer: headers AND
 * body. The client's own time limit ends at the answer's headers, so call()
 * keeps a timer of this length running until the payload is parsed; a body
 * that stalls after its headers is then unknown at this limit instead of
 * holding the page's call until undici's body timeout (300 seconds). It fits
 * inside "Ordered by me"'s 4 second page deadline and leaves 1.5 seconds
 * around the services' 2 second budget for their Identity checks (transit,
 * guard and transactions). The one-patient calls keep OWN_PROGRESS_TIMEOUT_MS
 * to the headers, exactly as before.
 */
export const OWN_PROGRESS_BATCH_TIMEOUT_MS = 3_500;
/**
 * Against an image without the batch form, at most this many one-patient
 * calls at once ("Ordered by me"'s own limit before decision 4, which its
 * worker kept across both kinds). It is the default size of
 * OwnProgressSlots: a page that passes one OwnProgressSlots to both
 * pharmacyForPatients and labForPatients keeps this limit for the page;
 * without one, each invocation has its own limit of this size.
 */
export const OWN_PROGRESS_FALLBACK_CONCURRENCY = 6;
export const PHARMACY_PROGRESS_BATCH_PATH = '/api/v1/pharmacy/work-items/progress/batch';
export const LAB_PROGRESS_BATCH_PATH = '/api/v1/lab/work-items/progress/batch';
const PHARMACY_PROGRESS_PATH = '/api/v1/pharmacy/work-items/progress';
const LAB_PROGRESS_PATH = '/api/v1/lab/work-items/progress';

export type PharmacyOwnProgressStatus = 'not_received' | 'received' | 'accepted' | 'dispensed' | 'dispensing_reversed'
  | 'withdrawn' | 'sent_elsewhere' | 'unknown';
export interface PharmacyOwnProgress {
  status: PharmacyOwnProgressStatus;
  receivedAt: string | null;
  /**
   * ORD-4: when a pharmacist at this hospital's pharmacy accepted it, as
   * pharmacy-api answers it: with 'accepted', and also kept with a later
   * status ('dispensed', 'withdrawn', ...), or null (not accepted, unknown, or
   * a pharmacy-api from before ORD-4, which never sends it).
   */
  acceptedAt: string | null;
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
  acceptedAt: null, dispensedAt: null, reversedAt: null });
export const PHARMACY_PROGRESS_NOT_RECEIVED: PharmacyOwnProgress = Object.freeze({ status: 'not_received',
  receivedAt: null, acceptedAt: null, dispensedAt: null, reversedAt: null });
export const LAB_PROGRESS_UNKNOWN: LabOwnProgress = Object.freeze({ status: 'unknown', receivedAt: null,
  collectedAt: null, lastResultAt: null });
export const LAB_PROGRESS_NOT_RECEIVED: LabOwnProgress = Object.freeze({ status: 'not_received', receivedAt: null,
  collectedAt: null, lastResultAt: null });

// 'accepted' (ORD-4): a pharmacist at this hospital's pharmacy accepted it (acceptedAt), and it is not dispensed yet.
// 'withdrawn' (0133): sent by itself, then held, cancelled, entered in error, edited or resumed before dispensing.
// 'sent_elsewhere' (0133 D14, owner's Q121 A): this hospital's pharmacy had it, and it was sent to another facility's
// pharmacy before it was dispensed; where it went is the prescription's orderRoute.
// Any other value still makes the whole batch unknown (parseItems).
const PHARMACY_STATUSES = new Set(['not_received', 'received', 'accepted', 'dispensed', 'dispensing_reversed',
  'withdrawn', 'sent_elsewhere']);
// ORD-4: a missing acceptedAt (a pharmacy-api from before ORD-4) parses as null, as a missing time always has.
const PHARMACY_TIMES = ['receivedAt', 'acceptedAt', 'dispensedAt', 'reversedAt'];

/**
 * Sent on the pharmacy call only (ORD-3): this ehr-api reads 'withdrawn' and
 * 'sent_elsewhere'. pharmacy-api answers them only to a call that carries
 * it; to an older ehr-api it answers 'received' and 'not_received', the
 * statuses that image knows, so its page never turns unknown because of
 * them. Always sent; not a setting.
 */
export const OWN_PROGRESS_HEADER = Object.freeze({ 'x-hid-own-progress': '0133' });

/**
 * ORD-4, sent beside OWN_PROGRESS_HEADER on the pharmacy call only: this
 * ehr-api also reads 'accepted' and `acceptedAt`. A separate header, so
 * OWN_PROGRESS_HEADER keeps exactly the value a Release A pharmacy-api
 * matches (that image ignores this one and answers as before, with no
 * `acceptedAt`, which parses as null). pharmacy-api answers 'accepted' only
 * to a call carrying both, each value matched exactly; to an ehr-api from
 * before ORD-4 it answers 'received', so that page never turns unknown
 * because of it. Either image may therefore be deployed, or rolled back,
 * first. Always sent; not a setting.
 */
export const OWN_PROGRESS_ACCEPTED_HEADER = Object.freeze({ 'x-hid-own-progress-accepted': 'ord4' });
const LAB_STATUSES = new Set(['not_received', 'received', 'sample_collected', 'some_results_ready', 'results_ready']);
const LAB_TIMES = ['receivedAt', 'collectedAt', 'lastResultAt'];

/** A draft was never sent, so it is not asked about; every other status may have been. */
const SENDABLE = (status: unknown) => status !== 'draft';

export interface OrderItem { id: string; status?: unknown }
/** One patient's orders of one kind, as "Ordered by me" lists them. */
export interface PatientOrders { patientId: string; items: readonly OrderItem[] }
/**
 * What "Ordered by me" passes for its page.
 *
 * `signal` (the page deadline): once it aborts, nothing more is asked, a call
 * in flight is abandoned at once, whether its answer's headers have arrived
 * or not, and what was not answered is unknown. A call abandoned after its
 * headers leaves its body read behind: that read keeps its socket until the
 * peer closes it or undici's body timeout ends it, because only
 * @hid/api-client could cancel it and decision 11 keeps that package
 * unchanged. Nothing waits for it, and its answer is never read.
 *
 * `slots`: the page's limit on one-patient calls (the fallback against an
 * image without the batch form). Pass the same OwnProgressSlots to both
 * kinds so the page makes at most OWN_PROGRESS_FALLBACK_CONCURRENCY at once
 * across both; without it, each invocation has a limit of its own.
 */
export interface OwnProgressOptions { signal?: AbortSignal; slots?: OwnProgressSlots }

/**
 * A limit on one-patient calls in flight at once, shared by whatever
 * invocations are given the same object ("Ordered by me" makes one per page
 * and gives it to both kinds, as #299's worker drained one queue across both
 * kinds). A slot is taken before each one-patient call and given back after
 * it, whatever its outcome. A caller waiting for a slot is let go at once,
 * without a slot, when its signal aborts, so no call starts after the page's
 * deadline. It holds no state beyond the object the caller made: nothing is
 * remembered between pages.
 */
export class OwnProgressSlots {
  private free: number;
  private readonly waiting: Array<(taken: boolean) => void> = [];

  constructor(readonly limit = OWN_PROGRESS_FALLBACK_CONCURRENCY) {
    // A limit below one (or not a whole number) would start no worker, and
    // every id the page asked would stay "not received" when the truth is
    // "not known": refused here rather than shown to a clinician.
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('OwnProgressSlots limit must be a whole number of 1 or more');
    this.free = limit;
  }

  /**
   * True with a slot, which the caller must give back; false, holding none,
   * when the signal has aborted, before or while waiting.
   */
  take(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const release = () => {
        // Let go at once, without a slot: the page has stopped waiting.
        const index = this.waiting.indexOf(handOver);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(false);
      };
      const handOver = (taken: boolean) => {
        signal?.removeEventListener('abort', release);
        resolve(taken);
      };
      this.waiting.push(handOver);
      signal?.addEventListener('abort', release, { once: true });
    });
  }

  /** A slot back: straight to the first caller still waiting, else free. */
  give(): void {
    const next = this.waiting.shift();
    if (next) next(true);
    else this.free += 1;
  }
}

/** One patient's ids to ask (in a batch call, at most OWN_PROGRESS_BATCH). */
interface Asked { patientId: string; ids: string[] }

/** What call() got: a 2xx answer's payload, or none (already logged); a batch call says whether the form is missing. */
type Answer = { ok: true; payload: unknown } | { ok: false; noBatchForm: boolean };

/** What differs between the pharmacy and the laboratory in the several-patient read. */
interface ProgressKind<Progress> {
  service: 'pharmacy' | 'lab';
  batchPath: string;
  idsField: 'sourceEhrPrescriptionIds' | 'sourceEhrOrderIds';
  notReceived: Progress;
  unknown: Progress;
  /** One patient's items, read exactly as the one-patient answer is; undefined when they are malformed. */
  items: (answer: unknown, ids: readonly string[]) => Map<string, Progress> | undefined;
  /** The one-patient route, for the fallback. */
  single: (context: DataAccessContext, patientId: string, items: readonly OrderItem[], options: OwnProgressOptions)
    => Promise<Map<string, Progress>>;
}

/**
 * Only a code of this shape is logged: the services' codes are constants, and
 * this keeps anything else (an id, free text) out of the log.
 */
const LOGGABLE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

@Injectable()
export class WorkItemProgressService {
  private readonly logger = new Logger(WorkItemProgressService.name);

  private readonly pharmacyKind: ProgressKind<PharmacyOwnProgress> = {
    service: 'pharmacy', batchPath: PHARMACY_PROGRESS_BATCH_PATH, idsField: 'sourceEhrPrescriptionIds',
    notReceived: PHARMACY_PROGRESS_NOT_RECEIVED, unknown: PHARMACY_PROGRESS_UNKNOWN, items: pharmacyItems,
    single: (context, patientId, items, options) => this.pharmacy(context, patientId, items, options),
  };

  private readonly labKind: ProgressKind<LabOwnProgress> = {
    service: 'lab', batchPath: LAB_PROGRESS_BATCH_PATH, idsField: 'sourceEhrOrderIds',
    notReceived: LAB_PROGRESS_NOT_RECEIVED, unknown: LAB_PROGRESS_UNKNOWN, items: labItems,
    single: (context, patientId, items, options) => this.lab(context, patientId, items, options),
  };

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
  async pharmacy(context: DataAccessContext, patientId: string, items: readonly OrderItem[],
    options: OwnProgressOptions = {}): Promise<Map<string, PharmacyOwnProgress>> {
    const result = new Map<string, PharmacyOwnProgress>(items.map((item) => [item.id, PHARMACY_PROGRESS_NOT_RECEIVED]));
    const asked = items.filter((item) => SENDABLE(item.status)).map((item) => item.id);
    for (const batch of batches(asked)) {
      const answer = await this.call('pharmacy', PHARMACY_PROGRESS_PATH, context,
        { patientId, sourceEhrPrescriptionIds: batch }, { signal: options.signal });
      const parsed = answer.ok ? pharmacyItems(answer.payload, batch) : undefined;
      for (const id of batch) result.set(id, parsed?.get(id) ?? PHARMACY_PROGRESS_UNKNOWN);
    }
    return result;
  }

  /** Each lab request's progress in this facility's own laboratory, by id. Never throws. */
  async lab(context: DataAccessContext, patientId: string, items: readonly OrderItem[],
    options: OwnProgressOptions = {}): Promise<Map<string, LabOwnProgress>> {
    const result = new Map<string, LabOwnProgress>(items.map((item) => [item.id, LAB_PROGRESS_NOT_RECEIVED]));
    const asked = items.filter((item) => SENDABLE(item.status)).map((item) => item.id);
    for (const batch of batches(asked)) {
      const answer = await this.call('lab', LAB_PROGRESS_PATH, context,
        { patientId, sourceEhrOrderIds: batch }, { signal: options.signal });
      const parsed = answer.ok ? labItems(answer.payload, batch) : undefined;
      for (const id of batch) result.set(id, parsed?.get(id) ?? LAB_PROGRESS_UNKNOWN);
    }
    return result;
  }

  /**
   * Each order's own pharmacy progress for several patients ("Ordered by me",
   * decision 4), one batch call per 100 ids, by each item's id as given.
   * Never throws.
   */
  pharmacyForPatients(context: DataAccessContext, patients: readonly PatientOrders[],
    options: OwnProgressOptions = {}): Promise<Map<string, PharmacyOwnProgress>> {
    return this.forPatients(this.pharmacyKind, context, patients, options);
  }

  /** Each order's own laboratory progress for several patients, as pharmacyForPatients. Never throws. */
  labForPatients(context: DataAccessContext, patients: readonly PatientOrders[],
    options: OwnProgressOptions = {}): Promise<Map<string, LabOwnProgress>> {
    return this.forPatients(this.labKind, context, patients, options);
  }

  /**
   * Decision 4. Every item starts not received (a draft is never asked); each
   * id is asked once, under the first patient that names it, in calls of at
   * most 50 patients and 100 ids, one after another. Nothing is remembered
   * between invocations, so an image deployed or rolled back is seen at the
   * next page.
   */
  private async forPatients<Progress>(kind: ProgressKind<Progress>, context: DataAccessContext,
    patients: readonly PatientOrders[], options: OwnProgressOptions): Promise<Map<string, Progress>> {
    const { signal } = options;
    // The page's slots when it passes them (both kinds share one limit), else this invocation's own.
    const slots = options.slots ?? new OwnProgressSlots();
    const result = new Map<string, Progress>();
    // Ids are UUIDs, so letter case does not make another order: an answer reaches every spelling the page used.
    const spellings = new Map<string, Set<string>>();
    // The services refuse a patient or an id named twice in one call (letter case ignored), so both are merged here.
    const merged = new Map<string, Asked>();
    for (const patient of patients) {
      const key = patient.patientId.toLowerCase();
      if (!merged.has(key)) merged.set(key, { patientId: patient.patientId, ids: [] });
      const entry = merged.get(key)!;
      for (const item of patient.items) {
        if (!result.has(item.id)) result.set(item.id, kind.notReceived);
        if (!SENDABLE(item.status)) continue;
        const id = item.id.toLowerCase();
        const known = spellings.get(id);
        if (known) {
          known.add(item.id);
          continue;
        }
        spellings.set(id, new Set([item.id]));
        entry.ids.push(item.id);
      }
    }
    const asked = [...merged.values()].filter((entry) => entry.ids.length > 0);
    const answer = (id: string, progress: Progress) => {
      for (const spelling of spellings.get(id.toLowerCase()) ?? [id]) result.set(spelling, progress);
    };
    const unknown = (entries: readonly Asked[]) => {
      for (const entry of entries) for (const id of entry.ids) answer(id, kind.unknown);
    };
    if (asked.length === 0) return result;
    if (signal?.aborted) {
      unknown(asked);
      return result;
    }
    // The batch form is direct care only (an emergency read stays one patient at a time); no other purpose is sent.
    if (context.purposeOfUse !== 'direct-care') {
      await this.perPatient(kind, context, asked, signal, slots, answer);
      return result;
    }
    let noBatchForm = false;
    for (const call of pack(asked)) {
      if (signal?.aborted) {
        unknown(call);
        continue;
      }
      if (noBatchForm) {
        await this.perPatient(kind, context, call, signal, slots, answer);
        continue;
      }
      const sent = await this.call(kind.service, kind.batchPath, context,
        { patients: call.map((entry) => ({ patientId: entry.patientId, [kind.idsField]: entry.ids })) },
        { signal, timeoutMs: OWN_PROGRESS_BATCH_TIMEOUT_MS, batch: true });
      if (sent.ok) this.readBatch(kind, call, sent.payload, answer);
      else if (sent.noBatchForm) {
        noBatchForm = true;
        await this.perPatient(kind, context, call, signal, slots, answer);
      } else unknown(call);
    }
    return result;
  }

  /**
   * One batch answer. The whole call is unknown unless it names exactly the
   * patients asked, in order; then each patient stands alone: only an
   * answered patient's well-formed items are used, and a patient refused or
   * not checked is unknown without touching another's entry. Logs counts and
   * codes, never an id.
   */
  private readBatch<Progress>(kind: ProgressKind<Progress>, asked: readonly Asked[], payload: unknown,
    answer: (id: string, progress: Progress) => void): void {
    const entries = (payload as { patients?: unknown } | undefined)?.patients;
    if (!Array.isArray(entries) || entries.length !== asked.length || entries.some((entry, index) => !entry
      || typeof entry !== 'object' || (entry as { patientId?: unknown }).patientId !== asked[index]!.patientId)) {
      this.logger.warn(`Own ${kind.service} progress is unknown: malformed answer`);
      for (const entry of asked) for (const id of entry.ids) answer(id, kind.unknown);
      return;
    }
    const counts = { denied: 0, unavailable: 0, malformed: 0, other: 0 };
    const codes = { denied: new Set<string>(), unavailable: new Set<string>() };
    for (const [index, raw] of entries.entries()) {
      const entry = raw as { outcome?: unknown; code?: unknown };
      const { ids } = asked[index]!;
      const found = entry.outcome === 'answered' ? kind.items(entry, ids) : undefined;
      for (const id of ids) answer(id, found?.get(id) ?? kind.unknown);
      if (found) continue;
      if (entry.outcome === 'answered') counts.malformed += 1;
      else if (entry.outcome === 'denied' || entry.outcome === 'unavailable') {
        counts[entry.outcome] += 1;
        if (typeof entry.code === 'string' && LOGGABLE_CODE.test(entry.code)) codes[entry.outcome].add(entry.code);
      } else counts.other += 1;
    }
    const unanswered = counts.denied + counts.unavailable + counts.malformed + counts.other;
    if (unanswered === 0) return;
    const withCodes = (group: 'denied' | 'unavailable') => `${group} ${counts[group]}${codes[group].size > 0
      ? ` (${[...codes[group]].sort().join(', ')})` : ''}`;
    const groups = [counts.denied > 0 ? withCodes('denied') : '',
      counts.unavailable > 0 ? withCodes('unavailable') : '',
      counts.malformed > 0 ? `malformed ${counts.malformed}` : '',
      counts.other > 0 ? `other ${counts.other}` : ''].filter(Boolean).join('; ');
    this.logger.warn(`Own ${kind.service} progress is unknown for ${unanswered} of ${asked.length} patients: `
      + groups);
  }

  /**
   * Each patient on the one-patient route (an image without the batch form,
   * or a purpose other than direct care), each with the one-patient time
   * limit and headers. Each call holds one of `slots` while it runs, so a
   * page that shares its slots between both kinds makes at most
   * OWN_PROGRESS_FALLBACK_CONCURRENCY such calls at once in all, as #299's
   * one queue did. None starts once the signal has aborted, including a
   * patient whose worker was still waiting for a slot: the abort lets that
   * worker go at once, and its patient is unknown.
   */
  private async perPatient<Progress>(kind: ProgressKind<Progress>, context: DataAccessContext,
    asked: readonly Asked[], signal: AbortSignal | undefined, slots: OwnProgressSlots,
    answer: (id: string, progress: Progress) => void) {
    const queue = [...asked];
    const unknown = (entry: Asked) => {
      for (const id of entry.ids) answer(id, kind.unknown);
    };
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (!(await slots.take(signal))) {
          unknown(next);
          continue;
        }
        try {
          // A slot handed over in the same turn as the abort is still not used for a call.
          if (signal?.aborted) {
            unknown(next);
            continue;
          }
          const found = await kind.single(context, next.patientId, next.ids.map((id) => ({ id })), { signal });
          for (const id of next.ids) answer(id, found.get(id) ?? kind.unknown);
        } finally {
          slots.give();
        }
      }
    };
    // More workers than slots would only wait; fewer would leave a shared slot idle while this kind has patients.
    const workers = Math.min(slots.limit, queue.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  /**
   * One POST with the clinician's credentials and the EHR's internal-caller
   * proof. Any failure is logged and answers `ok: false`; on a batch call a
   * 404 is the image without the batch form (it answers before any guard,
   * so nothing was checked or audited), logged as expected, not as a fault.
   *
   * The client's own time limit, and its use of the caller's signal, end
   * when the answer's headers arrive; it then reads the body with neither.
   * So a call that has a signal, or is a batch call, does not wait on the
   * client alone: see untilStopped. A one-patient call without a signal
   * (every per-visit list and read, and the chart summary) waits on the
   * client exactly as before, with no extra timer.
   */
  private async call(service: 'pharmacy' | 'lab', path: string, context: DataAccessContext, body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number; batch?: boolean } = {}): Promise<Answer> {
    try {
      if (!context.authorization && !context.userCookie) throw new Error('no delegated credentials');
      // Nothing is started once the caller has stopped waiting.
      options.signal?.throwIfAborted();
      const environment = getEnvironment();
      const jwt = service === 'pharmacy' ? environment.PHARMACY_SERVICE_IDENTITY_MODE === 'jwt'
        : environment.LAB_SERVICE_IDENTITY_MODE === 'jwt';
      const token = service === 'pharmacy' ? environment.PHARMACY_INTERNAL_SERVICE_TOKEN
        : environment.LAB_INTERNAL_SERVICE_TOKEN;
      const caller: Record<string, string> = jwt
        ? { 'x-hid-service-authorization': await this.workloadIdentity.authorization(service) }
        : { 'x-hid-service-token': token ?? '' };
      const timeoutMs = options.timeoutMs ?? OWN_PROGRESS_TIMEOUT_MS;
      const request = requestJson({
        baseUrl: service === 'pharmacy' ? environment.PHARMACY_API_URL : environment.LAB_API_URL,
        path, method: 'POST', body, timeoutMs, credentials: 'omit',
        ...(options.signal ? { signal: options.signal } : {}),
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
          ...(service === 'pharmacy' ? { ...OWN_PROGRESS_HEADER, ...OWN_PROGRESS_ACCEPTED_HEADER } : {}),
        },
      });
      // The batch form's time limit runs from here until the payload is parsed (headers and body).
      const { response, payload } = options.signal || options.batch
        ? await untilStopped(request, options.signal, options.batch ? OWN_PROGRESS_BATCH_TIMEOUT_MS : undefined)
        : await request;
      if (!response.ok) {
        if (options.batch && response.status === 404) {
          this.logger.log(`Own ${service} progress: no batch form (404); asking per patient`);
          return { ok: false, noBatchForm: true };
        }
        const code = (payload as { code?: unknown } | undefined)?.code;
        this.logger.warn(`Own ${service} progress is unknown: ${response.status} ${typeof code === 'string' ? code : ''}`.trim());
        return { ok: false, noBatchForm: false };
      }
      return { ok: true, payload };
    } catch (error) {
      this.logger.warn(`Own ${service} progress is unknown: ${error instanceof Error ? error.name : 'error'}`);
      return { ok: false, noBatchForm: false };
    }
  }
}

/**
 * The request, or the first of these, whichever ends first:
 * - the caller's signal, when one is given: on 'abort' this rejects at once
 *   with the signal's reason, as an abort before the headers already does
 *   (the client passes the signal to fetch only until the headers arrive);
 * - on a batch call, `timeoutMs` (OWN_PROGRESS_BATCH_TIMEOUT_MS) from now,
 *   the moment the request was sent, until the payload is parsed: this
 *   rejects with HidRequestTimeoutError, the same error as the client's own
 *   limit to the headers, so both read the same in the log.
 * The request left behind is not cancelled: its body read keeps its socket
 * until the peer closes it or undici's body timeout ends it, because only
 * @hid/api-client could cancel it and decision 11 keeps that package
 * unchanged. Nothing waits for it, its answer is never read, and its own
 * failure is caught here so it can never be an unhandled rejection. The
 * listener and the timer go in the finally, so a call that settled leaves
 * nothing on the page's signal and no timer running.
 */
async function untilStopped<T>(request: Promise<T>, signal: AbortSignal | undefined,
  timeoutMs: number | undefined): Promise<T> {
  request.catch(() => undefined);
  let stop: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal?.reason);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => reject(new HidRequestTimeoutError()), timeoutMs);
      timer.unref?.();
    }
  });
  try {
    return await Promise.race([request, stopped]);
  } finally {
    signal?.removeEventListener('abort', stop);
    clearTimeout(timer);
  }
}

function batches(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let start = 0; start < ids.length; start += OWN_PROGRESS_BATCH) out.push(ids.slice(start, start + OWN_PROGRESS_BATCH));
  return out;
}

/**
 * The batch calls, greedy and in order: a patient with more than 100 ids is
 * cut into slices of 100, and a new call starts when the next slice would
 * pass 50 patients or 100 ids, or name its patient a second time (the
 * services refuse all three). A page of "Ordered by me" (at most 50 rows) is
 * always one call.
 */
function pack(asked: readonly Asked[]): Asked[][] {
  const calls: Asked[][] = [];
  let current: Asked[] = [];
  let count = 0;
  for (const patient of asked) {
    for (const ids of batches(patient.ids)) {
      if (current.length > 0 && (current.length === OWN_PROGRESS_BATCH_PATIENTS
        || count + ids.length > OWN_PROGRESS_BATCH || current.some((entry) => entry.patientId === patient.patientId))) {
        calls.push(current);
        current = [];
        count = 0;
      }
      current.push({ patientId: patient.patientId, ids });
      count += ids.length;
    }
  }
  if (current.length > 0) calls.push(current);
  return calls;
}

/** A pharmacy answer's items (one patient's, alone or in a batch entry) by id, or undefined when malformed. */
function pharmacyItems(answer: unknown, ids: readonly string[]): Map<string, PharmacyOwnProgress> | undefined {
  const parsed = parseItems(answer, ids, 'sourceEhrPrescriptionId', PHARMACY_STATUSES, PHARMACY_TIMES);
  return parsed && new Map([...parsed].map(([id, found]) => [id, { status: found.status as PharmacyOwnProgressStatus,
    receivedAt: found.receivedAt ?? null, acceptedAt: found.acceptedAt ?? null, dispensedAt: found.dispensedAt ?? null,
    reversedAt: found.reversedAt ?? null }]));
}

/** A laboratory answer's items (one patient's, alone or in a batch entry) by id, or undefined when malformed. */
function labItems(answer: unknown, ids: readonly string[]): Map<string, LabOwnProgress> | undefined {
  const parsed = parseItems(answer, ids, 'sourceEhrOrderId', LAB_STATUSES, LAB_TIMES);
  return parsed && new Map([...parsed].map(([id, found]) => [id, { status: found.status as LabOwnProgressStatus,
    receivedAt: found.receivedAt ?? null, collectedAt: found.collectedAt ?? null,
    lastResultAt: found.lastResultAt ?? null }]));
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
