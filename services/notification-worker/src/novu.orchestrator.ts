import type { NotificationWorkerConfig } from './config';
import { WORKFLOW_BY_EVENT } from './event';
import type { HidEventEnvelope, NotificationRecipient, OrchestrationResult } from './types';

export interface NotificationOrchestrator {
  trigger(event: HidEventEnvelope, recipient?: NotificationRecipient | null): Promise<OrchestrationResult>;
  readiness(): Promise<void>;
}

export class NovuOrchestrator implements NotificationOrchestrator {
  constructor(private readonly config: NotificationWorkerConfig) {}

  async trigger(event: HidEventEnvelope, recipient?: NotificationRecipient | null): Promise<OrchestrationResult> {
    if (!recipient) {
      return { outcome: 'definitive_failure', provider: 'novu', safeCode: 'PATIENT_VERIFIED_EMAIL_UNAVAILABLE' };
    }
    if (this.config.NOVU_MODE === 'test') {
      return { outcome: 'accepted', provider: 'novu', providerMessageId: `test:${event.id}` };
    }
    if (this.config.NOVU_MODE !== 'live' || !this.config.NOVU_API_KEY) {
      return { outcome: 'definitive_failure', provider: 'novu', safeCode: 'NOVU_NOT_CONFIGURED' };
    }

    const baseUrl = this.config.NOVU_API_URL.replace(/\/+$/, '');
    try {
      const subscriberResponse = await fetch(baseUrl + '/v2/subscribers', {
        method: 'POST',
        headers: {
          authorization: `ApiKey ${this.config.NOVU_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': 'subscriber:' + event.id,
        },
        body: JSON.stringify({
          subscriberId: recipient.id,
          email: recipient.email,
          firstName: recipient.firstName,
          lastName: recipient.lastName,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!subscriberResponse.ok) return this.providerFailure(subscriberResponse.status);

      const response = await fetch(baseUrl + '/v1/events/trigger', {
        method: 'POST',
        headers: {
          authorization: `ApiKey ${this.config.NOVU_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': event.id,
        },
        body: JSON.stringify({
          name: WORKFLOW_BY_EVENT[event.type],
          to: { subscriberId: recipient.id },
          payload: { message: 'You have a new update in HID. Sign in securely to view it.' },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return this.providerFailure(response.status);
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

  private providerFailure(status: number): OrchestrationResult {
    return {
      outcome: status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'definitive_failure' : 'unknown',
      provider: 'novu',
      safeCode: `NOVU_HTTP_${status}`,
    };
  }
}
