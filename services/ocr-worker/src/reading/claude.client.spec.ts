import { createHash } from 'node:crypto';
import { AiInterruptedError, AiRejectedError, AiTransientError, ClaudePageClient, FORCED_ANSWER_INSTRUCTION,
  HARD_READ_ANSWER_RESERVE_TOKENS, HARD_READ_MIN_TURN_MS, HARD_READ_MIN_TURN_TOKENS, retryAfterMs,
  type HardReadTrace } from './claude.client';
import { readOcrWorkerConfig } from '../config';
import { Semaphore } from '../semaphore';
import { HIGH_RESOLUTION_TIER, resizedSize, STANDARD_TIER } from './page-image';
import { MODEL_OUTPUT_HARD_PAGE_JSON_SCHEMA, MODEL_OUTPUT_IMAGE_JSON_SCHEMA, MODEL_OUTPUT_JSON_SCHEMA, SYSTEM_PROMPT } from './prompt';
import { fixturePng, modelItem, modelPage } from './test-fixtures';
import { createZoomSession, ZOOM_LIMIT_MESSAGE, ZOOM_TOOL, ZOOM_UNAVAILABLE_MESSAGE, type PageZoom } from './zoom';

const FAKE_KEY = 'sk-ant-test-0000000000000000000000';
const config = { ANTHROPIC_API_KEY: FAKE_KEY, OCR_AI_MAX_TOKENS: 16_000, OCR_AI_TIMEOUT_MS: 30_000,
  OCR_AI_MAX_RETRIES: 3 };
const request = { model: 'claude-sonnet-5-5', effort: 'medium' as const, page: 1,
  lines: [{ id: 'p1-l1', text: 'Dx: Hypertension', confidence: 0.99, handwritten: false }] };
const answer = modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l1'],
  name: 'Hypertension', status: 'confirmed', plain: 'High blood pressure' })]);

function sse(text: string, stopReason = 'end_turn'): Response {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant',
      model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, stop_details: null,
      usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0,
        inference_geo: 'us' } } }],
    ...(text ? [
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ] : []),
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null,
      stop_details: stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: null } : null },
      usage: { output_tokens: 300 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } });
}

function failure(status: number, type: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message: 'secret detail from the API' } }),
    { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A stream that reported 10 input tokens and 1 output token, then an overloaded error event. */
function brokenStream(): Response {
  return new Response('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null,
    stop_sequence: null, stop_details: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    + '\n\nevent: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'overloaded_error',
      message: 'secret detail from the API' } }) + '\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function client(responses: Array<Response | Error>) {
  const fetch = jest.fn(async (_url: unknown, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = jest.fn().mockResolvedValue(undefined);
  const instance = new ClaudePageClient(config, { fetch: fetch as unknown as typeof globalThis.fetch, sleep,
    random: () => 0.5 });
  return { instance, fetch, sleep };
}

describe('ClaudePageClient', () => {
  const originalBase = process.env.ANTHROPIC_BASE_URL;
  beforeAll(() => { process.env.ANTHROPIC_BASE_URL = 'https://elsewhere.example.invalid'; });
  afterAll(() => { if (originalBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = originalBase; });

  it('sends the configured defaults: the most capable model at high effort, US only, for both passes', async () => {
    const defaults = readOcrWorkerConfig({ NODE_ENV: 'test', OCR_PROVIDER: 'test',
      OCR_WORKER_DATABASE_URL: 'postgresql://worker:secret@localhost:5432/hid', OCR_WORKER_SUBJECT: 'workload:ocr:test',
      OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: FAKE_KEY, OCR_AI_US_PROCESSING_APPROVED: 'true' });
    expect(defaults).toMatchObject({ OCR_AI_FIRST_PASS_MODEL: 'claude-opus-5-5', OCR_AI_FIRST_PASS_EFFORT: 'high',
      OCR_AI_REREAD_MODEL: 'claude-opus-5-5', OCR_AI_REREAD_EFFORT: 'high' });
    for (const [model, effort] of [[defaults.OCR_AI_FIRST_PASS_MODEL, defaults.OCR_AI_FIRST_PASS_EFFORT],
      [defaults.OCR_AI_REREAD_MODEL, defaults.OCR_AI_REREAD_EFFORT]] as const) {
      const { instance, fetch } = client([sse(JSON.stringify(answer))]);
      await instance.readPage({ ...request, model, effort }, new AbortController().signal);
      const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: 'claude-opus-5-5', inference_geo: 'us', thinking: { type: 'adaptive' },
        output_config: { effort: 'high' } });
    }
  });

  it('sends one page to the fixed Claude API endpoint with US-only inference, adaptive thinking and a JSON schema', async () => {
    const { instance, fetch } = client([sse(JSON.stringify(answer))]);
    const result = await instance.readPage(request, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'answer', attempts: 1, servedInferenceGeo: 'us',
      usage: { inputTokens: 120, outputTokens: 300, cacheReadInputTokens: 900 } });
    expect(result.kind === 'answer' && result.answer.items[0]!.asWritten).toBe('Hypertension');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const headers = new Headers(init!.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16_000, inference_geo: 'us',
      stream: true, thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }] });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body.messages)).not.toContain('box');
  });

  it('reports a refusal from stop_reason before reading content', async () => {
    const { instance } = client([sse('{"partial":', 'refusal')]);
    await expect(instance.readPage(request, new AbortController().signal)).resolves.toMatchObject({ kind: 'refused' });
  });

  it('treats a max_tokens stop as a failed page, and malformed or off-schema JSON as malformed', async () => {
    const { instance } = client([sse('{"pageUnsure": true', 'max_tokens'), sse('not json'),
      sse(JSON.stringify({ pageUnsure: false, identity: answer.identity, items: [{ kind: 'medicine' }] }))]);
    const signal = new AbortController().signal;
    await expect(instance.readPage(request, signal)).resolves.toMatchObject({ kind: 'failed', reason: 'max_tokens' });
    await expect(instance.readPage(request, signal)).resolves.toMatchObject({ kind: 'failed', reason: 'malformed' });
    await expect(instance.readPage(request, signal)).resolves.toMatchObject({ kind: 'failed', reason: 'malformed' });
  });

  it('retries a 429 after its retry-after, then succeeds', async () => {
    const { instance, fetch, sleep } = client([failure(429, 'rate_limit_error', { 'retry-after': '7' }),
      sse(JSON.stringify(answer))]);
    await expect(instance.readPage(request, new AbortController().signal)).resolves.toMatchObject({ kind: 'answer', attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]![0]).toBe(7_000);
  });

  it('retries 500/502/503/504 and connection errors with full-jitter backoff', async () => {
    const { instance, sleep } = client([failure(500, 'api_error'), failure(503, 'api_error'),
      new TypeError('fetch failed'), sse(JSON.stringify(answer))]);
    await expect(instance.readPage(request, new AbortController().signal)).resolves.toMatchObject({ kind: 'answer', attempts: 4 });
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([500, 1_000, 2_000]);
  });

  it('gives up with a transient error once 529 overloads outlast the configured attempts', async () => {
    const { instance, fetch } = client([529, 529, 529, 529].map((status) => failure(status, 'overloaded_error')));
    const error = await instance.readPage(request, new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiTransientError);
    expect((error as AiTransientError).code).toBe('AI_HTTP_529');
    // Every request it made is carried, so the usage record counts them; no tokens were reported.
    expect(error).toMatchObject({ attempts: 4, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0 } });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(String(error)).not.toContain('secret detail');
  });

  it.each([[400, 'invalid_request_error', 'AI_BAD_REQUEST'], [401, 'authentication_error', 'AI_NOT_AUTHENTICATED'],
    [403, 'permission_error', 'AI_NOT_PERMITTED'], [404, 'not_found_error', 'AI_MODEL_NOT_FOUND']])(
    'does not retry a %s', async (status, type, code) => {
      const { instance, fetch } = client([failure(status, type)]);
      const error = await instance.readPage(request, new AbortController().signal).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiRejectedError);
      expect((error as AiRejectedError).code).toBe(code);
      expect((error as AiRejectedError).attempts).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

  it('marks only a 400 invalid_request_error as an invalid request (the one rejection a picture can cause)', async () => {
    const cases: Array<[number, string, boolean]> = [[400, 'invalid_request_error', true], [400, 'api_error', false],
      [401, 'authentication_error', false], [403, 'permission_error', false], [404, 'not_found_error', false],
      [413, 'request_too_large', false]];
    for (const [status, type, invalid] of cases) {
      const { instance } = client([failure(status, type)]);
      const error = await instance.readPage(request, new AbortController().signal).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiRejectedError);
      expect((error as AiRejectedError).invalidRequest).toBe(invalid);
    }
  });

  it('retries an overloaded error event inside a stream that had already started', async () => {
    const broken = new Response('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: {
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null,
      stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      + '\n\nevent: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'overloaded_error',
        message: 'secret detail from the API' } }) + '\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const { instance, fetch } = client([broken, sse(JSON.stringify(answer))]);
    // The tokens the broken stream had already reported are added to the answer's usage.
    await expect(instance.readPage(request, new AbortController().signal)).resolves.toMatchObject({ kind: 'answer',
      attempts: 2, usage: { inputTokens: 121, outputTokens: 301, cacheReadInputTokens: 900 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('carries the attempts and the tokens already reported when broken streams outlast the attempts', async () => {
    const { instance, fetch } = client([1, 2, 3, 4].map(() => brokenStream()));
    const error = await instance.readPage(request, new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiTransientError);
    expect(error).toMatchObject({ code: 'AI_STREAM_ERROR', attempts: 4,
      usage: { inputTokens: 40, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(String(error)).not.toContain('secret detail');
  });

  it('carries the attempts already made when the worker shuts down during a backoff', async () => {
    const controller = new AbortController();
    const reason = new Error('worker shutdown');
    const fetch = jest.fn(async () => failure(529, 'overloaded_error'));
    const sleep = jest.fn(async (_ms: number, signal?: AbortSignal) => { controller.abort(reason); throw signal!.reason; });
    const instance = new ClaudePageClient(config, { fetch: fetch as unknown as typeof globalThis.fetch, sleep,
      random: () => 0.5 });
    const error = await instance.readPage(request, controller.signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiInterruptedError);
    expect(error).toMatchObject({ reason, attempts: 1, message: 'AI_INTERRUPTED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops at once when the worker shuts down', async () => {
    const controller = new AbortController();
    const { instance, fetch } = client([failure(529, 'overloaded_error'), sse(JSON.stringify(answer))]);
    const reason = new Error('worker shutdown');
    controller.abort(reason);
    const error = await instance.readPage(request, controller.signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiInterruptedError);
    expect((error as AiInterruptedError).reason).toBe(reason);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
    expect((error as AiInterruptedError).attempts).toBe(fetch.mock.calls.length);
  });

  it('reads retry-after in seconds, milliseconds or as a date, bounded', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '3' }))).toBe(3_000);
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '250', 'retry-after': '3' }))).toBe(250);
    expect(retryAfterMs(new Headers({ 'retry-after': '3600' }))).toBe(60_000);
    expect(retryAfterMs(new Headers({}))).toBeNull();
  });

  it('refuses to start without a key', () => {
    expect(() => new ClaudePageClient({ ...config, ANTHROPIC_API_KEY: undefined })).toThrow(/API key/);
  });

  it('holds the shared request limit for one HTTP attempt only, never across a backoff sleep', async () => {
    const limiter = new Semaphore(1);
    let inFlight = 0;
    let peak = 0;
    const queue: Array<Response> = [failure(529, 'overloaded_error'), sse(JSON.stringify(answer)), sse(JSON.stringify(answer))];
    const fetch = jest.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return queue.shift()!;
    });
    const held: number[] = [];
    const sleep = jest.fn(async () => { held.push(limiter.inFlight); });
    const instance = new ClaudePageClient(config, { fetch: fetch as unknown as typeof globalThis.fetch, sleep,
      random: () => 0.5, limiter });
    const answers = await Promise.all([instance.readPage(request, new AbortController().signal),
      instance.readPage(request, new AbortController().signal)]);
    expect(answers.map((entry) => entry.kind)).toEqual(['answer', 'answer']);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    // While the first request backed off, its permit was free (the other request may have held it).
    expect(limiter.inFlight).toBe(0);
    expect(held.every((count) => count <= 1)).toBe(true);
  });

  it('builds its limit from OCR_AI_MAX_CONCURRENT_REQUESTS, 4 by default', () => {
    expect(new ClaudePageClient(config).limiter.limit).toBe(4);
    expect(new ClaudePageClient({ ...config, OCR_AI_MAX_CONCURRENT_REQUESTS: 7 }).limiter.limit).toBe(7);
  });

  it('stops waiting for a permit on shutdown without calling the API', async () => {
    const limiter = new Semaphore(1);
    const release = await limiter.acquire();
    const { fetch } = client([]);
    const instance = new ClaudePageClient(config, { fetch: fetch as unknown as typeof globalThis.fetch, limiter });
    const controller = new AbortController();
    const pending = instance.readPage(request, controller.signal);
    const reason = new Error('worker shutdown');
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({ reason, attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
    release();
  });

  describe('image re-read requests', () => {
    const pictureBytes = fixturePng(1240, 1754);
    const image = { mediaType: 'image/png' as const, base64: Buffer.from(pictureBytes).toString('base64'), width: 1240,
      height: 1754 };
    const lines = [{ id: 'p1-l1', text: 'Dx: Hypertension', confidence: 0.987, handwritten: false,
      box: { left: 0.1, top: 0.1, width: 0.5, height: 0.02 } },
    { id: 'p1-l2', text: 'Amlodipine 5mg od', confidence: 0.61, handwritten: true, box: null }];
    const pinned = { model: 'claude-opus-5-5', effort: 'high' as const, page: 1, lines };
    const bodyOf = (fetch: jest.Mock) => String((fetch.mock.calls[0] as [unknown, RequestInit])[1].body);

    it('sends a text-only page byte for byte as before the image re-read existed, boxes and all left out', async () => {
      const { instance, fetch } = client([sse(JSON.stringify(answer))]);
      await instance.readPage(pinned, new AbortController().signal);
      const body = bodyOf(fetch);
      // The request body this exact call produced on the parent commit (605e971e), before any image work. It is
      // unchanged by PROMPT_VERSION 3 (the re-read routing): the version label is recorded in provenance, never sent.
      expect(createHash('sha256').update(body).digest('hex'))
        .toBe('cd03ba1ed24c0d36e6bb9b71f8c27582e2d0a30adc911838fcc0b00f50d6fb7f');
      expect(body).toHaveLength(7637);
      expect(body).not.toContain('"image"');
      expect(body).not.toContain('box');
    });

    it('puts the picture before the page text, keeps the cached system prefix, US inference and the fixed endpoint', async () => {
      // Pixels of the 1240 x 1754 picture (within the high-resolution tier, so not resized).
      const box = { x1: 124, y1: 175.4, x2: 496, y2: 210.48 };
      const imageAnswer = { ...answer, items: answer.items.map((item) => ({ ...item, box })) };
      const text = client([sse(JSON.stringify(answer))]);
      await text.instance.readPage(pinned, new AbortController().signal);
      const { instance, fetch } = client([sse(JSON.stringify(imageAnswer))]);
      const result = await instance.readPage({ ...pinned, image }, new AbortController().signal);
      // Normalised in code: page fractions.
      const read = result.kind === 'answer' ? result.answer.items[0]!.box! : null;
      expect(read).not.toBeNull();
      for (const [key, expected] of Object.entries({ left: 0.1, top: 0.1, width: 0.3, height: 0.02 })) {
        expect(read![key as keyof typeof read]).toBeCloseTo(expected, 6);
      }
      const [url] = fetch.mock.calls[0]!;
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      const body = JSON.parse(bodyOf(fetch)) as { inference_geo: string; system: unknown; messages: Array<{
        role: string; content: Array<Record<string, unknown>> }>; output_config: { format: { schema: unknown } } };
      const textBody = JSON.parse(bodyOf(text.fetch)) as typeof body;
      expect(body.inference_geo).toBe('us');
      // The cached prefix is the same bytes for both kinds of request.
      expect(JSON.stringify(body.system)).toBe(JSON.stringify(textBody.system));
      expect(body.messages).toHaveLength(1);
      const [first, second] = body.messages[0]!.content;
      expect(first).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.base64 } });
      expect(second).toMatchObject({ type: 'text' });
      expect(String(second!.text)).toContain('read the writing from the picture');
      expect(String(second!.text)).toContain('1240 pixels wide and 1754 pixels high');
      expect(String(second!.text)).toContain('absolute pixel coordinates');
      expect(String(second!.text)).toContain('including small fragments of the same row');
      expect(String(second!.text)).toContain('may be wrong or even nonsense');
      expect(String(second!.text)).not.toContain('fractions');
      expect(String(second!.text)).toContain('"box":{"x1":124,"y1":175,"x2":744,"y2":210}');
      expect(String(second!.text)).toContain('"handwritten":true');
      expect(body.output_config.format.schema).toEqual(MODEL_OUTPUT_IMAGE_JSON_SCHEMA);
      expect(textBody.output_config.format.schema).toEqual(MODEL_OUTPUT_JSON_SCHEMA);
    });

    it('works in the pixels of the picture as the API resizes it, by the model tier', async () => {
      // A4 at 300 dpi: over the high-resolution token budget, so the API reads it smaller (resizedSize).
      const big = { ...image, width: 2480, height: 3508 };
      const seenSize = resizedSize(2480, 3508, HIGH_RESOLUTION_TIER);
      expect(seenSize.width).toBeLessThan(2480);
      const box = { x1: seenSize.width / 2, y1: seenSize.height / 4, x2: seenSize.width, y2: seenSize.height / 2 };
      const { instance, fetch } = client([sse(JSON.stringify({ ...answer, items: answer.items.map((item) => ({ ...item, box })) }))]);
      const result = await instance.readPage({ ...pinned, image: big }, new AbortController().signal);
      const body = JSON.parse(bodyOf(fetch)) as { messages: Array<{ content: Array<{ text?: string }> }> };
      expect(body.messages[0]!.content[1]!.text).toContain(`${seenSize.width} pixels wide and ${seenSize.height} pixels high`);
      const read = result.kind === 'answer' ? result.answer.items[0]!.box! : null;
      expect(read!.left).toBeCloseTo(0.5, 6);
      expect(read!.top).toBeCloseTo(0.25, 6);
      expect(read!.width).toBeCloseTo(0.5, 6);
      expect(read!.height).toBeCloseTo(0.25, 6);
      // A standard-tier model sees the same picture smaller still.
      const standard = client([sse(JSON.stringify(answer))]);
      await standard.instance.readPage({ ...pinned, model: 'claude-sonnet-4-5', image: big }, new AbortController().signal)
        .catch(() => undefined);
      const small = resizedSize(2480, 3508, STANDARD_TIER);
      const standardBody = JSON.parse(bodyOf(standard.fetch)) as typeof body;
      expect(standardBody.messages[0]!.content[1]!.text).toContain(`${small.width} pixels wide and ${small.height} pixels high`);
    });

    it('never sends a picture to a model of unknown image tier', async () => {
      const { instance, fetch } = client([sse(JSON.stringify(answer))]);
      const error = await instance.readPage({ ...pinned, model: 'claude-haiku-5-5', image }, new AbortController().signal)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiRejectedError);
      expect(error).toMatchObject({ code: 'IMAGE_TIER_UNKNOWN', attempts: 0, invalidRequest: false });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('treats an image answer without item boxes as malformed, and a text answer with boxes as malformed', async () => {
      const box = { x1: 124, y1: 175, x2: 496, y2: 210 };
      const { instance } = client([sse(JSON.stringify(answer)),
        sse(JSON.stringify({ ...answer, items: answer.items.map((item) => ({ ...item, box })) }))]);
      const signal = new AbortController().signal;
      await expect(instance.readPage({ ...pinned, image }, signal)).resolves.toMatchObject({ kind: 'failed', reason: 'malformed' });
      await expect(instance.readPage(pinned, signal)).resolves.toMatchObject({ kind: 'failed', reason: 'malformed' });
    });

    it('sends a hard page the best-guess message and schema, and reads the dose, unit and basis beside each item', async () => {
      const box = { x1: 124, y1: 175.4, x2: 496, y2: 210.48 };
      const basis = { name: 'letters', dose: 'letters', unit: 'letters', route: 'empty', frequency: 'context',
        duration: 'empty', value: 'empty', other: 'empty' };
      const hardAnswer = { ...answer, items: [{ ...modelItem({ kind: 'medicine', asWritten: 'Pyrimethamine? 25 mg od',
        lineIds: ['p1-l2'], name: 'Pyrimethamine?', strength: '25 mg', frequency: 'od', status: 'new' }), box,
      dose: '25', doseUnit: 'mg', crossedOut: '', basis }] };
      const { instance, fetch } = client([sse(JSON.stringify(hardAnswer))]);
      const result = await instance.readPage({ ...pinned, effort: 'max', image, hardPage: true }, new AbortController().signal);
      const body = JSON.parse(bodyOf(fetch)) as { model: string; inference_geo: string; thinking: unknown;
        output_config: { effort: string; format: { schema: unknown } }; messages: Array<{ content: Array<{ text?: string }> }> };
      expect(body).toMatchObject({ model: 'claude-opus-5-5', inference_geo: 'us', thinking: { type: 'adaptive' },
        output_config: { effort: 'max' } });
      expect(body.output_config.format.schema).toEqual(MODEL_OUTPUT_HARD_PAGE_JSON_SCHEMA);
      const text = body.messages[0]!.content[1]!.text!;
      for (const phrase of ['line by line', 'put "?" straight after', '"letters"', '"context"',
        'od, bd, tds, qds, 6hrly, 8hrly', 'Write "[?]" only where', '"(? on paper)"', 'never a description of it',
        '"(crossed out: X)"', 'Transfer to the ward', 'Leave "plain" as ""', 'shows through from the back',
        'Never invent an item', 'absolute pixel coordinates', 'including small fragments of the same row'])
        expect(text).toContain(phrase);
      expect(String(fetch.mock.calls[0]![0])).toBe('https://api.anthropic.com/v1/messages');
      expect(result).toMatchObject({ kind: 'answer', answer: { items: [{ name: 'Pyrimethamine?',
        hard: { dose: '25', doseUnit: 'mg', crossedOut: '', basis } }] } });
      const item = result.kind === 'answer' ? result.answer.items[0]! : null;
      expect(item).not.toHaveProperty('dose');
      expect(item!.box!.left).toBeCloseTo(0.1, 6);
      // An answer without the basis, or without crossedOut, is malformed. A frequency is free text since hard-page
      // prompt 5/6 (hard-page.ts normalises the usual codes).
      const { basis: _basis, ...withoutBasis } = hardAnswer.items[0]!;
      const { crossedOut: _crossed, ...withoutCrossedOut } = hardAnswer.items[0]!;
      const bad = client([sse(JSON.stringify({ ...answer, items: [withoutBasis] })),
        sse(JSON.stringify({ ...answer, items: [withoutCrossedOut] }))]);
      for (let index = 0; index < 2; index += 1) {
        await expect(bad.instance.readPage({ ...pinned, image, hardPage: true }, new AbortController().signal))
          .resolves.toMatchObject({ kind: 'failed', reason: 'malformed' });
      }
      const free = client([sse(JSON.stringify({ ...answer, items: [{ ...hardAnswer.items[0]!, frequency: 'alternate days',
        crossedOut: '400mg?' }] }))]);
      await expect(free.instance.readPage({ ...pinned, image, hardPage: true }, new AbortController().signal))
        .resolves.toMatchObject({ kind: 'answer', answer: { items: [{ frequency: 'alternate days',
          hard: { crossedOut: '400mg?' } }] } });
      // Without hardPage, the image request is the earlier image re-read request; a text request ignores it.
      const plain = client([sse(JSON.stringify({ ...answer, items: answer.items.map((entry) => ({ ...entry, box })) })),
        sse(JSON.stringify(answer))]);
      await plain.instance.readPage({ ...pinned, image }, new AbortController().signal);
      expect((JSON.parse(bodyOf(plain.fetch)) as typeof body).output_config.format.schema).toEqual(MODEL_OUTPUT_IMAGE_JSON_SCHEMA);
      await plain.instance.readPage({ ...pinned, hardPage: true }, new AbortController().signal);
      const textBody = String((plain.fetch.mock.calls[1] as [unknown, RequestInit])[1].body);
      expect(createHash('sha256').update(textBody).digest('hex'))
        .toBe('cd03ba1ed24c0d36e6bb9b71f8c27582e2d0a30adc911838fcc0b00f50d6fb7f');
    });

    it('gives a hard-page request its own timeout', async () => {
      const timeouts: number[] = [];
      const spy = jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        timeouts.push(ms); return new AbortController().signal;
      });
      try {
        const fetch = jest.fn(async () => sse(JSON.stringify(answer)));
        const instance = new ClaudePageClient({ ...config, OCR_AI_HARD_PAGE_TIMEOUT_MS: 900_000 },
          { fetch: fetch as unknown as typeof globalThis.fetch });
        await instance.readPage({ ...pinned, image, hardPage: true }, new AbortController().signal).catch(() => undefined);
        await instance.readPage({ ...pinned, image }, new AbortController().signal).catch(() => undefined);
        await instance.readPage(pinned, new AbortController().signal);
        expect(timeouts).toEqual([900_000, 30_000, 30_000]);
      } finally { spy.mockRestore(); }
    });

    it('never puts the picture in an error', async () => {
      const { instance } = client([failure(400, 'invalid_request_error')]);
      const error = await instance.readPage({ ...pinned, image }, new AbortController().signal).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiRejectedError);
      const shown = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;
      expect(shown).not.toContain(image.base64.slice(100, 140));
    });
  });

  describe('the zoom tool loop (hard-page reads only)', () => {
    const image = { mediaType: 'image/png' as const, base64: Buffer.from(fixturePng(1240, 1754)).toString('base64'),
      width: 1240, height: 1754 };
    const lines = [{ id: 'p1-l1', text: 'Pyrmthmn 25 rng od', confidence: 0.4, handwritten: true,
      box: { left: 0.1, top: 0.1, width: 0.5, height: 0.02 } }];
    const hardRequest = { model: 'claude-opus-5-5', effort: 'max' as const, page: 1, lines, image, hardPage: true };
    const basis = { name: 'letters', dose: 'letters', unit: 'letters', route: 'empty', frequency: 'letters',
      duration: 'empty', value: 'empty', other: 'empty' };
    const hardAnswer = { ...answer, items: [{ ...modelItem({ kind: 'medicine', asWritten: 'Pyrimethamine? 25 mg od',
      lineIds: ['p1-l1'], name: 'Pyrimethamine?', strength: '25 mg', frequency: 'od', status: 'new' }),
    box: { x1: 124, y1: 175, x2: 744, y2: 210 }, dose: '25', doseUnit: 'mg', crossedOut: '', basis }] };
    /** A distinctive fictional "crop" (not an image): it must never appear anywhere but the request body. */
    const CROP = Buffer.from('fictional-crop-bytes-'.repeat(40)).toString('base64');
    const crop = { mediaType: 'image/png' as const, base64: CROP, width: 64, height: 64,
      region: { x: 124, y: 175, w: 16, h: 16 }, scale: 4 };
    const goodZoom: PageZoom = { available: () => true, crop: async () => ({ kind: 'crop', crop }) };
    const zoomInput = { page: 1, box: { x: 124, y: 175, w: 16, h: 16 }, scale: 4 };

    type Block = { type: 'thinking'; thinking: string; signature: string } | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; json: string };
    /** A streamed turn of content blocks, with its usage. */
    function turn(blocks: Block[], stopReason: string, inputTokens = 5_000, outputTokens = 700): Response {
      const events: Array<[string, unknown]> = [['message_start', { type: 'message_start', message: { id: 'msg_zoom',
        type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
        stop_details: null, usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 100,
          cache_creation_input_tokens: 10, inference_geo: 'us' } } }]];
      blocks.forEach((block, index) => {
        if (block.type === 'thinking') {
          events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking',
            thinking: '', signature: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }],
          ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }]);
        } else if (block.type === 'text') {
          events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
        } else {
          events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use',
            id: block.id, name: block.name, input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.json } }]);
        }
        events.push(['content_block_stop', { type: 'content_block_stop', index }]);
      });
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null,
        stop_details: null }, usage: { output_tokens: outputTokens } }], ['message_stop', { type: 'message_stop' }]);
      return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const zoomCall = (id: string, json = JSON.stringify(zoomInput)): Block => ({ type: 'tool_use', id, name: 'zoom', json });
    const thinking = (signature: string): Block => ({ type: 'thinking', thinking: '', signature });
    const final = () => turn([thinking('sig-final'), { type: 'text', text: JSON.stringify(hardAnswer) }], 'end_turn');
    type Body = { tools?: unknown[]; tool_choice?: unknown; cache_control?: unknown; max_tokens: number;
      output_config: { format: unknown; effort: string };
      messages: Array<{ role: string; content: Array<Record<string, unknown>> | string }> };
    const bodies = (fetch: jest.Mock) => fetch.mock.calls.map((call) => JSON.parse(String((call as [unknown, RequestInit])[1].body)) as Body);

    it('runs one zoom, then reads the answer; the thinking blocks go back exactly, the usage of every turn counts', async () => {
      const { instance, fetch } = client([turn([thinking('sig-one'), { type: 'text', text: 'Looking closer.' },
        zoomCall('toolu_a')], 'tool_use'), final()]);
      const session = createZoomSession(goodZoom, 1, 8, image.base64.length);
      const result = await instance.readPage({ ...hardRequest, zoom: session }, new AbortController().signal);
      expect(result).toMatchObject({ kind: 'answer', attempts: 2, usage: { inputTokens: 10_000, outputTokens: 1_400,
        cacheReadInputTokens: 200, cacheCreationInputTokens: 20 }, answer: { items: [{ name: 'Pyrimethamine?' }] } });
      expect(session.stats).toEqual({ calls: 1, limited: 0, failed: 0 });
      const [first, second] = bodies(fetch);
      expect(first!.tools).toEqual([ZOOM_TOOL]);
      expect(first!.tool_choice).toEqual({ type: 'auto' });
      expect(first!.cache_control).toEqual({ type: 'ephemeral' });
      // Structured output stays on with the tool: the final turn is the JSON answer.
      expect(second!.output_config.format).toEqual(first!.output_config.format);
      expect(first!.messages).toHaveLength(1);
      expect(String((first!.messages[0]!.content as Array<{ text?: string }>)[1]!.text)).toContain('You can use the zoom tool');
      expect(String((first!.messages[0]!.content as Array<{ text?: string }>)[1]!.text)).toContain('at most 8 times');
      // Append-only: the first turn's user message, then the assistant turn as it came, then the results.
      expect(second!.messages[0]).toEqual(first!.messages[0]);
      expect(second!.messages[1]).toEqual({ role: 'assistant', content: [
        { type: 'thinking', thinking: '', signature: 'sig-one' }, { type: 'text', text: 'Looking closer.' },
        { type: 'tool_use', id: 'toolu_a', name: 'zoom', input: zoomInput }] });
      expect(second!.messages[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a',
        content: [{ type: 'text' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: CROP } }] }] });
    });

    it('answers 9 calls with 8 crops and the limit error, then reads the answer', async () => {
      const calls = Array.from({ length: 9 }, (_, index) => zoomCall(`toolu_${index}`));
      const { instance, fetch } = client([turn([thinking('sig-many'), ...calls], 'tool_use'), final()]);
      const zoom = { available: () => true, crop: jest.fn(goodZoom.crop) };
      const session = createZoomSession(zoom, 1, 8, image.base64.length);
      await expect(instance.readPage({ ...hardRequest, zoom: session }, new AbortController().signal))
        .resolves.toMatchObject({ kind: 'answer', attempts: 2 });
      expect(zoom.crop).toHaveBeenCalledTimes(8);
      const results = bodies(fetch)[1]!.messages[2]!.content as Array<Record<string, unknown>>;
      // All results in one user turn, in the order of the calls.
      expect(results.map((entry) => entry.tool_use_id)).toEqual(calls.map((entry) => (entry as { id: string }).id));
      expect(results[8]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_8', is_error: true, content: ZOOM_LIMIT_MESSAGE });
      expect(session.stats).toEqual({ calls: 8, limited: 1, failed: 0 });
    });

    it('answers 5 calls in one turn with the cap of 4: 4 crops and 1 limit error, all in one user turn, then the answer', async () => {
      const calls = Array.from({ length: 5 }, (_, index) => zoomCall(`toolu_${index}`));
      const { instance, fetch } = client([turn([thinking('sig-five'), ...calls], 'tool_use'), final()]);
      const zoom = { available: () => true, crop: jest.fn(goodZoom.crop) };
      const session = createZoomSession(zoom, 1, 4, image.base64.length);
      await expect(instance.readPage({ ...hardRequest, zoom: session }, new AbortController().signal))
        .resolves.toMatchObject({ kind: 'answer', attempts: 2 });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(zoom.crop).toHaveBeenCalledTimes(4);
      const [first, second] = bodies(fetch);
      expect(String((first!.messages[0]!.content as Array<{ text?: string }>)[1]!.text))
        .toContain('ask for all of those zooms together in one response');
      // One assistant turn with the five calls, then one user turn with the five results, in call order; the cap is
      // used up, so the second turn is the answer-only turn: its instruction, no zoom offered, low effort.
      expect(second!.messages).toHaveLength(4);
      expect(second!.messages[3]).toEqual({ role: 'user', content: [{ type: 'text', text: FORCED_ANSWER_INSTRUCTION }] });
      expect(second!.tools).toEqual([ZOOM_TOOL]);
      expect(second!.tool_choice).toEqual({ type: 'none' });
      expect(second!.output_config.effort).toBe('low');
      expect((second!.messages[1]!.content as Array<{ type: string }>).filter((block) => block.type === 'tool_use')).toHaveLength(5);
      const results = second!.messages[2]!.content as Array<Record<string, unknown>>;
      expect(results.map((entry) => entry.tool_use_id)).toEqual(['toolu_0', 'toolu_1', 'toolu_2', 'toolu_3', 'toolu_4']);
      expect(results.slice(0, 4).every((entry) => entry.is_error === undefined)).toBe(true);
      expect(results[4]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_4', is_error: true, content: ZOOM_LIMIT_MESSAGE });
      expect(session.stats).toEqual({ calls: 4, limited: 1, failed: 0 });
    });

    it('counts a later turn\'s calls against what is left of the cap (3 calls, then 2: the last is refused)', async () => {
      const { instance, fetch } = client([turn([zoomCall('toolu_a'), zoomCall('toolu_b'), zoomCall('toolu_c')], 'tool_use'),
        turn([zoomCall('toolu_d'), zoomCall('toolu_e')], 'tool_use'), final()]);
      const zoom = { available: () => true, crop: jest.fn(goodZoom.crop) };
      const session = createZoomSession(zoom, 1, 4, image.base64.length);
      await expect(instance.readPage({ ...hardRequest, zoom: session }, new AbortController().signal))
        .resolves.toMatchObject({ kind: 'answer', attempts: 3 });
      expect(zoom.crop).toHaveBeenCalledTimes(4);
      const third = bodies(fetch)[2]!;
      expect((third.messages[2]!.content as Array<Record<string, unknown>>).map((entry) => entry.tool_use_id))
        .toEqual(['toolu_a', 'toolu_b', 'toolu_c']);
      expect(third.messages[4]!.content).toEqual([expect.objectContaining({ tool_use_id: 'toolu_d' }),
        { type: 'tool_result', tool_use_id: 'toolu_e', is_error: true, content: ZOOM_LIMIT_MESSAGE }]);
      expect(session.stats).toEqual({ calls: 4, limited: 1, failed: 0 });
    });

    it('answers a malformed input and a failed zoom with errors, and the read goes on', async () => {
      const { instance, fetch } = client([turn([zoomCall('toolu_bad', '{"page": 1, "box": "Test Patient"}')], 'tool_use'),
        turn([zoomCall('toolu_down')], 'tool_use'), final()]);
      let failing = false;
      const zoom: PageZoom = { available: () => true, crop: async () => failing ? { kind: 'unavailable' } : { kind: 'crop', crop } };
      failing = true;
      const session = createZoomSession(zoom, 1, 8, image.base64.length);
      await expect(instance.readPage({ ...hardRequest, zoom: session }, new AbortController().signal))
        .resolves.toMatchObject({ kind: 'answer', attempts: 3 });
      const sent = bodies(fetch);
      expect(sent[1]!.messages[2]!.content).toEqual([expect.objectContaining({ tool_use_id: 'toolu_bad', is_error: true })]);
      expect(JSON.stringify(sent[1]!.messages[2])).not.toContain('Test Patient');
      expect(sent[2]!.messages[4]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_down', is_error: true,
        content: ZOOM_UNAVAILABLE_MESSAGE }]);
      expect(session.stats).toEqual({ calls: 0, limited: 0, failed: 2 });
    });

    it('never runs a tool from a cut-off or refused turn; a cut-off turn is followed by the answer-only turn', async () => {
      const zoom = { available: () => true, crop: jest.fn(goodZoom.crop) };
      const { instance, fetch } = client([turn([zoomCall('toolu_cut', '{"page": 1, "box": {"x": 1')], 'max_tokens'),
        final(), turn([zoomCall('toolu_refused')], 'refusal')]);
      const signal = new AbortController().signal;
      const trace: HardReadTrace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
      await expect(instance.readPage({ ...hardRequest, trace, zoom: createZoomSession(zoom, 1, 8, 0) }, signal))
        .resolves.toMatchObject({ kind: 'answer', attempts: 2, usage: { outputTokens: 1_400 } });
      expect(trace).toEqual({ turns: 2, followupTurns: 1, cutAttempts: 0, forced: 'max_tokens' });
      // The cut turn is left out (its thinking cannot go back); the instruction follows the first user message.
      const forced = bodies(fetch)[1]!;
      expect(forced.messages).toHaveLength(2);
      expect(forced.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: FORCED_ANSWER_INSTRUCTION }] });
      expect(forced.tool_choice).toEqual({ type: 'none' });
      // A refusal ends the read at once (the reader may send the page to a text re-read).
      await expect(instance.readPage({ ...hardRequest, zoom: createZoomSession(zoom, 1, 8, 0) }, signal))
        .resolves.toMatchObject({ kind: 'refused', attempts: 1 });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(zoom.crop).not.toHaveBeenCalled();
    });

    it('sends the answer-only turn once the zoom calls are used up; a model still calling then ends as zoom_loop', async () => {
      const { instance, fetch } = client([turn([zoomCall('toolu_0')], 'tool_use', 10, 10),
        turn([zoomCall('toolu_1')], 'tool_use', 10, 10), final()]);
      const session = createZoomSession(goodZoom, 1, 2, 0);
      const trace: HardReadTrace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
      await expect(instance.readPage({ ...hardRequest, trace, zoom: session }, new AbortController().signal))
        .resolves.toMatchObject({ kind: 'answer', attempts: 3 });
      expect(trace.forced).toBe('zoom_cap');
      expect(bodies(fetch).map((body) => body.tool_choice)).toEqual([{ type: 'auto' }, { type: 'auto' }, { type: 'none' }]);
      expect(session.stats).toEqual({ calls: 2, limited: 0, failed: 0 });
      // Before 2026-11-10 a read could go on 3 turns past its calls; now there is never a turn after the answer-only one.
      const looping = client(Array.from({ length: 12 }, (_, index) => turn([zoomCall(`toolu_${index}`)], 'tool_use', 10, 10)));
      const result = await looping.instance.readPage({ ...hardRequest, zoom: createZoomSession(goodZoom, 1, 2, 0) },
        new AbortController().signal);
      expect(result).toMatchObject({ kind: 'failed', reason: 'incomplete', code: 'zoom_loop', attempts: 3,
        usage: { inputTokens: 30, outputTokens: 30 } });
      expect(looping.fetch).toHaveBeenCalledTimes(3);
    });

    it('reproduces job 566c38bf (the #200 reader): zoom turns, then an answer turn cut at max_tokens; now answered', async () => {
      // The most likely path (README "A hard read always ends with an answer"): each read's zoom turns used its calls,
      // and the turn that should have answered thought until max_tokens. The #200 client returned
      // { kind: 'failed', reason: 'max_tokens' } there, silently; both reads did, and the page kept its first reading.
      const { instance, fetch } = client([turn([thinking('sig-a'), zoomCall('toolu_a'), zoomCall('toolu_b')], 'tool_use'),
        turn([thinking('sig-b'), zoomCall('toolu_c')], 'tool_use'), turn([thinking('sig-cut')], 'max_tokens', 5_000, 4_000),
        final()]);
      const trace: HardReadTrace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
      const result = await instance.readPage({ ...hardRequest, trace, zoom: createZoomSession(goodZoom, 1, 4, 0) },
        new AbortController().signal);
      expect(result).toMatchObject({ kind: 'answer', attempts: 4, answer: { items: [{ name: 'Pyrimethamine?' }] } });
      expect(trace).toEqual({ turns: 4, followupTurns: 3, cutAttempts: 0, forced: 'max_tokens' });
      const sentBodies = bodies(fetch);
      // Every turn before the answer-only one keeps the answer reserve out of its max_tokens (16,000 cap here: 8,000).
      expect(sentBodies.map((body) => body.max_tokens)).toEqual([8_000, 7_300, 6_600, 8_000]);
      // The answer-only turn: the two zoom turns with their thinking, not the cut turn, then the instruction.
      expect(sentBodies[3]!.messages).toHaveLength(6);
      expect(JSON.stringify(sentBodies[3]!.messages)).not.toContain('sig-cut');
      expect(sentBodies[3]!.messages[5]).toEqual({ role: 'user', content: [{ type: 'text', text: FORCED_ANSWER_INSTRUCTION }] });
    });

    it('ends on an unparseable or off-schema answer with its reason code, without a repair turn', async () => {
      const { instance, fetch } = client([turn([{ type: 'text', text: 'not json' }], 'end_turn'),
        turn([{ type: 'text', text: JSON.stringify({ items: 'none' }) }], 'end_turn')]);
      const signal = new AbortController().signal;
      await expect(instance.readPage({ ...hardRequest, zoom: createZoomSession(goodZoom, 1, 4, 0) }, signal))
        .resolves.toMatchObject({ kind: 'failed', reason: 'malformed', code: 'parse_error', attempts: 1 });
      await expect(instance.readPage({ ...hardRequest, zoom: createZoomSession(goodZoom, 1, 4, 0) }, signal))
        .resolves.toMatchObject({ kind: 'failed', reason: 'malformed', code: 'schema_error', attempts: 1 });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('stops on shutdown between turns, counting the requests already made', async () => {
      const controller = new AbortController();
      const { instance, fetch } = client([turn([zoomCall('toolu_a')], 'tool_use'), final()]);
      const reason = new Error('worker shutdown');
      const zoom: PageZoom = { available: () => true, crop: async () => { controller.abort(reason); return { kind: 'crop', crop }; } };
      const error = await instance.readPage({ ...hardRequest, zoom: createZoomSession(zoom, 1, 8, 0) }, controller.signal)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiInterruptedError);
      expect(error).toMatchObject({ reason, attempts: 1, usage: { inputTokens: 5_000, outputTokens: 700 } });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(`${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`).not.toContain(CROP.slice(20, 60));
    });

    it('holds the loop\'s time in requests to the hard-page timeout times the attempts, not its waits', async () => {
      let clock = 1_000_000;
      const timeouts: number[] = [];
      const spy = jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        timeouts.push(ms); return new AbortController().signal;
      });
      try {
        const responses = Array.from({ length: 6 }, (_, index) => turn([zoomCall(`toolu_${index}`)], 'tool_use'));
        // Each request "takes" 1,000 seconds.
        const fetch = jest.fn(async () => { clock += 1_000_000; return responses.shift()!; });
        // A permit wait and a crop "take" far longer, and count for nothing.
        const limiter = { acquire: async () => { clock += 5_000_000; return () => undefined; } } as unknown as Semaphore;
        const instance = new ClaudePageClient({ ...config, OCR_AI_HARD_PAGE_TIMEOUT_MS: 900_000 },
          { fetch: fetch as unknown as typeof globalThis.fetch, now: () => clock, limiter });
        const zoom: PageZoom = { available: () => true, crop: async () => { clock += 5_000_000; return { kind: 'crop', crop }; } };
        const error = await instance.readPage({ ...hardRequest, zoom: createZoomSession(zoom, 1, 8, 0) },
          new AbortController().signal).catch((caught: unknown) => caught);
        // OCR_AI_MAX_RETRIES 3: a budget of 4 x 900 seconds; each attempt at most one hard-page timeout.
        expect(timeouts).toEqual([900_000, 900_000, 900_000, 600_000]);
        expect(error).toBeInstanceOf(AiTransientError);
        expect(error).toMatchObject({ code: 'AI_TIMEOUT', attempts: 4 });
        expect(fetch).toHaveBeenCalledTimes(4);
      } finally { spy.mockRestore(); }
    });

    describe('hard-page bounds (coordinator 2026-11-10)', () => {
      type Sent = { max_tokens: number; output_config: { effort: string } };
      const sent = (fetch: jest.Mock) => fetch.mock.calls.map((call) =>
        JSON.parse(String((call as [unknown, RequestInit])[1].body)) as Sent);
      const bounded = (responses: Response[], cap?: number) => {
        const fetch = jest.fn(async (_url: unknown, _init?: RequestInit) => responses.shift()!);
        const instance = new ClaudePageClient({ ...config, OCR_AI_MAX_TOKENS: 64_000,
          ...(cap === undefined ? {} : { OCR_AI_HARD_PAGE_MAX_TOKENS: cap }) },
        { fetch: fetch as unknown as typeof globalThis.fetch, sleep: jest.fn().mockResolvedValue(undefined) });
        return { instance, fetch };
      };

      it('runs the turns after a zoom result at the follow-up effort, the first at the hard-page effort', async () => {
        const { instance, fetch } = bounded([turn([thinking('sig-1'), zoomCall('toolu_a')], 'tool_use'),
          turn([thinking('sig-2'), zoomCall('toolu_b')], 'tool_use'), final()], 32_000);
        const trace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
        await expect(instance.readPage({ ...hardRequest, followupEffort: 'high', trace,
          zoom: createZoomSession(goodZoom, 1, 4, 0) }, new AbortController().signal))
          .resolves.toMatchObject({ kind: 'answer', attempts: 3 });
        expect(sent(fetch).map((body) => body.output_config.effort)).toEqual(['max', 'high', 'high']);
        expect(trace).toEqual({ turns: 3, followupTurns: 2, cutAttempts: 0 });
        // The thinking blocks of the 'max' turns go back unchanged on the 'high' turns (append-only history).
        const third = JSON.parse(String((fetch.mock.calls[2] as [unknown, RequestInit])[1].body)) as Body;
        expect(third.messages[1]!.content).toEqual(expect.arrayContaining([{ type: 'thinking', thinking: '', signature: 'sig-1' }]));
        expect(third.messages[3]!.content).toEqual(expect.arrayContaining([{ type: 'thinking', thinking: '', signature: 'sig-2' }]));
        // Not given: one effort for the whole read.
        const same = bounded([turn([zoomCall('toolu_a')], 'tool_use'), final()], 32_000);
        await same.instance.readPage({ ...hardRequest, zoom: createZoomSession(goodZoom, 1, 4, 0) }, new AbortController().signal);
        expect(sent(same.fetch).map((body) => body.output_config.effort)).toEqual(['max', 'max']);
      });

      it('holds a read\'s output tokens over all its turns to OCR_AI_HARD_PAGE_MAX_TOKENS, keeping the answer reserve', async () => {
        // Two tool turns "write" 10,000 output tokens each and a third its whole max_tokens: every turn's max_tokens is
        // what is left of the read's 32,000 less the 8,000 kept for the answer, so the answer-only turn still has them.
        const { instance, fetch } = bounded([turn([zoomCall('toolu_a')], 'tool_use', 5_000, 10_000),
          turn([zoomCall('toolu_b')], 'tool_use', 5_000, 10_000), turn([zoomCall('toolu_c')], 'tool_use', 5_000, 4_000),
          final()], 32_000);
        const trace: HardReadTrace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
        const result = await instance.readPage({ ...hardRequest, trace, zoom: createZoomSession(goodZoom, 1, 4, 0) },
          new AbortController().signal);
        expect(HARD_READ_ANSWER_RESERVE_TOKENS).toBe(8_000);
        expect(sent(fetch).map((body) => body.max_tokens)).toEqual([24_000, 14_000, 4_000, 8_000]);
        expect(sent(fetch).map((body) => body.output_config.effort)).toEqual(['max', 'max', 'max', 'low']);
        // The answer-only turn: tool still declared (earlier turns hold tool_use blocks), but not offered.
        const last = bodies(fetch)[3]!;
        expect(last.tools).toEqual([ZOOM_TOOL]);
        expect(last.tool_choice).toEqual({ type: 'none' });
        expect(result).toMatchObject({ kind: 'answer', attempts: 4, usage: { outputTokens: 24_700 } });
        expect(trace.forced).toBe('budget');
        expect(HARD_READ_MIN_TURN_TOKENS).toBe(2_048);
        // A hard page without zoom: its one turn keeps the reserve too (24,000 less 8,000); no tool on any turn. Any
        // other request keeps OCR_AI_MAX_TOKENS.
        const plain = bounded([sse(JSON.stringify(hardAnswer)), sse(JSON.stringify(answer))], 24_000);
        await plain.instance.readPage(hardRequest, new AbortController().signal);
        await plain.instance.readPage({ model: 'claude-opus-5-5', effort: 'high', page: 1, lines }, new AbortController().signal);
        expect(sent(plain.fetch).map((body) => body.max_tokens)).toEqual([16_000, 64_000]);
        // Not configured (a client built without it): OCR_AI_MAX_TOKENS less the reserve.
        const unset = bounded([sse(JSON.stringify(hardAnswer))]);
        await unset.instance.readPage(hardRequest, new AbortController().signal);
        expect(sent(unset.fetch)[0]!.max_tokens).toBe(56_000);
        // A cap of 4,096: the reserve is at most half of it.
        const small = bounded([sse('', 'max_tokens'), sse(JSON.stringify(hardAnswer))], 4_096);
        const cut: HardReadTrace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
        await expect(small.instance.readPage({ ...hardRequest, trace: cut }, new AbortController().signal))
          .resolves.toMatchObject({ kind: 'answer', attempts: 2 });
        expect(sent(small.fetch).map((body) => body.max_tokens)).toEqual([2_048, 2_048]);
        expect(cut.forced).toBe('max_tokens');
        expect(bodies(small.fetch)[1]).not.toHaveProperty('tool_choice');
      });

      it('sends the answer-only turn at once when the page\'s deadline is within the answer\'s time reserve', async () => {
        const { instance, fetch } = bounded([final()], 32_000);
        const trace: HardReadTrace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
        // 69 s left with 50 s kept for the answer: 19 s is too little for a turn to finish.
        await expect(instance.readPage({ ...hardRequest, trace, zoom: createZoomSession(goodZoom, 1, 4, 0),
          answerBy: { timeLeftMs: () => 50_000 + HARD_READ_MIN_TURN_MS - 1_000, reserveMs: 50_000 } },
        new AbortController().signal)).resolves.toMatchObject({ kind: 'answer', attempts: 1 });
        expect(trace).toEqual({ turns: 1, followupTurns: 0, cutAttempts: 0, forced: 'deadline' });
        const only = bodies(fetch)[0]!;
        expect(only.tool_choice).toEqual({ type: 'none' });
        expect(only.max_tokens).toBe(8_000);
        expect(only.messages).toHaveLength(2);
      });

      it('cuts a turn at the start of the answer\'s time reserve (no retry) and sends the answer-only turn', async () => {
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeouts: number[] = [];
        // The first attempt's timeout (the reserve's) fires after 30 ms; later ones are long.
        const spy = jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
          timeouts.push(ms);
          return realTimeout(timeouts.length === 1 ? 30 : 60_000);
        });
        try {
          const responses: Array<(init?: RequestInit) => Response> = [(init) => begunThenHang(init), () => final()];
          const fetch = jest.fn(async (_url: unknown, init?: RequestInit) => responses.shift()!(init));
          const instance = new ClaudePageClient({ ...config, OCR_AI_HARD_PAGE_MAX_TOKENS: 32_000,
            OCR_AI_HARD_PAGE_TIMEOUT_MS: 900_000 },
          { fetch: fetch as unknown as typeof globalThis.fetch, sleep: jest.fn().mockResolvedValue(undefined) });
          const trace: HardReadTrace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
          const result = await instance.readPage({ ...hardRequest, trace, zoom: createZoomSession(goodZoom, 1, 4, 0),
            answerBy: { timeLeftMs: () => 150_000, reserveMs: 50_000 } }, new AbortController().signal);
          expect(result).toMatchObject({ kind: 'answer', attempts: 2 });
          // The first turn's timeout is the time to the reserve (100 s); the answer-only turn's is the request's own.
          expect(timeouts).toEqual([100_000, 900_000]);
          expect(trace).toEqual({ turns: 1, followupTurns: 0, cutAttempts: 1, forced: 'deadline' });
          expect(fetch).toHaveBeenCalledTimes(2);
        } finally { spy.mockRestore(); }
      });

      /** A turn whose answer has begun (message_start, then 5,000 characters of thinking) and then hangs until aborted. */
      const begunThenHang = (init?: RequestInit) => {
        const encoder = new TextEncoder();
        const event = (name: string, data: unknown) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(event('message_start', { type: 'message_start', message: { id: 'msg_cut', type: 'message',
            role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
            stop_details: null, usage: { input_tokens: 5_000, output_tokens: 1 } } }));
          controller.enqueue(event('content_block_start', { type: 'content_block_start', index: 0,
            content_block: { type: 'thinking', thinking: '', signature: '' } }));
          controller.enqueue(event('content_block_delta', { type: 'content_block_delta', index: 0,
            delta: { type: 'thinking_delta', thinking: 'x'.repeat(5_000) } }));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
        } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };

      it('marks a read cut mid-answer: its reported output tokens are only a lower bound', async () => {
        const fetch = jest.fn(async (_url: unknown, init?: RequestInit) => begunThenHang(init));
        const instance = new ClaudePageClient({ ...config, OCR_AI_HARD_PAGE_MAX_TOKENS: 32_000 },
          { fetch: fetch as unknown as typeof globalThis.fetch });
        const controller = new AbortController();
        const trace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
        setTimeout(() => controller.abort(new Error('deadline')), 50);
        const error = await instance.readPage({ ...hardRequest, trace }, controller.signal).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AiInterruptedError);
        // The stream reported only message_start's 1 output token; the thinking already generated is not in it.
        expect(error).toMatchObject({ attempts: 1, usage: { inputTokens: 5_000, outputTokens: 1 } });
        expect(trace).toEqual({ turns: 0, followupTurns: 0, cutAttempts: 1 });
        // An attempt refused before its answer began (an HTTP 529) is not a cut attempt.
        const refused = bounded([failure(529, 'overloaded_error'), sse(JSON.stringify(hardAnswer))], 32_000);
        const clean = { turns: 0, followupTurns: 0, cutAttempts: 0 };
        await refused.instance.readPage({ ...hardRequest, trace: clean }, new AbortController().signal);
        expect(clean).toEqual({ turns: 1, followupTurns: 0, cutAttempts: 0 });
      });

      it('sends each retry of a turn the same max_tokens: the token cap bounds an attempt, the deadline the read', async () => {
        const { instance, fetch } = bounded([brokenStream(), brokenStream(), sse(JSON.stringify(hardAnswer))], 32_000);
        const trace = { turns: 0, followupTurns: 0, cutAttempts: 0 };
        await expect(instance.readPage({ ...hardRequest, trace, zoom: createZoomSession(goodZoom, 1, 4, 0) },
          new AbortController().signal)).resolves.toMatchObject({ kind: 'answer', attempts: 3 });
        expect(sent(fetch).map((body) => body.max_tokens)).toEqual([24_000, 24_000, 24_000]);
        expect(trace).toEqual({ turns: 1, followupTurns: 0, cutAttempts: 2 });
      });
    });

    it('keeps the crops out of errors, and gives no tool to other requests', async () => {
      const { instance } = client([turn([zoomCall('toolu_a')], 'tool_use'), failure(400, 'invalid_request_error')]);
      const error = await instance.readPage({ ...hardRequest, zoom: createZoomSession(goodZoom, 1, 8, 0) },
        new AbortController().signal).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiRejectedError);
      expect(error).toMatchObject({ attempts: 2 });
      expect(`${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`).not.toContain(CROP.slice(20, 60));
      // A zoom given to a request that is not a hard page, or a hard page with zoom at 0 calls: no tool, one request.
      const box = { x1: 124, y1: 175, x2: 496, y2: 210 };
      const imageAnswer = { ...answer, items: answer.items.map((item) => ({ ...item, box })) };
      const other = client([sse(JSON.stringify(imageAnswer)), sse(JSON.stringify(hardAnswer)), sse(JSON.stringify(answer))]);
      const signal = new AbortController().signal;
      const session = createZoomSession(goodZoom, 1, 8, 0);
      await other.instance.readPage({ ...hardRequest, hardPage: false, zoom: session }, signal);
      await other.instance.readPage({ ...hardRequest, zoom: createZoomSession(goodZoom, 1, 0, 0) }, signal);
      await other.instance.readPage({ model: 'claude-opus-5-5', effort: 'high', page: 1, lines, zoom: session }, signal);
      for (const body of bodies(other.fetch)) {
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('cache_control');
        expect(JSON.stringify(body)).not.toContain('zoom');
      }
    });
  });
});
