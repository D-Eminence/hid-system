import { AiInterruptedError, AiRejectedError, AiTransientError, ClaudePageClient, type PageAnswer,
  type PageModelClient } from './claude.client';
import { Semaphore } from '../semaphore';
import { paperReadingPayloadSchema } from './contract';
import { PaperReadingService, ReadingInterruptedError, ReadingUnavailableError, type ReadingConfig } from './reader';
import { CLINIC_PAGE, fixtureExifSegment, fixtureJpeg, fixturePng, modelItem, modelPage, readPage, SOURCE_SHA,
  pngChunk, pngFromChunks, pngIhdr, syntheticJpeg, syntheticPng, withRepeatedScan } from './test-fixtures';
import { IMAGE_MAX_BASE64_LENGTH, imageTierOf, resizedSize } from './page-image';
import { hardPageMessage, type ModelPage } from './prompt';
import { ZOOM_JPEG_MAX_SCANS, ZOOM_MAX_CALLS } from './zoom';
import { liveZoomWorkers } from './zoom-jobs';

const FACILITY = '11111111-2222-4333-8444-555555555555';
const config: ReadingConfig = { OCR_AI_MODE: 'claude', OCR_AI_FACILITY_IDS: undefined,
  OCR_AI_FIRST_PASS_MODEL: 'claude-sonnet-5-5', OCR_AI_FIRST_PASS_EFFORT: 'medium',
  OCR_AI_REREAD_MODEL: 'claude-opus-5-5', OCR_AI_REREAD_EFFORT: 'high', OCR_AI_MAX_REREAD_PAGES: 20 };
const usage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const ok = (answer: ModelPage): PageAnswer => ({ kind: 'answer', answer, usage, attempts: 1, servedInferenceGeo: 'us' });
const refused: PageAnswer = { kind: 'refused', usage, attempts: 1 };

const clearPage = modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l2'],
  name: 'Hypertension', status: 'confirmed', plain: 'High blood pressure' })], { identity: {
  name: 'Test Patient Adaeze Example', dateOfBirth: '', folderNumber: 'TEST-0001', sex: '', lineIds: ['p1-l1'] } });

type Script = (request: { model: string; page: number; lines: readonly { text: string }[] }) => PageAnswer | Error;
function fakeClient(script: Script) {
  const calls: Array<{ model: string; page: number; texts: string[] }> = [];
  const client: PageModelClient = { readPage: jest.fn(async (request) => {
    calls.push({ model: request.model, page: request.page, texts: request.lines.map((line) => line.text) });
    const result = script(request);
    if (result instanceof Error) throw result;
    return result;
  }) };
  return { client, calls };
}

/** Every line cited (identity and a diagnosis), so the first pass flags nothing and no re-read follows. */
const CLEAN_PAGE = readPage(1, ['Name: Test Patient Adaeze Example  Folder: TEST-0001', 'Dx: Hypertension']);
const input = (pages = [CLINIC_PAGE]) => ({ facilityId: FACILITY, sourceSha256Hex: SOURCE_SHA, pages });
const signal = () => new AbortController().signal;

describe('PaperReadingService', () => {
  it('reads each page with the first-pass model and builds a payload that meets the contract', async () => {
    const { client, calls } = fakeClient(() => ok(clearPage));
    const { payload, summary } = await new PaperReadingService(config, client).read(input([CLEAN_PAGE]), signal());
    expect(calls.map((call) => call.model)).toEqual(['claude-sonnet-5-5']);
    expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
    expect(payload.reading).toMatchObject({ status: 'read', firstPassModel: 'claude-sonnet-5-5', rereadModel: null,
      rereadPages: [], itemCount: 1, promptVersion: 'hid-paper-reading-prompt-9' });
    expect(payload.identity).toMatchObject({ nameAsWritten: 'Test Patient Adaeze Example', folderNumberAsWritten: 'TEST-0001' });
    expect(payload.items[0]).toMatchObject({ kind: 'diagnosis', readBy: 'first_pass', confidence: 'clear' });
    expect(summary).toMatchObject({ requests: 1, inferenceGeo: 'us', servedInferenceGeo: 'us' });
  });

  it('keeps two different items read from the same words under unique ids in a valid payload', async () => {
    const span = { kind: 'medicine' as const, asWritten: 'Amlodipine 5mg od, Metformin 500mg bd', lineIds: ['p1-l3'],
      status: 'new' as const };
    const page = modelPage([modelItem({ ...span, name: 'Amlodipine', strength: '5mg', frequency: 'od' }),
      modelItem({ ...span, name: 'Metformin', strength: '500mg', frequency: 'bd' })]);
    const { client } = fakeClient(() => ok(page));
    const { payload } = await new PaperReadingService({ ...config, OCR_AI_MAX_REREAD_PAGES: 0 }, client)
      .read(input(), signal());
    expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
    expect(payload.items).toHaveLength(2);
    expect(payload.items[1]!.id).toBe(`${payload.items[0]!.id}-2`);
    expect(payload.items.every((item) => item.checkReasons.includes('duplicate_source_span'))).toBe(true);
    expect(payload.pages[0]!.flagReasons).toContain('possible_missed_item');
    expect(payload.reading.schemaVersion).toBe('hid-paper-reading-schema-2+hid-paper-reading-model-schema-2');
  });

  it('re-reads a page the first model declined with the re-read model', async () => {
    const { client, calls } = fakeClient((request) => request.model === 'claude-sonnet-5-5' ? refused : ok(clearPage));
    const { payload } = await new PaperReadingService(config, client).read(input(), signal());
    expect(calls.map((call) => call.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(payload.reading).toMatchObject({ status: 'read', rereadModel: 'claude-opus-5-5', rereadPages: [1] });
    expect(payload.items[0]!.readBy).toBe('reread');
  });

  it('marks the document ai_declined when both models decline, with the page flagged', async () => {
    const { client } = fakeClient(() => refused);
    const { payload } = await new PaperReadingService(config, client).read(input(), signal());
    expect(payload.reading.status).toBe('ai_declined');
    expect(payload.items).toEqual([]);
    expect(payload.pages[0]).toMatchObject({ flagged: true, flagReasons: expect.arrayContaining(['ai_declined']) });
    expect(paperReadingPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('re-reads flagged pages only, and merges the re-read with that page\'s first pass', async () => {
    const unsure = modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Malaria', lineIds: ['p2-l1'],
      name: 'Malaria', status: 'confirmed' })], { pageUnsure: true });
    const reread = modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Malaria', lineIds: ['p2-l1'],
      name: 'Malaria', status: 'suspected' })]);
    const page2 = readPage(2, ['Malaria ++']);
    const { client, calls } = fakeClient((request) => request.page === 1 ? ok(clearPage)
      : request.model === 'claude-opus-5-5' ? ok(reread) : ok(unsure));
    const { payload } = await new PaperReadingService(config, client).read(input([CLEAN_PAGE, page2]), signal());
    expect(calls.map((call) => [call.page, call.model])).toEqual([[1, 'claude-sonnet-5-5'], [2, 'claude-sonnet-5-5'],
      [2, 'claude-opus-5-5']]);
    expect(payload.reading.rereadPages).toEqual([2]);
    // The re-read reads Malaria as suspected where the first pass read it as confirmed: not an exact twin, so both
    // are kept, each marked for comparison, and the first pass's also as not found by the second reading.
    expect(payload.items.map((item) => [item.page, item.readBy, item.fields])).toEqual([
      [1, 'first_pass', { name: 'Hypertension', status: 'confirmed' }],
      [2, 'reread', { name: 'Malaria', status: 'suspected' }],
      [2, 'first_pass', { name: 'Malaria', status: 'confirmed' }]]);
    expect(payload.items[1]!.checkReasons).toContain('differs_from_second_reading');
    expect(payload.items[2]!.checkReasons).toEqual(expect.arrayContaining(['differs_from_second_reading',
      'not_in_second_reading']));
    // A re-read that reads the same item exactly replaces it.
    const same = fakeClient((request) => request.page === 1 ? ok(clearPage)
      : request.model === 'claude-opus-5-5' ? ok(modelPage(unsure.items)) : ok(unsure));
    const replaced = await new PaperReadingService(config, same.client).read(input([CLEAN_PAGE, page2]), signal());
    expect(replaced.payload.items.map((item) => [item.page, item.readBy])).toEqual([[1, 'first_pass'], [2, 'reread']]);
  });

  describe('a text re-read of a flagged page is merged with its first pass, never replacing it wholesale', () => {
    const page = readPage(1, [['Amlodipine 5mg od', { handwritten: true, confidence: 0.6 }], 'Dx: Hypertension']);
    const amlodipine = modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg od', lineIds: ['p1-l1'],
      name: 'Amlodipine', strength: '5mg', frequency: 'od', status: 'current' });
    const hypertension = modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l2'],
      name: 'Hypertension', status: 'confirmed' });
    const run = async (second: ModelPage, document?: { mediaType: string; bytes: Uint8Array },
      pages = [page], masked: 'send' | 'text_only' = 'send') => {
      const { client, calls } = fakeClient((request) => request.model === 'claude-sonnet-5-5'
        ? ok(modelPage([amlodipine, hypertension])) : ok(second));
      const outcome = await new PaperReadingService({ ...config, OCR_AI_IMAGE_REREAD: 'on',
        OCR_AI_IMAGE_MASKED_PAGES: masked }, client).read({
        facilityId: FACILITY, sourceSha256Hex: SOURCE_SHA, pages, ...(document ? { document } : {}) }, signal());
      return { ...outcome, calls };
    };

    it('keeps the item a PDF page\'s text re-read left out', async () => {
      const { payload, summary } = await run(modelPage([hypertension]),
        { mediaType: 'application/pdf', bytes: fixturePng(10, 10) });
      expect(summary).toMatchObject({ rereadPages: [1], imageRereadSkipped: [{ page: 1, reason: 'image_not_available_pdf' }] });
      expect(payload.items.map((item) => [item.readBy, item.asWritten])).toEqual([['first_pass', 'Amlodipine 5mg od'],
        ['reread', 'Hypertension']]);
      expect(payload.items[0]).toMatchObject({ confidence: 'check_carefully',
        checkReasons: expect.arrayContaining(['not_in_second_reading']) });
      expect(payload.items[0]!.checkReasons).not.toContain('not_in_picture_reading');
      expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
    });

    it('keeps it on the masked-number text fallback too', async () => {
      const masked = readPage(1, [['Amlodipine 5mg od', { handwritten: true, confidence: 0.6 }],
        'Dx: Hypertension tel 08030000000']);
      const { payload, summary } = await run(modelPage([hypertension]), { mediaType: 'image/png',
        bytes: fixturePng(1240, 1754) }, [masked], 'text_only');
      expect(summary.imageRereadSkipped).toEqual([{ page: 1, reason: 'image_has_masked_number' }]);
      expect(payload.items.map((item) => item.asWritten)).toEqual(['Amlodipine 5mg od', 'Hypertension']);
      expect(payload.items[0]!.checkReasons).toContain('not_in_second_reading');
    });

    it('counts a text re-read that keeps nothing as a failed re-read, and keeps the first pass', async () => {
      const { payload, summary } = await run(modelPage([modelItem({ kind: 'medicine', asWritten: 'Not on this page',
        lineIds: ['p1-l1'], name: 'Invented' })]));
      expect(summary).toMatchObject({ rereadPages: [], rereadFailedPages: 1, imageRereadFailedPages: [] });
      expect(payload.items.map((item) => [item.readBy, item.asWritten])).toEqual([['first_pass', 'Amlodipine 5mg od'],
        ['first_pass', 'Hypertension']]);
      expect(payload.items.every((item) => item.checkReasons.includes('reread_failed'))).toBe(true);
      expect(payload.pages[0]!.flagReasons).toContain('ai_unsure');
    });
  });

  it('keeps first-pass items as check_carefully with reread_failed when the re-read fails', async () => {
    const unsure = modelPage(clearPage.items, { pageUnsure: true });
    const { client } = fakeClient((request) => request.model === 'claude-opus-5-5' ? new AiTransientError('AI_HTTP_529')
      : ok(unsure));
    const { payload } = await new PaperReadingService(config, client).read(input(), signal());
    expect(payload.reading.status).toBe('read');
    expect(payload.items[0]).toMatchObject({ readBy: 'first_pass', confidence: 'check_carefully',
      checkReasons: ['reread_failed'] });
    expect(payload.pages[0]!.flagReasons).toEqual(expect.arrayContaining(['ai_unsure']));
  });

  it('caps re-reads per document', async () => {
    const unsure = modelPage([], { pageUnsure: true });
    const pages = [1, 2, 3].map((page) => readPage(page, [`Line on page ${page}`]));
    const { client, calls } = fakeClient(() => ok(unsure));
    await new PaperReadingService({ ...config, OCR_AI_MAX_REREAD_PAGES: 2 }, client).read(input(pages), signal());
    expect(calls.filter((call) => call.model === 'claude-opus-5-5').map((call) => call.page)).toEqual([1, 2]);
  });

  it('counts dropped ungrounded items without keeping their text', async () => {
    const invented = modelPage([modelItem({ kind: 'medicine', asWritten: 'Invented Drugname 900mg',
      lineIds: ['p1-l3'], name: 'Invented Drugname' })]);
    const { client } = fakeClient((request) => request.model === 'claude-opus-5-5' ? ok(clearPage) : ok(invented));
    const { payload, summary } = await new PaperReadingService(config, client).read(input(), signal());
    expect(summary.droppedUngroundedFirstPass).toBe(1);
    expect(payload.reading.rereadPages).toEqual([1]);
    expect(JSON.stringify(payload)).not.toContain('Invented Drugname');
    // By reason, codes only: the first pass's drop; the final (re-read) reading dropped nothing. Not in the payload.
    expect(summary.droppedByReasonFirstPass).toEqual({ text_not_on_line: 1 });
    expect(summary.droppedByReason).toEqual({});
    expect(summary.droppedUngrounded).toBe(0);
    expect(JSON.stringify(payload)).not.toContain('droppedByReason');
    // Where the re-read drops too, the final count is the re-read's, summed over pages.
    const both = fakeClient(() => ok(invented));
    const twice = await new PaperReadingService(config, both.client).read(input(), signal());
    expect(twice.summary.droppedByReason).toEqual({ text_not_on_line: 1 });
    expect(Object.values(twice.summary.droppedByReason).reduce((sum, count) => sum + count, 0))
      .toBe(twice.summary.droppedUngrounded);
  });

  it('masks NIN-like and phone numbers before sending, and restores them in what is stored', async () => {
    const page = readPage(1, ['NIN 12345678901 tel 08030000000', 'Dx: Hypertension']);
    const { client, calls } = fakeClient(() => ok(modelPage([modelItem({ kind: 'note',
      asWritten: 'NIN [hidden-number-2] tel [hidden-number-1]', lineIds: ['p1-l1'] })])));
    const { payload, summary } = await new PaperReadingService(config, client).read(input([page]), signal());
    expect(calls[0]!.texts[0]).toBe('NIN [hidden-number-2] tel [hidden-number-1]');
    expect(payload.items[0]!.asWritten).toBe('NIN 12345678901 tel 08030000000');
    expect(payload.pages[0]!.lines[0]!.text).toBe('NIN 12345678901 tel 08030000000');
    expect(summary.maskedNumbers).toBe(2);
  });

  it('returns ai_off when the mode is off or the facility is not allowed, and no_text without lines', async () => {
    const { client, calls } = fakeClient(() => ok(clearPage));
    const off = await new PaperReadingService({ ...config, OCR_AI_MODE: 'off' }, client).read(input(), signal());
    expect(off.payload.reading).toMatchObject({ status: 'ai_off', firstPassModel: null });
    expect(off.payload.pages[0]!.lines).toHaveLength(4);
    const elsewhere = await new PaperReadingService({ ...config,
      OCR_AI_FACILITY_IDS: ['99999999-2222-4333-8444-555555555555'] }, client).read(input(), signal());
    expect(elsewhere.payload.reading.status).toBe('ai_off');
    const allowed = await new PaperReadingService({ ...config, OCR_AI_FACILITY_IDS: [FACILITY] }, client)
      .read(input([CLEAN_PAGE]), signal());
    expect(allowed.payload.reading.status).toBe('read');
    const blank = await new PaperReadingService(config, client).read(input([{ page: 1, lines: [] }]), signal());
    expect(blank.payload.reading.status).toBe('no_text');
    expect(calls).toHaveLength(1);
    for (const outcome of [off, elsewhere, blank]) expect(paperReadingPayloadSchema.safeParse(outcome.payload).success).toBe(true);
  });

  it('completes as ai_failed (so manual entry works) when the API rejects the request', async () => {
    const { client } = fakeClient(() => new AiRejectedError('AI_NOT_AUTHENTICATED'));
    const { payload, summary } = await new PaperReadingService(config, client).read(input(), signal());
    expect(payload.reading.status).toBe('ai_failed');
    expect(payload.items).toEqual([]);
    expect(summary.failureCode).toBe('AI_NOT_AUTHENTICATED');
  });

  it('raises ReadingUnavailableError for a transient first-pass failure', async () => {
    const { client } = fakeClient(() => new AiTransientError('AI_HTTP_529'));
    await expect(new PaperReadingService(config, client).read(input(), signal()))
      .rejects.toBeInstanceOf(ReadingUnavailableError);
  });

  it('fails a page whose answer was cut off, re-reads it, and reports ai_failed if nothing was read', async () => {
    const { client } = fakeClient(() => ({ kind: 'failed', reason: 'max_tokens', usage, attempts: 1 }));
    const { payload } = await new PaperReadingService(config, client).read(input(), signal());
    expect(payload.reading.status).toBe('ai_failed');
    expect(payload.pages[0]!.flagReasons).toContain('ai_unsure');
  });

  describe('page concurrency and per-model use', () => {
    const page2 = readPage(2, ['Dx: Hypertension', 'BP 140/90']);
    const page3 = readPage(3, ['Dx: Hypertension']);
    const onPage = (page: number) => modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Hypertension',
      lineIds: [`p${page}-l${page === 1 ? 2 : 1}`], name: 'Hypertension', status: 'confirmed', plain: 'High blood pressure' })]);

    it('reads at most OCR_AI_PAGE_CONCURRENCY pages of one document at once, with the same result', async () => {
      let running = 0;
      let peak = 0;
      const client: PageModelClient = { readPage: jest.fn(async (request) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setImmediate(resolve));
        running -= 1;
        return ok(onPage(request.page));
      }) };
      const pages = [CLINIC_PAGE, page2, page3];
      const parallel = await new PaperReadingService({ ...config, OCR_AI_PAGE_CONCURRENCY: 2 }, client)
        .read(input(pages), signal());
      expect(peak).toBe(2);
      peak = 0;
      const serial = await new PaperReadingService(config, client).read(input(pages), signal());
      expect(peak).toBe(1);
      expect(parallel.payload).toEqual(serial.payload);
      expect(parallel.payload.items.map((item) => item.lineIds[0])).toEqual(['p1-l2', 'p2-l1', 'p3-l1']);
    });

    it('totals requests and tokens per model, first pass and re-read apart', async () => {
      const { client } = fakeClient((request) => request.model === 'claude-sonnet-5-5'
        ? ok(modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Not on this page', lineIds: ['p1-l2'] })]))
        : { kind: 'answer', answer: clearPage, attempts: 2, servedInferenceGeo: 'us',
          usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 7, cacheCreationInputTokens: 3 } });
      const { summary } = await new PaperReadingService(config, client).read(input(), signal());
      expect(summary.modelUsage).toEqual([
        { model: 'claude-sonnet-5-5', requests: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { model: 'claude-opus-5-5', requests: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3 },
      ]);
      expect(summary.requests).toBe(3);
    });

    it('carries the use of the pages already read on a transient failure and on a rejection', async () => {
      const transient = fakeClient((request) => request.page === 1 ? ok(clearPage) : new AiTransientError('AI_HTTP_529'));
      const error = await new PaperReadingService(config, transient.client).read(input([CLINIC_PAGE, page2]), signal())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ReadingUnavailableError);
      expect((error as ReadingUnavailableError).modelUsage).toEqual([{ model: 'claude-sonnet-5-5', requests: 1,
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
      const rejected = fakeClient((request) => request.page === 1 ? ok(clearPage) : new AiRejectedError('AI_BAD_REQUEST'));
      const outcome = await new PaperReadingService(config, rejected.client).read(input([CLINIC_PAGE, page2]), signal());
      expect(outcome.summary.status).toBe('ai_failed');
      expect(outcome.summary.modelUsage).toHaveLength(1);
    });

    it('counts the requests and tokens of calls that end in an error, not only of answers', async () => {
      const spent = { inputTokens: 30, outputTokens: 2, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 };
      // Every attempt overloaded: 5 requests, no answer.
      const down = fakeClient(() => new AiTransientError('AI_HTTP_529', 5));
      const error = await new PaperReadingService(config, down.client).read(input(), signal())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ReadingUnavailableError);
      expect((error as ReadingUnavailableError).modelUsage).toEqual([{ model: 'claude-sonnet-5-5', requests: 5,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
      // A rejection after a cut-off stream: its request and reported tokens count.
      const rejected = fakeClient(() => new AiRejectedError('AI_STREAM_ERROR', 1, spent));
      const outcome = await new PaperReadingService(config, rejected.client).read(input(), signal());
      expect(outcome.summary).toMatchObject({ status: 'ai_failed', modelUsage: [{ model: 'claude-sonnet-5-5',
        requests: 1, inputTokens: 30, outputTokens: 2, cacheReadTokens: 900, cacheWriteTokens: 0 }] });
      // A re-read that fails is swallowed, but its requests still count.
      const reread = fakeClient((request) => request.model === 'claude-sonnet-5-5' ? refused
        : new AiTransientError('AI_TIMEOUT', 3, spent));
      const { summary } = await new PaperReadingService(config, reread.client).read(input(), signal());
      expect(summary.requests).toBe(4);
      expect(summary.modelUsage).toEqual([
        { model: 'claude-sonnet-5-5', requests: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { model: 'claude-opus-5-5', requests: 3, inputTokens: 30, outputTokens: 2, cacheReadTokens: 900, cacheWriteTokens: 0 },
      ]);
      expect(summary.usage).toEqual({ inputTokens: 130, outputTokens: 52, cacheReadInputTokens: 900,
        cacheCreationInputTokens: 0 });
    });

    it('keeps what was used when reading is interrupted by shutdown, and rethrows the shutdown reason as cause', async () => {
      const reason = new Error('worker shutdown');
      const page3 = readPage(3, ['Third page line']);
      const { client, calls } = fakeClient((request) => request.page === 1 ? ok(clearPage)
        : new AiInterruptedError(reason, 1, { inputTokens: 7, outputTokens: 0, cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0 }));
      const error = await new PaperReadingService(config, client).read(input([CLINIC_PAGE, page2, page3]), signal())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ReadingInterruptedError);
      expect((error as ReadingInterruptedError).cause).toBe(reason);
      expect((error as ReadingInterruptedError).modelUsage).toEqual([{ model: 'claude-sonnet-5-5', requests: 2,
        inputTokens: 107, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
      // No page starts after the interruption.
      expect(calls.map((call) => call.page)).toEqual([1, 2]);
      // The same during the re-read pass.
      const during = fakeClient((request) => request.model === 'claude-sonnet-5-5' ? refused
        : new AiInterruptedError(reason, 0, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0 }));
      const rereadError = await new PaperReadingService(config, during.client).read(input(), signal())
        .catch((caught: unknown) => caught);
      expect(rereadError).toBeInstanceOf(ReadingInterruptedError);
      expect((rereadError as ReadingInterruptedError).modelUsage).toEqual([{ model: 'claude-sonnet-5-5', requests: 1,
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
    });

    it('reports no model use when AI reading is off', async () => {
      const { client } = fakeClient(() => ok(clearPage));
      const { summary } = await new PaperReadingService({ ...config, OCR_AI_MODE: 'off' }, client).read(input(), signal());
      expect(summary.modelUsage).toEqual([]);
    });
  });

  describe('image re-read of flagged pages', () => {
    const imageConfig: ReadingConfig = { ...config, OCR_AI_IMAGE_REREAD: 'on' };
    const hardPage = readPage(1, [['Amlodipne 5rng od', { handwritten: true, confidence: 0.55 }], 'Dx: Hypertension']);
    // The first pass cites both lines; the hard handwritten line flags the page ('handwriting'), so it is re-read.
    const textAnswer = modelPage([modelItem({ kind: 'note', asWritten: 'Amlodipne 5rng od', lineIds: ['p1-l1'] }),
      modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l2'], name: 'Hypertension',
        status: 'confirmed' })]);
    const pictureAnswer = modelPage([
      modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg od', lineIds: ['p1-l1'], name: 'Amlodipine',
        strength: '5mg', frequency: 'od', status: 'current', box: { left: 0.12, top: 0.05, width: 0.3, height: 0.02 } }),
      modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l2'], name: 'Hypertension',
        status: 'confirmed', box: { left: 0.1, top: 0.6, width: 0.3, height: 0.02 } }),
    ]);
    const png = { mediaType: 'image/png', bytes: fixturePng(1240, 1754) };
    type Seen = { model: string; page: number; image: { mediaType: string; base64: string } | undefined };
    function pictureClient(rejectImage = false) {
      const seen: Seen[] = [];
      const client: PageModelClient = { readPage: jest.fn(async (request) => {
        seen.push({ model: request.model, page: request.page, image: request.image });
        if (request.image && rejectImage) throw new AiRejectedError('AI_BAD_REQUEST', 1, undefined, true);
        if (request.model === 'claude-sonnet-5-5') return ok(textAnswer);
        return ok(request.image ? pictureAnswer : textAnswer);
      }) };
      return { client, seen };
    }
    const read = (reading: ReadingConfig, client: PageModelClient, pages: ReturnType<typeof readPage>[],
      document?: { mediaType: string; bytes: Uint8Array }) => new PaperReadingService(reading, client)
      .read({ facilityId: FACILITY, sourceSha256Hex: SOURCE_SHA, pages, ...(document ? { document } : {}) }, signal());

    it('splits the use by pass for the log, while the database records stay one per model', async () => {
      const sameModel: ReadingConfig = { ...imageConfig, OCR_AI_FIRST_PASS_MODEL: 'claude-opus-5-5' };
      const textClient = (): PageModelClient => ({ readPage: jest.fn(async (request) =>
        ok(request.image ? pictureAnswer : textAnswer)) });
      const pictured = await read(sameModel, textClient(), [hardPage], png);
      expect(pictured.summary.modelUsage.map((entry) => [entry.model, entry.requests])).toEqual([['claude-opus-5-5', 2]]);
      expect(pictured.summary.passUsage.map((entry) => [entry.pass, entry.model, entry.requests])).toEqual([
        ['first_pass', 'claude-opus-5-5', 1], ['image_reread', 'claude-opus-5-5', 1]]);
      const pdf = await read(sameModel, textClient(), [hardPage], { mediaType: 'application/pdf', bytes: png.bytes });
      expect(pdf.summary.passUsage.map((entry) => [entry.pass, entry.requests])).toEqual([['first_pass', 1],
        ['reread', 1]]);
      // Each per-pass token sum adds up to the per-model record.
      const total = (key: 'inputTokens' | 'outputTokens') =>
        pictured.summary.passUsage.reduce((sum, entry) => sum + entry[key], 0);
      expect(total('inputTokens')).toBe(pictured.summary.modelUsage[0]!.inputTokens);
      expect(total('outputTokens')).toBe(pictured.summary.modelUsage[0]!.outputTokens);
    });

    it('sends a flagged PNG or JPEG page with its picture: one re-read request only, with an image block, never on the first pass', async () => {
      for (const document of [png, { mediaType: 'image/jpeg', bytes: fixtureJpeg(1240, 1754) }]) {
        const { client, seen } = pictureClient();
        const { payload, summary } = await read(imageConfig, client, [hardPage], document);
        expect(seen.map((call) => [call.model, call.image !== undefined])).toEqual([['claude-sonnet-5-5', false],
          ['claude-opus-5-5', true]]);
        expect(seen[1]!.image).toEqual({ mediaType: document.mediaType,
          base64: Buffer.from(document.bytes).toString('base64'), width: 1240, height: 1754 });
        expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
        expect(summary.imageRereadPages).toEqual([1]);
        expect(summary.imageRereadSkipped).toEqual([]);
        expect(payload.reading).toMatchObject({ rereadPages: [1], imageRereadPages: [1], imageRereadSkipped: [] });
        // The item on its lines is kept, read from the picture; the one placed elsewhere is dropped and counted, and
        // the first pass's word-for-word "Hypertension", which no picture item covers, is kept for checking.
        // The first pass's note on line 1 is another kind than the medicine read there from the picture, so it is
        // not covered by it: both are kept.
        expect(payload.items.map((item) => [item.kind, item.readBy])).toEqual([['medicine', 'reread'],
          ['note', 'first_pass'], ['diagnosis', 'first_pass']]);
        expect(payload.items[0]).toMatchObject({ readBy: 'reread', confidence: 'check_carefully',
          asWritten: 'Amlodipine 5mg od', box: { left: 0.12, top: 0.05, width: 0.3, height: 0.02 } });
        expect(payload.items[0]!.checkReasons).toContain('read_from_image');
        expect(payload.items[2]).toMatchObject({ asWritten: 'Hypertension', confidence: 'check_carefully',
          checkReasons: ['not_in_picture_reading'],
          checkReason: 'The second reading, from the picture, did not find this; check it against the paper.' });
        expect(payload.items[1]!.checkReasons).toContain('not_in_picture_reading');
        // Every line is cited by a kept item, so the page is not flagged for a missed item.
        expect(payload.pages[0]!.flagReasons).not.toContain('possible_missed_item');
        expect(payload.reading.droppedUngrounded).toBe(1);
      }
    });

    it('sends the picture for a flagged legible printed page too, and re-reads the text instead when the setting is off', async () => {
      const seen: Seen[] = [];
      // An unsure page with clear printed lines is flagged ai_unsure: the owner's rule sends it with the picture.
      const unsure = modelPage(textAnswer.items.slice(1), { pageUnsure: true });
      const onPicture = modelPage([{ ...textAnswer.items[1]!, lineIds: ['p1-l1'],
        box: { left: 0.1, top: 0.05, width: 0.4, height: 0.02 } }]);
      const easyClient: PageModelClient = { readPage: jest.fn(async (request) => {
        seen.push({ model: request.model, page: request.page, image: request.image });
        return ok(request.model === 'claude-sonnet-5-5' ? unsure : onPicture);
      }) };
      const result = await read(imageConfig, easyClient, [readPage(1, ['Dx: Hypertension'])], png);
      expect(seen.map((call) => [call.model, call.image !== undefined])).toEqual([['claude-sonnet-5-5', false],
        ['claude-opus-5-5', true]]);
      expect(result.summary).toMatchObject({ rereadPages: [1], imageRereadPages: [1], imageRereadSkipped: [] });

      for (const reading of [{ ...config, OCR_AI_IMAGE_REREAD: 'off' as const }, config]) {
        const { client, seen: calls } = pictureClient();
        const { summary, payload } = await read(reading, client, [hardPage], png);
        // The flagged page still gets its second reading, from the text.
        expect(calls.map((call) => [call.model, call.image])).toEqual([['claude-sonnet-5-5', undefined],
          ['claude-opus-5-5', undefined]]);
        expect(summary).toMatchObject({ rereadPages: [1], imageRereadSkipped: [{ page: 1, reason: 'image_reread_off' }] });
        expect(payload.items.every((item) => !item.checkReasons.includes('read_from_image'))).toBe(true);
      }
    });

    it('sends the picture, and no text re-read, for a legible printed page flagged low_confidence by many items to check', async () => {
      const printed = readPage(1, ['Paracetamol 1g tds', 'Metformin 500mg bd']);
      // Both items disagree with their lines (a dose), so the page is flagged low_confidence although every line is
      // printed and above REVIEW_BELOW: a flagged page, so it goes with its picture. The answer has no boxes, so
      // nothing from the picture is kept: the image re-read is recorded as failed and the first pass stays.
      const shaky = modelPage([
        modelItem({ kind: 'medicine', asWritten: 'Paracetamol 1g tds', lineIds: ['p1-l1'], name: 'Paracetamol',
          strength: '500mg', frequency: 'tds', status: 'current' }),
        modelItem({ kind: 'medicine', asWritten: 'Metformin 500mg bd', lineIds: ['p1-l2'], name: 'Metformin',
          strength: '850mg', frequency: 'bd', status: 'current' })]);
      const seen: Seen[] = [];
      const client: PageModelClient = { readPage: jest.fn(async (request) => {
        seen.push({ model: request.model, page: request.page, image: request.image });
        return ok(shaky);
      }) };
      const { summary } = await read(imageConfig, client, [printed], png);
      expect(seen.map((call) => [call.model, call.image !== undefined])).toEqual([['claude-sonnet-5-5', false],
        ['claude-opus-5-5', true]]);
      expect(summary).toMatchObject({ rereadPages: [], imageRereadPages: [], imageRereadSkipped: [],
        imageRereadFailedPages: [1], rereadFailedPages: 1 });
    });

    it('sends the picture for a page with a printed line below REVIEW_BELOW', async () => {
      const faint = readPage(1, [['Amlodipine 5mg od', { confidence: 0.6 }], 'Dx: Hypertension']);
      const { client, seen } = pictureClient();
      const { summary } = await read(imageConfig, client, [faint], png);
      expect(seen.map((call) => call.image !== undefined)).toEqual([false, true]);
      expect(summary.imageRereadPages).toEqual([1]);
    });

    it('never sends PDF or TIFF pages, a page of a many-page document, a missing document or a picture over the limit', async () => {
      const cases: Array<[{ mediaType: string; bytes: Uint8Array } | undefined, string]> = [
        [{ mediaType: 'application/pdf', bytes: png.bytes }, 'image_not_available_pdf'],
        [{ mediaType: 'image/tiff', bytes: png.bytes }, 'image_not_available_tiff'],
        [undefined, 'image_not_given'],
        [{ mediaType: 'image/png', bytes: fixturePng(9000, 1200) }, 'image_too_large'],
        [{ mediaType: 'image/png', bytes: fixturePng(1000, 1000, IMAGE_MAX_BASE64_LENGTH) }, 'image_too_large'],
      ];
      for (const [document, reason] of cases) {
        const { client, seen } = pictureClient();
        const { summary, payload } = await read(imageConfig, client, [hardPage], document);
        expect(seen.map((call) => call.image)).toEqual([undefined, undefined]);
        expect(summary.imageRereadSkipped).toEqual([{ page: 1, reason }]);
        expect(paperReadingPayloadSchema.safeParse(payload).success).toBe(true);
      }
      const page2 = readPage(2, [['Metfornin 500rng bd', { handwritten: true, confidence: 0.5 }]]);
      const { client, seen } = pictureClient();
      const { summary } = await read(imageConfig, client, [hardPage, page2], { mediaType: 'application/pdf',
        bytes: png.bytes });
      expect(seen.filter((call) => call.image !== undefined)).toEqual([]);
      expect(summary.imageRereadSkipped).toEqual([{ page: 1, reason: 'image_not_available_pdf' },
        { page: 2, reason: 'image_not_available_pdf' }]);
    });

    it('gives an unflagged clean page no re-read, and a declined or failed page one text re-read, never the picture', async () => {
      const seen: Seen[] = [];
      const clear: PageModelClient = { readPage: jest.fn(async (request) => {
        seen.push({ model: request.model, page: request.page, image: request.image });
        return ok(modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l1'],
          name: 'Hypertension', status: 'confirmed' })]));
      }) };
      const unflagged = await read(imageConfig, clear, [readPage(1, ['Dx: Hypertension'])], png);
      expect(seen.map((call) => [call.model, call.image])).toEqual([['claude-sonnet-5-5', undefined]]);
      expect(unflagged.summary).toMatchObject({ rereadPages: [], imageRereadPages: [], imageRereadSkipped: [],
        imageRereadFailedPages: [] });

      const failed: PageAnswer = { kind: 'failed', reason: 'malformed', usage, attempts: 1 };
      for (const first of [refused, failed]) {
        seen.length = 0;
        const client: PageModelClient = { readPage: jest.fn(async (request) => {
          seen.push({ model: request.model, page: request.page, image: request.image });
          return request.model === 'claude-sonnet-5-5' ? first : ok(request.image ? pictureAnswer : textAnswer);
        }) };
        const { summary, payload } = await read(imageConfig, client, [hardPage], png);
        expect(seen.map((call) => [call.model, call.image !== undefined])).toEqual([['claude-sonnet-5-5', false],
          ['claude-opus-5-5', false]]);
        expect(summary).toMatchObject({ rereadPages: [1], imageRereadPages: [], imageRereadSkipped: [],
          imageRereadFailedPages: [] });
        expect(payload.items.map((item) => item.readBy)).toEqual(['reread', 'reread']);
      }
    });

    it('re-reads failed and declined pages first, then flagged pages in page order, up to the cap', async () => {
      const pages = [1, 2, 3, 4].map((page) => readPage(page, [`Dx: Hypertension ${page}`]));
      const seen: Seen[] = [];
      const client: PageModelClient = { readPage: jest.fn(async (request) => {
        seen.push({ model: request.model, page: request.page, image: request.image });
        if (request.model !== 'claude-sonnet-5-5') return ok(modelPage([]));
        // Page 1 flagged (unsure), page 2 clean, page 3 declined, page 4 failed.
        if (request.page === 3) return refused;
        if (request.page === 4) return { kind: 'failed', reason: 'max_tokens', usage, attempts: 1 } as PageAnswer;
        return ok(modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: [`p${request.page}-l1`],
          name: 'Hypertension', status: 'confirmed' })], { pageUnsure: request.page === 1 }));
      }) };
      const { summary } = await read({ ...imageConfig, OCR_AI_MAX_REREAD_PAGES: 2 }, client, pages, png);
      expect(seen.filter((call) => call.model === 'claude-opus-5-5').map((call) => call.page)).toEqual([3, 4]);
      seen.length = 0;
      const all = await read(imageConfig, client, pages, png);
      expect(seen.filter((call) => call.model === 'claude-opus-5-5').map((call) => call.page)).toEqual([3, 4, 1]);
      // Page 1 is flagged, but a page of a many-page document: its text re-read, saying why.
      expect(all.summary.imageRereadSkipped).toEqual([{ page: 1, reason: 'not_single_page' }]);
      expect(summary.rereadPages).toEqual([3, 4]);
    });

    it('sends a page whose text had a masked number as a picture by default (owner decision), and keeps it text-only when set to text_only', async () => {
      const masked = readPage(1, [['Amlodipne 5rng od', { handwritten: true, confidence: 0.55 }],
        'Dx: Hypertension tel 08030000000']);
      const answerFor = (image: boolean) => modelPage([
        modelItem({ kind: 'note', asWritten: image ? 'Amlodipine 5mg od' : 'Amlodipne 5rng od', lineIds: ['p1-l1'],
          ...(image ? { box: { left: 0.12, top: 0.05, width: 0.3, height: 0.02 } } : {}) }),
        modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l2'], name: 'Hypertension',
          status: 'confirmed', ...(image ? { box: { left: 0.1, top: 0.1, width: 0.3, height: 0.02 } } : {}) })]);
      const run = async (reading: ReadingConfig) => {
        const seen: Seen[] = [];
        const sentLines: string[] = [];
        const client: PageModelClient = { readPage: jest.fn(async (request) => {
          seen.push({ model: request.model, page: request.page, image: request.image });
          sentLines.push(...request.lines.map((line) => line.text));
          return ok(answerFor(request.image !== undefined));
        }) };
        return { seen, sentLines, ...(await read(reading, client, [masked], png)) };
      };
      for (const reading of [{ ...imageConfig, OCR_AI_IMAGE_MASKED_PAGES: 'text_only' as const }]) {
        const kept = await run(reading);
        expect(kept.seen.map((call) => call.image !== undefined)).toEqual([false, false]);
        expect(kept.summary).toMatchObject({ rereadPages: [1], imageRereadPages: [],
          imageRereadSkipped: [{ page: 1, reason: 'image_has_masked_number' }] });
        expect(paperReadingPayloadSchema.parse(kept.payload).reading.imageRereadSkipped)
          .toEqual([{ page: 1, reason: 'image_has_masked_number' }]);
      }
      for (const reading of [imageConfig, { ...imageConfig, OCR_AI_IMAGE_MASKED_PAGES: 'send' as const }]) {
        const sent = await run(reading);
        expect(sent.seen.map((call) => call.image !== undefined)).toEqual([false, true]);
        expect(sent.summary).toMatchObject({ imageRereadPages: [1], imageRereadSkipped: [] });
        // The text sent to the API stays masked: no request's lines carry the phone number.
        expect(sent.sentLines.length).toBeGreaterThan(0);
        expect(sent.sentLines.join('\n')).not.toContain('08030000000');
      }
    });

    it('does not send a JPEG turned by its EXIF orientation, and re-reads its text instead', async () => {
      const turned = { mediaType: 'image/jpeg', bytes: fixtureJpeg(1240, 1754, 3_000, fixtureExifSegment(6)) };
      const { client, seen } = pictureClient();
      const { summary } = await read(imageConfig, client, [hardPage], turned);
      expect(seen.map((call) => call.image !== undefined)).toEqual([false, false]);
      expect(summary.imageRereadSkipped).toEqual([{ page: 1, reason: 'image_orientation_unsupported' }]);
      const upright = { mediaType: 'image/jpeg', bytes: fixtureJpeg(1240, 1754, 3_000, fixtureExifSegment(1, 'II')) };
      const again = pictureClient();
      expect((await read(imageConfig, again.client, [hardPage], upright)).summary.imageRereadPages).toEqual([1]);
    });

    it('records an image re-read that gave no usable answer, keeps the first pass marked reread_failed, and sends no text re-read', async () => {
      const outcomes: Array<PageAnswer | Error> = [{ kind: 'failed', reason: 'max_tokens', usage, attempts: 1 },
        new AiTransientError('AI_HTTP_529', 5), new AiRejectedError('AI_NOT_PERMITTED', 1)];
      for (const outcome of outcomes) {
        const seen: Seen[] = [];
        const client: PageModelClient = { readPage: jest.fn(async (request) => {
          seen.push({ model: request.model, page: request.page, image: request.image });
          if (!request.image) return ok(textAnswer);
          if (outcome instanceof Error) throw outcome;
          return outcome;
        }) };
        const { summary, payload } = await read(imageConfig, client, [hardPage], png);
        expect(seen.map((call) => call.image !== undefined)).toEqual([false, true]);
        expect(summary).toMatchObject({ rereadPages: [], rereadFailedPages: 1, imageRereadPages: [],
          imageRereadSkipped: [], imageRereadFailedPages: [1] });
        expect(payload.reading.imageRereadFailedPages).toEqual([1]);
        expect(payload.items.every((item) => item.readBy === 'first_pass' && item.checkReasons.includes('reread_failed')))
          .toBe(true);
        expect(payload.pages[0]!.flagReasons).toContain('ai_unsure');
        expect(paperReadingPayloadSchema.safeParse(payload).success).toBe(true);
      }
    });

    it('re-reads the text instead when the API refuses the request with the picture as an invalid request (400)', async () => {
      const { client, seen } = pictureClient(true);
      const { summary, payload } = await read(imageConfig, client, [hardPage], png);
      expect(seen.map((call) => [call.model, call.image !== undefined])).toEqual([['claude-sonnet-5-5', false],
        ['claude-opus-5-5', true], ['claude-opus-5-5', false]]);
      expect(summary).toMatchObject({ rereadPages: [1], imageRereadPages: [], requests: 3,
        imageRereadSkipped: [{ page: 1, reason: 'image_rejected' }], imageRereadFailedPages: [] });
      expect(payload.items.every((item) => !item.checkReasons.includes('read_from_image'))).toBe(true);
    });

    it('re-reads the text once when the model declines the request with the picture (image_refused)', async () => {
      for (const textAfter of [ok(textAnswer), refused]) {
        const seen: Seen[] = [];
        const client: PageModelClient = { readPage: jest.fn(async (request) => {
          seen.push({ model: request.model, page: request.page, image: request.image });
          if (request.model === 'claude-sonnet-5-5') return ok(textAnswer);
          return request.image ? refused : textAfter;
        }) };
        const { summary, payload } = await read(imageConfig, client, [hardPage], png);
        expect(seen.map((call) => [call.model, call.image !== undefined])).toEqual([['claude-sonnet-5-5', false],
          ['claude-opus-5-5', true], ['claude-opus-5-5', false]]);
        expect(summary).toMatchObject({ imageRereadPages: [], imageRereadFailedPages: [],
          imageRereadSkipped: [{ page: 1, reason: 'image_refused' }] });
        if (textAfter.kind === 'answer') {
          expect(summary.rereadPages).toEqual([1]);
          expect(payload.items.every((item) => item.readBy === 'reread')).toBe(true);
        } else {
          expect(summary).toMatchObject({ rereadPages: [], rereadFailedPages: 1 });
          expect(payload.items.every((item) => item.checkReasons.includes('reread_failed'))).toBe(true);
        }
        expect(paperReadingPayloadSchema.safeParse(payload).success).toBe(true);
      }
    });

    it('falls back to the first pass, recorded, when nothing read from the picture holds to the page', async () => {
      const offPage = modelPage([modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg od', lineIds: ['p1-l1'],
        name: 'Amlodipine', strength: '5mg', status: 'current', box: { left: 0.1, top: 0.8, width: 0.3, height: 0.02 } })]);
      const { client, seen } = ((): { client: PageModelClient; seen: Seen[] } => {
        const calls: Seen[] = [];
        return { seen: calls, client: { readPage: jest.fn(async (request) => {
          calls.push({ model: request.model, page: request.page, image: request.image });
          return ok(request.image ? offPage : textAnswer);
        }) } };
      })();
      const { summary, payload } = await read(imageConfig, client, [hardPage], png);
      expect(seen.map((call) => call.image !== undefined)).toEqual([false, true]);
      expect(summary).toMatchObject({ rereadPages: [], rereadFailedPages: 1, imageRereadPages: [],
        imageRereadFailedPages: [1], droppedUngrounded: 0 });
      expect(payload.items.map((item) => [item.readBy, item.asWritten])).toEqual([['first_pass', 'Amlodipne 5rng od'],
        ['first_pass', 'Hypertension']]);
      expect(payload.items.every((item) => item.checkReasons.includes('reread_failed'))).toBe(true);
      // A page whose first pass had no items keeps the picture's result as it is, even with nothing kept.
      const empty = modelPage([], { pageUnsure: true });
      const none: PageModelClient = { readPage: jest.fn(async (request) => ok(request.image ? offPage : empty)) };
      const kept = await read(imageConfig, none, [hardPage], png);
      expect(kept.summary).toMatchObject({ rereadPages: [1], imageRereadPages: [1], imageRereadFailedPages: [],
        droppedUngrounded: 1 });
      expect(kept.payload.items).toEqual([]);
    });

    describe('merging a partial picture reading with the first pass', () => {
      const page = readPage(1, [['Amlodipine 5mg od, Metformin 500mg bd', { handwritten: true, confidence: 0.55 }],
        'Dx: Hypertension', ['Paracetamol 1g tds', { handwritten: true, confidence: 0.6 }]]);
      const medicine = (asWritten: string, name: string, line: number,
        box?: { left: number; top: number; width: number; height: number }) => modelItem({ kind: 'medicine',
        asWritten, lineIds: [`p1-l${line}`], name, status: 'current', ...(box ? { box } : {}) });
      const first = modelPage([medicine('Amlodipine 5mg od', 'Amlodipine', 1), medicine('Metformin 500mg bd', 'Metformin', 1),
        modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l2'], name: 'Hypertension',
          status: 'confirmed' }), medicine('Paracetamol 1g tds', 'Paracetamol', 3)]);
      const onLine1 = { left: 0.1, top: 0.05, width: 0.2, height: 0.02 };
      const run = async (picture: ModelPage) => {
        const client: PageModelClient = { readPage: jest.fn(async (request) => ok(request.image ? picture : first)) };
        return read(imageConfig, client, [page], png);
      };
      const shape = (items: readonly { lineIds: string[]; kind: string; readBy: string; asWritten: string }[]) =>
        items.map((item) => [item.lineIds[0], item.kind, item.readBy, item.asWritten]);

      it('keeps the medicine the picture did not read on a shared line, replaces same-name twins, keeps dropped ones', async () => {
        const { summary, payload } = await run(modelPage([
          medicine('Amlodipine 5mg od', 'Amlodipine', 1, onLine1),
          modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l2'], name: 'Hypertension',
            status: 'confirmed', box: { left: 0.1, top: 0.1, width: 0.3, height: 0.02 } }),
          // Line 3's item is placed off its line and dropped, so the first-pass medicine there stays.
          medicine('Paracetamol 1g tds', 'Paracetamol', 3, { left: 0.1, top: 0.8, width: 0.3, height: 0.02 })]));
        expect(summary).toMatchObject({ rereadPages: [1], imageRereadPages: [1], imageRereadFailedPages: [],
          droppedUngrounded: 1 });
        expect(shape(payload.items)).toEqual([
          ['p1-l1', 'medicine', 'reread', 'Amlodipine 5mg od'], ['p1-l1', 'medicine', 'first_pass', 'Metformin 500mg bd'],
          ['p1-l2', 'diagnosis', 'reread', 'Hypertension'], ['p1-l3', 'medicine', 'first_pass', 'Paracetamol 1g tds']]);
        for (const kept of [payload.items[1]!, payload.items[3]!]) {
          expect(kept.confidence).toBe('check_carefully');
          expect(kept.checkReasons).toContain('not_in_picture_reading');
        }
        expect(new Set(payload.items.map((item) => item.id)).size).toBe(4);
        expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
        const again = await run(modelPage([medicine('Amlodipine 5mg od', 'Amlodipine', 1, onLine1)]));
        expect(again.payload.items.filter((item) => item.readBy === 'first_pass').map((item) => item.asWritten))
          .toEqual(['Metformin 500mg bd', 'Hypertension', 'Paracetamol 1g tds']);
      });

      it('keeps both medicines when the picture reads only a note on their line', async () => {
        const { payload } = await run(modelPage([modelItem({ kind: 'note', asWritten: 'Amlodipine 5mg od',
          noteText: 'Amlodipine 5mg od', lineIds: ['p1-l1'], box: onLine1 })]));
        expect(shape(payload.items).slice(0, 3)).toEqual([['p1-l1', 'note', 'reread', 'Amlodipine 5mg od'],
          ['p1-l1', 'medicine', 'first_pass', 'Amlodipine 5mg od'], ['p1-l1', 'medicine', 'first_pass', 'Metformin 500mg bd']]);
        expect(payload.items).toHaveLength(5);
        expect(new Set(payload.items.map((item) => item.id)).size).toBe(5);
      });
    });

    it('re-reads the text, never the picture, when the re-read model has no known image tier', async () => {
      const { client, seen } = pictureClient();
      const { summary } = await read({ ...imageConfig, OCR_AI_REREAD_MODEL: 'claude-haiku-5-5' }, client, [hardPage], png);
      expect(seen.map((call) => [call.model, call.image !== undefined])).toEqual([['claude-sonnet-5-5', false],
        ['claude-haiku-5-5', false]]);
      expect(summary).toMatchObject({ rereadPages: [1], imageRereadPages: [],
        imageRereadSkipped: [{ page: 1, reason: 'image_tier_unknown' }] });
    });

    it('falls back to the text only for a 400 invalid_request_error, never after a 413, key, permission or model rejection', async () => {
      const rejecting = (error: AiRejectedError) => {
        const seen: Seen[] = [];
        const client: PageModelClient = { readPage: jest.fn(async (request) => {
          seen.push({ model: request.model, page: request.page, image: request.image });
          if (request.image) throw error;
          return ok(textAnswer);
        }) };
        return { client, seen };
      };
      const invalid = rejecting(new AiRejectedError('AI_BAD_REQUEST', 1, undefined, true));
      const fallback = await read(imageConfig, invalid.client, [hardPage], png);
      expect(invalid.seen.map((call) => call.image !== undefined)).toEqual([false, true, false]);
      expect(fallback.summary.imageRereadSkipped).toEqual([{ page: 1, reason: 'image_rejected' }]);
      for (const error of [new AiRejectedError('AI_BAD_REQUEST', 1), new AiRejectedError('AI_HTTP_413', 1),
        new AiRejectedError('IMAGE_TIER_UNKNOWN'),
        new AiRejectedError('AI_NOT_AUTHENTICATED', 1), new AiRejectedError('AI_NOT_PERMITTED', 1),
        new AiRejectedError('AI_MODEL_NOT_FOUND', 1)]) {
        const { client, seen } = rejecting(error);
        const { summary, payload } = await read(imageConfig, client, [hardPage], png);
        // One request with the picture, no second (doomed) text request, and the picture not blamed.
        expect(seen.map((call) => call.image !== undefined)).toEqual([false, true]);
        expect(summary).toMatchObject({ rereadPages: [], rereadFailedPages: 1, imageRereadPages: [],
          imageRereadSkipped: [], imageRereadFailedPages: [1] });
        expect(payload.items.every((item) => item.checkReasons.includes('reread_failed'))).toBe(true);
      }
    });

    it('writes empty image fields when the AI step does not run, and old payloads without them still read', async () => {
      const { client } = pictureClient();
      const off = await read({ ...imageConfig, OCR_AI_MODE: 'off' }, client, [hardPage], png);
      expect(off.payload.reading).toMatchObject({ imageRereadPages: [], imageRereadSkipped: [],
        imageRereadFailedPages: [] });
      const { imageRereadPages: _pages, imageRereadSkipped: _skipped, imageRereadFailedPages: _failed,
        ...older } = off.payload.reading;
      expect(paperReadingPayloadSchema.safeParse({ ...off.payload, reading: older }).success).toBe(true);
      expect(paperReadingPayloadSchema.safeParse({ ...off.payload, reading: { ...older,
        imageRereadSkipped: [{ page: 1, reason: 'made_up' }] } }).success).toBe(false);
    });
  });

  describe('hard pages: two best-guess readings from the picture (owner decision 2026-11-05)', () => {
    const hardConfig: ReadingConfig = { ...config, OCR_AI_IMAGE_REREAD: 'on', OCR_AI_HARD_PAGE_READS: 'on' };
    const png = { mediaType: 'image/png', bytes: fixturePng(1240, 1754) };
    // Fictional: a handwritten line the text service could barely read (flags the page 'handwriting').
    const hardPage = readPage(1, [['Pyrmthmn 25 rng od', { handwritten: true, confidence: 0.4 }], 'Dx: Hypertension']);
    const firstPass = modelPage([modelItem({ kind: 'note', asWritten: 'Pyrmthmn 25 rng od', lineIds: ['p1-l1'] }),
      modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l2'], name: 'Hypertension',
        status: 'confirmed' })]);
    const basis = { name: 'letters', dose: 'letters', unit: 'letters', route: 'empty', frequency: 'letters',
      duration: 'empty', value: 'empty', other: 'empty' } as const;
    const best = (name: string, dose = '25', nameBasis: 'letters' | 'context' = 'letters'): ModelPage => modelPage([
      { ...modelItem({ kind: 'medicine', asWritten: `${name}? ${dose} mg od`, lineIds: ['p1-l1'], name,
        strength: `${dose}mg`, frequency: 'od', status: 'new' }), box: { left: 0.12, top: 0.05, width: 0.3, height: 0.02 },
      hard: { dose, doseUnit: 'mg', basis: { ...basis, name: nameBasis } } }]);
    type Call = { model: string; effort: string; image: boolean; hardPage: boolean; texts: string[] };
    function hardClient(answers: (call: number) => PageAnswer | Error, first: PageAnswer = ok(firstPass)) {
      const calls: Call[] = [];
      let hardCalls = 0;
      const client: PageModelClient = { readPage: jest.fn(async (request) => {
        calls.push({ model: request.model, effort: request.effort, image: request.image !== undefined,
          hardPage: request.hardPage === true, texts: request.lines.map((line) => line.text) });
        if (request.model === 'claude-sonnet-5-5') return first;
        if (request.hardPage) {
          const result = answers(hardCalls++);
          if (result instanceof Error) throw result;
          return result;
        }
        return ok(firstPass);
      }) };
      return { client, calls };
    }
    const read = (reading: ReadingConfig, client: PageModelClient, pages = [hardPage],
      document: { mediaType: string; bytes: Uint8Array } | undefined = png) => new PaperReadingService(reading, client)
      .read({ facilityId: FACILITY, sourceSha256Hex: SOURCE_SHA, pages, ...(document ? { document } : {}) }, signal());

    it('sends a handwriting or low_confidence page the best-guess request twice, at max effort, with its picture', async () => {
      const { client, calls } = hardClient(() => ok(best('Pyrimethamine')));
      const { payload, summary } = await read(hardConfig, client);
      expect(calls.map((call) => [call.model, call.effort, call.image, call.hardPage])).toEqual([
        ['claude-sonnet-5-5', 'medium', false, false], ['claude-opus-5-5', 'max', true, true],
        ['claude-opus-5-5', 'max', true, true]]);
      expect(summary).toMatchObject({ hardPages: [1], hardPageReads: 2, hardPageSingleReadPages: [],
        hardPageAgreement: { itemsPaired: 1, itemsSingle: 0 }, imageRereadPages: [1], rereadPages: [1] });
      expect(summary.passUsage.map((entry) => [entry.pass, entry.requests])).toEqual([['first_pass', 1],
        ['hard_page_read', 2]]);
      const medicine = payload.items.find((item) => item.kind === 'medicine')!;
      expect(medicine).toMatchObject({ readBy: 'reread', confidence: 'check_carefully',
        // asWritten "Pyrimethamine? 25 mg od": the model's "?" on the name is carried into the name, and so shown.
        fields: { name: 'Pyrimethamine?', strength: '25mg', frequency: 'od' }, plain: 'Pyrimethamine? 25 mg od' });
      expect(medicine.checkReasons).toEqual(expect.arrayContaining(['best_guess_from_picture', 'read_from_image']));
      // mergeReread keeps the first pass's items the hard reading did not carry.
      expect(payload.items.filter((item) => item.readBy === 'first_pass').map((item) => item.asWritten))
        .toEqual(['Pyrmthmn 25 rng od', 'Hypertension']);
      expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
      expect(payload.reading.promptVersion).toBe('hid-paper-reading-prompt-9');
      // The configured effort is used when given; a printed page below REVIEW_BELOW (low_confidence) is hard too.
      const faint = readPage(1, [['Pyrmthmn 25 rng od', { confidence: 0.5 }], 'Dx: Hypertension']);
      const xhigh = hardClient(() => ok(best('Pyrimethamine')));
      await read({ ...hardConfig, OCR_AI_HARD_PAGE_EFFORT: 'xhigh' }, xhigh.client, [faint]);
      expect(xhigh.calls.slice(1).map((call) => [call.effort, call.hardPage])).toEqual([['xhigh', true], ['xhigh', true]]);
    });

    it('keeps the earlier image re-read for a page flagged only for another reason, and rule D everywhere else', async () => {
      // A legible printed page the first pass was unsure of: flagged ai_unsure only, not a hard page.
      const unsure = modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l1'],
        name: 'Hypertension', status: 'confirmed' })], { pageUnsure: true });
      const plain = hardClient(() => ok(best('Pyrimethamine')), ok(unsure));
      const result = await read(hardConfig, plain.client, [readPage(1, ['Dx: Hypertension'])]);
      expect(plain.calls.map((call) => [call.effort, call.image, call.hardPage])).toEqual([['medium', false, false],
        ['high', true, false]]);
      expect(result.summary).toMatchObject({ hardPages: [], hardPageReads: 0 });
      // A hard page that cannot go with its picture (a PDF) gets the text re-read, never the best guess.
      const pdf = hardClient(() => ok(best('Pyrimethamine')));
      const text = await read(hardConfig, pdf.client, [hardPage], { mediaType: 'application/pdf', bytes: png.bytes });
      expect(pdf.calls.map((call) => [call.image, call.hardPage])).toEqual([[false, false], [false, false]]);
      expect(text.summary).toMatchObject({ hardPages: [], imageRereadSkipped: [{ page: 1, reason: 'image_not_available_pdf' }] });
      // With the hard-page reads off (or not given), a hard page gets the earlier single image re-read.
      for (const reading of [{ ...hardConfig, OCR_AI_HARD_PAGE_READS: 'off' as const },
        { ...config, OCR_AI_IMAGE_REREAD: 'on' as const }]) {
        const off = hardClient(() => ok(best('Pyrimethamine')));
        const outcome = await read(reading, off.client);
        expect(off.calls.map((call) => [call.effort, call.image, call.hardPage])).toEqual([['medium', false, false],
          ['high', true, false]]);
        expect(outcome.summary.hardPages).toEqual([]);
      }
    });

    it('shows a disagreeing name and dose as "A? (or B?)", listed or not (owner decision 2026-11-06)', async () => {
      const { client } = hardClient((call) => ok(call === 0 ? best('Pyrimethamine') : best('Primaquine', '15')));
      const { payload, summary } = await read(hardConfig, client);
      const medicine = payload.items.find((item) => item.kind === 'medicine')!;
      // Primaquine is not on the list: shown as read, as the second option; nothing becomes "[?]" for disagreeing.
      expect(medicine.fields).toMatchObject({ name: 'Pyrimethamine? (or Primaquine?)', strength: '25mg? (or 15mg?)' });
      expect(medicine.plain).toBe('Pyrimethamine? (or Primaquine?) 25mg? (or 15mg?) od');
      expect(medicine).toMatchObject({ confidence: 'check_carefully' });
      expect(medicine.checkReasons).toContain('readings_disagree');
      expect(summary.hardPageAgreement.fieldsAgreed).toBeLessThan(summary.hardPageAgreement.fieldsCompared);
      const listed = hardClient((call) => ok(call === 0 ? best('Pyrimethamine') : best('Proguanil')));
      const both = await read(hardConfig, listed.client);
      expect(both.payload.items.find((item) => item.kind === 'medicine')!.fields)
        .toMatchObject({ name: 'Pyrimethamine? (or Proguanil?)', strength: '25mg' });
    });

    it('uses the other reading alone when one fails or declines, saying so on every item', async () => {
      for (const failure of [new AiTransientError('AI_HTTP_529', 2), refused,
        { kind: 'failed', reason: 'max_tokens', usage, attempts: 1 } as PageAnswer]) {
        const { client } = hardClient((call) => call === 0 ? failure : ok(best('Pyrimethamine')));
        const { payload, summary } = await read(hardConfig, client);
        expect(summary).toMatchObject({ hardPages: [1], hardPageSingleReadPages: [1], imageRereadPages: [1],
          imageRereadFailedPages: [] });
        const medicine = payload.items.find((item) => item.kind === 'medicine')!;
        expect(medicine.checkReasons).toEqual(expect.arrayContaining(['single_reading_only', 'best_guess_from_picture']));
      }
    });

    it('treats two failed reads as a failed image re-read, and two refusals or invalid requests as before', async () => {
      const failed = hardClient(() => new AiTransientError('AI_HTTP_529', 1));
      const outcome = await read(hardConfig, failed.client);
      expect(failed.calls.map((call) => call.hardPage)).toEqual([false, true, true]);
      expect(outcome.summary).toMatchObject({ imageRereadFailedPages: [1], rereadFailedPages: 1, hardPages: [1] });
      expect(outcome.payload.items.every((item) => item.readBy === 'first_pass'
        && item.checkReasons.includes('reread_failed'))).toBe(true);
      for (const [answer, reason] of [[refused, 'image_refused'],
        [new AiRejectedError('AI_BAD_REQUEST', 1, undefined, true), 'image_rejected']] as const) {
        const { client, calls } = hardClient(() => answer);
        const { summary } = await read(hardConfig, client);
        expect(calls.map((call) => [call.image, call.hardPage])).toEqual([[false, false], [true, true], [true, true],
          [false, false]]);
        expect(summary).toMatchObject({ imageRereadSkipped: [{ page: 1, reason }], rereadPages: [1] });
      }
      // One declined and the other refused as an invalid request: the picture is still the likely cause, so the
      // page goes to the text re-read (image_refused, since one read declined), not to a failed image re-read.
      const mixed = hardClient((call) => call === 0 ? refused : new AiRejectedError('AI_BAD_REQUEST', 1, undefined, true));
      const fallback = await read(hardConfig, mixed.client);
      expect(mixed.calls.map((call) => [call.image, call.hardPage])).toEqual([[false, false], [true, true], [true, true],
        [false, false]]);
      expect(fallback.summary).toMatchObject({ imageRereadSkipped: [{ page: 1, reason: 'image_refused' }],
        imageRereadFailedPages: [], rereadPages: [1] });
    });

    it('keeps the text masked, and the picture out of the payload and summary', async () => {
      const masked = readPage(1, [['Pyrmthmn 25 rng od', { handwritten: true, confidence: 0.4 }],
        'Dx: Hypertension tel 08030000000']);
      const { client, calls } = hardClient(() => ok(best('Pyrimethamine')));
      const { payload, summary } = await read(hardConfig, client, [masked]);
      expect(calls.flatMap((call) => call.texts).join('\n')).not.toContain('08030000000');
      expect(calls.filter((call) => call.hardPage)).toHaveLength(2);
      const base64 = Buffer.from(png.bytes).toString('base64');
      const stored = JSON.stringify([payload, summary]);
      for (let index = 0; index + 24 < base64.length; index += 64) expect(stored).not.toContain(base64.slice(index, index + 24));
      expect(payload.pages[0]!.lines[1]!.text).toBe('Dx: Hypertension tel 08030000000');
    });

    describe('hard-page time and cost bounds (coordinator 2026-11-10)', () => {
      const FAKE_KEY = 'sk-ant-test-0000000000000000000000';
      const clientConfig = { ANTHROPIC_API_KEY: FAKE_KEY, OCR_AI_MAX_TOKENS: 64_000, OCR_AI_TIMEOUT_MS: 30_000,
        OCR_AI_MAX_RETRIES: 0, OCR_AI_HARD_PAGE_MAX_TOKENS: 32_000 };
      /** A streamed answer, as the Claude API sends it (fictional text only). */
      const sse = (text: string, outputTokens = 300) => new Response([
        ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant',
          model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, stop_details: null,
          usage: { input_tokens: 6_000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            inference_geo: 'us' } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null,
          stop_details: null }, usage: { output_tokens: outputTokens } }],
        ['message_stop', { type: 'message_stop' }],
      ].map(([event, data]) => `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
      // The hard-page answer as the model writes it (the item best() gives): pixel boxes in the picture as the model
      // sees it, dose, unit, crossed-out writing and basis.
      const seen = resizedSize(1240, 1754, imageTierOf('claude-opus-5-5')!);
      const rawHard = JSON.stringify({ ...firstPass, items: [{ ...modelItem({ kind: 'medicine',
        asWritten: 'Pyrimethamine? 25 mg od', lineIds: ['p1-l1'], name: 'Pyrimethamine', strength: '25mg',
        frequency: 'od', status: 'new' }), box: { x1: 0.12 * seen.width, y1: 0.05 * seen.height, x2: 0.42 * seen.width,
        y2: 0.07 * seen.height }, dose: '25', doseUnit: 'mg', crossedOut: '', basis }] });
      const isHard = (init?: RequestInit) => String(init?.body).includes('"type":"image"');
      /** A fetch that never answers a hard-page request: it ends only when that request is aborted. */
      const hang = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const abort = init?.signal;
        if (abort?.aborted) { reject(abort.reason); return; }
        abort?.addEventListener('abort', () => reject(abort.reason), { once: true });
      });
      /** A hard-page answer that has begun (message_start, then some thinking) and then goes on until aborted. */
      const begunThenHang = (init?: RequestInit) => {
        const encoder = new TextEncoder();
        const event = (name: string, data: unknown) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(event('message_start', { type: 'message_start', message: { id: 'msg_cut', type: 'message',
            role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
            stop_details: null, usage: { input_tokens: 6_000, output_tokens: 1 } } }));
          controller.enqueue(event('content_block_start', { type: 'content_block_start', index: 0,
            content_block: { type: 'thinking', thinking: '', signature: '' } }));
          controller.enqueue(event('content_block_delta', { type: 'content_block_delta', index: 0,
            delta: { type: 'thinking_delta', thinking: 'x'.repeat(5_000) } }));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
        } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };

      it('starts both reads before either finishes, through the real client and request limit', async () => {
        for (const permits of [2, 1]) {
          let startedBeforeFirstFinished = 0;
          let started = 0;
          let open!: () => void;
          const gate = new Promise<void>((resolve) => { open = resolve; });
          const fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
            if (!isHard(init)) return sse(JSON.stringify(firstPass));
            started += 1;
            // Both reads in flight: let them answer. With one permit the second never starts, so open after a while.
            if (started === 2) open();
            const timer = setTimeout(open, 300);
            await gate;
            clearTimeout(timer);
            if (startedBeforeFirstFinished === 0) startedBeforeFirstFinished = started;
            return sse(rawHard);
          });
          const client = new ClaudePageClient(clientConfig, { fetch: fetch as unknown as typeof globalThis.fetch,
            limiter: new Semaphore(permits) });
          const { summary } = await read(hardConfig, client);
          // Two permits (the configured minimum when hard-page reads are on): both reads in flight at once. One
          // permit (refused by config since 2026-11-10) would make them take turns.
          expect(startedBeforeFirstFinished).toBe(permits === 2 ? 2 : 1);
          expect(summary).toMatchObject({ hardPages: [1], hardPageSingleReadPages: [], hardPageDeadlinePages: [] });
          expect(summary.hardPageReadUsage.map((entry) => [entry.read, entry.endedBy, entry.requests, entry.turns,
            entry.outputTokens])).toEqual([[1, 'answer', 1, 1, 300], [2, 'answer', 1, 1, 300]]);
        }
      });

      it('aborts the slower read at the deadline and uses the one that finished, without failing the job', async () => {
        let hardRequests = 0;
        const fetch = jest.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
          if (!isHard(init)) return sse(JSON.stringify(firstPass));
          // The first hard read answers at once; the second has begun its answer and never ends it.
          hardRequests += 1;
          return hardRequests === 1 ? sse(rawHard) : begunThenHang(init);
        });
        const client = new ClaudePageClient(clientConfig, { fetch: fetch as unknown as typeof globalThis.fetch,
          limiter: new Semaphore(4) });
        const started = Date.now();
        const { payload, summary } = await read({ ...hardConfig, OCR_AI_HARD_PAGE_DEADLINE_MS: 200 }, client);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(summary).toMatchObject({ status: 'read', hardPages: [1], hardPageSingleReadPages: [1],
          hardPageDeadlinePages: [1], imageRereadPages: [1], imageRereadFailedPages: [] });
        expect(summary.hardPageReadUsage.map((entry) => [entry.read, entry.endedBy, entry.requests])).toEqual([
          [1, 'answer', 1], [2, 'deadline', 1]]);
        expect(summary.hardPageReadUsage[1]!.durationMs).toBeGreaterThanOrEqual(150);
        // The cut read's thinking so far was never reported (1 output token from message_start): marked a lower bound.
        expect(summary.hardPageReadUsage.map((entry) => [entry.outputTokens, entry.outputTokensIncomplete])).toEqual([
          [300, false], [1, true]]);
        const medicine = payload.items.find((item) => item.kind === 'medicine')!;
        expect(medicine.checkReasons).toEqual(expect.arrayContaining(['single_reading_only', 'best_guess_from_picture']));
        expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
        // The cut read's request counts (it was sent), in the pass and in the per-read entry.
        expect(summary.passUsage.find((entry) => entry.pass === 'hard_page_read')).toMatchObject({ requests: 2 });
      });

      it('keeps the first reading (reread_failed) when neither read finishes, including one still waiting for a permit', async () => {
        const fetch = jest.fn(async (_url: unknown, init?: RequestInit) => isHard(init) ? hang(init)
          : sse(JSON.stringify(firstPass)));
        // Two permits, one held elsewhere the whole time: the first pass and then one read get the other; the
        // second read waits for a permit until the deadline ends the wait.
        const limiter = new Semaphore(2);
        const held = await limiter.acquire();
        try {
          const client = new ClaudePageClient(clientConfig, { fetch: fetch as unknown as typeof globalThis.fetch, limiter });
          const { payload, summary } = await read({ ...hardConfig, OCR_AI_HARD_PAGE_DEADLINE_MS: 150 }, client);
          expect(summary).toMatchObject({ status: 'read', hardPages: [1], hardPageDeadlinePages: [1],
            imageRereadFailedPages: [1], rereadFailedPages: 1, imageRereadPages: [], imageRereadSkipped: [] });
          expect(summary.hardPageReadUsage.map((entry) => [entry.read, entry.endedBy, entry.requests])).toEqual([
            [1, 'deadline', 1], [2, 'deadline', 0]]);
          expect(payload.items.length).toBeGreaterThan(0);
          expect(payload.items.every((item) => item.readBy === 'first_pass' && item.checkReasons.includes('reread_failed')))
            .toBe(true);
          expect(limiter.inFlight).toBe(1);
          expect(limiter.waiting).toBe(0);
        } finally { held(); }
      });

      it('ends a read stuck in its zoom loop at the deadline too, and a shutdown still stops the reading', async () => {
        // Fake client: read 1 answers; read 2 keeps zooming (each crop answered) until its signal is aborted.
        const zoomConfig: ReadingConfig = { ...hardConfig, OCR_AI_HARD_PAGE_ZOOM: 'on', OCR_AI_HARD_PAGE_DEADLINE_MS: 150 };
        const synthetic = { mediaType: 'image/png', bytes: syntheticPng(400, 560) };
        let hard = 0;
        const client: PageModelClient = { readPage: jest.fn(async (request, readSignal) => {
          if (!request.hardPage) return ok(firstPass);
          if (hard++ === 0) return ok(best('Pyrimethamine'));
          for (let call = 0; !readSignal.aborted; call += 1) {
            await request.zoom!.answer({ id: `toolu_${call}`, name: 'zoom', input: { page: 1,
              box: { x: 10, y: 10, w: 40, h: 20 }, scale: 2 } }, readSignal);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new AiInterruptedError(readSignal.reason, 3, usage);
        }) };
        const { summary } = await read(zoomConfig, client, [hardPage], synthetic);
        expect(summary).toMatchObject({ hardPageSingleReadPages: [1], hardPageDeadlinePages: [1] });
        expect(summary.hardPageReadUsage.map((entry) => [entry.endedBy, entry.requests])).toEqual([['answer', 1],
          ['deadline', 3]]);
        expect(liveZoomWorkers()).toBe(0);
        // The job's own abort (worker shutdown) during the reads is not a deadline: the reading stops as before.
        const controller = new AbortController();
        const reason = new Error('worker shutdown');
        const stopping: PageModelClient = { readPage: jest.fn(async (request, readSignal) => {
          if (!request.hardPage) return ok(firstPass);
          setTimeout(() => controller.abort(reason), 5);
          await new Promise((resolve) => readSignal.addEventListener('abort', resolve, { once: true }));
          throw new AiInterruptedError(readSignal.reason, 1, usage);
        }) };
        const error = await new PaperReadingService({ ...hardConfig, OCR_AI_HARD_PAGE_DEADLINE_MS: 60_000 }, stopping)
          .read({ facilityId: FACILITY, sourceSha256Hex: SOURCE_SHA, pages: [hardPage], document: png }, controller.signal)
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ReadingInterruptedError);
        expect((error as ReadingInterruptedError).cause).toBe(reason);
      });

      it('sends the follow-up effort with each read, and logs per read only numbers and codes', async () => {
        const { client } = hardClient(() => ok(best('Pyrimethamine')));
        const { summary } = await read({ ...hardConfig, OCR_AI_HARD_PAGE_FOLLOWUP_EFFORT: 'medium' }, client);
        const requests = (client.readPage as jest.Mock).mock.calls.map(([request]) => request as { hardPage?: boolean;
          followupEffort?: string; trace?: unknown; effort: string });
        expect(requests.filter((request) => request.hardPage).map((request) => [request.effort, request.followupEffort,
          request.trace])).toEqual([['max', 'medium', { turns: 0, followupTurns: 0, cutAttempts: 0 }],
          ['max', 'medium', { turns: 0, followupTurns: 0, cutAttempts: 0 }]]);
        // Not given: 'high' after a zoom result (the setting's default); the first pass gets none of it.
        const { client: defaults } = hardClient(() => ok(best('Pyrimethamine')));
        await read(hardConfig, defaults);
        const sent = (defaults.readPage as jest.Mock).mock.calls.map(([request]) => request as { followupEffort?: string });
        expect(sent.map((request) => request.followupEffort)).toEqual([undefined, 'high', 'high']);
        const kept = JSON.stringify(summary.hardPageReadUsage);
        for (const text of ['Pyrimethamine', 'Pyrmthmn', 'Hypertension']) expect(kept).not.toContain(text);
        for (const entry of summary.hardPageReadUsage) {
          for (const [key, value] of Object.entries(entry)) {
            if (['model', 'effort', 'followupEffort', 'endedBy'].includes(key)) {
              expect(value === null || /^[a-z0-9_-]+$/.test(String(value))).toBe(true);
            } else if (key === 'outputTokensIncomplete') expect(value).toBe(false);
            else expect(typeof value).toBe('number');
          }
        }
      });

      it('offers each read at most 4 zoom calls by default, and says 4 in rule J', async () => {
        const seen: Array<number | null> = [];
        let crops = 0;
        const client: PageModelClient = { readPage: jest.fn(async (request) => {
          if (!request.hardPage) return ok(firstPass);
          seen.push(request.zoom?.maxCalls ?? null);
          for (let call = 0; call < 6; call += 1) {
            const result = await request.zoom!.answer({ id: `toolu_${call}`, name: 'zoom', input: { page: 1,
              box: { x: 10, y: 10, w: 40, h: 20 }, scale: 2 } });
            if (Array.isArray(result.content)) crops += 1;
          }
          return ok(best('Pyrimethamine'));
        }) };
        const { summary } = await read({ ...hardConfig, OCR_AI_HARD_PAGE_ZOOM: 'on' }, client, [hardPage],
          { mediaType: 'image/png', bytes: syntheticPng(400, 560) });
        expect(seen).toEqual([4, 4]);
        expect(crops).toBe(8);
        expect(summary).toMatchObject({ zoomCalls: 8, zoomLimited: 4 });
        expect(summary.hardPageReadUsage.map((entry) => [entry.zoomCalls, entry.zoomLimited])).toEqual([[4, 2], [4, 2]]);
        // A configured 8 (no longer valid config) is still held to 4 here.
        const over = await read({ ...hardConfig, OCR_AI_HARD_PAGE_ZOOM: 'on', OCR_AI_ZOOM_MAX_CALLS: 8 }, client, [hardPage],
          { mediaType: 'image/png', bytes: syntheticPng(400, 560) });
        expect(over.summary.zoomCalls).toBe(8);
        expect(hardPageMessage(1, [], { width: 100, height: 100 }, ZOOM_MAX_CALLS)).toContain('You may zoom at most 4 times');
        expect(liveZoomWorkers()).toBe(0);
      }, 60_000);
    });

    describe('zoom in the hard-page reads (owner decision 2026-11-05, about 18:45 UTC)', () => {
      const zoomConfig: ReadingConfig = { ...hardConfig, OCR_AI_HARD_PAGE_ZOOM: 'on' };
      // Every zoom decode and crop runs in a worker thread of its own, ended with its job: none outlives a reading.
      afterEach(() => { expect(liveZoomWorkers()).toBe(0); });
      // A real, decodable, synthetic picture (no page of anyone's): the zoom decodes and crops it.
      const synthetic = { mediaType: 'image/png', bytes: syntheticPng(400, 560) };
      const zoomCall = (id: string) => ({ id, name: 'zoom', input: { page: 1, box: { x: 10, y: 10, w: 40, h: 20 }, scale: 2 } });
      /** A client whose hard reads each zoom `calls` times through the session they are given, then answer. */
      function zoomingClient(calls: number) {
        const seen: Array<{ hardPage: boolean; image: boolean; zoom: boolean; maxCalls: number | null }> = [];
        const crops: string[] = [];
        const client: PageModelClient = { readPage: jest.fn(async (request) => {
          seen.push({ hardPage: request.hardPage === true, image: request.image !== undefined,
            zoom: request.zoom !== undefined, maxCalls: request.zoom?.maxCalls ?? null });
          if (request.model === 'claude-sonnet-5-5') return ok(firstPass);
          if (request.zoom) {
            for (let index = 0; index < calls; index += 1) {
              const result = await request.zoom.answer(zoomCall(`toolu_${index}`));
              const image = Array.isArray(result.content) ? result.content.find((block) => block.type === 'image') : undefined;
              if (image && image.type === 'image' && image.source.type === 'base64') crops.push(image.source.data);
            }
          }
          return ok(best('Pyrimethamine'));
        }) };
        return { client, seen, crops };
      }

      it('gives both reads of a hard page the zoom, decoded once, and counts the crops per pass and in the summary', async () => {
        const { client, seen, crops } = zoomingClient(3);
        const { payload, summary } = await read({ ...zoomConfig, OCR_AI_ZOOM_MAX_CALLS: 2 }, client, [hardPage], synthetic);
        expect(seen).toEqual([{ hardPage: false, image: false, zoom: false, maxCalls: null },
          { hardPage: true, image: true, zoom: true, maxCalls: 2 }, { hardPage: true, image: true, zoom: true, maxCalls: 2 }]);
        // Two crops per read; the third call of each read is over the limit.
        expect(crops).toHaveLength(4);
        expect(summary).toMatchObject({ zoomCalls: 4, zoomLimited: 2, zoomFailed: 0, hardPages: [1], hardPageZoomPages: [1] });
        expect(summary.passUsage.map((entry) => [entry.pass, entry.zoomCalls])).toEqual([['first_pass', undefined],
          ['hard_page_read', 4]]);
        // No crop anywhere in what is kept or logged.
        const kept = JSON.stringify([payload, summary]);
        for (const crop of crops) expect(kept).not.toContain(crop.slice(40, 80));
      });

      it('answers "zoom unavailable" for a picture that cannot be decoded, and the reading goes on', async () => {
        const { client, crops } = zoomingClient(2);
        const { summary, payload } = await read(zoomConfig, client);
        expect(crops).toHaveLength(0);
        expect(summary).toMatchObject({ zoomCalls: 0, zoomLimited: 0, zoomFailed: 4, hardPages: [1], imageRereadPages: [1] });
        expect(payload.items.some((item) => item.kind === 'medicine')).toBe(true);
      });

      it('offers no zoom (no tool, no rule J) for a picture that fails the header checks, and reads it as before', async () => {
        const jpegPage = syntheticJpeg(400, 560);
        const refused = [
          // More scans than zoom lets jpeg-js decode (a small file that would stall the decoder).
          { mediaType: 'image/jpeg', bytes: withRepeatedScan(jpegPage, ZOOM_JPEG_MAX_SCANS + 1) },
          // Over the JPEG pixel limit by its header (the picture itself is still sent).
          { mediaType: 'image/jpeg', bytes: fixtureJpeg(4_000, 3_200) },
          // A 16-bit PNG (its chunks walk cleanly, so the picture is still sent).
          { mediaType: 'image/png', bytes: pngFromChunks(pngIhdr(40, 56, 16, 2), pngChunk('IDAT', [0]), pngChunk('IEND')) },
          // A PNG with a chunk zoom does not know (sent whole: only zoom checks the chunk types).
          { mediaType: 'image/png', bytes: pngFromChunks(pngIhdr(40, 56), pngChunk('prVt', [1]), pngChunk('IDAT', [0]),
            pngChunk('IEND')) },
        ];
        for (const picture of refused) {
          const { client, seen, crops } = zoomingClient(1);
          const { summary } = await read(zoomConfig, client, [hardPage], picture);
          expect(seen.filter((call) => call.hardPage)).toEqual([{ hardPage: true, image: true, zoom: false, maxCalls: null },
            { hardPage: true, image: true, zoom: false, maxCalls: null }]);
          expect(crops).toHaveLength(0);
          expect(summary).toMatchObject({ zoomCalls: 0, zoomLimited: 0, zoomFailed: 0, hardPages: [1], hardPageZoomPages: [] });
        }
        // The same JPEG at the scan limit is offered the tool and zoomed.
        const { client, seen, crops } = zoomingClient(1);
        const { summary } = await read(zoomConfig, client, [hardPage],
          { mediaType: 'image/jpeg', bytes: withRepeatedScan(jpegPage, ZOOM_JPEG_MAX_SCANS) });
        expect(seen.filter((call) => call.zoom)).toHaveLength(2);
        expect(crops).toHaveLength(2);
        expect(summary).toMatchObject({ zoomCalls: 2, hardPageZoomPages: [1] });
      });

      it('gives no zoom when it is off, at 0 calls, or to a page that is not a hard page', async () => {
        for (const reading of [hardConfig, { ...zoomConfig, OCR_AI_HARD_PAGE_ZOOM: 'off' as const },
          { ...zoomConfig, OCR_AI_ZOOM_MAX_CALLS: 0 }]) {
          const { client, seen } = zoomingClient(1);
          const { summary } = await read(reading, client, [hardPage], synthetic);
          expect(seen.every((call) => !call.zoom)).toBe(true);
          expect(summary).toMatchObject({ zoomCalls: 0, zoomLimited: 0, zoomFailed: 0, hardPages: [1], hardPageZoomPages: [] });
        }
        // Flagged, but not handwriting or low_confidence (possible_missed_item): the ordinary image re-read, no zoom.
        const missed = readPage(1, ['Dx: Hypertension', 'Amlodipine 5mg od']);
        const { client, seen } = zoomingClient(1);
        await read(zoomConfig, client, [missed], synthetic);
        expect(seen.filter((call) => call.image)).toHaveLength(1);
        expect(seen.filter((call) => call.image).every((call) => !call.zoom && !call.hardPage)).toBe(true);
      });
    });
  });
});
