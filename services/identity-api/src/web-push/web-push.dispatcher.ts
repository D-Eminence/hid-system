import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationOtpClient, type WebPushDeliveryResult } from '../auth/notification-otp.client';
import { DatabaseService } from '../database/database.service';
import { webPushConfiguration } from './web-push.config';
import { checkWebPushEndpoint } from './web-push-endpoint';
import { WebPushProtector } from './web-push.protector';

export { WEB_PUSH_DELIVERY_TIMEOUT_MS } from './web-push-endpoint';
/** Pushes leased per claim, and for how long: ten sends of at most 8 s stay inside the lease. */
export const WEB_PUSH_CLAIM_LIMIT = 10;
export const WEB_PUSH_CLAIM_LEASE_SECONDS = 120;
/** Claims per tick; a tick stops early at the first claim that is not full. */
export const WEB_PUSH_CLAIM_BATCHES = 5;
/** Subscriptions of ended sign-ins erased per tick. */
export const WEB_PUSH_PRUNE_BATCH = 100;

interface ClaimedPush {
  subscription_id: string;
  endpoint_ciphertext: Buffer;
  endpoint_key_version: string;
  push_service: string;
  attempt_count: number;
  claimed_through: Date;
}

export interface WebPushDispatchSummary {
  claimed: number;
  delivered: number;
  retried: number;
  dropped: number;
  removed: number;
}

/**
 * The sweeper's web push steps (B6, 0097, D6 to D8). dispatch(): while push is
 * on, claims the subscriptions with a new unread inbox item (system:auth,
 * SKIP LOCKED, a 120-second lease, at most one push per subscription per 2
 * minutes), decrypts each endpoint, checks it against rule E again, asks
 * notification-api to send an empty push and records the outcome (retries
 * with backoff, removal on 404/410 from the push service). prune(): erases
 * the subscriptions whose sign-in has ended, whatever the switch. Logs
 * counts only: never an endpoint, a key or an id.
 */
@Injectable()
export class WebPushDispatcher {
  private readonly logger = new Logger(WebPushDispatcher.name);
  private readonly workerId = `identity-api:${randomUUID()}`;
  private stopped = false;

  constructor(private readonly database: DatabaseService, private readonly notification: NotificationOtpClient,
    private readonly protector: WebPushProtector) {}

  /** At shutdown: claim and send nothing more; a claimed push is sent again once its lease expires. */
  stop(): void {
    this.stopped = true;
  }

  async prune(correlationId: string): Promise<number> {
    if (this.stopped) return 0;
    const removed = await this.database.withSystemTransaction(correlationId, async (client) => Number(
      (await client.query<{ removed: number }>('select identity.prune_web_push_subscriptions($1) as removed',
        [WEB_PUSH_PRUNE_BATCH])).rows[0]?.removed ?? 0));
    if (removed > 0) this.logger.log(`Web push prune (event=web_push_prune removed=${removed})`);
    return removed;
  }

  async dispatch(correlationId: string): Promise<WebPushDispatchSummary> {
    const summary: WebPushDispatchSummary = { claimed: 0, delivered: 0, retried: 0, dropped: 0, removed: 0 };
    const configuration = webPushConfiguration();
    // Off, or the endpoints cannot be decrypted here: claim nothing (a claim
    // that cannot be sent would only count against the subscription).
    if (!configuration.on || !this.protector.configured()) return summary;
    for (let batch = 0; batch < WEB_PUSH_CLAIM_BATCHES; batch += 1) {
      if (this.stopped) break;
      const claimed = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<ClaimedPush>(
        'select subscription_id::text, endpoint_ciphertext, endpoint_key_version, push_service, attempt_count, claimed_through '
        + 'from identity.claim_web_push_deliveries($1, $2, $3, $4)',
        [this.workerId, WEB_PUSH_CLAIM_LIMIT, WEB_PUSH_CLAIM_LEASE_SECONDS, configuration.keyId])).rows);
      summary.claimed += claimed.length;
      for (const push of claimed) {
        if (this.stopped) break;
        const result = await this.send(push, configuration.keyId, correlationId);
        const next = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ next: string }>(
          'select identity.record_web_push_outcome($1, $2, $3, $4, $5) as next',
          [push.subscription_id, this.workerId, result.outcome, result.retryAfterSeconds ?? null, result.safeCode ?? null],
        )).rows[0]?.next);
        if (next === 'delivered') summary.delivered += 1;
        else if (next === 'retrying') summary.retried += 1;
        else if (next === 'dropped') summary.dropped += 1;
        else if (next === 'removed') summary.removed += 1;
      }
      if (claimed.length < WEB_PUSH_CLAIM_LIMIT) break;
    }
    if (summary.claimed > 0) {
      this.logger.log(`Web push dispatch (event=web_push_dispatch claimed=${summary.claimed} delivered=${summary.delivered} `
        + `retried=${summary.retried} dropped=${summary.dropped} removed=${summary.removed})`);
    }
    return summary;
  }

  private async send(push: ClaimedPush, keyId: string, correlationId: string): Promise<WebPushDeliveryResult> {
    let endpoint: string;
    try {
      endpoint = this.protector.decrypt(push.subscription_id, push.endpoint_key_version, push.endpoint_ciphertext);
    } catch {
      return { outcome: 'rejected', safeCode: 'endpoint_protection_unavailable' };
    }
    if (!checkWebPushEndpoint(endpoint).ok) return { outcome: 'rejected', safeCode: 'endpoint_invalid' };
    return this.notification.deliverWebPush({ subscriptionId: push.subscription_id, endpoint, vapidKeyId: keyId,
      claimedThrough: new Date(push.claimed_through), correlationId })
      .catch((): WebPushDeliveryResult => ({ outcome: 'retry', safeCode: 'transport_error' }));
  }
}
