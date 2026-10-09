import { GetDocumentTextDetectionCommand, StartDocumentTextDetectionCommand } from '@aws-sdk/client-textract';
import type { OcrWorkerConfig } from './config';
import { SafeWorkerFailure } from './types';
import { TEXTRACT_PROCESSING_CONTRACT, TextractOcrProvider,
  textractPdfClientRequestToken } from './textract.provider';

const document = {
  bucket: 'hid-documents', key: 'clinical/objects/opaque', versionId: 'version-1',
  sha256Hex: 'a'.repeat(64),
};

describe('Textract duplicate-cost controls', () => {
  it('creates a deterministic 64-character request token for the immutable source and processing contract', () => {
    const first = textractPdfClientRequestToken(document);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(textractPdfClientRequestToken({ ...document })).toBe(first);
    expect(TEXTRACT_PROCESSING_CONTRACT).toBe('hid-textract-v1');
  });

  it('changes the request token when exact object evidence changes', () => {
    const baseline = textractPdfClientRequestToken(document);
    expect(textractPdfClientRequestToken({ ...document, versionId: 'version-2' })).not.toBe(baseline);
    expect(textractPdfClientRequestToken({ ...document, sha256Hex: 'b'.repeat(64) })).not.toBe(baseline);
  });

  it('passes the deterministic token to an async PDF start', async () => {
    const provider = new TextractOcrProvider({ AWS_REGION: 'eu-west-1',
      OCR_TEXTRACT_MAX_POLL_SECONDS: 10, OCR_TEXTRACT_POLL_MS: 1,
      OCR_WORKER_API_TIMEOUT_MS: 1_000 } as OcrWorkerConfig);
    const send = jest.fn(async (command: unknown) => {
      if (command instanceof StartDocumentTextDetectionCommand) return { JobId: 'job-1' };
      if (command instanceof GetDocumentTextDetectionCommand) return { JobStatus: 'SUCCEEDED', Blocks: [] };
      throw new Error('unexpected command');
    });
    (provider as unknown as { client: { send: typeof send } }).client = { send };
    await provider.extract({ ...document, bytes: new Uint8Array(), mediaType: 'application/pdf' },
      new AbortController().signal);
    const start = send.mock.calls[0]![0] as StartDocumentTextDetectionCommand;
    expect(start.input.ClientRequestToken).toBe(textractPdfClientRequestToken(document));
  });

  it('does not blindly retry an uncertain synchronous image charge', async () => {
    const provider = new TextractOcrProvider({ AWS_REGION: 'eu-west-1',
      OCR_TEXTRACT_MAX_POLL_SECONDS: 10, OCR_TEXTRACT_POLL_MS: 1,
      OCR_WORKER_API_TIMEOUT_MS: 1_000 } as OcrWorkerConfig);
    const timeout = Object.assign(new Error('unsafe detail'), { name: 'TimeoutError' });
    (provider as unknown as { client: { send: () => Promise<never> } }).client = {
      send: jest.fn().mockRejectedValue(timeout),
    };
    await expect(provider.extract({ ...document, bytes: new Uint8Array([1]), mediaType: 'image/png' },
      new AbortController().signal)).rejects.toEqual(expect.objectContaining<Partial<SafeWorkerFailure>>({
      code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: false,
    }));
  });
});
