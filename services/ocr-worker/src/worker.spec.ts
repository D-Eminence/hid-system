import type { OcrWorkerConfig } from './config';
import { AiInterruptedError, AiTransientError, type PageModelClient } from './reading/claude.client';
import { paperReadingPayloadSchema, type PaperReadingPayload } from './reading/contract';
import { readingCountsSchema } from './reading/contract';
import { LIST_VERSION } from './reading/list-version';
import { PaperReadingService, type ReadingConfig, type ReadingOutcome } from './reading/reader';
import { fixturePng, modelItem, modelPage, readPage, syntheticJpeg, withRepeatedScan } from './reading/test-fixtures';
import { ZOOM_JPEG_MAX_SCANS } from './reading/zoom';
import { DocumentTooManyPagesFailure, SafeWorkerFailure, type ClaimedOcrJob, type CompletedExtraction,
  type DocumentReader, type TextReading, type WorkerOcrProvider, type WorkerRepository } from './types';
import { Semaphore } from './semaphore';
import { buildCompletion, OcrWorker, readingProvenanceExtras } from './worker';

const parseLines = (written: readonly string[]) => written.flatMap((line) => line.split('\n')).filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>);

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

  it('logs the reading settings in force at ready, the last resort\'s own window among them (settings only)', async () => {
    const { repository, reader, provider, reading } = mocks();
    repository.claim.mockResolvedValue(null);
    const worker = new OcrWorker({ ...config, OCR_AI_HARD_PAGE_DEADLINE_MS: 150_000, OCR_AI_LAST_RESORT_SECONDS: 90 },
      repository, reader, provider, reading);
    const running = worker.run();
    await new Promise((resolve) => { setImmediate(resolve); });
    worker.stop();
    await running;
    const ready = logs().map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === 'ocr.worker.ready')!;
    expect(ready).toMatchObject({ aiLastResortSeconds: 90, aiHardPageDeadlineMs: 150_000 });
  });

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
        promptVersion: 'hid-paper-reading-prompt-13', usage: { inputTokens: 2400, outputTokens: 800 } } });
    const provenance = JSON.stringify(result.provenance);
    for (const secret of [SECRET_NAME, SECRET_DRUG, SECRET_NOTE, 'Inventedcillin']) expect(provenance).not.toContain(secret);
    expect(JSON.stringify(result.structuredPayload)).not.toContain('Inventedcillin');
  });

  it('logs the dropped items by reason code on completion, keeps the map out of the payload, and stores it in provenance counts', async () => {
    const { repository, reader, provider, reading } = mocks();
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    const line = logs().find((entry) => entry.includes('ocr.job.completed'))!;
    const logged = JSON.parse(line) as { droppedUngrounded: number; droppedByReason: Record<string, number>; listVersion: string };
    expect(logged.droppedByReason).toEqual({ text_not_on_line: 1 });
    expect(Object.values(logged.droppedByReason).reduce((sum, count) => sum + count, 0)).toBe(logged.droppedUngrounded);
    expect(line).not.toContain('Inventedcillin');
    expect(logged.listVersion).toBe(LIST_VERSION);
    const result = completed(repository);
    expect(JSON.stringify(result.structuredPayload)).not.toContain('droppedByReason');
    // Phase 1 "measure, content-free": the same counts are stored in provenance.reading.counts.
    const stored = result.provenance.reading as Record<string, unknown>;
    expect(stored.listVersion).toBe(LIST_VERSION);
    expect(stored.listVersion).toMatch(/^[0-9a-f]{16}$/);
    const counts = readingCountsSchema.parse(stored.counts);
    expect(counts).toEqual({ version: 1, droppedByReason: logged.droppedByReason,
      droppedByReasonFirstPass: { text_not_on_line: 1 },
      hardPageAgreement: { fieldsCompared: 0, fieldsAgreed: 0, itemsPaired: 0, itemsSingle: 0, drugSplits: 0,
        alternativesDropped: 0 },
      zoomCalls: 0, zoomLimited: 0, zoomFailed: 0, hardPageDeadlineHits: 0, hardReadFailures: {} });
    expect(parseLines(logs()).filter((entry) => entry.event === 'ocr.reading.provenance_field_omitted')).toEqual([]);
    const provenance = JSON.stringify(result.provenance);
    for (const secret of [SECRET_NAME, SECRET_DRUG, SECRET_NOTE, 'Fictionalmab', 'Inventedcillin', 'Zebulon',
      'Ultramarine', 'TEST-9907']) expect(provenance).not.toContain(secret);
  });

  it('completes the job without counts, and logs a code, when the counts cannot be computed or are not in shape', async () => {
    for (const [breakSummary, code] of [
      [(summary: ReadingOutcome['summary']) => { summary.droppedByReason = { 'Fictionalmab 437mg': 1 }; }, 'READING_COUNTS_INVALID'],
      [(summary: ReadingOutcome['summary']) => { summary.zoomCalls = -1; }, 'READING_COUNTS_INVALID'],
      [(summary: ReadingOutcome['summary']) => {
        // Only the counts read this map (the completion log does not): an error while copying it.
        summary.droppedByReasonFirstPass = new Proxy({}, { ownKeys: () => { throw new Error('Fictionalmab boom'); } });
      }, 'READING_COUNTS_FAILED'],
    ] as const) {
      stdout.mockClear();
      const { repository, reader, provider, reading } = mocks();
      const read = reading.read.bind(reading);
      jest.spyOn(reading, 'read').mockImplementation(async (...args) => {
        const outcome = await read(...args);
        breakSummary(outcome.summary);
        return outcome;
      });
      await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
      expect(repository.fail).not.toHaveBeenCalled();
      const result = completed(repository);
      const stored = result.provenance.reading as Record<string, unknown>;
      expect(stored).not.toHaveProperty('counts');
      expect(stored.listVersion).toBe(LIST_VERSION);
      expect(stored.promptVersion).toBe('hid-paper-reading-prompt-13');
      const omitted = parseLines(logs()).filter((entry) => entry.event === 'ocr.reading.provenance_field_omitted');
      expect(omitted.map((entry) => entry.code)).toEqual([code]);
      expect(parseLines(logs()).some((entry) => entry.event === 'ocr.job.completed')).toBe(true);
      expect(logs().join('\n')).not.toContain('Fictionalmab boom');
      expect(JSON.stringify(result.provenance)).not.toContain('Fictionalmab');
    }
  });

  it('leaves listVersion out when it could not be computed, and still completes', () => {
    const { summary, payload } = new PaperReadingService(readingConfig, { readPage: jest.fn() })
      .withoutItems({ facilityId: job.facilityId, sourceSha256Hex: job.sourceSha256Hex, pages: [page] }, 'ai_off');
    const extras = readingProvenanceExtras(summary, null);
    expect(extras).toMatchObject({ omitted: ['LIST_VERSION_UNAVAILABLE'] });
    expect(extras.counts).toBeDefined();
    const completion = buildCompletion(textReading, { summary, payload }, extras);
    expect(completion.provenance.reading).not.toHaveProperty('listVersion');
    expect(readingProvenanceExtras(summary, 'not-hex').omitted).toEqual(['LIST_VERSION_UNAVAILABLE']);
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

    it('logs the opaque document id (never its key, bucket or patient) on the claimed and completed lines', async () => {
      const { repository, reader, provider, reading } = mocks();
      const worker = new OcrWorker(config, repository, reader, provider, reading);
      let claims = 0;
      repository.claim.mockImplementation(async () => {
        claims += 1;
        if (claims === 1) return job;
        worker.stop();
        return null;
      });
      await worker.run();
      const lines = logs().map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const event of ['ocr.job.claimed', 'ocr.job.completed']) {
        const line = lines.find((entry) => entry.event === event)!;
        expect(line).toMatchObject({ jobId: job.jobId, documentId: job.documentId, correlationId: job.correlationId });
      }
      const text = logs().join('\n');
      for (const secret of [job.storageKey, job.storageBucket, job.objectVersionId, job.claimToken, job.facilityId]) {
        expect(text).not.toContain(secret);
      }
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

  const basis = { name: 'letters', dose: 'letters', unit: 'letters', route: 'empty', frequency: 'context',
    duration: 'empty', value: 'empty', other: 'empty' } as const;
  const bestGuess = modelPage([{ ...modelItem({ kind: 'medicine', asWritten: 'Pyrimethamine? 437 mg od', lineIds: ['p1-l1'],
    name: 'Pyrimethamine', strength: '437mg', frequency: 'od', status: 'new' }),
  box: { left: 0.12, top: 0.05, width: 0.3, height: 0.02 }, hard: { dose: '437', doseUnit: 'mg', basis } }]);

  function setUp(rereadFails: boolean, hardPages = false) {
    const images: string[] = [];
    const client: PageModelClient = { readPage: jest.fn(async (request) => {
      if (request.image && request.hardPage) {
        images.push(request.image.base64);
        return { kind: 'answer' as const, answer: bestGuess, attempts: 1, servedInferenceGeo: 'us', usage: used };
      }
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
    const reading = new PaperReadingService({ ...readingConfig, OCR_AI_IMAGE_REREAD: 'on',
      OCR_AI_HARD_PAGE_READS: hardPages ? 'on' : 'off' }, client);
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
      imagePromptVersion: 'hid-paper-reading-image-prompt-5' });
    // Picture tokens count in the usage records as any other input.
    expect(repository.recordAiUsage).toHaveBeenCalledWith(job, expect.objectContaining({ model: 'claude-opus-5-5',
      requests: 1, inputTokens: 6000 }));
    const stored = JSON.stringify([result, repository.recordAiUsage.mock.calls, repository.recordPages.mock.calls]);
    const everything = [stored, ...written].join('\n');
    expect(written.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(everything).not.toContain(chunk);
    expect(written.join('\n')).toContain('"imageRereadPages":1');
  });

  it('reads a hard page twice and logs only codes and counts: hard-page use, reads and agreement', async () => {
    const { repository, reader, provider, reading, images } = setUp(false, true);
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(images).toEqual([base64, base64]);
    const result = completed(repository);
    const payload = result.structuredPayload as PaperReadingPayload;
    expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
    const medicine = payload.items.find((item) => item.kind === 'medicine')!;
    // asWritten "Pyrimethamine? 437 mg od": the model's "?" on the name is shown; the frequency came from context.
    expect(medicine.fields).toMatchObject({ name: 'Pyrimethamine?', strength: '437mg' });
    expect(medicine.plain).toBe('Pyrimethamine? 437 mg od?');
    expect(medicine.checkReasons).toEqual(expect.arrayContaining(['best_guess_from_picture', 'field_from_context']));
    expect(result.provenance.reading).toMatchObject({ hardPages: [1], hardPageReads: 2, hardPageSingleReadPages: [],
      // Zoom off: the reads sent the version 7 hard-page text (version 8 without rule J), and provenance says so.
      hardPagePromptVersion: 'hid-paper-reading-hard-page-prompt-12-no-zoom', hardPageZoomPages: [], imagePromptVersion: null,
      promptVersion: 'hid-paper-reading-prompt-13' });
    const lines = written.flatMap((line) => line.split('\n')).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const usageLines = lines.filter((line) => line.event === 'ocr.reading.usage');
    // One line per hard-page read (read 1 and 2), in the pass's place; together they are the pass's use.
    expect(usageLines.map((line) => [line.pass, line.read, line.requests])).toEqual([['first_pass', undefined, 1],
      ['hard_page_read', 1, 1], ['hard_page_read', 2, 1]]);
    // Zoom off here: the hard-page usage lines still say how many crops were made (none), the first pass's does not.
    expect(usageLines.map((line) => line.zoomCalls)).toEqual([undefined, 0, 0]);
    for (const line of usageLines.slice(1)) {
      expect(line).toMatchObject({ page: 1, model: 'claude-opus-5-5', effort: 'high', followupEffort: null,
        endedBy: 'answer', outputTokensIncomplete: false, turns: 0, zoomLimited: 0, durationMs: expect.any(Number), inputTokens: expect.any(Number),
        outputTokens: expect.any(Number), cacheReadTokens: expect.any(Number), cacheWriteTokens: expect.any(Number) });
      // Numbers and codes only.
      for (const [key, value] of Object.entries(line)) {
        if (!['event', 'level', 'timestamp', 'jobId', 'correlationId', 'model', 'pass', 'effort', 'followupEffort',
          'forcedEffort', 'zoomClosed', 'endedBy', 'outputTokensIncomplete', 'failure', 'forcedAnswer'].includes(key)) {
          expect(typeof value).toBe('number');
        }
      expect(line).toMatchObject({ failure: null, forcedAnswer: null, forcedEffort: null, zoomClosed: null });
      }
    }
    const done = lines.find((line) => line.event === 'ocr.job.completed')!;
    expect(done).toMatchObject({ zoomCalls: 0, zoomLimited: 0, zoomFailed: 0, hardPageDeadlineHits: 0,
      hardPageReadsOutputIncomplete: 0, hardReadFailures: {}, hardReadForcedAnswers: {}, pageReadFailures: 0,
      firstPassItemCount: 1 });
    // Both reads answered on their own turns: no warn line.
    expect(lines.filter((line) => line.level === 'warn')).toEqual([]);
    expect(result.provenance.reading).toMatchObject({ hardPageDeadlinePages: [] });
    expect(done).toMatchObject({ hardPages: 1, hardPageReads: 2,
      hardPageAgreement: { itemsPaired: 1, itemsSingle: 0, fieldsCompared: expect.any(Number), fieldsAgreed: expect.any(Number) } });
    expect(Object.values(done.hardPageAgreement as Record<string, unknown>).every((value) => typeof value === 'number')).toBe(true);
    // The same counts are stored in provenance (contract.ts readingCountsSchema), equal to the logged ones.
    const counts = readingCountsSchema.parse((result.provenance.reading as Record<string, unknown>).counts);
    expect(counts.hardPageAgreement).toEqual(done.hardPageAgreement);
    expect(counts.hardPageAgreement.itemsPaired).toBe(1);
    expect(counts).toMatchObject({ zoomCalls: done.zoomCalls, zoomLimited: done.zoomLimited, zoomFailed: done.zoomFailed,
      hardPageDeadlineHits: done.hardPageDeadlineHits, hardReadFailures: done.hardReadFailures,
      droppedByReason: done.droppedByReason });
    expect(done.listVersion).toBe((result.provenance.reading as Record<string, unknown>).listVersion);
    const logs = written.join('\n');
    for (const secret of ['Pyrimethamine', 'Fictionalmab', 'Ultramarine', 'rng']) expect(logs).not.toContain(secret);
    expect(JSON.stringify(result.provenance)).not.toMatch(/Pyrimethamine|Fictionalmab|Ultramarine/);
    const everything = [JSON.stringify([result, repository.recordAiUsage.mock.calls]), ...written].join('\n');
    for (const chunk of chunks) expect(everything).not.toContain(chunk);
  });

  it('keeps the first pass when both hard reads fail, and logs a warn line per read and page: codes and counts only', async () => {
    // Job 566c38bf (README "A hard read always ends with an answer"): both reads ended without an answer and nothing
    // said so. Read 1 was sent the answer-only turn after a turn stopped at max_tokens and that turn was cut off too;
    // read 2 answered with text that was not JSON.
    let hardCalls = 0;
    const client: PageModelClient = { readPage: jest.fn(async (request) => {
      if (request.image && request.hardPage) {
        hardCalls += 1;
        if (hardCalls === 1) {
          // Its first turn and the answer-only turn (not a follow-up turn: it runs at low effort).
          request.trace!.turns += 2;
          request.trace!.forced = 'max_tokens';
          return { kind: 'failed' as const, reason: 'max_tokens' as const, code: 'max_tokens' as const, attempts: 2,
            usage: used };
        }
        request.trace!.turns += 1;
        return { kind: 'failed' as const, reason: 'malformed' as const, code: 'parse_error' as const, attempts: 1,
          usage: used };
      }
      return { kind: 'answer' as const, answer: firstPass, attempts: 1, servedInferenceGeo: 'us', usage: used };
    }) };
    const { repository, reader, provider } = mocks(client);
    reader.readExact.mockResolvedValue({ ...document, bytes: picture });
    provider.extract.mockResolvedValue(hardText);
    const reading = new PaperReadingService({ ...readingConfig, OCR_AI_IMAGE_REREAD: 'on', OCR_AI_HARD_PAGE_READS: 'on' },
      client);
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    const result = completed(repository);
    const payload = result.structuredPayload as PaperReadingPayload;
    expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
    // The first pass survives: its item, marked reread_failed; the page flagged ai_unsure; the payload names the page.
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ readBy: 'first_pass', confidence: 'check_carefully' });
    expect(payload.items[0]!.checkReasons).toContain('reread_failed');
    expect(payload.pages[0]!.flagReasons).toContain('ai_unsure');
    expect(payload.reading).toMatchObject({ imageRereadFailedPages: [1], itemCount: 1 });
    const lines = written.flatMap((line) => line.split('\n')).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const warns = lines.filter((line) => line.level === 'warn');
    expect(warns.map((line) => [line.event, line.read ?? null, line.reason])).toEqual([
      ['ocr.reading.hard_read_forced_answer', 1, 'forced_answer_max_tokens'],
      ['ocr.reading.hard_read_failed', 1, 'max_tokens'],
      ['ocr.reading.hard_read_failed', 2, 'parse_error'],
      ['ocr.reading.page_read_failed', null, 'hard_reads_failed']]);
    expect(warns[0]).toMatchObject({ answered: false, page: 1, turns: 2, requests: 2, outputTokens: 400, zoomCalls: 0 });
    expect(warns[1]).toMatchObject({ forcedAnswer: 'forced_answer_max_tokens', page: 1, turns: 2, outputTokens: 400 });
    expect(warns[2]).toMatchObject({ forcedAnswer: null, turns: 1, requests: 1 });
    expect(warns[3]).toMatchObject({ page: 1, pass: 'hard_page_read' });
    for (const line of warns) {
      for (const [key, value] of Object.entries(line)) {
        if (typeof value === 'string' && !['timestamp', 'jobId', 'correlationId'].includes(key)) {
          expect(value).toMatch(/^[a-z0-9_.]+$/);
        }
      }
    }
    const done = lines.find((line) => line.event === 'ocr.job.completed')!;
    expect(done).toMatchObject({ itemCount: 1, firstPassItemCount: 1, rereadFailedPages: 1, imageRereadFailedPages: 1,
      hardReadFailures: { max_tokens: 1, parse_error: 1 }, hardReadForcedAnswers: { forced_answer_max_tokens: 1 },
      pageReadFailures: 1 });
    expect(completed(repository).provenance.reading).toMatchObject({ rereadFailedPages: 1,
      counts: { hardReadFailures: { max_tokens: 1, parse_error: 1 }, hardPageDeadlineHits: 0 } });
    const usageLines = lines.filter((line) => line.event === 'ocr.reading.usage' && line.pass === 'hard_page_read');
    expect(usageLines.map((line) => [line.read, line.failure, line.forcedAnswer])).toEqual([
      [1, 'max_tokens', 'forced_answer_max_tokens'], [2, 'parse_error', null]]);
    expect(usageLines[0]).toMatchObject({ followupEffort: null, forcedEffort: 'low', zoomClosed: null });
    const logs = written.join('\n');
    for (const secret of ['Fictionalmab', 'rng', 'Pyrimethamine']) expect(logs).not.toContain(secret);
    for (const chunk of chunks) expect(logs).not.toContain(chunk);
  });

  describe('last resort (coordinator 2026-11-10, README "Last resort")', () => {
    /** Hard reads fail; the first pass kept nothing; the last resort (an ordinary image re-read) answers `last`. */
    function lastResortSetUp(last: 'answer' | 'refused') {
      const images: string[] = [];
      const efforts: string[] = [];
      const client: PageModelClient = { readPage: jest.fn(async (request) => {
        if (request.image && request.hardPage) {
          request.trace!.turns += 1;
          return { kind: 'failed' as const, reason: 'max_tokens' as const, code: 'max_tokens' as const, attempts: 1,
            usage: used };
        }
        if (request.image) {
          images.push(request.image.base64);
          efforts.push(request.effort);
          return last === 'answer'
            ? { kind: 'answer' as const, answer: fromPicture, attempts: 1, servedInferenceGeo: 'us', usage: used }
            : { kind: 'refused' as const, attempts: 1, usage: used };
        }
        return { kind: 'answer' as const, answer: modelPage([]), attempts: 1, servedInferenceGeo: 'us', usage: used };
      }) };
      const parts = mocks(client);
      parts.reader.readExact.mockResolvedValue({ ...document, bytes: picture });
      parts.provider.extract.mockResolvedValue(hardText);
      const reading = new PaperReadingService({ ...readingConfig, OCR_AI_IMAGE_REREAD: 'on', OCR_AI_HARD_PAGE_READS: 'on' },
        client);
      return { ...parts, reading, images, efforts };
    }
    const parsed = () => written.flatMap((line) => line.split('\n')).filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    it('reads the page from its picture once more and says so in provenance and the completion log, never its text',
      async () => {
        const { repository, reader, provider, reading, images, efforts } = lastResortSetUp('answer');
        await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
        expect(images).toEqual([base64]);
        expect(efforts).toEqual(['high']);
        const result = completed(repository);
        const payload = result.structuredPayload as PaperReadingPayload;
        expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
        expect(payload.items).toHaveLength(1);
        expect(payload.items[0]!.checkReasons).toEqual(expect.arrayContaining(['last_resort_read', 'read_from_image']));
        expect(payload.reading).toMatchObject({ itemCount: 1, imageRereadPages: [1], imageRereadFailedPages: [] });
        // The payload's reading gains no field (ocr-api reads it strictly); the last resort is in provenance.
        expect(Object.keys(payload.reading)).not.toEqual(expect.arrayContaining(['lastResortPages']));
        expect(result.provenance.reading).toMatchObject({ lastResortPages: [1], lastResortFailedPages: [],
          lastResortSkipped: [], imagePromptVersion: 'hid-paper-reading-image-prompt-5' });
        const lines = parsed();
        const done = lines.find((line) => line.event === 'ocr.job.completed')!;
        expect(done).toMatchObject({ itemCount: 1, firstPassItemCount: 0, lastResortReads: 1, lastResortFailed: 0,
          lastResortSkipped: 0, imageRereadFailedPages: 0 });
        expect(lines.filter((line) => line.event === 'ocr.reading.usage').map((line) => line.pass))
          .toEqual(['first_pass', 'hard_page_read', 'hard_page_read', 'last_resort_read']);
        const logs = written.join('\n');
        for (const secret of ['Fictionalmab', 'rng', SECRET_NOTE]) expect(logs).not.toContain(secret);
        const everything = [JSON.stringify([result.provenance, repository.recordAiUsage.mock.calls]), ...written].join('\n');
        for (const chunk of chunks) expect(everything).not.toContain(chunk);
      });

    it('logs a last_resort_failed warn with how it ended when the last resort gives nothing; the page stays named as failed',
      async () => {
        const { repository, reader, provider, reading } = lastResortSetUp('refused');
        await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
        const result = completed(repository);
        const payload = result.structuredPayload as PaperReadingPayload;
        expect(payload.items).toEqual([]);
        expect(payload.pages[0]!.flagReasons).toContain('ai_unsure');
        expect(payload.reading).toMatchObject({ itemCount: 0, imageRereadFailedPages: [1] });
        expect(result.provenance.reading).toMatchObject({ lastResortPages: [1], lastResortFailedPages: [1],
          imageRereadFailedPages: [1], rereadFailedPages: 1 });
        const lines = parsed();
        const pageWarns = lines.filter((line) => line.event === 'ocr.reading.page_read_failed');
        expect(pageWarns.map((line) => [line.pass, line.reason, line.detail ?? null])).toEqual([
          ['hard_page_read', 'hard_reads_failed', null], ['last_resort_read', 'last_resort_failed', 'refusal']]);
        expect(pageWarns[1]).toMatchObject({ level: 'warn', jobId: job.jobId, correlationId: job.correlationId, page: 1 });
        for (const line of pageWarns) {
          for (const [key, value] of Object.entries(line)) {
            if (typeof value === 'string' && !['timestamp', 'jobId', 'correlationId'].includes(key)) {
              expect(value).toMatch(/^[a-z0-9_.]+$/);
            }
          }
        }
        const done = lines.find((line) => line.event === 'ocr.job.completed')!;
        expect(done).toMatchObject({ lastResortReads: 1, lastResortFailed: 1, lastResortSkipped: 0, pageReadFailures: 2,
          itemCount: 0, firstPassItemCount: 0 });
      });
  });

  it('writes the hard-read warn lines even when the job then fails at completion', async () => {
    const client: PageModelClient = { readPage: jest.fn(async (request) => {
      if (request.image && request.hardPage) {
        request.trace!.turns += 1;
        return { kind: 'failed' as const, reason: 'malformed' as const, code: 'schema_error' as const, attempts: 1,
          usage: used };
      }
      return { kind: 'answer' as const, answer: firstPass, attempts: 1, servedInferenceGeo: 'us', usage: used };
    }) };
    const { repository, reader, provider } = mocks(client);
    reader.readExact.mockResolvedValue({ ...document, bytes: picture });
    provider.extract.mockResolvedValue(hardText);
    repository.complete.mockRejectedValueOnce(new Error('fictional database outage'));
    const reading = new PaperReadingService({ ...readingConfig, OCR_AI_IMAGE_REREAD: 'on', OCR_AI_HARD_PAGE_READS: 'on' },
      client);
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(repository.fail).toHaveBeenCalledTimes(1);
    const lines = written.flatMap((line) => line.split('\n')).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.level === 'warn').map((line) => [line.event, line.read ?? null, line.reason ?? null]))
      .toEqual([['ocr.reading.hard_read_failed', 1, 'schema_error'], ['ocr.reading.hard_read_failed', 2, 'schema_error'],
        ['ocr.reading.page_read_failed', null, 'hard_reads_failed'], ['ocr.job.failed', null, null]]);
    expect(lines.some((line) => line.event === 'ocr.job.completed')).toBe(false);
  });

  it('records the no-zoom hard-page prompt version when the picture fails zoom\'s header checks', async () => {
    // A synthetic JPEG with more scans than zoom decodes: the hard page is read, but never offered the tool.
    const synthetic = withRepeatedScan(syntheticJpeg(480, 640), ZOOM_JPEG_MAX_SCANS + 1);
    const offered: boolean[] = [];
    const client: PageModelClient = { readPage: jest.fn(async (request) => {
      if (request.image && request.hardPage) {
        offered.push(request.zoom !== undefined);
        return { kind: 'answer' as const, answer: bestGuess, attempts: 1, servedInferenceGeo: 'us', usage: used };
      }
      return { kind: 'answer' as const, answer: firstPass, attempts: 1, servedInferenceGeo: 'us', usage: used };
    }) };
    const { repository, reader, provider } = mocks(client);
    reader.readExact.mockResolvedValue({ ...document, mediaType: 'image/jpeg', bytes: synthetic });
    provider.extract.mockResolvedValue(hardText);
    const reading = new PaperReadingService({ ...readingConfig, OCR_AI_IMAGE_REREAD: 'on', OCR_AI_HARD_PAGE_READS: 'on',
      OCR_AI_HARD_PAGE_ZOOM: 'on', OCR_AI_ZOOM_MAX_CALLS: 4 }, client);
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(offered).toEqual([false, false]);
    expect(completed(repository).provenance.reading).toMatchObject({ hardPages: [1],
      hardPagePromptVersion: 'hid-paper-reading-hard-page-prompt-12-no-zoom', hardPageZoomPages: [] });
  });

  it('zooms in a hard page and logs only the counts: no crop in a log, the payload, provenance or the usage records', async () => {
    // A real, decodable, synthetic JPEG (no page of anyone's), so the zoom decodes and crops it.
    const synthetic = syntheticJpeg(480, 640);
    const crops: string[] = [];
    const client: PageModelClient = { readPage: jest.fn(async (request) => {
      if (request.image && request.hardPage) {
        for (const id of ['toolu_a', 'toolu_b', 'toolu_bad']) {
          const result = await request.zoom!.answer({ id, name: 'zoom', input: id === 'toolu_bad' ? { page: 1 }
            : { page: 1, box: { x: 20, y: 30, w: 120, h: 40 }, scale: 3 } });
          if (Array.isArray(result.content)) {
            for (const block of result.content) if (block.type === 'image' && block.source.type === 'base64') crops.push(block.source.data);
          }
        }
        return { kind: 'answer' as const, answer: bestGuess, attempts: 2, servedInferenceGeo: 'us', usage: used };
      }
      return { kind: 'answer' as const, answer: firstPass, attempts: 1, servedInferenceGeo: 'us', usage: used };
    }) };
    const { repository, reader, provider } = mocks(client);
    reader.readExact.mockResolvedValue({ ...document, mediaType: 'image/jpeg', bytes: synthetic });
    provider.extract.mockResolvedValue(hardText);
    const reading = new PaperReadingService({ ...readingConfig, OCR_AI_IMAGE_REREAD: 'on', OCR_AI_HARD_PAGE_READS: 'on',
      OCR_AI_HARD_PAGE_ZOOM: 'on', OCR_AI_ZOOM_MAX_CALLS: 4 }, client);
    await new OcrWorker(config, repository, reader, provider, reading).processOne(job);
    expect(crops).toHaveLength(4);
    const result = completed(repository);
    expect(result.provenance.reading).toMatchObject({ hardPages: [1],
      hardPagePromptVersion: 'hid-paper-reading-hard-page-prompt-12', hardPageZoomPages: [1] });
    const lines = written.flatMap((line) => line.split('\n')).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const hardUsage = lines.filter((line) => line.event === 'ocr.reading.usage' && line.pass === 'hard_page_read');
    expect(hardUsage).toEqual([expect.objectContaining({ read: 1, requests: 2, zoomCalls: 2, zoomLimited: 0 }),
      expect.objectContaining({ read: 2, requests: 2, zoomCalls: 2, zoomLimited: 0 })]);
    const done = lines.find((line) => line.event === 'ocr.job.completed')!;
    expect(done).toMatchObject({ zoomCalls: 4, zoomLimited: 0, zoomFailed: 2 });
    expect((result.provenance.reading as Record<string, unknown>).counts)
      .toMatchObject({ zoomCalls: 4, zoomLimited: 0, zoomFailed: 2 });
    const everything = [JSON.stringify([result, repository.recordAiUsage.mock.calls]), ...written].join('\n');
    const pictureBase64 = Buffer.from(synthetic).toString('base64');
    for (const crop of [...crops, pictureBase64]) {
      for (let at = 0; at + 24 <= Math.min(crop.length, 4_000); at += 200) expect(everything).not.toContain(crop.slice(at, at + 24));
    }
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
