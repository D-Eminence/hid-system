import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { OcrWorkerConfig } from './config';
import { SafeWorkerFailure, type ClaimedOcrJob, type DocumentReader, type VerifiedDocument } from './types';

export class S3ExactDocumentReader implements DocumentReader {
  private readonly client: S3Client;
  constructor(private readonly config: OcrWorkerConfig, client?: S3Client) {
    this.client = client ?? new S3Client({ region: config.AWS_REGION, maxAttempts: 1,
      ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY ? { credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      } } : {}) });
  }

  async checkReadiness(bucket: string, signal: AbortSignal): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: this.requestSignal(signal) });
  }

  async readExact(job: ClaimedOcrJob, signal: AbortSignal): Promise<VerifiedDocument> {
    if (job.sizeBytes > this.config.OCR_WORKER_MAX_OBJECT_BYTES) {
      throw new SafeWorkerFailure('OBJECT_TOO_LARGE', 'Document exceeds the OCR worker size limit', false, 0);
    }
    let result;
    try {
      result = await this.client.send(new GetObjectCommand({ Bucket: job.storageBucket,
        Key: job.storageKey, VersionId: job.objectVersionId, ChecksumMode: 'ENABLED' }), { abortSignal: this.requestSignal(signal) });
    } catch (error) {
      throw this.storageFailure(error);
    }
    if (result.VersionId !== job.objectVersionId || result.ContentLength !== job.sizeBytes || !result.Body) {
      throw new SafeWorkerFailure('OBJECT_METADATA_MISMATCH', 'Stored document metadata does not match the claimed version', false, 0);
    }
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength !== job.sizeBytes) {
      throw new SafeWorkerFailure('OBJECT_SIZE_MISMATCH', 'Stored document size does not match immutable evidence', false, 0);
    }
    const sha256Hex = createHash('sha256').update(bytes).digest('hex');
    if (sha256Hex !== job.sourceSha256Hex) {
      throw new SafeWorkerFailure('OBJECT_INTEGRITY_MISMATCH', 'Stored document digest does not match immutable evidence', false, 0);
    }
    return { bytes, bucket: job.storageBucket, key: job.storageKey,
      versionId: job.objectVersionId, mediaType: job.mediaType, sha256Hex };
  }

  private storageFailure(error: unknown): SafeWorkerFailure {
    const name = error instanceof Error ? error.name : 'unknown';
    const terminal = name === 'NoSuchKey' || name === 'NoSuchVersion';
    return new SafeWorkerFailure(terminal ? 'OBJECT_NOT_FOUND' : 'STORAGE_UNAVAILABLE',
      terminal ? 'The immutable document version is unavailable' : 'Document storage is temporarily unavailable',
      !terminal, terminal ? 0 : 15);
  }
  private requestSignal(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(this.config.OCR_WORKER_API_TIMEOUT_MS)]);
  }
}
