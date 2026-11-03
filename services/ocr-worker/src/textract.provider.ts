import {
  AnalyzeDocumentCommand, DetectDocumentTextCommand, GetDocumentAnalysisCommand, GetDocumentTextDetectionCommand,
  StartDocumentAnalysisCommand, StartDocumentTextDetectionCommand, TextractClient, type Block, type FeatureType,
} from '@aws-sdk/client-textract';
import { createHash } from 'node:crypto';
import { abortableDelay, fullJitterDelayMs, type Sleep } from './backoff';
import type { OcrWorkerConfig } from './config';
import { Semaphore } from './semaphore';
import {
  DocumentTooManyPagesFailure, SafeWorkerFailure, type LineBox, type ReadLine, type ReadPage, type TextReading,
  type VerifiedDocument, type WorkerOcrProvider,
} from './types';

/**
 * Text reading v2: every LINE with its page, reading order, position, legibility and a handwriting flag,
 * kept as working data for the AI step and the check screen. OCR_TEXTRACT_FEATURES picks the Textract API:
 *
 * - 'text' (default, cheapest): DetectDocumentText for a PNG or JPEG; StartDocumentTextDetection /
 *   GetDocumentTextDetection for PDF and TIFF. Lines come in Textract's own order.
 * - 'layout': AnalyzeDocument / StartDocumentAnalysis / GetDocumentAnalysis with FeatureTypes ['LAYOUT'] only,
 *   whose layout blocks give the reading order. FORMS and TABLES are never requested.
 *
 * Both give the same line output. PDF and TIFF (which can have many pages) are read asynchronously from the
 * exact S3 object version.
 */
export const TEXTRACT_PROCESSING_CONTRACT = 'hid-textract-v2';
export type TextractFeatures = OcrWorkerConfig['OCR_TEXTRACT_FEATURES'];

interface TextractMode {
  providerModel: string;
  imageOperation: string;
  asyncOperation: string;
  resultOperation: string;
  /** FeatureTypes sent to Textract; empty for text detection, which takes none. */
  features: readonly FeatureType[];
}

export const TEXTRACT_MODES: Readonly<Record<TextractFeatures, TextractMode>> = {
  text: { providerModel: 'amazon-textract-detect-document-text', imageOperation: 'DetectDocumentText',
    asyncOperation: 'StartDocumentTextDetection', resultOperation: 'GetDocumentTextDetection', features: [] },
  layout: { providerModel: 'amazon-textract-analyze-document-layout', imageOperation: 'AnalyzeDocument',
    asyncOperation: 'StartDocumentAnalysis', resultOperation: 'GetDocumentAnalysis', features: ['LAYOUT'] },
};
const IMAGE_TYPES = ['image/png', 'image/jpeg'];
const ASYNC_TYPES = ['application/pdf', 'image/tiff'];
/** Throttling and transient service errors: retried inside the call with backoff before giving up retryable. */
const THROTTLING = new Set(['ProvisionedThroughputExceededException', 'ThrottlingException',
  'LimitExceededException', 'InternalServerError']);
const BACKOFF = { baseMs: 500, capMs: 8_000 };

/**
 * A deterministic ClientRequestToken for the async start: the same immutable object, processing contract,
 * operation and features always name the same Textract job, so a retried claim never buys the reading twice,
 * and switching OCR_TEXTRACT_FEATURES never reuses a job started by the other operation.
 */
export function textractAsyncClientRequestToken(document: Pick<VerifiedDocument,
  'bucket' | 'key' | 'versionId' | 'sha256Hex'>, features: TextractFeatures = 'text'): string {
  const mode = TEXTRACT_MODES[features];
  return createHash('sha256').update(JSON.stringify({
    contract: TEXTRACT_PROCESSING_CONTRACT,
    provider: 'amazon-textract',
    model: mode.providerModel,
    operation: mode.asyncOperation,
    features: { mode: features, featureTypes: mode.features },
    bucket: document.bucket,
    key: document.key,
    versionId: document.versionId,
    sha256Hex: document.sha256Hex,
  })).digest('hex');
}
/** @deprecated kept for existing callers; PDF and TIFF share the async token. */
export const textractPdfClientRequestToken = textractAsyncClientRequestToken;

export interface TextractProviderOptions {
  sleep?: Sleep;
  random?: () => number;
  /** The process-wide Textract call limit; by default one built from OCR_TEXTRACT_MAX_CONCURRENT (2). */
  limiter?: Semaphore;
}
type TextractConfig = Pick<OcrWorkerConfig, 'AWS_REGION' | 'AWS_ENDPOINT_URL' | 'AWS_ACCESS_KEY_ID'
  | 'AWS_SECRET_ACCESS_KEY' | 'OCR_TEXTRACT_POLL_MS' | 'OCR_TEXTRACT_MAX_POLL_SECONDS' | 'OCR_WORKER_API_TIMEOUT_MS'
  | 'OCR_TEXTRACT_MAX_RETRIES' | 'OCR_TEXTRACT_MAX_PAGES' | 'OCR_TEXTRACT_FEATURES'>
  & Partial<Pick<OcrWorkerConfig, 'OCR_TEXTRACT_MAX_CONCURRENT'>>;

interface AsyncResult {
  JobStatus?: string;
  DocumentMetadata?: { Pages?: number };
  Blocks?: Block[];
  NextToken?: string;
}

export class TextractOcrProvider implements WorkerOcrProvider {
  readonly name = 'textract';
  private readonly client: TextractClient;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly features: TextractFeatures;
  private readonly mode: TextractMode;
  /**
   * Textract calls in flight for the whole process (main.ts builds one provider, shared by every claim loop).
   * A permit is held for one API call only: never across a throttling backoff or an async poll delay.
   */
  readonly limiter: Semaphore;
  constructor(private readonly config: TextractConfig, options: TextractProviderOptions = {}) {
    this.client = new TextractClient({ region: config.AWS_REGION, maxAttempts: 1,
      ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
      ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY ? { credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      } } : {}) });
    this.sleep = options.sleep ?? abortableDelay;
    this.random = options.random ?? Math.random;
    this.features = config.OCR_TEXTRACT_FEATURES;
    this.mode = TEXTRACT_MODES[this.features];
    this.limiter = options.limiter ?? new Semaphore(config.OCR_TEXTRACT_MAX_CONCURRENT ?? 2);
  }

  async checkReadiness(_signal: AbortSignal): Promise<void> {
    // AWS has no non-mutating Textract health API. Construction validates local
    // configuration; the first bounded request is the truthful remote check.
    return Promise.resolve();
  }

  async extract(document: VerifiedDocument, signal: AbortSignal): Promise<TextReading> {
    try {
      if (ASYNC_TYPES.includes(document.mediaType)) return await this.extractAsync(document, signal);
      return await this.extractImage(document, signal);
    } catch (error) {
      if (error instanceof SafeWorkerFailure) throw error;
      const name = error instanceof Error ? error.name : 'unknown';
      // InvalidS3ObjectException is not terminal: Textract also raises it for S3 access, region and KMS
      // configuration, and the worker has already verified the exact object version itself.
      const terminal = ['UnsupportedDocumentException', 'BadDocumentException', 'DocumentTooLargeException']
        .includes(name);
      const uncertain = ['AbortError', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException'].includes(name);
      if (uncertain) {
        const duplicateSafe = ASYNC_TYPES.includes(document.mediaType);
        throw new SafeWorkerFailure('PROVIDER_OUTCOME_UNKNOWN',
          'OCR provider outcome is unknown after the bounded request deadline', duplicateSafe,
          duplicateSafe ? 20 : 0);
      }
      throw new SafeWorkerFailure(terminal ? 'PROVIDER_REJECTED_DOCUMENT' : 'PROVIDER_UNAVAILABLE',
        terminal ? 'OCR provider rejected the document format' : 'OCR provider is temporarily unavailable',
        !terminal, terminal ? 0 : 20);
    }
  }

  private provenance(operation: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { processingContract: TEXTRACT_PROCESSING_CONTRACT, adapter: 'amazon-textract', operation,
      textractFeatures: this.features, features: [...this.mode.features], ...extra, sourceVersionBound: true };
  }

  private async extractImage(document: VerifiedDocument, signal: AbortSignal): Promise<TextReading> {
    if (!IMAGE_TYPES.includes(document.mediaType)) {
      throw new SafeWorkerFailure('UNSUPPORTED_MEDIA_TYPE', 'Document media type is not supported for OCR', false, 0);
    }
    const Document = { Bytes: document.bytes };
    const result = this.features === 'layout'
      ? await this.send((abortSignal) => this.client.send(new AnalyzeDocumentCommand({
        Document, FeatureTypes: [...this.mode.features] }), { abortSignal }), signal)
      : await this.send((abortSignal) => this.client.send(new DetectDocumentTextCommand({ Document }),
        { abortSignal }), signal);
    const pages = blocksToPages(result.Blocks ?? [], 1);
    return { providerModel: this.mode.providerModel, providerRequestReference: result.$metadata.requestId ?? null,
      pageCount: 1, pages, provenance: this.provenance(this.mode.imageOperation) };
  }

  private async startAsync(document: VerifiedDocument, signal: AbortSignal): Promise<string | undefined> {
    const input = {
      ClientRequestToken: textractAsyncClientRequestToken(document, this.features),
      DocumentLocation: { S3Object: { Bucket: document.bucket, Name: document.key, Version: document.versionId } },
    };
    const started = this.features === 'layout'
      ? await this.send((abortSignal) => this.client.send(new StartDocumentAnalysisCommand({
        ...input, FeatureTypes: [...this.mode.features] }), { abortSignal }), signal)
      : await this.send((abortSignal) => this.client.send(new StartDocumentTextDetectionCommand(input),
        { abortSignal }), signal);
    return started.JobId;
  }

  private async getAsync(jobId: string, nextToken: string | undefined, signal: AbortSignal): Promise<AsyncResult> {
    const input = { JobId: jobId, MaxResults: 1_000, ...(nextToken ? { NextToken: nextToken } : {}) };
    return this.features === 'layout'
      ? this.send((abortSignal) => this.client.send(new GetDocumentAnalysisCommand(input), { abortSignal }), signal)
      : this.send((abortSignal) => this.client.send(new GetDocumentTextDetectionCommand(input), { abortSignal }), signal);
  }

  private async extractAsync(document: VerifiedDocument, signal: AbortSignal): Promise<TextReading> {
    const jobId = await this.startAsync(document, signal);
    if (!jobId) throw new SafeWorkerFailure('PROVIDER_PROTOCOL_ERROR', 'OCR provider did not return a job reference', true, 15);
    const deadline = Date.now() + this.config.OCR_TEXTRACT_MAX_POLL_SECONDS * 1_000;
    const blocks: Block[] = [];
    let pageCount: number | undefined;
    let nextToken: string | undefined;
    do {
      let result: AsyncResult;
      do {
        if (Date.now() >= deadline) throw new SafeWorkerFailure('PROVIDER_TIMEOUT', 'OCR provider polling deadline was exceeded', true, 30);
        await abortableDelay(this.config.OCR_TEXTRACT_POLL_MS, signal);
        result = await this.getAsync(jobId, nextToken, signal);
      } while (result.JobStatus === 'IN_PROGRESS');
      if (result.JobStatus !== 'SUCCEEDED') {
        throw new SafeWorkerFailure('PROVIDER_PROCESSING_FAILED', 'OCR provider could not process the document', true, 30);
      }
      pageCount ??= result.DocumentMetadata?.Pages;
      // Stop paging as soon as the document is known to be too long: the result is never used.
      if (pageCount !== undefined && pageCount > this.config.OCR_TEXTRACT_MAX_PAGES) {
        throw new DocumentTooManyPagesFailure(pageCount, this.config.OCR_TEXTRACT_MAX_PAGES);
      }
      blocks.push(...(result.Blocks ?? []));
      nextToken = result.NextToken;
    } while (nextToken);
    const pages = blocksToPages(blocks, pageCount ?? 0);
    const counted = Math.max(pageCount ?? 0, pages.length);
    if (counted > this.config.OCR_TEXTRACT_MAX_PAGES) {
      throw new DocumentTooManyPagesFailure(counted, this.config.OCR_TEXTRACT_MAX_PAGES);
    }
    return { providerModel: this.mode.providerModel, providerRequestReference: jobId, pageCount: counted, pages,
      provenance: this.provenance(this.mode.asyncOperation, { resultOperation: this.mode.resultOperation,
        deterministicStartToken: true }) };
  }

  /** One Textract call, retried only for throttling and transient service errors, with full-jitter backoff. */
  private async send<Output>(call: (abortSignal: AbortSignal) => Promise<Output>, signal: AbortSignal): Promise<Output> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // The request deadline starts once a permit is held; the wait itself ends only on shutdown.
        return await this.limiter.run(() => call(this.requestSignal(signal)), signal);
      } catch (error) {
        const name = error instanceof Error ? error.name : 'unknown';
        if (signal.aborted || !THROTTLING.has(name) || attempt >= this.config.OCR_TEXTRACT_MAX_RETRIES) throw error;
        await this.sleep(fullJitterDelayMs(attempt, { ...BACKOFF, random: this.random }), signal);
      }
    }
  }

  private requestSignal(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(this.config.OCR_WORKER_API_TIMEOUT_MS)]);
  }
}

function round4(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 10_000) / 10_000));
}

function boxOf(block: Block): LineBox | null {
  const box = block.Geometry?.BoundingBox;
  if (!box || [box.Left, box.Top, box.Width, box.Height].some((value) => typeof value !== 'number')) return null;
  return { left: round4(box.Left!), top: round4(box.Top!), width: round4(box.Width!), height: round4(box.Height!) };
}

function childIds(block: Block): string[] {
  return (block.Relationships ?? []).filter((relation) => relation.Type === 'CHILD').flatMap((relation) => relation.Ids ?? []);
}

/**
 * Textract blocks to pages of lines in reading order. Text detection has no layout blocks, so lines keep
 * Textract's own order. With LAYOUT, the order of the layout blocks is the reading order and each one lists its
 * lines; any line no layout block lists keeps its own place after them. Line ids, boxes, confidence and the
 * handwriting flag are worked out the same way for both.
 * A line's confidence is its least legible word's; it is handwritten when any of its words is.
 */
export function blocksToPages(blocks: readonly Block[], pageCount: number): ReadPage[] {
  const byId = new Map(blocks.filter((block) => block.Id).map((block) => [block.Id!, block]));
  const perPage = new Map<number, { layout: Block[]; lines: Block[] }>();
  for (const block of blocks) {
    const page = block.Page ?? 1;
    const entry = perPage.get(page) ?? { layout: [], lines: [] };
    if (block.BlockType === 'LINE' && block.Text) entry.lines.push(block);
    else if (block.BlockType?.startsWith('LAYOUT_')) entry.layout.push(block);
    perPage.set(page, entry);
  }
  const total = Math.max(pageCount, ...perPage.keys(), 0);
  const pages: ReadPage[] = [];
  for (let page = 1; page <= total; page += 1) {
    const entry = perPage.get(page) ?? { layout: [], lines: [] };
    const lineIds = new Set(entry.lines.map((line) => line.Id));
    const ordered: Block[] = [];
    const placed = new Set<string>();
    const visit = (id: string, depth: number) => {
      const block = byId.get(id);
      if (!block || depth > 4) return;
      if (block.BlockType === 'LINE') {
        if (lineIds.has(id) && !placed.has(id)) { placed.add(id); ordered.push(block); }
        return;
      }
      if (block.BlockType?.startsWith('LAYOUT_')) childIds(block).forEach((child) => visit(child, depth + 1));
    };
    for (const layout of entry.layout) childIds(layout).forEach((child) => visit(child, 0));
    for (const line of entry.lines) if (line.Id === undefined || !placed.has(line.Id)) ordered.push(line);
    const lines: ReadLine[] = ordered.map((block, index) => {
      const words = childIds(block).map((id) => byId.get(id)).filter((word): word is Block => word?.BlockType === 'WORD');
      const confidences = words.map((word) => word.Confidence).filter((value): value is number => typeof value === 'number');
      const confidence = confidences.length > 0 ? Math.min(...confidences) : block.Confidence ?? 0;
      return { id: `p${page}-l${index + 1}`, page, text: block.Text!, box: boxOf(block),
        confidence: round4(confidence / 100), handwritten: words.some((word) => word.TextType === 'HANDWRITING') };
    });
    pages.push({ page, lines });
  }
  return pages;
}
