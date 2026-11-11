import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import type { OcrWorkerConfig } from './config';

/**
 * Deletion of an OCR source 24 hours after its jobs finished (migration 0110; owner and coordinator decisions of
 * 2026-11-11). Each round the worker lists the documents due, deletes every S3 version and delete marker of each
 * document's stored key, confirms none remain, and only then has the database mark the document source_deleted and
 * blank the reading and review content of its OCR rows. A storage failure skips the purge; the next round retries.
 * Logs carry ids, codes and counts only.
 */

/** One row of ocr.list_worker_source_deletions (0110). */
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

/** What ocr.purge_worker_source_document answered: rows blanked per table. */
export interface SourcePurgeResult {
  outcome: 'deleted' | 'already_deleted' | 'not_due';
  extractions: number;
  validations: number;
  confirmations: number;
}

export interface SourceDeletionRepository {
  sourceDeletionBacklog(correlationId: string): Promise<SourceDeletionBacklog>;
  listSourceDeletions(limit: number, correlationId: string): Promise<readonly SourceDeletionCandidate[]>;
  purgeSourceDocument(documentId: string, deletedVersions: number, correlationId: string): Promise<SourcePurgeResult>;
}

export interface SourceObjectEraser {
  /** Deletes every version and delete marker whose key is exactly `key`; resolves with how many it deleted. */
  eraseAllVersions(bucket: string, key: string, signal: AbortSignal): Promise<number>;
}

/** A storage or layout failure with a code safe to log. */
export class SourceDeletionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SourceDeletionError'; }
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
    for (const versionId of versions) {
      await this.call(() => this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
        { abortSignal: this.requestSignal(signal) }), 'SOURCE_DELETE_FAILED');
    }
    if ((await this.listExact(bucket, key, signal)).length > 0) throw new SourceDeletionError('SOURCE_VERSIONS_REMAIN');
    return versions.length;
  }

  /**
   * Every version and delete marker whose key is exactly `key`. ListObjectVersions takes a prefix, so a key that
   * only starts with it (clinical/objects/<uuid>-copy, say) is listed too and dropped here.
   */
  private async listExact(bucket: string, key: string, signal: AbortSignal): Promise<string[]> {
    const found: string[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.call(() => this.client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key,
        ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
        ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }) }),
        { abortSignal: this.requestSignal(signal) }), 'SOURCE_LIST_FAILED');
      for (const entry of [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]) {
        if (entry.Key === key) {
          if (!entry.VersionId) throw new SourceDeletionError('SOURCE_VERSION_ID_MISSING');
          found.push(entry.VersionId);
        }
      }
      if (!result.IsTruncated) return found;
      keyMarker = result.NextKeyMarker;
      versionIdMarker = result.NextVersionIdMarker;
      if (keyMarker === undefined && versionIdMarker === undefined) throw new SourceDeletionError('SOURCE_LIST_FAILED');
    }
    throw new SourceDeletionError('SOURCE_LIST_TOO_LONG');
  }

  private async call<Result>(operation: () => Promise<Result>, code: string): Promise<Result> {
    try { return await operation(); } catch (error) {
      if (error instanceof SourceDeletionError) throw error;
      throw new SourceDeletionError(code);
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
      let versionsDeleted: number;
      try {
        versionsDeleted = await this.eraser.eraseAllVersions(candidate.storageBucket, candidate.storageKey, signal);
      } catch (error) {
        failed += 1;
        this.log('warn', 'ocr.source_deletion.failed', { correlationId, documentId: candidate.documentId,
          stage: 'storage', code: safeCode(error), dueSeconds: candidate.dueSeconds });
        continue;
      }
      try {
        const result = await this.repository.purgeSourceDocument(candidate.documentId, versionsDeleted, correlationId);
        if (result.outcome === 'deleted') deleted += 1;
        this.log('info', 'ocr.source_deletion.done', { correlationId, documentId: candidate.documentId,
          outcome: result.outcome, objectVersionsDeleted: versionsDeleted, extractionsBlanked: result.extractions,
          validationsBlanked: result.validations, confirmationsBlanked: result.confirmations,
          dueSeconds: candidate.dueSeconds });
      } catch (error) {
        failed += 1;
        this.log('warn', 'ocr.source_deletion.failed', { correlationId, documentId: candidate.documentId,
          stage: 'purge', code: safeCode(error), objectVersionsDeleted: versionsDeleted });
      }
    }
    // The CloudWatch alarm's line (dev Terraform): metric filter { $.event = "ocr.source_deletion.overdue" }, value
    // $.overdue, missing data breaching. Counts taken at the start of the round.
    this.log('info', 'ocr.source_deletion.overdue', { overdue: backlog.overdue, due: backlog.due, deleted });
    return { due: backlog.due, overdue: backlog.overdue, deleted, failed };
  }
}

function safeCode(error: unknown): string {
  if (error instanceof SourceDeletionError) return error.code;
  const code = error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
    ? (error as Error & { code: string }).code : 'UNKNOWN';
  return /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : 'UNKNOWN';
}
