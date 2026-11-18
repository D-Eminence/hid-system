import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { markQoreIdDelivery, qoreIdDelivery } from './qoreid-delivery';
import type { QoreIdNinBinding, QoreIdNinEnrollmentBinding, QoreIdNinRecord } from './qoreid-verification.types';

/**
 * Q109 (owner, 18 November 2026): QoreID charges every NIN check, answered or
 * not, so the same NIN is never sent to QoreID twice while HID has, or is
 * getting, its answer. No limit on staff, facilities or Health ID is added.
 *
 * A QoreID answer is reused for 30 days when QoreID returned the NIN's
 * record: a record does not change from one day to the next, and a person who
 * starts again after the 24-hour enrollment ends, adds the NIN on the profile
 * after a sign-up, or is checked at a desk, is the same NIN.
 */
export const NIN_RECORD_ANSWER_SECONDS = 30 * 24 * 60 * 60;
/**
 * "No record", QoreID's "not found" (404) and an answer HID could not use are
 * charged too, so they are reused for 24 hours: long enough that a person
 * typing the same NIN again and again pays once, short enough that a NIN the
 * registry adds or corrects (a new NIN slip) can be checked again the next
 * day. A wrong NIN is another NIN and is checked on its own. A record a
 * profile check did not match (someone else's NIN typed on a profile) is kept
 * no longer than this either: as long as a NIN-only sign-up keeps the record
 * of whatever NIN was typed.
 */
export const NIN_NO_RECORD_ANSWER_SECONDS = 24 * 60 * 60;
/**
 * The request was sent but QoreID's answer was an error that may have been
 * charged (a 5xx, a 4xx other than "not found", the connection lost after the
 * request was written): for this long a new check of the NIN is refused with
 * a plain message saying when to try again, instead of being paid again.
 */
export const NIN_CHECK_HOLD_SECONDS = 5 * 60;
/**
 * QoreID was asked and no answer ever came: it did not answer within
 * QOREID_NIN_ANSWER_CEILING_MS, or the attempt holding the check stopped (the
 * task was stopped, or its answer could not be recorded) and its lease ended.
 * QoreID has probably charged, and the same NIN is likely to be as slow again,
 * so the NIN is held this long. 0137's begin_qoreid_nin_check applies the same
 * hold to an ended lease.
 */
export const NIN_CHECK_NO_ANSWER_HOLD_SECONDS = 6 * 60 * 60;
/** The pauses between the attempts to record a check's outcome. */
const FINISH_RETRY_PAUSES_MS = [200, 1_000, 3_000];

/** Where a check comes from, for the audit (never the NIN). */
export type NinCheckPath = 'enrollment' | 'profile' | 'desk' | 'other';

/** What QoreID said about a NIN, as HID keeps it (encrypted) and reuses it. */
export type NinCheckAnswer =
  | { outcome: 'record'; providerReference: string; record: QoreIdNinRecord }
  | { outcome: 'no_record'; state: 'not_verified' | 'incomplete'; providerReference?: string }
  | { outcome: 'rejected' }
  /**
   * QoreID answered in full but HID cannot use the answer (a record without
   * a gender or with a photo it cannot read, a verified answer without a
   * usable transaction id): the same NIN gets the same answer again. The name
   * and date of birth on it, when they could be read, so a profile check can
   * still compare them.
   */
  | { outcome: 'unusable'; record?: Extract<QoreIdNinRecord, { complete: false }>; providerReference?: string };

export interface NinCheckAskOptions {
  /** How long the check request may take: QOREID_NIN_ANSWER_CEILING_MS, not the caller's wait. */
  timeoutMs: number;
}

export interface NinCheckRequest<Value> {
  nin: string;
  correlationId: string;
  path: NinCheckPath;
  /**
   * What else the check sends besides the NIN (a profile check's name and
   * date of birth), when QoreID's "no record" may depend on it. Absent: the
   * NIN alone, whose "no record" answers every question.
   */
  question?: string;
  /** True when only a complete record (gender and the rest) will do. */
  needsCompleteRecord: boolean;
  /**
   * Asks QoreID once: the answer to keep, what the path makes of it now and,
   * when the answer is to be kept for less than its outcome's usual time,
   * for how long. It must pass `options.timeoutMs` to the adapter.
   */
  ask: (options: NinCheckAskOptions) => Promise<{ answer: NinCheckAnswer; value: Value; keepSeconds?: number }>;
}

export type NinCheckResult<Value> =
  | { source: 'qoreid'; answer: NinCheckAnswer; value: Value }
  | { source: 'stored'; answer: NinCheckAnswer };

interface BeginRow { decision: 'stored' | 'call' | 'wait' | 'held'; outcome: string | null;
  record_complete: boolean | null; answer_ciphertext: Buffer | null; until: Date | null }

type Settled<Value> = { ok: true; asked: { answer: NinCheckAnswer; value: Value } } | { ok: false; error: unknown };

/** A check is running for this NIN (another request's, or this request's own after its wait ended). */
export function ninCheckInProgress(): DomainProblem {
  return new DomainProblem(409, 'NIN_CHECK_IN_PROGRESS',
    'We are still checking this NIN. Please wait a minute, then try again.', undefined,
    { extensions: { retryAfterSeconds: 60 } });
}

/**
 * The NIN is held after a check that QoreID may have charged without an
 * answer HID could keep. The message says when to try again, from the hold's
 * own end, so the two always agree.
 */
export function ninCheckHeld(until: Date | null): DomainProblem {
  const seconds = Math.max(60, Math.ceil(((until?.getTime() ?? Date.now()) - Date.now()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  const when = minutes <= 90 ? `${minutes} minute${minutes === 1 ? '' : 's'}`
    : `${Math.ceil(minutes / 60)} hours`;
  return new DomainProblem(409, 'NIN_CHECK_HELD',
    `We could not finish checking this NIN. Please try again in ${when}.`, undefined,
    { extensions: { retryAfterSeconds: seconds } });
}

/**
 * The caller's wait ended while QoreID was still answering. The check keeps
 * going (QoreID charges it either way) and its answer is kept for the retry.
 */
export function ninCheckStillRunning(): DomainProblem {
  return new DomainProblem(504, 'QOREID_TIMEOUT',
    'The NIN check is taking longer than usual. Please wait a minute, then try again.', undefined,
    { extensions: { retryAfterSeconds: 60 } });
}

export function ninCheckUnavailable(): DomainProblem {
  return new DomainProblem(503, 'NIN_CHECK_UNAVAILABLE',
    'NIN checks are not available right now. Please try again in a minute.');
}

/** The error a stored refusal stands for: the same one QoreID's refusal gave. */
export function qoreIdRejected(): DomainProblem {
  return new DomainProblem(502, 'QOREID_PROVIDER_REJECTED', 'External verification could not be completed');
}

/**
 * The error an answer HID cannot use stands for, fresh or stored. Thrown from
 * an `ask`, it is marked as answered, so the answer is kept as 'unusable'.
 */
export function unusableAnswer(): DomainProblem {
  return markQoreIdDelivery(new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
    'External verification returned an invalid response'), { delivery: 'answered' });
}

/**
 * Check a NIN once: every path that sends a patient NIN to QoreID (sign-up
 * with a NIN, the NIN added on the profile, and the registration desk through
 * PUBLIC_PATIENT_IDENTITY_PROVIDER) goes through check().
 *
 * (a) One attempt per NIN holds the check (identity.qoreid_nin_checks, 0137,
 *     keyed by the NIN lookup HMAC); another attempt for the same NIN waits
 *     for its answer instead of calling QoreID. The hold is a committed row
 *     with a lease, so no database connection or lock is kept while QoreID
 *     answers, and one row per NIN means no lock order to deadlock on.
 * (b) The answer is kept, encrypted under NIN_ENCRYPTION_KEY like an
 *     enrollment's profile, and reused by every path until it expires; the
 *     patient lifecycle sweeper erases expired rows, and the answers for a NIN
 *     whose patient's login was just deleted. QoreID's own refusals that
 *     check nothing (401, 429) and failures that sent nothing are not kept.
 * (c) A check is never abandoned once sent: when the caller's wait
 *     (QOREID_TIMEOUT_MS) ends first, the caller is told to try again in a
 *     minute while the check goes on reading QoreID's answer for up to
 *     QOREID_NIN_ANSWER_CEILING_MS and keeps it for that retry. With no answer
 *     by then, the NIN is held for NIN_CHECK_NO_ANSWER_HOLD_SECONDS. A sent
 *     check that failed in a way QoreID may have charged holds the NIN for
 *     NIN_CHECK_HOLD_SECONDS.
 * (d) Every attempt writes one audit row saying whether QoreID was called or a
 *     stored answer reused (never the NIN or its HMAC), and a check that
 *     answers after its caller stopped waiting writes one more ('late').
 * The existing per-IP limit, Turnstile and the 0049 per-session quota stay as
 * they are, in front of this; nothing here limits staff, facilities or volume.
 */
@Injectable()
export class NinCheckOnce implements BeforeApplicationShutdown {
  private readonly logger = new Logger(NinCheckOnce.name);
  /** Checks still reading QoreID's answer, so shutdown can let them finish. */
  private readonly running = new AfterResponseTasks(this.logger, 'A NIN check could not be completed');

  constructor(private readonly database: DatabaseService,
    private readonly ninProtector: NinIdentifierProtector,
    private readonly audit: AuditService) {}

  beforeApplicationShutdown(): Promise<void> {
    return this.running.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS);
  }

  /** Resolves once every check still reading an answer has recorded it (tests, shutdown). */
  settle(timeoutMs?: number): Promise<void> {
    return this.running.settle(timeoutMs);
  }

  async check<Value>(request: NinCheckRequest<Value>): Promise<NinCheckResult<Value>> {
    const environment = getEnvironment();
    // Both NIN keys before anything: an answer QoreID charged for must be keepable.
    this.encryptionKey();
    const lookup = this.ninProtector.lookup(request.nin);
    const question = request.question === undefined ? null : this.questionHmac(lookup, request.question);
    const attempt = randomUUID();
    const timeoutMs = environment.QOREID_TIMEOUT_MS;
    const ceilingMs = Math.max(timeoutMs, environment.QOREID_NIN_ANSWER_CEILING_MS);
    // Long enough for a token and the check, twice (the one replay after a
    // 401), the check reading for its full ceiling: at most 290 s.
    const leaseSeconds = Math.min(300, Math.ceil((2 * timeoutMs + 2 * ceilingMs) / 1000) + 10);
    const waitUntil = Date.now() + timeoutMs + 3_000;
    const startedAt = Date.now();
    let pause = 50;
    for (;;) {
      const begun = await this.begin(request, lookup, question, attempt, leaseSeconds);
      if (begun.decision === 'stored') {
        const answer = this.decryptAnswer(lookup, begun);
        await this.record(request, 'stored', answer.outcome, Date.now() - startedAt);
        return { source: 'stored', answer };
      }
      if (begun.decision === 'held') {
        await this.record(request, 'none', 'held', Date.now() - startedAt);
        throw ninCheckHeld(begun.until);
      }
      if (begun.decision === 'wait') {
        if (Date.now() >= waitUntil) {
          await this.record(request, 'none', 'in_progress', Date.now() - startedAt);
          throw ninCheckInProgress();
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(pause, Math.max(1, waitUntil - Date.now()))));
        pause = Math.min(pause * 2, 500);
        continue;
      }
      return this.call(request, lookup, question, attempt, startedAt, timeoutMs, ceilingMs);
    }
  }

  /**
   * The sweeper's: erases rows past their end, and the answers for NINs whose
   * patient's login deletion completed in the last day (0096), each bounded
   * by `limit`.
   */
  async prune(correlationId: string, limit: number): Promise<number> {
    const result = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<{ removed: number }>('select identity.prune_qoreid_nin_checks($1) as removed', [limit]));
    return Number(result.rows[0]?.removed ?? 0);
  }

  /**
   * Asks QoreID and waits for it at most QOREID_TIMEOUT_MS. The check itself
   * goes on (up to its ceiling) whatever the caller's wait: its outcome is
   * recorded when it arrives, and a retry finds it.
   */
  private async call<Value>(request: NinCheckRequest<Value>, lookup: string, question: string | null,
    attempt: string, startedAt: number, timeoutMs: number, ceilingMs: number): Promise<NinCheckResult<Value>> {
    const state = { late: false };
    let asking: Promise<{ answer: NinCheckAnswer; value: Value; keepSeconds?: number }>;
    try {
      asking = request.ask({ timeoutMs: ceilingMs });
    } catch (error) {
      asking = Promise.reject(error);
    }
    const settled: Promise<Settled<Value>> = asking.then(
      async (asked) => {
        await this.finishAnswer(request, lookup, question, attempt, asked.answer, asked.keepSeconds);
        await this.record(request, state.late ? 'late' : 'qoreid', asked.answer.outcome, Date.now() - startedAt);
        return { ok: true as const, asked };
      },
      async (error: unknown) => {
        const result = await this.finishFailure(request, lookup, question, attempt, error);
        await this.record(request, state.late ? 'late' : 'qoreid', result, Date.now() - startedAt);
        return { ok: false as const, error };
      });
    this.running.run(request.correlationId, async () => { await settled; });
    // The caller waits for QoreID's answer (not for recording it) at most
    // timeoutMs. `late` is set by the timer itself, so an answer that wins the
    // race is never audited as late.
    let timer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([
      asking.then(() => 'answered' as const, () => 'answered' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => { state.late = true; resolve('timeout'); }, timeoutMs);
      })]);
    clearTimeout(timer);
    if (waited === 'timeout') {
      await this.record(request, 'qoreid', 'timeout', Date.now() - startedAt);
      throw ninCheckStillRunning();
    }
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;
    return { source: 'qoreid', answer: outcome.asked.answer, value: outcome.asked.value };
  }

  /**
   * What a failed check leaves, from how far it got (qoreid-delivery.ts):
   * nothing sent, nothing kept; QoreID's "not found" (404) and an answer HID
   * cannot use, kept like an answer; no answer by the ceiling, the long hold;
   * anything else that was (or may have been) sent, the short hold.
   */
  private async finishFailure<Value>(request: NinCheckRequest<Value>, lookup: string, question: string | null,
    attempt: string, error: unknown): Promise<string> {
    const facts = qoreIdDelivery(error);
    const code = error instanceof DomainProblem ? error.code : undefined;
    if (facts?.delivery === 'not_sent') {
      await this.finish(request.correlationId, lookup, attempt, 'released', null, null, null, null, null);
      return 'not_sent';
    }
    if (facts?.delivery === 'answered' && code === 'QOREID_PROVIDER_REJECTED' && facts.status === 404) {
      await this.finishAnswer(request, lookup, question, attempt, { outcome: 'rejected' });
      return 'rejected';
    }
    if (facts?.delivery === 'answered' && code === 'QOREID_PROVIDER_RESPONSE_INVALID') {
      await this.finishAnswer(request, lookup, question, attempt, { outcome: 'unusable',
        ...(facts.record ? { record: facts.record } : {}),
        ...(facts.providerReference ? { providerReference: facts.providerReference } : {}) });
      return 'unusable';
    }
    if (code === 'QOREID_TIMEOUT') {
      await this.finish(request.correlationId, lookup, attempt, 'held', null, null, null, null,
        NIN_CHECK_NO_ANSWER_HOLD_SECONDS);
      return 'no_answer';
    }
    await this.finish(request.correlationId, lookup, attempt, 'held', null, null, null, null, NIN_CHECK_HOLD_SECONDS);
    return 'not_answered';
  }

  private async begin<Value>(request: NinCheckRequest<Value>, lookup: string, question: string | null,
    attempt: string, leaseSeconds: number): Promise<BeginRow> {
    try {
      const result = await this.database.withSystemTransaction(request.correlationId, (client) =>
        client.query<BeginRow>(
          'select * from identity.begin_qoreid_nin_check($1,$2,$3,$4,$5,$6)',
          [lookup, question, request.needsCompleteRecord, getEnvironment().NIN_KEY_VERSION, attempt, leaseSeconds]));
      const row = result.rows[0];
      if (!row || !['stored', 'call', 'wait', 'held'].includes(row.decision)) throw new Error('unexpected decision');
      return row;
    } catch (error) {
      // Nothing was sent to QoreID. No SQL text or identifier is logged.
      this.logger.error({ event: 'nin-check.begin.failed', path: request.path, correlationId: request.correlationId,
        code: this.databaseCode(error) });
      throw ninCheckUnavailable();
    }
  }

  private async finishAnswer<Value>(request: NinCheckRequest<Value>, lookup: string, question: string | null,
    attempt: string, answer: NinCheckAnswer, keepSeconds?: number): Promise<void> {
    // QoreID's "incomplete" (its check not finished) may change soon: kept for
    // the short hold only, so a quick resubmit is not paid again.
    const usual = answer.outcome === 'record' ? NIN_RECORD_ANSWER_SECONDS
      : answer.outcome === 'no_record' && answer.state === 'incomplete' ? NIN_CHECK_HOLD_SECONDS
        : NIN_NO_RECORD_ANSWER_SECONDS;
    const seconds = keepSeconds === undefined ? usual : Math.max(60, Math.min(usual, keepSeconds));
    await this.finish(request.correlationId, lookup, attempt, answer.outcome, question,
      answer.outcome === 'record' ? answer.record.complete : null, this.encryptAnswer(lookup, answer),
      getEnvironment().NIN_KEY_VERSION, seconds);
  }

  /**
   * Records the attempt's outcome while it holds the lease, trying again
   * after a short pause when the database cannot take it (a busy pool): an
   * answer QoreID charged for is not lost to one failed write. If every try
   * fails the error is logged and swallowed (the caller still gets its
   * answer); the lease then ends, and 0137 holds the NIN as unanswered
   * instead of letting it be checked again at once.
   */
  private async finish(correlationId: string, lookup: string, attempt: string, result: string,
    question: string | null, complete: boolean | null, ciphertext: Buffer | null, keyVersion: string | null,
    seconds: number | null): Promise<void> {
    for (let attemptNumber = 0; ; attemptNumber += 1) {
      try {
        await this.database.withSystemTransaction(correlationId, (client) => client.query(
          'select identity.finish_qoreid_nin_check($1,$2,$3,$4,$5,$6,$7,$8) as recorded',
          [lookup, attempt, result, question, complete, ciphertext, keyVersion, seconds]));
        return;
      } catch (error) {
        const pause = FINISH_RETRY_PAUSES_MS[attemptNumber];
        if (pause === undefined) {
          this.logger.error({ event: 'nin-check.finish.failed', correlationId, code: this.databaseCode(error),
            attempts: attemptNumber + 1 });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
  }

  /**
   * One audit row per attempt: QoreID called (qoreidCalled false when the
   * failure sent nothing), a stored answer reused, or refused; plus one 'late'
   * row when a check answers after its caller stopped waiting. No NIN, no HMAC.
   */
  private async record<Value>(request: NinCheckRequest<Value>, source: 'qoreid' | 'stored' | 'none' | 'late',
    result: string, waitedMs: number): Promise<void> {
    await this.audit.record({
      correlationId: request.correlationId,
      actorType: 'system',
      action: 'identity.qoreid.nin-check',
      resourceType: 'qoreid-nin-check',
      outcome: source === 'none' ? 'denied' : 'success',
      details: { path: request.path, qoreidCalled: source === 'qoreid' && result !== 'not_sent', source, result,
        waitedMs },
      provenance: 'system',
      sourceSystem: 'identity-api',
    });
  }

  private questionHmac(lookup: string, question: string): string {
    const key = getEnvironment().NIN_LOOKUP_HMAC_KEY_B64;
    if (!key) throw new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE', 'NIN protection keys are unavailable');
    return createHmac('sha256', Buffer.from(key, 'base64'))
      .update(`qoreid-nin-question\u001f${lookup}\u001f${question}`, 'utf8').digest('hex');
  }

  /** As an enrollment's profile: AES-256-GCM, version byte 1, 12-byte nonce, tag last. */
  private encryptAnswer(lookup: string, answer: NinCheckAnswer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), nonce);
    cipher.setAAD(Buffer.from(`identity:qoreid-nin-check:${lookup}:answer`));
    return Buffer.concat([Buffer.from([1]), nonce, cipher.update(JSON.stringify(answer), 'utf8'), cipher.final(),
      cipher.getAuthTag()]);
  }

  private decryptAnswer(lookup: string, row: BeginRow): NinCheckAnswer {
    const value = row.answer_ciphertext;
    try {
      if (!Buffer.isBuffer(value) || value.length < 30 || value[0] !== 1) throw new Error('malformed');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), value.subarray(1, 13));
      decipher.setAAD(Buffer.from(`identity:qoreid-nin-check:${lookup}:answer`));
      decipher.setAuthTag(value.subarray(value.length - 16));
      const answer = JSON.parse(Buffer.concat([decipher.update(value.subarray(13, value.length - 16)),
        decipher.final()]).toString('utf8')) as NinCheckAnswer;
      if (answer.outcome !== row.outcome) throw new Error('outcome mismatch');
      return answer;
    } catch {
      throw ninCheckUnavailable();
    }
  }

  private encryptionKey(): Buffer {
    const key = getEnvironment().NIN_ENCRYPTION_KEY_B64;
    const buffer = key ? Buffer.from(key, 'base64') : Buffer.alloc(0);
    if (buffer.length !== 32) {
      throw new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE', 'NIN protection keys are unavailable');
    }
    return buffer;
  }

  private databaseCode(error: unknown): string {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code : 'unknown';
  }
}

/** The record as a binding, or undefined when it lacks what the NIN-only paths need. */
export function completeRecord(record: QoreIdNinRecord): QoreIdNinEnrollmentBinding | undefined {
  return record.complete ? record.binding : undefined;
}

/** The name and date of birth on the record, as every path compares them. */
export function recordNames(record: QoreIdNinRecord): QoreIdNinBinding {
  const { nin, firstName, lastName, dateOfBirth } = record.binding;
  return { nin, firstName, lastName, dateOfBirth };
}
