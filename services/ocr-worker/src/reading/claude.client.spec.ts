import { AiInterruptedError, AiRejectedError, AiTransientError, ClaudePageClient, retryAfterMs } from './claude.client';
import { Semaphore } from '../semaphore';
import { SYSTEM_PROMPT } from './prompt';
import { modelItem, modelPage } from './test-fixtures';

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
        inference_geo: 'global' } } }],
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

  it('sends one page to the fixed Claude API endpoint with global inference, adaptive thinking and a JSON schema', async () => {
    const { instance, fetch } = client([sse(JSON.stringify(answer))]);
    const result = await instance.readPage(request, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'answer', attempts: 1, servedInferenceGeo: 'global',
      usage: { inputTokens: 120, outputTokens: 300, cacheReadInputTokens: 900 } });
    expect(result.kind === 'answer' && result.answer.items[0]!.asWritten).toBe('Hypertension');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const headers = new Headers(init!.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16_000, inference_geo: 'global',
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
});
