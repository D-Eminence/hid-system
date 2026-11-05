import Anthropic from '@anthropic-ai/sdk';
import { abortableDelay, fullJitterDelayMs, type Sleep } from '../backoff';
import type { OcrWorkerConfig } from '../config';
import { Semaphore } from '../semaphore';
import { imageTierOf, resizedSize, type PageImage } from './page-image';
import { imagePageMessage, MODEL_OUTPUT_IMAGE_JSON_SCHEMA, MODEL_OUTPUT_JSON_SCHEMA, modelImagePageSchema,
  modelPageSchema, pageMessage, SYSTEM_PROMPT, toFractionBox, type ModelPage } from './prompt';

/** The Claude API, always at its own endpoint: ANTHROPIC_BASE_URL is never read. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const INFERENCE_GEO = 'us';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A line as the model is given it. The box is sent only with the picture (image re-read). */
export interface PageLinesForModel { id: string; text: string; confidence: number; handwritten: boolean;
  box?: { left: number; top: number; width: number; height: number } | null }

/**
 * One page for the model. `image` (a hard page's re-read only) adds the picture of the page: the user turn is then
 * [image, text], the text lists the lines with their boxes and the answer schema gives each item a box. Without it
 * the request is exactly the text-only request. The picture is never logged, stored or put in an error.
 */
export interface PageRequest { model: string; effort: Effort; page: number; lines: readonly PageLinesForModel[];
  image?: PageImage }

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

const noUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

/**
 * What a call that ended without an answer still used: every HTTP attempt it made (each one is a request that
 * may be billed) and the tokens the API had already reported on any of them (a stream cut off mid-answer).
 */
export interface AiCallUse { readonly attempts: number; readonly usage: TokenUsage }

/** The AI step could not be reached after its retries: try the job again later. */
export class AiTransientError extends Error implements AiCallUse {
  constructor(readonly code: string, readonly attempts = 0, readonly usage: TokenUsage = noUsage()) {
    super(code); this.name = 'AiTransientError';
  }
}
/**
 * The API refused the request itself (bad request, key, permission, model): retrying will not help.
 * `invalidRequest` is true only for a 400 whose error type is invalid_request_error: the one rejection a request
 * with the picture can cause that the same request without it would not.
 */
export class AiRejectedError extends Error implements AiCallUse {
  constructor(readonly code: string, readonly attempts = 0, readonly usage: TokenUsage = noUsage(),
    readonly invalidRequest = false) {
    super(code); this.name = 'AiRejectedError';
  }
}
/**
 * The worker shut down during a call. `reason` is the abort signal's reason, which the reader rethrows once it
 * has counted the attempts already made; the message carries no request or response detail.
 */
export class AiInterruptedError extends Error implements AiCallUse {
  constructor(readonly reason: unknown, readonly attempts: number, readonly usage: TokenUsage) {
    super('AI_INTERRUPTED'); this.name = 'AiInterruptedError';
  }
}

export interface PageModelClient {
  readPage(request: PageRequest, signal: AbortSignal): Promise<PageAnswer>;
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
  /** The process-wide request limit; by default one built from OCR_AI_MAX_CONCURRENT_REQUESTS (4). */
  limiter?: Semaphore;
}

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

export class ClaudePageClient implements PageModelClient {
  private readonly client: Anthropic;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  /**
   * Claude API requests in flight for the whole process. main.ts builds one client, so every claim loop and
   * every page of every document shares this limit. A permit is held for one HTTP attempt only, never across
   * a backoff sleep, and waiting for one does not stop the job's lease renewal.
   */
  readonly limiter: Semaphore;

  constructor(private readonly config: Pick<OcrWorkerConfig, 'ANTHROPIC_API_KEY' | 'OCR_AI_MAX_TOKENS'
    | 'OCR_AI_TIMEOUT_MS' | 'OCR_AI_MAX_RETRIES'> & Partial<Pick<OcrWorkerConfig, 'OCR_AI_MAX_CONCURRENT_REQUESTS'>>,
    options: ClaudeClientOptions = {}) {
    if (!config.ANTHROPIC_API_KEY) throw new Error('AI reading requires an API key');
    // apiKey given in code: the SDK reads no other credential from the environment. baseURL is fixed so an
    // inherited ANTHROPIC_BASE_URL cannot send pages elsewhere. Retries are ours (maxRetries 0), and the SDK
    // logger is silenced so no request or error detail reaches the worker's logs.
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, baseURL: ANTHROPIC_BASE_URL,
      webhookKey: null, maxRetries: 0, timeout: config.OCR_AI_TIMEOUT_MS, logLevel: 'off', logger: silentLogger,
      ...(options.fetch ? { fetch: options.fetch } : {}) });
    this.sleep = options.sleep ?? abortableDelay;
    this.random = options.random ?? Math.random;
    this.limiter = options.limiter ?? new Semaphore(config.OCR_AI_MAX_CONCURRENT_REQUESTS ?? 4);
  }

  async readPage(request: PageRequest, signal: AbortSignal): Promise<PageAnswer> {
    const image = request.image;
    // The picture as the model sees it: the model's pixel coordinates are in this size (resized, unpadded).
    const seen = image ? resizedSize(image.width, image.height, imageTierOf(request.model)) : null;
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: this.config.OCR_AI_MAX_TOKENS,
      inference_geo: INFERENCE_GEO,
      thinking: { type: 'adaptive' },
      output_config: { effort: request.effort, format: { type: 'json_schema',
        schema: { ...(image ? MODEL_OUTPUT_IMAGE_JSON_SCHEMA : MODEL_OUTPUT_JSON_SCHEMA) } } },
      // Frozen prefix: the same bytes for every page and document, cached. The image re-read's own
      // instructions are in its user turn, so this system block is the same for both kinds of request. Its
      // answer schema (output_config.format) is not: a different structured-output format is a cache breaker,
      // so image re-reads do not read the text requests' cache and keep their own, which is warm only when
      // another image re-read came within the cache lifetime. Cost estimates count them without cache reads.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: image
        ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: imagePageMessage(request.page, request.lines, seen!) }]
        : pageMessage(request.page, request.lines) }],
    };
    const maxAttempts = this.config.OCR_AI_MAX_RETRIES + 1;
    // Attempts that reached the API without an answer, and the tokens they were reported to use: counted in
    // every error this call throws, so a failed or interrupted call's requests still count towards the usage totals.
    let sent = 0;
    const spent = noUsage();
    for (let attempt = 1; ; attempt += 1) {
      // The wait for a permit is not part of the request timeout; only shutdown ends it.
      let release: () => void;
      try {
        release = await this.limiter.acquire(signal);
      } catch (error) {
        throw signal.aborted ? new AiInterruptedError(signal.reason, sent, spent) : error;
      }
      const timeout = AbortSignal.timeout(this.config.OCR_AI_TIMEOUT_MS);
      let stream: { readonly currentMessage: Anthropic.Message | undefined } | undefined;
      try {
        // Streaming, so a long adaptive-thinking answer is never cut by an idle HTTP connection.
        const started = this.client.messages.stream(params, { signal: AbortSignal.any([signal, timeout]) });
        stream = started;
        const message = await started.finalMessage();
        release();
        return interpret(message, attempt, spent, seen ?? undefined);
      } catch (error) {
        release();
        sent = attempt;
        addTokens(spent, partialUsage(stream));
        if (signal.aborted) throw new AiInterruptedError(signal.reason, sent, spent);
        const decision = classify(error, timeout.aborted);
        if (decision.kind === 'rejected') throw new AiRejectedError(decision.code, sent, spent, decision.invalidRequest === true);
        if (attempt >= maxAttempts) throw new AiTransientError(decision.code, sent, spent);
        const jitter = fullJitterDelayMs(attempt - 1, { ...BACKOFF, random: this.random });
        try {
          await this.sleep(decision.retryAfterMs === null ? jitter : Math.max(decision.retryAfterMs, jitter), signal);
        } catch (sleepError) {
          throw signal.aborted ? new AiInterruptedError(signal.reason, sent, spent) : sleepError;
        }
      }
    }
  }
}

function usageOf(message: Anthropic.Message): TokenUsage {
  return { inputTokens: message.usage.input_tokens ?? 0, outputTokens: message.usage.output_tokens ?? 0,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0 };
}

function addTokens(total: TokenUsage, more: TokenUsage): void {
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cacheReadInputTokens += more.cacheReadInputTokens;
  total.cacheCreationInputTokens += more.cacheCreationInputTokens;
}

/** The usage a stream had reported before it failed (message_start, then message_delta); none before it began. */
function partialUsage(stream: { readonly currentMessage: Anthropic.Message | undefined } | undefined): TokenUsage {
  try {
    const message = stream?.currentMessage;
    return message?.usage ? usageOf(message) : noUsage();
  } catch { return noUsage(); }
}

/**
 * stop_reason first, content after: a refusal or a cut-off answer is never parsed as one. `earlier` is what the
 * call's failed attempts before this one already used; it is added to the answer's usage.
 */
export function interpret(message: Anthropic.Message, attempts: number, earlier: TokenUsage = noUsage(),
  imageSize?: { width: number; height: number }): PageAnswer {
  const usage = usageOf(message);
  addTokens(usage, earlier);
  if (message.stop_reason === 'refusal') return { kind: 'refused', usage, attempts };
  if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
    return { kind: 'failed', reason: 'max_tokens', usage, attempts };
  }
  if (message.stop_reason !== 'end_turn') return { kind: 'failed', reason: 'incomplete', usage, attempts };
  const text = message.content.filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text).join('');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { kind: 'failed', reason: 'malformed', usage, attempts }; }
  if (imageSize) {
    // Read from the picture: the model's pixel boxes become page fractions here, before any check sees them.
    const read = modelImagePageSchema.safeParse(parsed);
    if (!read.success) return { kind: 'failed', reason: 'malformed', usage, attempts };
    const page: ModelPage = { ...read.data, items: read.data.items.map((item) => ({ ...item,
      box: toFractionBox(item.box, imageSize) })) };
    return { kind: 'answer', answer: page, usage, attempts, servedInferenceGeo: message.usage.inference_geo ?? null };
  }
  const answer = modelPageSchema.safeParse(parsed);
  if (!answer.success) return { kind: 'failed', reason: 'malformed', usage, attempts };
  return { kind: 'answer', answer: answer.data, usage, attempts,
    servedInferenceGeo: message.usage.inference_geo ?? null };
}

type Decision = { kind: 'retry'; code: string; retryAfterMs: number | null }
  | { kind: 'rejected'; code: string; invalidRequest?: boolean };

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
  if (error instanceof Anthropic.BadRequestError) {
    return { kind: 'rejected', code: 'AI_BAD_REQUEST', invalidRequest: error.type === 'invalid_request_error' };
  }
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
