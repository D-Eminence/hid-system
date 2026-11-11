import type { OcrWorkerConfig } from '../config';
import { forEachBounded } from '../semaphore';
import type { AiUsageRecord, ReadLine, ReadPage } from '../types';
import { AiInterruptedError, AiRejectedError, AiTransientError, answerReserveMs, HARD_READ_FORCED_EFFORT, INFERENCE_GEO,
  type AiCallUse, type Effort, type ForcedAnswerReason, type HardReadTrace, type PageAnswer, type PageModelClient,
  type TokenUsage, type ZoomClosedReason } from './claude.client';
import {
  PAPER_READING_CONTRACT, PAPER_READING_SCHEMA_VERSION, type FlagReason, type ImageRereadSkipReason, type PaperIdentity,
  type PaperItem, type PaperPage, type PaperReadingPayload, type ReadingStatus,
} from './contract';
import { mergeHardReadings, noAgreement, prepareHardAnswer, type HardPageAgreement } from './hard-page';
import { blankIdentity, checkPage, checkReasonSentence, mergeReread, REVIEW_BELOW, uniqueItemIds,
  type PageCheck } from './items';
import { createMasker, type Masker } from './masking';
import { tidyPage } from './tidy';
import { imageTierOf, pageImageFor, resizedSize, type PageImage, type PageImageDecision,
  type SourceDocument } from './page-image';
import { MODEL_SCHEMA_VERSION, PROMPT_VERSION } from './prompt';
import { createPageZoom, createZoomSession, noZoomStats, ZOOM_MAX_CALLS, type PageZoom, type ZoomStats,
  type ZoomToolSession } from './zoom';

export type ReadingConfig = Pick<OcrWorkerConfig, 'OCR_AI_MODE' | 'OCR_AI_FACILITY_IDS' | 'OCR_AI_FIRST_PASS_MODEL'
  | 'OCR_AI_FIRST_PASS_EFFORT' | 'OCR_AI_REREAD_MODEL' | 'OCR_AI_REREAD_EFFORT' | 'OCR_AI_MAX_REREAD_PAGES'>
  // Pages of one document read at once; one at a time when not given. The image re-read is off when not given,
  // and a page with a masked number is sent as a picture unless OCR_AI_IMAGE_MASKED_PAGES is 'text_only'.
  & Partial<Pick<OcrWorkerConfig, 'OCR_AI_PAGE_CONCURRENCY' | 'OCR_AI_IMAGE_REREAD' | 'OCR_AI_IMAGE_MASKED_PAGES'>>
  // Hard-page best-guess reads (two per hard page); off when not given, as the image re-read. Effort 'max' when not
  // given, 'high' after a zoom result (OCR_AI_HARD_PAGE_FOLLOWUP_EFFORT), and the page's deadline 150 s when not given.
  & Partial<Pick<OcrWorkerConfig, 'OCR_AI_HARD_PAGE_READS' | 'OCR_AI_HARD_PAGE_EFFORT'
    | 'OCR_AI_HARD_PAGE_FOLLOWUP_EFFORT' | 'OCR_AI_HARD_PAGE_DEADLINE_MS'>>
  // The last resort's own window; LAST_RESORT_SECONDS (60) when not given.
  & Partial<Pick<OcrWorkerConfig, 'OCR_AI_LAST_RESORT_SECONDS'>>
  // Zoom in the hard-page reads (zoom.ts); off when not given. At most OCR_AI_ZOOM_MAX_CALLS (4 when not given) per read.
  & Partial<Pick<OcrWorkerConfig, 'OCR_AI_HARD_PAGE_ZOOM' | 'OCR_AI_ZOOM_MAX_CALLS'>>;

/** OCR_AI_HARD_PAGE_DEADLINE_MS when the reading config does not give it (the setting's default). */
export const HARD_PAGE_DEADLINE_MS = 150_000;

/**
 * The last-resort image re-read (coordinator decisions 2026-11-10, README "Last resort"): one ordinary image re-read
 * request (imagePageMessage, IMAGE_PROMPT_VERSION, no zoom, OCR_AI_REREAD_MODEL) of a page that has a picture and no
 * usable reading at all, in a window of its own: OCR_AI_LAST_RESORT_SECONDS (LAST_RESORT_SECONDS, 60, when not given)
 * from when it is decided, never what is left of the hard page's deadline (coordinator, about 18:58 UTC: so a page
 * whose two hard reads were both cut by the deadline still gets an answer; a hard page's worst case is then about
 * 150 s + 60 s). The setting's minimum of 30 s (config.ts) is about 3,000 output tokens at the ~100 tokens per second
 * measured in production, the size of a sparse page's answer with little thinking (a 12-item answer is about 3,000
 * to 4,000); with less, the request would almost surely be cut and its thinking billed for nothing. The window starts
 * fresh and the worker has no job-level time budget (its lease is renewed for as long as the job runs), so there is
 * no 'not enough time left' case any more: the request is always sent when the page needs it and has a picture.
 * Effort 'high' (the owner's choice for hard pages, 2026-11-10); max_tokens LAST_RESORT_MAX_TOKENS: about 160 s of
 * output at the measured rate, so it only caps the cost of an attempt (16,000 x $22 per million = $0.35) where
 * OCR_AI_MAX_TOKENS would allow 64,000 on a retry.
 */
export const LAST_RESORT_SECONDS = 60;
export const LAST_RESORT_EFFORT: Effort = 'high';
export const LAST_RESORT_MAX_TOKENS = 16_000;
/** The check reason every item of a last-resort reading carries (with read_from_image; always check_carefully). */
export const LAST_RESORT_REASON = 'last_resort_read';

/**
 * A page that needed the last resort but was not sent it: 'no_picture' (its picture cannot go; `picture` says why, as
 * for imageRereadSkipped), the only reason since the last resort has a window of its own. Codes only.
 */
export interface LastResortSkip { page: number; reason: 'no_picture'; picture?: ImageRereadSkipReason }

export interface ReadingInput {
  facilityId: string;
  sourceSha256Hex: string;
  pages: readonly ReadPage[];
  /**
   * The exact document the pages were read from (the verified bytes and their detected media type), for the
   * image re-read of a flagged page. Without it every re-read is text only ('image_not_given').
   */
  document?: SourceDocument;
}

export interface ImageRereadSkip { page: number; reason: ImageRereadSkipReason }

/** Counts and codes only: safe to log and to keep in provenance. */
export interface ReadingSummary {
  status: ReadingStatus;
  firstPassModel: string | null;
  rereadModel: string | null;
  inferenceGeo: string | null;
  servedInferenceGeo: string | null;
  requests: number;
  refusals: number;
  pagesSent: number;
  rereadPages: number[];
  rereadFailedPages: number;
  /** Re-read pages answered from the picture of the page. */
  imageRereadPages: number[];
  /** Flagged pages that were re-read without the picture, and why. */
  imageRereadSkipped: ImageRereadSkip[];
  /**
   * Pages sent with the picture whose image re-read gave no usable answer, or kept no item where the first pass had
   * some (first-pass items kept, reread_failed).
   */
  imageRereadFailedPages: number[];
  droppedUngrounded: number;
  droppedUngroundedFirstPass: number;
  /**
   * droppedUngrounded by reason code (items.ts DROP_REASONS), from the reading each page ended with, plus the items
   * the last step left out (tidy.ts TIDY_DROP_REASONS: heading, duplicate_of_order; not in droppedUngrounded); and
   * the first pass's drops by reason (before that step). Codes and counts only, for the completion log: never in the
   * payload or provenance.
   */
  droppedByReason: Record<string, number>;
  droppedByReasonFirstPass: Record<string, number>;
  itemCount: number;
  flaggedPages: number;
  maskedNumbers: number;
  failureCode: string | null;
  usage: TokenUsage;
  /** The same use per model (requests and tokens), for ocr.record_worker_ai_usage; not stored in provenance. */
  modelUsage: AiUsageRecord[];
  /**
   * The same use per model and pass, for the ocr.reading.usage log only (both passes may use one model, so the
   * per-model records cannot show what the re-reads cost); not stored in provenance or the database.
   */
  passUsage: PassUsageRecord[];
  /**
   * Hard pages (flagged handwriting or low_confidence, re-read with the picture) sent for best-guess readings, the
   * number of hard-page reads sent (two per page), pages where only one of the two gave an answer, and how far the
   * two readings agreed. Codes and counts only.
   */
  hardPages: number[];
  hardPageReads: number;
  hardPageSingleReadPages: number[];
  hardPageAgreement: HardPageAgreement;
  /**
   * Zoom in the hard-page reads (zoom.ts), over every read: crops returned, calls refused at the call limit or the
   * request size budget, and calls answered "zoom unavailable" or refused as malformed. Counts only.
   */
  zoomCalls: number;
  zoomLimited: number;
  zoomFailed: number;
  /** Hard pages whose reads were offered the zoom tool (their prompt carried rule J). */
  hardPageZoomPages: number[];
  /**
   * Hard pages where OCR_AI_HARD_PAGE_DEADLINE_MS passed with a read still running (that read was aborted; the other
   * one, if it had finished, was used alone, else the page kept its first reading).
   */
  hardPageDeadlinePages: number[];
  /** One entry per hard-page read, for the ocr.reading.usage log only: counts and codes, never text. */
  hardPageReadUsage: HardReadUsage[];
  /**
   * Items the first pass kept (after its checks) over every page, before any re-read: a page that keeps its first
   * reading after a failed re-read keeps exactly these. For the completion log only (a count).
   */
  firstPassItemCount: number;
  /**
   * Every page-level way a reading of a page gave nothing usable, for one warn line each (worker.ts
   * ocr.reading.page_read_failed): codes and page numbers only. A hard page's reads have their own warn lines
   * (hardPageReadUsage `failure`), and the page one line here when neither answered.
   */
  pageReadFailures: PageReadFailure[];
  /**
   * The last resort (README "Last resort"): pages sent the one last-resort image re-read; those of them whose answer
   * was not usable (no answer, or no item kept); and pages that needed it but were not sent it, and why. Page numbers
   * and codes only: in provenance, and as counts in the completion log.
   */
  lastResortPages: number[];
  lastResortFailedPages: number[];
  lastResortSkipped: LastResortSkip[];
}

/**
 * A page whose reading in one pass gave nothing usable: the pass, and a reason code. 'refusal', 'max_tokens',
 * 'parse_error', 'schema_error', 'zoom_loop', 'incomplete' (how the answer ended); 'api_error' or 'api_rejected' (no
 * answer after the retries, or the API refused the request; `errorCode` is the safe AI_* code); 'kept_nothing' (an
 * answer, but no item of it held to the page while the first pass had some, so the first pass was kept);
 * 'hard_reads_failed' (neither of a hard page's two reads answered).
 */
export interface PageReadFailure { page: number; pass: ReadingPass; reason: string; errorCode?: string;
  /**
   * For the last resort ('last_resort_read'): how a 'last_resort_failed' request ended (as `reason` above, or
   * 'deadline'), or, for 'last_resort_no_picture', why the picture could not go (an imageRereadSkipped code).
   */
  detail?: string }

/**
 * How one hard-page read ended: its answer; aborted at the page's deadline; cut off at its output-token cap (or the
 * API's max_tokens); declined; or anything else (a transient failure after retries, a rejection, a malformed or
 * incomplete answer).
 */
export type HardReadEnd = 'answer' | 'deadline' | 'max_tokens' | 'refused' | 'error';

/**
 * Why a hard-page read gave no answer (README "A hard read always ends with an answer"): how its last turn ended
 * ('max_tokens', 'parse_error', 'schema_error', 'refusal', 'zoom_loop', 'incomplete'), the page's deadline
 * ('deadline'), or no answer from the API after the retries ('api_error') or a refused request ('api_rejected').
 * Codes only.
 */
export type HardReadFailure = 'max_tokens' | 'parse_error' | 'schema_error' | 'refusal' | 'zoom_loop' | 'incomplete'
  | 'deadline' | 'api_error' | 'api_rejected';

/** One hard-page read (read 1 or 2 of its page): what it used and how it went. Numbers and codes only. */
export interface HardReadUsage extends AiUsageRecord {
  page: number;
  read: 1 | 2;
  durationMs: number;
  /** Requests answered (zoom-loop turns), as against `requests`, which also counts failed attempts. */
  turns: number;
  zoomCalls: number;
  zoomLimited: number;
  /**
   * The first turn's effort, the follow-up turns' (null when there was no follow-up turn; the answer-only turn is not
   * one), and the answer-only turn's (null when it was not sent).
   */
  effort: Effort;
  followupEffort: Effort | null;
  forcedEffort: Effort | null;
  /** Why zoom stopped being offered (HardReadTrace.zoomClosed; the expected end of a zoom read); null: it was not. */
  zoomClosed: ZoomClosedReason | null;
  endedBy: HardReadEnd;
  /**
   * True when an attempt of this read was cut after the model had begun its answer (a deadline or shutdown abort, a
   * timeout or a stream failure; HardReadTrace.cutAttempts): its thinking so far was billed but the stream never
   * reported it, so outputTokens is a lower bound. The cost of such a read comes from the Anthropic usage and cost
   * report, not from this line.
   */
  outputTokensIncomplete: boolean;
  /** Why the read gave no answer; null when it answered. */
  failure: HardReadFailure | null;
  /** The safe AI_* code of an 'api_error' or 'api_rejected' failure; null otherwise. */
  errorCode: string | null;
  /** Why the read was sent its answer-only turn; null when it was not (it answered, or failed, on its own turns). */
  forcedAnswer: ForcedAnswerReason | null;
}

/** 'hard_page_read': both best-guess reads of a hard page (owner decision 2026-11-05), so their cost shows apart. */
export type ReadingPass = 'first_pass' | 'reread' | 'image_reread' | 'hard_page_read' | 'last_resort_read';
export interface PassUsageRecord extends AiUsageRecord { pass: ReadingPass;
  /** hard_page_read only: zoom crops returned in this pass (counts only). */
  zoomCalls?: number }

export interface ReadingOutcome { payload: PaperReadingPayload; summary: ReadingSummary }

/** The AI step's transient failure, after its own retries; the worker decides whether the job retries. */
export class ReadingUnavailableError extends Error {
  constructor(readonly code: string, readonly usage: TokenUsage, readonly modelUsage: AiUsageRecord[] = []) {
    super(code); this.name = 'ReadingUnavailableError';
  }
}

/**
 * Reading stopped for another reason (the worker shutting down, or an unexpected error) after the AI step had
 * started. It carries what was used until then so the worker can still record it while the job is held;
 * `cause` is the original error (for a shutdown, the abort signal's reason), which the worker handles as before.
 */
export class ReadingInterruptedError extends Error {
  constructor(override readonly cause: unknown, readonly usage: TokenUsage, readonly modelUsage: AiUsageRecord[]) {
    super('READING_INTERRUPTED'); this.name = 'ReadingInterruptedError';
  }
}

/** Per-model totals of what the AI step used, in the order the models were first asked. */
function addRecord(entry: AiUsageRecord, attempts: number, usage: TokenUsage): void {
  entry.requests += attempts;
  entry.inputTokens += usage.inputTokens;
  entry.outputTokens += usage.outputTokens;
  entry.cacheReadTokens += usage.cacheReadInputTokens;
  entry.cacheWriteTokens += usage.cacheCreationInputTokens;
}

class ModelUsageTally {
  private readonly byModel = new Map<string, AiUsageRecord>();
  private readonly byPass = new Map<string, PassUsageRecord>();
  add(model: string, pass: ReadingPass, attempts: number, usage: TokenUsage): void {
    const entry = this.byModel.get(model) ?? { model, requests: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0 };
    addRecord(entry, attempts, usage);
    this.byModel.set(model, entry);
    const key = `${pass}\u0000${model}`;
    const perPass = this.byPass.get(key) ?? { model, pass, requests: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0 };
    addRecord(perPass, attempts, usage);
    this.byPass.set(key, perPass);
  }
  /** Zoom crops returned in a pass, on that pass's record. */
  addZoomCalls(model: string, pass: ReadingPass, calls: number): void {
    const perPass = this.byPass.get(`${pass}\u0000${model}`);
    if (perPass) perPass.zoomCalls = (perPass.zoomCalls ?? 0) + calls;
  }
  list(): AiUsageRecord[] { return [...this.byModel.values()].map((entry) => ({ ...entry })); }
  listByPass(): PassUsageRecord[] { return [...this.byPass.values()].map((entry) => ({ ...entry })); }
}

interface PageState {
  page: number;
  /** Masked lines: what the model sees and what grounding checks against. */
  lines: ReadLine[];
  masker: Masker;
  /** The masker hid a number in this page's text: the picture would show it. */
  hasMaskedNumber: boolean;
  first: PageAnswer | null;
  firstCheck: PageCheck | null;
  final: PageCheck | null;
  declined: boolean;
  failed: boolean;
  reread: 'none' | 'done' | 'failed';
  /** The re-read's answer came from a request with the picture of the page. */
  fromImage: boolean;
}

const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
function addUsage(total: TokenUsage, more: TokenUsage): void {
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cacheReadInputTokens += more.cacheReadInputTokens;
  total.cacheCreationInputTokens += more.cacheCreationInputTokens;
}

export class PaperReadingService {
  constructor(private readonly config: ReadingConfig, private readonly client: PageModelClient | null) {}

  /** Whether the AI step runs for this facility at all (mode on, client built, facility allowed). */
  enabledFor(facilityId: string): boolean {
    if (this.config.OCR_AI_MODE !== 'claude' || this.client === null) return false;
    const allowed = this.config.OCR_AI_FACILITY_IDS;
    return allowed === undefined || allowed.includes(facilityId.toLowerCase());
  }

  /** A payload with no AI items (AI off, no text, or AI failed on the last attempt). */
  withoutItems(input: ReadingInput, status: Exclude<ReadingStatus, 'read' | 'ai_declined'>,
    usage: TokenUsage = zeroUsage(), failureCode: string | null = null,
    modelUsage: readonly AiUsageRecord[] = []): ReadingOutcome {
    const pages = input.pages.map((page) => lineOnlyPage(page));
    const aiUsed = status === 'ai_failed';
    const summary = this.summary(status, pages, [], 0, 0, [], 0, aiUsed, usage, 0, 0, 0, 0, null, failureCode,
      false, modelUsage.map((entry) => ({ ...entry })), [], [], [], []);
    return { payload: this.payload(pages, blankIdentity(), [], summary), summary };
  }

  async read(input: ReadingInput, signal: AbortSignal): Promise<ReadingOutcome> {
    const hasText = input.pages.some((page) => page.lines.length > 0);
    if (!hasText) return this.withoutItems(input, 'no_text');
    if (!this.enabledFor(input.facilityId)) return this.withoutItems(input, 'ai_off');
    const client = this.client!;
    const usage = zeroUsage();
    const tally = new ModelUsageTally();
    const pageConcurrency = this.config.OCR_AI_PAGE_CONCURRENCY ?? 1;
    // Any other way out after the AI step started keeps what was used, so the worker can record it.
    const interrupted = (error: unknown) => new ReadingInterruptedError(
      error instanceof AiInterruptedError ? error.reason : error, { ...usage }, tally.list());
    let requests = 0;
    let refusals = 0;
    const pageFailures: PageReadFailure[] = [];
    let servedGeo: string | null = null;
    const states: PageState[] = input.pages.filter((page) => page.lines.length > 0).map((page) => {
      const masker = createMasker();
      const lines = page.lines.map((line) => ({ ...line, text: masker.mask(line.text) }));
      return { page: page.page, masker, lines, hasMaskedNumber: masker.count > 0, first: null, firstCheck: null,
        final: null, declined: false, failed: false, reread: 'none', fromImage: false };
    });
    /** `hard`: a hard-page read's own abort signal (the job's, or its page's deadline), follow-up effort and trace. */
    const ask = async (state: PageState, model: string, effort: Effort, image?: PageImage,
      pass: ReadingPass = image ? 'image_reread' : 'reread', hardPage = false, zoom?: ZoomToolSession,
      hard?: { signal: AbortSignal; followupEffort: Effort; trace: HardReadTrace;
        answerBy?: { timeLeftMs: () => number; reserveMs: number } },
      // The last resort's own abort signal (the job's and its window's) and output-token cap.
      own?: { signal: AbortSignal; maxTokens: number }) => {
      let answer: PageAnswer;
      try {
        answer = await client.readPage({ model, effort, page: state.page, lines: state.lines,
          ...(image ? { image } : {}), ...(hardPage ? { hardPage: true } : {}), ...(zoom ? { zoom } : {}),
          ...(hard ? { followupEffort: hard.followupEffort, trace: hard.trace,
            ...(hard.answerBy ? { answerBy: hard.answerBy } : {}) } : {}),
          ...(own ? { maxTokens: own.maxTokens } : {}) },
        hard?.signal ?? own?.signal ?? signal);
      } catch (error) {
        // A call that ended without an answer still made requests (and may have used tokens): count them.
        // A call stopped before its first request (waiting for a permit) made none and adds nothing.
        if ((error instanceof AiTransientError || error instanceof AiRejectedError || error instanceof AiInterruptedError)
          && error.attempts > 0) {
          const spent: AiCallUse = error;
          requests += spent.attempts;
          addUsage(usage, spent.usage);
          tally.add(model, pass, spent.attempts, spent.usage);
        }
        throw error;
      }
      requests += answer.attempts;
      addUsage(usage, answer.usage);
      tally.add(model, pass, answer.attempts, answer.usage);
      if (answer.kind === 'refused') refusals += 1;
      if (answer.kind === 'answer' && answer.servedInferenceGeo) servedGeo = answer.servedInferenceGeo;
      return answer;
    };

    // First pass: every page with text, one request each, so a flagged page can be re-read alone. Up to
    // OCR_AI_PAGE_CONCURRENCY pages at once (each request also waits for the process-wide request limit);
    // after a failure no further page starts, and the pages already asked are awaited so their use counts.
    try {
      await forEachBounded(states, pageConcurrency, async (state) => {
        state.first = await ask(state, this.config.OCR_AI_FIRST_PASS_MODEL, this.config.OCR_AI_FIRST_PASS_EFFORT,
          undefined, 'first_pass');
        if (state.first.kind === 'answer') {
          state.firstCheck = checkPage({ page: state.page, lines: state.lines, answer: state.first.answer,
            sourceSha256Hex: input.sourceSha256Hex, readBy: 'first_pass', masker: state.masker });
          state.final = state.firstCheck;
        } else {
          pageFailures.push({ page: state.page, pass: 'first_pass', reason: answerFailure(state.first) });
        }
      });
    } catch (error) {
      if (error instanceof AiTransientError) throw new ReadingUnavailableError(error.code, usage, tally.list());
      if (error instanceof AiRejectedError) {
        return this.withoutItems(input, 'ai_failed', usage, error.code, tally.list());
      }
      throw interrupted(error);
    }

    // Re-read (owner decision 2026-11-05): pages the first pass failed on or declined get a text re-read; pages it
    // flagged get the image re-read, or, where the picture cannot go (or the API rejects or the model declines
    // it), a text re-read instead. Failed or declined pages first, then flagged pages in page order, up to
    // OCR_AI_MAX_REREAD_PAGES: a flagged page past the cap is not re-read, and a re-read that itself fails leaves
    // the page with its first reading (marked reread_failed).
    const failedFirst = states.filter((state) => state.first?.kind !== 'answer');
    const flagged = states.filter((state) => state.firstCheck !== null && state.firstCheck.flagReasons.length > 0);
    const candidates = [...failedFirst, ...flagged].slice(0, this.config.OCR_AI_MAX_REREAD_PAGES);
    const rereadAttempted = candidates.length > 0;
    const skipped: ImageRereadSkip[] = [];
    const imageFailed: number[] = [];
    // The picture, encoded once for the document and only when a page is sent with it; never logged or stored.
    let encoded: PageImage | null = null;
    const pictureOf = (decision: Extract<PageImageDecision, { kind: 'image' }>): PageImage => {
      encoded ??= { mediaType: decision.mediaType, base64: Buffer.from(decision.bytes.buffer, decision.bytes.byteOffset,
        decision.bytes.byteLength).toString('base64'), width: decision.width, height: decision.height };
      return encoded;
    };
    const rereadModel = this.config.OCR_AI_REREAD_MODEL;
    const rereadEffort = this.config.OCR_AI_REREAD_EFFORT;
    const hardEffort: Effort = this.config.OCR_AI_HARD_PAGE_EFFORT ?? 'high';
    const followupEffort: Effort = this.config.OCR_AI_HARD_PAGE_FOLLOWUP_EFFORT ?? 'high';
    const deadlineMs = this.config.OCR_AI_HARD_PAGE_DEADLINE_MS ?? HARD_PAGE_DEADLINE_MS;
    const lastResortWindowMs = (this.config.OCR_AI_LAST_RESORT_SECONDS ?? LAST_RESORT_SECONDS) * 1_000;
    const deadlinePages: number[] = [];
    const readUsage: HardReadUsage[] = [];
    const hardPages: number[] = [];
    const hardSingle: number[] = [];
    const agreement = noAgreement();
    const zoomTotals = noZoomStats();
    const zoomPages: number[] = [];
    let hardReads = 0;
    const zoomOn = this.config.OCR_AI_HARD_PAGE_ZOOM === 'on';
    const zoomMaxCalls = Math.min(ZOOM_MAX_CALLS, Math.max(0, this.config.OCR_AI_ZOOM_MAX_CALLS ?? ZOOM_MAX_CALLS));
    // One zoom per page (decoded at most once, on its first call, and shared by both reads); dropped with the reading.
    const zooms = new Map<number, PageZoom>();
    const zoomOf = (state: PageState, decision: Extract<PageImageDecision, { kind: 'image' }>): PageZoom | null => {
      const tier = imageTierOf(rereadModel);
      if (!zoomOn || zoomMaxCalls === 0 || tier === null) return null;
      let zoom = zooms.get(state.page);
      if (!zoom) {
        zoom = createPageZoom({ mediaType: decision.mediaType, bytes: decision.bytes, width: decision.width,
          height: decision.height }, resizedSize(decision.width, decision.height, tier), tier);
        zooms.set(state.page, zoom);
      }
      // A picture over zoom's limits by its bytes (zoom.ts zoomDecodable: size, PNG chunks, bit depth and interlacing,
      // JPEG structure, components and scans) is never offered the tool: no rule J, and prompt version 3 for the page.
      return zoom.available() ? zoom : null;
    };
    /**
     * A hard page (owner decision 2026-11-05, about 18:40 UTC): the same best-guess request with the picture sent
     * twice, at the hard-page effort, then the two readings compared (hard-page.ts). One reading failing or declining
     * leaves the other alone (single_reading_only on every item). Both failing: as a failed image re-read, except
     * that, as for the image re-read, each read refused as an invalid request or declined sends the page to a text
     * re-read instead ('image_refused' when either declined, else 'image_rejected').
     * Zoom (owner decision 2026-11-05, about 18:45 UTC): with OCR_AI_HARD_PAGE_ZOOM on, each read may ask for up to
     * OCR_AI_ZOOM_MAX_CALLS enlarged crops of the picture (zoom.ts), each read with its own count.
     * Bounds (coordinator 2026-11-10): the two reads start together (each holds a request permit only per attempt;
     * config requires at least 2), and OCR_AI_HARD_PAGE_DEADLINE_MS after they start every read still running is
     * aborted through its own signal, which ends a permit wait, a request, a zoom crop or a backoff sleep alike. A read
     * that had answered is then used alone (single_reading_only); none answered: a failed image re-read (the first
     * pass kept, reread_failed). The job is never failed for it.
     */
    const readHard = async (state: PageState, picture: PageImage,
      decision: Extract<PageImageDecision, { kind: 'image' }>): Promise<{ kind: 'read'; check: PageCheck }
      | { kind: 'fallback'; reason: 'image_rejected' | 'image_refused' } | { kind: 'failed' }> => {
      hardPages.push(state.page);
      hardReads += 2;
      const zoom = zoomOf(state, decision);
      if (zoom) zoomPages.push(state.page);
      const reads = [0, 1].map(() => ({
        session: zoom ? createZoomSession(zoom, state.page, zoomMaxCalls, picture.base64.length) : undefined,
        controller: new AbortController(), trace: { turns: 0, followupTurns: 0, cutAttempts: 0 } as HardReadTrace,
        done: false, cut: false, durationMs: 0, attempts: 0, usage: zeroUsage(),
      }));
      const started = Date.now();
      // The answer-only turn's time (README "A hard read always ends with an answer"): at most a third of the deadline,
      // and none at a deadline too short for a turn and an answer-only turn (answerReserveMs).
      const reserveMs = answerReserveMs(deadlineMs);
      const answerBy = reserveMs > 0 ? { timeLeftMs: () => deadlineMs - (Date.now() - started), reserveMs } : undefined;
      const deadline = setTimeout(() => {
        for (const read of reads) {
          if (read.done) continue;
          read.cut = true;
          read.controller.abort(new HardPageDeadlineError());
        }
      }, deadlineMs);
      let settled: PromiseSettledResult<PageAnswer>[];
      try {
        settled = await Promise.allSettled(reads.map(async (read) => {
          try {
            const answer = await ask(state, rereadModel, hardEffort, picture, 'hard_page_read', true, read.session,
              { signal: AbortSignal.any([signal, read.controller.signal]), followupEffort, trace: read.trace,
                ...(answerBy ? { answerBy } : {}) });
            read.attempts = answer.attempts;
            read.usage = answer.usage;
            return answer;
          } catch (error) {
            if (error instanceof AiTransientError || error instanceof AiRejectedError || error instanceof AiInterruptedError) {
              read.attempts = error.attempts;
              read.usage = { ...error.usage };
            }
            throw error;
          } finally {
            read.done = true;
            read.durationMs = Date.now() - started;
          }
        }));
      } finally {
        clearTimeout(deadline);
      }
      // Counted however the reads ended (a failed read's crops were still sent).
      for (const read of reads) {
        if (!read.session) continue;
        addZoomStats(zoomTotals, read.session.stats);
        tally.addZoomCalls(rereadModel, 'hard_page_read', read.session.stats.calls);
      }
      reads.forEach((read, index) => {
        const result = settled[index]!;
        readUsage.push({ page: state.page, read: index === 0 ? 1 : 2, model: rereadModel, requests: read.attempts,
          inputTokens: read.usage.inputTokens, outputTokens: read.usage.outputTokens,
          cacheReadTokens: read.usage.cacheReadInputTokens, cacheWriteTokens: read.usage.cacheCreationInputTokens,
          durationMs: read.durationMs, turns: read.trace.turns, zoomCalls: read.session?.stats.calls ?? 0,
          zoomLimited: read.session?.stats.limited ?? 0, effort: hardEffort,
          followupEffort: read.trace.followupTurns > 0 ? followupEffort : null,
          forcedEffort: read.trace.forced === undefined ? null : HARD_READ_FORCED_EFFORT,
          zoomClosed: read.trace.zoomClosed ?? null,
          endedBy: endOf(result, read.cut && !signal.aborted),
          outputTokensIncomplete: read.trace.cutAttempts > 0,
          ...failureOf(result, read.cut && !signal.aborted), forcedAnswer: read.trace.forced ?? null });
      });
      // A read the deadline cut is not an error of the job; a shutdown (or an unexpected error) still is.
      const cutByDeadline = (index: number) => reads[index]!.cut && !signal.aborted
        && settled[index]!.status === 'rejected';
      if (reads.some((read, index) => read.cut && cutByDeadline(index))) deadlinePages.push(state.page);
      settled.forEach((result, index) => {
        if (result.status === 'rejected' && !cutByDeadline(index) && (signal.aborted
          || !(result.reason instanceof AiTransientError || result.reason instanceof AiRejectedError))) throw result.reason;
      });
      const answers = settled.flatMap((result) => result.status === 'fulfilled' && result.value.kind === 'answer'
        ? [result.value.answer] : []);
      if (answers.length === 0) {
        const kinds = settled.map((result, index) => result.status === 'fulfilled' ? result.value.kind
          : cutByDeadline(index) ? 'deadline'
            : result.reason instanceof AiRejectedError && result.reason.code === 'AI_BAD_REQUEST' && result.reason.invalidRequest
              ? 'invalid' : 'error');
        // Each read either refused as an invalid request or declined: the picture is the likely cause either way.
        if (kinds.every((kind) => kind === 'invalid' || kind === 'refused')) {
          return { kind: 'fallback', reason: kinds.includes('refused') ? 'image_refused' : 'image_rejected' };
        }
        pageFailures.push({ page: state.page, pass: 'hard_page_read', reason: 'hard_reads_failed' });
        return { kind: 'failed' };
      }
      if (answers.length === 1) hardSingle.push(state.page);
      const readings = answers.map((raw) => {
        const prepared = prepareHardAnswer(raw);
        return { answer: prepared, check: checkPage({ page: state.page, lines: state.lines, answer: prepared,
          sourceSha256Hex: input.sourceSha256Hex, readBy: 'reread', masker: state.masker, fromImage: true }) };
      });
      const merged = mergeHardReadings(readings, input.sourceSha256Hex);
      for (const key of Object.keys(agreement) as (keyof HardPageAgreement)[]) agreement[key] += merged.agreement[key];
      return { kind: 'read', check: merged.check };
    };
    const lastResortPages: number[] = [];
    const lastResortFailed: number[] = [];
    const lastResortSkipped: LastResortSkip[] = [];
    /**
     * The last resort (coordinator decision 2026-11-10, after staging job 566c38bf gave the owner nothing): one
     * ordinary image re-read of a page with no usable reading (README "Last resort"), at LAST_RESORT_EFFORT, capped at
     * LAST_RESORT_MAX_TOKENS, and aborted when its own window (lastResortWindowMs from now) ends, through the same
     * kind of abort signal as a hard read (the job's and its window's together; a shutdown still stops the reading).
     * Its items go through checkPage as any image re-read's; one that keeps none is a failure ('kept_nothing'). Never
     * throws for the API or the window's end: a failed last resort is a warn line.
     */
    const lastResort = async (state: PageState, decision: Extract<PageImageDecision, { kind: 'image' }>,
    ): Promise<{ kind: 'read'; check: PageCheck } | { kind: 'failed' }> => {
      lastResortPages.push(state.page);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new HardPageDeadlineError()), lastResortWindowMs);
      let detail: string;
      let errorCode: string | undefined;
      try {
        const answer = await ask(state, rereadModel, LAST_RESORT_EFFORT, pictureOf(decision), 'last_resort_read', false,
          undefined, undefined, { signal: AbortSignal.any([signal, controller.signal]), maxTokens: LAST_RESORT_MAX_TOKENS });
        if (answer.kind === 'answer') {
          const check = checkPage({ page: state.page, lines: state.lines, answer: answer.answer,
            sourceSha256Hex: input.sourceSha256Hex, readBy: 'reread', masker: state.masker, fromImage: true });
          if (check.items.length > 0) return { kind: 'read', check };
          detail = 'kept_nothing';
        } else {
          detail = answerFailure(answer);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof AiInterruptedError && controller.signal.aborted) detail = 'deadline';
        else if (error instanceof AiTransientError) { detail = 'api_error'; errorCode = error.code; }
        else if (error instanceof AiRejectedError) { detail = 'api_rejected'; errorCode = error.code; }
        else throw error;
      } finally {
        clearTimeout(timer);
      }
      lastResortFailed.push(state.page);
      pageFailures.push({ page: state.page, pass: 'last_resort_read', reason: 'last_resort_failed', detail,
        ...(errorCode === undefined ? {} : { errorCode }) });
      return { kind: 'failed' };
    };
    await forEachBounded(candidates, pageConcurrency, async (state) => {
      let answer: PageAnswer | null = null;
      // The page's reading came from the last resort (its items are marked last_resort_read).
      let lastResortRead = false;
      let fromImage = false;
      let hardCheck: PageCheck | null = null;
      // Only a flagged page (one the first pass answered) may go with its picture.
      const decision = state.firstCheck === null ? null : this.imageDecision(state, input);
      // The pass of the request being made, for a warn line if it gives nothing.
      let pass: ReadingPass = 'reread';
      try {
        if (decision?.kind === 'image' && this.isHardPage(state)) {
          const hard = await readHard(state, pictureOf(decision), decision);
          if (hard.kind === 'read' && hard.check.items.length === 0 && state.firstCheck!.items.length === 0) {
            // A hard read answered, but no item of the hard reading held to the page, and the first pass kept
            // nothing either: still no usable reading, so the last resort as for failed hard reads (README "Last
            // resort"), in its own window.
            pageFailures.push({ page: state.page, pass: 'hard_page_read', reason: 'kept_nothing' });
            const last = await lastResort(state, decision);
            if (last.kind === 'read') {
              hardCheck = last.check;
              fromImage = true;
              lastResortRead = true;
            } else {
              imageFailed.push(state.page);
            }
          } else if (hard.kind === 'read') {
            hardCheck = hard.check;
            fromImage = true;
          } else if (hard.kind === 'fallback') {
            skipped.push({ page: state.page, reason: hard.reason });
            answer = await ask(state, rereadModel, rereadEffort);
            if (answer.kind !== 'answer') pageFailures.push({ page: state.page, pass, reason: answerFailure(answer) });
          } else if (state.firstCheck!.items.length === 0) {
            // Neither hard read answered and the first pass kept nothing on the page: nothing at all to show, so one
            // last-resort image re-read in a window of its own, even when the deadline cut both reads (README "Last
            // resort").
            const last = await lastResort(state, decision);
            if (last.kind === 'read') {
              hardCheck = last.check;
              fromImage = true;
              lastResortRead = true;
            } else {
              imageFailed.push(state.page);
            }
          } else {
            imageFailed.push(state.page);
          }
        } else if (decision?.kind === 'image') {
          try {
            pass = 'image_reread';
            answer = await ask(state, rereadModel, rereadEffort, pictureOf(decision));
            fromImage = true;
          } catch (error) {
            if (signal.aborted) throw error;
            // The API refused the request with the picture as an invalid request (400 invalid_request_error): the
            // picture is the likely cause, so re-read the text instead. Any other rejection (key, permission,
            // model) would refuse the text request too, and a transient failure has had its retries: neither is
            // blamed on the picture, and the page goes on as a failed re-read.
            if (error instanceof AiRejectedError && error.code === 'AI_BAD_REQUEST' && error.invalidRequest) {
              skipped.push({ page: state.page, reason: 'image_rejected' });
              pass = 'reread';
              answer = await ask(state, rereadModel, rereadEffort);
            } else {
              if (error instanceof AiTransientError || error instanceof AiRejectedError) imageFailed.push(state.page);
              throw error;
            }
          }
          if (fromImage && answer.kind === 'refused') {
            // The decline may be about the picture: re-read the text instead, once.
            pageFailures.push({ page: state.page, pass, reason: 'refusal' });
            skipped.push({ page: state.page, reason: 'image_refused' });
            fromImage = false;
            pass = 'reread';
            answer = await ask(state, rereadModel, rereadEffort);
          } else if (fromImage && answer.kind !== 'answer') {
            imageFailed.push(state.page);
          }
          if (answer.kind !== 'answer') pageFailures.push({ page: state.page, pass, reason: answerFailure(answer) });
        } else {
          if (decision !== null) skipped.push({ page: state.page, reason: decision.reason });
          answer = await ask(state, rereadModel, rereadEffort);
          if (answer.kind !== 'answer') pageFailures.push({ page: state.page, pass, reason: answerFailure(answer) });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof AiTransientError) && !(error instanceof AiRejectedError)) throw error;
        pageFailures.push({ page: state.page, pass, reason: error instanceof AiTransientError ? 'api_error' : 'api_rejected',
          errorCode: error.code });
      }
      if ((hardCheck !== null || answer?.kind === 'answer') && state.firstCheck) {
        // A flagged page the first pass answered, re-read from the picture or the text: merged, fail-safe, so no
        // first-pass item without an exact twin in the second reading is lost. A hard page's two readings were
        // already merged into one (readHard).
        const read = hardCheck ?? checkPage({ page: state.page, lines: state.lines,
          answer: (answer as Extract<PageAnswer, { kind: 'answer' }>).answer,
          sourceSha256Hex: input.sourceSha256Hex, readBy: 'reread', masker: state.masker, fromImage });
        if (read.items.length === 0 && state.firstCheck.items.length > 0) {
          // Nothing from the second reading held to the page while the first pass had items: not a usable reading.
          if (fromImage) imageFailed.push(state.page);
          pageFailures.push({ page: state.page, pass: hardCheck !== null ? 'hard_page_read' : pass, reason: 'kept_nothing' });
          state.reread = 'failed';
          state.final = markRereadFailed(state.firstCheck);
          return;
        }
        state.final = mergeReread(state.firstCheck, read, state.lines, fromImage ? 'image' : 'text');
        if (lastResortRead) state.final = markLastResort(state.final);
        state.reread = 'done';
        state.fromImage = fromImage;
        return;
      }
      // A page whose first pass failed or was declined: nothing to merge, the re-read stands, if it kept anything.
      if (answer?.kind === 'answer') {
        const check = checkPage({ page: state.page, lines: state.lines, answer: answer.answer,
          sourceSha256Hex: input.sourceSha256Hex, readBy: 'reread', masker: state.masker });
        if (check.items.length > 0) {
          state.final = check;
          state.reread = 'done';
          return;
        }
        // The re-read answered but no item held to the page: still no reading of the page at all (README "Last
        // resort", case b).
        pageFailures.push({ page: state.page, pass, reason: 'kept_nothing' });
      }
      if (state.firstCheck === null) {
        // The first pass failed or was declined and so did its re-read: no reading of the page at all. The last
        // resort, with the picture, in a window of its own (as for a hard page); without a picture, a warn
        // line saying why (README "Last resort").
        const picture = this.imageDecision(state, input);
        if (picture.kind === 'image') {
          const last = await lastResort(state, picture);
          if (last.kind === 'read') {
            state.final = markLastResort(last.check);
            state.reread = 'done';
            state.fromImage = true;
            state.declined = false;
            state.failed = false;
            return;
          }
          imageFailed.push(state.page);
        } else {
          lastResortSkipped.push({ page: state.page, reason: 'no_picture', picture: picture.reason });
          pageFailures.push({ page: state.page, pass: 'last_resort_read', reason: 'last_resort_no_picture',
            detail: picture.reason });
        }
      }
      state.reread = 'failed';
      if (state.first?.kind === 'refused') state.declined = answer?.kind === 'refused' || answer === null;
      else if (state.first?.kind === 'failed') state.failed = true;
      else if (state.firstCheck) state.final = markRereadFailed(state.firstCheck);
    }).catch((error: unknown) => { throw interrupted(error); });
    for (const state of states) {
      if (state.first?.kind === 'refused' && state.final === null) state.declined = true;
      if (state.first?.kind === 'failed' && state.final === null) state.failed = true;
      // Headings and notes repeating an order are left out of every page's reading, however it was read (tidy.ts;
      // counted in droppedByReason as heading and duplicate_of_order).
      if (state.final !== null) state.final = tidyPage(state.final);
    }

    // Ids are unique within the whole extraction, not only within a page.
    const items = uniqueItemIds(states.flatMap((state) => state.final?.items ?? []));
    const read = states.filter((state) => state.final !== null).length;
    const declined = states.filter((state) => state.declined).length;
    // Any page read: 'read' (declined or failed pages are flagged). None: declined only when every model
    // declined every page; a page that could not be read for another reason makes it 'ai_failed'.
    const status: ReadingStatus = read > 0 ? 'read' : declined === states.length ? 'ai_declined' : 'ai_failed';
    const byPage = new Map(states.map((state) => [state.page, state]));
    const pages: PaperPage[] = input.pages.map((page) => {
      const state = byPage.get(page.page);
      if (!state) return lineOnlyPage(page);
      const reasons = new Set<FlagReason>(state.final?.flagReasons ?? lineFlags(page.lines));
      if (state.declined) reasons.add('ai_declined');
      if (state.failed || state.reread === 'failed') reasons.add('ai_unsure');
      return { page: page.page, flagged: reasons.size > 0, flagReasons: orderedFlags(reasons), lines: page.lines.map(toLine) };
    });
    const identity = states.map((state) => state.final?.identity).find((candidate): candidate is PaperIdentity =>
      candidate !== undefined && (candidate.nameAsWritten !== null || candidate.folderNumberAsWritten !== null))
      ?? states.map((state) => state.final?.identity).find((candidate): candidate is PaperIdentity =>
        candidate !== undefined && candidate.lineIds.length > 0) ?? blankIdentity();
    const kept = status === 'read' ? items : [];
    const dropped = states.reduce((sum, state) => sum + (state.final?.droppedUngrounded ?? 0), 0);
    const droppedFirst = states.reduce((sum, state) => sum + (state.firstCheck?.droppedUngrounded ?? 0), 0);
    const rereadPages = states.filter((state) => state.reread === 'done').map((state) => state.page);
    const imageRereadPages = states.filter((state) => state.reread === 'done' && state.fromImage)
      .map((state) => state.page);
    const summary = this.summary(status, pages, kept, dropped, droppedFirst, rereadPages,
      states.filter((state) => state.reread === 'failed').length, true, usage, requests, refusals, states.length,
      states.reduce((sum, state) => sum + state.masker.count, 0), servedGeo, null, rereadAttempted, tally.list(),
      tally.listByPass(),
      imageRereadPages, [...skipped].sort((a, b) => a.page - b.page), [...imageFailed].sort((a, b) => a - b));
    summary.droppedByReason = sumReasons(states.map((state) => state.final?.droppedByReason));
    summary.droppedByReasonFirstPass = sumReasons(states.map((state) => state.firstCheck?.droppedByReason));
    summary.hardPages = [...hardPages].sort((a, b) => a - b);
    summary.hardPageReads = hardReads;
    summary.hardPageSingleReadPages = [...hardSingle].sort((a, b) => a - b);
    summary.hardPageAgreement = agreement;
    summary.zoomCalls = zoomTotals.calls;
    summary.zoomLimited = zoomTotals.limited;
    summary.zoomFailed = zoomTotals.failed;
    summary.hardPageZoomPages = zoomPages;
    summary.hardPageDeadlinePages = [...deadlinePages].sort((a, b) => a - b);
    summary.hardPageReadUsage = readUsage;
    summary.firstPassItemCount = states.reduce((sum, state) => sum + (state.firstCheck?.items.length ?? 0), 0);
    summary.pageReadFailures = [...pageFailures].sort((a, b) => a.page - b.page);
    summary.lastResortPages = [...lastResortPages].sort((a, b) => a - b);
    summary.lastResortFailedPages = [...lastResortFailed].sort((a, b) => a - b);
    summary.lastResortSkipped = [...lastResortSkipped].sort((a, b) => a.page - b.page);
    return { payload: this.payload(pages, status === 'read' ? identity : blankIdentity(), kept, summary), summary };
  }

  /**
   * Whether a flagged page's re-read may carry the picture of the page: the setting on; the document a one-page PNG
   * or JPEG within the image limits and upright (pageImageFor); the re-read model on the list of known image tiers;
   * and, when OCR_AI_IMAGE_MASKED_PAGES is 'text_only', no number hidden in the page's text (the picture would
   * show it; the default 'send' allows it).
   */
  private imageDecision(state: PageState, input: ReadingInput): PageImageDecision {
    if (this.config.OCR_AI_IMAGE_REREAD !== 'on') return { kind: 'skip', reason: 'image_reread_off' };
    const decision = pageImageFor(input.document, state.page, input.pages.length);
    if (decision.kind === 'image' && imageTierOf(this.config.OCR_AI_REREAD_MODEL) === null) {
      return { kind: 'skip', reason: 'image_tier_unknown' };
    }
    if (decision.kind === 'image' && state.hasMaskedNumber && this.config.OCR_AI_IMAGE_MASKED_PAGES === 'text_only') {
      return { kind: 'skip', reason: 'image_has_masked_number' };
    }
    return decision;
  }

  /**
   * A hard page: the first pass flagged it handwriting or low_confidence (owner decision 2026-11-05, about 18:40 UTC,
   * "recommended with prompt that makes them do best result") and the hard-page reads are on. Called only for a page
   * whose re-read goes with its picture; every other path keeps rule D ("[unreadable]", never a guess).
   */
  private isHardPage(state: PageState): boolean {
    return this.config.OCR_AI_HARD_PAGE_READS === 'on' && state.firstCheck !== null
      && state.firstCheck.flagReasons.some((reason) => reason === 'handwriting' || reason === 'low_confidence');
  }

  private summary(status: ReadingStatus, pages: readonly PaperPage[], items: readonly PaperItem[], dropped: number,
    droppedFirst: number, rereadPages: number[], rereadFailed: number, aiUsed: boolean, usage: TokenUsage,
    requests: number, refusals: number, pagesSent: number, masked: number, servedGeo: string | null,
    failureCode: string | null, rereadAttempted: boolean, modelUsage: AiUsageRecord[], passUsage: PassUsageRecord[],
    imageRereadPages: number[], imageRereadSkipped: ImageRereadSkip[], imageRereadFailedPages: number[]): ReadingSummary {
    return {
      status,
      firstPassModel: aiUsed ? this.config.OCR_AI_FIRST_PASS_MODEL : null,
      rereadModel: aiUsed && rereadAttempted ? this.config.OCR_AI_REREAD_MODEL : null,
      inferenceGeo: aiUsed ? INFERENCE_GEO : null,
      servedInferenceGeo: servedGeo,
      requests, refusals, pagesSent, rereadPages, rereadFailedPages: rereadFailed, imageRereadPages, imageRereadSkipped,
      imageRereadFailedPages,
      droppedUngrounded: dropped, droppedUngroundedFirstPass: droppedFirst, droppedByReason: {},
      droppedByReasonFirstPass: {}, itemCount: items.length,
      flaggedPages: pages.filter((page) => page.flagged).length, maskedNumbers: masked, failureCode, usage,
      modelUsage, passUsage, hardPages: [], hardPageReads: 0, hardPageSingleReadPages: [],
      hardPageAgreement: noAgreement(), zoomCalls: 0, zoomLimited: 0, zoomFailed: 0, hardPageZoomPages: [],
      hardPageDeadlinePages: [], hardPageReadUsage: [], firstPassItemCount: 0, pageReadFailures: [],
      lastResortPages: [], lastResortFailedPages: [], lastResortSkipped: [],
    };
  }

  private payload(pages: PaperPage[], identity: PaperIdentity, items: PaperItem[], summary: ReadingSummary): PaperReadingPayload {
    return {
      contract: PAPER_READING_CONTRACT,
      pages,
      identity,
      items,
      reading: {
        status: summary.status,
        firstPassModel: summary.firstPassModel,
        rereadModel: summary.rereadModel,
        rereadPages: summary.rereadPages,
        droppedUngrounded: summary.droppedUngrounded,
        itemCount: items.length,
        promptVersion: PROMPT_VERSION,
        schemaVersion: `${PAPER_READING_SCHEMA_VERSION}+${MODEL_SCHEMA_VERSION}`,
        imageRereadPages: summary.imageRereadPages,
        imageRereadSkipped: summary.imageRereadSkipped.map((skip) => ({ ...skip })),
        imageRereadFailedPages: [...summary.imageRereadFailedPages],
      },
    };
  }
}

/** The abort reason a hard page's deadline gives its reads still running (a code only). */
export class HardPageDeadlineError extends Error {
  constructor() { super('HARD_PAGE_DEADLINE'); this.name = 'HardPageDeadlineError'; }
}

function endOf(result: PromiseSettledResult<PageAnswer>, cut: boolean): HardReadEnd {
  if (result.status === 'rejected') return cut ? 'deadline' : 'error';
  const answer = result.value;
  if (answer.kind === 'answer') return 'answer';
  if (answer.kind === 'refused') return 'refused';
  return answer.reason === 'max_tokens' ? 'max_tokens' : 'error';
}

/** Why a hard-page read gave no answer, and the safe error code where the API gave none (README). */
function failureOf(result: PromiseSettledResult<PageAnswer>, cut: boolean):
  { failure: HardReadFailure | null; errorCode: string | null } {
  if (result.status === 'rejected') {
    if (cut) return { failure: 'deadline', errorCode: null };
    const error: unknown = result.reason;
    if (error instanceof AiRejectedError) return { failure: 'api_rejected', errorCode: error.code };
    return { failure: 'api_error', errorCode: error instanceof AiTransientError ? error.code : null };
  }
  const answer = result.value;
  if (answer.kind === 'answer') return { failure: null, errorCode: null };
  return { failure: answerFailure(answer) as HardReadFailure, errorCode: null };
}

/** The reason code of an answer that is not one (refused, or failed with its finer code). */
function answerFailure(answer: Exclude<PageAnswer, { kind: 'answer' }>): string {
  if (answer.kind === 'refused') return 'refusal';
  return answer.code ?? (answer.reason === 'malformed' ? 'schema_error' : answer.reason);
}

function addZoomStats(total: ZoomStats, more: ZoomStats): void {
  total.calls += more.calls;
  total.limited += more.limited;
  total.failed += more.failed;
}

/** Drop counts by reason summed over pages, with the codes in a stable (sorted) order. */
function sumReasons(maps: readonly (Readonly<Record<string, number>> | undefined)[]): Record<string, number> {
  const total = new Map<string, number>();
  for (const map of maps) for (const [code, count] of Object.entries(map ?? {})) total.set(code, (total.get(code) ?? 0) + count);
  return Object.fromEntries([...total.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** First-pass items kept when the re-read did not work: each one goes to a person. */
function markRereadFailed(check: PageCheck): PageCheck {
  return { ...check, items: check.items.map((item) => {
    const checkReasons = item.checkReasons.includes('reread_failed') ? item.checkReasons
      : [...item.checkReasons, 'reread_failed'];
    return { ...item, confidence: 'check_carefully' as const, checkReasons,
      checkReason: item.checkReason ?? "A second reading of this page didn't work; check it against the paper." };
  }) };
}

/** A last-resort reading's items: each goes to a person, with last_resort_read (README "Last resort"). */
function markLastResort(check: PageCheck): PageCheck {
  return { ...check, items: check.items.map((item) => {
    const checkReasons = item.checkReasons.includes(LAST_RESORT_REASON) ? item.checkReasons
      : [...item.checkReasons, LAST_RESORT_REASON];
    return { ...item, confidence: 'check_carefully' as const, checkReasons, checkReason: checkReasonSentence(checkReasons) };
  }) };
}

const FLAG_ORDER: readonly FlagReason[] = ['low_confidence', 'handwriting', 'many_dropped', 'ai_unsure',
  'possible_missed_item', 'ai_declined'];
function orderedFlags(reasons: ReadonlySet<FlagReason>): FlagReason[] {
  return FLAG_ORDER.filter((reason) => reasons.has(reason));
}

/** Without an AI reading, a page is flagged from its own lines' legibility. */
function lineFlags(lines: readonly ReadLine[]): FlagReason[] {
  return [
    ...(lines.some((line) => !line.handwritten && line.confidence < REVIEW_BELOW) ? ['low_confidence' as const] : []),
    ...(lines.some((line) => line.handwritten && line.confidence < REVIEW_BELOW) ? ['handwriting' as const] : []),
  ];
}

function toLine(line: ReadLine) {
  return { id: line.id, text: line.text, box: line.box, confidence: line.confidence, handwritten: line.handwritten };
}

function lineOnlyPage(page: ReadPage): PaperPage {
  const reasons = lineFlags(page.lines);
  return { page: page.page, flagged: reasons.length > 0, flagReasons: reasons, lines: page.lines.map(toLine) };
}
