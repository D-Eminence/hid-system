import { Injectable } from '@nestjs/common';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getEnvironment } from '../../config/environment';
import { DomainProblem } from '../../common/problem';

@Injectable()
export class BedrockAiService {
  private readonly client = new BedrockRuntimeClient({ maxAttempts: 1 });

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const modelId = getEnvironment().AI_EMBEDDING_MODEL_ID;
    if (text.length > 6500) throw new DomainProblem(400, 'CHAT_INPUT_TOO_LARGE', 'Chat input exceeds its limit');
    const response = await this.client.send(new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text, dimensions: 1024, normalize: true }),
    }), { abortSignal: AbortSignal.any([AbortSignal.timeout(getEnvironment().AI_REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
    if (response.body.length > 100_000) throw new Error('Invalid embedding response size');
    const payload: unknown = JSON.parse(Buffer.from(response.body).toString('utf8'));
    const embedding = typeof payload === 'object' && payload !== null && 'embedding' in payload
      ? payload.embedding : undefined;
    if (!Array.isArray(embedding) || embedding.length !== 1024
      || embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('Bedrock returned an invalid embedding');
    }
    return embedding;
  }

}
