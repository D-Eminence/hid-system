import Anthropic, {
  APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError, BadRequestError,
  InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError,
} from '@anthropic-ai/sdk';
import { ANSWER_JSON_SCHEMA } from './answer-validator';
import {
  ClaudeRecordChatClient, OUTPUT_CHARACTER_LIMIT, RecordChatProcessorError, clientOptions, messageParams,
  processorFailure, type SdkFactory,
} from './claude-record-chat.client';
import type { EnabledRecordChatConfig } from './record-chat.config';

// A placeholder that is clearly not a real model id.
const MODEL = 'synthetic-test-model';
const config: EnabledRecordChatConfig = {
  patientEnabled: true, staffEnabled: false, modelId: MODEL, apiKey: 'synthetic-api-key-0123456789abcdef', baseUrl: 'https://api.anthropic.com',
  inferenceGeo: 'us', maxOutputTokens: 4096, deadlineMs: 25_000, maxRetries: 0, maxEvidenceChars: 40_000,
  dailyTokenBudget: 2_000_000, noticeVersion: 'notice-1', auditDigestKey: Buffer.alloc(32, 1),
};
const request = { systemPrompt: 'SYSTEM', userBlocks: ['{"extract":{}}', '{"question":"q"}'] };
const headers = new Headers();

function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_synthetic_0001', type: 'message', role: 'assistant', model: MODEL, stop_reason: 'end_turn',
    stop_sequence: null, stop_details: null, container: null, context_management: null, diagnostics: null,
    content: [{ type: 'text', text: '{"status":"answered","blocks":[]}', citations: null }],
    usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 400, cache_creation_input_tokens: 0,
      inference_geo: 'us' },
    ...overrides,
  } as unknown as Anthropic.Message;
}

/** A fake SDK: records the options, the request and the stream use; answers as told. */
function fakeSdk(answer: { message?: Anthropic.Message; error?: unknown; deltas?: string[] } = {},
  model: unknown = { id: MODEL, capabilities: { structured_outputs: { supported: true },
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } } } }) {
  const calls = { options: [] as unknown[], params: [] as unknown[], requestOptions: [] as unknown[], aborted: 0,
    finalMessage: 0, retrieved: [] as unknown[] };
  const factory: SdkFactory = (options) => {
    calls.options.push(options);
    return {
      messages: {
        stream: (params: unknown, requestOptions: unknown) => {
          calls.params.push(params);
          calls.requestOptions.push(requestOptions);
          let onText: ((delta: string) => void) | undefined;
          let aborted = false;
          return {
            on: (event: string, listener: (delta: string) => void) => { if (event === 'text') onText = listener; },
            abort: () => { aborted = true; calls.aborted += 1; },
            finalMessage: async () => {
              calls.finalMessage += 1;
              for (const delta of answer.deltas ?? []) {
                onText?.(delta);
                if (aborted) throw new APIUserAbortError();
              }
              if (answer.error) throw answer.error;
              return answer.message ?? message();
            },
          };
        },
      },
      models: {
        retrieve: async (...args: unknown[]) => {
          calls.retrieved.push(args);
          if (model instanceof Error) throw model;
          return model;
        },
      },
    } as unknown as ReturnType<SdkFactory>;
  };
  return { factory, calls };
}

const later = () => Date.now() + 20_000;

describe('ClaudeRecordChatClient', () => {
  it('builds the SDK client with every option explicit and SDK logging off', async () => {
    const sdk = fakeSdk();
    await new ClaudeRecordChatClient(config, sdk.factory).ask(request, later());
    expect(sdk.calls.options).toHaveLength(1);
    const options = sdk.calls.options[0] as Record<string, unknown>;
    expect(options).toMatchObject({ apiKey: config.apiKey, authToken: null, webhookKey: null,
      baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 25_000, logLevel: 'off' });
    const logger = options.logger as Record<string, (message: string) => unknown>;
    expect(Object.keys(logger).sort()).toEqual(['debug', 'error', 'info', 'warn']);
  });

  it('never reads the SDK\'s ambient credential, base URL or log level from the environment', () => {
    const ambient = { ANTHROPIC_API_KEY: 'ambient-key', ANTHROPIC_AUTH_TOKEN: 'ambient-token',
      ANTHROPIC_BASE_URL: 'https://ambient.example.invalid', ANTHROPIC_LOG: 'debug' };
    const saved = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
    Object.assign(process.env, ambient);
    try {
      const client = new Anthropic(clientOptions(config));
      expect(client.apiKey).toBe(config.apiKey);
      expect(client.authToken).toBeNull();
      expect(client.baseURL).toBe('https://api.anthropic.com');
      expect(client.logLevel).toBe('off');
      expect(client.maxRetries).toBe(0);
      expect(client.timeout).toBe(25_000);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('sends exactly the configured model, max_tokens and geography, the cached system block and the JSON schema', async () => {
    const sdk = fakeSdk();
    await new ClaudeRecordChatClient(config, sdk.factory).ask(request, later());
    expect(sdk.calls.params).toEqual([{
      model: MODEL, max_tokens: 4096, inference_geo: 'us',
      system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: '{"extract":{}}' }, { type: 'text', text: '{"question":"q"}' }] }],
      output_config: { format: { type: 'json_schema', schema: ANSWER_JSON_SCHEMA } },
    }]);
    const params = sdk.calls.params[0] as Record<string, unknown>;
    for (const absent of ['tools', 'tool_choice', 'thinking', 'temperature', 'top_p', 'top_k', 'fallbacks', 'metadata',
      'betas', 'stop_sequences', 'service_tier']) {
      expect(Object.hasOwn(params, absent)).toBe(false);
    }
    expect(sdk.calls.finalMessage).toBe(1);
    expect(sdk.calls.requestOptions[0]).toMatchObject({ maxRetries: 0, signal: expect.any(AbortSignal) });
  });

  it('adds effort only when configured', () => {
    expect((messageParams({ ...config, effort: 'low' }, request).output_config as Record<string, unknown>).effort).toBe('low');
    expect(Object.hasOwn(messageParams(config, request).output_config as object, 'effort')).toBe(false);
  });

  it('reads the text blocks of an end_turn answer only, ignoring thinking blocks, with the usage and served geography', async () => {
    const sdk = fakeSdk({ message: message({ content: [
      { type: 'thinking', thinking: 'internal reasoning text', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: '{"status":', citations: null }, { type: 'text', text: '"answered"}', citations: null },
    ] as unknown as Anthropic.Message['content'] }) });
    const result = await new ClaudeRecordChatClient(config, sdk.factory).ask(request, later());
    expect(result).toEqual({ kind: 'answer', text: '{"status":"answered"}', stopReason: 'end_turn',
      processorMessageId: 'msg_synthetic_0001', usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 400,
        cacheWriteTokens: 0, servedGeo: 'us' } });
  });

  it('maps a refusal stop reason to a refusal with its category, and other stop reasons to incomplete', async () => {
    const refused = await new ClaudeRecordChatClient(config, fakeSdk({ message: message({ stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'bio', explanation: 'not kept' } as Anthropic.Message['stop_details'],
      content: [] }) }).factory).ask(request, later());
    expect(refused).toMatchObject({ kind: 'refusal', refusalCategory: 'bio' });
    expect(JSON.stringify(refused)).not.toContain('not kept');
    for (const stop of ['max_tokens', 'pause_turn', 'tool_use', 'model_context_window_exceeded']) {
      const incomplete = await new ClaudeRecordChatClient(config, fakeSdk({ message: message({
        stop_reason: stop as Anthropic.Message['stop_reason'] }) }).factory).ask(request, later());
      expect(incomplete).toMatchObject({ kind: 'incomplete', stopReason: stop });
    }
  });

  it('keeps only known values of the served geography and the refusal category, for the audit row', async () => {
    const odd = await new ClaudeRecordChatClient(config, fakeSdk({ message: message({ usage: { input_tokens: 1,
      output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, inference_geo: 'x'.repeat(500) },
    } as unknown as Partial<Anthropic.Message>) }).factory).ask(request, later());
    expect(odd).toMatchObject({ usage: { servedGeo: 'other' } });
    const global = await new ClaudeRecordChatClient(config, fakeSdk({ message: message({ usage: { input_tokens: 1,
      output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, inference_geo: 'global' },
    } as unknown as Partial<Anthropic.Message>) }).factory).ask(request, later());
    expect(global).toMatchObject({ usage: { servedGeo: 'global' } });
    const refused = await new ClaudeRecordChatClient(config, fakeSdk({ message: message({ stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'y'.repeat(500), explanation: null } as unknown as
        Anthropic.Message['stop_details'], content: [] }) }).factory).ask(request, later());
    expect(refused).toMatchObject({ kind: 'refusal', refusalCategory: 'other' });
    for (const category of ['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms']) {
      const known = await new ClaudeRecordChatClient(config, fakeSdk({ message: message({ stop_reason: 'refusal',
        stop_details: { type: 'refusal', category, explanation: null } as unknown as Anthropic.Message['stop_details'],
        content: [] }) }).factory).ask(request, later());
      expect(known).toMatchObject({ refusalCategory: category });
    }
  });

  it('aborts the stream when the visible output passes its bound', async () => {
    const sdk = fakeSdk({ deltas: ['a'.repeat(OUTPUT_CHARACTER_LIMIT), 'b'] });
    await expect(new ClaudeRecordChatClient(config, sdk.factory).ask(request, later()))
      .rejects.toMatchObject({ reason: 'output_too_large' });
    expect(sdk.calls.aborted).toBe(1);
  });

  it('aborts at the deadline', async () => {
    const factory: SdkFactory = () => ({
      messages: { stream: (_params: unknown, options: { signal: AbortSignal }) => ({
        on: () => undefined, abort: () => undefined,
        finalMessage: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new APIUserAbortError()));
        }),
      }) },
      models: { retrieve: async () => ({}) },
    }) as unknown as ReturnType<SdkFactory>;
    await expect(new ClaudeRecordChatClient(config, factory).ask(request, Date.now() + 30))
      .rejects.toMatchObject({ reason: 'timeout' });
    await expect(new ClaudeRecordChatClient(config, factory).ask(request, Date.now() - 1))
      .rejects.toMatchObject({ reason: 'timeout' });
  });

  it.each([
    ['a user abort', new APIUserAbortError(), 'timeout'],
    ['a connection timeout', new APIConnectionTimeoutError(), 'timeout'],
    ['a connection error', new APIConnectionError({ message: 'secret detail' }), 'network'],
    ['a rate limit', new RateLimitError(429, { message: 'secret detail' }, 'secret detail', headers), 'processor_rate_limited'],
    ['an authentication error', new AuthenticationError(401, {}, 'secret detail', headers), 'processor_credentials'],
    ['a permission error', new PermissionDeniedError(403, {}, 'secret detail', headers), 'processor_credentials'],
    ['a missing model', new NotFoundError(404, {}, 'model: secret detail', headers), 'model_unavailable'],
    ['a rejected request', new BadRequestError(400, {}, 'secret detail', headers), 'processor_rejected'],
    ['a server error', new InternalServerError(529, {}, 'secret detail', headers), 'processor_error'],
    ['another API error', new APIError(418, {}, 'secret detail', headers), 'processor_rejected'],
    ['anything else', new Error('secret detail'), 'processor_error'],
  ])('maps %s to its reason code, without the SDK\'s message', async (_label, error, reason) => {
    const failure = processorFailure(error);
    expect(failure).toBeInstanceOf(RecordChatProcessorError);
    expect(failure.reason).toBe(reason);
    expect(failure.message).not.toContain('secret detail');
    await expect(new ClaudeRecordChatClient(config, fakeSdk({ error }).factory).ask(request, later()))
      .rejects.toMatchObject({ reason });
  });

  it('checks the model once an hour through the Models API: present, with structured outputs and the configured effort', async () => {
    const sdk = fakeSdk();
    const client = new ClaudeRecordChatClient({ ...config, effort: 'low' }, sdk.factory);
    await client.ensureReady(later());
    await client.ensureReady(later());
    expect(sdk.calls.retrieved).toHaveLength(1);
    expect((sdk.calls.retrieved[0] as unknown[])[0]).toBe(MODEL);
  });

  it.each([
    ['a missing model', new NotFoundError(404, {}, 'model', headers), 'model_unavailable'],
    ['a model without structured outputs', { id: MODEL, capabilities: { structured_outputs: { supported: false } } },
      'model_unsupported'],
    ['a model without capabilities', { id: MODEL, capabilities: null }, 'model_unsupported'],
    ['a model without the configured effort', { id: MODEL, capabilities: { structured_outputs: { supported: true },
      effort: { supported: true, low: { supported: false } } } }, 'model_unsupported'],
  ])('refuses %s before any record is sent', async (_label, model, reason) => {
    const sdk = fakeSdk({}, model);
    await expect(new ClaudeRecordChatClient({ ...config, effort: 'low' }, sdk.factory).ensureReady(later()))
      .rejects.toMatchObject({ reason });
    expect(sdk.calls.params).toHaveLength(0);
  });
});
