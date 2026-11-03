import { AiRejectedError, AiTransientError, type PageAnswer, type PageModelClient } from './claude.client';
import { paperReadingPayloadSchema } from './contract';
import { PaperReadingService, ReadingUnavailableError, type ReadingConfig } from './reader';
import { CLINIC_PAGE, modelItem, modelPage, readPage, SOURCE_SHA } from './test-fixtures';
import type { ModelPage } from './prompt';

const FACILITY = '11111111-2222-4333-8444-555555555555';
const config: ReadingConfig = { OCR_AI_MODE: 'claude', OCR_AI_FACILITY_IDS: undefined,
  OCR_AI_FIRST_PASS_MODEL: 'claude-sonnet-5-5', OCR_AI_FIRST_PASS_EFFORT: 'medium',
  OCR_AI_REREAD_MODEL: 'claude-opus-5-5', OCR_AI_REREAD_EFFORT: 'high', OCR_AI_MAX_REREAD_PAGES: 20 };
const usage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const ok = (answer: ModelPage): PageAnswer => ({ kind: 'answer', answer, usage, attempts: 1, servedInferenceGeo: 'global' });
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
    expect(summary).toMatchObject({ requests: 1, inferenceGeo: 'global', servedInferenceGeo: 'global' });
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
});
