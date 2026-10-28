import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationOtpClient, type OtpDeliveryOutcome } from '../auth/notification-otp.client';
import { DatabaseService } from '../database/database.service';

/**
 * Each claim leases at most this many emails for this long; one email takes
 * at most 5 s (the client's timeout), so a batch ends well inside its lease.
 */
export const ACCOUNT_DELETION_NOTICE_CLAIM_LIMIT = 10;
export const ACCOUNT_DELETION_NOTICE_CLAIM_LEASE_SECONDS = 120;
/** Batches per tick; a tick stops early at the first batch that is not full. */
export const ACCOUNT_DELETION_NOTICE_CLAIM_BATCHES = 5;

interface ClaimedNotice {
  notice_id: string;
  request_id: string;
  kind: 'scheduled' | 'cancelled' | 'completed';
  recipient: string;
  scheduled_for: Date | null;
  attempt_count: number;
}

export interface AccountDeletionNoticeSummary {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

/**
 * Sends the account-deletion emails (B5, 0096, D11) that confirmation
 * (scheduled), cancelling a scheduled deletion (cancelled) and completion
 * (completed) wrote: claimed under a lease (system:auth, SKIP LOCKED, the
 * account's verified email whatever its status), sent with the kind and the
 * scheduled date only, the outcome recorded; unknown retries with backoff, at
 * most 5 attempts within 24 hours. Keyed account-deletion:<requestId>:<kind>.
 * Runs whatever ACCOUNT_DELETION_ENABLED says: a scheduled deletion still
 * completes, and the patient is told. Logs counts only.
 */
@Injectable()
export class AccountDeletionNoticeDispatcher {
  private readonly logger = new Logger(AccountDeletionNoticeDispatcher.name);
  private readonly workerId = `identity-api:${randomUUID()}`;
  private stopped = false;

  constructor(private readonly database: DatabaseService, private readonly notification: NotificationOtpClient) {}

  /** At shutdown: claim and send nothing more; a claimed email is retried once its lease expires. */
  stop(): void {
    this.stopped = true;
  }

  async dispatch(correlationId: string): Promise<AccountDeletionNoticeSummary> {
    const summary: AccountDeletionNoticeSummary = { claimed: 0, delivered: 0, retried: 0, failed: 0 };
    for (let batch = 0; batch < ACCOUNT_DELETION_NOTICE_CLAIM_BATCHES; batch += 1) {
      if (this.stopped) break;
      const claimed = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<ClaimedNotice>(
        'select notice_id::text, request_id::text, kind, recipient, scheduled_for, attempt_count '
        + 'from identity.claim_account_deletion_notices($1, $2, $3)',
        [this.workerId, ACCOUNT_DELETION_NOTICE_CLAIM_LIMIT, ACCOUNT_DELETION_NOTICE_CLAIM_LEASE_SECONDS],
      )).rows);
      summary.claimed += claimed.length;
      for (const notice of claimed) {
        if (this.stopped) break;
        const delivery: { outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string } = await this.notification
          .deliverAccountDeletionNotice({ requestId: notice.request_id, recipient: notice.recipient, kind: notice.kind,
            ...(notice.scheduled_for ? { scheduledFor: new Date(notice.scheduled_for) } : {}), correlationId })
          .catch(() => ({ outcome: 'unknown' as const, safeCode: 'transport_error' }));
        const next = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ next_status: string }>(
          'select identity.record_account_deletion_notice_outcome($1, $2, $3, $4, $5) as next_status',
          [notice.notice_id, this.workerId, delivery.outcome, delivery.provider ?? null, delivery.safeCode ?? null],
        )).rows[0]?.next_status);
        if (next === 'delivered') summary.delivered += 1;
        else if (next === 'pending') summary.retried += 1;
        else if (next === 'failed') summary.failed += 1;
      }
      if (claimed.length < ACCOUNT_DELETION_NOTICE_CLAIM_LIMIT) break;
    }
    if (summary.claimed > 0) {
      this.logger.log(`Account-deletion email dispatch (event=account_deletion_notice_dispatch claimed=${summary.claimed} `
        + `delivered=${summary.delivered} retried=${summary.retried} failed=${summary.failed})`);
    }
    return summary;
  }
}
