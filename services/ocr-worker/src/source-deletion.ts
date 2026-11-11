import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import type { OcrWorkerConfig } from './config';

/**
 * Deletion of an OCR source 24 hours after its jobs finished (migration 0111; owner and coordinator decisions of
 * 2026-11-11). Each round the worker lists the documents due (those already claimed first), and for each: claims it
 * (status source_deleting, under a row lock; from then the database refuses a new job, a retry or a legal hold),
 * deletes every S3 version and delete marker of its stored key, confirms none remain, and only then has the database
 * mark it source_deleted and blank the reading and review content of its OCR rows. A refused claim means no S3 call.
 * A storage failure leaves the document claimed; the next round retries it first. Logs carry ids, codes and counts.
 */

/** One row of ocr.list_worker_source_deletions (0111). */
export interface SourceDeletionCandidate {
  documentId: string;
  facilityId: string;
  storageBucket: string;
  storageKey: string;
  /** Seconds since the document became due (24 hours after its latest job finished). */
  dueSeconds: number;
}

export interface SourceDeletionBacklog {
  /** Documents due now. */
  due: number;
  /** Documents due for more than 2 hours (more than 26 hours after their job finished). */
  overdue: number;
}

/** What ocr.claim_worker_source_deletion answered; bucket and key only for a claim the worker may act on. */
export interface SourceClaimResult {
  outcome: 'claimed' | 'already_claimed' | 'already_deleted' | 'not_due';
  storageBucket: string | null;
  storageKey: string | null;
}

/** What ocr.purge_worker_source_document answered: rows blanked per table. */
export interface SourcePurgeResult {
  outcome: 'deleted' | 'already_deleted' | 'not_claimed';
  extractions: number;
  validations: number;
  confirmations: number;
}

export interface SourceDeletionRepository {
  sourceDeletionBacklog(correlationId: string): Promise<SourceDeletionBacklog>;
  listSourceDeletions(limit: number, correlationId: string): Promise<readonly SourceDeletionCandidate[]>;
  claimSourceDeletion(documentId: string, correlationId: string): Promise<SourceClaimResult>;
  purgeSourceDocument(documentId: string, deletedVersions: number, correlationId: string): Promise<SourcePurgeResult>;
}

export interface SourceObjectEraser {
  /** Deletes every version and delete marker whose key is exactly `key`; resolves with how many it deleted. */
  eraseAllVersions(bucket: string, key: string, signal: AbortSignal): Promise<number>;
}

/** A storage or layout failure with a code safe to log, and how many versions were deleted before it. */
export class SourceDeletionError extends Error {
  constructor(readonly code: string, readonly deleted = 0) { super(code); this.name = 'SourceDeletionError'; }
}

/** The upload intent's key layout (clinical/objects/<uuid>, set by the EHR service); anything else is never deleted. */
const SOURCE_KEY = /^clinical\/objects\/[A-Za-z0-9-]{1,128}$/;
/** Documents taken per round; the rest wait for the next round (the overdue count shows a backlog). */
export const SOURCE_DELETION_BATCH = 100;

export class S3SourceObjectEraser implements SourceObjectEraser {
  private readonly client: S3Client;
  constructor(private readonly config: OcrWorkerConfig, client?: S3Client) {
    this.client = client ?? new S3Client({ region: config.AWS_REGION, maxAttempts: 3,
      ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY ? { credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      } } : {}) });
  }

  async eraseAllVersions(bucket: string, key: string, signal: AbortSignal): Promise<number> {
    if (!SOURCE_KEY.test(key)) throw new SourceDeletionError('SOURCE_KEY_OUTSIDE_LAYOUT');
    const versions = await this.listExact(bucket, key, signal);
    let deleted = 0;
    for (const versionId of versions) {
      await this.call(() => this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
        { abortSignal: this.requestSignal(signal) }), 'SOURCE_DELETE_FAILED', deleted);
      deleted += 1;
    }
    if ((await this.listExact(bucket, key, signal, deleted)).length > 0) {
      throw new SourceDeletionError('SOURCE_VERSIONS_REMAIN', deleted);
    }
    return deleted;
  }

  /**
   * Every version and delete marker whose key is exactly `key`. ListObjectVersions takes a prefix, so a key that
   * only starts with it (clinical/objects/<uuid>-copy, say) is listed too and dropped here.
   */
  private async listExact(bucket: string, key: string, signal: AbortSignal, deletedSoFar = 0): Promise<string[]> {
    const found: string[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.call(() => this.client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key,
        ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
        ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }) }),
        { abortSignal: this.requestSignal(signal) }), 'SOURCE_LIST_FAILED', deletedSoFar);
      for (const entry of [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]) {
        if (entry.Key === key) {
          if (!entry.VersionId) throw new SourceDeletionError('SOURCE_VERSION_ID_MISSING', deletedSoFar);
          found.push(entry.VersionId);
        }
      }
      if (!result.IsTruncated) return found;
      keyMarker = result.NextKeyMarker;
      versionIdMarker = result.NextVersionIdMarker;
      if (keyMarker === undefined && versionIdMarker === undefined) {
        throw new SourceDeletionError('SOURCE_LIST_FAILED', deletedSoFar);
      }
    }
    throw new SourceDeletionError('SOURCE_LIST_TOO_LONG', deletedSoFar);
  }

  private async call<Result>(operation: () => Promise<Result>, code: string, deletedSoFar: number): Promise<Result> {
    try { return await operation(); } catch (error) {
      if (error instanceof SourceDeletionError) throw error;
      throw new SourceDeletionError(code, deletedSoFar);
    }
  }

  private requestSignal(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(this.config.OCR_WORKER_API_TIMEOUT_MS)]);
  }
}

export type SourceDeletionLog = (level: string, event: string, fields: Readonly<Record<string, unknown>>) => void;

/** The worker's log line: one flat JSON object with timestamp, level and event (as OcrWorker writes its own). */
export const jsonLog: SourceDeletionLog = (level, event, fields) => {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
};

export interface SourceDeletionRound {
  due: number;
  overdue: number;
  deleted: number;
  failed: number;
}

export class SourceDeletionSweeper {
  /**
   * S3 versions deleted for a document in earlier rounds whose purge has not happened yet (a storage failure part-way,
   * or a purge that failed), so the audit row's objectVersionsDeleted counts every round of this worker process.
   */
  private readonly pendingVersions = new Map<string, number>();

  constructor(private readonly repository: SourceDeletionRepository, private readonly eraser: SourceObjectEraser,
    private readonly log: SourceDeletionLog = jsonLog) {}

  /**
   * One round. A round that cannot count or list the documents due logs ocr.source_deletion.failed and no overdue
   * line (the alarm then sees missing data); every other round ends with exactly one ocr.source_deletion.overdue line,
   * also when nothing is due.
   */
  async runRound(signal: AbortSignal): Promise<SourceDeletionRound | null> {
    const correlationId = `ocr-source-deletion-${randomUUID()}`;
    let backlog: SourceDeletionBacklog;
    let candidates: readonly SourceDeletionCandidate[];
    try {
      backlog = await this.repository.sourceDeletionBacklog(correlationId);
      candidates = await this.repository.listSourceDeletions(SOURCE_DELETION_BATCH, correlationId);
    } catch (error) {
      this.log('error', 'ocr.source_deletion.failed', { correlationId, stage: 'list', code: safeCode(error) });
      return null;
    }
    let deleted = 0;
    let failed = 0;
    for (const candidate of candidates) {
      if (signal.aborted) break;
      const outcome = await this.deleteOne(candidate, correlationId, signal);
      if (outcome === 'deleted') deleted += 1;
      if (outcome === 'failed') failed += 1;
    }
    // The CloudWatch alarm's line (dev Terraform): metric filter { $.event = "ocr.source_deletion.overdue" }, value
    // $.overdue, missing data breaching. Counts taken at the start of the round.
    this.log('info', 'ocr.source_deletion.overdue', { overdue: backlog.overdue, due: backlog.due, deleted });
    return { due: backlog.due, overdue: backlog.overdue, deleted, failed };
  }

  /** Claim, then S3, then the purge. Never an S3 call without a claim the database granted. */
  private async deleteOne(candidate: SourceDeletionCandidate, correlationId: string,
    signal: AbortSignal): Promise<'deleted' | 'done' | 'skipped' | 'failed'> {
    const documentId = candidate.documentId;
    const fail = (stage: string, code: string, fields: Record<string, unknown> = {}) => {
      this.log('warn', 'ocr.source_deletion.failed', { correlationId, documentId, stage, code,
        dueSeconds: candidate.dueSeconds, ...fields });
      return 'failed' as const;
    };
    let claim: SourceClaimResult;
    try {
      claim = await this.repository.claimSourceDeletion(documentId, correlationId);
    } catch (error) {
      return fail('claim', safeCode(error));
    }
    if (claim.outcome === 'not_due') {
      // A job, a retry or a legal hold came after the listing: nothing is deleted.
      this.log('info', 'ocr.source_deletion.skipped', { correlationId, documentId, code: 'SOURCE_NO_LONGER_DUE' });
      return 'skipped';
    }
    let versionsDeleted = this.pendingVersions.get(documentId) ?? 0;
    if (claim.outcome !== 'already_deleted') {
      if (!claim.storageBucket || !claim.storageKey) return fail('claim', 'SOURCE_CLAIM_INVALID');
      try {
        versionsDeleted += await this.eraser.eraseAllVersions(claim.storageBucket, claim.storageKey, signal);
      } catch (error) {
        if (error instanceof SourceDeletionError) versionsDeleted += error.deleted;
        this.remember(documentId, versionsDeleted);
        return fail('storage', safeCode(error));
      }
    }
    let result: SourcePurgeResult;
    try {
      result = await this.repository.purgeSourceDocument(documentId, versionsDeleted, correlationId);
    } catch (error) {
      this.remember(documentId, versionsDeleted);
      return fail('purge', safeCode(error), { objectVersionsDeleted: versionsDeleted });
    }
    if (result.outcome === 'not_claimed') {
      this.remember(documentId, versionsDeleted);
      return fail('purge', 'SOURCE_NOT_CLAIMED', { objectVersionsDeleted: versionsDeleted });
    }
    this.pendingVersions.delete(documentId);
    this.log('info', 'ocr.source_deletion.done', { correlationId, documentId,
      outcome: result.outcome, objectVersionsDeleted: versionsDeleted, extractionsBlanked: result.extractions,
      validationsBlanked: result.validations, confirmationsBlanked: result.confirmations,
      dueSeconds: candidate.dueSeconds });
    return result.outcome === 'deleted' ? 'deleted' : 'done';
  }

  private remember(documentId: string, versionsDeleted: number): void {
    if (versionsDeleted > 0) this.pendingVersions.set(documentId, versionsDeleted);
  }
}

function safeCode(error: unknown): string {
  if (error instanceof SourceDeletionError) return error.code;
  const code = error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
    ? (error as Error & { code: string }).code : 'UNKNOWN';
  return /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : 'UNKNOWN';
}
