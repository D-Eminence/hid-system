import type { TextReading, VerifiedDocument, WorkerOcrProvider } from './types';

export class TestOcrProvider implements WorkerOcrProvider {
  readonly name = 'test';
  async checkReadiness(_signal: AbortSignal): Promise<void> { return Promise.resolve(); }
  async extract(_document: VerifiedDocument, _signal: AbortSignal): Promise<TextReading> {
    return { providerModel: 'deterministic-test-v1', providerRequestReference: 'test-request', pageCount: 1,
      pages: [{ page: 1, lines: [{ id: 'p1-l1', page: 1, text: 'deterministic test extraction',
        box: { left: 0.1, top: 0.1, width: 0.5, height: 0.05 }, confidence: 1, handwritten: false }] }],
      provenance: { processingContract: 'hid-textract-v2', adapter: 'test', synthetic: true } };
  }
}
