import { BedrockAiService } from './bedrock-ai.service';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  InvokeModelCommand: jest.fn((input: unknown) => ({ kind: 'embed', input })),
}));
jest.mock('../../config/environment', () => ({ getEnvironment: () => ({
  AI_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
  AI_REQUEST_TIMEOUT_MS: 20_000,
}) }));

describe('Bounded Bedrock request contracts', () => {
  beforeEach(() => mockSend.mockReset());
  it('requires finite vectors of the schema dimension and propagates request cancellation', async () => {
    const controller = new AbortController();
    mockSend.mockResolvedValue({ body: Buffer.from(JSON.stringify({ embedding: Array(1024).fill(0.1) })) });
    const result = await new BedrockAiService().embed('Invented released note', controller.signal);
    expect(result).toHaveLength(1024);
    const [command, options] = mockSend.mock.calls[0];
    expect(JSON.parse(command.input.body)).toEqual({ inputText: 'Invented released note', dimensions: 1024, normalize: true });
    expect(options.abortSignal.aborted).toBe(false);
    controller.abort();
    expect(options.abortSignal.aborted).toBe(true);
    for (const vector of [Array(512).fill(0), [...Array(1023).fill(0), null]]) {
      mockSend.mockResolvedValue({ body: Buffer.from(JSON.stringify({ embedding: vector })) });
      await expect(new BedrockAiService().embed('Invented note')).rejects.toThrow('invalid embedding');
    }
  });
  it('rejects oversized inputs before invoking a model', async () => {
    await expect(new BedrockAiService().embed('x'.repeat(6501))).rejects.toThrow('exceeds its limit');
    expect(mockSend).not.toHaveBeenCalled();
  });
});
