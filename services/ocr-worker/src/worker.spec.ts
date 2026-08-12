import type { OcrWorkerConfig } from './config';
import { SafeWorkerFailure, type ClaimedOcrJob, type DocumentReader,
  type WorkerOcrProvider, type WorkerRepository } from './types';
import { OcrWorker } from './worker';

const config = {
  OCR_WORKER_CONCURRENCY: 1, OCR_WORKER_LEASE_SECONDS: 60, OCR_WORKER_POLL_MS: 100,
} as OcrWorkerConfig;
const job: ClaimedOcrJob = { jobId: 'job-id', facilityId: 'facility-id', documentId: 'document-id',
  patientId: null, storageBucket: 'bucket', storageKey: 'opaque/key', objectVersionId: 'version',
  sourceSha256Hex: 'a'.repeat(64), sizeBytes: 3, mediaType: 'image/png', provider: 'test',
  attemptNo: 1, maxAttempts: 3, claimToken: 'claim-token', claimExpiresAt: new Date(),
  correlationId: 'correlation-id' };
const document = { bytes: new Uint8Array([1, 2, 3]), bucket: 'bucket', key: 'opaque/key',
  versionId: 'version', mediaType: 'image/png', sha256Hex: 'a'.repeat(64) };
const extraction = { providerModel: 'model', providerRequestReference: 'request',
  pages: [{ page: 1, text: 'clinical text', confidence: 0.9 }], provenance: {} };

function mocks() {
  const repository: jest.Mocked<WorkerRepository> = { checkReadiness: jest.fn(), claim: jest.fn(),
    renew: jest.fn(), complete: jest.fn().mockResolvedValue('extraction'), fail: jest.fn(), close: jest.fn() };
  const reader: jest.Mocked<DocumentReader> = { readExact: jest.fn().mockResolvedValue(document) };
  const provider: jest.Mocked<WorkerOcrProvider> = { name: 'test', checkReadiness: jest.fn(),
    extract: jest.fn().mockResolvedValue(extraction) };
  return { repository, reader, provider };
}

describe('OcrWorker processing', () => {
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => { stdout.mockRestore(); stderr.mockRestore(); });

  it('retrieves and verifies the source before invoking the provider, then completes', async () => {
    const { repository, reader, provider } = mocks();
    const order: string[] = [];
    reader.readExact.mockImplementation(async () => { order.push('integrity'); return document; });
    provider.extract.mockImplementation(async () => { order.push('provider'); return extraction; });
    repository.complete.mockImplementation(async () => { order.push('complete'); return 'id'; });
    await new OcrWorker(config, repository, reader, provider).processOne(job);
    expect(order).toEqual(['integrity', 'provider', 'complete']);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('does not invoke the provider when exact-object integrity fails', async () => {
    const { repository, reader, provider } = mocks();
    reader.readExact.mockRejectedValue(new SafeWorkerFailure('OBJECT_INTEGRITY_MISMATCH',
      'Stored document digest does not match immutable evidence', false, 0));
    await new OcrWorker(config, repository, reader, provider).processOne(job);
    expect(provider.extract).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(job, expect.objectContaining({
      code: 'OBJECT_INTEGRITY_MISMATCH', retryable: false,
    }));
  });

  it('maps unexpected errors to a safe retryable failure without logging clinical text', async () => {
    const { repository, reader, provider } = mocks();
    provider.extract.mockRejectedValue(new Error('patient secret clinical text'));
    await new OcrWorker(config, repository, reader, provider).processOne(job);
    expect(repository.fail).toHaveBeenCalledWith(job, expect.objectContaining({
      code: 'WORKER_INTERNAL_ERROR', safeSummary: 'OCR processing failed unexpectedly', retryable: true,
    }));
    const logs = [...stdout.mock.calls, ...stderr.mock.calls].flat().join(' ');
    expect(logs).not.toContain('patient secret clinical text');
    expect(logs).not.toContain('clinical text');
  });
});
