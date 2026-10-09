import type { NotificationWorkerConfig } from './config';
import { WORKFLOW_BY_EVENT } from './event';
import type { HidEventEnvelope, OrchestrationResult } from './types';

export interface NotificationOrchestrator {
  trigger(event: HidEventEnvelope): Promise<OrchestrationResult>;
  readiness(): Promise<void>;
}

export class NovuOrchestrator implements NotificationOrchestrator {
  constructor(private readonly config: NotificationWorkerConfig) {}

  async trigger(event: HidEventEnvelope): Promise<OrchestrationResult> {
    if (this.config.NOVU_MODE === 'test') {
      return { outcome: 'accepted', provider: 'novu', providerMessageId: `test:${event.id}` };
    }
    if (this.config.NOVU_MODE !== 'live' || !this.config.NOVU_API_KEY) {
      return { outcome: 'definitive_failure', provider: 'novu', safeCode: 'NOVU_NOT_CONFIGURED' };
    }
    try {
      const response = await fetch(`${this.config.NOVU_API_URL.replace(/\/+$/, '')}/v1/events/trigger`, {
        method: 'POST',
        headers: {
          authorization: `ApiKey ${this.config.NOVU_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': event.id,
        },
        body: JSON.stringify({
          name: WORKFLOW_BY_EVENT[event.type],
          to: { subscriberId: event.context.patientId },
          payload: { message: 'You have a new update in HID. Sign in securely to view it.' },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return {
        outcome: response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
          ? 'definitive_failure' : 'unknown',
        provider: 'novu', safeCode: `NOVU_HTTP_${response.status}`,
      };
      const result = await response.json().catch(() => undefined) as { data?: { transactionId?: unknown } } | undefined;
      const messageId = result?.data?.transactionId;
      return { outcome: 'accepted', provider: 'novu',
        ...(typeof messageId === 'string' && messageId.length <= 255 ? { providerMessageId: messageId } : {}) };
    } catch {
      return { outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_TIMEOUT_OR_UNAVAILABLE' };
    }
  }

  async readiness(): Promise<void> {
    if (this.config.NOVU_MODE === 'live' && !this.config.NOVU_API_KEY) throw new Error('NOVU_NOT_CONFIGURED');
  }
}
