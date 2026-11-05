import { randomUUID } from 'node:crypto';
import type { OcrWorkerConfig } from './config';
import { paperReadingPayloadSchema } from './reading/contract';
import { IMAGE_PROMPT_VERSION } from './reading/prompt';
import { PaperReadingService, ReadingInterruptedError, ReadingUnavailableError, type ReadingOutcome } from './reading/reader';
import { DocumentTooManyPagesFailure, SafeWorkerFailure, type AiUsageRecord, type ClaimedOcrJob, type CompletedExtraction,
  type DocumentReader, type TextReading, type VerifiedDocument, type WorkerOcrProvider, type WorkerRepository } from './types';

const MAX_RECORDED_PAGES = 200;

export class OcrWorker {
  private readonly shutdown = new AbortController();
  private acceptingClaims = false;
  constructor(private readonly config: OcrWorkerConfig, private readonly repository: WorkerRepository,
    private readonly reader: DocumentReader, private readonly provider: WorkerOcrProvider,
    private readonly reading: PaperReadingService) {}

  async run(): Promise<void> {
    await this.repository.checkReadiness();
    await this.provider.checkReadiness(this.shutdown.signal);
    this.acceptingClaims = true;
    this.log('info', 'ocr.worker.ready', { provider: this.provider.name,
      acceptingClaims: true, concurrency: this.config.OCR_WORKER_CONCURRENCY,
      maxInFlightPerFacility: this.config.OCR_WORKER_MAX_INFLIGHT_PER_FACILITY,
      aiMaxConcurrentRequests: this.config.OCR_AI_MAX_CONCURRENT_REQUESTS,
      aiImageReread: this.config.OCR_AI_IMAGE_REREAD,
      textractMaxConcurrent: this.config.OCR_TEXTRACT_MAX_CONCURRENT, remoteProviderCheck: false });
    await Promise.all(Array.from({ length: this.config.OCR_WORKER_CONCURRENCY }, (_, index) => this.claimLoop(index)));
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
      await this.recordAiUsage(job, outcome.summary.modelUsage);
      const completion = buildCompletion(text, outcome);
      const checked = paperReadingPayloadSchema.safeParse(completion.structuredPayload);
      if (!checked.success) {
        this.log('error', 'ocr.reading.contract_violation', { jobId: job.jobId, correlationId: job.correlationId,
          issues: checked.error.issues.length });
        throw new SafeWorkerFailure('READING_CONTRACT_VIOLATION', 'OCR reading result was not in the expected shape', true, 60);
      }
      await this.repository.complete(job, completion);
      const summary = outcome.summary;
      this.log('info', 'ocr.job.completed', { jobId: job.jobId, correlationId: job.correlationId,
        provider: this.provider.name, attempt: job.attemptNo, pagesProcessed: text.pageCount,
        retryCount: Math.max(0, job.attemptNo - 1), readingStatus: summary.status,
        firstPassModel: summary.firstPassModel, rereadModel: summary.rereadModel, aiRequests: summary.requests,
        aiRefusals: summary.refusals, rereadPages: summary.rereadPages.length,
        imageRereadPages: summary.imageRereadPages.length, imageRereadSkippedPages: summary.imageRereadSkipped.length,
        rereadFailedPages: summary.rereadFailedPages, itemCount: summary.itemCount,
        droppedUngrounded: summary.droppedUngrounded, flaggedPages: summary.flaggedPages,
        inputTokens: summary.usage.inputTokens, outputTokens: summary.usage.outputTokens,
        cacheReadInputTokens: summary.usage.cacheReadInputTokens,
        cacheCreationInputTokens: summary.usage.cacheCreationInputTokens,
        allowancePagesUsed: after.pagesUsed, allowancePagesLimit: after.pagesLimit,
        durationMs: Date.now() - started });
    } catch (error) {
      const failure = this.toSafeFailure(error);
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
    // The verified bytes and their detected media type, for the image re-read of a hard page (never logged).
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

  /** One ocr.record_worker_ai_usage per model used; counts only. A failure is logged with a safe code. */
  private async recordAiUsage(job: ClaimedOcrJob, usage: readonly AiUsageRecord[]): Promise<void> {
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
          this.log('info', 'ocr.job.claimed', { jobId: job.jobId, correlationId: job.correlationId,
            provider: this.provider.name, attempt: job.attemptNo, claimedJobs: 1,
            ...(metrics ? { queueDepth: metrics.queueDepth,
              oldestQueueAgeSeconds: metrics.oldestQueueAgeSeconds } : {}) });
          await this.processOne(job);
        }
        else await delay(this.config.OCR_WORKER_POLL_MS, this.shutdown.signal);
      } catch (error) {
        if (this.shutdown.signal.aborted) break;
        consecutiveErrors += 1;
        this.log('error', 'ocr.worker.loop_error', { workerIndex, code: safeErrorCode(error),
          consecutiveErrors });
        const backoff = Math.min(30_000, this.config.OCR_WORKER_POLL_MS * (2 ** Math.min(consecutiveErrors, 5)));
        await delay(backoff + Math.floor(Math.random() * Math.min(backoff, 1_000)), this.shutdown.signal)
          .catch(() => undefined);
      }
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

/** raw_text is every line in reading order; provenance carries ids, counts, codes and models, never text. */
export function buildCompletion(text: TextReading, outcome: ReadingOutcome): CompletedExtraction {
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
        imagePromptVersion: summary.imageRereadPages.length > 0 ? IMAGE_PROMPT_VERSION : null,
        droppedUngrounded: summary.droppedUngrounded,
        droppedUngroundedFirstPass: summary.droppedUngroundedFirstPass,
        itemCount: summary.itemCount,
        flaggedPages: summary.flaggedPages,
        maskedNumbers: summary.maskedNumbers,
        failureCode: summary.failureCode,
        usage: summary.usage,
      },
    },
  };
}
