import {
  AnalyzeDocumentCommand, GetDocumentTextDetectionCommand, StartDocumentTextDetectionCommand,
  TextractClient, type Block,
} from '@aws-sdk/client-textract';
import { createHash } from 'node:crypto';
import type { OcrWorkerConfig } from './config';
import { SafeWorkerFailure, type ProviderExtraction, type VerifiedDocument, type WorkerOcrProvider } from './types';

export const TEXTRACT_PROCESSING_CONTRACT = 'hid-textract-v1';
const IMAGE_OPERATION = 'AnalyzeDocument';
const IMAGE_FEATURES = ['FORMS', 'TABLES'] as const;
const PDF_OPERATION = 'StartDocumentTextDetection';

export function textractPdfClientRequestToken(document: Pick<VerifiedDocument,
  'bucket' | 'key' | 'versionId' | 'sha256Hex'>): string {
  return createHash('sha256').update(JSON.stringify({
    contract: TEXTRACT_PROCESSING_CONTRACT,
    provider: 'amazon-textract',
    model: 'amazon-textract-detect-document-text',
    operation: PDF_OPERATION,
    features: [],
    bucket: document.bucket,
    key: document.key,
    versionId: document.versionId,
    sha256Hex: document.sha256Hex,
  })).digest('hex');
}

export class TextractOcrProvider implements WorkerOcrProvider {
  readonly name = 'textract';
  private readonly client: TextractClient;
  constructor(private readonly config: OcrWorkerConfig) {
    this.client = new TextractClient({ region: config.AWS_REGION, maxAttempts: 1,
      ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
      ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY ? { credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      } } : {}) });
  }

  async checkReadiness(_signal: AbortSignal): Promise<void> {
    // AWS has no non-mutating Textract health API. Construction validates local
    // configuration; the first bounded request is the truthful remote check.
    return Promise.resolve();
  }

  async extract(document: VerifiedDocument, signal: AbortSignal): Promise<ProviderExtraction> {
    try {
      return document.mediaType === 'application/pdf'
        ? await this.extractPdf(document, signal)
        : await this.extractImage(document, signal);
    } catch (error) {
      if (error instanceof SafeWorkerFailure) throw error;
      const name = error instanceof Error ? error.name : 'unknown';
      const terminal = ['UnsupportedDocumentException', 'BadDocumentException', 'DocumentTooLargeException'].includes(name);
      const uncertain = ['AbortError', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException'].includes(name);
      if (uncertain) {
        const duplicateSafe = document.mediaType === 'application/pdf';
        throw new SafeWorkerFailure('PROVIDER_OUTCOME_UNKNOWN',
          'OCR provider outcome is unknown after the bounded request deadline', duplicateSafe,
          duplicateSafe ? 20 : 0);
      }
      throw new SafeWorkerFailure(terminal ? 'PROVIDER_REJECTED_DOCUMENT' : 'PROVIDER_UNAVAILABLE',
        terminal ? 'OCR provider rejected the document format' : 'OCR provider is temporarily unavailable',
        !terminal, terminal ? 0 : 20);
    }
  }

  private async extractImage(document: VerifiedDocument, signal: AbortSignal): Promise<ProviderExtraction> {
    if (!['image/png', 'image/jpeg'].includes(document.mediaType)) {
      throw new SafeWorkerFailure('UNSUPPORTED_MEDIA_TYPE', 'Document media type is not supported for OCR', false, 0);
    }
    const result = await this.client.send(new AnalyzeDocumentCommand({ Document: { Bytes: document.bytes },
      FeatureTypes: [...IMAGE_FEATURES] }), { abortSignal: this.requestSignal(signal) });
    return { providerModel: 'amazon-textract-analyze-document',
      providerRequestReference: result.$metadata.requestId ?? null,
      pages: this.linesToPages(result.Blocks ?? []),
      provenance: { processingContract: TEXTRACT_PROCESSING_CONTRACT, adapter: 'amazon-textract',
        operation: IMAGE_OPERATION, features: IMAGE_FEATURES, sourceVersionBound: true } };
  }

  private async extractPdf(document: VerifiedDocument, signal: AbortSignal): Promise<ProviderExtraction> {
    const started = await this.client.send(new StartDocumentTextDetectionCommand({ ClientRequestToken:
      textractPdfClientRequestToken(document), DocumentLocation: {
      S3Object: { Bucket: document.bucket, Name: document.key, Version: document.versionId },
    } }), { abortSignal: this.requestSignal(signal) });
    if (!started.JobId) throw new SafeWorkerFailure('PROVIDER_PROTOCOL_ERROR', 'OCR provider did not return a job reference', true, 15);
    const deadline = Date.now() + this.config.OCR_TEXTRACT_MAX_POLL_SECONDS * 1_000;
    const blocks: Block[] = [];
    let nextToken: string | undefined;
    do {
      let result;
      do {
        if (Date.now() >= deadline) throw new SafeWorkerFailure('PROVIDER_TIMEOUT', 'OCR provider polling deadline was exceeded', true, 30);
        await abortableDelay(this.config.OCR_TEXTRACT_POLL_MS, signal);
        result = await this.client.send(new GetDocumentTextDetectionCommand({ JobId: started.JobId,
          ...(nextToken ? { NextToken: nextToken } : {}) }), { abortSignal: this.requestSignal(signal) });
      } while (result.JobStatus === 'IN_PROGRESS');
      if (result.JobStatus !== 'SUCCEEDED') {
        throw new SafeWorkerFailure('PROVIDER_PROCESSING_FAILED', 'OCR provider could not process the document', true, 30);
      }
      blocks.push(...(result.Blocks ?? []));
      nextToken = result.NextToken;
    } while (nextToken);
    return { providerModel: 'amazon-textract-detect-document-text',
      providerRequestReference: started.JobId, pages: this.linesToPages(blocks),
      provenance: { processingContract: TEXTRACT_PROCESSING_CONTRACT, adapter: 'amazon-textract',
        operation: PDF_OPERATION, features: [], deterministicStartToken: true,
        sourceVersionBound: true } };
  }

  private linesToPages(blocks: readonly Block[]) {
    const grouped = new Map<number, Array<{ text: string; confidence: number }>>();
    for (const block of blocks) {
      if (block.BlockType !== 'LINE' || !block.Text) continue;
      const page = block.Page ?? 1;
      const lines = grouped.get(page) ?? [];
      lines.push({ text: block.Text, confidence: Math.max(0, Math.min(1, (block.Confidence ?? 0) / 100)) });
      grouped.set(page, lines);
    }
    return [...grouped.entries()].sort(([left], [right]) => left - right).map(([page, lines]) => ({
      page, text: lines.map((line) => line.text).join('\n'),
      confidence: lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length,
    }));
  }
  private requestSignal(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(this.config.OCR_WORKER_API_TIMEOUT_MS)]);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
