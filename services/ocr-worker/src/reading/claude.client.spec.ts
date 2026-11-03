import { AiRejectedError, AiTransientError, ClaudePageClient, retryAfterMs } from './claude.client';
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
    await expect(instance.readPage(request, new AbortController().signal)).resolves.toMatchObject({ kind: 'answer', attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops at once when the worker shuts down', async () => {
    const controller = new AbortController();
    const { instance, fetch } = client([failure(529, 'overloaded_error'), sse(JSON.stringify(answer))]);
    controller.abort(new Error('worker shutdown'));
    await expect(instance.readPage(request, controller.signal)).rejects.toThrow('worker shutdown');
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
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
});
