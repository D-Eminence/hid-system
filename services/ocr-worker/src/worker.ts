import { randomUUID } from 'node:crypto';
import type { OcrWorkerConfig } from './config';
import { SafeWorkerFailure, type ClaimedOcrJob, type DocumentReader,
  type WorkerOcrProvider, type WorkerRepository } from './types';

export class OcrWorker {
  private readonly shutdown = new AbortController();
  private acceptingClaims = false;
  constructor(private readonly config: OcrWorkerConfig, private readonly repository: WorkerRepository,
    private readonly reader: DocumentReader, private readonly provider: WorkerOcrProvider) {}

  async run(): Promise<void> {
    await this.repository.checkReadiness();
    await this.provider.checkReadiness(this.shutdown.signal);
    this.acceptingClaims = true;
    this.log('info', 'ocr.worker.ready', { provider: this.provider.name,
      acceptingClaims: true, concurrency: this.config.OCR_WORKER_CONCURRENCY,
      remoteProviderCheck: false });
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
    try {
      const document = await this.reader.readExact(job, this.shutdown.signal);
      const extraction = await this.provider.extract(document, this.shutdown.signal);
      await this.repository.complete(job, extraction);
      this.log('info', 'ocr.job.completed', { jobId: job.jobId, correlationId: job.correlationId,
        provider: this.provider.name, attempt: job.attemptNo, pagesProcessed: extraction.pages.length,
        retryCount: Math.max(0, job.attemptNo - 1) });
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

  private async claimLoop(workerIndex: number): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.shutdown.signal.aborted) {
      try {
        const job = await this.repository.claim(this.provider.name, this.config.OCR_WORKER_LEASE_SECONDS,
          `ocr-worker-${randomUUID()}`);
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
