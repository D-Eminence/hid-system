import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
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
 * "No record" and a refusal (QoreID's 4xx, its "not found") are charged too,
 * so they are reused for 24 hours: long enough that a person typing the same
 * NIN again and again pays once, short enough that a NIN the registry adds or
 * corrects (a new NIN slip) can be checked again the next day. A wrong NIN is
 * another NIN and is checked on its own.
 */
export const NIN_NO_RECORD_ANSWER_SECONDS = 24 * 60 * 60;
/**
 * After a timeout, or an answer HID could not read, QoreID may still have
 * charged for the check. For this long a new check of the NIN gets a plain
 * "still checking" message instead of being paid again; after it, the next
 * check asks QoreID.
 */
export const NIN_CHECK_HOLD_SECONDS = 5 * 60;

/** Where a check comes from, for the audit (never the NIN). */
export type NinCheckPath = 'enrollment' | 'profile' | 'desk' | 'other';

/** What QoreID said about a NIN, as HID keeps it (encrypted) and reuses it. */
export type NinCheckAnswer =
  | { outcome: 'record'; providerReference: string; record: QoreIdNinRecord }
  | { outcome: 'no_record'; state: 'not_verified' | 'incomplete'; providerReference?: string }
  | { outcome: 'rejected' };

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
  /** Asks QoreID once: the answer to keep, and what the path makes of it now. */
  ask: () => Promise<{ answer: NinCheckAnswer; value: Value }>;
}

export type NinCheckResult<Value> =
  | { source: 'qoreid'; answer: NinCheckAnswer; value: Value }
  | { source: 'stored'; answer: NinCheckAnswer };

interface BeginRow { decision: 'stored' | 'call' | 'wait' | 'held'; outcome: string | null;
  record_complete: boolean | null; answer_ciphertext: Buffer | null; until: Date | null }

/** Failures that may have reached QoreID and been charged without an answer HID can use. */
const HOLD_CODES = new Set(['QOREID_TIMEOUT', 'QOREID_PROVIDER_RESPONSE_INVALID']);

export function ninCheckInProgress(): DomainProblem {
  return new DomainProblem(409, 'NIN_CHECK_IN_PROGRESS',
    'We are still checking this NIN. Please wait a few minutes, then try again.');
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
 *     whose patient's login was deleted. Network failures, QoreID outages and
 *     its rate limit are not kept.
 * (c) A timeout holds the NIN for NIN_CHECK_HOLD_SECONDS: a quick resubmit gets
 *     a plain "still checking" message instead of paying again.
 * (d) Every attempt writes one audit row saying whether QoreID was called or a
 *     stored answer reused (never the NIN or its HMAC).
 * The existing per-IP limit, Turnstile and the 0049 per-session quota stay as
 * they are, in front of this; nothing here limits staff, facilities or volume.
 */
@Injectable()
export class NinCheckOnce {
  private readonly logger = new Logger(NinCheckOnce.name);

  constructor(private readonly database: DatabaseService,
    private readonly ninProtector: NinIdentifierProtector,
    private readonly audit: AuditService) {}

  async check<Value>(request: NinCheckRequest<Value>): Promise<NinCheckResult<Value>> {
    const environment = getEnvironment();
    // Both NIN keys before anything: an answer QoreID charged for must be keepable.
    this.encryptionKey();
    const lookup = this.ninProtector.lookup(request.nin);
    const question = request.question === undefined ? null : this.questionHmac(lookup, request.question);
    const attempt = randomUUID();
    const timeoutMs = environment.QOREID_TIMEOUT_MS;
    // Long enough for a token, the check and the one replay after a 401.
    const leaseSeconds = Math.min(300, Math.ceil((4 * timeoutMs) / 1000) + 5);
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
        throw ninCheckInProgress();
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
      return this.call(request, lookup, question, attempt, startedAt);
    }
  }

  /** Erases expired rows and the answers for NINs whose patient's login was deleted (the sweeper's). */
  async prune(correlationId: string, limit: number): Promise<number> {
    const result = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<{ removed: number }>('select identity.prune_qoreid_nin_checks($1) as removed', [limit]));
    return Number(result.rows[0]?.removed ?? 0);
  }

  private async call<Value>(request: NinCheckRequest<Value>, lookup: string, question: string | null,
    attempt: string, startedAt: number): Promise<NinCheckResult<Value>> {
    let asked: { answer: NinCheckAnswer; value: Value };
    try {
      asked = await request.ask();
    } catch (error) {
      const code = error instanceof DomainProblem ? error.code : undefined;
      if (code === 'QOREID_PROVIDER_REJECTED') {
        // QoreID refused this NIN (its 4xx, "not found"): charged, and the
        // same NIN would be refused again. Kept as the same refusal.
        await this.finishAnswer(request, lookup, question, attempt, { outcome: 'rejected' });
        await this.record(request, 'qoreid', 'rejected', Date.now() - startedAt);
        throw error;
      }
      const hold = code !== undefined && HOLD_CODES.has(code);
      await this.finish(request.correlationId, lookup, attempt, hold ? 'held' : 'released', null, null, null, null,
        hold ? NIN_CHECK_HOLD_SECONDS : null);
      await this.record(request, 'qoreid', code === 'QOREID_TIMEOUT' ? 'timeout'
        : code === 'QOREID_PROVIDER_RESPONSE_INVALID' ? 'unreadable' : 'not_answered', Date.now() - startedAt);
      throw error;
    }
    await this.finishAnswer(request, lookup, question, attempt, asked.answer);
    await this.record(request, 'qoreid', asked.answer.outcome, Date.now() - startedAt);
    return { source: 'qoreid', answer: asked.answer, value: asked.value };
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
    attempt: string, answer: NinCheckAnswer): Promise<void> {
    // QoreID's "incomplete" (its check not finished) may change soon: kept for
    // the hold only, so a quick resubmit is not paid again.
    const seconds = answer.outcome === 'record' ? NIN_RECORD_ANSWER_SECONDS
      : answer.outcome === 'no_record' && answer.state === 'incomplete' ? NIN_CHECK_HOLD_SECONDS
        : NIN_NO_RECORD_ANSWER_SECONDS;
    await this.finish(request.correlationId, lookup, attempt, answer.outcome, question,
      answer.outcome === 'record' ? answer.record.complete : null, this.encryptAnswer(lookup, answer),
      getEnvironment().NIN_KEY_VERSION, seconds);
  }

  /**
   * Records the attempt's outcome while it holds the lease. A failure here is
   * logged and swallowed: QoreID has answered (and charged), so the caller
   * gets the answer; the lease then ends on its own.
   */
  private async finish(correlationId: string, lookup: string, attempt: string, result: string,
    question: string | null, complete: boolean | null, ciphertext: Buffer | null, keyVersion: string | null,
    seconds: number | null): Promise<void> {
    try {
      await this.database.withSystemTransaction(correlationId, (client) => client.query(
        'select identity.finish_qoreid_nin_check($1,$2,$3,$4,$5,$6,$7,$8) as recorded',
        [lookup, attempt, result, question, complete, ciphertext, keyVersion, seconds]));
    } catch (error) {
      this.logger.error({ event: 'nin-check.finish.failed', correlationId, code: this.databaseCode(error) });
    }
  }

  /** One audit row per attempt: QoreID called or a stored answer reused. No NIN, no HMAC. */
  private async record<Value>(request: NinCheckRequest<Value>, source: 'qoreid' | 'stored' | 'none',
    result: string, waitedMs: number): Promise<void> {
    await this.audit.record({
      correlationId: request.correlationId,
      actorType: 'system',
      action: 'identity.qoreid.nin-check',
      resourceType: 'qoreid-nin-check',
      outcome: source === 'none' ? 'denied' : 'success',
      details: { path: request.path, qoreidCalled: source === 'qoreid', source, result, waitedMs },
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
