import { randomUUID } from 'node:crypto';
import { captureServerError } from '@hid/server-telemetry';
import type { OcrWorkerConfig } from './config';
import { listVersionSchema, paperReadingPayloadSchema, READING_COUNTS_VERSION, readingCountsSchema,
  type ReadingCounts } from './reading/contract';
import { LIST_VERSION, LIST_VERSION_ERROR } from './reading/list-version';
import { HARD_PAGE_PROMPT_VERSION, HARD_PAGE_PROMPT_VERSION_NO_ZOOM, IMAGE_PROMPT_VERSION } from './reading/prompt';
import { PaperReadingService, ReadingInterruptedError, ReadingUnavailableError, type HardReadUsage, type PassUsageRecord,
  type ReadingOutcome } from './reading/reader';
import type { SourceDeletionSweeper } from './source-deletion';
import { DocumentTooManyPagesFailure, SafeWorkerFailure, type AiUsageRecord, type ClaimedOcrJob, type CompletedExtraction,
  type DocumentReader, type TextReading, type VerifiedDocument, type WorkerOcrProvider, type WorkerRepository } from './types';

const MAX_RECORDED_PAGES = 200;

export class OcrWorker {
  private readonly shutdown = new AbortController();
  private acceptingClaims = false;
  constructor(private readonly config: OcrWorkerConfig, private readonly repository: WorkerRepository,
    private readonly reader: DocumentReader, private readonly provider: WorkerOcrProvider,
    private readonly reading: PaperReadingService, private readonly sourceDeletion?: SourceDeletionSweeper) {}

  async run(): Promise<void> {
    await this.repository.checkReadiness();
    await this.provider.checkReadiness(this.shutdown.signal);
    this.acceptingClaims = true;
    this.log('info', 'ocr.worker.ready', { provider: this.provider.name,
      acceptingClaims: true, concurrency: this.config.OCR_WORKER_CONCURRENCY,
      maxInFlightPerFacility: this.config.OCR_WORKER_MAX_INFLIGHT_PER_FACILITY,
      aiMaxConcurrentRequests: this.config.OCR_AI_MAX_CONCURRENT_REQUESTS,
      aiImageReread: this.config.OCR_AI_IMAGE_REREAD, aiImageMaskedPages: this.config.OCR_AI_IMAGE_MASKED_PAGES,
      // The hard-page bounds in force (settings only), so a staging comparison of efforts can be read from the logs.
      aiHardPageReads: this.config.OCR_AI_HARD_PAGE_READS, aiHardPageEffort: this.config.OCR_AI_HARD_PAGE_EFFORT,
      aiHardPageFollowupEffort: this.config.OCR_AI_HARD_PAGE_FOLLOWUP_EFFORT,
      aiHardPageMaxTokens: this.config.OCR_AI_HARD_PAGE_MAX_TOKENS,
      aiHardPageDeadlineMs: this.config.OCR_AI_HARD_PAGE_DEADLINE_MS, aiZoomMaxCalls: this.config.OCR_AI_ZOOM_MAX_CALLS,
      aiLastResortSeconds: this.config.OCR_AI_LAST_RESORT_SECONDS,
      textractMaxConcurrent: this.config.OCR_TEXTRACT_MAX_CONCURRENT, remoteProviderCheck: false,
      sourceDeletion: this.sourceDeletionEnabled(),
      ...(this.sourceDeletionEnabled() ? { sourceDeletionIntervalSeconds: this.config.OCR_SOURCE_DELETION_INTERVAL_SECONDS } : {}) });
    await Promise.all([
      ...Array.from({ length: this.config.OCR_WORKER_CONCURRENCY }, (_, index) => this.claimLoop(index)),
      ...(this.sourceDeletionEnabled() ? [this.sourceDeletionLoop()] : []),
    ]);
    await this.repository.close();
    this.log('info', 'ocr.worker.stopped', { acceptingClaims: false });
  }

  stop(): void {
    if (this.shutdown.signal.aborted) return;
    this.acceptingClaims = false;
    this.log('info', 'ocr.worker.draining', { acceptingClaims: false });
    this.shutdown.abort(new Error('worker shutdown'));
  }

  status(): Readonly<{ acceptingClaims: boolean; provider: string }> {
    return { acceptingClaims: this.acceptingClaims, provider: this.provider.name };
  }

  async processOne(job: ClaimedOcrJob): Promise<void> {
    const renewal = this.startLeaseRenewal(job);
    const started = Date.now();
    try {
      const document = await this.reader.readExact(job, this.shutdown.signal);
      // The page allowance is checked before anything is charged. At 100% reading pauses until the
      // allowance resets; the job keeps its attempts, and review and manual entry are unaffected.
      // A retry whose pages are already counted is never paused (the database answers paused=false),
      // and a pause that finds the allowance no longer used up changes nothing: the job is read.
      const allowance = await this.repository.pageAllowance(job);
      if (allowance.paused) {
        const resumeAt = await this.repository.pauseForAllowance(job);
        if (resumeAt !== null) {
          this.log('info', 'ocr.job.paused_for_allowance', { jobId: job.jobId, correlationId: job.correlationId,
            resumeAt: resumeAt.toISOString() });
          return;
        }
        this.log('info', 'ocr.job.allowance_available', { jobId: job.jobId, correlationId: job.correlationId });
      }
      const text = await this.extractText(job, document);
      // Every read is counted, even with AI reading off; a document reads as at least one page.
      const after = await this.repository.recordPages(job, Math.max(1, text.pageCount));
      const outcome = await this.readItems(job, text, document);
      // Before completion, so the job is still held; a failure to record never fails the job.
      await this.recordAiUsage(job, outcome.summary.modelUsage, outcome.summary.pagesSent, outcome.summary.passUsage,
        outcome.summary.hardPageReadUsage);
      // The warn lines come before the contract check and completion, so they are written however the job ends.
      this.logReadFailures(job, outcome.summary);
      // Counts and listVersion for provenance: a failure omits the field and logs a code, never fails the job.
      const extras = readingProvenanceExtras(outcome.summary);
      for (const code of extras.omitted) {
        this.log('warn', 'ocr.reading.provenance_field_omitted', { jobId: job.jobId, correlationId: job.correlationId,
          code });
      }
      const completion = buildCompletion(text, outcome, extras);
      const checked = paperReadingPayloadSchema.safeParse(completion.structuredPayload);
      if (!checked.success) {
        this.log('error', 'ocr.reading.contract_violation', { jobId: job.jobId, correlationId: job.correlationId,
          issues: checked.error.issues.length });
        throw new SafeWorkerFailure('READING_CONTRACT_VIOLATION', 'OCR reading result was not in the expected shape', true, 60);
      }
      await this.repository.complete(job, completion);
      const summary = outcome.summary;
      // documentId: the opaque document UUID (never its name, key or content), so a job's lines can be found from the
      // document the owner names; README "Logs carry only ids, counts, codes ...".
      this.log('info', 'ocr.job.completed', { jobId: job.jobId, documentId: job.documentId,
        correlationId: job.correlationId, provider: this.provider.name, attempt: job.attemptNo, pagesProcessed: text.pageCount,
        retryCount: Math.max(0, job.attemptNo - 1), readingStatus: summary.status,
        firstPassModel: summary.firstPassModel, rereadModel: summary.rereadModel,
        listVersion: extras.listVersion ?? null, aiRequests: summary.requests,
        aiRefusals: summary.refusals, rereadPages: summary.rereadPages.length,
        imageRereadPages: summary.imageRereadPages.length, imageRereadSkippedPages: summary.imageRereadSkipped.length,
        imageRereadFailedPages: summary.imageRereadFailedPages.length,
        rereadFailedPages: summary.rereadFailedPages, itemCount: summary.itemCount,
        droppedUngrounded: summary.droppedUngrounded, droppedByReason: summary.droppedByReason,
        flaggedPages: summary.flaggedPages,
        // Hard pages' best-guess reads (two per page): codes and counts only.
        hardPages: summary.hardPages.length, hardPageReads: summary.hardPageReads,
        hardPageAgreement: { ...summary.hardPageAgreement },
        // Zoom in the hard-page reads: crops returned, calls refused at the limit, calls failed. Numbers only.
        zoomCalls: summary.zoomCalls, zoomLimited: summary.zoomLimited, zoomFailed: summary.zoomFailed,
        // Hard pages where OCR_AI_HARD_PAGE_DEADLINE_MS cut a read still running (a count only).
        hardPageDeadlineHits: summary.hardPageDeadlinePages.length,
        // Hard-page reads whose outputTokens is a lower bound (an attempt cut mid-answer): outputTokens below
        // under-counts by their unreported thinking (README "Hard-page time and cost bounds").
        hardPageReadsOutputIncomplete: summary.hardPageReadUsage.filter((read) => read.outputTokensIncomplete).length,
        // Hard-page reads with no answer, and reads sent the answer-only turn, by reason code (README "A hard read
        // always ends with an answer"); pages whose reading in some pass gave nothing; the first pass's items.
        hardReadFailures: countBy(summary.hardPageReadUsage.map((read) => read.failure)),
        hardReadForcedAnswers: countBy(summary.hardPageReadUsage.map((read) =>
          read.forcedAnswer === null ? null : `forced_answer_${read.forcedAnswer}`)),
        pageReadFailures: summary.pageReadFailures.length, firstPassItemCount: summary.firstPassItemCount,
        // The last resort (README "Last resort"): pages sent it, those whose answer was not usable, and those that
        // needed it but were not sent it (no time left, or no picture). Counts only.
        lastResortReads: summary.lastResortPages.length, lastResortFailed: summary.lastResortFailedPages.length,
        lastResortSkipped: summary.lastResortSkipped.length,
        inputTokens: summary.usage.inputTokens, outputTokens: summary.usage.outputTokens,
        cacheReadInputTokens: summary.usage.cacheReadInputTokens,
        cacheCreationInputTokens: summary.usage.cacheCreationInputTokens,
        allowancePagesUsed: after.pagesUsed, allowancePagesLimit: after.pagesLimit,
        durationMs: Date.now() - started });
    } catch (error) {
      const failure = this.toSafeFailure(error);
      if (failure.code === 'WORKER_INTERNAL_ERROR') captureServerError(error);
      try {
        await this.repository.fail(job, failure);
        this.log('warn', 'ocr.job.failed', { jobId: job.jobId, correlationId: job.correlationId,
          code: failure.code, retryable: failure.retryable, attempt: job.attemptNo,
          failedPages: 1, retryCount: Math.max(0, job.attemptNo - 1) });
      } catch (persistenceError) {
        this.log('error', 'ocr.job.failure_persistence_failed', { jobId: job.jobId,
          correlationId: job.correlationId, code: safeErrorCode(persistenceError) });
      }
    } finally { clearInterval(renewal); }
  }

  /** Text reading; a document over the page limit was still read (and charged), so its pages count. */
  private async extractText(job: ClaimedOcrJob, document: Parameters<WorkerOcrProvider['extract']>[0]): Promise<TextReading> {
    try {
      return await this.provider.extract(document, this.shutdown.signal);
    } catch (error) {
      if (error instanceof DocumentTooManyPagesFailure) {
        // ocr.record_worker_pages takes 1-200 pages; beyond that the count is capped, never skipped.
        await this.repository.recordPages(job, Math.min(MAX_RECORDED_PAGES, error.pageCount)).catch((recordError: unknown) => {
          this.log('error', 'ocr.allowance.record_failed', { jobId: job.jobId, correlationId: job.correlationId,
            code: safeErrorCode(recordError) });
        });
      }
      throw error;
    }
  }

  /** The AI step. A transient failure retries the job, except on its last attempt, which completes without items. */
  private async readItems(job: ClaimedOcrJob, text: TextReading, document: VerifiedDocument): Promise<ReadingOutcome> {
    // The verified bytes and their detected media type, for the image re-read of a flagged page (never logged).
    const input = { facilityId: job.facilityId, sourceSha256Hex: job.sourceSha256Hex, pages: text.pages,
      document: { mediaType: document.mediaType, bytes: document.bytes } };
    let outcome: ReadingOutcome;
    try {
      outcome = await this.reading.read(input, this.shutdown.signal);
    } catch (error) {
      if (error instanceof ReadingInterruptedError) {
        // A shutdown (or an unexpected error) mid-reading: the claim is still held, so what the pages already
        // asked used is recorded before the job is failed; the original error is then handled as before.
        await this.recordAiUsage(job, error.modelUsage);
        throw error.cause;
      }
      if (!(error instanceof ReadingUnavailableError)) throw error;
      this.log('warn', 'ocr.reading.unavailable', { jobId: job.jobId, correlationId: job.correlationId,
        code: error.code, attempt: job.attemptNo, maxAttempts: job.maxAttempts, finalAttempt: job.attemptNo >= job.maxAttempts });
      if (job.attemptNo < job.maxAttempts) {
        // What this attempt used is still counted (per attempt, so the retry adds its own).
        await this.recordAiUsage(job, error.modelUsage);
        throw new SafeWorkerFailure('AI_UNAVAILABLE', 'AI reading is temporarily unavailable', true, 60);
      }
      outcome = this.reading.withoutItems(input, 'ai_failed', error.usage, error.code, error.modelUsage);
    }
    if (outcome.summary.status === 'ai_failed' && outcome.summary.failureCode) {
      this.log('warn', 'ocr.reading.ai_failed', { jobId: job.jobId, correlationId: job.correlationId,
        code: outcome.summary.failureCode });
    }
    return outcome;
  }

  /**
   * One ocr.record_worker_ai_usage per model used; counts only. A failure is logged with a safe code. The
   * ocr.reading.usage log has one line per model and pass (first_pass, reread, image_reread, hard_page_read) when the reading
   * gives that split, and one per model otherwise (a reading stopped before it finished). Hard-page reads get one line
   * per read instead of one for their pass (`page`, `read` 1 or 2, time, turns, zoom counts, effort, endedBy), so the
   * lines still add up to the reading's use.
   */
  private async recordAiUsage(job: ClaimedOcrJob, usage: readonly AiUsageRecord[], pagesSent?: number,
    passUsage?: readonly PassUsageRecord[], hardReads: readonly HardReadUsage[] = []): Promise<void> {
    // Counts only, never text: lets the cost per page, and per pass, be seen in the logs.
    const logLines: ReadonlyArray<AiUsageRecord & { pass?: string; zoomCalls?: number }> = passUsage ?? usage;
    for (const entry of logLines) {
      if (entry.pass === 'hard_page_read' && hardReads.length > 0) {
        // In the pass's place: one line per read of that model instead (they add up to the pass line they replace).
        for (const read of hardReads.filter((candidate) => candidate.model === entry.model)) {
          this.log('info', 'ocr.reading.usage', { jobId: job.jobId, correlationId: job.correlationId,
            attempt: job.attemptNo, model: read.model, pass: 'hard_page_read', page: read.page, read: read.read,
            requests: read.requests, turns: read.turns, inputTokens: read.inputTokens, outputTokens: read.outputTokens,
            cacheReadTokens: read.cacheReadTokens, cacheWriteTokens: read.cacheWriteTokens, durationMs: read.durationMs,
            zoomCalls: read.zoomCalls, zoomLimited: read.zoomLimited, effort: read.effort,
            followupEffort: read.followupEffort, forcedEffort: read.forcedEffort, zoomClosed: read.zoomClosed,
            endedBy: read.endedBy,
            outputTokensIncomplete: read.outputTokensIncomplete, failure: read.failure,
            forcedAnswer: read.forcedAnswer === null ? null : `forced_answer_${read.forcedAnswer}`,
            ...(pagesSent === undefined ? {} : { pagesSent }) });
        }
        continue;
      }
      if (entry.requests <= 0) continue;
      this.log('info', 'ocr.reading.usage', { jobId: job.jobId, correlationId: job.correlationId,
        attempt: job.attemptNo, model: entry.model, ...(entry.pass === undefined ? {} : { pass: entry.pass }),
        requests: entry.requests, inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens, cacheReadTokens: entry.cacheReadTokens,
        cacheWriteTokens: entry.cacheWriteTokens, ...(pagesSent === undefined ? {} : { pagesSent }),
        // The hard-page reads' zoom crops (a count only; no crop is ever logged).
        ...(entry.pass === 'hard_page_read' ? { zoomCalls: entry.zoomCalls ?? 0 } : {}) });
    }
    for (const entry of usage) {
      if (entry.requests <= 0) continue;
      try {
        await this.repository.recordAiUsage(job, entry);
      } catch (error) {
        this.log('error', 'ocr.reading.usage_record_failed', { jobId: job.jobId, correlationId: job.correlationId,
          model: entry.model, code: safeErrorCode(error) });
      }
    }
  }

  /**
   * One warn line per hard-page read that gave no answer (ocr.reading.hard_read_failed), per read sent the
   * answer-only turn (ocr.reading.hard_read_forced_answer, whether that turn answered or not), and per page whose
   * reading in a pass gave nothing usable (ocr.reading.page_read_failed). Codes and counts only: never item text, page
   * content or the picture (README "A hard read always ends with an answer").
   */
  private logReadFailures(job: ClaimedOcrJob, summary: ReadingOutcome['summary']): void {
    for (const read of summary.hardPageReadUsage) {
      const counts = { page: read.page, read: read.read, turns: read.turns, requests: read.requests,
        outputTokens: read.outputTokens, outputTokensIncomplete: read.outputTokensIncomplete, zoomCalls: read.zoomCalls,
        zoomLimited: read.zoomLimited, durationMs: read.durationMs };
      if (read.forcedAnswer !== null) {
        this.log('warn', 'ocr.reading.hard_read_forced_answer', { jobId: job.jobId, correlationId: job.correlationId,
          attempt: job.attemptNo, reason: `forced_answer_${read.forcedAnswer}`, answered: read.failure === null,
          ...counts });
      }
      if (read.failure !== null) {
        this.log('warn', 'ocr.reading.hard_read_failed', { jobId: job.jobId, correlationId: job.correlationId,
          attempt: job.attemptNo, reason: read.failure, ...(read.errorCode === null ? {} : { code: read.errorCode }),
          forcedAnswer: read.forcedAnswer === null ? null : `forced_answer_${read.forcedAnswer}`, ...counts });
      }
    }
    for (const failure of summary.pageReadFailures) {
      this.log('warn', 'ocr.reading.page_read_failed', { jobId: job.jobId, correlationId: job.correlationId,
        attempt: job.attemptNo, page: failure.page, pass: failure.pass, reason: failure.reason,
        ...(failure.errorCode === undefined ? {} : { code: failure.errorCode }),
        ...(failure.detail === undefined ? {} : { detail: failure.detail }) });
    }
  }

  private async claimLoop(workerIndex: number): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.shutdown.signal.aborted) {
      try {
        const job = await this.repository.claim(this.provider.name, this.config.OCR_WORKER_LEASE_SECONDS,
          this.config.OCR_WORKER_MAX_INFLIGHT_PER_FACILITY, `ocr-worker-${randomUUID()}`);
        consecutiveErrors = 0;
        if (job) {
          const metrics = await this.repository.metrics().catch((error) => {
            this.log('warn', 'ocr.queue.metrics_unavailable', {
              correlationId: job.correlationId, code: safeErrorCode(error),
            });
            return undefined;
          });
          this.log('info', 'ocr.job.claimed', { jobId: job.jobId, documentId: job.documentId,
            correlationId: job.correlationId,
            provider: this.provider.name, attempt: job.attemptNo, claimedJobs: 1,
            ...(metrics ? { queueDepth: metrics.queueDepth,
              oldestQueueAgeSeconds: metrics.oldestQueueAgeSeconds } : {}) });
          await this.processOne(job);
        }
        else await delay(this.config.OCR_WORKER_POLL_MS, this.shutdown.signal);
      } catch (error) {
        if (this.shutdown.signal.aborted) break;
        consecutiveErrors += 1;
        captureServerError(error);
        this.log('error', 'ocr.worker.loop_error', { workerIndex, code: safeErrorCode(error),
          consecutiveErrors });
        const backoff = Math.min(30_000, this.config.OCR_WORKER_POLL_MS * (2 ** Math.min(consecutiveErrors, 5)));
        await delay(backoff + Math.floor(Math.random() * Math.min(backoff, 1_000)), this.shutdown.signal)
          .catch(() => undefined);
      }
    }
  }

  private sourceDeletionEnabled(): boolean {
    return this.sourceDeletion !== undefined && this.config.OCR_SOURCE_DELETION_ENABLED === true;
  }

  /** One deletion round at start, then one every OCR_SOURCE_DELETION_INTERVAL_SECONDS, until shutdown. */
  private async sourceDeletionLoop(): Promise<void> {
    const sweeper = this.sourceDeletion;
    if (!sweeper) return;
    while (!this.shutdown.signal.aborted) {
      try {
        await sweeper.runRound(this.shutdown.signal);
      } catch (error) {
        if (this.shutdown.signal.aborted) break;
        this.log('error', 'ocr.source_deletion.failed', { stage: 'round', code: safeErrorCode(error) });
      }
      await delay(this.config.OCR_SOURCE_DELETION_INTERVAL_SECONDS * 1_000, this.shutdown.signal).catch(() => undefined);
    }
  }

  private startLeaseRenewal(job: ClaimedOcrJob): ReturnType<typeof setInterval> {
    const intervalMs = Math.max(10_000, Math.floor(this.config.OCR_WORKER_LEASE_SECONDS * 1_000 / 3));
    return setInterval(() => {
      void this.repository.renew(job, this.config.OCR_WORKER_LEASE_SECONDS).catch((error) => {
        this.log('error', 'ocr.job.lease_renewal_failed', { jobId: job.jobId,
          correlationId: job.correlationId, code: safeErrorCode(error) });
      });
    }, intervalMs);
  }

  private toSafeFailure(error: unknown): SafeWorkerFailure {
    if (error instanceof SafeWorkerFailure) return error;
    if (this.shutdown.signal.aborted) {
      return new SafeWorkerFailure('WORKER_SHUTDOWN', 'OCR worker stopped before processing completed', true, 5);
    }
    return new SafeWorkerFailure('WORKER_INTERNAL_ERROR', 'OCR processing failed unexpectedly', true, 30);
  }

  private log(level: string, event: string, fields: Readonly<Record<string, unknown>>): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  }
}

/** Counts per code, codes in sorted order; nulls not counted. */
function countBy(codes: readonly (string | null)[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const code of codes) if (code !== null) counts.set(code, (counts.get(code) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SafeWorkerFailure) return error.code;
  const code = error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
    ? (error as Error & { code: string }).code : 'UNKNOWN';
  return /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : 'UNKNOWN';
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * What the worker adds to provenance.reading beside promptVersion (README "Provenance"): listVersion and the
 * counts that were once only logged. Each is validated against the contract (contract.ts readingCountsSchema,
 * listVersionSchema) and left out, with a code in `omitted`, if it cannot be computed or is not in that shape.
 */
export interface ReadingProvenanceExtras {
  listVersion?: string;
  counts?: ReadingCounts;
  omitted: string[];
}

export function readingProvenanceExtras(summary: ReadingOutcome['summary'],
  listVersion: string | null = LIST_VERSION): ReadingProvenanceExtras {
  const extras: ReadingProvenanceExtras = { omitted: [] };
  if (listVersion !== null && listVersionSchema.safeParse(listVersion).success) extras.listVersion = listVersion;
  else extras.omitted.push(LIST_VERSION_ERROR ?? 'LIST_VERSION_UNAVAILABLE');
  try {
    const agreement = summary.hardPageAgreement;
    const candidate = {
      version: READING_COUNTS_VERSION,
      droppedByReason: { ...summary.droppedByReason },
      droppedByReasonFirstPass: { ...summary.droppedByReasonFirstPass },
      hardPageAgreement: { fieldsCompared: agreement.fieldsCompared, fieldsAgreed: agreement.fieldsAgreed,
        itemsPaired: agreement.itemsPaired, itemsSingle: agreement.itemsSingle, drugSplits: agreement.drugSplits,
        alternativesDropped: agreement.alternativesDropped },
      zoomCalls: summary.zoomCalls,
      zoomLimited: summary.zoomLimited,
      zoomFailed: summary.zoomFailed,
      hardPageDeadlineHits: summary.hardPageDeadlinePages.length,
      hardReadFailures: countBy(summary.hardPageReadUsage.map((read) => read.failure)),
    };
    const checked = readingCountsSchema.safeParse(candidate);
    if (checked.success) extras.counts = checked.data;
    else extras.omitted.push('READING_COUNTS_INVALID');
  } catch {
    extras.omitted.push('READING_COUNTS_FAILED');
  }
  return extras;
}

/** raw_text is every line in reading order; provenance carries ids, counts, codes and models, never text. */
export function buildCompletion(text: TextReading, outcome: ReadingOutcome,
  extras: ReadingProvenanceExtras = readingProvenanceExtras(outcome.summary)): CompletedExtraction {
  const lines = text.pages.flatMap((page) => page.lines);
  const summary = outcome.summary;
  return {
    providerModel: text.providerModel,
    providerRequestReference: text.providerRequestReference,
    rawText: lines.map((line) => line.text).join('\n'),
    structuredPayload: outcome.payload,
    confidence: lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length,
    provenance: {
      ...text.provenance,
      pageCount: text.pageCount,
      lineCount: lines.length,
      reading: {
        contract: outcome.payload.contract,
        status: summary.status,
        firstPassModel: summary.firstPassModel,
        rereadModel: summary.rereadModel,
        promptVersion: outcome.payload.reading.promptVersion,
        // The reference lists' version (list-version.ts); left out when it could not be computed.
        ...(extras.listVersion === undefined ? {} : { listVersion: extras.listVersion }),
        schemaVersion: outcome.payload.reading.schemaVersion,
        inferenceGeo: summary.inferenceGeo,
        servedInferenceGeo: summary.servedInferenceGeo,
        requests: summary.requests,
        refusals: summary.refusals,
        pagesSent: summary.pagesSent,
        rereadPages: summary.rereadPages,
        rereadFailedPages: summary.rereadFailedPages,
        imageRereadPages: summary.imageRereadPages,
        imageRereadSkipped: summary.imageRereadSkipped,
        imageRereadFailedPages: summary.imageRereadFailedPages,
        // The image re-read prompt only where a page read from its picture was not a hard page, or was read by the
        // last resort (the ordinary image re-read request).
        imagePromptVersion: summary.imageRereadPages.some((page) => !summary.hardPages.includes(page)
          || (summary.lastResortPages.includes(page) && !summary.lastResortFailedPages.includes(page)))
          ? IMAGE_PROMPT_VERSION : null,
        hardPages: summary.hardPages,
        hardPageReads: summary.hardPageReads,
        hardPageSingleReadPages: summary.hardPageSingleReadPages,
        // Version 4 only where a hard page's reads were offered zoom; without it they sent the version 3 text.
        hardPagePromptVersion: summary.hardPages.length === 0 ? null
          : summary.hardPageZoomPages.length > 0 ? HARD_PAGE_PROMPT_VERSION : HARD_PAGE_PROMPT_VERSION_NO_ZOOM,
        hardPageZoomPages: summary.hardPageZoomPages,
        // Hard pages where the page's deadline cut a read (OCR_AI_HARD_PAGE_DEADLINE_MS); page numbers only.
        hardPageDeadlinePages: summary.hardPageDeadlinePages,
        // The last resort (README "Last resort"): page numbers and codes only. Its failures are also in
        // imageRereadFailedPages (a picture was sent and gave nothing usable).
        lastResortPages: summary.lastResortPages,
        lastResortFailedPages: summary.lastResortFailedPages,
        lastResortSkipped: summary.lastResortSkipped,
        droppedUngrounded: summary.droppedUngrounded,
        droppedUngroundedFirstPass: summary.droppedUngroundedFirstPass,
        itemCount: summary.itemCount,
        flaggedPages: summary.flaggedPages,
        maskedNumbers: summary.maskedNumbers,
        failureCode: summary.failureCode,
        usage: summary.usage,
        // Counts that were once only in the completion log (contract.ts readingCountsSchema); codes and counts only.
        ...(extras.counts === undefined ? {} : { counts: extras.counts }),
      },
    },
  };
}
