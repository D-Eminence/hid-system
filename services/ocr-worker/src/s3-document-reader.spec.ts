import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import type { OcrWorkerConfig } from './config';
import { S3ExactDocumentReader } from './s3-document-reader';
import type { ClaimedOcrJob } from './types';

const bytes = new TextEncoder().encode('verified document');
const job = { storageBucket: 'bucket', storageKey: 'opaque/key', objectVersionId: 'v1',
  sizeBytes: bytes.byteLength, sourceSha256Hex: createHash('sha256').update(bytes).digest('hex'),
  mediaType: 'image/png' } as ClaimedOcrJob;
const config = { AWS_REGION: 'eu-west-1', S3_FORCE_PATH_STYLE: false,
  OCR_WORKER_MAX_OBJECT_BYTES: 1024, OCR_WORKER_API_TIMEOUT_MS: 30_000 } as OcrWorkerConfig;

describe('S3ExactDocumentReader', () => {
  it('requests the exact version and returns bytes only after digest verification', async () => {
    const client = new S3Client({ region: 'eu-west-1' });
    const send = jest.spyOn(client, 'send').mockResolvedValue({ VersionId: 'v1',
      ContentLength: bytes.byteLength, Body: { transformToByteArray: async () => bytes } } as never);
    const result = await new S3ExactDocumentReader(config, client).readExact(job, new AbortController().signal);
    expect(result.sha256Hex).toBe(job.sourceSha256Hex);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Bucket: 'bucket', Key: 'opaque/key', VersionId: 'v1' });
  });

  it('fails terminally on a content digest mismatch', async () => {
    const client = new S3Client({ region: 'eu-west-1' });
    jest.spyOn(client, 'send').mockResolvedValue({ VersionId: 'v1', ContentLength: bytes.byteLength,
      Body: { transformToByteArray: async () => new TextEncoder().encode('tampered content!') } } as never);
    await expect(new S3ExactDocumentReader(config, client).readExact(job, new AbortController().signal))
      .rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_MISMATCH', retryable: false });
  });
});
