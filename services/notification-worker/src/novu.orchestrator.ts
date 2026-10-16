import { createHash } from 'node:crypto';
import type { NotificationWorkerConfig } from './config';
import { WORKFLOW_BY_EVENT } from './event';
import type { HidEventEnvelope, OrchestrationResult, SubscriberOperationResult } from './types';

export interface NotificationOrchestrator {
  trigger(event: HidEventEnvelope): Promise<OrchestrationResult>;
  readiness(): Promise<void>;
  // NOVU_SUBSCRIBER_SYNC=email only (ADR-064). claimToken is the inbox claim
  // of this attempt, so each attempt's subscriber call has its own key.
  syncSubscriberEmail(subscriberId: string, email: string, eventId: string, claimToken: string): Promise<SubscriberOperationResult>;
  clearSubscriberEmail(subscriberId: string, eventId: string, claimToken: string): Promise<SubscriberOperationResult>;
  triggerWithEmailWithheld(event: HidEventEnvelope): Promise<OrchestrationResult>;
}

const GENERIC_MESSAGE = 'You have a new update in HID. Sign in securely to view it.';
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

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

  /**
   * Creates or updates the Novu subscriber with exactly its id and the
   * verified login email (POST /v2/subscribers upserts). Novu answers a seen
   * idempotency key from its cache for 24 hours without processing it again,
   * so the key is bound to this attempt (the claim token, unique per attempt)
   * and to the body (the email's digest): a retry of the event is a new
   * request. Setting an email is idempotent, so nothing is lost. The key holds
   * neither the email nor the token.
   */
  async syncSubscriberEmail(subscriberId: string, email: string, eventId: string,
    claimToken: string): Promise<SubscriberOperationResult> {
    return this.subscriberRequest('POST', '/v2/subscribers',
      sha256(`hid-novu-subscriber-email-v1\u001f${eventId}\u001f${claimToken}\u001f${sha256(email)}`),
      { subscriberId, email }, false);
  }

  /**
   * Sets the Novu subscriber's email to null (PATCH /v2/subscribers/{id}; the
   * email is nullable), so a trigger cannot email an address synced earlier.
   * Keyed by the event and this attempt's claim token, so a retry clears again
   * instead of receiving the first attempt's cached answer. A subscriber Novu
   * does not have (404) holds no email: confirmed.
   */
  async clearSubscriberEmail(subscriberId: string, eventId: string, claimToken: string): Promise<SubscriberOperationResult> {
    return this.subscriberRequest('PATCH', `/v2/subscribers/${encodeURIComponent(subscriberId)}`,
      sha256(`hid-novu-subscriber-email-clear-v1\u001f${eventId}\u001f${claimToken}`), { email: null }, true);
  }

  /**
   * Main's workflow and generic message to the same subscriber id, with the
   * subscriber's email set to null in the same request (a trigger updates the
   * subscriber it names). Used only when the clear above was not confirmed, so
   * the in-app notice still goes and cannot be emailed. Its own idempotency
   * key keeps it apart from main's trigger of the same event.
   */
  async triggerWithEmailWithheld(event: HidEventEnvelope): Promise<OrchestrationResult> {
    if (this.config.NOVU_MODE === 'test') {
      return { outcome: 'accepted', provider: 'novu', providerMessageId: `test:withheld:${event.id}` };
    }
    if (this.config.NOVU_MODE !== 'live' || !this.config.NOVU_API_KEY) {
      return { outcome: 'definitive_failure', provider: 'novu', safeCode: 'NOVU_NOT_CONFIGURED' };
    }
    try {
      const response = await fetch(`${this.config.NOVU_API_URL.replace(/\/+$/, '')}/v1/events/trigger`, {
        method: 'POST',
        headers: this.headers(sha256(`hid-novu-trigger-email-withheld-v1\u001f${event.id}`)),
        body: JSON.stringify({
          name: WORKFLOW_BY_EVENT[event.type],
          to: { subscriberId: event.context.patientId, email: null },
          payload: { message: GENERIC_MESSAGE },
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

  private headers(idempotencyKey: string): Record<string, string> {
    return { authorization: `ApiKey ${this.config.NOVU_API_KEY}`, 'content-type': 'application/json',
      'idempotency-key': idempotencyKey };
  }

  /** 2xx confirmed; 408, 409, 429, 5xx, a timeout or no answer unknown; any other 4xx rejected. */
  private async subscriberRequest(method: 'POST' | 'PATCH', path: string, idempotencyKey: string,
    body: Record<string, unknown>, absentIsConfirmed: boolean): Promise<SubscriberOperationResult> {
    if (this.config.NOVU_MODE === 'test') return { outcome: 'confirmed', provider: 'novu' };
    if (this.config.NOVU_MODE !== 'live' || !this.config.NOVU_API_KEY) {
      return { outcome: 'rejected', provider: 'novu', safeCode: 'NOVU_NOT_CONFIGURED' };
    }
    try {
      const response = await fetch(`${this.config.NOVU_API_URL.replace(/\/+$/, '')}${path}`, {
        method, headers: this.headers(idempotencyKey), body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return { outcome: 'confirmed', provider: 'novu' };
      if (absentIsConfirmed && response.status === 404) {
        return { outcome: 'confirmed', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_ABSENT' };
      }
      const transient = [408, 409, 429].includes(response.status) || response.status >= 500;
      return { outcome: transient ? 'unknown' : 'rejected', provider: 'novu', safeCode: `NOVU_SUBSCRIBER_HTTP_${response.status}` };
    } catch {
      return { outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_TIMEOUT_OR_UNAVAILABLE' };
    }
  }
}
