import { randomUUID } from 'node:crypto';
import {
  type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { NotificationOtpClient, type OtpDeliveryOutcome } from '../auth/notification-otp.client';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { cardLinksEnabled } from './card-links.flag';

export const CARD_LINK_EMAIL_CLAIM_LIMIT = 10;
export const CARD_LINK_EMAIL_CLAIM_LEASE_SECONDS = 120;
export const CARD_LINK_EMAIL_CLAIM_BATCHES = 5;
/** Links past their end closed, and retention applied, per tick. */
export const CARD_LINK_SWEEP_BATCH = 200;

interface ClaimedEmail {
  email_id: string;
  kind: 'created' | 'opened';
  recipient: string;
  reference: string;
  recipient_hint: string | null;
  occurred_at: Date;
  link_expires_at: Date;
  attempt_count: number;
}

export interface CardLinkEmailSummary { claimed: number; delivered: number; retried: number; failed: number }

/**
 * The patient's card-link emails (0118): E8 on every new link and E7 on the
 * first open of each link each Lagos day, queued by the database and claimed
 * here under a lease (system:auth, SKIP LOCKED, the recipient checked again
 * by 0063's rule). No health data; logs counts only. Nothing is claimed
 * while CARD_LINKS_ENABLED is off.
 */
@Injectable()
export class CardLinksEmailDispatcher {
  private readonly logger = new Logger(CardLinksEmailDispatcher.name);
  private readonly workerId = `identity-api:${randomUUID()}`;
  private stopped = false;

  constructor(private readonly database: DatabaseService, private readonly notification: NotificationOtpClient) {}

  stop(): void {
    this.stopped = true;
  }

  async dispatch(correlationId: string): Promise<CardLinkEmailSummary> {
    const summary: CardLinkEmailSummary = { claimed: 0, delivered: 0, retried: 0, failed: 0 };
    if (!cardLinksEnabled()) return summary;
    for (let batch = 0; batch < CARD_LINK_EMAIL_CLAIM_BATCHES; batch += 1) {
      if (this.stopped) break;
      const claimed = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<ClaimedEmail>(
        `select email_id::text, kind, recipient, reference, recipient_hint, occurred_at, link_expires_at, attempt_count
           from identity.claim_card_share_emails($1, $2, $3)`,
        [this.workerId, CARD_LINK_EMAIL_CLAIM_LIMIT, CARD_LINK_EMAIL_CLAIM_LEASE_SECONDS])).rows);
      summary.claimed += claimed.length;
      for (const email of claimed) {
        if (this.stopped) break;
        const delivery: { outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string } = await this.send(email,
          correlationId).catch(() => ({ outcome: 'unknown' as const, safeCode: 'transport_error' }));
        const next = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{
          next_status: string }>('select identity.record_card_share_email_outcome($1, $2, $3, $4, $5) as next_status',
          [email.email_id, this.workerId, delivery.outcome, delivery.provider ?? null, delivery.safeCode ?? null])).rows[0]
          ?.next_status);
        if (next === 'delivered') summary.delivered += 1;
        else if (next === 'pending') summary.retried += 1;
        else if (next === 'failed') summary.failed += 1;
      }
      if (claimed.length < CARD_LINK_EMAIL_CLAIM_LIMIT) break;
    }
    if (summary.claimed > 0) {
      this.logger.log(`Card link emails (event=card_share_email_dispatch claimed=${summary.claimed} `
        + `delivered=${summary.delivered} retried=${summary.retried} failed=${summary.failed})`);
    }
    return summary;
  }

  private send(email: ClaimedEmail, correlationId: string) {
    if (email.kind === 'opened') {
      return this.notification.deliverCardShareOpened({ emailId: email.email_id, recipient: email.recipient,
        reference: email.reference, openedAt: new Date(email.occurred_at), correlationId });
    }
    // A link anonymised before its email went has no hint left to name: nothing is sent.
    if (!email.recipient_hint) return Promise.resolve({ outcome: 'definitive_failure' as const, safeCode: 'no_hint' });
    return this.notification.deliverCardShareCreated({ emailId: email.email_id, recipient: email.recipient,
      reference: email.reference, recipientHint: email.recipient_hint, expiresAt: new Date(email.link_expires_at),
      correlationId });
  }
}

/**
 * Card links' periodic work (0118), every PATIENT_LIFECYCLE_SWEEP_SECONDS
 * while CARD_LINKS_ENABLED is on (no timer under NODE_ENV=test or at 0):
 * identity.close_expired_card_shares (links past their end close and their
 * address is erased; network data older than 30 days, and the hint and
 * address HMAC of links ended over 12 months ago, are erased), then the
 * patient emails. Each step logs its code only on failure.
 */
@Injectable()
export class CardLinksSweeper implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(CardLinksSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  constructor(private readonly emails: CardLinksEmailDispatcher, private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void {
    const environment = getEnvironment();
    const seconds = environment.PATIENT_LIFECYCLE_SWEEP_SECONDS;
    if (seconds === 0 || environment.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.runOnce(); }, seconds * 1_000);
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.emails.stop();
    await this.inFlight;
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  runOnce(): Promise<void> {
    this.inFlight ??= this.tick().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async tick(): Promise<void> {
    if (!cardLinksEnabled()) return;
    const correlationId = `card-links-sweep-${randomUUID()}`;
    await this.step('card_share_expiry', () => this.database.withSystemTransaction(correlationId,
      (client) => client.query('select identity.close_expired_card_shares($1) as swept', [CARD_LINK_SWEEP_BATCH])), correlationId);
    await this.step('card_share_emails', () => this.emails.dispatch(correlationId), correlationId);
  }

  private async step(name: string, work: () => Promise<unknown>, correlationId: string): Promise<void> {
    try {
      await work();
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown';
      this.logger.error(`Card link sweep failed (step=${name}, code=${code}, correlation=${correlationId})`);
    }
  }
}
