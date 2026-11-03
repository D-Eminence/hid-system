import type { OcrWorkerConfig } from './config';
import { AiTransientError, type PageModelClient } from './reading/claude.client';
import { paperReadingPayloadSchema, type PaperReadingPayload } from './reading/contract';
import { PaperReadingService, type ReadingConfig } from './reading/reader';
import { modelItem, modelPage, readPage } from './reading/test-fixtures';
import { DocumentTooManyPagesFailure, SafeWorkerFailure, type ClaimedOcrJob, type CompletedExtraction,
  type DocumentReader, type TextReading, type WorkerOcrProvider, type WorkerRepository } from './types';
import { OcrWorker } from './worker';

const config = {
  OCR_WORKER_CONCURRENCY: 1, OCR_WORKER_LEASE_SECONDS: 60, OCR_WORKER_POLL_MS: 100,
} as OcrWorkerConfig;
const readingConfig: ReadingConfig = { OCR_AI_MODE: 'claude', OCR_AI_FACILITY_IDS: undefined,
  OCR_AI_FIRST_PASS_MODEL: 'claude-sonnet-5-5', OCR_AI_FIRST_PASS_EFFORT: 'medium',
  OCR_AI_REREAD_MODEL: 'claude-opus-5-5', OCR_AI_REREAD_EFFORT: 'high', OCR_AI_MAX_REREAD_PAGES: 20 };
const job: ClaimedOcrJob = { jobId: 'job-id', facilityId: '11111111-2222-4333-8444-555555555555',
  documentId: 'document-id', patientId: null, storageBucket: 'bucket', storageKey: 'opaque/key',
  objectVersionId: 'version', sourceSha256Hex: 'a'.repeat(64), sizeBytes: 3, mediaType: 'image/png',
  provider: 'test', attemptNo: 1, maxAttempts: 3, claimToken: 'claim-token', claimExpiresAt: new Date(),
  correlationId: 'correlation-id' };
const document = { bytes: new Uint8Array([1, 2, 3]), bucket: 'bucket', key: 'opaque/key',
  versionId: 'version', mediaType: 'image/png', sha256Hex: 'a'.repeat(64) };

// Distinctive fictional text: none of it may ever appear in a log line.
const SECRET_NAME = 'Test Patient Zebulon Quixotic-Example';
const SECRET_DRUG = 'Fictionalmab 437mg';
const SECRET_NOTE = 'Ultramarine wombat clinic note';
const page = readPage(1, [`Name: ${SECRET_NAME} Folder: TEST-9907`, `${SECRET_DRUG} od`, SECRET_NOTE]);
const textReading: TextReading = { providerModel: 'amazon-textract-detect-document-text', providerRequestReference: 'request',
  pageCount: 1, pages: [page], provenance: { processingContract: 'hid-textract-v2', adapter: 'amazon-textract' } };
const answer = modelPage([
  modelItem({ kind: 'medicine', asWritten: `${SECRET_DRUG} od`, lineIds: ['p1-l2'], name: 'Fictionalmab',
    strength: '437mg', frequency: 'od', status: 'current', plain: `${SECRET_DRUG} once a day` }),
  modelItem({ kind: 'note', asWritten: SECRET_NOTE, lineIds: ['p1-l3'], noteText: SECRET_NOTE }),
  modelItem({ kind: 'medicine', asWritten: 'Dropped Inventedcillin 999mg', lineIds: ['p1-l2'], name: 'Inventedcillin' }),
], { identity: { name: SECRET_NAME, dateOfBirth: '', folderNumber: 'TEST-9907', sex: '', lineIds: ['p1-l1'] } });

const allowance = { pagesUsed: 10, pagesLimit: 500, resetsOn: '2026-12-01', paused: false };

function mocks(client?: PageModelClient) {
  const repository: jest.Mocked<WorkerRepository> = { checkReadiness: jest.fn(), claim: jest.fn(),
    metrics: jest.fn().mockResolvedValue({ queueDepth: 0, oldestQueueAgeSeconds: 0 }),
    renew: jest.fn(), complete: jest.fn().mockResolvedValue('extraction'), fail: jest.fn(), close: jest.fn(),
    pageAllowance: jest.fn().mockResolvedValue(allowance),
    recordPages: jest.fn().mockResolvedValue({ ...allowance, pagesUsed: 11 }),
    pauseForAllowance: jest.fn().mockResolvedValue(new Date('2026-11-30T23:00:00.000Z')) };
  const reader: jest.Mocked<DocumentReader> = { readExact: jest.fn().mockResolvedValue(document) };
  const provider: jest.Mocked<WorkerOcrProvider> = { name: 'test', checkReadiness: jest.fn(),
    extract: jest.fn().mockResolvedValue(textReading) };
  const pageClient: PageModelClient = client ?? { readPage: jest.fn().mockResolvedValue({ kind: 'answer', answer,
    attempts: 1, servedInferenceGeo: 'global',
    usage: { inputTokens: 1200, outputTokens: 400, cacheReadInputTokens: 3000, cacheCreationInputTokens: 0 } }) };
  const reading = new PaperReadingService(readingConfig, pageClient);
  return { repository, reader, provider, reading, pageClient };
}

function completed(repository: jest.Mocked<WorkerRepository>): CompletedExtraction {
  return repository.complete.mock.calls[0]![1];
}

describe('OcrWorker processing', () => {
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => { stdout.mockRestore(); stderr.mockRestore(); });
  const logs = () => [...stdout.mock.calls, ...stderr.mock.calls].map((call) => String(call[0]));

  it('verifies the source, checks the allowance, reads text, records pages, reads items, then completes', async () => {
    const { repository, reader, provider, reading } = mocks();
    const order: string[] = [];
    reader.readExact.mockImplementation(async () => { order.push('integrity'); return document; });
    repository.pageAllowance.mockImplementation(async () => { order.push('allowance'); return allowance; });
    provider.extract.mockImplementation(async () => { order.push('provider'); return textReading; });
    repository.recordPages.mockImplementation(async () => { order.push('record'); return allowance; });
    repository.complete.mockImplementation(async () => { order.push('complete'); return 'id'; });
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(order).toEqual(['integrity', 'allowance', 'provider', 'record', 'complete']);
    expect(repository.recordPages).toHaveBeenCalledWith(job, 1);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('writes the contract payload, raw text in reading order, mean line confidence and text-free provenance', async () => {
    const { repository, reader, provider, reading } = mocks();
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    const result = completed(repository);
    const payload = paperReadingPayloadSchema.parse(result.structuredPayload) as PaperReadingPayload;
    expect(payload.contract).toBe('hid-paper-reading-v2');
    expect(payload.items).toHaveLength(2);
    // The dropped item flags the page, so the stronger model re-read it once.
    expect(payload.reading).toMatchObject({ status: 'read', droppedUngrounded: 1, itemCount: 2, rereadPages: [1],
      rereadModel: 'claude-opus-5-5' });
    expect(result.rawText).toBe(page.lines.map((line) => line.text).join('\n'));
    expect(result.confidence).toBeCloseTo(0.99);
    expect(result.providerModel).toBe('amazon-textract-detect-document-text');
    expect(result.provenance).toMatchObject({ processingContract: 'hid-textract-v2', pageCount: 1,
      reading: { contract: 'hid-paper-reading-v2', firstPassModel: 'claude-sonnet-5-5', inferenceGeo: 'global',
        promptVersion: 'hid-paper-reading-prompt-2', usage: { inputTokens: 2400, outputTokens: 800 } } });
    const provenance = JSON.stringify(result.provenance);
    for (const secret of [SECRET_NAME, SECRET_DRUG, SECRET_NOTE, 'Inventedcillin']) expect(provenance).not.toContain(secret);
    expect(JSON.stringify(result.structuredPayload)).not.toContain('Inventedcillin');
  });

  it('never logs line text, items, names or SDK error details across a full job', async () => {
    const { repository, reader, provider, reading } = mocks();
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    const transient = mocks({ readPage: jest.fn().mockRejectedValue(new AiTransientError('AI_HTTP_529')) });
    await new OcrWorker(config, transient.repository, transient.reader, transient.provider, transient.reading)
      .processOne({ ...job, attemptNo: 3 });
    const failing = mocks();
    failing.provider.extract.mockRejectedValue(new Error(`${SECRET_NAME} provider detail`));
    await new OcrWorker(config, failing.repository, failing.reader, failing.provider, failing.reading).processOne(job);
    const text = logs().join('\n');
    expect(text).toContain('ocr.job.completed');
    for (const secret of [SECRET_NAME, SECRET_DRUG, SECRET_NOTE, 'Fictionalmab', 'Zebulon', 'Ultramarine', 'TEST-9907',
      'Inventedcillin', 'provider detail']) {
      expect(text).not.toContain(secret);
    }
    for (const line of logs()) {
      expect(Object.keys(JSON.parse(line) as object)).not.toEqual(expect.arrayContaining(['items', 'lines', 'text']));
    }
  });

  it('pauses without charging when the facility allowance is used up', async () => {
    const { repository, reader, provider, reading, pageClient } = mocks();
    repository.pageAllowance.mockResolvedValue({ ...allowance, pagesUsed: 500, paused: true });
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(repository.pauseForAllowance).toHaveBeenCalledWith(job);
    expect(provider.extract).not.toHaveBeenCalled();
    expect(pageClient.readPage).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    const paused = logs().map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === 'ocr.job.paused_for_allowance');
    expect(paused).toEqual({ timestamp: expect.any(String), level: 'info', event: 'ocr.job.paused_for_allowance',
      jobId: 'job-id', correlationId: 'correlation-id', resumeAt: '2026-11-30T23:00:00.000Z' });
  });

  it('reads the job when the pause finds the allowance no longer used up (a limit raised meanwhile)', async () => {
    const { repository, reader, provider, reading } = mocks();
    repository.pageAllowance.mockResolvedValue({ ...allowance, pagesUsed: 500, paused: true });
    repository.pauseForAllowance.mockResolvedValue(null);
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(repository.pauseForAllowance).toHaveBeenCalledWith(job);
    expect(provider.extract).toHaveBeenCalledTimes(1);
    expect(repository.fail).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledTimes(1);
  });

  it('does not park a retry whose own recorded pages used up the allowance', async () => {
    // A fake of the 0110 rule: paused only when used >= limit and this job has no recorded pages.
    const recorded = new Map<string, number>();
    const state = () => {
      const used = 495 + [...recorded.values()].reduce((sum, pages) => sum + pages, 0);
      return { pagesUsed: used, pagesLimit: 500, resetsOn: '2026-12-01', paused: used >= 500 };
    };
    const pageClient = { readPage: jest.fn()
      .mockRejectedValueOnce(new AiTransientError('AI_HTTP_529'))
      .mockResolvedValue({ kind: 'answer', answer, attempts: 1, servedInferenceGeo: 'global',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }) };
    const { repository, reader, provider, reading } = mocks(pageClient);
    provider.extract.mockResolvedValue({ ...textReading, pageCount: 6 });
    repository.pageAllowance.mockImplementation(async (held) => ({ ...state(),
      paused: state().paused && !recorded.has(held.jobId) }));
    repository.recordPages.mockImplementation(async (held, pages) => {
      recorded.set(held.jobId, Math.max(pages, recorded.get(held.jobId) ?? 0));
      return state();
    });
    const worker = new OcrWorker(config, repository, reader, provider, reading);
    await worker.processOne({ ...job, attemptNo: 1 });
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'AI_UNAVAILABLE' }));
    await worker.processOne({ ...job, attemptNo: 2 });
    expect(repository.pauseForAllowance).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledTimes(1);
    expect(state().pagesUsed).toBe(501);
  });

  it('records pages even when AI reading is off, and completes with ai_off', async () => {
    const { repository, reader, provider } = mocks();
    const reading = new PaperReadingService({ ...readingConfig, OCR_AI_MODE: 'off' }, null);
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(repository.recordPages).toHaveBeenCalledWith(job, 1);
    expect((completed(repository).structuredPayload as PaperReadingPayload).reading.status).toBe('ai_off');
  });

  it('retries the job with AI_UNAVAILABLE when the AI step is down before the last attempt', async () => {
    const { repository, reader, provider, reading } = mocks({ readPage: jest.fn()
      .mockRejectedValue(new AiTransientError('AI_HTTP_529')) });
    await new OcrWorker(config, repository, reader, provider, reading).processOne({ ...job, attemptNo: 2 });
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      code: 'AI_UNAVAILABLE', retryable: true, retryDelaySeconds: 60 }));
    expect(repository.recordPages).toHaveBeenCalledTimes(1);
  });

  it('completes with ai_failed and no items on the last attempt, so manual entry still works', async () => {
    const { repository, reader, provider, reading } = mocks({ readPage: jest.fn()
      .mockRejectedValue(new AiTransientError('AI_HTTP_529')) });
    await new OcrWorker(config, repository, reader, provider, reading).processOne({ ...job, attemptNo: 3 });
    expect(repository.fail).not.toHaveBeenCalled();
    const payload = completed(repository).structuredPayload as PaperReadingPayload;
    expect(payload.reading).toMatchObject({ status: 'ai_failed', itemCount: 0 });
    expect(payload.pages[0]!.lines).toHaveLength(3);
    expect(logs().some((line) => line.includes('"code":"AI_HTTP_529"'))).toBe(true);
  });

  it('fails a document over 20 pages terminally after counting the pages that were read', async () => {
    const { repository, reader, provider, reading } = mocks();
    provider.extract.mockRejectedValue(new DocumentTooManyPagesFailure(23, 20));
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(repository.recordPages).toHaveBeenCalledWith(job, 23);
    expect(repository.fail).toHaveBeenCalledWith(job, expect.objectContaining({ code: 'DOCUMENT_TOO_MANY_PAGES',
      retryable: false }));
  });

  it('does not invoke the provider when exact-object integrity fails', async () => {
    const { repository, reader, provider, reading } = mocks();
    reader.readExact.mockRejectedValue(new SafeWorkerFailure('OBJECT_INTEGRITY_MISMATCH',
      'Stored document digest does not match immutable evidence', false, 0));
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(provider.extract).not.toHaveBeenCalled();
    expect(repository.pageAllowance).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(job, expect.objectContaining({
      code: 'OBJECT_INTEGRITY_MISMATCH', retryable: false,
    }));
  });

  it('maps unexpected errors to a safe retryable failure without logging clinical text', async () => {
    const { repository, reader, provider, reading } = mocks();
    provider.extract.mockRejectedValue(new Error('patient secret clinical text'));
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(repository.fail).toHaveBeenCalledWith(job, expect.objectContaining({
      code: 'WORKER_INTERNAL_ERROR', safeSummary: 'OCR processing failed unexpectedly', retryable: true,
    }));
    const text = logs().join(' ');
    expect(text).not.toContain('patient secret clinical text');
    expect(text).not.toContain('clinical text');
  });
});
