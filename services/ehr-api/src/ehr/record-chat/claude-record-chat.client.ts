import Anthropic, {
  APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError, BadRequestError,
  InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError,
} from '@anthropic-ai/sdk';
import type { ClientOptions } from '@anthropic-ai/sdk';
import { ANSWER_JSON_SCHEMA } from './answer-validator';
import type { EnabledRecordChatConfig } from './record-chat.config';

/**
 * The only module that talks to the Claude API (owner decision 1 of
 * 2026-10-16). One Messages API request per question, streamed server-side and
 * read with finalMessage(), with:
 * - every client option explicit: the API key from the secret store, no auth
 *   token, no webhook key, the configured base URL, SDK logging off with a
 *   silent logger, the configured timeout and retries (0 by default, so PHI is
 *   not sent twice). The SDK's ambient chain (ANTHROPIC_* variables, profiles,
 *   workload identity) is never consulted, and environment.ts refuses to start
 *   beside any ANTHROPIC_* variable while chat is enabled;
 * - the model, max_tokens and inference_geo from configuration only (there is
 *   no default model), the frozen system prompt as the one cached block, and
 *   a JSON-schema output format; effort only when configured;
 * - no tools, no thinking parameter (the model's default applies and
 *   thinking blocks are ignored), no sampling parameters, no metadata, no
 *   server-side or client-side fallback to another model (a fallback would
 *   send PHI to a model nobody configured).
 * No SDK message text leaves this class: every failure is a reason code.
 */
export type ProcessorFailureReason = 'timeout' | 'output_too_large' | 'network' | 'processor_rate_limited'
  | 'processor_credentials' | 'model_unavailable' | 'model_unsupported' | 'processor_rejected' | 'processor_error';

export class RecordChatProcessorError extends Error {
  constructor(readonly reason: ProcessorFailureReason, readonly httpStatus?: number) {
    super(`record chat processor failure: ${reason}`);
    this.name = 'RecordChatProcessorError';
  }
}

export interface ProcessorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  servedGeo: string | null;
}

export type ProcessorResult =
  | { kind: 'answer'; text: string; stopReason: 'end_turn'; processorMessageId: string; usage: ProcessorUsage }
  | { kind: 'refusal'; stopReason: 'refusal'; refusalCategory: string | null; processorMessageId: string;
      usage: ProcessorUsage }
  | { kind: 'incomplete'; stopReason: string; processorMessageId: string; usage: ProcessorUsage };

export interface ProcessorRequest {
  systemPrompt: string;
  userBlocks: readonly string[];
}

/** What the chat service needs from a processor; the tests and the disabled build supply their own. */
export interface RecordChatProcessor {
  readonly processor: 'anthropic';
  ensureReady(deadlineAt: number): Promise<void>;
  ask(request: ProcessorRequest, deadlineAt: number): Promise<ProcessorResult>;
}

export const RECORD_CHAT_PROCESSOR = Symbol('RECORD_CHAT_PROCESSOR');

/** The model's visible text may not exceed this many characters; the stream is aborted beyond it. */
export const OUTPUT_CHARACTER_LIMIT = 16_000;
/** A readiness answer is reused for an hour. */
const READINESS_TTL_MS = 60 * 60 * 1000;

type Sdk = Pick<Anthropic, 'messages' | 'models'>;
export type SdkFactory = (options: ClientOptions) => Sdk;

const SILENT_LOGGER = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

/** The exact client options: nothing is left for the SDK to read from the environment. */
export function clientOptions(config: EnabledRecordChatConfig): ClientOptions {
  return {
    apiKey: config.apiKey,
    authToken: null,
    webhookKey: null,
    baseURL: config.baseUrl,
    maxRetries: config.maxRetries,
    timeout: config.deadlineMs,
    logLevel: 'off',
    logger: SILENT_LOGGER,
  };
}

/** The Messages API request for one question, exactly. */
export function messageParams(config: EnabledRecordChatConfig, request: ProcessorRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: config.modelId,
    max_tokens: config.maxOutputTokens,
    inference_geo: config.inferenceGeo,
    system: [{ type: 'text', text: request.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: request.userBlocks.map((text) => ({ type: 'text' as const, text })) }],
    output_config: {
      format: { type: 'json_schema', schema: ANSWER_JSON_SCHEMA as unknown as Record<string, unknown> },
      ...(config.effort ? { effort: config.effort } : {}),
    },
  };
}

/** The reason code for an SDK failure, most specific first. */
export function processorFailure(error: unknown, outputTooLarge = false): RecordChatProcessorError {
  if (error instanceof RecordChatProcessorError) return error;
  if (error instanceof APIUserAbortError) return new RecordChatProcessorError(outputTooLarge ? 'output_too_large' : 'timeout');
  if (error instanceof APIConnectionTimeoutError) return new RecordChatProcessorError('timeout');
  if (error instanceof APIConnectionError) return new RecordChatProcessorError('network');
  if (error instanceof RateLimitError) return new RecordChatProcessorError('processor_rate_limited', 429);
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return new RecordChatProcessorError('processor_credentials', error.status);
  }
  if (error instanceof NotFoundError) return new RecordChatProcessorError('model_unavailable', 404);
  if (error instanceof BadRequestError) return new RecordChatProcessorError('processor_rejected', 400);
  if (error instanceof InternalServerError) return new RecordChatProcessorError('processor_error', error.status);
  if (error instanceof APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    return new RecordChatProcessorError(status && status >= 400 && status < 500 ? 'processor_rejected' : 'processor_error',
      status);
  }
  return new RecordChatProcessorError('processor_error');
}

function usageOf(message: Anthropic.Message): ProcessorUsage {
  const usage = message.usage;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    servedGeo: usage?.inference_geo ?? null,
  };
}

/** A timer that aborts at the deadline; cleared by the caller. */
function deadlineSignal(deadlineAt: number): { signal: AbortSignal; remaining: number; clear: () => void } {
  const controller = new AbortController();
  const remaining = Math.max(1, deadlineAt - Date.now());
  const timer = setTimeout(() => controller.abort(), remaining);
  timer.unref?.();
  return { signal: controller.signal, remaining, clear: () => clearTimeout(timer) };
}

export class ClaudeRecordChatClient implements RecordChatProcessor {
  readonly processor = 'anthropic' as const;
  private sdk?: Sdk;
  private readyUntil = 0;

  constructor(private readonly config: EnabledRecordChatConfig,
    private readonly factory: SdkFactory = (options) => new Anthropic(options)) {}

  private client(): Sdk {
    this.sdk ??= this.factory(clientOptions(this.config));
    return this.sdk;
  }

  /**
   * The configured model exists for this workspace and supports structured
   * outputs (and the configured effort). No PHI is sent. Answered from cache
   * for an hour after it passes.
   */
  async ensureReady(deadlineAt: number): Promise<void> {
    if (Date.now() < this.readyUntil) return;
    if (deadlineAt <= Date.now()) throw new RecordChatProcessorError('timeout');
    const deadline = deadlineSignal(deadlineAt);
    let model: Anthropic.ModelInfo;
    try {
      model = await this.client().models.retrieve(this.config.modelId, {},
        { signal: deadline.signal, timeout: deadline.remaining, maxRetries: this.config.maxRetries });
    } catch (error) {
      throw processorFailure(error);
    } finally {
      deadline.clear();
    }
    const capabilities = model.capabilities as (Record<string, unknown> & {
      structured_outputs?: { supported?: boolean };
      effort?: Record<string, { supported?: boolean } | boolean | null> & { supported?: boolean };
    }) | null;
    const effort = this.config.effort;
    if (capabilities?.structured_outputs?.supported !== true
      || (effort && (capabilities.effort?.supported !== true
        || (capabilities.effort[effort] as { supported?: boolean } | null | undefined)?.supported !== true))) {
      throw new RecordChatProcessorError('model_unsupported');
    }
    this.readyUntil = Date.now() + READINESS_TTL_MS;
  }

  async ask(request: ProcessorRequest, deadlineAt: number): Promise<ProcessorResult> {
    if (deadlineAt <= Date.now()) throw new RecordChatProcessorError('timeout');
    const deadline = deadlineSignal(deadlineAt);
    let outputTooLarge = false;
    let message: Anthropic.Message;
    try {
      const stream = this.client().messages.stream(messageParams(this.config, request),
        { signal: deadline.signal, timeout: deadline.remaining, maxRetries: this.config.maxRetries });
      let characters = 0;
      stream.on('text', (delta: string) => {
        characters += delta.length;
        if (characters > OUTPUT_CHARACTER_LIMIT && !outputTooLarge) {
          outputTooLarge = true;
          stream.abort();
        }
      });
      message = await stream.finalMessage();
    } catch (error) {
      throw processorFailure(error, outputTooLarge);
    } finally {
      deadline.clear();
    }
    if (outputTooLarge) throw new RecordChatProcessorError('output_too_large');
    const usage = usageOf(message);
    const processorMessageId = typeof message.id === 'string' ? message.id.slice(0, 128) : '';
    // The stop reason decides before any content is read.
    if (message.stop_reason === 'end_turn') {
      // Text blocks only: thinking and redacted thinking blocks are ignored.
      const text = message.content.filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text).join('');
      return { kind: 'answer', text, stopReason: 'end_turn', processorMessageId, usage };
    }
    if (message.stop_reason === 'refusal') {
      return { kind: 'refusal', stopReason: 'refusal', refusalCategory: message.stop_details?.category ?? null,
        processorMessageId, usage };
    }
    return { kind: 'incomplete', stopReason: String(message.stop_reason ?? 'unknown').slice(0, 64), processorMessageId,
      usage };
  }
}

/** The processor of a build with record chat off: it is never reached, and refuses if it is. */
export const DISABLED_RECORD_CHAT_PROCESSOR: RecordChatProcessor = {
  processor: 'anthropic',
  ensureReady: async () => { throw new RecordChatProcessorError('model_unavailable'); },
  ask: async () => { throw new RecordChatProcessorError('model_unavailable'); },
};
