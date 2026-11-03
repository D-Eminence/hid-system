import {
  AnalyzeDocumentCommand, DetectDocumentTextCommand, GetDocumentAnalysisCommand, GetDocumentTextDetectionCommand,
  StartDocumentAnalysisCommand, StartDocumentTextDetectionCommand, type Block,
} from '@aws-sdk/client-textract';
import type { OcrWorkerConfig } from './config';
import { Semaphore } from './semaphore';
import { DocumentTooManyPagesFailure, SafeWorkerFailure } from './types';
import { blocksToPages, TEXTRACT_PROCESSING_CONTRACT, TextractOcrProvider, type TextractFeatures,
  textractAsyncClientRequestToken, textractPdfClientRequestToken } from './textract.provider';

const document = {
  bucket: 'hid-documents', key: 'clinical/objects/opaque', versionId: 'version-1',
  sha256Hex: 'a'.repeat(64),
};
const config = { AWS_REGION: 'eu-west-1', OCR_TEXTRACT_MAX_POLL_SECONDS: 10, OCR_TEXTRACT_POLL_MS: 1,
  OCR_WORKER_API_TIMEOUT_MS: 1_000, OCR_TEXTRACT_MAX_RETRIES: 3, OCR_TEXTRACT_MAX_PAGES: 20,
  OCR_TEXTRACT_FEATURES: 'text' } as OcrWorkerConfig;

function provider(send: jest.Mock, features: TextractFeatures = 'text', sleep = jest.fn().mockResolvedValue(undefined)) {
  const instance = new TextractOcrProvider({ ...config, OCR_TEXTRACT_FEATURES: features }, { sleep, random: () => 0.5 });
  (instance as unknown as { client: { send: jest.Mock } }).client = { send };
  return { instance, sleep };
}

const word = (id: string, text: string, confidence: number, handwriting = false): Block => ({
  BlockType: 'WORD', Id: id, Text: text, Confidence: confidence, TextType: handwriting ? 'HANDWRITING' : 'PRINTED' });
const line = (id: string, text: string, words: string[], page?: number, box?: [number, number, number, number],
  confidence = 99): Block => ({
  BlockType: 'LINE', Id: id, Text: text, Confidence: confidence, ...(page ? { Page: page } : {}),
  Relationships: [{ Type: 'CHILD', Ids: words }],
  ...(box ? { Geometry: { BoundingBox: { Left: box[0], Top: box[1], Width: box[2], Height: box[3] } } } : {}),
});

/** The same fictional two-page reading, as text detection and as layout analysis would return it. */
function twoPageBlocks(withLayout: boolean): { first: Block[]; second: Block[] } {
  const first: Block[] = [word('w1', 'Amlodipine', 99.1), word('w2', '5mg', 62.35, true),
    line('a', 'Amlodipine 5mg', ['w1', 'w2'], 1, [0.123456, 0.2, 0.333333, 0.04])];
  const second: Block[] = [word('w3', 'Folder', 98), line('b', 'Folder TEST-0001', ['w3'], 2)];
  if (withLayout) {
    first.push({ BlockType: 'LAYOUT_TEXT', Id: 'L1', Page: 1, Relationships: [{ Type: 'CHILD', Ids: ['a'] }] });
    second.push({ BlockType: 'LAYOUT_TEXT', Id: 'L2', Page: 2, Relationships: [{ Type: 'CHILD', Ids: ['b'] }] });
  }
  return { first, second };
}

function asyncSend(features: TextractFeatures, jobId = 'job-1') {
  const { first, second } = twoPageBlocks(features === 'layout');
  const Start = features === 'layout' ? StartDocumentAnalysisCommand : StartDocumentTextDetectionCommand;
  const Get = features === 'layout' ? GetDocumentAnalysisCommand : GetDocumentTextDetectionCommand;
  let polls = 0;
  return jest.fn(async (command: unknown) => {
    if (command instanceof Start) return { JobId: jobId };
    if (command instanceof Get) {
      polls += 1;
      if (polls === 1) return { JobStatus: 'IN_PROGRESS' };
      return command.input.NextToken
        ? { JobStatus: 'SUCCEEDED', Blocks: second }
        : { JobStatus: 'SUCCEEDED', DocumentMetadata: { Pages: 2 }, NextToken: 'next', Blocks: first };
    }
    throw new Error('unexpected command');
  });
}

const pdf = { ...document, bytes: new Uint8Array(), mediaType: 'application/pdf' };

describe('Textract v2 duplicate-cost controls', () => {
  it('creates a deterministic 64-character request token for the immutable source, contract and operation', () => {
    const first = textractAsyncClientRequestToken(document);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(textractAsyncClientRequestToken({ ...document })).toBe(first);
    expect(textractAsyncClientRequestToken(document, 'text')).toBe(first);
    expect(textractPdfClientRequestToken).toBe(textractAsyncClientRequestToken);
    expect(TEXTRACT_PROCESSING_CONTRACT).toBe('hid-textract-v2');
  });

  it('changes the request token when exact object evidence or the operation and features change', () => {
    const baseline = textractAsyncClientRequestToken(document);
    expect(textractAsyncClientRequestToken({ ...document, versionId: 'version-2' })).not.toBe(baseline);
    expect(textractAsyncClientRequestToken({ ...document, sha256Hex: 'b'.repeat(64) })).not.toBe(baseline);
    expect(textractAsyncClientRequestToken(document, 'layout')).not.toBe(baseline);
    expect(textractAsyncClientRequestToken(document, 'layout')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('text mode: starts text detection on the exact S3 version with no features, polls and pages through', async () => {
    const send = asyncSend('text');
    const reading = await provider(send, 'text').instance.extract(pdf, new AbortController().signal);
    const start = send.mock.calls[0]![0] as StartDocumentTextDetectionCommand;
    expect(start).toBeInstanceOf(StartDocumentTextDetectionCommand);
    expect(start.input).toEqual({ ClientRequestToken: textractAsyncClientRequestToken(document, 'text'),
      DocumentLocation: { S3Object: { Bucket: 'hid-documents', Name: 'clinical/objects/opaque', Version: 'version-1' } } });
    expect(send.mock.calls.slice(1).every(([command]) => command instanceof GetDocumentTextDetectionCommand)).toBe(true);
    expect((send.mock.calls[3]![0] as GetDocumentTextDetectionCommand).input).toEqual({ JobId: 'job-1',
      MaxResults: 1_000, NextToken: 'next' });
    expect(reading.pageCount).toBe(2);
    expect(reading.providerModel).toBe('amazon-textract-detect-document-text');
    expect(reading.providerRequestReference).toBe('job-1');
    expect(reading.provenance).toMatchObject({ processingContract: 'hid-textract-v2',
      operation: 'StartDocumentTextDetection', resultOperation: 'GetDocumentTextDetection', textractFeatures: 'text',
      features: [], deterministicStartToken: true, sourceVersionBound: true });
  });

  it('layout mode: starts document analysis with LAYOUT only (never FORMS or TABLES)', async () => {
    const send = asyncSend('layout');
    const reading = await provider(send, 'layout').instance.extract(pdf, new AbortController().signal);
    const start = send.mock.calls[0]![0] as StartDocumentAnalysisCommand;
    expect(start).toBeInstanceOf(StartDocumentAnalysisCommand);
    expect(start.input).toEqual({ ClientRequestToken: textractAsyncClientRequestToken(document, 'layout'),
      FeatureTypes: ['LAYOUT'],
      DocumentLocation: { S3Object: { Bucket: 'hid-documents', Name: 'clinical/objects/opaque', Version: 'version-1' } } });
    expect(send.mock.calls.slice(1).every(([command]) => command instanceof GetDocumentAnalysisCommand)).toBe(true);
    expect((send.mock.calls[3]![0] as GetDocumentAnalysisCommand).input.NextToken).toBe('next');
    expect(reading.providerModel).toBe('amazon-textract-analyze-document-layout');
    expect(reading.provenance).toMatchObject({ operation: 'StartDocumentAnalysis',
      resultOperation: 'GetDocumentAnalysis', textractFeatures: 'layout', features: ['LAYOUT'] });
  });

  it('gives identical lines in both modes', async () => {
    const text = await provider(asyncSend('text'), 'text').instance.extract(pdf, new AbortController().signal);
    const layout = await provider(asyncSend('layout'), 'layout').instance.extract(pdf, new AbortController().signal);
    expect(text.pages).toEqual(layout.pages);
    expect(text.pages).toEqual([
      { page: 1, lines: [{ id: 'p1-l1', page: 1, text: 'Amlodipine 5mg',
        box: { left: 0.1235, top: 0.2, width: 0.3333, height: 0.04 }, confidence: 0.6235, handwritten: true }] },
      { page: 2, lines: [{ id: 'p2-l1', page: 2, text: 'Folder TEST-0001', box: null, confidence: 0.98,
        handwritten: false }] },
    ]);
  });

  it.each<[TextractFeatures, unknown]>([['text', StartDocumentTextDetectionCommand],
    ['layout', StartDocumentAnalysisCommand]])('reads multi-page TIFF asynchronously too (%s)', async (features, Start) => {
    const send = jest.fn(async (command: unknown) => command instanceof (Start as typeof StartDocumentAnalysisCommand)
      ? { JobId: 'job-2' } : { JobStatus: 'SUCCEEDED', DocumentMetadata: { Pages: 1 }, Blocks: [] });
    const reading = await provider(send, features).instance.extract({ ...document, bytes: new Uint8Array(),
      mediaType: 'image/tiff' }, new AbortController().signal);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(Start as typeof StartDocumentAnalysisCommand);
    expect(reading.pageCount).toBe(1);
    expect(reading.pages).toEqual([{ page: 1, lines: [] }]);
  });

  it.each<TextractFeatures>(['text', 'layout'])('stops with a terminal failure for more than 20 pages (%s)', async (features) => {
    const send = jest.fn(async (command: unknown) => command instanceof StartDocumentAnalysisCommand
      || command instanceof StartDocumentTextDetectionCommand
      ? { JobId: 'job-3' } : { JobStatus: 'SUCCEEDED', DocumentMetadata: { Pages: 21 }, NextToken: 'more', Blocks: [] });
    const failure = await provider(send, features).instance.extract(pdf, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DocumentTooManyPagesFailure);
    expect(failure).toMatchObject({ code: 'DOCUMENT_TOO_MANY_PAGES', retryable: false, pageCount: 21 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('text mode: detects text in a PNG or JPEG synchronously from the bytes as one page', async () => {
    const send = jest.fn(async () => ({ $metadata: { requestId: 'request-1' },
      Blocks: [word('w1', 'Paracetamol', 99), line('l1', 'Paracetamol', ['w1'])] }));
    const reading = await provider(send, 'text').instance.extract({ ...document, bytes: new Uint8Array([1]),
      mediaType: 'image/jpeg' }, new AbortController().signal);
    const command = (send.mock.calls[0] as unknown[])[0] as DetectDocumentTextCommand;
    expect(command).toBeInstanceOf(DetectDocumentTextCommand);
    expect(command.input).toEqual({ Document: { Bytes: new Uint8Array([1]) } });
    expect(reading).toMatchObject({ pageCount: 1, providerRequestReference: 'request-1',
      providerModel: 'amazon-textract-detect-document-text',
      provenance: { operation: 'DetectDocumentText', textractFeatures: 'text', features: [] } });
    expect(reading.pages[0]!.lines.map((entry) => entry.text)).toEqual(['Paracetamol']);
  });

  it('layout mode: analyses a PNG or JPEG synchronously with LAYOUT only as one page', async () => {
    const send = jest.fn(async () => ({ $metadata: { requestId: 'request-1' },
      Blocks: [word('w1', 'Paracetamol', 99), line('l1', 'Paracetamol', ['w1'])] }));
    const reading = await provider(send, 'layout').instance.extract({ ...document, bytes: new Uint8Array([1]),
      mediaType: 'image/png' }, new AbortController().signal);
    const command = (send.mock.calls[0] as unknown[])[0] as AnalyzeDocumentCommand;
    expect(command).toBeInstanceOf(AnalyzeDocumentCommand);
    expect(command.input.FeatureTypes).toEqual(['LAYOUT']);
    expect(reading).toMatchObject({ pageCount: 1, providerModel: 'amazon-textract-analyze-document-layout',
      provenance: { operation: 'AnalyzeDocument', textractFeatures: 'layout', features: ['LAYOUT'] } });
  });

  it.each<TextractFeatures>(['text', 'layout'])('does not blindly retry an uncertain synchronous image charge (%s)', async (features) => {
    const timeout = Object.assign(new Error('unsafe detail'), { name: 'TimeoutError' });
    const { instance } = provider(jest.fn().mockRejectedValue(timeout), features);
    await expect(instance.extract({ ...document, bytes: new Uint8Array([1]), mediaType: 'image/png' },
      new AbortController().signal)).rejects.toEqual(expect.objectContaining<Partial<SafeWorkerFailure>>({
      code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: false,
    }));
  });

  it.each<TextractFeatures>(['text', 'layout'])('retries throttling inside the call with bounded backoff, then succeeds (%s)', async (features) => {
    const throttled = Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException' });
    const send = jest.fn().mockRejectedValueOnce(throttled)
      .mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'ThrottlingException' }))
      .mockResolvedValue({ $metadata: {}, Blocks: [] });
    const { instance, sleep } = provider(send, features);
    await instance.extract({ ...document, bytes: new Uint8Array([1]), mediaType: 'image/png' }, new AbortController().signal);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 500]);
  });

  it('retries throttling while polling the asynchronous text detection', async () => {
    const throttled = Object.assign(new Error('x'), { name: 'ThrottlingException' });
    const send = jest.fn()
      .mockResolvedValueOnce({ JobId: 'job-4' })
      .mockRejectedValueOnce(throttled)
      .mockResolvedValue({ JobStatus: 'SUCCEEDED', DocumentMetadata: { Pages: 1 }, Blocks: [] });
    const { instance, sleep } = provider(send, 'text');
    const reading = await instance.extract(pdf, new AbortController().signal);
    expect(reading.pageCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up retryable once throttling outlasts the configured retries', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'LimitExceededException' }));
    const { instance } = provider(send);
    await expect(instance.extract({ ...document, bytes: new Uint8Array([1]), mediaType: 'image/png' },
      new AbortController().signal)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('treats InvalidS3ObjectException (S3 access, region or KMS configuration) as retryable', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'InvalidS3ObjectException' }));
    const { instance } = provider(send);
    await expect(instance.extract(pdf, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true, retryDelaySeconds: 20 });
  });

  it('rejects unsupported media types terminally', async () => {
    const { instance } = provider(jest.fn());
    await expect(instance.extract({ ...document, bytes: new Uint8Array([1]), mediaType: 'text/plain' },
      new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', retryable: false });
  });

  it('never asks Textract for FORMS or TABLES in either mode', async () => {
    for (const features of ['text', 'layout'] as const) {
      const image = jest.fn(async () => ({ $metadata: {}, Blocks: [] }));
      await provider(image, features).instance.extract({ ...document, bytes: new Uint8Array([1]),
        mediaType: 'image/png' }, new AbortController().signal);
      const many = asyncSend(features);
      await provider(many, features).instance.extract(pdf, new AbortController().signal);
      const sent = JSON.stringify([...image.mock.calls, ...many.mock.calls]
        .map((call) => ((call as unknown[])[0] as { input: unknown }).input));
      expect(sent).not.toMatch(/FORMS|TABLES|QUERIES|SIGNATURES/);
    }
  });
});

describe('Textract v2 line mapping', () => {
  it('keeps each line with page, reading-order id, box to 4 dp, least-legible word confidence and handwriting', () => {
    const pages = blocksToPages([
      word('w1', 'Amlodipine', 99.1), word('w2', '5mg', 62.35, true), word('w3', 'od', 97),
      line('l1', 'Amlodipine 5mg od', ['w1', 'w2', 'w3'], 1, [0.123456, 0.2, 0.333333, 0.04]),
      word('w4', 'Folder', 98), line('l2', 'Folder 7781-TEST', ['w4'], 1),
    ], 1);
    expect(pages).toEqual([{ page: 1, lines: [
      { id: 'p1-l1', page: 1, text: 'Amlodipine 5mg od', box: { left: 0.1235, top: 0.2, width: 0.3333, height: 0.04 },
        confidence: 0.6235, handwritten: true },
      { id: 'p1-l2', page: 1, text: 'Folder 7781-TEST', box: null, confidence: 0.98, handwritten: false },
    ] }]);
  });

  it('orders lines by the layout blocks, and keeps lines no layout lists after them', () => {
    const pages = blocksToPages([
      line('a', 'Right column', [], 1), line('b', 'Title', [], 1), line('c', 'Stray', [], 1),
      { BlockType: 'LAYOUT_TITLE', Id: 'L1', Page: 1, Relationships: [{ Type: 'CHILD', Ids: ['b'] }] },
      { BlockType: 'LAYOUT_LIST', Id: 'L2', Page: 1, Relationships: [{ Type: 'CHILD', Ids: ['L3'] }] },
      { BlockType: 'LAYOUT_TEXT', Id: 'L3', Page: 1, Relationships: [{ Type: 'CHILD', Ids: ['a'] }] },
    ], 1);
    expect(pages[0]!.lines.map((entry) => [entry.id, entry.text])).toEqual([
      ['p1-l1', 'Title'], ['p1-l2', 'Right column'], ['p1-l3', 'Stray']]);
  });

  it('numbers lines per page and keeps empty pages', () => {
    const pages = blocksToPages([line('a', 'one', [], 1), line('b', 'three', [], 3), line('c', 'three b', [], 3)], 3);
    expect(pages.map((page) => [page.page, page.lines.map((entry) => entry.id)])).toEqual([
      [1, ['p1-l1']], [2, []], [3, ['p3-l1', 'p3-l2']]]);
    expect(pages[2]!.lines[0]!.confidence).toBe(0.99);
  });
});

describe('Textract call limit (OCR_TEXTRACT_MAX_CONCURRENT)', () => {
  const image = { ...document, bytes: new Uint8Array([1]), mediaType: 'image/png' };
  const blocks = { $metadata: { requestId: 'request-1' }, Blocks: [word('w1', 'Paracetamol', 99), line('l1', 'Paracetamol', ['w1'])] };

  it('builds its limit from OCR_TEXTRACT_MAX_CONCURRENT, 2 by default', () => {
    expect(new TextractOcrProvider(config).limiter.limit).toBe(2);
    expect(new TextractOcrProvider({ ...config, OCR_TEXTRACT_MAX_CONCURRENT: 5 }).limiter.limit).toBe(5);
  });

  it('never has more calls in flight than the shared limit, across documents', async () => {
    const limiter = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    const send = jest.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return blocks;
    });
    const instance = new TextractOcrProvider(config, { limiter });
    (instance as unknown as { client: { send: jest.Mock } }).client = { send };
    const readings = await Promise.all(Array.from({ length: 5 }, () => instance.extract(image, new AbortController().signal)));
    expect(readings).toHaveLength(5);
    expect(send).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
    expect(limiter.inFlight).toBe(0);
  });

  it('frees the permit during a throttling backoff', async () => {
    const limiter = new Semaphore(1);
    const throttled = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    const send = jest.fn().mockRejectedValueOnce(throttled).mockResolvedValue(blocks);
    const held: number[] = [];
    const sleep = jest.fn(async () => { held.push(limiter.inFlight); });
    const instance = new TextractOcrProvider(config, { limiter, sleep, random: () => 0.5 });
    (instance as unknown as { client: { send: jest.Mock } }).client = { send };
    await instance.extract(image, new AbortController().signal);
    expect(send).toHaveBeenCalledTimes(2);
    expect(held).toEqual([0]);
  });
});

