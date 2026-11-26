import { Injectable, Logger, Optional } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { WorkItemProgressBatchDto, WorkItemProgressDto } from './dto/work-item-progress.dto';
import { OWN_WORK_OFF, PharmacyOwnWork, type OwnWorkState } from './own-work-access';
import { PharmacyRefills, REFILLS_OFF } from './prescription-refills';

/**
 * Where a prescription is in this facility's own pharmacy (ORD-3):
 * - not_received: no work item here that the clinician may read;
 * - received: the pharmacy has it and has not dispensed it;
 * - accepted (ORD-4): a pharmacist here accepted it (acceptedAt), and it is
 *   not dispensed: by the accept route, or handed in by hand
 *   (accept-ehr-prescription), when it was accepted as it was made;
 * - dispensed: it was dispensed (dispensedAt);
 * - dispensing_reversed: it was dispensed and the dispensing was reversed;
 *   with refills (ORD-12, 0154), 'dispensed' while any fill of the item stands
 *   (is not reversed), and 'dispensing_reversed', with `reversedAt` (the
 *   latest fill's reversal), only once every fill is reversed; `dispensedAt`
 *   stays the first fill's (0133's claim time);
 * - withdrawn (0133): sent by itself to the pharmacy, then held, cancelled,
 *   entered in error, edited or resumed before it was dispensed; the pharmacy
 *   holds the version sent, which it can no longer dispense;
 * - sent_elsewhere (0133 D14, owner's Q121 A): the pharmacy had it
 *   (receivedAt), and it was sent to another facility's pharmacy before it
 *   was dispensed; the item here is withdrawn and off the pharmacy's list.
 * withdrawn and sent_elsewhere are answered only to an ehr-api that reads
 * them (header X-HID-Own-Progress: 0133); see OWN_PROGRESS_HEADER. accepted
 * and acceptedAt only to one that also reads them (X-HID-Own-Progress-Accepted:
 * ord4); see OWN_PROGRESS_ACCEPTED_HEADER.
 */
export type PharmacyProgressStatus = 'not_received' | 'received' | 'accepted' | 'dispensed' | 'dispensing_reversed'
  | 'withdrawn' | 'sent_elsewhere';

/**
 * ehr-api sends this header, with OWN_PROGRESS_VERSION, when it reads
 * 'withdrawn' and 'sent_elsewhere' (0133). An ehr-api from before 0133 knows
 * four statuses and treats a whole answer with any other as unknown, so
 * without the header 'withdrawn' is answered 'received' (times kept) and
 * 'sent_elsewhere' 'not_received' (times null).
 */
export const OWN_PROGRESS_HEADER = 'x-hid-own-progress';
export const OWN_PROGRESS_VERSION = '0133';

/**
 * ORD-4: an ehr-api that reads 'accepted' and `acceptedAt` sends this header,
 * with OWN_PROGRESS_ACCEPTED_VERSION, beside OWN_PROGRESS_HEADER, which stays
 * exactly '0133' (a Release A pharmacy-api matches it exactly). Each value is
 * matched exactly, and the new statuses need both: without this one,
 * 'accepted' is answered 'received' (times kept) and `acceptedAt` is left
 * out, so an ehr-api from before ORD-4, which treats a whole answer with a
 * status it does not know as unknown, reads every answer as before. Either
 * image can then be deployed, or rolled back, first.
 */
export const OWN_PROGRESS_ACCEPTED_HEADER = 'x-hid-own-progress-accepted';
export const OWN_PROGRESS_ACCEPTED_VERSION = 'ord4';

export interface PharmacyProgressItem {
  sourceEhrPrescriptionId: string;
  status: PharmacyProgressStatus;
  receivedAt: string | null;
  dispensedAt: string | null;
  reversedAt: string | null;
  /**
   * ORD-4, only to a caller sending both headers: when a pharmacist here
   * accepted it, whatever the status now (also dispensed, withdrawn or sent
   * elsewhere), or null (none yet, or it cannot be read).
   */
  acceptedAt?: string | null;
  /**
   * ORD-12, only while PRESCRIPTION_REFILLS_ENABLED is on: the latest fill's
   * time (null before the first). `dispensedAt` stays the first fill's;
   * `reversedAt` is the latest fill's reversal, and only once every fill is
   * reversed. An ehr-api that does not read it drops it (its parser keeps the
   * fields it names).
   */
  lastFilledAt?: string | null;
}

interface ProgressRow extends QueryResultRow {
  work_item_id: string; source_ehr_prescription_id: string; accepted_at: Date;
  dispensed_at: Date | null; reversed_at: Date | null; last_filled_at: Date | null;
  /** ORD-12: a fill of the item is not reversed (false, or absent, when none is recorded). */
  fill_standing?: boolean | null;
}

/**
 * This facility's own work items for the given EHR prescriptions of one
 * patient: $1 patient, $2 facility, $3 prescription ids. Work items on an
 * order route to another facility are not this facility's own and are left
 * out (their progress is on the route). Row-level security applies as well:
 * the clinician reads under their own consent grant (pharmacy.work_item_allows
 * and pharmacy.context_allows), never the pharmacist's. One row per work
 * item, whatever its number of fills (ORD-12, 0154, setting on or off): the
 * first fill's time (`dispensed_at`, 0133's claim time), the latest fill's
 * (`last_filled_at`) and the latest fill's reversal (one per dispensing,
 * 0023), each by fill number, and whether any fill of the item stands (has no
 * reversal), so that a refill reversed after an earlier fill that stands
 * still reads dispensed (false when none is recorded). Every row read runs
 * the clinician's read policies (the consent test, about 1.5 ms), so the
 * statement reads as few fills as it can, and as many whatever the number of
 * fills (Rahman's review of 25 November 2026: reading every fill and
 * reversal grew about 1.5 ms per fill per item): first the latest fill and
 * its reversal (the lateral, by fill number, one row); then, only when the
 * latest is not fill 1, fill 1 by its number (an equality on the key
 * (work_item_id, fill_number), so at most one row, whatever plan is chosen;
 * the first fill the session may read when fill 1 is hidden from it, as
 * before); and only when the latest fill is reversed, whether an earlier
 * fill stands. So an item reads one fill (one fill recorded), or two
 * (refills), and an earlier fill's reversal only when its latest is
 * reversed. The answers are the ones the earlier statement gave (every fill
 * and reversal read in one lateral). Measured on a throwaway production-kind
 * copy (0001-0154 by a NOSUPERUSER NOBYPASSRLS migrator, the union grants),
 * as hid_pharmacy_api_runtime in a doctor's session on consent, 100 ids,
 * medians of 5 (consent-test calls, pharmacy.context_allows, in brackets),
 * Release E's statement (one row per fill, a cost baseline only) / the one
 * before (every fill and reversal in one lateral) / this one: 1 fill 190 /
 * 190 / 188 ms (100 / 100 / 100); 2 fills 281 / 282 / 283 ms (200 each); 3
 * fills 376 / 374 / 282 ms (300 / 300 / 200); 6 fills 651 / 658 / 283 ms
 * (600 / 600 / 200); 12 fills 1,207 / 1,211 / 284 ms (1,200 / 1,200 / 200);
 * 12 fills, 1-11 reversed, 2,238 / 2,232 / 285 ms (2,300 / 2,300 / 200); 12
 * fills, the 12th reversed, 1,301 / 1,318 / 478 ms (1,300 / 1,300 / 400).
 * The one case it does not keep flat is an item whose every fill is
 * reversed, where it must read each fill and its reversal to know that none
 * stands: 12 fills, all reversed, 2,356 / 2,352 / 2,442 ms (2,400 / 2,400 /
 * 2,500). The same answers as the one before, row for row, in all of these
 * and with a random set of reversals on 100 items and with fills hidden from
 * the session by row-level security. It needs 0154's `fill_number`.
 * Exported for the tests.
 */
export const WORK_ITEM_PROGRESS_QUERY = `select w.id::text as work_item_id,
  w.source_ehr_prescription_id::text as source_ehr_prescription_id, w.accepted_at,
  case when l.id is null then null when l.fill_number=1 then l.dispensed_at
    else coalesce((select f1.dispensed_at from pharmacy.dispensings f1
        where f1.work_item_id=w.id and f1.fill_number=1),
      (select fv.dispensed_at from pharmacy.dispensings fv
        where fv.work_item_id=w.id order by fv.fill_number asc limit 1)) end as dispensed_at,
  l.dispensed_at as last_filled_at, l.reversed_at,
  case when l.id is null then false when l.reversal_id is null then true
    else exists (select 1 from pharmacy.dispensings fe
      where fe.work_item_id=w.id and fe.fill_number<l.fill_number
        and not exists (select 1 from pharmacy.dispensing_reversals re where re.dispensing_id=fe.id)) end
    as fill_standing
  from pharmacy.work_items w
  left join lateral (select df.id, df.fill_number, df.dispensed_at, rs.id as reversal_id, rs.reversed_at
    from pharmacy.dispensings df
    left join pharmacy.dispensing_reversals rs on rs.dispensing_id=df.id
    where df.work_item_id=w.id order by df.fill_number desc limit 1) l on true
  where w.patient_id=$1::uuid and w.facility_id=$2::uuid and w.order_route_id is null
    and w.source_ehr_prescription_id=any($3::uuid[])`;

/** At most this many Identity checks of one batch read run at once (decision 4). */
export const PROGRESS_BATCH_CHECK_CONCURRENCY = 4;

/**
 * Every Identity check of one batch read is done within this long of the
 * handler's start (decision 4), or aborted: ehr-api waits 3.5 seconds for the
 * whole call, and this leaves time for the guard, the transactions and the
 * way back.
 */
export const PROGRESS_BATCH_CHECK_BUDGET_MS = 2_000;

/**
 * One patient's entry in the batch answer: answered with its items, exactly
 * as the one-patient route; or denied (audited) or unavailable, with a code
 * and never items.
 */
export type PharmacyProgressBatchEntry = { patientId: string; outcome: 'answered'; items: PharmacyProgressItem[] }
  | { patientId: string; outcome: 'denied' | 'unavailable'; code: string };

/** One patient's check in the batch. */
type Verdict = { outcome: 'answered'; breakGlass: boolean }
  | { outcome: 'denied'; code: string; reason: 'identity_refusal' | 'identity_authorization' }
  | { outcome: 'unavailable'; code: string };

/** Not checked before the budget ran out, or aborted by it. */
const TIME_LIMIT: Verdict = { outcome: 'unavailable', code: 'PROGRESS_CHECK_TIME_LIMIT' };

/**
 * ORD-3: a read-only progress answer for ehr-api, which shows the clinician
 * whether this facility's pharmacy received and dispensed each prescription.
 * Identity first decides the clinician's read of the patient (a refusal is
 * 403 and is audited); then one audit row names the patient, with the
 * prescriptions asked about and the work items found, in the read's
 * transaction (no answer without its audit row).
 */
@Injectable()
export class PharmacyWorkItemProgressService {
  /** How long readBatch's checks may take, from its start; a property so a test can shorten it. */
  batchCheckBudgetMs = PROGRESS_BATCH_CHECK_BUDGET_MS;
  /** For PROGRESS_CHECK_FAILED only. */
  private readonly logger = new Logger(PharmacyWorkItemProgressService.name);

  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService, private readonly ownWork: PharmacyOwnWork = OWN_WORK_OFF,
    // ORD-12: `lastFilledAt` while PRESCRIPTION_REFILLS_ENABLED is on; off by default, so every existing caller is
    // unchanged. @Optional, as PharmacyService's last parameters are.
    @Optional() private readonly refills: PharmacyRefills = REFILLS_OFF) {}

  /**
   * `current`: the caller sent OWN_PROGRESS_HEADER (it reads 'withdrawn' and
   * 'sent_elsewhere'). `accepted`: it also sent OWN_PROGRESS_ACCEPTED_HEADER
   * (it reads 'accepted' and `acceptedAt`); taken only with `current`.
   */
  async read(context: DataAccessContext, input: WorkItemProgressDto, current = false, accepted = false):
  Promise<{ items: PharmacyProgressItem[] }> {
    // The clinician's browser request to ehr-api was a read (GET), and this
    // route only reads, so Identity is told GET: its delegated path then
    // checks a forwarded cookie without the browser-write Origin and CSRF
    // check (the website sends no CSRF token on a GET) and allows only
    // read_records, which is all this asks for. request.method here is the
    // POST of the internal ehr-api call, never the clinician's.
    const readContext: DataAccessContext = { ...context, requestMethod: 'GET' };
    const denied = (reason: string) => this.database.withTransaction(context, (client) => this.audit.recordWithClient(
      client, context, 'pharmacy.work-item.progress.read', { patientId: input.patientId,
        resourceType: 'pharmacy-work-item-collection', resourceId: context.facilityId },
      { requestedCount: input.sourceEhrPrescriptionIds.length, reason }, 'denied'));
    let decision: Awaited<ReturnType<IdentityService['authorize']>>;
    try {
      decision = await this.identity.authorize(input.patientId, 'read_records', readContext);
    } catch (error) {
      // Identity's own refusal (403) is a denied read of this patient, audited as one.
      if (error instanceof DomainProblem && error.getStatus() === 403) await denied('identity_refusal');
      throw error;
    }
    if (!decision.allowed) {
      await denied('identity_authorization');
      throw new DomainProblem(403, 'PHARMACY_ACCESS_DENIED', 'Pharmacy access is not authorized');
    }
    return this.database.withTransaction(context, async (client) => {
      const rows = (await client.query<ProgressRow>(WORK_ITEM_PROGRESS_QUERY,
        [input.patientId, context.facilityId, input.sourceEhrPrescriptionIds])).rows;
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.progress.read', {
        patientId: input.patientId, resourceType: 'pharmacy-work-item-collection', resourceId: context.facilityId,
      }, { requestedCount: input.sourceEhrPrescriptionIds.length, foundCount: rows.length,
        workItemIds: rows.map((row) => row.work_item_id), breakGlass: decision.breakGlass });
      // 0133: whether each item was withdrawn before it was dispensed, and why (no flag when it cannot be read);
      // ORD-4: in the same reader statement, its pharmacist's acceptance (none when it cannot be read).
      const states = await this.ownWork.states(client, rows.map((row) => row.work_item_id), context.correlationId, 'flag');
      return { items: progressItems(input.sourceEhrPrescriptionIds, rows, states, current, accepted,
        this.refills.enabled) };
    });
  }

  /**
   * Decision 4: ORD-3 for several patients; each patient as by a call of its
   * own. Each patient gets its own Identity check (at most
   * PROGRESS_BATCH_CHECK_CONCURRENCY at once, all within batchCheckBudgetMs),
   * its own denied or success row, and today's statement bound to that
   * patient alone; a patient that is refused, or could not be checked, is
   * answered without items and changes nothing in another patient's entry.
   * Direct care only. One transaction writes every denial, before the read;
   * one more reads every allowed patient.
   */
  async readBatch(context: DataAccessContext, input: WorkItemProgressBatchDto, current = false, accepted = false):
  Promise<{ patients: PharmacyProgressBatchEntry[] }> {
    // MY-1 reads under direct care only. An emergency read of many patients at
    // once has no use, so it keeps the one-patient route; refused before
    // Identity is asked anything.
    if (context.purposeOfUse !== 'direct-care') {
      throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care for this route');
    }
    const patients = input.patients;
    const verdicts = await this.checkAll(context, patients);
    const resource = (patientId: string) => ({ patientId, resourceType: 'pharmacy-work-item-collection',
      resourceId: context.facilityId });
    const denied = patients.flatMap((entry, index) => {
      const verdict = verdicts[index]!;
      return verdict.outcome === 'denied' ? [{ entry, reason: verdict.reason }] : [];
    });
    // Every denial is written, and committed, before anything is read, as the
    // one-patient route writes its denial before it answers 403.
    if (denied.length > 0) {
      await this.database.withTransaction(context, async (client) => {
        for (const { entry, reason } of denied) {
          await this.audit.recordWithClient(client, context, 'pharmacy.work-item.progress.read', resource(entry.patientId),
            { requestedCount: entry.sourceEhrPrescriptionIds.length, reason, via: 'batch' }, 'denied');
        }
      });
    }
    const allowed = patients.flatMap((entry, index) => {
      const verdict = verdicts[index]!;
      return verdict.outcome === 'answered' ? [{ entry, index, breakGlass: verdict.breakGlass }] : [];
    });
    const answered = new Map<number, PharmacyProgressItem[]>();
    if (allowed.length > 0) {
      const items = await this.database.withTransaction(context, async (client) => {
        const found: Array<{ entry: WorkItemProgressDto; rows: ProgressRow[] }> = [];
        for (const { entry, breakGlass } of allowed) {
          // Today's statement, bound to this patient and this patient's ids
          // only: no id reaches a statement bound to another patient.
          const rows = (await client.query<ProgressRow>(WORK_ITEM_PROGRESS_QUERY,
            [entry.patientId, context.facilityId, entry.sourceEhrPrescriptionIds])).rows;
          await this.audit.recordWithClient(client, context, 'pharmacy.work-item.progress.read', resource(entry.patientId),
            { requestedCount: entry.sourceEhrPrescriptionIds.length, foundCount: rows.length,
              workItemIds: rows.map((row) => row.work_item_id), breakGlass, via: 'batch' });
          found.push({ entry, rows });
        }
        // 0133's and ORD-4's reader once for the whole call (at most 100 work
        // items, within one statement of the reader); each item keeps its own
        // state, so a patient's items are built from its own rows only.
        const states = await this.ownWork.states(client, found.flatMap(({ rows }) => rows.map((row) => row.work_item_id)),
          context.correlationId, 'flag');
        return found.map(({ entry, rows }) =>
          progressItems(entry.sourceEhrPrescriptionIds, rows, states, current, accepted, this.refills.enabled));
      });
      allowed.forEach(({ index }, position) => answered.set(index, items[position]!));
    }
    return { patients: patients.map((entry, index): PharmacyProgressBatchEntry => {
      const verdict = verdicts[index]!;
      return verdict.outcome === 'answered'
        ? { patientId: entry.patientId, outcome: 'answered', items: answered.get(index)! }
        : { patientId: entry.patientId, outcome: verdict.outcome, code: verdict.code };
    }) };
  }

  /**
   * Each patient's check, in the order asked, by at most
   * PROGRESS_BATCH_CHECK_CONCURRENCY workers. When batchCheckBudgetMs is up,
   * the checks still running are aborted and no longer waited for, and the
   * ones not started are not started, so one hung check cannot hold the
   * whole call past ehr-api's timeout; those patients are unavailable, not
   * refused.
   */
  private async checkAll(context: DataAccessContext, patients: readonly WorkItemProgressDto[]): Promise<Verdict[]> {
    // As read(): the clinician's browser request was a GET; see there.
    const readContext: DataAccessContext = { ...context, requestMethod: 'GET' };
    const budget = new AbortController();
    // An explicit timer (not AbortSignal.timeout) so a test can shorten batchCheckBudgetMs.
    const timer = setTimeout(() => budget.abort(), this.batchCheckBudgetMs);
    timer.unref?.();
    const verdicts: Verdict[] = [];
    let next = 0;
    const worker = async () => {
      while (next < patients.length) {
        const index = next;
        next += 1;
        verdicts[index] = budget.signal.aborted ? TIME_LIMIT
          : await this.check(patients[index]!.patientId, readContext, budget.signal);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PROGRESS_BATCH_CHECK_CONCURRENCY, patients.length) }, worker));
    } finally {
      clearTimeout(timer);
    }
    return verdicts;
  }

  /** One patient's verdict, by the table of the batch contract (in its order); never throws. */
  private async check(patientId: string, readContext: DataAccessContext, signal: AbortSignal): Promise<Verdict> {
    let decision: Awaited<ReturnType<IdentityService['authorize']>>;
    try {
      decision = await withinBudget(this.identity.authorize(patientId, 'read_records', readContext, { signal }),
        signal);
    } catch (error) {
      // Identity's own refusal (403) is a denied read of this patient, audited as one, as read() does.
      if (error instanceof DomainProblem && error.getStatus() === 403) {
        return { outcome: 'denied', code: error.code, reason: 'identity_refusal' };
      }
      // The Identity client answers an aborted check as Identity being
      // unavailable, and withinBudget stops waiting with the signal's reason;
      // either way it was our time limit.
      if (signal.aborted) return TIME_LIMIT;
      if (error instanceof DomainProblem) return { outcome: 'unavailable', code: error.code };
      // Neither ids nor the message: only what tells the failure apart.
      this.logger.error({ message: 'Own progress check failed', correlationId: readContext.correlationId,
        errorName: error instanceof Error ? error.name : 'UnknownError' });
      return { outcome: 'unavailable', code: 'PROGRESS_CHECK_FAILED' };
    }
    // Not allowed is a denial, by the same test as read() (and lab-api's batch).
    if (!decision.allowed) {
      return { outcome: 'denied', code: 'PHARMACY_ACCESS_DENIED', reason: 'identity_authorization' };
    }
    // A break-glass decision is never read through the batch (decision 4: an
    // emergency read keeps the one-patient route), so a decision carrying it
    // is not an answer this route takes.
    if (decision.breakGlass !== false) {
      return { outcome: 'unavailable', code: 'INVALID_IDENTITY_RESPONSE' };
    }
    return { outcome: 'answered', breakGlass: decision.breakGlass };
  }
}

/**
 * The check, or the budget, whichever ends first: once the signal aborts,
 * this rejects with its reason. The Identity client stops its own time limit
 * and the abort once Identity's answer headers arrive, and reads the body
 * after them with neither, so one stalled answer would otherwise hold its
 * worker, and with it the whole call, past ehr-api's timeout. The check left
 * behind ends on its own; nothing waits for it, and its answer is not read.
 */
async function withinBudget<T>(check: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: () => void = () => undefined;
  const spent = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
  try {
    // Promise.race keeps a handler on the promise that loses, so a late
    // failure of the check left behind is not an unhandled rejection.
    return await Promise.race([check, spent]);
  } finally {
    // One listener per check in flight, so the budget's signal never holds more than four of ours.
    signal.removeEventListener('abort', stop);
  }
}

/**
 * Each id asked, in the order asked, from this patient's own rows only (ids
 * matched without regard to letter case and answered as sent); shared by
 * read() and readBatch(), so a batch entry is exactly the one-patient answer.
 * `refills` (ORD-12, PRESCRIPTION_REFILLS_ENABLED on): each item also carries
 * `lastFilledAt`, the latest fill's time, null whenever `dispensedAt` is; off,
 * no item carries it.
 */
function progressItems(ids: readonly string[], rows: readonly ProgressRow[], states: Map<string, OwnWorkState>,
  current: boolean, accepted: boolean, refills: boolean): PharmacyProgressItem[] {
  const found = new Map(rows.map((row) => [row.source_ehr_prescription_id.toLowerCase(), row]));
  return ids.map((id) => {
    const row = found.get(id.toLowerCase());
    const item = project(id, row, row ? states.get(row.work_item_id) : undefined, current, current && accepted);
    return refills
      ? { ...item, lastFilledAt: item.dispensedAt === null ? null : iso(row?.last_filled_at ?? null) } : item;
  });
}

/**
 * The status, in this order: a reversal of every fill (ORD-12: while any fill
 * stands the item reads dispensed, and `reversedAt` is null), a dispensing,
 * sent elsewhere, withdrawn, accepted (ORD-4), else received. To a caller without
 * OWN_PROGRESS_HEADER, 'withdrawn' is 'received' (times kept) and
 * 'sent_elsewhere' 'not_received' (times null), the statuses an ehr-api from
 * before 0133 knows. To a caller without both headers (`accepted` false),
 * 'accepted' is 'received' (times kept) and `acceptedAt` is left out; with
 * both, every item carries `acceptedAt`, null when there is none.
 */
function project(id: string, row: ProgressRow | undefined, state: OwnWorkState | undefined,
  current: boolean, accepted: boolean): PharmacyProgressItem {
  const notReceived: PharmacyProgressItem = { sourceEhrPrescriptionId: id, status: 'not_received', receivedAt: null,
    dispensedAt: null, reversedAt: null, ...(accepted ? { acceptedAt: null } : {}) };
  if (!row) return notReceived;
  const acceptedAt = acceptedTime(row, state);
  const reversedAt = row.reversed_at && row.fill_standing !== true ? row.reversed_at : null;
  const status: PharmacyProgressStatus = reversedAt ? 'dispensing_reversed'
    : row.dispensed_at ? 'dispensed'
      : state?.withdrawn === true && state.withdrawnReason === 'sent_elsewhere' ? 'sent_elsewhere'
        : state?.withdrawn === true ? 'withdrawn'
          : acceptedAt !== null ? 'accepted' : 'received';
  if (!current && status === 'sent_elsewhere') return notReceived;
  const answered: PharmacyProgressStatus = (!current && status === 'withdrawn') || (!accepted && status === 'accepted')
    ? 'received' : status;
  return { sourceEhrPrescriptionId: id, status: answered, receivedAt: iso(row.accepted_at),
    dispensedAt: iso(row.dispensed_at), reversedAt: iso(reversedAt),
    ...(accepted ? { acceptedAt: iso(acceptedAt) } : {}) };
}

/**
 * ORD-4: when a pharmacist here accepted the item, from ORD-4's steps reader
 * only: its stored acceptance (the accept route, or its first dispensing);
 * else, for an item not sent automatically (handed in by a pharmacist by
 * hand), the time it was handed in; else, or when the reader did not answer
 * (a schema without it, or a failure), none, so it is never guessed.
 */
function acceptedTime(row: ProgressRow, state: OwnWorkState | undefined): Date | null {
  const steps = state?.steps;
  if (!steps) return null;
  if (steps.acceptance) return steps.acceptance.acceptedAt;
  return steps.sentAutomatically ? null : row.accepted_at;
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
