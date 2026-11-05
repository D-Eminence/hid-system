import type { OcrWorkerConfig } from '../config';
import { forEachBounded } from '../semaphore';
import type { AiUsageRecord, ReadLine, ReadPage } from '../types';
import { AiInterruptedError, AiRejectedError, AiTransientError, INFERENCE_GEO, type AiCallUse, type Effort,
  type PageAnswer, type PageModelClient, type TokenUsage } from './claude.client';
import {
  PAPER_READING_CONTRACT, PAPER_READING_SCHEMA_VERSION, type FlagReason, type ImageRereadSkipReason, type PaperIdentity,
  type PaperItem, type PaperPage, type PaperReadingPayload, type ReadingStatus,
} from './contract';
import { mergeHardReadings, noAgreement, prepareHardAnswer, type HardPageAgreement } from './hard-page';
import { blankIdentity, checkPage, mergeReread, REVIEW_BELOW, uniqueItemIds, type PageCheck } from './items';
import { createMasker, type Masker } from './masking';
import { imageTierOf, pageImageFor, type PageImage, type PageImageDecision, type SourceDocument } from './page-image';
import { MODEL_SCHEMA_VERSION, PROMPT_VERSION } from './prompt';

export type ReadingConfig = Pick<OcrWorkerConfig, 'OCR_AI_MODE' | 'OCR_AI_FACILITY_IDS' | 'OCR_AI_FIRST_PASS_MODEL'
  | 'OCR_AI_FIRST_PASS_EFFORT' | 'OCR_AI_REREAD_MODEL' | 'OCR_AI_REREAD_EFFORT' | 'OCR_AI_MAX_REREAD_PAGES'>
  // Pages of one document read at once; one at a time when not given. The image re-read is off when not given,
  // and a page with a masked number is sent as a picture unless OCR_AI_IMAGE_MASKED_PAGES is 'text_only'.
  & Partial<Pick<OcrWorkerConfig, 'OCR_AI_PAGE_CONCURRENCY' | 'OCR_AI_IMAGE_REREAD' | 'OCR_AI_IMAGE_MASKED_PAGES'>>
  // Hard-page best-guess reads (two per hard page); off when not given, as the image re-read. Effort 'max' when not
  // given.
  & Partial<Pick<OcrWorkerConfig, 'OCR_AI_HARD_PAGE_READS' | 'OCR_AI_HARD_PAGE_EFFORT'>>;

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
   * droppedUngrounded by reason code (items.ts DROP_REASONS), from the reading each page ended with; and the same
   * for the first pass. Codes and counts only, for the completion log: never in the payload or provenance.
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
}

/** 'hard_page_read': both best-guess reads of a hard page (owner decision 2026-11-05), so their cost shows apart. */
export type ReadingPass = 'first_pass' | 'reread' | 'image_reread' | 'hard_page_read';
export interface PassUsageRecord extends AiUsageRecord { pass: ReadingPass }

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
    let servedGeo: string | null = null;
    const states: PageState[] = input.pages.filter((page) => page.lines.length > 0).map((page) => {
      const masker = createMasker();
      const lines = page.lines.map((line) => ({ ...line, text: masker.mask(line.text) }));
      return { page: page.page, masker, lines, hasMaskedNumber: masker.count > 0, first: null, firstCheck: null,
        final: null, declined: false, failed: false, reread: 'none', fromImage: false };
    });
    const ask = async (state: PageState, model: string, effort: Effort, image?: PageImage,
      pass: ReadingPass = image ? 'image_reread' : 'reread', hardPage = false) => {
      let answer: PageAnswer;
      try {
        answer = await client.readPage({ model, effort, page: state.page, lines: state.lines,
          ...(image ? { image } : {}), ...(hardPage ? { hardPage: true } : {}) }, signal);
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
    const hardEffort: Effort = this.config.OCR_AI_HARD_PAGE_EFFORT ?? 'max';
    const hardPages: number[] = [];
    const hardSingle: number[] = [];
    const agreement = noAgreement();
    let hardReads = 0;
    /**
     * A hard page (owner decision 2026-11-05, about 18:40 UTC): the same best-guess request with the picture sent
     * twice, at the hard-page effort, then the two readings compared (hard-page.ts). One reading failing or declining
     * leaves the other alone (single_reading_only on every item). Both failing: as a failed image re-read, except
     * that, as for the image re-read, both refused as an invalid request ('image_rejected') or both declined
     * ('image_refused') sends the page to a text re-read instead.
     * Zoom (deferred): a later step could ask for a crop here, between the two reads and the merge (zoom.ts).
     */
    const readHard = async (state: PageState, picture: PageImage): Promise<{ kind: 'read'; check: PageCheck }
      | { kind: 'fallback'; reason: 'image_rejected' | 'image_refused' } | { kind: 'failed' }> => {
      hardPages.push(state.page);
      hardReads += 2;
      const settled = await Promise.allSettled([0, 1].map(() =>
        ask(state, rereadModel, hardEffort, picture, 'hard_page_read', true)));
      for (const result of settled) {
        if (result.status === 'rejected' && (signal.aborted
          || !(result.reason instanceof AiTransientError || result.reason instanceof AiRejectedError))) throw result.reason;
      }
      const answers = settled.flatMap((result) => result.status === 'fulfilled' && result.value.kind === 'answer'
        ? [result.value.answer] : []);
      if (answers.length === 0) {
        const kinds = settled.map((result) => result.status === 'fulfilled' ? result.value.kind
          : result.reason instanceof AiRejectedError && result.reason.code === 'AI_BAD_REQUEST' && result.reason.invalidRequest
            ? 'invalid' : 'error');
        if (kinds.every((kind) => kind === 'invalid')) return { kind: 'fallback', reason: 'image_rejected' };
        if (kinds.every((kind) => kind === 'refused')) return { kind: 'fallback', reason: 'image_refused' };
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
    await forEachBounded(candidates, pageConcurrency, async (state) => {
      let answer: PageAnswer | null = null;
      let fromImage = false;
      let hardCheck: PageCheck | null = null;
      // Only a flagged page (one the first pass answered) may go with its picture.
      const decision = state.firstCheck === null ? null : this.imageDecision(state, input);
      try {
        if (decision?.kind === 'image' && this.isHardPage(state)) {
          const hard = await readHard(state, pictureOf(decision));
          if (hard.kind === 'read') {
            hardCheck = hard.check;
            fromImage = true;
          } else if (hard.kind === 'fallback') {
            skipped.push({ page: state.page, reason: hard.reason });
            answer = await ask(state, rereadModel, rereadEffort);
          } else {
            imageFailed.push(state.page);
          }
        } else if (decision?.kind === 'image') {
          try {
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
              answer = await ask(state, rereadModel, rereadEffort);
            } else {
              if (error instanceof AiTransientError || error instanceof AiRejectedError) imageFailed.push(state.page);
              throw error;
            }
          }
          if (fromImage && answer.kind === 'refused') {
            // The decline may be about the picture: re-read the text instead, once.
            skipped.push({ page: state.page, reason: 'image_refused' });
            fromImage = false;
            answer = await ask(state, rereadModel, rereadEffort);
          } else if (fromImage && answer.kind !== 'answer') {
            imageFailed.push(state.page);
          }
        } else {
          if (decision !== null) skipped.push({ page: state.page, reason: decision.reason });
          answer = await ask(state, rereadModel, rereadEffort);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof AiTransientError) && !(error instanceof AiRejectedError)) throw error;
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
          state.reread = 'failed';
          state.final = markRereadFailed(state.firstCheck);
          return;
        }
        state.final = mergeReread(state.firstCheck, read, state.lines, fromImage ? 'image' : 'text');
        state.reread = 'done';
        state.fromImage = fromImage;
        return;
      }
      // A page whose first pass failed or was declined: nothing to merge, the re-read stands.
      if (answer?.kind === 'answer') {
        state.final = checkPage({ page: state.page, lines: state.lines, answer: answer.answer,
          sourceSha256Hex: input.sourceSha256Hex, readBy: 'reread', masker: state.masker });
        state.reread = 'done';
        return;
      }
      state.reread = 'failed';
      if (state.first?.kind === 'refused') state.declined = answer?.kind === 'refused' || answer === null;
      else if (state.first?.kind === 'failed') state.failed = true;
      else if (state.firstCheck) state.final = markRereadFailed(state.firstCheck);
    }).catch((error: unknown) => { throw interrupted(error); });
    for (const state of states) {
      if (state.first?.kind === 'refused' && state.final === null) state.declined = true;
      if (state.first?.kind === 'failed' && state.final === null) state.failed = true;
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
      hardPageAgreement: noAgreement(),
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
