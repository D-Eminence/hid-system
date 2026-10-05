import type { NotificationWorkerConfig } from './config';
import { WORKFLOW_BY_EVENT } from './event';
import type { HidEventEnvelope, OrchestrationResult } from './types';

export interface NotificationOrchestrator {
  trigger(event: HidEventEnvelope, verifiedEmail: string): Promise<OrchestrationResult>;
  readiness(): Promise<void>;
}

export class NovuOrchestrator implements NotificationOrchestrator {
  constructor(private readonly config: NotificationWorkerConfig) {}

  async trigger(event: HidEventEnvelope, verifiedEmail: string): Promise<OrchestrationResult> {
    if (this.config.NOVU_MODE === 'test') {
      return { outcome: 'accepted', provider: 'novu', providerMessageId: `test:${event.id}` };
    }
    if (this.config.NOVU_MODE !== 'live' || !this.config.NOVU_API_KEY) {
      return { outcome: 'definitive_failure', provider: 'novu', safeCode: 'NOVU_NOT_CONFIGURED' };
    }
    const subscriberFailure = await this.syncSubscriber(
      event.context.patientId!, verifiedEmail, `subscriber:${event.id}`,
    );
    if (subscriberFailure) return subscriberFailure;
    try {
      const response = await this.request('/v1/events/trigger', 'POST', event.id, {
        name: WORKFLOW_BY_EVENT[event.type],
        to: { subscriberId: event.context.patientId },
        payload: { message: 'You have a new update in HID. Sign in securely to view it.' },
      });
      if (!response.ok) return this.httpFailure('NOVU', response.status);
      const result = await response.json().catch(() => undefined) as { data?: { transactionId?: unknown } } | undefined;
      const messageId = result?.data?.transactionId;
      return { outcome: 'accepted', provider: 'novu',
        ...(typeof messageId === 'string' && messageId.length <= 255 ? { providerMessageId: messageId } : {}) };
    } catch {
      return { outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_TIMEOUT_OR_UNAVAILABLE' };
    }
  }

  private async syncSubscriber(
    subscriberId: string,
    email: string,
    idempotencyKey: string,
  ): Promise<OrchestrationResult | undefined> {
    try {
      const updated = await this.request(
        `/v2/subscribers/${encodeURIComponent(subscriberId)}`,
        'PATCH',
        idempotencyKey,
        { email },
      );
      if (updated.ok) return undefined;
      if (updated.status !== 404) return this.httpFailure('NOVU_SUBSCRIBER', updated.status);

      const created = await this.request('/v2/subscribers', 'POST', idempotencyKey, { subscriberId, email });
      if (created.ok) return undefined;
      if (created.status !== 409) return this.httpFailure('NOVU_SUBSCRIBER', created.status);

      const reconciled = await this.request(
        `/v2/subscribers/${encodeURIComponent(subscriberId)}`,
        'PATCH',
        idempotencyKey,
        { email },
      );
      return reconciled.ok ? undefined : this.httpFailure('NOVU_SUBSCRIBER', reconciled.status);
    } catch {
      return { outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_TIMEOUT_OR_UNAVAILABLE' };
    }
  }

  private request(
    path: string,
    method: 'PATCH' | 'POST',
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${this.config.NOVU_API_URL.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        authorization: `ApiKey ${this.config.NOVU_API_KEY}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  }

  private httpFailure(prefix: string, status: number): OrchestrationResult {
    return {
      outcome: status >= 400 && status < 500 && status !== 408 && status !== 429
        ? 'definitive_failure' : 'unknown',
      provider: 'novu', safeCode: `${prefix}_HTTP_${status}`,
    };
  }

  async readiness(): Promise<void> {
    if (this.config.NOVU_MODE === 'live' && !this.config.NOVU_API_KEY) throw new Error('NOVU_NOT_CONFIGURED');
  }
}
