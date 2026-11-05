import type { OcrWorkerConfig } from './config';
import { AiInterruptedError, AiTransientError, type PageModelClient } from './reading/claude.client';
import { paperReadingPayloadSchema, type PaperReadingPayload } from './reading/contract';
import { PaperReadingService, type ReadingConfig } from './reading/reader';
import { fixturePng, modelItem, modelPage, readPage } from './reading/test-fixtures';
import { DocumentTooManyPagesFailure, SafeWorkerFailure, type ClaimedOcrJob, type CompletedExtraction,
  type DocumentReader, type TextReading, type WorkerOcrProvider, type WorkerRepository } from './types';
import { Semaphore } from './semaphore';
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
    pauseForAllowance: jest.fn().mockResolvedValue(new Date('2026-11-30T23:00:00.000Z')),
    recordAiUsage: jest.fn().mockResolvedValue(undefined) };
  const reader: jest.Mocked<DocumentReader> = { readExact: jest.fn().mockResolvedValue(document) };
  const provider: jest.Mocked<WorkerOcrProvider> = { name: 'test', checkReadiness: jest.fn(),
    extract: jest.fn().mockResolvedValue(textReading) };
  const pageClient: PageModelClient = client ?? { readPage: jest.fn().mockResolvedValue({ kind: 'answer', answer,
    attempts: 1, servedInferenceGeo: 'us',
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
      reading: { contract: 'hid-paper-reading-v2', firstPassModel: 'claude-sonnet-5-5', inferenceGeo: 'us',
        promptVersion: 'hid-paper-reading-prompt-4', usage: { inputTokens: 2400, outputTokens: 800 } } });
    const provenance = JSON.stringify(result.provenance);
    for (const secret of [SECRET_NAME, SECRET_DRUG, SECRET_NOTE, 'Inventedcillin']) expect(provenance).not.toContain(secret);
    expect(JSON.stringify(result.structuredPayload)).not.toContain('Inventedcillin');
  });

  it('logs the dropped items by reason code on completion, and keeps the map out of the payload and provenance', async () => {
    const { repository, reader, provider, reading } = mocks();
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    const line = logs().find((entry) => entry.includes('ocr.job.completed'))!;
    const logged = JSON.parse(line) as { droppedUngrounded: number; droppedByReason: Record<string, number> };
    expect(logged.droppedByReason).toEqual({ text_not_on_line: 1 });
    expect(Object.values(logged.droppedByReason).reduce((sum, count) => sum + count, 0)).toBe(logged.droppedUngrounded);
    expect(line).not.toContain('Inventedcillin');
    const result = completed(repository);
    expect(JSON.stringify(result.structuredPayload)).not.toContain('droppedByReason');
    expect(JSON.stringify(result.provenance)).not.toContain('droppedByReason');
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
    // A fake of the 0107 rule: paused only when used >= limit and this job has no recorded pages.
    const recorded = new Map<string, number>();
    const state = () => {
      const used = 495 + [...recorded.values()].reduce((sum, pages) => sum + pages, 0);
      return { pagesUsed: used, pagesLimit: 500, resetsOn: '2026-12-01', paused: used >= 500 };
    };
    const pageClient = { readPage: jest.fn()
      .mockRejectedValueOnce(new AiTransientError('AI_HTTP_529'))
      .mockResolvedValue({ kind: 'answer', answer, attempts: 1, servedInferenceGeo: 'us',
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

  describe('AI use and caps', () => {
    const sonnet = { model: 'claude-sonnet-5-5', requests: 1, inputTokens: 1200, outputTokens: 400, cacheReadTokens: 3000,
      cacheWriteTokens: 0 };

    it('records the AI use per model after reading and before completion', async () => {
      const { repository, reader, provider, reading } = mocks();
      const order: string[] = [];
      repository.recordAiUsage.mockImplementation(async (_held, usage) => { order.push(`usage:${usage.model}`); });
      repository.complete.mockImplementation(async () => { order.push('complete'); return 'id'; });
      await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
      expect(order).toEqual(['usage:claude-sonnet-5-5', 'usage:claude-opus-5-5', 'complete']);
      expect(repository.recordAiUsage).toHaveBeenCalledWith(job, sonnet);
      expect(repository.recordAiUsage).toHaveBeenCalledWith(job, { ...sonnet, model: 'claude-opus-5-5' });
    });

    it('logs the token counts per model with the pages sent, and nothing else', async () => {
      const { repository, reader, provider, reading } = mocks();
      await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
      const usage = logs().map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === 'ocr.reading.usage');
      expect(usage.map((line) => [line.pass, line.model])).toEqual([['first_pass', 'claude-sonnet-5-5'],
        ['reread', 'claude-opus-5-5']]);
      for (const line of usage) {
        expect(line).toMatchObject({ jobId: job.jobId, correlationId: job.correlationId, attempt: job.attemptNo,
          requests: 1, inputTokens: 1200, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 0 });
        expect(typeof line.pagesSent).toBe('number');
        expect(Object.keys(line).sort()).toEqual(['attempt', 'cacheReadTokens', 'cacheWriteTokens', 'correlationId',
          'event', 'inputTokens', 'jobId', 'level', 'model', 'outputTokens', 'pagesSent', 'pass', 'requests', 'timestamp'].sort());
      }
    });

    it('completes the job when recording the use fails, logging only a safe code', async () => {
      const { repository, reader, provider, reading } = mocks();
      repository.recordAiUsage.mockRejectedValue(Object.assign(new Error(`${SECRET_NAME} database detail`), { code: '42883' }));
      await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
      expect(repository.complete).toHaveBeenCalledTimes(1);
      expect(repository.fail).not.toHaveBeenCalled();
      const failed = logs().map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.event === 'ocr.reading.usage_record_failed');
      expect(failed).toEqual([
        { timestamp: expect.any(String), level: 'error', event: 'ocr.reading.usage_record_failed', jobId: 'job-id',
          correlationId: 'correlation-id', model: 'claude-sonnet-5-5', code: '42883' },
        expect.objectContaining({ model: 'claude-opus-5-5', code: '42883' })]);
      expect(logs().join('\n')).not.toContain('database detail');
    });

    it('records what an attempt used before retrying it with AI_UNAVAILABLE, and nothing with AI off', async () => {
      const pageClient = { readPage: jest.fn()
        .mockResolvedValueOnce({ kind: 'answer', answer, attempts: 1, servedInferenceGeo: 'us',
          usage: { inputTokens: 1200, outputTokens: 400, cacheReadInputTokens: 3000, cacheCreationInputTokens: 0 } })
        .mockRejectedValue(new AiTransientError('AI_HTTP_529')) };
      const { repository, reader, provider, reading } = mocks(pageClient);
      provider.extract.mockResolvedValue({ ...textReading, pageCount: 2,
        pages: [page, readPage(2, ['Second page line'])] });
      await new OcrWorker(config, repository, reader, provider, reading).processOne({ ...job, attemptNo: 1 });
      expect(repository.recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ attemptNo: 1 }), sonnet);
      expect(repository.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'AI_UNAVAILABLE' }));

      const off = mocks();
      await new OcrWorker(config, off.repository, off.reader, off.provider,
        new PaperReadingService({ ...readingConfig, OCR_AI_MODE: 'off' }, null)).processOne(job);
      expect(off.repository.recordAiUsage).not.toHaveBeenCalled();
    });

    it('records the requests of a final attempt whose every AI request failed, then completes with ai_failed', async () => {
      const pageClient = { readPage: jest.fn().mockRejectedValue(new AiTransientError('AI_HTTP_529', 5)) };
      const { repository, reader, provider, reading } = mocks(pageClient);
      await new OcrWorker(config, repository, reader, provider, reading).processOne({ ...job, attemptNo: 3 });
      expect(repository.recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ attemptNo: 3 }),
        { model: 'claude-sonnet-5-5', requests: 5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          cacheWriteTokens: 0 });
      expect(completed(repository).structuredPayload).toMatchObject({ reading: { status: 'ai_failed' } });
    });

    it('records what the pages already read used when the worker shuts down mid-reading, then fails the job', async () => {
      const usage = { inputTokens: 1200, outputTokens: 400, cacheReadInputTokens: 3000, cacheCreationInputTokens: 0 };
      let worker: OcrWorker | undefined;
      const pageClient: PageModelClient = { readPage: jest.fn(async (request, signal) => {
        if (request.page === 1) return { kind: 'answer' as const, answer, attempts: 1, servedInferenceGeo: 'us', usage };
        worker!.stop(); // SIGTERM while page 2 is being read
        throw new AiInterruptedError(signal.reason, 1, { inputTokens: 50, outputTokens: 0, cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0 });
      }) };
      const { repository, reader, provider, reading } = mocks(pageClient);
      provider.extract.mockResolvedValue({ ...textReading, pageCount: 3,
        pages: [page, readPage(2, ['Second page line']), readPage(3, ['Third page line'])] });
      const order: string[] = [];
      repository.recordAiUsage.mockImplementation(async (_held, entry) => { order.push(`usage:${entry.model}`); });
      repository.fail.mockImplementation(async () => { order.push('fail'); });
      worker = new OcrWorker(config, repository, reader, provider, reading);
      await worker.processOne(job);
      expect(order).toEqual(['usage:claude-sonnet-5-5', 'fail']);
      expect(repository.recordAiUsage).toHaveBeenCalledWith(job, { model: 'claude-sonnet-5-5', requests: 2,
        inputTokens: 1250, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 0 });
      expect(repository.fail).toHaveBeenCalledWith(job, expect.objectContaining({ code: 'WORKER_SHUTDOWN' }));
      expect(repository.complete).not.toHaveBeenCalled();
    });

    it('records the use and keeps the safe failure when reading throws an unexpected error after asking the AI', async () => {
      const pageClient: PageModelClient = { readPage: jest.fn()
        .mockResolvedValueOnce({ kind: 'answer', answer, attempts: 1, servedInferenceGeo: 'us',
          usage: { inputTokens: 1200, outputTokens: 400, cacheReadInputTokens: 3000, cacheCreationInputTokens: 0 } })
        .mockRejectedValue(new Error(`${SECRET_NAME} unexpected`)) };
      const { repository, reader, provider, reading } = mocks(pageClient);
      provider.extract.mockResolvedValue({ ...textReading, pageCount: 2, pages: [page, readPage(2, ['Second page line'])] });
      await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
      expect(repository.recordAiUsage).toHaveBeenCalledWith(job, sonnet);
      expect(repository.fail).toHaveBeenCalledWith(job, expect.objectContaining({ code: 'WORKER_INTERNAL_ERROR' }));
      expect(logs().join('\n')).not.toContain(SECRET_NAME);
    });

    it('claims fairly with OCR_WORKER_MAX_INFLIGHT_PER_FACILITY', async () => {
      const { repository, reader, provider, reading } = mocks();
      const worker = new OcrWorker({ ...config, OCR_WORKER_MAX_INFLIGHT_PER_FACILITY: 3 }, repository, reader, provider,
        reading);
      repository.claim.mockImplementation(async () => { worker.stop(); return null; });
      await worker.run();
      expect(repository.claim).toHaveBeenCalledWith('test', 60, 3, expect.stringMatching(/^ocr-worker-/));
    });

    it('keeps renewing the lease while the job waits for a Claude API permit', async () => {
      jest.useFakeTimers();
      try {
        const limiter = new Semaphore(1);
        const pageClient: PageModelClient = { readPage: jest.fn((_request, signal) => limiter.run(async () => ({
          kind: 'answer' as const, answer, attempts: 1, servedInferenceGeo: 'us',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }), signal)) };
        const { repository, reader, provider, reading } = mocks(pageClient);
        repository.renew.mockResolvedValue(undefined);
        const held = await limiter.acquire(); // another job's request holds the only permit
        const processing = new OcrWorker(config, repository, reader, provider, reading).processOne(job);
        // The lease of 60 s is renewed every 20 s.
        await jest.advanceTimersByTimeAsync(61_000);
        expect(limiter.waiting).toBe(1);
        expect(repository.renew).toHaveBeenCalledTimes(3);
        expect(repository.complete).not.toHaveBeenCalled();
        held();
        await processing;
        expect(repository.complete).toHaveBeenCalledTimes(1);
        const renewals = repository.renew.mock.calls.length;
        await jest.advanceTimersByTimeAsync(60_000);
        expect(repository.renew).toHaveBeenCalledTimes(renewals);
      } finally { jest.useRealTimers(); }
    });
  });
});

describe('OcrWorker image re-read: the picture never reaches a log, an error or what is stored', () => {
  const picture = fixturePng(1240, 1754, 6_000);
  const base64 = Buffer.from(picture).toString('base64');
  /** Every 24-character run of the picture's base64 (overlapping), so no fragment of it can hide. */
  const chunks = Array.from({ length: Math.floor((base64.length - 24) / 8) }, (_, index) => base64.slice(index * 8, index * 8 + 24));
  const hard = readPage(1, [['Fictionalmab 437rng od', { handwritten: true, confidence: 0.5 }], SECRET_NOTE]);
  const hardText: TextReading = { ...textReading, pages: [hard] };
  const firstPass = modelPage([modelItem({ kind: 'note', asWritten: 'Fictionalmab 437rng od', lineIds: ['p1-l1'] })]);
  const fromPicture = modelPage([modelItem({ kind: 'medicine', asWritten: 'Fictionalmab 437mg od', lineIds: ['p1-l1'],
    name: 'Fictionalmab', strength: '437mg', frequency: 'od', status: 'current',
    box: { left: 0.12, top: 0.05, width: 0.3, height: 0.02 } })]);
  const used = { inputTokens: 6000, outputTokens: 400, cacheReadInputTokens: 3000, cacheCreationInputTokens: 0 };

  function setUp(rereadFails: boolean) {
    const images: string[] = [];
    const client: PageModelClient = { readPage: jest.fn(async (request) => {
      if (request.image) {
        images.push(request.image.base64);
        if (rereadFails) throw new AiTransientError('AI_HTTP_529', 1);
        return { kind: 'answer' as const, answer: fromPicture, attempts: 1, servedInferenceGeo: 'us', usage: used };
      }
      return { kind: 'answer' as const, answer: firstPass, attempts: 1, servedInferenceGeo: 'us', usage: used };
    }) };
    const parts = mocks(client);
    parts.reader.readExact.mockResolvedValue({ ...document, bytes: picture });
    parts.provider.extract.mockResolvedValue(hardText);
    const reading = new PaperReadingService({ ...readingConfig, OCR_AI_IMAGE_REREAD: 'on' }, client);
    return { ...parts, reading, images };
  }

  let written: string[];
  let consoleSpies: jest.SpyInstance[];
  beforeEach(() => {
    written = [];
    const capture = (chunk: unknown) => { written.push(String(chunk)); return true; };
    consoleSpies = [jest.spyOn(process.stdout, 'write').mockImplementation(capture),
      jest.spyOn(process.stderr, 'write').mockImplementation(capture),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => jest.spyOn(console, method)
        .mockImplementation((...args: unknown[]) => { written.push(args.map(String).join(' ')); }))];
  });
  afterEach(() => { for (const spy of consoleSpies) spy.mockRestore(); });

  it('sends the picture with the re-read, then keeps it out of logs, the payload, provenance and the usage records', async () => {
    const { repository, reader, provider, reading, images } = setUp(false);
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(images).toEqual([base64]);
    expect(repository.fail).not.toHaveBeenCalled();
    const result = completed(repository);
    const payload = result.structuredPayload as PaperReadingPayload;
    expect(payload.reading).toMatchObject({ imageRereadPages: [1], imageRereadSkipped: [] });
    // The Textract text says "437rng": the item is held to what was read in the picture, so the sentence shown is
    // the picture's, not a dose disagreement with the paper.
    expect(payload.items[0]).toMatchObject({ readBy: 'reread', confidence: 'check_carefully',
      checkReason: 'This was read from the picture of the page; check it against the paper.' });
    expect(payload.items[0]!.checkReasons).toContain('read_from_image');
    expect(payload.items[0]!.checkReasons).not.toContain('strength_mismatch');
    expect(result.provenance.reading).toMatchObject({ imageRereadPages: [1], imageRereadSkipped: [],
      imagePromptVersion: 'hid-paper-reading-image-prompt-4' });
    // Picture tokens count in the usage records as any other input.
    expect(repository.recordAiUsage).toHaveBeenCalledWith(job, expect.objectContaining({ model: 'claude-opus-5-5',
      requests: 1, inputTokens: 6000 }));
    const stored = JSON.stringify([result, repository.recordAiUsage.mock.calls, repository.recordPages.mock.calls]);
    const everything = [stored, ...written].join('\n');
    expect(written.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(everything).not.toContain(chunk);
    expect(written.join('\n')).toContain('"imageRereadPages":1');
  });

  it('keeps the picture out of logs and what is stored when the re-read with it fails', async () => {
    const { repository, reader, provider, reading, images } = setUp(true);
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(images).toEqual([base64]);
    const result = completed(repository);
    const everything = [JSON.stringify([result, repository.fail.mock.calls, repository.recordAiUsage.mock.calls]),
      ...written].join('\n');
    for (const chunk of chunks) expect(everything).not.toContain(chunk);
    expect((result.structuredPayload as PaperReadingPayload).reading.imageRereadPages).toEqual([]);
    expect((result.structuredPayload as PaperReadingPayload).reading.imageRereadFailedPages).toEqual([1]);
    expect(result.provenance.reading).toMatchObject({ imageRereadFailedPages: [1] });
    expect(written.join('\n')).toContain('"imageRereadFailedPages":1');
  });
});
