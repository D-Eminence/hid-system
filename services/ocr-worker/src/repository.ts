import { createHash } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import type { OcrWorkerConfig } from './config';
import type { AiUsageRecord, ClaimedOcrJob, CompletedExtraction, PageAllowance, SafeWorkerFailure, WorkerRepository } from './types';
import type { SourceClaimResult, SourceDeletionBacklog, SourceDeletionCandidate, SourceDeletionRepository,
  SourcePurgeResult } from './source-deletion';

interface ClaimRow extends QueryResultRow {
  job_id: string; facility_id: string; document_id: string; patient_id: string | null;
  storage_bucket: string; storage_key: string; object_version_id: string;
  source_sha256_hex: string; size_bytes: string; media_type: string; provider: string;
  attempt_no: number; max_attempts: number; claim_token: string;
  claim_expires_at: Date; correlation_id: string;
}

interface AllowanceRow extends QueryResultRow {
  pages_used: number; pages_limit: number; resets_on: string; paused: boolean;
}

interface QueueMetricsRow extends QueryResultRow {
  queue_depth: string;
  oldest_queue_age_seconds: string;
}

interface SourceDeletionRow extends QueryResultRow {
  document_id: string; facility_id: string; storage_bucket: string; storage_key: string; due_seconds: string;
}

export class PostgresWorkerRepository implements WorkerRepository, SourceDeletionRepository {
  private readonly pool: Pool;
  constructor(private readonly config: OcrWorkerConfig) {
    const ssl: PoolConfig['ssl'] = config.OCR_WORKER_DATABASE_SSL ? {
      rejectUnauthorized: true,
      ...(config.OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64 ? {
        ca: Buffer.from(config.OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64, 'base64').toString('utf8'),
      } : {}),
    } : false;
    this.pool = new Pool({ connectionString: config.OCR_WORKER_DATABASE_URL,
      max: config.OCR_WORKER_POOL_MAX, application_name: 'hid-ocr-worker', ssl,
      connectionTimeoutMillis: 5_000, statement_timeout: 30_000, query_timeout: 35_000 });
    this.pool.on('error', (error) => this.logDbFailure(error));
  }

  async checkReadiness(): Promise<void> { await this.pool.query('select 1'); }

  // Fair claim (migration 0107): the same rules as ocr.claim_worker_job, but a facility already holding
  // maxInFlightPerFacility live claims is skipped and the facility with the fewest goes first.
  async claim(provider: string, leaseSeconds: number, maxInFlightPerFacility: number,
    correlationId: string): Promise<ClaimedOcrJob | null> {
    return this.transaction(correlationId, async (client) => {
      const result = await client.query<ClaimRow>('select * from ocr.claim_worker_job_fair($1, $2, $3)',
        [provider, leaseSeconds, maxInFlightPerFacility]);
      const row = result.rows[0];
      return row ? this.mapClaim(row) : null;
    });
  }

  async renew(job: ClaimedOcrJob, leaseSeconds: number): Promise<void> {
    await this.transaction(job.correlationId, async (client) => {
      await client.query('select ocr.renew_worker_claim($1, $2, $3)', [job.jobId, job.claimToken, leaseSeconds]);
    });
  }

  // hid_ocr_worker has no table privileges; queue depth and age come only from
  // the aggregate-only command (0082), which reads ocr.jobs as its owner.
  async metrics(): Promise<Readonly<{ queueDepth: number; oldestQueueAgeSeconds: number }>> {
    const result = await this.pool.query<QueueMetricsRow>(
      `select queue_depth::text as queue_depth,
              oldest_queue_age_seconds::text as oldest_queue_age_seconds
         from ocr.worker_queue_metrics()`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('OCR queue metrics returned no row');
    return { queueDepth: Number(row.queue_depth),
      oldestQueueAgeSeconds: Number(row.oldest_queue_age_seconds) };
  }

  async complete(job: ClaimedOcrJob, extraction: CompletedExtraction): Promise<string> {
    const canonical = JSON.stringify({ rawText: extraction.rawText, structured: extraction.structuredPayload });
    const contentHash = createHash('sha256').update(canonical).digest('hex');
    const confidence = Math.max(0, Math.min(1, Math.round(extraction.confidence * 100_000) / 100_000));
    const resultKey = `${extraction.providerRequestReference ?? 'local'}:${contentHash}`.slice(0, 255);
    return this.transaction(job.correlationId, async (client) => {
      const result = await client.query<{ extraction_id: string }>(
        `select ocr.complete_worker_job($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11) as extraction_id`,
        [job.jobId, job.claimToken, resultKey, contentHash, extraction.providerModel,
          extraction.providerRequestReference, extraction.rawText, JSON.stringify(extraction.structuredPayload),
          confidence, JSON.stringify(extraction.provenance), job.correlationId],
      );
      const id = result.rows[0]?.extraction_id;
      if (!id) throw new Error('OCR completion did not return an extraction identifier');
      return id;
    });
  }

  // Page allowance (migration 0107): each command runs as the worker subject in
  // the claim's correlation, like every other worker command.
  async pageAllowance(job: ClaimedOcrJob): Promise<PageAllowance> {
    return this.transaction(job.correlationId, async (client) => mapAllowance((await client.query<AllowanceRow>(
      `select pages_used, pages_limit, resets_on::text as resets_on, paused
         from ocr.worker_page_allowance($1, $2)`, [job.jobId, job.claimToken])).rows[0]));
  }

  async recordPages(job: ClaimedOcrJob, pageCount: number): Promise<PageAllowance> {
    return this.transaction(job.correlationId, async (client) => mapAllowance((await client.query<AllowanceRow>(
      `select pages_used, pages_limit, resets_on::text as resets_on, paused
         from ocr.record_worker_pages($1, $2, $3, $4)`,
      [job.jobId, job.claimToken, pageCount, job.correlationId])).rows[0]));
  }

  /** The resume time, or null when nothing was parked (a limit raised since the read, or pages already counted). */
  async pauseForAllowance(job: ClaimedOcrJob): Promise<Date | null> {
    return this.transaction(job.correlationId, async (client) => {
      const result = await client.query<{ resume_at: Date | string }>(
        'select ocr.pause_worker_job_for_allowance($1, $2, $3) as resume_at',
        [job.jobId, job.claimToken, job.correlationId]);
      if (result.rows.length !== 1) throw new Error('OCR allowance pause returned no row');
      const resumeAt = result.rows[0]!.resume_at;
      if (resumeAt === null || resumeAt === undefined) return null;
      return resumeAt instanceof Date ? resumeAt : new Date(resumeAt);
    });
  }

  /** Counts only (migration 0107); idempotent per job, attempt and model (a replay replaces the totals). */
  async recordAiUsage(job: ClaimedOcrJob, usage: AiUsageRecord): Promise<void> {
    await this.transaction(job.correlationId, async (client) => {
      await client.query('select ocr.record_worker_ai_usage($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [job.jobId, job.claimToken, usage.model, usage.requests, usage.inputTokens, usage.outputTokens,
          usage.cacheReadTokens, usage.cacheWriteTokens, job.correlationId]);
    });
  }

  async fail(job: ClaimedOcrJob, failure: SafeWorkerFailure): Promise<void> {
    await this.transaction(job.correlationId, async (client) => {
      await client.query('select ocr.fail_worker_job($1,$2,$3,$4,$5,$6,$7)',
        [job.jobId, job.claimToken, failure.code, failure.safeSummary, failure.retryable,
          failure.retryDelaySeconds, job.correlationId]);
    });
  }
  // Source deletion (migration 0110): the documents due and their counts, and the purge after every S3 version of
  // the source is gone. Each runs as the worker subject in the round's correlation.
  async sourceDeletionBacklog(correlationId: string): Promise<SourceDeletionBacklog> {
    return this.transaction(correlationId, async (client) => {
      const row = (await client.query<{ due: number; overdue: number }>(
        'select due, overdue from ocr.worker_source_deletion_backlog()')).rows[0];
      if (!row || !Number.isSafeInteger(Number(row.due)) || !Number.isSafeInteger(Number(row.overdue))) {
        throw new Error('OCR source deletion backlog returned an invalid row');
      }
      return { due: Number(row.due), overdue: Number(row.overdue) };
    });
  }

  async listSourceDeletions(limit: number, correlationId: string): Promise<readonly SourceDeletionCandidate[]> {
    return this.transaction(correlationId, async (client) => (await client.query<SourceDeletionRow>(
      `select document_id::text as document_id, facility_id::text as facility_id, storage_bucket, storage_key,
              due_seconds::text as due_seconds
         from ocr.list_worker_source_deletions($1)`, [limit])).rows.map((row) => ({
      documentId: row.document_id, facilityId: row.facility_id, storageBucket: row.storage_bucket,
      storageKey: row.storage_key, dueSeconds: Number(row.due_seconds) })));
  }

  // The claim (source_deleting under a row lock) comes before any S3 call.
  async claimSourceDeletion(documentId: string, correlationId: string): Promise<SourceClaimResult> {
    return this.transaction(correlationId, async (client) => {
      const row = (await client.query<{ outcome: string; storage_bucket: string | null; storage_key: string | null }>(
        'select outcome, storage_bucket, storage_key from ocr.claim_worker_source_deletion($1, $2)',
        [documentId, correlationId])).rows[0];
      if (!row || !['claimed', 'already_claimed', 'already_deleted', 'not_due'].includes(row.outcome)) {
        throw new Error('OCR source deletion claim returned an invalid row');
      }
      return { outcome: row.outcome as SourceClaimResult['outcome'], storageBucket: row.storage_bucket,
        storageKey: row.storage_key };
    });
  }

  async purgeSourceDocument(documentId: string, deletedVersions: number, correlationId: string): Promise<SourcePurgeResult> {
    return this.transaction(correlationId, async (client) => {
      const row = (await client.query<{ outcome: string; extractions: number; validations: number; confirmations: number }>(
        'select outcome, extractions, validations, confirmations from ocr.purge_worker_source_document($1, $2, $3)',
        [documentId, deletedVersions, correlationId])).rows[0];
      if (!row || !['deleted', 'already_deleted', 'not_claimed'].includes(row.outcome)) {
        throw new Error('OCR source purge returned an invalid row');
      }
      return { outcome: row.outcome as SourcePurgeResult['outcome'], extractions: Number(row.extractions),
        validations: Number(row.validations), confirmations: Number(row.confirmations) };
    });
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async transaction<Result>(correlationId: string, operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.actor_subject',$1,true), set_config('app.correlation_id',$2,true)`,
        [this.config.OCR_WORKER_SUBJECT, correlationId]);
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  private mapClaim(row: ClaimRow): ClaimedOcrJob {
    const sizeBytes = Number(row.size_bytes);
    if (!Number.isSafeInteger(sizeBytes)) throw new Error('Invalid claimed object size');
    return { jobId: row.job_id, facilityId: row.facility_id, documentId: row.document_id,
      patientId: row.patient_id, storageBucket: row.storage_bucket, storageKey: row.storage_key,
      objectVersionId: row.object_version_id, sourceSha256Hex: row.source_sha256_hex,
      sizeBytes, mediaType: row.media_type, provider: row.provider, attemptNo: row.attempt_no,
      maxAttempts: row.max_attempts, claimToken: row.claim_token,
      claimExpiresAt: row.claim_expires_at, correlationId: row.correlation_id };
  }
  private logDbFailure(error: Error): void {
    const code = typeof (error as Error & { code?: unknown }).code === 'string'
      ? (error as Error & { code: string }).code : 'unknown';
    process.stderr.write(JSON.stringify({ level: 'error', event: 'ocr.db.pool_error', code }) + '\n');
  }
}

function mapAllowance(row: AllowanceRow | undefined): PageAllowance {
  if (!row) throw new Error('OCR page allowance returned no row');
  const pagesUsed = Number(row.pages_used);
  const pagesLimit = Number(row.pages_limit);
  if (!Number.isSafeInteger(pagesUsed) || !Number.isSafeInteger(pagesLimit) || typeof row.paused !== 'boolean'
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.resets_on))) {
    throw new Error('OCR page allowance returned an invalid row');
  }
  return { pagesUsed, pagesLimit, resetsOn: String(row.resets_on), paused: row.paused };
}
