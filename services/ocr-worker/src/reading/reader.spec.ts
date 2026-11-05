import { AiInterruptedError, AiRejectedError, AiTransientError, type PageAnswer, type PageModelClient } from './claude.client';
import { paperReadingPayloadSchema } from './contract';
import { PaperReadingService, ReadingInterruptedError, ReadingUnavailableError, type ReadingConfig } from './reader';
import { CLINIC_PAGE, fixtureJpeg, fixturePng, modelItem, modelPage, readPage, SOURCE_SHA } from './test-fixtures';
import { IMAGE_MAX_BASE64_LENGTH } from './page-image';
import type { ModelPage } from './prompt';

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

const input = (pages = [CLINIC_PAGE]) => ({ facilityId: FACILITY, sourceSha256Hex: SOURCE_SHA, pages });
const signal = () => new AbortController().signal;

describe('PaperReadingService', () => {
  it('reads each page with the first-pass model and builds a payload that meets the contract', async () => {
    const { client, calls } = fakeClient(() => ok(clearPage));
    const { payload, summary } = await new PaperReadingService(config, client).read(input(), signal());
    expect(calls.map((call) => call.model)).toEqual(['claude-sonnet-5-5']);
    expect(paperReadingPayloadSchema.parse(payload)).toBeTruthy();
    expect(payload.reading).toMatchObject({ status: 'read', firstPassModel: 'claude-sonnet-5-5', rereadModel: null,
      rereadPages: [], itemCount: 1, promptVersion: 'hid-paper-reading-prompt-2' });
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

  it('re-reads flagged pages only, and the re-read replaces that page\'s items', async () => {
    const unsure = modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Malaria', lineIds: ['p2-l1'],
      name: 'Malaria', status: 'confirmed' })], { pageUnsure: true });
    const reread = modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Malaria', lineIds: ['p2-l1'],
      name: 'Malaria', status: 'suspected' })]);
    const page2 = readPage(2, ['Malaria ++']);
    const { client, calls } = fakeClient((request) => request.page === 1 ? ok(clearPage)
      : request.model === 'claude-opus-5-5' ? ok(reread) : ok(unsure));
    const { payload } = await new PaperReadingService(config, client).read(input([CLINIC_PAGE, page2]), signal());
    expect(calls.map((call) => [call.page, call.model])).toEqual([[1, 'claude-sonnet-5-5'], [2, 'claude-sonnet-5-5'],
      [2, 'claude-opus-5-5']]);
    expect(payload.reading.rereadPages).toEqual([2]);
    expect(payload.items.map((item) => [item.page, item.readBy, item.fields])).toEqual([
      [1, 'first_pass', { name: 'Hypertension', status: 'confirmed' }],
      [2, 'reread', { name: 'Malaria', status: 'suspected' }]]);
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
      .read(input(), signal());
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

  describe('image re-read of hard pages', () => {
    const imageConfig: ReadingConfig = { ...config, OCR_AI_IMAGE_REREAD: 'on' };
    const hardPage = readPage(1, [['Amlodipne 5rng od', { handwritten: true, confidence: 0.55 }], 'Dx: Hypertension']);
    // The first pass cites the hard handwritten line, so the page is re-read as today (low_confidence_handwriting).
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
        if (request.image && rejectImage) throw new AiRejectedError('AI_BAD_REQUEST', 1);
        if (request.model === 'claude-sonnet-5-5') return ok(textAnswer);
        return ok(request.image ? pictureAnswer : textAnswer);
      }) };
      return { client, seen };
    }
    const read = (reading: ReadingConfig, client: PageModelClient, pages: ReturnType<typeof readPage>[],
      document?: { mediaType: string; bytes: Uint8Array }) => new PaperReadingService(reading, client)
      .read({ facilityId: FACILITY, sourceSha256Hex: SOURCE_SHA, pages, ...(document ? { document } : {}) }, signal());

    it('sends the picture only with the re-read of a hard PNG or JPEG page, never with the first pass', async () => {
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
        // The item on its lines is kept, read from the picture; the one placed elsewhere is dropped and counted.
        expect(payload.items).toHaveLength(1);
        expect(payload.items[0]).toMatchObject({ readBy: 'reread', confidence: 'check_carefully',
          asWritten: 'Amlodipine 5mg od', box: { left: 0.12, top: 0.05, width: 0.3, height: 0.02 } });
        expect(payload.items[0]!.checkReasons).toContain('read_from_image');
        expect(payload.reading.droppedUngrounded).toBe(1);
      }
    });

    it('re-reads from the text alone, saying why, when the page is not hard to read or the setting is off', async () => {
      const easy = { ...pictureClient() };
      // An unsure page with clear printed lines is re-read, but without the picture.
      const unsure = modelPage(textAnswer.items.slice(1), { pageUnsure: true });
      const easyClient: PageModelClient = { readPage: jest.fn(async (request) => {
        easy.seen.push({ model: request.model, page: request.page, image: request.image });
        return ok(request.model === 'claude-sonnet-5-5' ? unsure : modelPage(textAnswer.items.slice(1)));
      }) };
      const result = await read(imageConfig, easyClient, [readPage(1, ['Dx: Hypertension'])], png);
      expect(easy.seen.every((call) => call.image === undefined)).toBe(true);
      expect(result.summary).toMatchObject({ rereadPages: [1], imageRereadPages: [],
        imageRereadSkipped: [{ page: 1, reason: 'not_hard_to_read' }] });

      for (const reading of [{ ...config, OCR_AI_IMAGE_REREAD: 'off' as const }, config]) {
        const { client, seen } = pictureClient();
        const { summary, payload } = await read(reading, client, [hardPage], png);
        expect(seen.map((call) => call.image)).toEqual([undefined, undefined]);
        expect(summary.imageRereadSkipped).toEqual([{ page: 1, reason: 'image_reread_off' }]);
        expect(payload.items.every((item) => !item.checkReasons.includes('read_from_image'))).toBe(true);
      }
    });

    it('keeps a legible printed page text-only although many first-pass items need checking (its low_confidence flag)', async () => {
      const printed = readPage(1, ['Paracetamol 1g tds', 'Metformin 500mg bd']);
      // Both items disagree with their lines (a dose), so the page is re-read and flagged low_confidence; every line
      // is printed and above REVIEW_BELOW, so it is not hard to read.
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
        ['claude-opus-5-5', false]]);
      expect(summary).toMatchObject({ rereadPages: [1], imageRereadPages: [],
        imageRereadSkipped: [{ page: 1, reason: 'not_hard_to_read' }] });
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

    it('does not send the picture for an unflagged page, and sends it for a page the first model declined', async () => {
      const seen: Seen[] = [];
      const clear: PageModelClient = { readPage: jest.fn(async (request) => {
        seen.push({ model: request.model, page: request.page, image: request.image });
        return ok(modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l1'],
          name: 'Hypertension', status: 'confirmed' })]));
      }) };
      const unflagged = await read(imageConfig, clear, [readPage(1, ['Dx: Hypertension'])], png);
      expect(seen.map((call) => [call.model, call.image])).toEqual([['claude-sonnet-5-5', undefined]]);
      expect(unflagged.summary).toMatchObject({ rereadPages: [], imageRereadPages: [], imageRereadSkipped: [] });

      const declined: PageModelClient = { readPage: jest.fn(async (request) => {
        seen.push({ model: request.model, page: request.page, image: request.image });
        return request.model === 'claude-sonnet-5-5' ? refused : ok(request.image ? pictureAnswer : textAnswer);
      }) };
      seen.length = 0;
      const { summary } = await read(imageConfig, declined, [hardPage], png);
      expect(seen.map((call) => call.image !== undefined)).toEqual([false, true]);
      expect(summary.imageRereadPages).toEqual([1]);
    });

    it('re-reads the text instead when the API refuses the request with the picture', async () => {
      const { client, seen } = pictureClient(true);
      const { summary, payload } = await read(imageConfig, client, [hardPage], png);
      expect(seen.map((call) => [call.model, call.image !== undefined])).toEqual([['claude-sonnet-5-5', false],
        ['claude-opus-5-5', true], ['claude-opus-5-5', false]]);
      expect(summary).toMatchObject({ rereadPages: [1], imageRereadPages: [], requests: 3,
        imageRereadSkipped: [{ page: 1, reason: 'image_rejected' }] });
      expect(payload.items.every((item) => !item.checkReasons.includes('read_from_image'))).toBe(true);
    });

    it('re-reads the text for a request too large with the picture (413), but not after a key, permission or model rejection', async () => {
      const rejecting = (code: string) => {
        const seen: Seen[] = [];
        const client: PageModelClient = { readPage: jest.fn(async (request) => {
          seen.push({ model: request.model, page: request.page, image: request.image });
          if (request.image) throw new AiRejectedError(code, 1);
          return ok(textAnswer);
        }) };
        return { client, seen };
      };
      const large = rejecting('AI_HTTP_413');
      const tooLarge = await read(imageConfig, large.client, [hardPage], png);
      expect(large.seen.map((call) => call.image !== undefined)).toEqual([false, true, false]);
      expect(tooLarge.summary.imageRereadSkipped).toEqual([{ page: 1, reason: 'image_rejected' }]);
      for (const code of ['AI_NOT_AUTHENTICATED', 'AI_NOT_PERMITTED', 'AI_MODEL_NOT_FOUND']) {
        const { client, seen } = rejecting(code);
        const { summary, payload } = await read(imageConfig, client, [hardPage], png);
        // One request with the picture, no second (doomed) text request, and the picture not blamed.
        expect(seen.map((call) => call.image !== undefined)).toEqual([false, true]);
        expect(summary).toMatchObject({ rereadPages: [], rereadFailedPages: 1, imageRereadPages: [],
          imageRereadSkipped: [] });
        expect(payload.items.every((item) => item.checkReasons.includes('reread_failed'))).toBe(true);
      }
    });

    it('writes empty image fields when the AI step does not run, and old payloads without them still read', async () => {
      const { client } = pictureClient();
      const off = await read({ ...imageConfig, OCR_AI_MODE: 'off' }, client, [hardPage], png);
      expect(off.payload.reading).toMatchObject({ imageRereadPages: [], imageRereadSkipped: [] });
      const { imageRereadPages: _pages, imageRereadSkipped: _skipped, ...older } = off.payload.reading;
      expect(paperReadingPayloadSchema.safeParse({ ...off.payload, reading: older }).success).toBe(true);
      expect(paperReadingPayloadSchema.safeParse({ ...off.payload, reading: { ...older,
        imageRereadSkipped: [{ page: 1, reason: 'made_up' }] } }).success).toBe(false);
    });
  });
});
