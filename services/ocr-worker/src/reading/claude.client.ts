import Anthropic from '@anthropic-ai/sdk';
import { abortableDelay, fullJitterDelayMs, type Sleep } from '../backoff';
import type { OcrWorkerConfig } from '../config';
import { MODEL_OUTPUT_JSON_SCHEMA, modelPageSchema, pageMessage, SYSTEM_PROMPT, type ModelPage } from './prompt';

/** The Claude API, always at its own endpoint: ANTHROPIC_BASE_URL is never read. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const INFERENCE_GEO = 'global';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PageLinesForModel { id: string; text: string; confidence: number; handwritten: boolean }

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type PageAnswer =
  | { kind: 'answer'; answer: ModelPage; usage: TokenUsage; servedInferenceGeo: string | null; attempts: number }
  | { kind: 'refused'; usage: TokenUsage; attempts: number }
  | { kind: 'failed'; reason: 'max_tokens' | 'malformed' | 'incomplete'; usage: TokenUsage; attempts: number };

/** The AI step could not be reached after its retries: try the job again later. */
export class AiTransientError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AiTransientError'; }
}
/** The API refused the request itself (bad request, key, permission, model): retrying will not help. */
export class AiRejectedError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AiRejectedError'; }
}

export interface PageModelClient {
  readPage(request: { model: string; effort: Effort; page: number; lines: readonly PageLinesForModel[] },
    signal: AbortSignal): Promise<PageAnswer>;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const RETRYABLE_STREAM_ERROR_TYPES = new Set(['overloaded_error', 'api_error', 'rate_limit_error']);
const BACKOFF = { baseMs: 1_000, capMs: 30_000 };
const MAX_RETRY_AFTER_MS = 60_000;

export interface ClaudeClientOptions {
  /** Tests inject a fake fetch; production uses the global fetch. */
  fetch?: typeof fetch;
  sleep?: Sleep;
  random?: () => number;
}

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

export class ClaudePageClient implements PageModelClient {
  private readonly client: Anthropic;
  private readonly sleep: Sleep;
  private readonly random: () => number;

  constructor(private readonly config: Pick<OcrWorkerConfig, 'ANTHROPIC_API_KEY' | 'OCR_AI_MAX_TOKENS'
    | 'OCR_AI_TIMEOUT_MS' | 'OCR_AI_MAX_RETRIES'>, options: ClaudeClientOptions = {}) {
    if (!config.ANTHROPIC_API_KEY) throw new Error('AI reading requires an API key');
    // apiKey given in code: the SDK reads no other credential from the environment. baseURL is fixed so an
    // inherited ANTHROPIC_BASE_URL cannot send pages elsewhere. Retries are ours (maxRetries 0), and the SDK
    // logger is silenced so no request or error detail reaches the worker's logs.
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, baseURL: ANTHROPIC_BASE_URL,
      webhookKey: null, maxRetries: 0, timeout: config.OCR_AI_TIMEOUT_MS, logLevel: 'off', logger: silentLogger,
      ...(options.fetch ? { fetch: options.fetch } : {}) });
    this.sleep = options.sleep ?? abortableDelay;
    this.random = options.random ?? Math.random;
  }

  async readPage(request: { model: string; effort: Effort; page: number; lines: readonly PageLinesForModel[] },
    signal: AbortSignal): Promise<PageAnswer> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: this.config.OCR_AI_MAX_TOKENS,
      inference_geo: INFERENCE_GEO,
      thinking: { type: 'adaptive' },
      output_config: { effort: request.effort, format: { type: 'json_schema', schema: { ...MODEL_OUTPUT_JSON_SCHEMA } } },
      // Frozen prefix: the same bytes for every page and document, cached.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: pageMessage(request.page, request.lines) }],
    };
    const maxAttempts = this.config.OCR_AI_MAX_RETRIES + 1;
    for (let attempt = 1; ; attempt += 1) {
      const timeout = AbortSignal.timeout(this.config.OCR_AI_TIMEOUT_MS);
      try {
        // Streaming, so a long adaptive-thinking answer is never cut by an idle HTTP connection.
        const message = await this.client.messages.stream(params, { signal: AbortSignal.any([signal, timeout]) })
          .finalMessage();
        return interpret(message, attempt);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const decision = classify(error, timeout.aborted);
        if (decision.kind === 'rejected') throw new AiRejectedError(decision.code);
        if (attempt >= maxAttempts) throw new AiTransientError(decision.code);
        const jitter = fullJitterDelayMs(attempt - 1, { ...BACKOFF, random: this.random });
        await this.sleep(decision.retryAfterMs === null ? jitter : Math.max(decision.retryAfterMs, jitter), signal);
      }
    }
  }
}

function usageOf(message: Anthropic.Message): TokenUsage {
  return { inputTokens: message.usage.input_tokens ?? 0, outputTokens: message.usage.output_tokens ?? 0,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0 };
}

/** stop_reason first, content after: a refusal or a cut-off answer is never parsed as one. */
export function interpret(message: Anthropic.Message, attempts: number): PageAnswer {
  const usage = usageOf(message);
  if (message.stop_reason === 'refusal') return { kind: 'refused', usage, attempts };
  if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
    return { kind: 'failed', reason: 'max_tokens', usage, attempts };
  }
  if (message.stop_reason !== 'end_turn') return { kind: 'failed', reason: 'incomplete', usage, attempts };
  const text = message.content.filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text).join('');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { kind: 'failed', reason: 'malformed', usage, attempts }; }
  const answer = modelPageSchema.safeParse(parsed);
  if (!answer.success) return { kind: 'failed', reason: 'malformed', usage, attempts };
  return { kind: 'answer', answer: answer.data, usage, attempts,
    servedInferenceGeo: message.usage.inference_geo ?? null };
}

type Decision = { kind: 'retry'; code: string; retryAfterMs: number | null } | { kind: 'rejected'; code: string };

/** Typed SDK errors only; never the message text. */
export function classify(error: unknown, timedOut: boolean): Decision {
  if (error instanceof Anthropic.APIUserAbortError) {
    return timedOut ? { kind: 'retry', code: 'AI_TIMEOUT', retryAfterMs: null }
      : { kind: 'retry', code: 'AI_ABORTED', retryAfterMs: null };
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'retry', code: 'AI_TIMEOUT', retryAfterMs: null };
  if (error instanceof Anthropic.APIConnectionError) return { kind: 'retry', code: 'AI_CONNECTION', retryAfterMs: null };
  if (error instanceof Anthropic.AuthenticationError) return { kind: 'rejected', code: 'AI_NOT_AUTHENTICATED' };
  if (error instanceof Anthropic.PermissionDeniedError) return { kind: 'rejected', code: 'AI_NOT_PERMITTED' };
  if (error instanceof Anthropic.NotFoundError) return { kind: 'rejected', code: 'AI_MODEL_NOT_FOUND' };
  if (error instanceof Anthropic.BadRequestError) return { kind: 'rejected', code: 'AI_BAD_REQUEST' };
  if (error instanceof Anthropic.APIError) {
    if (typeof error.status === 'number') {
      return RETRYABLE_STATUSES.has(error.status)
        ? { kind: 'retry', code: `AI_HTTP_${error.status}`, retryAfterMs: retryAfterMs(error.headers) }
        : { kind: 'rejected', code: `AI_HTTP_${error.status}` };
    }
    // An error event inside a stream that had already started (no HTTP status).
    return error.type !== null && RETRYABLE_STREAM_ERROR_TYPES.has(error.type)
      ? { kind: 'retry', code: 'AI_STREAM_ERROR', retryAfterMs: null }
      : { kind: 'rejected', code: 'AI_STREAM_ERROR' };
  }
  if (error instanceof Anthropic.AnthropicError) return { kind: 'rejected', code: 'AI_CLIENT_ERROR' };
  return { kind: 'retry', code: 'AI_UNEXPECTED', retryAfterMs: null };
}

/** retry-after in seconds (or an HTTP date), bounded; retry-after-ms when the API sends it. */
export function retryAfterMs(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const milliseconds = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') !== null && Number.isFinite(milliseconds) && milliseconds >= 0) {
    return Math.min(milliseconds, MAX_RETRY_AFTER_MS);
  }
  const header = headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}
