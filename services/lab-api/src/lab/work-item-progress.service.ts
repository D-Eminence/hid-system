import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { LabWorkItemProgressBatchDto, LabWorkItemProgressDto } from './dto/work-item-progress.dto';

/**
 * Where a lab request is in this facility's own laboratory (ORD-3):
 * - not_received: no work item here that the clinician may read;
 * - received: the laboratory has it and no sample is taken yet;
 * - sample_collected: a sample was taken (collectedAt, the first one);
 * - some_results_ready: some of its tests have a released result;
 * - results_ready: every test it asks for has a released result.
 * A result counts only while its current version is released and not marked
 * entered in error, the same rule as the laboratory's own work list.
 */
export type LabProgressStatus = 'not_received' | 'received' | 'sample_collected' | 'some_results_ready'
  | 'results_ready';

export interface LabProgressItem {
  sourceEhrOrderId: string;
  status: LabProgressStatus;
  receivedAt: string | null;
  collectedAt: string | null;
  lastResultAt: string | null;
}

/** At most this many Identity checks at once in one batch progress read (decision 4). */
export const PROGRESS_BATCH_CHECK_CONCURRENCY = 4;

/**
 * Every Identity check of a batch progress read must finish within this long
 * of the handler's start (decision 4), well inside ehr-api's 3.5 s timeout for
 * the call, so one hung check costs only its own patient.
 */
export const PROGRESS_BATCH_CHECK_BUDGET_MS = 2_000;

/** One patient's answer in a batch progress read: its items, or why there are none. */
export type LabProgressBatchEntry = { patientId: string; outcome: 'answered'; items: LabProgressItem[] }
  | { patientId: string; outcome: 'denied' | 'unavailable'; code: string };

/** What one patient's Identity check decided (section 2.4's table). */
type BatchVerdict = { outcome: 'answered'; breakGlass: boolean }
  | { outcome: 'denied'; code: string; reason: 'identity_refusal' | 'identity_authorization' }
  | { outcome: 'unavailable'; code: string };

/** A check not done within the budget: that patient is not read, and it is no denial. */
const TIME_LIMIT: BatchVerdict = { outcome: 'unavailable', code: 'PROGRESS_CHECK_TIME_LIMIT' };

interface ProgressRow extends QueryResultRow {
  work_item_id: string; source_ehr_order_id: string; accepted_at: Date; collected_at: Date | null;
  test_count: number; released_count: number; released_at: Date | null;
}

/**
 * This facility's own work items for the given EHR lab requests of one
 * patient: $1 patient, $2 facility, $3 lab request ids. Work items on an
 * order route to another facility are left out (their progress is on the
 * route). Every Lab table is read under row-level security, which the
 * clinician passes with their own consent grant (lab.context_allows), never a
 * laboratory member's. A sample counts once taken (collected or received; not
 * one rejected, cancelled or entered in error). Exported for the tests.
 */
export const LAB_WORK_ITEM_PROGRESS_QUERY = `select w.id::text as work_item_id,
  w.source_ehr_order_id::text as source_ehr_order_id, w.accepted_at,
  c.collected_at, t.test_count, rl.released_count, rl.released_at
  from lab.work_items w
  cross join lateral (select min(s.collected_at) as collected_at from lab.accessions a
    join lab.specimens s on s.accession_id=a.id
    where a.work_item_id=w.id and s.status in ('collected','received') and s.collected_at is not null) c
  cross join lateral (select count(*)::int as test_count from lab.work_item_requested_tests rt
    where rt.work_item_id=w.id) t
  cross join lateral (select count(distinct e.requested_test_id)::int as released_count,
      max(rel.released_at) as released_at
    from lab.work_item_requested_tests rt
    join lab.test_executions e on e.requested_test_id=rt.id
    join lab.results r on r.execution_id=e.id
    join lab.result_releases rel on rel.result_id=r.id and rel.result_version=r.current_version
    where rt.work_item_id=w.id and not exists(select 1 from lab.result_invalidations i
      where i.result_id=r.id and i.result_version=r.current_version)) rl
  where w.patient_id=$1::uuid and w.facility_id=$2::uuid and w.order_route_id is null
    and w.source_ehr_order_id=any($3::uuid[])`;

/**
 * ORD-3: a read-only progress answer for ehr-api, which shows the clinician
 * whether this facility's laboratory received each lab request, took the
 * sample and released results. Identity first decides the clinician's read of
 * the patient (a refusal is 403 and is audited); then one audit row names the
 * patient, with the requests asked about and the work items found, in the
 * read's transaction (no answer without its audit row).
 */
@Injectable()
export class LabWorkItemProgressService {
  private readonly logger = new Logger(LabWorkItemProgressService.name);

  /** Public so tests can shorten it; the route always uses the default. */
  batchCheckBudgetMs = PROGRESS_BATCH_CHECK_BUDGET_MS;

  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService) {}

  async read(context: DataAccessContext, input: LabWorkItemProgressDto): Promise<{ items: LabProgressItem[] }> {
    // The clinician's browser request to ehr-api was a read (GET), and this
    // route only reads, so Identity is told GET: its delegated path then
    // checks a forwarded cookie without the browser-write Origin and CSRF
    // check (the website sends no CSRF token on a GET) and allows only
    // read_records, which is all this asks for. request.method here is the
    // POST of the internal ehr-api call, never the clinician's.
    const readContext: DataAccessContext = { ...context, requestMethod: 'GET' };
    const denied = (reason: string) => this.database.withTransaction(context, (client) => this.audit.recordWithClient(
      client, this.event(context, input.patientId, 'denied', { requestedCount: input.sourceEhrOrderIds.length,
        reason })));
    let decision: Awaited<ReturnType<IdentityService['authorize']>>;
    try {
      decision = await this.identity.authorize(input.patientId, 'read_records', context.purposeOfUse, readContext);
    } catch (error) {
      // Identity's own refusal (403) is a denied read of this patient, audited as one.
      if (error instanceof HttpException && error.getStatus() === 403) await denied('identity_refusal');
      throw error;
    }
    if (!decision.allowed) {
      await denied('identity_authorization');
      throw new DomainProblem(403, 'LAB_WORK_ITEM_ACCESS_DENIED', 'Lab work-item access is not authorized');
    }
    return this.database.withTransaction(context, async (client) => ({
      items: await this.readPatient(client, context, input, decision.breakGlass) }));
  }

  /**
   * Decision 4: ORD-3 for several patients; each patient as by a call of its
   * own. Every patient gets its own Identity check (at most 4 at once, all
   * within the budget), and only a patient Identity allowed is read, with the
   * one-patient statement bound to that patient, so no refused or unchecked
   * patient's ids reach the database. One patient refused or not checked
   * changes nothing in another's answer, so it is an entry, never a refusal
   * of the call.
   */
  async readBatch(context: DataAccessContext, input: LabWorkItemProgressBatchDto):
    Promise<{ patients: LabProgressBatchEntry[] }> {
    // MY-1 reads for direct care only; an emergency read keeps the one-patient
    // route, where each break-glass read is a request of its own.
    if (context.purposeOfUse !== 'direct-care') {
      throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care for this route');
    }
    const verdicts = await this.checkAll(context, input.patients.map((entry) => entry.patientId));
    const deniedAt = verdicts.flatMap((verdict, index) => (verdict.outcome === 'denied' ? [index] : []));
    // The denials are committed before the read, as on the one-patient route,
    // so a failed read cannot take a refusal's audit row with it.
    if (deniedAt.length > 0) {
      await this.database.withTransaction(context, async (client) => {
        for (const index of deniedAt) {
          const entry = input.patients[index]!;
          const verdict = verdicts[index] as Extract<BatchVerdict, { outcome: 'denied' }>;
          await this.audit.recordWithClient(client, this.event(context, entry.patientId, 'denied',
            { requestedCount: entry.sourceEhrOrderIds.length, reason: verdict.reason, via: 'batch' }));
        }
      });
    }
    const items = new Map<number, LabProgressItem[]>();
    if (verdicts.some((verdict) => verdict.outcome === 'answered')) {
      await this.database.withTransaction(context, async (client) => {
        for (const [index, entry] of input.patients.entries()) {
          const verdict = verdicts[index]!;
          if (verdict.outcome !== 'answered') continue;
          items.set(index, await this.readPatient(client, context, entry, verdict.breakGlass, { via: 'batch' }));
        }
      });
    }
    return { patients: input.patients.map((entry, index): LabProgressBatchEntry => {
      const verdict = verdicts[index]!;
      return verdict.outcome === 'answered'
        ? { patientId: entry.patientId, outcome: 'answered', items: items.get(index)! }
        : { patientId: entry.patientId, outcome: verdict.outcome, code: verdict.code };
    }) };
  }

  /**
   * One patient's rows, its success row and its items, in the caller's
   * transaction; read() and readBatch() share it, so a batch entry is the
   * one-patient answer. Rows are matched to ids of this patient only.
   */
  private async readPatient(client: PoolClient, context: DataAccessContext, input: LabWorkItemProgressDto,
    breakGlass: boolean, extra: { via?: 'batch' } = {}): Promise<LabProgressItem[]> {
    const rows = (await client.query<ProgressRow>(LAB_WORK_ITEM_PROGRESS_QUERY,
      [input.patientId, context.facilityId, input.sourceEhrOrderIds])).rows;
    await this.audit.recordWithClient(client, this.event(context, input.patientId, 'success', {
      requestedCount: input.sourceEhrOrderIds.length, foundCount: rows.length,
      workItemIds: rows.map((row) => row.work_item_id), breakGlass, ...extra }));
    const found = new Map(rows.map((row) => [row.source_ehr_order_id.toLowerCase(), row]));
    return input.sourceEhrOrderIds.map((id) => project(id, found.get(id.toLowerCase())));
  }

  /**
   * Each patient's Identity check, in the order asked, by at most
   * PROGRESS_BATCH_CHECK_CONCURRENCY workers. At the budget the checks still
   * running are aborted and no longer waited for, and the rest are not
   * started, so one hung check cannot hold the whole call past ehr-api's
   * timeout. An explicit timer, not AbortSignal.timeout, so tests can shorten
   * batchCheckBudgetMs.
   */
  private async checkAll(context: DataAccessContext, patientIds: readonly string[]): Promise<BatchVerdict[]> {
    // As read(): the clinician's browser request was a GET, whatever this call's method.
    const readContext: DataAccessContext = { ...context, requestMethod: 'GET' };
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), this.batchCheckBudgetMs);
    timer.unref?.();
    const verdicts: BatchVerdict[] = new Array<BatchVerdict>(patientIds.length);
    let next = 0;
    const worker = async () => {
      while (next < patientIds.length) {
        const index = next;
        next += 1;
        verdicts[index] = budget.signal.aborted ? TIME_LIMIT
          : await this.check(context, readContext, patientIds[index]!, budget.signal);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PROGRESS_BATCH_CHECK_CONCURRENCY, patientIds.length) }, worker));
    } finally {
      clearTimeout(timer);
    }
    return verdicts;
  }

  /** One patient's verdict, by section 2.4's table, in its order. */
  private async check(context: DataAccessContext, readContext: DataAccessContext, patientId: string,
    signal: AbortSignal): Promise<BatchVerdict> {
    let decision: Awaited<ReturnType<IdentityService['authorize']>>;
    try {
      decision = await withinBudget(this.identity.authorize(patientId, 'read_records', context.purposeOfUse,
        readContext, { signal }), signal);
    } catch (error) {
      // Identity's own refusal (403) is a denied read of this patient, as on the one-patient route.
      if (error instanceof HttpException && error.getStatus() === 403) {
        return { outcome: 'denied', code: error instanceof DomainProblem ? error.code : 'ACCESS_DENIED',
          reason: 'identity_refusal' };
      }
      // The abort surfaces as Identity unavailable, or, for a check still
      // running, as withinBudget's signal reason; it was the budget, not Identity.
      if (signal.aborted) return TIME_LIMIT;
      if (error instanceof DomainProblem) return { outcome: 'unavailable', code: error.code };
      // Only the error's name: its message could carry a patient or lab request id.
      this.logger.error({ message: 'Own progress check failed', correlationId: context.correlationId,
        errorName: error instanceof Error ? error.name : 'UnknownError' });
      return { outcome: 'unavailable', code: 'PROGRESS_CHECK_FAILED' };
    }
    if (!decision.allowed) {
      return { outcome: 'denied', code: 'LAB_WORK_ITEM_ACCESS_DENIED', reason: 'identity_authorization' };
    }
    // A direct-care check never allows by break-glass, and this route never
    // reads by it (decision 4), so a decision that says it did is not read.
    if (decision.breakGlass !== false) return { outcome: 'unavailable', code: 'INVALID_IDENTITY_RESPONSE' };
    return { outcome: 'answered', breakGlass: decision.breakGlass };
  }

  private event(context: DataAccessContext, patientId: string, outcome: 'success' | 'denied',
    details: Record<string, unknown>) {
    return { correlationId: context.correlationId, actorType: 'staff' as const, actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId,
      patientId, action: 'lab.work-item.progress.read', resourceType: 'lab-work-item-collection',
      resourceId: context.facilityId, outcome, purposeOfUse: context.purposeOfUse, details, sourceSystem: 'lab-api' };
  }
}

/**
 * The check, or the budget, whichever ends first: once the signal aborts,
 * this rejects with its reason. The Identity client stops its own time limit
 * and the abort once Identity's answer headers arrive, and reads the body
 * after them with neither, so one stalled answer would otherwise hold its
 * worker, and with it the whole call, past ehr-api's timeout. The check left
 * behind ends on its own (IdentityService still writes its
 * identity.authorization.check row then); nothing waits for it, and its
 * answer is not read.
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

function project(id: string, row: ProgressRow | undefined): LabProgressItem {
  if (!row) return { sourceEhrOrderId: id, status: 'not_received', receivedAt: null, collectedAt: null,
    lastResultAt: null };
  const tests = Number(row.test_count);
  const released = Number(row.released_count);
  const status: LabProgressStatus = tests > 0 && released >= tests ? 'results_ready'
    : released > 0 ? 'some_results_ready' : row.collected_at ? 'sample_collected' : 'received';
  return { sourceEhrOrderId: id, status, receivedAt: iso(row.accepted_at), collectedAt: iso(row.collected_at),
    lastResultAt: released > 0 ? iso(row.released_at) : null };
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
