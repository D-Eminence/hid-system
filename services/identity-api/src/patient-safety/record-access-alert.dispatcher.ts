import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationOtpClient, type OtpDeliveryOutcome } from '../auth/notification-otp.client';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

/**
 * Each claim leases at most this many notices for this long; one email takes
 * at most 5 s (the client's timeout), so a batch ends well inside its lease.
 */
export const RECORD_ACCESS_ALERT_CLAIM_LIMIT = 10;
export const RECORD_ACCESS_ALERT_CLAIM_LEASE_SECONDS = 120;
/** Batches per tick; a tick stops early at the first batch that is not full. */
export const RECORD_ACCESS_ALERT_CLAIM_BATCHES = 5;

interface ClaimedAlert {
  notice_id: string;
  recipient: string;
  occurred_at: Date;
  attempt_count: number;
}

export interface RecordAccessAlertSummary {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

/**
 * Sends the "Your Health ID records were opened" emails (B4, 0095, D9) that
 * identity.note_record_access queued: claimed under a lease (system:auth,
 * SKIP LOCKED, the recipient checked again by 0063's rule), sent with the
 * time only, the outcome recorded; unknown retries with backoff, at most 5
 * attempts within 24 hours of the access. Nothing is claimed while
 * RECORD_ACCESS_EMAIL_ENABLED is false. Logs counts only.
 */
@Injectable()
export class RecordAccessAlertDispatcher {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(RecordAccessAlertDispatcher.name);
  private readonly workerId = `identity-api:${randomUUID()}`;
  private stopped = false;

  constructor(private readonly database: DatabaseService, private readonly notification: NotificationOtpClient) {}

  /** At shutdown: claim and send nothing more; a claimed notice is retried once its lease expires. */
  stop(): void {
    this.stopped = true;
  }

  async dispatch(correlationId: string): Promise<RecordAccessAlertSummary> {
    const summary: RecordAccessAlertSummary = { claimed: 0, delivered: 0, retried: 0, failed: 0 };
    if (!this.environment.RECORD_ACCESS_EMAIL_ENABLED) return summary;
    for (let batch = 0; batch < RECORD_ACCESS_ALERT_CLAIM_BATCHES; batch += 1) {
      if (this.stopped) break;
      const claimed = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<ClaimedAlert>(
        'select notice_id::text, recipient, occurred_at, attempt_count from identity.claim_record_access_alerts($1, $2, $3)',
        [this.workerId, RECORD_ACCESS_ALERT_CLAIM_LIMIT, RECORD_ACCESS_ALERT_CLAIM_LEASE_SECONDS],
      )).rows);
      summary.claimed += claimed.length;
      for (const notice of claimed) {
        if (this.stopped) break;
        const delivery: { outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string } = await this.notification
          .deliverRecordAccessAlert({ noticeId: notice.notice_id, recipient: notice.recipient,
            occurredAt: new Date(notice.occurred_at), correlationId })
          .catch(() => ({ outcome: 'unknown' as const, safeCode: 'transport_error' }));
        const next = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ next_status: string }>(
          'select identity.record_record_access_alert_outcome($1, $2, $3, $4, $5) as next_status',
          [notice.notice_id, this.workerId, delivery.outcome, delivery.provider ?? null, delivery.safeCode ?? null],
        )).rows[0]?.next_status);
        if (next === 'delivered') summary.delivered += 1;
        else if (next === 'pending') summary.retried += 1;
        else if (next === 'failed') summary.failed += 1;
      }
      if (claimed.length < RECORD_ACCESS_ALERT_CLAIM_LIMIT) break;
    }
    if (summary.claimed > 0) {
      this.logger.log(`Records-opened dispatch (event=record_access_alert_dispatch claimed=${summary.claimed} `
        + `delivered=${summary.delivered} retried=${summary.retried} failed=${summary.failed})`);
    }
    return summary;
  }
}
