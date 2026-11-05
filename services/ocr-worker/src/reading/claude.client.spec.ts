import { createHash } from 'node:crypto';
import { AiInterruptedError, AiRejectedError, AiTransientError, ClaudePageClient, retryAfterMs } from './claude.client';
import { readOcrWorkerConfig } from '../config';
import { Semaphore } from '../semaphore';
import { HIGH_RESOLUTION_TIER, resizedSize, STANDARD_TIER } from './page-image';
import { MODEL_OUTPUT_IMAGE_JSON_SCHEMA, MODEL_OUTPUT_JSON_SCHEMA, SYSTEM_PROMPT } from './prompt';
import { fixturePng, modelItem, modelPage } from './test-fixtures';

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

    it('never puts the picture in an error', async () => {
      const { instance } = client([failure(400, 'invalid_request_error')]);
      const error = await instance.readPage({ ...pinned, image }, new AbortController().signal).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiRejectedError);
      const shown = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;
      expect(shown).not.toContain(image.base64.slice(100, 140));
    });
  });
});
