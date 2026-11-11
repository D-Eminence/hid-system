import Anthropic from '@anthropic-ai/sdk';
import { abortableDelay, fullJitterDelayMs, type Sleep } from '../backoff';
import type { OcrWorkerConfig } from '../config';
import { Semaphore } from '../semaphore';
import { imageTierOf, resizedSize, type PageImage } from './page-image';
import { hardPageMessage, imagePageMessage, MODEL_OUTPUT_HARD_PAGE_JSON_SCHEMA, MODEL_OUTPUT_IMAGE_JSON_SCHEMA,
  MODEL_OUTPUT_JSON_SCHEMA, modelHardPageSchema, modelImagePageSchema, modelPageSchema, pageMessage, SYSTEM_PROMPT,
  toFractionBox, type ModelPage } from './prompt';
import { ZOOM_TOOL, type ZoomToolSession } from './zoom';

/** The Claude API, always at its own endpoint: ANTHROPIC_BASE_URL is never read. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const INFERENCE_GEO = 'us';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A line as the model is given it. The box is sent only with the picture (image re-read). */
export interface PageLinesForModel { id: string; text: string; confidence: number; handwritten: boolean;
  box?: { left: number; top: number; width: number; height: number } | null }

/**
 * One page for the model. `image` (a flagged page's re-read only) adds the picture of the page: the user turn is then
 * [image, text], the text lists the lines with their boxes and the answer schema gives each item a box. Without it
 * the request is exactly the text-only request. The picture is never logged, stored or put in an error.
 */
export interface PageRequest { model: string; effort: Effort; page: number; lines: readonly PageLinesForModel[];
  image?: PageImage;
  /**
   * A hard page's best-guess reading (with `image` only): the hard-page message and answer schema, and the
   * hard-page timeout. Without it an image request is exactly the image re-read request.
   */
  hardPage?: boolean;
  /**
   * A hard page's zoom tool for this read (with `hardPage` only; zoom.ts): the request declares the zoom tool, the
   * message offers it, and the client runs the tool loop. Without it a hard-page request is exactly as before zoom.
   */
  zoom?: ZoomToolSession;
  /**
   * The effort of every turn of the zoom loop after the first (the turns that follow a zoom tool_result); the first
   * keeps `effort`. Sent as that request's top-level effort (README "Hard-page time and cost bounds"). Not given:
   * `effort` throughout.
   */
  followupEffort?: Effort;
  /** A hard page's read only: filled in by the client as the read goes, for the per-read usage log (counts only). */
  trace?: HardReadTrace;
  /**
   * A hard page's read only: the time left before the page's deadline (OCR_AI_HARD_PAGE_DEADLINE_MS, on the reader's
   * clock) and how much of it is kept for the answer-only turn. A turn that would run into the kept time is cut there
   * and the answer-only turn is sent instead (README "A hard read always ends with an answer"). Not given: no time
   * reserve (the token reserve and the other rules still apply).
   */
  answerBy?: { timeLeftMs: () => number; reserveMs: number };
  /**
   * The output-token cap of a request that is not a hard page's read (the last-resort image re-read only, README "Last
   * resort"). Not given: OCR_AI_MAX_TOKENS, so every other request body is byte for byte as before.
   */
  maxTokens?: number }

/**
 * What one hard-page read did, as it went: requests answered (turns), how many of them were follow-up turns (the
 * turns after the first at followupEffort; the answer-only turn is not one: it runs at HARD_READ_FORCED_EFFORT and is
 * marked by `forced`), and `cutAttempts`: attempts that failed after the API had begun its answer (message_start came,
 * then the stream was aborted by the deadline or a shutdown, timed out or failed). A stream reports output tokens only
 * in its final message_delta, so the usage counted for such an attempt is its input and about 1 output token, while
 * the thinking it had already generated is billed: with any cut attempt, the read's outputTokens is a lower bound.
 */
export interface HardReadTrace { turns: number; followupTurns: number; cutAttempts: number;
  /**
   * Why zoom stopped being offered (tool_choice none from the next turn, an ordinary follow-up turn at followupEffort
   * with the budget left): the zoom calls were used up ('zoom_cap') or the read had taken as many zoom turns as it has
   * calls ('turns'). The expected path (prompt rule J: all zooms in one turn, then the answer), not a failure; absent:
   * zoom was offered on every turn (or not at all).
   */
  zoomClosed?: ZoomClosedReason;
  /** Why the read was sent an answer-only turn (README "A hard read always ends with an answer"); absent: it was not. */
  forced?: ForcedAnswerReason }

/** Why a hard read's zoom tool stopped being offered (HardReadTrace.zoomClosed). Codes only. */
export type ZoomClosedReason = 'zoom_cap' | 'turns';

/**
 * Why a hard read was sent its answer-only turn: its output tokens left reached the answer reserve ('budget'), the
 * page's deadline came within the answer's time reserve ('deadline'), a turn stopped at its max_tokens before an
 * answer ('max_tokens'), or a turn ended without an answer or tool calls ('incomplete'; also a turn after zoom was
 * closed that still did not answer). Codes only.
 */
export type ForcedAnswerReason = 'budget' | 'deadline' | 'max_tokens' | 'incomplete';

/**
 * Output tokens of a hard read's OCR_AI_HARD_PAGE_MAX_TOKENS kept for its answer-only turn (at most half the cap):
 * every turn before it is sent with max_tokens = what is left less this, so the answer-only turn always has it. 8,000:
 * a hard page's JSON answer is about 3,000 to 4,000 tokens for 12 items (README, job 5419047a), and a turn at
 * HARD_READ_FORCED_EFFORT thinks little, so 8,000 leaves room for a page about twice as dense.
 */
export const HARD_READ_ANSWER_RESERVE_TOKENS = 8_000;
/**
 * Milliseconds before a hard page's deadline kept for the answer-only turn (at most a third of the deadline, and none
 * at short deadlines; answerReserveMs). 50 s: about 4,000 to 5,000 output tokens at the roughly 100 tokens per second measured in production
 * (README, job 5419047a), which is a 12-item answer (3,000 to 4,000 tokens) and a little thinking at low effort, plus
 * a few seconds to read the picture and crops again (the effort change rewrites the messages cache).
 */
export const HARD_READ_ANSWER_RESERVE_MS = 50_000;
/**
 * A turn before the answer-only one is not started with less than this left before the time reserve: it would be cut
 * before it could finish (its thinking billed for nothing). The answer-only turn is sent at once instead.
 */
export const HARD_READ_MIN_TURN_MS = 20_000;
/**
 * The effort of the answer-only turn. 'low': the turn's job is to write down what was already read (the earlier
 * turns' thinking and crops are in its context), and every token it spends thinking is time and tokens the answer
 * does not get; on Claude Opus 5.5 thinking cannot be turned off, so low effort is the least thinking there is.
 */
export const HARD_READ_FORCED_EFFORT: Effort = 'low';
/**
 * The answer-only turn's instruction, a user message appended to the read (append-only, after the last tool results).
 * Part of the hard-page prompt (HARD_PAGE_PROMPT_VERSION 11): never logged. A read that was offered zoom gets this one;
 * a read never offered zoom (no zoom, or the -11-no-zoom prompt) gets FORCED_ANSWER_INSTRUCTION_NO_ZOOM.
 */
export const FORCED_ANSWER_INSTRUCTION_NO_ZOOM = 'Stop looking now and give your answer for this page: write it from '
  + 'what you have already seen in the picture and any enlarged views, as your best reading under the rules above, in '
  + 'the answer format.';
export const FORCED_ANSWER_INSTRUCTION = `${FORCED_ANSWER_INSTRUCTION_NO_ZOOM} The zoom tool is no longer available.`;

/**
 * The time a hard page's read keeps for its answer-only turn, from the page's deadline (OCR_AI_HARD_PAGE_DEADLINE_MS):
 * HARD_READ_ANSWER_RESERVE_MS, at most a third of the deadline, and never so much that the time before it leaves the
 * first turn less than twice HARD_READ_MIN_TURN_MS. A reserve that would then be under HARD_READ_MIN_TURN_MS (no time
 * for an answer-only turn to finish) is none (0): the read runs as before the reserve, bounded by the deadline only
 * (deadlines under 60 s; the token reserve and the other rules still apply). At the 30 s minimum a reserve of a third
 * would have left 20 s, under the turn minimum, and every hard read would have skipped straight to the answer-only turn.
 */
export function answerReserveMs(deadlineMs: number): number {
  const reserve = Math.min(HARD_READ_ANSWER_RESERVE_MS, Math.floor(deadlineMs / 3), deadlineMs - 2 * HARD_READ_MIN_TURN_MS);
  return reserve < HARD_READ_MIN_TURN_MS ? 0 : reserve;
}

/**
 * A turn of a hard-page read is not sent with less than this many output tokens left of the read's
 * OCR_AI_HARD_PAGE_MAX_TOKENS: it would be cut off before it could answer. The read ends as max_tokens instead.
 */
export const HARD_READ_MIN_TURN_TOKENS = 2_048;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type PageAnswer =
  | { kind: 'answer'; answer: ModelPage; usage: TokenUsage; servedInferenceGeo: string | null; attempts: number }
  | { kind: 'refused'; usage: TokenUsage; attempts: number }
  | { kind: 'failed'; reason: 'max_tokens' | 'malformed' | 'incomplete'; usage: TokenUsage; attempts: number;
    /**
     * The finer code, for the warn logs: 'parse_error' (the answer was not JSON) or 'schema_error' (JSON, but not the
     * answer schema) for 'malformed'; 'zoom_loop' (tool calls where an answer was required) or 'incomplete' (another
     * stop reason) for 'incomplete'; 'max_tokens'. Codes only.
     */
    code?: 'max_tokens' | 'parse_error' | 'schema_error' | 'zoom_loop' | 'incomplete' };

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
  /** Milliseconds, for the zoom loop's request-time budget; tests inject a clock. */
  now?: () => number;
}

/**
 * Requests a call made and what they used, for its answer or its error; `requestMs` is the time spent in requests
 * (from holding a permit to the answer or the failure), never in a permit wait, a backoff sleep or a zoom crop.
 */
interface CallState { sent: number; spent: TokenUsage; requestMs: number; trace?: HardReadTrace }

/**
 * A turn of a hard read cut at the start of the answer's time reserve (never retried): the read goes on to its
 * answer-only turn. Internal to the client.
 */
class ReserveReachedError extends Error {
  constructor() { super('HARD_READ_RESERVE_REACHED'); this.name = 'ReserveReachedError'; }
}

/**
 * One attempt's timeout (`ms`, the request time it may take), and, for a hard read's turn before its answer-only one,
 * when the answer's time reserve begins (`reserveMs`, only when sooner than `ms`): an attempt still thinking then is
 * cut; one already writing its answer text is left to finish (bounded by `ms` and the page's deadline).
 */
interface AttemptTime { ms: number; reserveMs?: number }

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

export class ClaudePageClient implements PageModelClient {
  private readonly client: Anthropic;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly now: () => number;
  /**
   * Claude API requests in flight for the whole process. main.ts builds one client, so every claim loop and
   * every page of every document shares this limit. A permit is held for one HTTP attempt only, never across
   * a backoff sleep, and waiting for one does not stop the job's lease renewal.
   */
  readonly limiter: Semaphore;

  constructor(private readonly config: Pick<OcrWorkerConfig, 'ANTHROPIC_API_KEY' | 'OCR_AI_MAX_TOKENS'
    | 'OCR_AI_TIMEOUT_MS' | 'OCR_AI_MAX_RETRIES'> & Partial<Pick<OcrWorkerConfig, 'OCR_AI_MAX_CONCURRENT_REQUESTS'
    | 'OCR_AI_HARD_PAGE_TIMEOUT_MS' | 'OCR_AI_HARD_PAGE_MAX_TOKENS'>>,
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
    this.now = options.now ?? Date.now;
    this.limiter = options.limiter ?? new Semaphore(config.OCR_AI_MAX_CONCURRENT_REQUESTS ?? 4);
  }

  async readPage(request: PageRequest, signal: AbortSignal): Promise<PageAnswer> {
    const image = request.image;
    // The picture as the model sees it: the model's pixel coordinates are in this size (resized, unpadded).
    const tier = image ? imageTierOf(request.model) : null;
    // The reader sends a picture only to a model of known tier ('image_tier_unknown' otherwise); never guess one.
    // A rejection (no request made), so only this page's re-read fails, never the whole reading.
    if (image && tier === null) throw new AiRejectedError('IMAGE_TIER_UNKNOWN');
    const seen = image && tier ? resizedSize(image.width, image.height, tier) : null;
    const hard = image !== undefined && request.hardPage === true;
    const zoom = hard && request.zoom !== undefined && request.zoom.maxCalls > 0 ? request.zoom : undefined;
    // A hard page at max effort may think for many minutes: its own (longer) per-request timeout.
    const timeoutMs = hard ? this.config.OCR_AI_HARD_PAGE_TIMEOUT_MS ?? this.config.OCR_AI_TIMEOUT_MS
      : this.config.OCR_AI_TIMEOUT_MS;
    // A hard page's read: OCR_AI_HARD_PAGE_MAX_TOKENS for the whole read (every turn together); any other request
    // keeps OCR_AI_MAX_TOKENS, so its body is byte for byte as before.
    const readCap = hard ? this.config.OCR_AI_HARD_PAGE_MAX_TOKENS ?? this.config.OCR_AI_MAX_TOKENS
      : request.maxTokens ?? this.config.OCR_AI_MAX_TOKENS;
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: readCap,
      inference_geo: INFERENCE_GEO,
      thinking: { type: 'adaptive' },
      output_config: { effort: request.effort, format: { type: 'json_schema',
        schema: { ...(hard ? MODEL_OUTPUT_HARD_PAGE_JSON_SCHEMA : image ? MODEL_OUTPUT_IMAGE_JSON_SCHEMA
          : MODEL_OUTPUT_JSON_SCHEMA) } } },
      // Frozen prefix: the same bytes for every page and document, cached. The image re-read's own
      // instructions are in its user turn, so this system block is the same for both kinds of request. Its
      // answer schema (output_config.format) is not: a different structured-output format is a cache breaker,
      // so image re-reads do not read the text requests' cache and keep their own, which is warm only when
      // another image re-read came within the cache lifetime. Cost estimates count them without cache reads.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: image
        ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: hard ? hardPageMessage(request.page, request.lines, seen!, zoom?.maxCalls ?? 0)
            : imagePageMessage(request.page, request.lines, seen!) }]
        : pageMessage(request.page, request.lines) }],
      // Zoom (hard-page reads only): the client tool, with the JSON answer still given by output_config.format
      // (structured outputs and tools combine: a turn ends either in tool calls or in the JSON answer). The
      // conversation grows by whole turns only (append-only), so top-level automatic caching lets each later turn
      // read the picture, the earlier crops and the thinking from the cache.
      ...(zoom ? { tools: [ZOOM_TOOL], tool_choice: { type: 'auto' as const },
        cache_control: { type: 'ephemeral' as const } } : {}),
    };
    const trace = hard ? request.trace : undefined;
    const state: CallState = { sent: 0, spent: noUsage(), requestMs: 0, ...(trace ? { trace } : {}) };
    if (!hard) {
      const message = await this.send(params, () => ({ ms: timeoutMs }), signal, state);
      return interpret(message, state.sent, state.spent, seen ?? undefined, hard);
    }
    return this.readHard(request, params, zoom, readCap, timeoutMs, seen!, signal, state);
  }

  /**
   * A hard page's read: its turns (the zoom tool loop when zoom is offered, else one turn), then, whenever a turn did
   * not answer, one answer-only turn (README "A hard read always ends with an answer", coordinator 2026-11-10, after
   * job 566c38bf gave the owner nothing). Each attempt of each turn gets the hard-page timeout, and the read's time in
   * requests (every turn and retry, not the permit waits, the backoff sleeps or the crops) is held to what one request
   * with all its retries could take: the hard-page timeout times (OCR_AI_MAX_RETRIES + 1). The abort signal (the
   * job's, and the page's deadline) ends it between turns as within them. Each turn's usage is counted.
   *
   * Bounds (coordinator 2026-11-10): the read's reported output tokens over all its turns are held to readCap. Every
   * turn before the answer-only one is sent with max_tokens = what is left less the answer reserve
   * (HARD_READ_ANSWER_RESERVE_TOKENS, at most half the cap), and never with less than HARD_READ_MIN_TURN_TOKENS; the
   * answer-only turn gets the reserve (or what is left, if less). A retried attempt of a turn is sent with the same
   * max_tokens, and an attempt that failed mid-stream counts about 1 output token (HardReadTrace.cutAttempts), so the
   * cap bounds each attempt, not the read's billed output; the read's bound in time (and so in money) is
   * OCR_AI_HARD_PAGE_DEADLINE_MS. The turns after a zoom tool_result run at followupEffort. A different top-level
   * effort from the first turn's is accepted with adaptive thinking (the earlier thinking blocks stay valid) but is a
   * messages-cache breaker: the first follow-up turn writes the cache again and the later ones read it. The
   * per-message effort system message (mid-conversation-output-config-2026-07-01) keeps the cache but cannot be used
   * here: placed after a user turn of only tool_result blocks, it waits for the next user turn with new input, which a
   * zoom loop never has.
   *
   * When the zoom calls are used up, or the read has had as many zoom turns as it has calls (HardReadTrace.zoomClosed),
   * the next turn is an ordinary follow-up turn (followupEffort, max_tokens = what is left less the answer reserve, no
   * new instruction) with tool_choice {type: 'none'}: the normal end of a read that asked for all its zooms in one turn
   * (prompt rule J), which keeps its full-effort answer turn.
   *
   * The answer-only turn is sent when: the output tokens left reach the reserve; the page's deadline is within the
   * time reserve (answerBy) of now, or close enough that a turn could not finish before it (HARD_READ_MIN_TURN_MS); a
   * turn is still thinking (not yet writing its answer text) when the time reserve begins and is cut there; or a turn
   * stops at max_tokens or with neither an answer nor tool calls (a turn after zoom was closed included). It is the
   * conversation so far (the cut or unanswered turn left out: a cut turn's thinking cannot be sent back) and
   * FORCED_ANSWER_INSTRUCTION (FORCED_ANSWER_INSTRUCTION_NO_ZOOM when the read was never offered zoom) as a new user
   * message, at HARD_READ_FORCED_EFFORT, with tool_choice {type: 'none'} where the zoom tool is declared (the
   * tool stays declared, since earlier turns hold tool_use and tool_result blocks; forced tool use is not available on
   * Claude Opus 5.5, but 'none' is, with adaptive thinking), and the same structured-output answer schema. Only one
   * answer-only turn is sent; how it ends is how the read ends. A refusal, or an answer that is not the answer schema,
   * ends the read at once (no repair turn: structured outputs constrain the JSON, so a schema failure would most likely
   * repeat, and the turn would cost another read of the picture and crops).
   */
  private async readHard(request: PageRequest, params: Anthropic.MessageCreateParamsNonStreaming,
    zoom: ZoomToolSession | undefined, readCap: number, timeoutMs: number, seen: { width: number; height: number },
    signal: AbortSignal, state: CallState): Promise<PageAnswer> {
    const trace = state.trace;
    const budget = timeoutMs * (this.config.OCR_AI_MAX_RETRIES + 1);
    const remaining = () => Math.min(timeoutMs, budget - state.requestMs);
    const reserveTokens = Math.min(HARD_READ_ANSWER_RESERVE_TOKENS, Math.floor(readCap / 2));
    const answerBy = request.answerBy;
    /** Milliseconds before the answer's time reserve begins (no reserve: never). */
    const untilReserve = () => answerBy ? answerBy.timeLeftMs() - answerBy.reserveMs : Number.POSITIVE_INFINITY;
    const messages: Anthropic.MessageParam[] = [...params.messages];
    const followupEffort = request.followupEffort ?? request.effort;
    /** An answered request; every one after the read's first is a follow-up turn, except the answer-only turn. */
    const countTurn = (answerOnly: boolean) => {
      if (!trace) return;
      if (trace.turns > 0 && !answerOnly) trace.followupTurns += 1;
      trace.turns += 1;
    };
    let forced: ForcedAnswerReason | undefined;
    let closed: ZoomClosedReason | undefined;
    let toolTurns = 0;
    for (let turn = 0; forced === undefined; turn += 1) {
      const left = readCap - state.spent.outputTokens;
      if (left - reserveTokens < HARD_READ_MIN_TURN_TOKENS) { forced = 'budget'; break; }
      if (untilReserve() < HARD_READ_MIN_TURN_MS) { forced = 'deadline'; break; }
      const effort = turn === 0 ? request.effort : followupEffort;
      let message: Anthropic.Message;
      try {
        message = await this.send({ ...params, max_tokens: left - reserveTokens,
          output_config: { ...params.output_config, effort }, messages,
          ...(closed ? { tool_choice: { type: 'none' as const } } : {}) }, () => {
          const request = remaining();
          const reserve = untilReserve();
          return reserve < request ? { ms: request, reserveMs: reserve } : { ms: request };
        }, signal, state);
      } catch (error) {
        if (error instanceof ReserveReachedError) { forced = 'deadline'; break; }
        throw error;
      }
      countTurn(false);
      // A refusal or an answer (well formed or not) ends the read as it is.
      if (message.stop_reason === 'refusal' || message.stop_reason === 'end_turn') {
        return interpret(message, state.sent, state.spent, seen, true);
      }
      addTokens(state.spent, usageOf(message));
      // A turn after zoom was closed that did not answer goes on to the answer-only turn like any other.
      if (message.stop_reason !== 'tool_use' || !zoom || closed) {
        forced = message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded'
          ? 'max_tokens' : 'incomplete';
        break;
      }
      const calls = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
      if (calls.length === 0) { forced = 'incomplete'; break; }
      // Every call of the turn answered, in order, in one user turn. A malformed input or a failed zoom is an
      // is_error result (zoom.ts never throws): the read goes on.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) results.push(await zoom.answer({ id: call.id, name: call.name, input: call.input }, signal));
      if (signal.aborted) throw new AiInterruptedError(signal.reason, state.sent, { ...state.spent });
      // The assistant turn exactly as it came (thinking blocks with their signatures, text, tool calls), as tool use
      // with thinking requires; then the results.
      messages.push({ role: 'assistant', content: message.content as Anthropic.ContentBlockParam[] },
        { role: 'user', content: results });
      toolTurns += 1;
      if (zoom.callsLeft <= 0) closed = 'zoom_cap';
      else if (toolTurns >= zoom.maxCalls) closed = 'turns';
      if (closed && trace) trace.zoomClosed = closed;
    }
    if (trace) trace.forced = forced;
    const left = readCap - state.spent.outputTokens;
    if (left < HARD_READ_MIN_TURN_TOKENS) {
      return { kind: 'failed', reason: 'max_tokens', code: 'max_tokens', usage: { ...state.spent }, attempts: state.sent };
    }
    messages.push({ role: 'user', content: [{ type: 'text',
      text: zoom ? FORCED_ANSWER_INSTRUCTION : FORCED_ANSWER_INSTRUCTION_NO_ZOOM }] });
    const message = await this.send({ ...params, max_tokens: Math.min(left, reserveTokens),
      output_config: { ...params.output_config, effort: HARD_READ_FORCED_EFFORT }, messages,
      ...(zoom ? { tool_choice: { type: 'none' as const } } : {}) },
    () => ({ ms: remaining() }), signal, state);
    countTurn(true);
    return interpret(message, state.sent, state.spent, seen, true);
  }

  /**
   * One request, with our retries. `timeoutFor` gives each attempt's timeout, read once the permit is held (for a
   * hard read, capped by its request-time budget left), and for a hard read's turn before its answer-only one when its
   * answer reserve begins. No request time left is a timeout; the reserve already begun is a ReserveReachedError, as
   * is an attempt still thinking when it begins. An attempt already writing its answer text then (its latest content
   * block is text) is not cut: an answer that would have finished before the deadline is not thrown away (README "A
   * hard read always ends with an answer"); the request time and the page's deadline still bound it. Every attempt is
   * counted in `state` (sent, its time in the request, and the tokens of any that failed after it started).
   */
  private async send(params: Anthropic.MessageCreateParamsNonStreaming, timeoutFor: () => AttemptTime,
    signal: AbortSignal, state: CallState): Promise<Anthropic.Message> {
    const maxAttempts = this.config.OCR_AI_MAX_RETRIES + 1;
    for (let attempt = 1; ; attempt += 1) {
      // The wait for a permit is not part of the request timeout or the zoom loop's budget; only shutdown ends it.
      let release: () => void;
      try {
        release = await this.limiter.acquire(signal);
      } catch (error) {
        throw signal.aborted ? new AiInterruptedError(signal.reason, state.sent, state.spent) : error;
      }
      const { ms, reserveMs } = timeoutFor();
      // A hard read's answer reserve has begun (README "A hard read always ends with an answer"): no retry.
      if (reserveMs !== undefined && reserveMs <= 0) { release(); throw new ReserveReachedError(); }
      if (ms <= 0) { release(); throw new AiTransientError('AI_TIMEOUT', state.sent, state.spent); }
      // The reserve's start: the attempt is cut there unless it is already writing its answer text.
      const reserveAt = reserveMs === undefined ? undefined : AbortSignal.timeout(reserveMs);
      const timeout = AbortSignal.timeout(ms);
      const reserveCut = new AbortController();
      const started = this.now();
      let stream: { readonly currentMessage: Anthropic.Message | undefined } | undefined;
      const atReserve = () => { if (!writingAnswer(stream)) reserveCut.abort(); };
      reserveAt?.addEventListener('abort', atReserve, { once: true });
      try {
        // Streaming, so a long adaptive-thinking answer is never cut by an idle HTTP connection.
        const opened = this.client.messages.stream(params,
          { signal: AbortSignal.any([signal, timeout, reserveCut.signal]) });
        stream = opened;
        const message = await opened.finalMessage();
        reserveAt?.removeEventListener('abort', atReserve);
        release();
        state.sent += 1;
        state.requestMs += this.now() - started;
        return message;
      } catch (error) {
        reserveAt?.removeEventListener('abort', atReserve);
        release();
        state.sent += 1;
        state.requestMs += this.now() - started;
        const partial = partialUsage(stream);
        addTokens(state.spent, partial.usage);
        // The answer had begun: its output so far is billed but was never reported (see HardReadTrace).
        if (partial.started && state.trace) state.trace.cutAttempts += 1;
        if (signal.aborted) throw new AiInterruptedError(signal.reason, state.sent, state.spent);
        // Cut at the start of a hard read's answer reserve: not retried; the read goes on to its answer-only turn.
        if (reserveCut.signal.aborted) throw new ReserveReachedError();
        const decision = classify(error, timeout.aborted);
        if (decision.kind === 'rejected') {
          throw new AiRejectedError(decision.code, state.sent, state.spent, decision.invalidRequest === true);
        }
        if (attempt >= maxAttempts) throw new AiTransientError(decision.code, state.sent, state.spent);
        const jitter = fullJitterDelayMs(attempt - 1, { ...BACKOFF, random: this.random });
        try {
          await this.sleep(decision.retryAfterMs === null ? jitter : Math.max(decision.retryAfterMs, jitter), signal);
        } catch (sleepError) {
          throw signal.aborted ? new AiInterruptedError(signal.reason, state.sent, state.spent) : sleepError;
        }
      }
    }
  }
}

/** True when the stream's latest content block is text: the turn is writing its answer (the structured JSON). */
function writingAnswer(stream: { readonly currentMessage: Anthropic.Message | undefined } | undefined): boolean {
  try {
    const content = stream?.currentMessage?.content;
    return content !== undefined && content.length > 0 && content[content.length - 1]!.type === 'text';
  } catch { return false; }
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

/**
 * The usage a stream had reported before it failed (message_start, then message_delta); none before it began.
 * `started`: message_start had come, so the model had begun its answer. Its output tokens are then under-counted
 * (message_start says 1; the real count comes only in the final message_delta).
 */
function partialUsage(stream: { readonly currentMessage: Anthropic.Message | undefined } | undefined):
  { usage: TokenUsage; started: boolean } {
  try {
    const message = stream?.currentMessage;
    return message?.usage ? { usage: usageOf(message), started: true } : { usage: noUsage(), started: false };
  } catch { return { usage: noUsage(), started: false }; }
}

/**
 * stop_reason first, content after: a refusal or a cut-off answer is never parsed as one. `earlier` is what the
 * call's failed attempts before this one already used; it is added to the answer's usage.
 */
export function interpret(message: Anthropic.Message, attempts: number, earlier: TokenUsage = noUsage(),
  imageSize?: { width: number; height: number }, hardPage = false): PageAnswer {
  const usage = usageOf(message);
  addTokens(usage, earlier);
  if (message.stop_reason === 'refusal') return { kind: 'refused', usage, attempts };
  if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
    return { kind: 'failed', reason: 'max_tokens', code: 'max_tokens', usage, attempts };
  }
  if (message.stop_reason === 'tool_use') return { kind: 'failed', reason: 'incomplete', code: 'zoom_loop', usage, attempts };
  if (message.stop_reason !== 'end_turn') return { kind: 'failed', reason: 'incomplete', code: 'incomplete', usage, attempts };
  const text = message.content.filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text).join('');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { kind: 'failed', reason: 'malformed', code: 'parse_error', usage, attempts }; }
  if (imageSize && hardPage) {
    // A hard page's best guess: boxes to page fractions, and the dose, unit, crossed-out writing and basis kept beside
    // each item.
    const read = modelHardPageSchema.safeParse(parsed);
    if (!read.success) return { kind: 'failed', reason: 'malformed', code: 'schema_error', usage, attempts };
    const page: ModelPage = { ...read.data, items: read.data.items.map(({ dose, doseUnit, crossedOut, basis, box, ...item }) => ({
      ...item, box: toFractionBox(box, imageSize), hard: { dose, doseUnit, crossedOut, basis } })) };
    return { kind: 'answer', answer: page, usage, attempts, servedInferenceGeo: message.usage.inference_geo ?? null };
  }
  if (imageSize) {
    // Read from the picture: the model's pixel boxes become page fractions here, before any check sees them.
    const read = modelImagePageSchema.safeParse(parsed);
    if (!read.success) return { kind: 'failed', reason: 'malformed', code: 'schema_error', usage, attempts };
    const page: ModelPage = { ...read.data, items: read.data.items.map((item) => ({ ...item,
      box: toFractionBox(item.box, imageSize) })) };
    return { kind: 'answer', answer: page, usage, attempts, servedInferenceGeo: message.usage.inference_geo ?? null };
  }
  const answer = modelPageSchema.safeParse(parsed);
  if (!answer.success) return { kind: 'failed', reason: 'malformed', code: 'schema_error', usage, attempts };
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
