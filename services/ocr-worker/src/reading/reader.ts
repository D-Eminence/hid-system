import type { OcrWorkerConfig } from '../config';
import type { ReadLine, ReadPage } from '../types';
import { AiRejectedError, AiTransientError, INFERENCE_GEO, type Effort, type PageAnswer,
  type PageModelClient, type TokenUsage } from './claude.client';
import {
  PAPER_READING_CONTRACT, PAPER_READING_SCHEMA_VERSION, type FlagReason, type PaperIdentity, type PaperItem,
  type PaperPage, type PaperReadingPayload, type ReadingStatus,
} from './contract';
import { blankIdentity, checkPage, REVIEW_BELOW, uniqueItemIds, type PageCheck } from './items';
import { createMasker, type Masker } from './masking';
import { MODEL_SCHEMA_VERSION, PROMPT_VERSION } from './prompt';

export type ReadingConfig = Pick<OcrWorkerConfig, 'OCR_AI_MODE' | 'OCR_AI_FACILITY_IDS' | 'OCR_AI_FIRST_PASS_MODEL'
  | 'OCR_AI_FIRST_PASS_EFFORT' | 'OCR_AI_REREAD_MODEL' | 'OCR_AI_REREAD_EFFORT' | 'OCR_AI_MAX_REREAD_PAGES'>;

export interface ReadingInput {
  facilityId: string;
  sourceSha256Hex: string;
  pages: readonly ReadPage[];
}

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
  droppedUngrounded: number;
  droppedUngroundedFirstPass: number;
  itemCount: number;
  flaggedPages: number;
  maskedNumbers: number;
  failureCode: string | null;
  usage: TokenUsage;
}

export interface ReadingOutcome { payload: PaperReadingPayload; summary: ReadingSummary }

/** The AI step's transient failure, after its own retries; the worker decides whether the job retries. */
export class ReadingUnavailableError extends Error {
  constructor(readonly code: string, readonly usage: TokenUsage) { super(code); this.name = 'ReadingUnavailableError'; }
}

interface PageState {
  page: number;
  /** Masked lines: what the model sees and what grounding checks against. */
  lines: ReadLine[];
  masker: Masker;
  first: PageAnswer | null;
  firstCheck: PageCheck | null;
  final: PageCheck | null;
  declined: boolean;
  failed: boolean;
  reread: 'none' | 'done' | 'failed';
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
    usage: TokenUsage = zeroUsage(), failureCode: string | null = null): ReadingOutcome {
    const pages = input.pages.map((page) => lineOnlyPage(page));
    const aiUsed = status === 'ai_failed';
    const summary = this.summary(status, pages, [], 0, 0, [], 0, aiUsed, usage, 0, 0, 0, 0, null, failureCode);
    return { payload: this.payload(pages, blankIdentity(), [], summary), summary };
  }

  async read(input: ReadingInput, signal: AbortSignal): Promise<ReadingOutcome> {
    const hasText = input.pages.some((page) => page.lines.length > 0);
    if (!hasText) return this.withoutItems(input, 'no_text');
    if (!this.enabledFor(input.facilityId)) return this.withoutItems(input, 'ai_off');
    const client = this.client!;
    const usage = zeroUsage();
    let requests = 0;
    let refusals = 0;
    let servedGeo: string | null = null;
    const states: PageState[] = input.pages.filter((page) => page.lines.length > 0).map((page) => {
      const masker = createMasker();
      return { page: page.page, masker, lines: page.lines.map((line) => ({ ...line, text: masker.mask(line.text) })),
        first: null, firstCheck: null, final: null, declined: false, failed: false, reread: 'none' };
    });
    const ask = async (state: PageState, model: string, effort: Effort) => {
      const answer = await client.readPage({ model, effort, page: state.page, lines: state.lines }, signal);
      requests += answer.attempts;
      addUsage(usage, answer.usage);
      if (answer.kind === 'refused') refusals += 1;
      if (answer.kind === 'answer' && answer.servedInferenceGeo) servedGeo = answer.servedInferenceGeo;
      return answer;
    };

    // First pass: every page with text, one request each, so a flagged page can be re-read alone.
    try {
      for (const state of states) {
        state.first = await ask(state, this.config.OCR_AI_FIRST_PASS_MODEL, this.config.OCR_AI_FIRST_PASS_EFFORT);
        if (state.first.kind === 'answer') {
          state.firstCheck = checkPage({ page: state.page, lines: state.lines, answer: state.first.answer,
            sourceSha256Hex: input.sourceSha256Hex, readBy: 'first_pass', masker: state.masker });
          state.final = state.firstCheck;
        }
      }
    } catch (error) {
      if (error instanceof AiTransientError) throw new ReadingUnavailableError(error.code, usage);
      if (error instanceof AiRejectedError) return this.withoutItems(input, 'ai_failed', usage, error.code);
      throw error;
    }

    // Re-read: refused or failed pages first, then flagged pages in page order, up to the cap.
    const candidates = [
      ...states.filter((state) => state.first?.kind !== 'answer'),
      ...states.filter((state) => state.firstCheck !== null && state.firstCheck.rereadReasons.length > 0),
    ].slice(0, this.config.OCR_AI_MAX_REREAD_PAGES);
    let rereadAttempted = false;
    for (const state of candidates) {
      rereadAttempted = true;
      let answer: PageAnswer | null = null;
      try {
        answer = await ask(state, this.config.OCR_AI_REREAD_MODEL, this.config.OCR_AI_REREAD_EFFORT);
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof AiTransientError) && !(error instanceof AiRejectedError)) throw error;
      }
      if (answer?.kind === 'answer') {
        state.final = checkPage({ page: state.page, lines: state.lines, answer: answer.answer,
          sourceSha256Hex: input.sourceSha256Hex, readBy: 'reread', masker: state.masker });
        state.reread = 'done';
        continue;
      }
      state.reread = 'failed';
      if (state.first?.kind === 'refused') state.declined = answer?.kind === 'refused' || answer === null;
      else if (state.first?.kind === 'failed') state.failed = true;
      else if (state.firstCheck) state.final = markRereadFailed(state.firstCheck);
    }
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
    const summary = this.summary(status, pages, kept, dropped, droppedFirst, rereadPages,
      states.filter((state) => state.reread === 'failed').length, true, usage, requests, refusals, states.length,
      states.reduce((sum, state) => sum + state.masker.count, 0), servedGeo, null, rereadAttempted);
    return { payload: this.payload(pages, status === 'read' ? identity : blankIdentity(), kept, summary), summary };
  }

  private summary(status: ReadingStatus, pages: readonly PaperPage[], items: readonly PaperItem[], dropped: number,
    droppedFirst: number, rereadPages: number[], rereadFailed: number, aiUsed: boolean, usage: TokenUsage,
    requests: number, refusals: number, pagesSent: number, masked: number, servedGeo: string | null,
    failureCode: string | null, rereadAttempted = false): ReadingSummary {
    return {
      status,
      firstPassModel: aiUsed ? this.config.OCR_AI_FIRST_PASS_MODEL : null,
      rereadModel: aiUsed && rereadAttempted ? this.config.OCR_AI_REREAD_MODEL : null,
      inferenceGeo: aiUsed ? INFERENCE_GEO : null,
      servedInferenceGeo: servedGeo,
      requests, refusals, pagesSent, rereadPages, rereadFailedPages: rereadFailed,
      droppedUngrounded: dropped, droppedUngroundedFirstPass: droppedFirst, itemCount: items.length,
      flaggedPages: pages.filter((page) => page.flagged).length, maskedNumbers: masked, failureCode, usage,
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
      },
    };
  }
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
