import type { ProviderExtraction, VerifiedDocument, WorkerOcrProvider } from './types';

export class TestOcrProvider implements WorkerOcrProvider {
  readonly name = 'test';
  async checkReadiness(_signal: AbortSignal): Promise<void> { return Promise.resolve(); }
  async extract(_document: VerifiedDocument, _signal: AbortSignal): Promise<ProviderExtraction> {
    return { providerModel: 'deterministic-test-v1', providerRequestReference: 'test-request',
      pages: [{ page: 1, text: 'deterministic test extraction', confidence: 1 }],
      provenance: { adapter: 'test', synthetic: true } };
  }
}
